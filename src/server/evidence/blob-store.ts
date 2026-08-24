/**
 * Reading blobs back out of the content-addressed store.
 *
 * The write side is `./blob.ts` (upload pipeline): it hashes the bytes the user
 * handed in, re-encodes the image to a metadata-free JPEG and stores it at
 * `<blobDir>/<sha>.jpg`. This module is the mirror — given the hash on a
 * `files` row, hand those bytes back — and it takes the directory, the
 * extension and the content type from there rather than restating them.
 *
 * Safety rests on one predicate: the requested name must be 64 lowercase hex
 * characters. That single whitelist rules out `..`, path separators, absolute
 * paths, NUL bytes, URL-encoded escapes and unicode normalisation games at
 * once — there is nothing to sanitize here, only to accept or reject — and the
 * extension is appended by us, so a request cannot name a file the store did
 * not create.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { BLOB_EXTENSION, BLOB_MIME_TYPE, resolveBlobDir } from "./blob";

/** The only name shape a blob can have: lowercase sha-256 hex, no extension. */
const SHA_PATTERN = /^[0-9a-f]{64}$/;

/** Whether `value` is a well-formed blob name, and therefore safe to join. */
export function isBlobSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

/**
 * Absolute path of a stored blob, or null when the name is not a valid hash.
 * The containment check is redundant given the pattern, and is the guard that
 * would catch a future loosening of it.
 */
export function blobPath(sha: string): string | null {
  if (!isBlobSha(sha)) return null;
  const dir = resolveBlobDir();
  const path = join(dir, `${sha}${BLOB_EXTENSION}`);
  return path.startsWith(dir + "/") ? path : null;
}

export interface BlobRead {
  /**
   * Backed by a plain `ArrayBuffer` rather than the default `ArrayBufferLike`:
   * a `Response` body will not take a view over a `SharedArrayBuffer`, so the
   * narrower type is what makes these bytes directly serveable.
   */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Always the store's own type: everything in there was re-encoded on write. */
  readonly mimeType: string;
}

/**
 * Read one blob. Returns null for a malformed name, a missing file, or anything
 * that is not a regular file — the caller cannot tell those apart and should
 * not: all three mean "no such blob".
 */
export async function readBlob(sha: string): Promise<BlobRead | null> {
  const path = blobPath(sha);
  if (path === null) return null;

  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    // Copy into a plain Uint8Array: a Response body wants exactly that.
    return { bytes: new Uint8Array(await readFile(path)), mimeType: BLOB_MIME_TYPE };
  } catch {
    return null;
  }
}
