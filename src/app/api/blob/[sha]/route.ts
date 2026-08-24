// GET /api/blob/<sha256> — serve one evidence blob from data/blobs.
//
// Thin on purpose: the whitelist, the path resolution and the content sniffing
// all live in `src/server/evidence/blob-store.ts`, where they are unit-tested
// without a server. This file owns the HTTP shape only.
//
// Blobs are content-addressed, so a hit is immutable and cached forever;
// `private` keeps it out of shared caches, since screenshots of someone's
// relationship are not public data.

import { isBlobSha, readBlob } from "../../../../server/evidence/blob-store";

// Reads the filesystem — Node.js runtime, never edge.
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sha: string }> },
): Promise<Response> {
  const { sha } = await context.params;

  if (!isBlobSha(sha)) {
    return new Response("invalid blob id", { status: 400 });
  }

  const blob = await readBlob(sha);
  if (blob === null) {
    return new Response("blob not found", { status: 404 });
  }

  return new Response(blob.bytes, {
    status: 200,
    headers: {
      "content-type": blob.mimeType,
      "content-length": String(blob.bytes.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      // Whatever the bytes turn out to be, the browser must not reinterpret
      // them as something executable.
      "x-content-type-options": "nosniff",
    },
  });
}
