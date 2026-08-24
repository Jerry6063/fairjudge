/**
 * The archive of the GPT polish layer — read-only.
 *
 * The layer itself is gone (see the removal note in doc 02 §1.1a): between
 * 2026-08-14 and 2026-08-16 this product sent locked surface text to OpenAI for
 * a copy edit, measured what came back, and cut the stage. What it does not do
 * is pretend that never happened. `judgment_polish_runs` holds the
 * (original, polished, diff) triples of every run that ever executed, including
 * the six real GPT round trips, and those rows are audit records: they say what
 * this product sent to a second vendor, what came back, and what was done with
 * it. Deleting them would erase the only evidence behind the decision to stop.
 *
 * So this module is what is left of `polish-chain.ts`: the read half, with the
 * write half removed. Nothing here can create a run — there is no code path in
 * this repository that writes `judgment_polish_runs` any more — and the reading
 * view uses it to render the archived comparison on the handful of judgments
 * that carry one.
 *
 * ## Why the row types are structural rather than imported
 *
 * `polish-validation.ts` and `llm/stages/polish-entailment.ts` were deleted with
 * the layer, so the failure and entailment shapes they defined no longer exist
 * as live domain types. They still exist as JSON on disk. The interfaces below
 * describe that JSON as what it is — a historical record written by code that is
 * gone — rather than resurrecting the validator's types to give an archive
 * something to be validated against. Reading is deliberately permissive: an
 * archived row is not re-checked, because there is nothing left to re-check it
 * for.
 */

import { desc, eq } from "drizzle-orm";

import type { Db } from "../db";
import { judgmentPolishRuns, type PolishOutcome } from "../db/schema";
import type { SurfaceLayer } from "./contract";

/* -------------------------------------------------------------------------- */
/* Archived shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-section before/after, as the chain recorded it.
 *
 * Section-level rather than word-level, which was the right unit then and is the
 * right unit now: the thing a reader compares is a paragraph of a verdict.
 * `changed: false` is the useful signal — it says the polisher left that section
 * alone, and on the real gpt-5-mini runs it said that about every section.
 */
export interface SectionDiff {
  readonly section_id: string;
  /** False when the polisher returned the section unchanged. */
  readonly changed: boolean;
  readonly heading: { readonly original: string; readonly polished: string };
  readonly text: { readonly original: string; readonly polished: string };
}

/**
 * One entry from the deleted validation chain's failure list.
 *
 * `code` was an enum (`placeholder_lost`, `entailment_violation`, …) and is read
 * back as a plain string: the enum's authority came from the validator that
 * produced it, and that validator no longer exists to be authoritative.
 */
export interface ArchivedPolishFailure {
  readonly code: string;
  readonly sectionId?: string;
  readonly detail: string;
}

/** Whatever the `polish_entailment` stage answered, verbatim as stored. */
export type ArchivedEntailment = Record<string, unknown>;

export interface PolishRunRecord {
  readonly id: string;
  readonly judgmentId: string;
  readonly outcome: PolishOutcome;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly original: SurfaceLayer | null;
  readonly polished: SurfaceLayer | null;
  readonly diff: readonly SectionDiff[];
  readonly failures: readonly ArchivedPolishFailure[];
  readonly entailment: ArchivedEntailment | null;
  readonly reason: string | null;
  readonly latencyMs: number | null;
  readonly createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every archived polish run for one judgment, newest first.
 *
 * Returns an empty array for every judgment produced after the layer was cut,
 * which is now the ordinary case and is what the reading view branches on.
 */
export function readPolishRuns(db: Db, judgmentId: string): PolishRunRecord[] {
  return db
    .select()
    .from(judgmentPolishRuns)
    .where(eq(judgmentPolishRuns.judgmentId, judgmentId))
    .orderBy(desc(judgmentPolishRuns.createdAt))
    .all()
    .map((row) => {
      const failures = (row.failures ?? {}) as {
        reason?: string | null;
        failures?: ArchivedPolishFailure[];
        entailment?: ArchivedEntailment | null;
      };
      const diff = (row.diff ?? {}) as { sections?: SectionDiff[] };
      return {
        id: row.id,
        judgmentId: row.judgmentId,
        outcome: row.outcome,
        model: row.model,
        promptVersion: row.promptVersion,
        original: (row.original ?? null) as SurfaceLayer | null,
        polished: (row.polished ?? null) as SurfaceLayer | null,
        diff: diff.sections ?? [],
        failures: failures.failures ?? [],
        entailment: failures.entailment ?? null,
        reason: failures.reason ?? null,
        latencyMs: row.latencyMs,
        createdAt: row.createdAt,
      };
    });
}
