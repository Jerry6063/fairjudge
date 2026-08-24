/**
 * Local OCR pipeline for evidence screenshots.
 *
 * Stage 1 is `tools/ocr/fairjudge-ocr`, a Swift CLI that runs Apple's Vision
 * framework on-device (see `tools/ocr/main.swift`). Stage 2 is here: turn the
 * flat list of recognized lines into message blocks with a speaker side, the
 * shape the evidence workbench and the utterance table want.
 *
 * Nothing in this module talks to the network. That is the point: the M2
 * decision was to keep OCR fully local, so no screenshot and no recognized text
 * is ever an egress event.
 *
 * Coordinates follow the binary's convention throughout — normalized to [0, 1]
 * against the oriented image, origin at the TOP-LEFT, y growing downwards.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One recognized text line, exactly as the Swift binary emits it. */
export interface OcrLine {
  readonly text: string;
  /** Left edge, normalized [0,1]. */
  readonly x: number;
  /** Top edge, normalized [0,1] (top-left origin). */
  readonly y: number;
  /** Width, normalized [0,1]. */
  readonly w: number;
  /** Height, normalized [0,1]. */
  readonly h: number;
  /** Vision's own confidence for the chosen candidate, [0,1]. */
  readonly confidence: number;
}

/** A whole recognized page. */
export interface OcrPage {
  readonly width: number;
  readonly height: number;
  readonly coordinateSystem: string;
  readonly lines: readonly OcrLine[];
}

/**
 * Which column of the chat the block sits in.
 *
 * `left`   — the other party (in this corpus: ChatGPT's replies, article body)
 * `right`  — the phone owner's own outgoing messages
 * `center` — status bar, timestamps, system notices; never a party's speech
 */
export type SpeakerSide = "left" | "right" | "center";

/** A cluster of lines that reads as one bubble / paragraph. */
export interface BubbleBlock {
  readonly side: SpeakerSide;
  readonly text: string;
  /** `HH:MM` when the block carries a clock reading (status bar, chat divider). */
  readonly timestamp?: string;
  /**
   * True when the block looks like UI chrome or a cut-off fragment rather than
   * speech (see NOISE_MAX_WIDTH / NOISE_MAX_CHARS). Callers should keep these —
   * the human confirmation step deletes them — but may render them dimmed and
   * should not seed utterances from them by default.
   */
  readonly noise: boolean;
  /** Union bounding box of the block's lines, same coordinate system. */
  readonly box: { x: number; y: number; w: number; h: number };
  readonly lines: readonly OcrLine[];
}

// ---------------------------------------------------------------------------
// Clustering constants
//
// Every value below was calibrated on a corpus of 14 chat screenshots (iOS
// assistant + social app, 1280 x 2781). The calibration harness that measured
// them was one-corpus tooling and is not in the repository; the constants are
// deliberately exported so a future corpus can retune them without a fork.
// ---------------------------------------------------------------------------

/**
 * Two vertically adjacent lines join the same block while the gap between them
 * stays under this multiple of the page's median line height.
 *
 * Measured over all 393 recognized lines, gap/medianHeight is sharply bimodal:
 * a peak at 0.0-0.5 (line wrap inside one paragraph) and a peak at ~1.25
 * (paragraph break), with a clear valley between 0.5 and 1.0. 0.9 sits in that
 * valley. It splits paragraphs into separate blocks, which is the safe
 * direction to err: over-splitting costs the reviewer an extra confirm click,
 * whereas under-splitting would fuse two speakers into one utterance.
 */
export const BLOCK_GAP_FACTOR = 0.9;

/**
 * A line counts as "indented" when its left edge sits this far right of the
 * page's left content margin. Used only to *split* blocks, never to decide the
 * side.
 *
 * Body text, bullets and block quotes in this corpus start at x = 0.035-0.101,
 * i.e. within 0.066 of the margin; right-hand bubbles start at x = 0.29. 0.12
 * separates the two with room to spare, so a right bubble never merges into the
 * assistant paragraph above it even when they are vertically close.
 */
export const INDENT_TOLERANCE = 0.12;

/**
 * Hard block break when a line's left edge jumps this far from the current
 * block's left edge. Backstop for the case where two bubbles are so close
 * vertically that BLOCK_GAP_FACTOR alone would merge them.
 *
 * Largest legitimate within-message jump observed is 0.066 (body text -> bullet
 * continuation line); the bubble-to-assistant jump is 0.258.
 */
export const LEFT_EDGE_JUMP = 0.15;

/**
 * The page's left content margin is the Nth percentile of all line left edges,
 * not the minimum — a single stray artifact at x≈0 must not drag the margin
 * left and make every real line look indented.
 */
export const PAGE_LEFT_PERCENTILE = 0.1;

/**
 * A block at least this wide cannot be a chat bubble, so it is treated as
 * full-width content (article body, assistant reply) and assigned `left`.
 *
 * Mobile chat UIs cap outgoing bubbles well below the frame width to leave an
 * avatar gutter: the widest real bubble here is 0.640. The Xiaohongshu nested
 * comment replies — indented under an avatar, therefore right-skewed and the
 * one thing that fools a pure asymmetry test — measure 0.726 and 0.739. 0.70
 * splits those two populations.
 */
export const FULL_WIDTH_MIN = 0.7;

/**
 * `leftGap - rightGap` must reach this for a block to be called `right`.
 *
 * Real outgoing bubbles measure +0.215, +0.221, +0.224. The Xiaohongshu nested
 * replies measure +0.160 and +0.163. 0.18 separates them, and is a second,
 * independent guard alongside FULL_WIDTH_MIN — a block must fail *both* tests
 * to be misread as an outgoing bubble.
 */
export const SIDE_ASYMMETRY_MIN = 0.18;

/** A near-symmetric block narrower than this reads as centered (timestamp/divider). */
export const CENTER_MAX_WIDTH = 0.6;

/** Lines above this y are candidates for the phone status bar. */
export const STATUS_BAR_MAX_Y = 0.06;

/**
 * Within the status-bar band, only lines whose vertical centre is this close to
 * the clock's own centre are treated as chrome.
 *
 * A tighter rule than "everything in the band" is required because these are
 * scrolling screenshots: real message text bleeds to y≈0, above the clock row.
 * Clock centres sit at 0.0342-0.0386; genuine bleed-through content measured
 * 0.0080-0.0291 and 0.0545-0.0618. 0.005 captures the battery/wifi glyphs that
 * share the clock's row while leaving that content classified normally.
 */
export const CLOCK_ROW_TOLERANCE = 0.005;

/** A block narrower than this *and* shorter than NOISE_MAX_CHARS is flagged `noise`. */
export const NOISE_MAX_WIDTH = 0.3;
/** See NOISE_MAX_WIDTH. Real message blocks in this corpus are far longer. */
export const NOISE_MAX_CHARS = 8;

/**
 * Recognises a wall-clock reading. Deliberately unanchored on the right: Vision
 * routinely fuses the status-bar clock with the adjacent silent-mode glyph
 * ("12:36" -> "12:364"), and an anchored pattern would reject every one of them.
 */
const CLOCK_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b|([01]?\d|2[0-3]):([0-5]\d)/;

const CJK_PATTERN = /[　-〿㐀-䶿一-鿿＀-￯]/;

// ---------------------------------------------------------------------------
// Binary location and build
// ---------------------------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this module rather than cwd so scripts and Next agree. */
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
export const OCR_SOURCE_PATH = path.join(REPO_ROOT, "tools", "ocr", "main.swift");
export const OCR_BINARY_PATH =
  process.env.FAIRJUDGE_OCR_BIN ?? path.join(REPO_ROOT, "tools", "ocr", "fairjudge-ocr");

let buildInFlight: Promise<void> | null = null;

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(command: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/**
 * Compile the Swift CLI if it is not already present. The binary is gitignored
 * (it is a build artifact, and a Mach-O blob has no business in the history),
 * so a fresh clone builds it on first OCR rather than failing.
 */
export async function ensureOcrBinary(): Promise<string> {
  if (await isExecutable(OCR_BINARY_PATH)) return OCR_BINARY_PATH;
  if (process.env.FAIRJUDGE_OCR_BIN) {
    throw new Error(
      `FAIRJUDGE_OCR_BIN points at ${OCR_BINARY_PATH}, which is not an executable file.`,
    );
  }
  // Collapse concurrent first-use builds onto one compiler invocation.
  buildInFlight ??= (async () => {
    const result = await run("xcrun", ["swiftc", "-O", OCR_SOURCE_PATH, "-o", OCR_BINARY_PATH]);
    if (result.code !== 0) {
      throw new Error(
        `Failed to build the OCR binary (xcrun swiftc exited ${String(result.code)}).\n` +
          `${result.stderr}\n` +
          "Xcode command line tools are required: xcode-select --install",
      );
    }
  })().finally(() => {
    buildInFlight = null;
  });
  await buildInFlight;
  return OCR_BINARY_PATH;
}

// ---------------------------------------------------------------------------
// Stage 1 — recognition
// ---------------------------------------------------------------------------

/** Run Vision OCR over one image and return its raw lines. */
export async function runOcr(imagePath: string): Promise<OcrPage> {
  const binary = await ensureOcrBinary();
  const result = await run(binary, [path.resolve(imagePath)]);
  if (result.code !== 0) {
    throw new Error(`OCR failed for ${imagePath}: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
  }
  const page = JSON.parse(result.stdout.toString("utf8")) as OcrPage;
  return page;
}

// ---------------------------------------------------------------------------
// Stage 2 — bubble clustering
// ---------------------------------------------------------------------------

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

/**
 * Join wrapped lines back into one string. CJK text wraps mid-sentence with no
 * space, so inserting one would corrupt the phrase; Latin text needs the space.
 * Decide per boundary rather than per block, since the corpus mixes both.
 */
function joinLines(lines: readonly OcrLine[]): string {
  return lines.reduce((accumulated, line, index) => {
    if (index === 0) return line.text;
    const left = accumulated.slice(-1);
    const right = line.text.slice(0, 1);
    const needsSpace =
      left !== "" && right !== "" && !CJK_PATTERN.test(left) && !CJK_PATTERN.test(right);
    return accumulated + (needsSpace ? " " : "") + line.text;
  }, "");
}

function extractTimestamp(text: string): string | undefined {
  const match = CLOCK_PATTERN.exec(text);
  if (!match) return undefined;
  const hour = match[1] ?? match[3];
  const minute = match[2] ?? match[4];
  if (hour === undefined || minute === undefined) return undefined;
  return `${hour.padStart(2, "0")}:${minute}`;
}

/**
 * Find the status-bar row, if this screenshot has one.
 *
 * Gated on actually seeing a clock in the top band: screenshot #2 of the corpus
 * is cropped below the status bar and opens straight into content at y = 0.017.
 * Without the gate that content would be silently demoted to `center`.
 */
function findClockRow(lines: readonly OcrLine[]): number | null {
  for (const line of lines) {
    if (line.y >= STATUS_BAR_MAX_Y) continue;
    if (extractTimestamp(line.text) !== undefined) return line.y + line.h / 2;
  }
  return null;
}

function classify(block: readonly OcrLine[], isChrome: boolean): SpeakerSide {
  if (isChrome) return "center";
  const left = Math.min(...block.map((line) => line.x));
  const right = Math.max(...block.map((line) => line.x + line.w));
  const width = right - left;
  // Asymmetry of the surrounding whitespace. This, not the block's centre, is
  // what a chat layout actually encodes: an outgoing bubble is flush right with
  // a wide gutter on the left, whatever its ragged last line does.
  const asymmetry = left - (1 - right);

  if (width >= FULL_WIDTH_MIN) return "left";
  if (asymmetry >= SIDE_ASYMMETRY_MIN) return "right";
  if (asymmetry <= -SIDE_ASYMMETRY_MIN) return "left";
  if (width <= CENTER_MAX_WIDTH) return "center";
  return "left";
}

/**
 * Group recognized lines into message blocks and assign each a speaker side.
 *
 * Pure function over the binary's output — no I/O — so it is unit-testable
 * against recorded fixtures without a Mac or a screenshot.
 */
export function clusterBubbles(page: OcrPage): BubbleBlock[] {
  const lines = page.lines.filter((line) => line.text.trim() !== "");
  if (lines.length === 0) return [];

  const medianHeight = percentile(
    lines.map((line) => line.h),
    0.5,
  );
  const pageLeft = percentile(
    lines.map((line) => line.x),
    PAGE_LEFT_PERCENTILE,
  );
  const clockRow = findClockRow(lines);

  const isChromeLine = (line: OcrLine): boolean =>
    clockRow !== null &&
    line.y < STATUS_BAR_MAX_Y &&
    Math.abs(line.y + line.h / 2 - clockRow) <= CLOCK_ROW_TOLERANCE;

  const isIndented = (line: OcrLine): boolean => line.x - pageLeft > INDENT_TOLERANCE;

  const groups: OcrLine[][] = [];
  let current: OcrLine[] = [];
  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous !== undefined) {
      const gap = line.y - (previous.y + previous.h);
      const blockLeft = Math.min(...current.map((entry) => entry.x));
      const breaks =
        gap > BLOCK_GAP_FACTOR * medianHeight ||
        isIndented(line) !== isIndented(previous) ||
        isChromeLine(line) !== isChromeLine(previous) ||
        Math.abs(line.x - blockLeft) > LEFT_EDGE_JUMP;
      if (breaks) {
        groups.push(current);
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const chrome = group.every(isChromeLine);
    const text = joinLines(group);
    const left = Math.min(...group.map((line) => line.x));
    const top = Math.min(...group.map((line) => line.y));
    const right = Math.max(...group.map((line) => line.x + line.w));
    const bottom = Math.max(...group.map((line) => line.y + line.h));
    const width = right - left;
    const timestamp = extractTimestamp(text);
    const noise = width < NOISE_MAX_WIDTH && text.length <= NOISE_MAX_CHARS;

    const block: BubbleBlock = {
      side: classify(group, chrome),
      text,
      noise,
      box: { x: left, y: top, w: width, h: bottom - top },
      lines: group,
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
    return block;
  });
}

/** Recognize one screenshot and return both the raw page and its message blocks. */
export async function ocrScreenshot(
  imagePath: string,
): Promise<{ page: OcrPage; blocks: BubbleBlock[] }> {
  const page = await runOcr(imagePath);
  return { page, blocks: clusterBubbles(page) };
}
