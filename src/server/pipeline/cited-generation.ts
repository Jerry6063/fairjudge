/**
 * Running a stage whose every claim must cite confirmed material.
 *
 * Two M3 stages have the same contract — issue fixing and adverse facts both
 * return lists of items, and every item carries `evidence_refs` — so they share
 * one runner rather than each growing their own retry loop. The order of
 * operations is the whole value of this module:
 *
 *     brief (confirmed material only) -> model -> VALIDATE -> persist
 *
 * Validation sits between the model and the database, never after it. A
 * generation with one bad reference is rejected whole: it is not persisted with
 * the offending item stripped, and it is not persisted with the offending
 * reference removed from an otherwise-fine item. Both of those "repairs" would
 * leave a plausible list on screen with the failure erased, which is precisely
 * the outcome HARD RULE #1 exists to prevent. A bad citation is a loud failure
 * or it is nothing.
 *
 * One retry, then the error surfaces. The retry re-states the faults by id and
 * asks for the whole answer again — the model gets a second chance, the user
 * gets the truth if it does not take it.
 */

import type { z } from "zod";

import type { Db } from "../db";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage } from "../llm";
import type {
  RunStageOptions,
  StageDescriptor,
  StageMeta as StageRunMeta,
} from "../llm";
import {
  auditCitations,
  buildCitableBrief,
  describeCitationFaults,
  renderBrief,
  type CitableBrief,
  type CitationAudit,
  type CitingItem,
} from "./evidence-refs";

/** One generation, one retry. A third attempt does not learn anything new. */
export const MAX_CITATION_ATTEMPTS = 2;

export type CitedRunResult<T> =
  | {
      readonly kind: "ok";
      readonly data: T;
      readonly audit: CitationAudit;
      readonly brief: CitableBrief;
      readonly meta: StageRunMeta;
      readonly attempts: number;
    }
  /** The model cited something that does not exist or is not confirmed. */
  | {
      readonly kind: "invalid_refs";
      readonly audit: CitationAudit;
      readonly attempts: number;
      readonly message: string;
    }
  /** Nothing in this case is citable yet, so nothing may be generated. */
  | { readonly kind: "no_material"; readonly message: string }
  | { readonly kind: "refused"; readonly category?: string }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly message: string;
    };

export interface CitedRunInput<TSchema extends z.ZodType> {
  readonly db: Db;
  readonly caseId: string;
  readonly stage: StageDescriptor<TSchema>;
  /**
   * The user turn, appended after the evidence brief. The stage's own system
   * prompt carries the job description; this is the per-run instruction.
   */
  readonly task: string;
  /** Flatten the stage output into the items whose citations are checked. */
  readonly extract: (data: z.infer<TSchema>) => CitingItem[];
  /** Infrastructure overrides forwarded to `runStage` (tests inject both). */
  readonly llm?: RunStageOptions;
}

/**
 * Correction handed to the model on the retry.
 *
 * It names the ids that failed and why, and repeats the one constraint that was
 * broken. It does not re-send the evidence block: the block is already in the
 * turn above it, and re-sending it would double the prompt for no new
 * information.
 */
function correction(audit: CitationAudit): string {
  return (
    `Your previous answer was rejected. ${describeCitationFaults(audit)}\n\n` +
    `Every evidence_ref must be an \`id\` copied exactly from the EVIDENCE ` +
    `block above. Ids that are not in that block do not exist as far as this ` +
    `case is concerned, and an item that cannot be grounded in one must be ` +
    `left out rather than cited loosely.\n\n` +
    `Produce the complete answer again, from the same evidence.`
  );
}

/**
 * The exact bytes a citing stage is handed, for one case.
 *
 * Exported so the external-session runtime can assemble the same request without
 * a socket: `prepareStage` needs the prompt `runCitedStage` would have sent, and
 * a second copy of "brief, blank line, task" living in the other runtime is a
 * second prompt — the one that drifts is the one nobody is watching.
 *
 * The brief comes back with it because its emptiness is the caller's decision to
 * make: nothing confirmed means nothing citable, and both runtimes refuse rather
 * than asking a model to ground claims in an empty record.
 */
export function buildCitedPrompt(
  db: Db,
  caseId: string,
  task: string,
): { readonly prompt: string; readonly brief: CitableBrief } {
  const brief = buildCitableBrief(db, caseId);
  return { prompt: `${renderBrief(brief)}\n\n${task}`, brief };
}

/** What both runtimes say when there is nothing confirmed to cite. */
export const NO_CITABLE_MATERIAL =
  "Nothing in this case has been confirmed yet, so there is nothing " +
  "that may be cited. Confirm the transcription first — unconfirmed " +
  "lines are invisible to every stage downstream.";

/**
 * Run one citing stage end to end.
 *
 * Never throws: a refusal, a transport failure and an unfixable citation are
 * all results the caller branches on. Nothing is written to the database here —
 * persistence is the caller's, and it only ever runs on `kind: "ok"`.
 */
export async function runCitedStage<TSchema extends z.ZodType>(
  input: CitedRunInput<TSchema>,
): Promise<CitedRunResult<z.infer<TSchema>>> {
  const { db, caseId, stage, task, extract } = input;

  const { prompt: base, brief } = buildCitedPrompt(db, caseId, task);
  if (brief.utterances.length === 0) {
    return { kind: "no_material", message: NO_CITABLE_MATERIAL };
  }

  const dict = buildCaseDict(db, caseId);
  let lastAudit: CitationAudit | null = null;

  for (let attempt = 1; attempt <= MAX_CITATION_ATTEMPTS; attempt += 1) {
    const prompt =
      lastAudit === null ? base : `${base}\n\n${correction(lastAudit)}`;

    const result = await runStage(
      stage,
      { prompt, dict, caseId },
      { db, ...input.llm },
    );

    if (result.kind === "refused") {
      return result.category === undefined
        ? { kind: "refused" }
        : { kind: "refused", category: result.category };
    }
    if (result.kind === "error") {
      return {
        kind: "error",
        retryable: result.retryable,
        message: result.message,
      };
    }

    const audit = auditCitations(db, caseId, extract(result.data));
    if (audit.ok) {
      return {
        kind: "ok",
        data: result.data,
        audit,
        brief,
        meta: result.meta,
        attempts: attempt,
      };
    }
    lastAudit = audit;
  }

  /* c8 ignore next 3 -- the loop only exits here with an audit in hand. */
  const audit = lastAudit as CitationAudit;
  return {
    kind: "invalid_refs",
    audit,
    attempts: MAX_CITATION_ATTEMPTS,
    message:
      `The model cited material that does not hold, twice. Nothing was ` +
      `saved.\n\n${describeCitationFaults(audit)}`,
  };
}
