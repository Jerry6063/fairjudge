/**
 * Blob storage for evidence images.
 *
 * Two jobs: give every uploaded image a content-addressed home under
 * `data/blobs/`, and make sure what lands there is a *re-encoded* image rather
 * than the file the user picked.
 *
 * The re-encode is the point. A phone screenshot carries EXIF — capture time,
 * device model, sometimes GPS — and this product's whole premise is that
 * intimate material stays local and minimal. sharp decodes to pixels and writes
 * a fresh JPEG, so nothing but the pixels survives; `.rotate()` first bakes the
 * EXIF orientation into those pixels, because an image stripped of its
 * orientation tag without being rotated displays sideways.
 *
 * Nothing here talks to the network.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

/** Re-encode quality. High enough that OCR reads the result as well as the original. */
export const JPEG_QUALITY = 90;

/** Every stored blob is a JPEG, whatever came in. */
export const BLOB_MIME_TYPE = "image/jpeg";
export const BLOB_EXTENSION = ".jpg";

/**
 * Where blobs live, relative to the process working directory — the same
 * convention as `DEFAULT_DB_PATH` in `server/db`, so `npm run dev` and the
 * scripts agree without resolving anything from `import.meta.url` (which moves
 * under the Next.js bundler).
 */
export const DEFAULT_BLOB_DIR = "data/blobs";

/** Absolute blob directory: `FAIRJUDGE_BLOB_DIR` if set, else `<cwd>/data/blobs`. */
export function resolveBlobDir(explicit?: string): string {
  return path.resolve(
    explicit ?? process.env.FAIRJUDGE_BLOB_DIR ?? DEFAULT_BLOB_DIR,
  );
}

/** Hex SHA-256 of a buffer. The identity of an upload, and its blob filename. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Storage path recorded on the `files` row, e.g. `data/blobs/<sha>.jpg`.
 *
 * Relative to the working directory whenever the blob lives under it, so the
 * database survives the project being moved; absolute otherwise (a test
 * pointing `blobDir` at a temp directory). Absolute paths from the M0 seed
 * importer keep working either way — see `resolveStoragePath`.
 */
export function blobStoragePath(sha256: string, blobDir?: string): string {
  const absolute = path.join(
    resolveBlobDir(blobDir),
    `${sha256}${BLOB_EXTENSION}`,
  );
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? absolute
    : relative;
}

/** Turn a stored `files.storage_path` into an absolute path. */
export function resolveStoragePath(storagePath: string): string {
  return path.resolve(storagePath);
}

export interface SanitizedImage {
  /** Re-encoded JPEG bytes, EXIF-free and orientation-baked. */
  bytes: Buffer;
  width: number;
  height: number;
}

/** Thrown when the uploaded bytes are not an image sharp can decode. */
export class UnreadableImageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UnreadableImageError";
  }
}

/**
 * Decode, auto-orient and re-encode as JPEG. The output carries no EXIF, no
 * XMP and no ICC profile: sharp only copies metadata when explicitly asked
 * (`keepMetadata` / `withExif`), and we never ask.
 */
export async function sanitizeImage(input: Buffer): Promise<SanitizedImage> {
  try {
    const { data, info } = await sharp(input, {
      // Accept slightly imperfect files (a truncated last scan line is common in
      // screenshots shared through chat apps); only a hard decode failure is
      // worth rejecting an upload over.
      failOn: "error",
    })
      .rotate()
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return { bytes: data, width: info.width, height: info.height };
  } catch (cause) {
    throw new UnreadableImageError(cause);
  }
}

/**
 * Write blob bytes to `<blobDir>/<sha>.jpg`, atomically.
 *
 * Content-addressed, so re-writing an existing blob is a no-op in effect; the
 * temp-file + rename dance means a crash mid-write can never leave a truncated
 * image at the real path.
 */
export async function writeBlob(
  sha256: string,
  bytes: Buffer,
  blobDir?: string,
): Promise<string> {
  const dir = resolveBlobDir(blobDir);
  await mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, `${sha256}${BLOB_EXTENSION}`);
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, finalPath);
  return finalPath;
}
