/**
 * Evidence workbench — the server-side data layer behind `/evidence/[id]`.
 *
 * Every change the confirmation workbench can make to an utterance goes through
 * this module, and every entry point re-derives two things the client is not
 * trusted to assert:
 *
 *   1. Ownership — the utterance must belong to the evidence named in the
 *      request, and share its case. Swapping an id in a form post must not let
 *      one screenshot's reviewer confirm a line of another.
 *   2. Transition legality — `rejected` is terminal. A line the reviewer threw
 *      away must not be able to come back as citable material through a later
 *      click; that is HARD RULE #1 (unconfirmed material is not citable) seen from the write
 *      side, and it is enforced here rather than by hiding a button.
 *
 * `listCitableUtterances` is the read side of the same rule: it is the only
 * sanctioned way for downstream stages to pull utterance text, and it filters
 * on `confirm_status` in SQL so a caller cannot forget to.
 *
 * Since M5 the same read filters on visibility in the same WHERE clause (SPEC
 * M5 ①). The two rules ride together deliberately: "a human confirmed this" and
 * "this is mine to read" are both questions the database answers before a row
 * becomes text, and splitting them across two layers is how one of them ends up
 * applied in three call sites out of four. Every read below takes a
 * `MaterialAudience` defaulting to `CASE_RECORD`, so no existing caller changed
 * behaviour and no new caller reads cross-party by omitting an argument.
 *
 * Everything is synchronous (better-sqlite3) and takes an explicit `Db`, so the
 * state machine is testable against an in-memory database with no Next runtime.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import {
  summarizeConfirmProgress,
  type ConfirmProgress,
} from "../../lib/confirm-progress";
import { TIMESTAMP_SPEAKER_LABEL } from "../../lib/utterance-speaker";
import {
  CASE_RECORD,
  isVisible,
  resolveMaterialGrant,
  visibleMaterial,
  type MaterialAudience,
} from "../access/visibility";
import type { Db } from "../db";
import {
  EVIDENCE_GRADES,
  UTTERANCE_TONES,
  caseParticipants,
  evidence,
  files,
  utterances,
  type ConfirmStatus,
  type EvidenceGrade,
  type EvidenceSourceType,
  type UtteranceTone,
} from "../db/schema";
import { GRADE_BY_SOURCE_TYPE } from "../domain/grading";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Confirm statuses whose text may be cited downstream (HARD RULE #1). `edited`
 * counts because the human wrote that text themselves; `pending` and `rejected`
 * never do.
 */
export const CITABLE_STATUSES = ["confirmed", "edited"] as const;

/**
 * Re-exported for callers that already depend on this module: the marker and
 * the rules for reading it live in `lib/utterance-speaker`, because the client
 * needs them too and must not import anything from `src/server/`.
 */
export { TIMESTAMP_SPEAKER_LABEL };

/**
 * Legal confirm-status transitions for an utterance.
 *
 * Re-confirming an already-settled row is a no-op rather than an error (the
 * reviewer may click twice, or re-save the same text), but nothing leaves
 * `rejected`.
 */
export const UTTERANCE_TRANSITIONS: Readonly<
  Record<ConfirmStatus, readonly ConfirmStatus[]>
> = {
  pending: ["confirmed", "edited", "rejected"],
  confirmed: ["confirmed", "edited", "rejected"],
  edited: ["confirmed", "edited", "rejected"],
  rejected: [],
};

/** Whether `from -> to` is a legal utterance confirm-status transition. */
export function canTransition(from: ConfirmStatus, to: ConfirmStatus): boolean {
  return UTTERANCE_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type WorkbenchErrorCode =
  | "evidence_not_found"
  | "utterance_not_found"
  | "ownership_mismatch"
  | "illegal_transition"
  | "empty_text"
  | "invalid_tone"
  | "invalid_grade"
  | "speaker_not_in_case";

/**
 * A rejected request with a code for callers and Chinese copy for the UI.
 * Anything that is not a `WorkbenchError` is a bug, not a user mistake, and is
 * left to propagate.
 */
export class WorkbenchError extends Error {
  readonly code: WorkbenchErrorCode;

  constructor(code: WorkbenchErrorCode, message: string) {
    super(message);
    this.name = "WorkbenchError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* View models                                                                */
/* -------------------------------------------------------------------------- */

/** One utterance row as the workbench (and its server actions) exchange it. */
export interface WorkbenchUtterance {
  readonly id: string;
  readonly evidenceId: string;
  /** OCR / model draft, kept verbatim as provenance even after an edit. */
  readonly aiDraft: string | null;
  /** Human-owned text; null until the row is confirmed or rewritten. */
  readonly humanFinal: string | null;
  /** What to display and what downstream stages would cite: final ?? draft. */
  readonly text: string;
  readonly confirmStatus: ConfirmStatus;
  readonly isRetold: boolean;
  readonly tone: UtteranceTone | null;
  readonly speakerParticipantId: string | null;
  readonly speakerLabel: string | null;
  readonly orderKey: string | null;
}

/** Evidence header shown above the two columns. */
export interface WorkbenchEvidence {
  readonly id: string;
  readonly caseId: string;
  readonly sourceType: EvidenceSourceType;
  /** Null until a human signs off — the intake pipeline only fills the suggestion. */
  readonly gradeFinal: EvidenceGrade | null;
  /**
   * The machine's answer, shown next to the control so an override is visible
   * as one. Falls back to the source_type rule for rows written before
   * `grade_suggested` existed (the M0 seed import).
   */
  readonly gradeSuggested: EvidenceGrade;
  readonly gradeRationale: string | null;
  /** Epoch ms of the human sign-off; null while the grade is still a suggestion. */
  readonly gradeConfirmedAt: number | null;
  readonly contentSummary: string | null;
}

/** The backing image, when this evidence came from an uploaded file. */
export interface WorkbenchImage {
  readonly sha256: string;
  readonly originalFilename: string | null;
  readonly mimeType: string | null;
}

/** A party of the case, for the speaker-attribution control. */
export interface WorkbenchParticipant {
  readonly id: string;
  readonly pseudonym: string;
  readonly displayName: string | null;
}

/** Confirmation progress; `complete` drives the "done" state of the page. */
export interface WorkbenchProgress extends ConfirmProgress {
  readonly gradeConfirmed: boolean;
  /** Grade signed off and every line decided — this evidence is done. */
  readonly complete: boolean;
}

export interface WorkbenchData {
  readonly evidence: WorkbenchEvidence;
  readonly image: WorkbenchImage | null;
  readonly participants: readonly WorkbenchParticipant[];
  readonly utterances: readonly WorkbenchUtterance[];
  readonly progress: WorkbenchProgress;
}

/** An utterance that downstream stages are allowed to quote. */
export interface CitableUtterance {
  readonly id: string;
  readonly evidenceId: string | null;
  readonly text: string;
  readonly speakerLabel: string | null;
  readonly isRetold: boolean;
  readonly tone: UtteranceTone | null;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** Every utterance mutation carries the parent evidence id for the ownership check. */
export interface UtteranceRef {
  readonly evidenceId: string;
  readonly utteranceId: string;
}

/** Speaker attribution: one of the parties, or "this line is not speech". */
export type SpeakerAssignment =
  | { readonly kind: "participant"; readonly participantId: string }
  | { readonly kind: "timestamp" };

/** Partial metadata update; omitted fields are left alone. */
export interface UtteranceAttributes {
  readonly isRetold?: boolean;
  /** `null` clears the tone label back to "unlabelled". */
  readonly tone?: UtteranceTone | null;
  readonly speaker?: SpeakerAssignment;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

type EvidenceRow = typeof evidence.$inferSelect;
type UtteranceRow = typeof utterances.$inferSelect;

function toWorkbenchUtterance(row: UtteranceRow): WorkbenchUtterance {
  return {
    id: row.id,
    // `evidence_id` is nullable in the schema (ON DELETE SET NULL), but every
    // row reachable from the workbench was fetched through its evidence.
    evidenceId: row.evidenceId ?? "",
    aiDraft: row.aiDraft,
    humanFinal: row.humanFinal,
    text: row.humanFinal ?? row.aiDraft ?? "",
    confirmStatus: row.confirmStatus,
    isRetold: row.isRetold,
    tone: row.tone,
    speakerParticipantId: row.speakerParticipantId,
    speakerLabel: row.speakerLabel,
    orderKey: row.orderKey,
  };
}

function findEvidence(db: Db, evidenceId: string): EvidenceRow | undefined {
  return db.select().from(evidence).where(eq(evidence.id, evidenceId)).all()[0];
}

function requireEvidence(db: Db, evidenceId: string): EvidenceRow {
  const row = findEvidence(db, evidenceId);
  if (row === undefined) {
    throw new WorkbenchError(
      "evidence_not_found",
      "This evidence is not in the database; it may have been deleted.",
    );
  }
  return row;
}

/**
 * Load an utterance and prove it belongs where the caller claims.
 * Case mismatch is treated as the same failure as evidence mismatch: from the
 * client's side both are "this row is not yours to touch".
 */
function requireUtterance(db: Db, ref: UtteranceRef): UtteranceRow {
  const parent = requireEvidence(db, ref.evidenceId);
  const row = db
    .select()
    .from(utterances)
    .where(eq(utterances.id, ref.utteranceId))
    .all()[0];

  if (row === undefined) {
    throw new WorkbenchError(
      "utterance_not_found",
      "This line is not in the database; it may have been deleted.",
    );
  }
  if (row.evidenceId !== parent.id || row.caseId !== parent.caseId) {
    throw new WorkbenchError(
      "ownership_mismatch",
      "This line does not belong to the evidence being edited; the change was refused.",
    );
  }
  return row;
}

const REJECTED_MESSAGE =
  "This line was deleted and can no longer be confirmed or edited. To get it back, run transcription on the screenshot again.";

/** Guard the write side of the state machine: nothing leaves `rejected`. */
function requireTransition(row: UtteranceRow, to: ConfirmStatus): void {
  if (!canTransition(row.confirmStatus, to)) {
    throw new WorkbenchError("illegal_transition", REJECTED_MESSAGE);
  }
}

/**
 * Guard a write that does *not* move `confirm_status` (the metadata controls).
 *
 * The transition table cannot express this one: `pending -> pending` is not a
 * transition, yet labelling a still-unconfirmed line is the normal case. The
 * actual rule is narrower — a state with no outgoing transitions is terminal,
 * and a terminal row accepts no writes at all.
 */
function requireWritable(row: UtteranceRow): void {
  if (UTTERANCE_TRANSITIONS[row.confirmStatus].length === 0) {
    throw new WorkbenchError("illegal_transition", REJECTED_MESSAGE);
  }
}

function writeUtterance(
  db: Db,
  id: string,
  values: Partial<UtteranceRow>,
): WorkbenchUtterance {
  const [updated] = db
    .update(utterances)
    .set(values)
    .where(eq(utterances.id, id))
    .returning()
    .all();
  return toWorkbenchUtterance(updated);
}

/* -------------------------------------------------------------------------- */
/* Utterance mutations                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Accept the current text as-is (pending → confirmed).
 *
 * The draft is copied into `human_final` on the way, so a later re-run of OCR
 * cannot silently change text a human already signed off. Confirming a row that
 * is already `confirmed`/`edited` keeps its status — an `edited` row stays
 * edited, because the text is still the human's, not the machine's.
 */
export function confirmUtterance(db: Db, ref: UtteranceRef): WorkbenchUtterance {
  const row = requireUtterance(db, ref);
  const next: ConfirmStatus =
    row.confirmStatus === "pending" ? "confirmed" : row.confirmStatus;
  requireTransition(row, next);

  const text = row.humanFinal ?? row.aiDraft;
  if (text === null || text.trim() === "") {
    throw new WorkbenchError(
      "empty_text",
      "There is no text to confirm on this line. Rewrite it first, or delete it.",
    );
  }

  return writeUtterance(db, row.id, { humanFinal: text, confirmStatus: next });
}

/**
 * Replace the text with the reviewer's own wording (→ edited).
 *
 * Saving text identical to the draft is recorded as `confirmed`, not `edited`:
 * a rewrite that changed nothing is a confirmation, and the distinction is what
 * later tells us how much of the corpus the machine actually got right.
 */
export function editUtterance(
  db: Db,
  ref: UtteranceRef & { readonly text: string },
): WorkbenchUtterance {
  const row = requireUtterance(db, ref);
  const text = ref.text.trim();
  if (text === "") {
    throw new WorkbenchError(
      "empty_text",
      "A rewrite cannot be empty. Use Delete to take this line out.",
    );
  }

  const unchanged = row.aiDraft !== null && text === row.aiDraft.trim();
  const next: ConfirmStatus = unchanged ? "confirmed" : "edited";
  requireTransition(row, next);

  return writeUtterance(db, row.id, { humanFinal: text, confirmStatus: next });
}

/**
 * Drop the line (→ rejected). Terminal: OCR noise, UI chrome and misreads leave
 * the citable pool for good. The text is kept for the audit trail.
 */
export function rejectUtterance(db: Db, ref: UtteranceRef): WorkbenchUtterance {
  const row = requireUtterance(db, ref);
  requireTransition(row, "rejected");
  return writeUtterance(db, row.id, { confirmStatus: "rejected" });
}

/**
 * Set `is_retold` / `tone` / speaker attribution.
 *
 * These are corrections to how a line is framed, not to its text, so they leave
 * `confirm_status` where it is — labelling a line before confirming it is the
 * normal reading order. Refused on a rejected row, which accepts no writes.
 */
export function updateUtteranceAttributes(
  db: Db,
  ref: UtteranceRef & UtteranceAttributes,
): WorkbenchUtterance {
  const row = requireUtterance(db, ref);
  requireWritable(row);

  const values: Partial<UtteranceRow> = {};

  if (ref.isRetold !== undefined) values.isRetold = ref.isRetold;

  if (ref.tone !== undefined) {
    if (ref.tone !== null && !(UTTERANCE_TONES as readonly string[]).includes(ref.tone)) {
      throw new WorkbenchError("invalid_tone", "Unknown tone label.");
    }
    values.tone = ref.tone;
  }

  if (ref.speaker !== undefined) {
    const speaker = ref.speaker;
    if (speaker.kind === "timestamp") {
      values.speakerParticipantId = null;
      values.speakerLabel = TIMESTAMP_SPEAKER_LABEL;
    } else if (
      // The type says these hold, but this input arrives from a client form.
      speaker.kind === "participant" &&
      typeof speaker.participantId === "string" &&
      speaker.participantId !== ""
    ) {
      const participant = db
        .select()
        .from(caseParticipants)
        .where(
          and(
            eq(caseParticipants.id, speaker.participantId),
            eq(caseParticipants.caseId, row.caseId),
          ),
        )
        .all()[0];
      if (participant === undefined) {
        throw new WorkbenchError(
          "speaker_not_in_case",
          "The selected speaker is not a party to this case.",
        );
      }
      values.speakerParticipantId = participant.id;
      values.speakerLabel = participant.pseudonym;
    } else {
      throw new WorkbenchError("speaker_not_in_case", "Invalid speaker attribution.");
    }
  }

  if (Object.keys(values).length === 0) return toWorkbenchUtterance(row);
  return writeUtterance(db, row.id, values);
}

/* -------------------------------------------------------------------------- */
/* Evidence grade sign-off                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record the human decision on `grade_final`.
 *
 * `grade_final` is NULL until this runs — intake writes only `grade_suggested`
 * — so anything filtering on `grade_final` can never pick up an unreviewed
 * item. The chosen grade may differ from the suggestion, which is the whole
 * point of asking, but it must be one of A-D. Re-confirming is allowed: a grade
 * can still be revised while the case is being assembled.
 */
export function confirmEvidenceGrade(
  db: Db,
  input: { readonly evidenceId: string; readonly grade: EvidenceGrade },
): WorkbenchEvidence {
  const row = requireEvidence(db, input.evidenceId);
  if (!(EVIDENCE_GRADES as readonly string[]).includes(input.grade)) {
    throw new WorkbenchError("invalid_grade", "Evidence grade must be A, B, C or D.");
  }

  const [updated] = db
    .update(evidence)
    .set({ gradeFinal: input.grade, gradeConfirmedAt: new Date() })
    .where(eq(evidence.id, row.id))
    .returning()
    .all();

  return toWorkbenchEvidence(updated);
}

function toWorkbenchEvidence(row: EvidenceRow): WorkbenchEvidence {
  return {
    id: row.id,
    caseId: row.caseId,
    sourceType: row.sourceType,
    gradeFinal: row.gradeFinal,
    gradeSuggested: row.gradeSuggested ?? GRADE_BY_SOURCE_TYPE[row.sourceType],
    gradeRationale: row.gradeRationale,
    gradeConfirmedAt: row.gradeConfirmedAt?.getTime() ?? null,
    contentSummary: row.contentSummary,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Utterances of one evidence in reading order (fractional `order_key`), scoped
 * to what the audience may read.
 *
 * The evidence row carries the case, so the grant is resolved from it rather
 * than asked for: a caller holding an evidence id should not have to know which
 * case it belongs to in order to be filtered correctly.
 */
export function listEvidenceUtterances(
  db: Db,
  evidenceId: string,
  audience: MaterialAudience = CASE_RECORD,
): WorkbenchUtterance[] {
  const parent = findEvidence(db, evidenceId);
  if (parent === undefined) return [];
  const grant = resolveMaterialGrant(db, parent.caseId, audience);

  return db
    .select()
    .from(utterances)
    .where(
      and(
        eq(utterances.evidenceId, evidenceId),
        visibleMaterial(utterances, grant),
      ),
    )
    // order_key is the sequence; created_at and id only break ties so the list
    // is stable across reloads when a batch was inserted without keys.
    .orderBy(asc(utterances.orderKey), asc(utterances.createdAt), asc(utterances.id))
    .all()
    .map(toWorkbenchUtterance);
}

function summarize(
  rows: readonly WorkbenchUtterance[],
  gradeConfirmed: boolean,
): WorkbenchProgress {
  const progress = summarizeConfirmProgress(
    rows.map((row) => row.confirmStatus),
  );
  return {
    ...progress,
    gradeConfirmed,
    complete: progress.settled && gradeConfirmed,
  };
}

/**
 * Everything `/evidence/[id]` renders. Returns null when the id is unknown —
 * and equally when the evidence is not this audience's to read, because "it is
 * not there" and "it is not yours" must look the same from outside.
 */
export function loadWorkbench(
  db: Db,
  evidenceId: string,
  audience: MaterialAudience = CASE_RECORD,
): WorkbenchData | null {
  const row = findEvidence(db, evidenceId);
  if (row === undefined) return null;

  const grant = resolveMaterialGrant(db, row.caseId, audience);
  if (!isVisible(row, grant)) return null;

  const evidenceView = toWorkbenchEvidence(row);

  const file =
    row.fileId === null
      ? undefined
      : db.select().from(files).where(eq(files.id, row.fileId)).all()[0];

  const participants = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, row.caseId))
    .orderBy(asc(caseParticipants.pseudonym))
    .all()
    .map((participant) => ({
      id: participant.id,
      pseudonym: participant.pseudonym,
      displayName: participant.displayName,
    }));

  const rows = listEvidenceUtterances(db, row.id, audience);

  return {
    evidence: evidenceView,
    image:
      file === undefined
        ? null
        : {
            sha256: file.sha256,
            originalFilename: file.originalFilename,
            mimeType: file.mimeType,
          },
    participants,
    utterances: rows,
    progress: summarize(rows, evidenceView.gradeConfirmedAt !== null),
  };
}

/**
 * HARD RULE #1, read side: the only sanctioned source of utterance text for
 * downstream stages (steelman, issue framing, judgment). Pending and rejected
 * rows are filtered out in SQL, so no caller can forget the predicate — and
 * since M5, so is anything this audience has no consent to read.
 *
 * The default audience is `CASE_RECORD`: the case as the document a judgment is
 * made from. Passing a participant instead is how the transparency view asks
 * "what may *she* see", and the same query answers both, which is the point.
 */
export function listCitableUtterances(
  db: Db,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): CitableUtterance[] {
  const grant = resolveMaterialGrant(db, caseId, audience);
  return db
    .select()
    .from(utterances)
    .where(
      and(
        eq(utterances.caseId, caseId),
        inArray(utterances.confirmStatus, [...CITABLE_STATUSES]),
        visibleMaterial(utterances, grant),
      ),
    )
    .orderBy(asc(utterances.orderKey), asc(utterances.createdAt), asc(utterances.id))
    .all()
    .map((row) => ({
      id: row.id,
      evidenceId: row.evidenceId,
      text: row.humanFinal ?? row.aiDraft ?? "",
      speakerLabel: row.speakerLabel,
      isRetold: row.isRetold,
      tone: row.tone,
    }));
}
