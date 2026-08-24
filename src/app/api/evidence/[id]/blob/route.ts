// GET /api/evidence/[id]/blob — the stored image for one evidence item.
//
// Evidence images live in `data/blobs/`, outside `public/`, and that is on
// purpose: they are the most sensitive bytes in the product and must not be
// reachable by guessing a static URL. Serving them through a route means the
// path always comes from the database, never from the request — the caller only
// ever supplies an evidence id.
//
// `no-store` because the response is private material; the browser may hold it
// for the length of the page and no longer.

import { readFile } from "node:fs/promises";

import { getDb } from "../../../../../server/db";
import { findEvidenceImage, resolveStoragePath } from "../../../../../server/evidence";

export const runtime = "nodejs";

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let image;
  try {
    image = findEvidenceImage(getDb(), id);
  } catch {
    return text("Cannot open the local database.", 500);
  }
  if (!image) return text("No such material, or it has no image.", 404);

  let bytes: Buffer;
  try {
    bytes = await readFile(resolveStoragePath(image.storagePath));
  } catch {
    // The row survives even when the blob does not (a half-restored backup, a
    // seed row pointing at a corpus that moved). 410 says "known, but gone".
    return text("The image file is gone; the material record remains.", 410);
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": image.mimeType,
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}
