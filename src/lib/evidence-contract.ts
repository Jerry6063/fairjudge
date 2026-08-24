// Wire contract for `POST /api/evidence/upload`, shared by the route handler
// and the `/evidence` page.
//
// Types plus a few constants the browser genuinely needs (accepted types, size
// ceiling, field name). Every import is type-only and erased at compile time,
// so nothing from `src/server/` reaches the client bundle while the response
// shape still tracks what intake actually returns.

import type { EvidenceGrade, EvidenceSourceType } from "../server/db/schema";
import type { GradeReason, RegistrationKind } from "../server/domain/grading";

export type { EvidenceGrade, EvidenceSourceType, GradeReason, RegistrationKind };

/** Multipart field the files arrive under. Repeat it to send several at once. */
export const EVIDENCE_UPLOAD_FIELD = "file";

/** Optional multipart fields: which case, and what kind of material it is. */
export const EVIDENCE_CASE_FIELD = "caseId";
export const EVIDENCE_KIND_FIELD = "kind";

/** Per-file ceiling. A phone screenshot is ~1 MB; 25 MB is room to spare. */
export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/** Files per request, so one stray drop cannot queue a hundred OCR runs. */
export const EVIDENCE_MAX_FILES = 20;

/** What the file picker offers. sharp decides for real; this is just the hint. */
export const EVIDENCE_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif";

/**
 * One file's outcome. `duplicate` means the exact bytes were already in the
 * case: no blob was written, no second transcription was produced, and the
 * existing evidence id is returned instead.
 */
export interface EvidenceUploadItem {
  filename: string | null;
  evidenceId: string;
  sha256: string;
  duplicate: boolean;
  gradeSuggested: EvidenceGrade | null;
  gradeFinal: EvidenceGrade | null;
  sourceType: EvidenceSourceType;
  gradeReasons: GradeReason[];
  /** Utterances waiting in the confirmation workbench for this item. */
  utteranceCount: number;
  /** Set when OCR failed; the evidence is stored regardless. */
  ocrError?: string;
}

/** One file that could not be stored at all. Others in the batch still land. */
export interface EvidenceUploadRejection {
  filename: string | null;
  /** User-facing reason. */
  reason: string;
}

/**
 * Failure taxonomy. Each code maps to exactly one HTTP status in the route:
 * `invalid_request` → 400, `no_case` → 409, `internal` → 500.
 */
export type EvidenceUploadErrorCode = "invalid_request" | "no_case" | "internal";

export interface EvidenceUploadSuccessBody {
  ok: true;
  items: EvidenceUploadItem[];
  rejected: EvidenceUploadRejection[];
}

export interface EvidenceUploadErrorBody {
  ok: false;
  code: EvidenceUploadErrorCode;
  /** User-facing message; safe to render as-is. */
  error: string;
  /** Diagnostic detail from the server internals. Never PII. */
  detail?: string;
}

export type EvidenceUploadResponseBody =
  | EvidenceUploadSuccessBody
  | EvidenceUploadErrorBody;
