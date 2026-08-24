// fairjudge-ocr — on-device OCR for evidence screenshots.
//
// Everything here runs locally through Apple's Vision framework. No image, no
// recognized text and no derived data ever leaves the machine: this binary is
// the reason the M2 pipeline needs no cloud vision provider.
//
// Usage:
//     fairjudge-ocr <image-path>
//
// Output: exactly one JSON object on stdout.
//
//     {
//       "width": 1280,
//       "height": 2781,
//       "coordinateSystem": "normalized-top-left",
//       "lines": [
//         { "text": "...", "x": 0.207, "y": 0.079, "w": 0.664, "h": 0.019,
//           "confidence": 0.5 }
//       ]
//     }
//
// COORDINATE SYSTEM (important — it differs from Vision's own convention):
// all of x/y/w/h are normalized to [0, 1] against the *oriented* image size,
// with the origin at the TOP-LEFT corner, x growing rightwards and y growing
// downwards. Vision reports bounding boxes with a bottom-left origin; the flip
// to top-left happens here so that every downstream consumer (the Node wrapper,
// the confirmation workbench overlay, the browser) shares the one convention
// that screen coordinates already use.
//
// Errors go to stderr with a non-zero exit code, so the Node wrapper can tell a
// hard failure apart from a legitimately empty page.

import CoreGraphics
import Foundation
import ImageIO
import Vision

// MARK: - Output shape

struct OcrLine: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let confidence: Double
}

struct OcrResult: Encodable {
    let width: Int
    let height: Int
    let coordinateSystem: String
    let lines: [OcrLine]
}

// MARK: - Helpers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("fairjudge-ocr: \(message)\n".utf8))
    exit(1)
}

/// Keeps the JSON payload readable and stable. Five decimals on a normalized
/// axis is ~0.03 px of precision on a 2781 px tall screenshot — far finer than
/// Vision's own box accuracy, and it keeps snapshots diffable.
func round5(_ value: CGFloat) -> Double {
    (Double(value) * 100_000).rounded() / 100_000
}

// MARK: - Input

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fail("usage: fairjudge-ocr <image-path>")
}
let imagePath = arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let imageSource = CGImageSourceCreateWithURL(imageURL as CFURL, nil) else {
    fail("cannot open image at \(imagePath)")
}
guard let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    fail("cannot decode image at \(imagePath)")
}

// Honour the EXIF orientation tag. Phone screenshots are almost always `.up`,
// but photographed / re-exported evidence may not be, and Vision needs the
// orientation to read rotated text.
let imageProperties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any]
let orientationRaw = (imageProperties?[kCGImagePropertyOrientation] as? UInt32) ?? 1
let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up

// Reported width/height must describe the image *after* orientation is applied,
// because that is the frame the normalized boxes are expressed in.
let isQuarterTurned: Bool
switch orientation {
case .left, .leftMirrored, .right, .rightMirrored:
    isQuarterTurned = true
default:
    isQuarterTurned = false
}
let orientedWidth = isQuarterTurned ? cgImage.height : cgImage.width
let orientedHeight = isQuarterTurned ? cgImage.width : cgImage.height

// MARK: - Recognition

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// Simplified Chinese first: the corpus is Chinese chat UI with English product
// chrome ("Ask ChatGPT", "Follow"). Order matters — Vision treats the list as a
// priority order when a glyph is ambiguous between scripts.
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error.localizedDescription)")
}

var lines: [OcrLine] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append(
        OcrLine(
            text: candidate.string,
            x: round5(box.minX),
            // Bottom-left origin -> top-left origin.
            y: round5(1.0 - box.maxY),
            w: round5(box.width),
            h: round5(box.height),
            confidence: round5(CGFloat(candidate.confidence))
        )
    )
}

// Vision does not promise reading order, so impose a deterministic one:
// top-to-bottom, then left-to-right within the same visual row.
//
// ROW_TOLERANCE is a fraction of image height. Body text in this corpus has a
// line box height of ~0.019 (≈53 px on a 2781 px screenshot) and a baseline
// pitch of ~0.024. 0.008 is comfortably under one line pitch — so two genuinely
// stacked lines never collapse into one row — while still being wide enough to
// keep side-by-side elements (e.g. the "402 / 280 / 10" counter row) in
// left-to-right order despite their few-pixel vertical jitter.
let ROW_TOLERANCE = 0.008
lines.sort { a, b in
    let rowA = Int(((a.y + a.h / 2) / ROW_TOLERANCE).rounded(.down))
    let rowB = Int(((b.y + b.h / 2) / ROW_TOLERANCE).rounded(.down))
    if rowA != rowB { return rowA < rowB }
    return a.x < b.x
}

// MARK: - Output

let result = OcrResult(
    width: orientedWidth,
    height: orientedHeight,
    coordinateSystem: "normalized-top-left",
    lines: lines
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
do {
    FileHandle.standardOutput.write(try encoder.encode(result))
} catch {
    fail("cannot encode result: \(error.localizedDescription)")
}
