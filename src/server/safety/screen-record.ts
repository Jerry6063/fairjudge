/**
 * The `safety_screens` table, and the read model the referral page renders.
 *
 * This module exists as a separate file for one reason, and it is the reason
 * HARD RULE #9 is a rule rather than a habit: **nothing here may reach the LLM
 * module, transitively or otherwise.** The gate (`gate.ts`) imports `runStage`
 * and therefore drags the whole Anthropic client into any module that imports
 * it. The crisis-referral page must not be such a module — "renders with zero
 * latency and no LLM in the loop" is not a promise you can keep by being careful
 * at the call site when the call site is one import away.
 *
 * So the split is: reads and writes here, orchestration and the model call in
 * `gate.ts`, and the page imports only this file and `resources.ts`.
 * `tests/safety-referral.test.ts` holds that line: it walks the page's imports
 * on disk and fails if `server/llm` is reachable, so importing the barrel
 * instead of the leaf goes red even before anything calls a model.
 *
 * Import rule for this file, stated once so it survives a refactor:
 *   allowed — drizzle, `../db`, `../db/schema`, `../domain/*`, `./resources`,
 *             `./questionnaire`
 *   banned  — `../llm`, `../llm/*`, `../pipeline/*`, `../evidence/anomaly`,
 *             anything that reaches them
 */

import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  cases,
  safetyScreens,
  type SafetyAnswer,
  type SafetyOutcome,
  type SafetyScreenType,
} from "../db/schema";
import { deriveOutputLevel } from "../domain/output-level";
import {
  SAFETY_CATEGORY_LABELS,
  type SafetyFlagCategory,
  type SafetyRiskLevel,
} from "../domain/safety-rules";

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** One row's worth of screen result, as a caller supplies it. */
export interface SafetyScreenRecord {
  readonly caseId: string;
  readonly screenType: SafetyScreenType;
  readonly outcome: SafetyOutcome;
  /** The questionnaire as asked and answered. Null for a layer that had none. */
  readonly answers?: readonly SafetyAnswer[] | null;
  /** Category strings — the shared vocabulary both layers speak. */
  readonly redFlags?: readonly SafetyFlagCategory[];
  /** Grounds for the outcome, in English. Carries no verbatim evidence. */
  readonly rationale: string;
}

/** One persisted screen, as the read model returns it. */
export interface SafetyScreenRow {
  readonly id: string;
  readonly caseId: string;
  readonly screenType: SafetyScreenType;
  readonly outcome: SafetyOutcome;
  readonly answers: readonly SafetyAnswer[];
  readonly redFlags: readonly SafetyFlagCategory[];
  readonly rationale: string | null;
  readonly referralShown: boolean;
  readonly createdAt: Date;
}

/**
 * Write one screen row.
 *
 * `referral_shown` is set from the outcome rather than from a later page view,
 * and that is a claim worth defending: a `refuse` outcome has exactly one
 * consequence in this codebase, because `canAdvance` refuses every transition
 * on a refused case (`pipeline/stage-machine.ts`). There is no branch in which
 * the case is refused and the referral is not what the user meets. Waiting for
 * the page to confirm it would mean writing to the database from a GET, which is
 * a worse thing to have in the crisis path than an optimistic boolean.
 */
export function recordSafetyScreen(
  db: Db,
  record: SafetyScreenRecord,
): SafetyScreenRow {
  const [row] = db
    .insert(safetyScreens)
    .values({
      caseId: record.caseId,
      screenType: record.screenType,
      answers: record.answers === null ? null : [...(record.answers ?? [])],
      redFlags: [...(record.redFlags ?? [])],
      rationale: record.rationale,
      outcome: record.outcome,
      referralShown: record.outcome === "refuse",
    })
    .returning()
    .all();

  return toRow(row);
}

/**
 * Lock the case onto the refusal path.
 *
 * The level still comes out of `deriveOutputLevel` (HARD RULE #2) rather than
 * being typed here as the literal `"refused"`. The other two arguments are
 * unread on this path — `mustRefuse` short-circuits before either is looked at —
 * and passing neutral values rather than reading the real ones is the honest
 * spelling of that: this call is not a derivation from participation and
 * evidence, it is the statement that safety outranks both.
 */
export function lockCaseAsRefused(db: Db, caseId: string): void {
  const level = deriveOutputLevel(
    { state: "pending", downgradeSignal: false },
    {
      counts: { A: 0, B: 0, C: 0, D: 0 },
      hasClientConfirmed: false,
      hasCounterpartyConfirmed: false,
      citableUtterances: { total: 0, byClient: 0, byCounterparty: 0 },
    },
    { mustRefuse: true },
  );

  db.update(cases)
    .set({ outputLevel: level, outputLevelLockedAt: new Date() })
    .where(eq(cases.id, caseId))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type Row = typeof safetyScreens.$inferSelect;

function toRow(row: Row): SafetyScreenRow {
  return {
    id: row.id,
    caseId: row.caseId,
    screenType: row.screenType,
    outcome: row.outcome,
    answers: row.answers ?? [],
    // The column is a plain `string[]`; narrow it back to the vocabulary both
    // layers write with. A value from outside it would be a bug upstream, and
    // is dropped here rather than rendered as a category nobody has copy for.
    redFlags: (row.redFlags ?? []).filter(isCategory),
    rationale: row.rationale,
    referralShown: row.referralShown,
    createdAt: row.createdAt,
  };
}

function isCategory(value: string): value is SafetyFlagCategory {
  return value in SAFETY_CATEGORY_LABELS;
}

/** Every screen on one case, newest first. */
export function listSafetyScreens(db: Db, caseId: string): SafetyScreenRow[] {
  return db
    .select()
    .from(safetyScreens)
    .where(eq(safetyScreens.caseId, caseId))
    .orderBy(desc(safetyScreens.createdAt), desc(safetyScreens.id))
    .all()
    .map(toRow);
}

/** The screen that refused this case, or null. Newest wins. */
export function latestRefusal(db: Db, caseId: string): SafetyScreenRow | null {
  const row = db
    .select()
    .from(safetyScreens)
    .where(
      and(eq(safetyScreens.caseId, caseId), eq(safetyScreens.outcome, "refuse")),
    )
    .orderBy(desc(safetyScreens.createdAt), desc(safetyScreens.id))
    .get();
  return row === undefined ? null : toRow(row);
}

/**
 * Is this case on the referral path?
 *
 * One query, no model, safe to call anywhere — including in front of a stage
 * that is about to cost money.
 */
export function caseIsReferred(db: Db, caseId: string): boolean {
  return latestRefusal(db, caseId) !== null;
}

/* -------------------------------------------------------------------------- */
/* The referral page's read model                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the referral page renders.
 *
 * Note what is NOT in here: no quote, no utterance, no matched fragment. The
 * page's job is to hand over phone numbers and say why the pipeline stopped, and
 * quoting the sentence that tripped the screen back at the person who wrote it
 * serves neither. The categories and the rationale say enough to be
 * accountable; the evidence stays where it is.
 */
export interface ReferralView {
  readonly caseId: string;
  readonly caseTitle: string | null;
  /** False when nothing refused this case — the page says so and stops. */
  readonly referred: boolean;
  /** Categories from the refusing screen, with their plain-language labels. */
  readonly categories: readonly {
    readonly category: SafetyFlagCategory;
    readonly label: string;
  }[];
  /** The refusing screen's own words, English. Null when there is none. */
  readonly rationale: string | null;
  /** Which layer refused, for the audit line at the foot of the page. */
  readonly screenType: SafetyScreenType | null;
  readonly screenedAt: Date | null;
}

/**
 * Assemble the referral page's data. Two `SELECT`s and no model — this function
 * is the whole request path behind HARD RULE #9.
 */
export function buildReferralView(db: Db, caseId: string): ReferralView {
  const caseRow = db
    .select({ id: cases.id, title: cases.title })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();
  const refusal = latestRefusal(db, caseId);

  return {
    caseId,
    caseTitle: caseRow?.title ?? null,
    referred: refusal !== null,
    categories:
      refusal === null
        ? []
        : refusal.redFlags.map((category) => ({
            category,
            label: SAFETY_CATEGORY_LABELS[category],
          })),
    rationale: refusal?.rationale ?? null,
    screenType: refusal?.screenType ?? null,
    screenedAt: refusal?.createdAt ?? null,
  };
}

/** Re-exported so the page has one import for its whole vocabulary. */
export type { SafetyFlagCategory, SafetyRiskLevel };
