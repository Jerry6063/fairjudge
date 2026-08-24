import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../src/app/api/blob/[sha]/route";
import {
  BLOB_EXTENSION,
  BLOB_MIME_TYPE,
  resolveBlobDir,
} from "../src/server/evidence/blob";
import { blobPath, isBlobSha, readBlob } from "../src/server/evidence/blob-store";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const SHA = "b".repeat(64);

/** The route's params arrive as a promise in Next 15. */
function get(sha: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/blob/${sha}`), {
    params: Promise.resolve({ sha }),
  });
}

describe("blob reads", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.FAIRJUDGE_BLOB_DIR;
    dir = await mkdtemp(join(tmpdir(), "fairjudge-blobs-"));
    process.env.FAIRJUDGE_BLOB_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FAIRJUDGE_BLOB_DIR;
    else process.env.FAIRJUDGE_BLOB_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  describe("name whitelist", () => {
    it("accepts exactly 64 lowercase hex characters", () => {
      expect(isBlobSha("0123456789abcdef".repeat(4))).toBe(true);
      expect(isBlobSha(SHA)).toBe(true);
    });

    it("refuses everything that is not a bare hash", () => {
      const rejected = [
        "",
        "..",
        "../../etc/passwd",
        `../${SHA}`,
        `${SHA}/../../etc/passwd`,
        `${SHA}${sep}x`,
        SHA.toUpperCase(), // the canonical form is lowercase
        SHA.slice(0, 63),
        `${SHA}a`,
        `${SHA}.jpg`, // the extension is ours to append, not the caller's
        `${SHA} `,
        "%2e%2e%2fetc%2fpasswd",
        "/etc/passwd",
        `..%2F${SHA}`,
        `${SHA}\u0000.jpg`, // NUL-terminated path trick
      ];
      for (const value of rejected) {
        expect(isBlobSha(value), value).toBe(false);
        expect(blobPath(value), value).toBeNull();
      }
    });

    it("resolves a valid name inside the blob directory, with the store's extension", () => {
      expect(blobPath(SHA)).toBe(join(resolveBlobDir(), `${SHA}${BLOB_EXTENSION}`));
      expect(resolveBlobDir()).toBe(dir);
    });
  });

  describe("readBlob", () => {
    it("returns null for a missing blob and for a directory", async () => {
      expect(await readBlob(SHA)).toBeNull();
      await mkdir(join(dir, `${"c".repeat(64)}${BLOB_EXTENSION}`));
      expect(await readBlob("c".repeat(64))).toBeNull();
    });

    it("returns the stored bytes with the store's content type", async () => {
      await writeFile(join(dir, `${SHA}${BLOB_EXTENSION}`), JPEG_BYTES);

      const blob = await readBlob(SHA);
      expect(blob?.mimeType).toBe(BLOB_MIME_TYPE);
      expect(blob?.bytes.byteLength).toBe(JPEG_BYTES.byteLength);
      expect(blob?.bytes[0]).toBe(0xff);
    });
  });

  describe("GET /api/blob/[sha]", () => {
    it("refuses a traversal attempt with 400", async () => {
      expect((await get("../../../etc/passwd")).status).toBe(400);
      expect((await get(`${SHA}.jpg`)).status).toBe(400);
    });

    it("404s an unknown hash", async () => {
      expect((await get(SHA)).status).toBe(404);
    });

    it("serves a stored blob, private and never re-sniffed", async () => {
      await writeFile(join(dir, `${SHA}${BLOB_EXTENSION}`), JPEG_BYTES);

      const response = await get(SHA);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(BLOB_MIME_TYPE);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // Content-addressed, so cacheable forever — but never in a shared cache.
      expect(response.headers.get("cache-control")).toContain("private");

      const body = new Uint8Array(await response.arrayBuffer());
      expect(body.byteLength).toBe(JPEG_BYTES.byteLength);
      expect(body[0]).toBe(0xff);
    });
  });
});
