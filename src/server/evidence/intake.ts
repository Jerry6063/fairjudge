/**
 * Evidence intake — one uploaded image, end to end.
 *
 * hash → sanitize → store → OCR → anomaly check → grade → one database write.
 *
 * Two properties are worth stating up front, because everything else follows
 * from them:
 *
 * IDEMPOTENT. Identity is the SHA-256 of the bytes the user handed us, not of
 * what we stored: re-encoding is ours to change (a future sharp release could
 * emit different JPEG bytes for the same input), while the uploaded file is
 * what the user thinks of as "that screenshot". Uploading the same image twice
 * therefore returns the first evidence row, unchanged — no second blob, no
 * second OCR pass, and above all no second set of utterances for the reviewer
 * to confirm.
 *
 * NOTHING IS CONFIRMED. Every utterance lands `pending`, and the grade lands in
 * `grade_suggested` with `grade_final` NULL. Intake produces claims for a human
 * to accept, never accepted claims (HARD RULE #1).
 *
 * The order is deliberate: OCR and the anomaly check are async and happen
 * *before* the database work, so all the row writing sits in one synchronous
 * better-sqlite3 transaction that either lands whole or not at all.
 */

import { and, count, eq } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";

import { getDb, type Db } from "../db";
import {
  evidence as evidenceTable,
  files as filesTable,
  utterances as utterancesTable,
  type EvidenceGrade,
  type EvidenceSourceType,
} from "../db/schema";
import {
  DEFAULT_REGISTRATION_KIND,
  deriveGradeForRegistration,
  type EvidenceAnomaly,
  type GradeReason,
  type RegistrationKind,
} from "../domain/grading";
import { ocrScreenshot, type BubbleBlock } from "../ocr";
import {
  blobStoragePath,
  sanitizeImage,
  sha256Hex,
  writeBlob,
  BLOB_MIME_TYPE,
} from "./blob";
import {
  buildCaseDict,
  buildOcrDigest,
  checkEvidenceAnomaly,
  type AnomalyChecker,
} from "./anomaly";

/** How much OCR text is kept on `evidence.content_summary` for list views. */
export const CONTENT_SUMMARY_MAX_CHARS = 160;

/**
 * Read side of the database, satisfied by both the client and a transaction
 * handle — the dedupe lookup runs once before the write and once inside it.
 */
type Queryable = Pick<Db, "select">;

/* -------------------------------------------------------------------------- */
/* IO types                                                                   */
/* -------------------------------------------------------------------------- */

export interface IngestInput {
  caseId: string;
  /** Raw uploaded bytes, exactly as received. */
  bytes: Buffer;
  /** Original filename, kept for the reviewer's orientation only. */
  filename?: string | null;
  /** What the uploader says this is. Defaults to a plain screenshot. */
  kind?: RegistrationKind;
  /** Set when this item was produced from evidence already in the case. */
  derivedFromEvidenceId?: string | null;
}

export interface IngestResult {
  evidenceId: string;
  fileId: string;
  /** SHA-256 of the uploaded bytes — the dedupe key. */
  sha256: string;
  /** True when this exact image was already in the case; nothing was written. */
  duplicate: boolean;
  filename: string | null;
  storagePath: string;
  /** Machine suggestion. Null on a seeded row written before grading existed. */
  gradeSuggested: EvidenceGrade | null;
  /** Human-confirmed grade — always null for a fresh upload. */
  gradeFinal: EvidenceGrade | null;
  sourceType: EvidenceSourceType;
  /** Which grading rules fired. Empty for a duplicate (nothing was graded). */
  gradeReasons: GradeReason[];
  anomaly: EvidenceAnomaly | null;
  /** Utterances attached to this evidence — the reviewer's queue length. */
  utteranceCount: number;
  /** Set when this call ran OCR and it failed; the upload itself still stands. */
  ocrError?: string;
}

/** Seams for tests and for callers that want the LLM step off. */
export interface IngestOptions {
  db?: Db;
  /** Local OCR entry point. Defaults to the Vision pipeline in `server/ocr`. */
  ocr?: (imagePath: string) => Promise<{ blocks: BubbleBlock[] }>;
  /** Anomaly checker. Defaults to one `evidence_anomaly_check` stage run. */
  anomalyChecker?: AnomalyChecker;
  /** Set false to grade from `source_type` alone (no egress at all). */
  checkAnomaly?: boolean;
  /** Blob directory override. Defaults to `<cwd>/data/blobs`. */
  blobDir?: string;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Store one uploaded image as a file + evidence row, transcribe it, and suggest
 * a grade. Re-uploading the same bytes returns the existing evidence.
 */
export async function ingestEvidenceUpload(
  input: IngestInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const db = options.db ?? getDb();
  const runOcr = options.ocr ?? ocrScreenshot;
  const kind = input.kind ?? DEFAULT_REGISTRATION_KIND;
  const filename = input.filename ?? null;

  const sha256 = sha256Hex(input.bytes);

  // 1. Already here? Then this call must change nothing.
  const existing = findExisting(db, input.caseId, sha256);
  if (existing) return existing;

  // 2. Re-encode (drops EXIF) and store under the hash of the ORIGINAL bytes.
  const sanitized = await sanitizeImage(input.bytes);
  const absolutePath = await writeBlob(sha256, sanitized.bytes, options.blobDir);
  const storagePath = blobStoragePath(sha256, options.blobDir);

  // 3. Local OCR. Best-effort: a missing Xcode toolchain must not cost the user
  //    their upload — the workbench can re-run transcription later.
  let blocks: BubbleBlock[] = [];
  let ocrError: string | undefined;
  try {
    ({ blocks } = await runOcr(absolutePath));
  } catch (error) {
    ocrError = error instanceof Error ? error.message : String(error);
  }

  const speech = blocks.filter(
    (block) => !block.noise && block.text.trim() !== "",
  );

  // 4. The one egress point, on a digest of the recognized text.
  const digest = buildOcrDigest(blocks);
  const anomaly =
    options.checkAnomaly === false || digest === ""
      ? null
      : await (options.anomalyChecker ?? checkEvidenceAnomaly)(digest, {
          caseId: input.caseId,
          dict: buildCaseDict(db, input.caseId),
        });

  // 5. Grade by rule. Suggestion only.
  const decision = deriveGradeForRegistration(kind, {
    derivedFromEvidenceId: input.derivedFromEvidenceId ?? null,
    anomaly,
  });

  // 6. One transaction: file, evidence, utterances.
  const written = db.transaction((tx) => {
    // Re-check inside the transaction: two uploads of the same image racing
    // each other would both have missed the check in step 1.
    const raced = findExisting(tx, input.caseId, sha256);
    if (raced) return raced;

    const [file] = tx
      .insert(filesTable)
      .values({
        caseId: input.caseId,
        kind: "screenshot",
        originalFilename: filename,
        storagePath,
        sha256,
        byteSize: sanitized.bytes.byteLength,
        mimeType: BLOB_MIME_TYPE,
      })
      .returning({ id: filesTable.id })
      .all();

    const [row] = tx
      .insert(evidenceTable)
      .values({
        caseId: input.caseId,
        fileId: file.id,
        sourceType: decision.sourceType,
        gradeSuggested: decision.grade,
        // grade_final stays NULL: a human confirms it in the workbench.
        gradeRationale: decision.rationale,
        gradeAnomaly: anomaly ? { ...anomaly } : null,
        contentSummary: summarize(speech),
      })
      .returning({ id: evidenceTable.id })
      .all();

    const orderKeys = generateNKeysBetween(null, null, speech.length);
    speech.forEach((block, index) => {
      tx.insert(utterancesTable)
        .values({
          caseId: input.caseId,
          evidenceId: row.id,
          // The OCR side (left / right / center) is a *guess* at who spoke,
          // recorded as the label the workbench asks the human to correct into
          // a real participant.
          speakerLabel: block.side,
          isRetold: false,
          aiDraft: block.text,
          confirmStatus: "pending",
          orderKey: orderKeys[index],
        })
        .run();
    });

    return { fileId: file.id, evidenceId: row.id };
  });

  if ("duplicate" in written) return written;

  return {
    evidenceId: written.evidenceId,
    fileId: written.fileId,
    sha256,
    duplicate: false,
    filename,
    storagePath,
    gradeSuggested: decision.grade,
    gradeFinal: null,
    sourceType: decision.sourceType,
    gradeReasons: decision.reasons,
    anomaly,
    utteranceCount: speech.length,
    ...(ocrError === undefined ? {} : { ocrError }),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The already-ingested result for these bytes, or undefined.
 *
 * Matches on (case, sha256) — the natural key `files` already enforces with a
 * unique index — and requires the evidence row to exist too, so a half-written
 * import (file row without evidence) is re-ingested rather than resurrected as
 * a phantom duplicate.
 */
function findExisting(
  db: Queryable,
  caseId: string,
  sha256: string,
): IngestResult | undefined {
  const [row] = db
    .select({
      fileId: filesTable.id,
      filename: filesTable.originalFilename,
      storagePath: filesTable.storagePath,
      evidenceId: evidenceTable.id,
      gradeSuggested: evidenceTable.gradeSuggested,
      gradeFinal: evidenceTable.gradeFinal,
      sourceType: evidenceTable.sourceType,
      anomaly: evidenceTable.gradeAnomaly,
    })
    .from(filesTable)
    .innerJoin(evidenceTable, eq(evidenceTable.fileId, filesTable.id))
    .where(and(eq(filesTable.caseId, caseId), eq(filesTable.sha256, sha256)))
    .all();

  if (!row) return undefined;

  const [counted] = db
    .select({ n: count() })
    .from(utterancesTable)
    .where(eq(utterancesTable.evidenceId, row.evidenceId))
    .all();

  return {
    evidenceId: row.evidenceId,
    fileId: row.fileId,
    sha256,
    duplicate: true,
    filename: row.filename,
    storagePath: row.storagePath ?? "",
    gradeSuggested: row.gradeSuggested,
    gradeFinal: row.gradeFinal,
    sourceType: row.sourceType,
    // Nothing was graded on this call, so there is no rule trace to report.
    gradeReasons: [],
    anomaly: (row.anomaly as EvidenceAnomaly | null) ?? null,
    utteranceCount: counted?.n ?? 0,
  };
}

/** First few lines of recognized speech, for the evidence list. */
function summarize(blocks: readonly BubbleBlock[]): string | null {
  const text = blocks
    .map((block) => block.text.trim())
    .join(" / ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return text.length <= CONTENT_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, CONTENT_SUMMARY_MAX_CHARS)}…`;
}
