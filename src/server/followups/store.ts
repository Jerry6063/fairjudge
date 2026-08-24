/**
 * The follow-up row, its lifecycle transitions, and the read the UI is built on
 * (SPEC M4 ④).
 *
 * Everything here is written so that the one failure this feature exists to
 * prevent — a check-in that never fires and never errors — cannot be silent.
 * Concretely:
 *
 *   * **Overdue is derived, not stored.** `dueState` is computed from the clock
 *     at read time, so a row cannot drift into a state where it is late and the
 *     database still says "scheduled, fine". There is no job that has to
 *     remember to mark things overdue, which means there is no job that can
 *     forget.
 *   * **Claiming is a conditional UPDATE.** `claimDueFollowups` sets `fired_at`
 *     with `WHERE fired_at IS NULL AND generation_status = 'pending'` and reads
 *     back only the rows it actually changed. That is what makes firing
 *     exactly-once: a second run — the launchd timer landing on top of the
 *     application-start catch-up, say — claims nothing and does nothing.
 *   * **Failure is a stored state, not a log line.** `markFailed` writes
 *     `last_error` onto the row, and the read below surfaces it. A generation
 *     that failed is as visible as one that is late.
 *
 * The clock is injected everywhere it is read. Not for tidiness: the acceptance
 * test for this feature is "a follow-up whose due time passed while the process
 * was down fires at next start", and that is only assertable with a stub.
 */

import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Db } from "../db";
import { followups } from "../db/schema";
import type {
  FollowupGenerationStatus,
  FollowupKind,
  FollowupStatus,
} from "../db/schema";

/* -------------------------------------------------------------------------- */
/* Record                                                                     */
/* -------------------------------------------------------------------------- */

export interface FollowupRecord {
  readonly id: string;
  readonly caseId: string;
  readonly kind: FollowupKind;
  readonly scheduledAt: Date;
  readonly status: FollowupStatus;
  readonly completedAt: Date | null;
  readonly response: unknown;
  readonly judgmentId: string | null;
  readonly improvementContractId: string | null;
  readonly commitments: unknown;
  readonly questions: unknown;
  readonly generationStatus: FollowupGenerationStatus;
  readonly batchId: string | null;
  readonly batchCustomId: string | null;
  readonly llmCallId: string | null;
  readonly firedAt: Date | null;
  readonly generatedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type FollowupRow = typeof followups.$inferSelect;

export function toFollowupRecord(row: FollowupRow): FollowupRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind,
    scheduledAt: row.scheduledAt,
    status: row.status,
    completedAt: row.completedAt,
    response: row.response ?? null,
    judgmentId: row.judgmentId,
    improvementContractId: row.improvementContractId,
    commitments: row.commitments ?? null,
    questions: row.questions ?? null,
    generationStatus: row.generationStatus,
    batchId: row.batchId,
    batchCustomId: row.batchCustomId,
    llmCallId: row.llmCallId,
    firedAt: row.firedAt,
    generatedAt: row.generatedAt,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* The view the UI renders                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a check-in stands relative to the clock, in the words a person would
 * use. `overdue` is the one that matters: it is the state a laptop that slept
 * through a due date produces, and the product has to say so out loud.
 */
export type FollowupDueState =
  /** Not due yet. */
  | "upcoming"
  /** Due now and answerable — questions are generated and waiting. */
  | "due"
  /** Due time has passed and the check-in has not been completed. */
  | "overdue"
  /** Answered. */
  | "completed"
  /** Deliberately skipped. */
  | "skipped";

export interface FollowupView extends FollowupRecord {
  readonly dueState: FollowupDueState;
  /** Whole days past the scheduled time; 0 when not overdue. */
  readonly overdueByDays: number;
  /** True when the questions exist and the check-in can actually be answered. */
  readonly answerable: boolean;
  /**
   * True when this row needs an operator, not a user: overdue with no questions
   * to answer, because generation failed or never ran. This is the state the
   * whole feature is defending against, so it gets its own name.
   */
  readonly needsAttention: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days from 7 to 30 are the two offsets; this is the label the UI shows. */
export const FOLLOWUP_LABELS: Readonly<Record<FollowupKind, string>> = {
  day7: "7-day check-in",
  day30: "30-day check-in",
};

export function describeFollowup(
  record: FollowupRecord,
  now: number = Date.now(),
): FollowupView {
  const scheduled = record.scheduledAt.getTime();
  const late = now - scheduled;
  const answerable = record.generationStatus === "ready" && record.questions !== null;

  let dueState: FollowupDueState;
  if (record.status === "completed") dueState = "completed";
  else if (record.status === "skipped") dueState = "skipped";
  else if (late < 0) dueState = "upcoming";
  else if (late < DAY_MS && answerable) dueState = "due";
  else dueState = "overdue";

  return {
    ...record,
    dueState,
    overdueByDays: dueState === "overdue" ? Math.floor(late / DAY_MS) : 0,
    answerable,
    needsAttention: dueState === "overdue" && !answerable,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Every check-in on a case, earliest first, with its due state resolved. */
export function listFollowups(
  db: Db,
  caseId: string,
  now: number = Date.now(),
): FollowupView[] {
  return db
    .select()
    .from(followups)
    .where(eq(followups.caseId, caseId))
    .orderBy(asc(followups.scheduledAt))
    .all()
    .map((row) => describeFollowup(toFollowupRecord(row), now));
}

/**
 * Every check-in that is past due and not yet answered, across all cases.
 *
 * The UI's "is anything being quietly dropped" query, and the one a catch-up
 * run reports on. Includes rows whose generation failed — those are exactly the
 * ones that would otherwise disappear.
 */
export function listOverdueFollowups(
  db: Db,
  now: number = Date.now(),
): FollowupView[] {
  return db
    .select()
    .from(followups)
    .where(
      and(eq(followups.status, "scheduled"), lte(followups.scheduledAt, new Date(now))),
    )
    .orderBy(asc(followups.scheduledAt))
    .all()
    .map((row) => describeFollowup(toFollowupRecord(row), now))
    .filter((view) => view.dueState === "overdue");
}

export function readFollowup(db: Db, followupId: string): FollowupRecord | null {
  const row = db.select().from(followups).where(eq(followups.id, followupId)).get();
  return row === undefined ? null : toFollowupRecord(row);
}

/* -------------------------------------------------------------------------- */
/* Claiming — the exactly-once door                                           */
/* -------------------------------------------------------------------------- */

export interface ClaimOptions {
  /** Now, in epoch ms. Injected so a test can move the clock. */
  readonly now?: number;
  /** Ceiling on rows claimed in one run. Batches are cheap; sanity is cheaper. */
  readonly limit?: number;
  /**
   * Attempts after which a row stops being retried and stays `failed`.
   * Retrying forever would turn a permanent fault into a permanent silence.
   */
  readonly maxAttempts?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Claim every follow-up that is due for generation, atomically.
 *
 * The `WHERE` is the whole mechanism: a row is claimable only while it is
 * `pending` with no `fired_at`, and the same statement sets both. Two runs
 * racing — the launchd timer and the application-start catch-up firing within
 * the same second — cannot both claim the same row, because SQLite serializes
 * the writes and the second one matches nothing.
 *
 * `attempts` is incremented here rather than on failure, so a run that crashes
 * between claiming and reporting still counts against the budget. The
 * alternative (count on failure) makes a crash free, and a crash loop invisible.
 */
export function claimDueFollowups(
  db: Db,
  options: ClaimOptions = {},
): FollowupRecord[] {
  const now = options.now ?? Date.now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const claimable = db
    .select({ id: followups.id })
    .from(followups)
    .where(
      and(
        eq(followups.status, "scheduled"),
        eq(followups.generationStatus, "pending"),
        isNull(followups.firedAt),
        lte(followups.scheduledAt, new Date(now)),
        lte(followups.attempts, maxAttempts - 1),
      ),
    )
    .orderBy(asc(followups.scheduledAt))
    .limit(options.limit ?? 50)
    .all()
    .map((row) => row.id);

  if (claimable.length === 0) return [];

  return db
    .update(followups)
    .set({
      firedAt: new Date(now),
      attempts: sql`${followups.attempts} + 1`,
      lastError: null,
    })
    .where(
      and(
        inArray(followups.id, claimable),
        eq(followups.generationStatus, "pending"),
        isNull(followups.firedAt),
      ),
    )
    .returning()
    .all()
    .map(toFollowupRecord);
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

export interface SubmittedPatch {
  readonly batchId: string;
  readonly batchCustomId: string;
  readonly llmCallId?: string | null;
  readonly improvementContractId?: string | null;
  readonly commitments?: unknown;
}

/** The request is in a batch and the batch is with the provider. */
export function markSubmitted(
  db: Db,
  followupId: string,
  patch: SubmittedPatch,
): void {
  db.update(followups)
    .set({
      generationStatus: "submitted",
      batchId: patch.batchId,
      batchCustomId: patch.batchCustomId,
      llmCallId: patch.llmCallId ?? null,
      ...(patch.improvementContractId === undefined
        ? {}
        : { improvementContractId: patch.improvementContractId }),
      ...(patch.commitments === undefined ? {} : { commitments: patch.commitments }),
    })
    .where(eq(followups.id, followupId))
    .run();
}

/** Checked questions are stored; the check-in is answerable. */
export function markReady(
  db: Db,
  followupId: string,
  questions: unknown,
  now: number = Date.now(),
): void {
  db.update(followups)
    .set({
      generationStatus: "ready",
      questions,
      generatedAt: new Date(now),
      lastError: null,
    })
    .where(eq(followups.id, followupId))
    .run();
}

/**
 * The attempt failed.
 *
 * Under the attempt budget the row goes back to `pending` and un-claims itself,
 * so the next run retries it; at the budget it stays `failed`. Either way
 * `last_error` is written, so the reason is on the row and not only in a log
 * nobody reads. `fired_at` is cleared on the retry path because it is the claim
 * marker, not a history field — the history is `attempts`.
 */
export function markFailed(
  db: Db,
  followupId: string,
  reason: string,
  options: { readonly maxAttempts?: number } = {},
): FollowupGenerationStatus {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const row = db
    .select({ attempts: followups.attempts })
    .from(followups)
    .where(eq(followups.id, followupId))
    .get();
  const exhausted = (row?.attempts ?? maxAttempts) >= maxAttempts;
  const generationStatus: FollowupGenerationStatus = exhausted ? "failed" : "pending";

  db.update(followups)
    .set({
      generationStatus,
      lastError: reason.slice(0, 1000),
      firedAt: exhausted ? new Date() : null,
      batchId: null,
      batchCustomId: null,
    })
    .where(eq(followups.id, followupId))
    .run();

  return generationStatus;
}

/** Record the user's behaviour answers and close the check-in. */
export function completeFollowup(
  db: Db,
  followupId: string,
  response: unknown,
  now: number = Date.now(),
): FollowupRecord | null {
  const [row] = db
    .update(followups)
    .set({
      status: "completed",
      completedAt: new Date(now),
      response: response as Record<string, unknown>,
    })
    .where(and(eq(followups.id, followupId), eq(followups.status, "scheduled")))
    .returning()
    .all();
  return row === undefined ? null : toFollowupRecord(row);
}

/** Deliberately let a check-in go. Recorded, so it is a decision, not a gap. */
export function skipFollowup(db: Db, followupId: string): FollowupRecord | null {
  const [row] = db
    .update(followups)
    .set({ status: "skipped" })
    .where(and(eq(followups.id, followupId), eq(followups.status, "scheduled")))
    .returning()
    .all();
  return row === undefined ? null : toFollowupRecord(row);
}
