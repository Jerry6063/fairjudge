// POST /api/evidence/upload — take screenshots in, hand evidence rows back.
//
// Thin, like /api/translate: read the multipart body, decide which case the
// material belongs to, and let `ingestEvidenceUpload` do the hashing, EXIF
// stripping, storage, transcription and grading. This file owns the wire format
// and the error copy, nothing else.
//
// One deliberate choice: a file that cannot be stored (not an image, too large)
// is reported in `rejected` while the rest of the batch still lands. Dropping
// nineteen good screenshots because the twentieth was a PDF would be the wrong
// trade for someone assembling a case file.

import {
  EVIDENCE_CASE_FIELD,
  EVIDENCE_KIND_FIELD,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_UPLOAD_FIELD,
  type EvidenceUploadErrorCode,
  type EvidenceUploadItem,
  type EvidenceUploadRejection,
  type EvidenceUploadResponseBody,
} from "../../../../lib/evidence-contract";
import { getDb } from "../../../../server/db";
import { isRegistrationKind } from "../../../../server/domain/grading";
import {
  UnreadableImageError,
  ingestEvidenceUpload,
  resolveDefaultCaseId,
} from "../../../../server/evidence";

// sharp, better-sqlite3 and the OCR subprocess all need the Node.js runtime.
export const runtime = "nodejs";

/** HTTP status per failure code — the single mapping table. */
const STATUS_BY_CODE: Record<EvidenceUploadErrorCode, number> = {
  invalid_request: 400,
  no_case: 409,
  internal: 500,
};

function json(body: EvidenceUploadResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(
  code: EvidenceUploadErrorCode,
  error: string,
  detail?: string,
): Response {
  return json(
    detail === undefined
      ? { ok: false, code, error }
      : { ok: false, code, error, detail },
    STATUS_BY_CODE[code],
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(
      "invalid_request",
      "Malformed upload: a multipart/form-data body is required.",
    );
  }

  const uploads = form
    .getAll(EVIDENCE_UPLOAD_FIELD)
    .filter((value): value is File => value instanceof File);

  if (uploads.length === 0) {
    return fail(
      "invalid_request",
      "There are no images in this request. Choose the screenshots to upload first.",
    );
  }
  if (uploads.length > EVIDENCE_MAX_FILES) {
    return fail(
      "invalid_request",
      `At most ${EVIDENCE_MAX_FILES} files per upload; this one had ${uploads.length}.`,
    );
  }

  const kindField = form.get(EVIDENCE_KIND_FIELD);
  if (kindField !== null && !isRegistrationKind(kindField)) {
    return fail("invalid_request", "That material type is not one of the options.");
  }
  const kind = kindField === null ? undefined : kindField;

  let db;
  let caseId: string | null;
  try {
    db = getDb();
    const requested = form.get(EVIDENCE_CASE_FIELD);
    caseId = typeof requested === "string" && requested.length > 0
      ? requested
      : resolveDefaultCaseId(db);
  } catch (error) {
    return fail(
      "internal",
      "Cannot open the local database. Check FAIRJUDGE_DB_KEY in .env.local.",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (caseId === null) {
    return fail(
      "no_case",
      "There is no case to file this material under. Run npm run seed:import to create one.",
    );
  }

  const items: EvidenceUploadItem[] = [];
  const rejected: EvidenceUploadRejection[] = [];

  // Sequential on purpose: each file runs an OCR subprocess and may run a model
  // call, and this is a single-user local app. Fanning them out would just make
  // the machine thrash.
  for (const upload of uploads) {
    const filename = upload.name === "" ? null : upload.name;

    if (upload.size > EVIDENCE_MAX_BYTES) {
      rejected.push({
        filename,
        reason: `File is ${megabytes(upload.size)}MB, over the ${megabytes(EVIDENCE_MAX_BYTES)}MB limit.`,
      });
      continue;
    }

    try {
      const result = await ingestEvidenceUpload(
        {
          caseId,
          bytes: Buffer.from(await upload.arrayBuffer()),
          filename,
          ...(kind === undefined ? {} : { kind }),
        },
        { db },
      );

      items.push({
        filename: result.filename,
        evidenceId: result.evidenceId,
        sha256: result.sha256,
        duplicate: result.duplicate,
        gradeSuggested: result.gradeSuggested,
        gradeFinal: result.gradeFinal,
        sourceType: result.sourceType,
        gradeReasons: result.gradeReasons,
        utteranceCount: result.utteranceCount,
        ...(result.ocrError === undefined ? {} : { ocrError: result.ocrError }),
      });
    } catch (error) {
      if (error instanceof UnreadableImageError) {
        rejected.push({
          filename,
          reason:
            "This file is not a readable image (PNG, JPEG, WebP and HEIC are supported).",
        });
        continue;
      }
      return fail(
        "internal",
        "This upload did not complete. Check the server logs.",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return json({ ok: true, items, rejected }, 200);
}
