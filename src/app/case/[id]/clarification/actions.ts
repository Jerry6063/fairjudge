"use server";

// Server actions for stage ⑤ — clarification and steelmanning.
//
// Every action is a shell around `server/pipeline`: the request carries an id
// and some text, never a fact. How many rounds are left, whether a question
// belongs to this round, whether the other side can be argued at all — all of
// that is re-derived from the database inside the pipeline functions, so a
// stale page (or a hand-written POST) gets exactly the same refusal the tests
// drive. HARD RULE #4's counter lives there and is re-checked inside the write
// transaction; nothing in this file can talk it up to four.

import { revalidatePath } from "next/cache";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb } from "../../../../server/db";
import {
  ClarificationError,
  SteelmanError,
  answerClarificationQuestion,
  generateSteelman,
  markClarificationSaturated,
  recordSteelmanVerdict,
  runClarificationRound,
  type ClarificationRoundView,
  type SteelmanAnswer,
  type SteelmanView,
} from "../../../../server/pipeline";

/** Refresh both the stage screen and the shell's stepper/blocker panel. */
function refresh(caseId: string): void {
  revalidatePath(`/case/${caseId}/clarification`);
  revalidatePath(`/case/${caseId}`);
}

/** Run one synchronous mutation, turning the domain refusals into copy. */
function run<T>(caseId: string, work: () => T): ActionResult<T> {
  try {
    const data = work();
    refresh(caseId);
    return { ok: true, data };
  } catch (cause) {
    if (cause instanceof ClarificationError || cause instanceof SteelmanError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Clarification                                                              */
/* -------------------------------------------------------------------------- */

export interface AskedRound {
  readonly round: ClarificationRoundView;
  /** Questions actually asked, after the server budget. */
  readonly asked: number;
  /** Questions the budget refused. Shown, not hidden. */
  readonly dropped: number;
}

/** Ask for the next round. Refused server-side once three have been used. */
export async function askClarificationRoundAction(
  caseId: string,
): Promise<ActionResult<AskedRound>> {
  const result = await runClarificationRound(getDb(), caseId);

  if (result.kind === "ok") {
    refresh(caseId);
    return {
      ok: true,
      data: { round: result.round, asked: result.asked, dropped: result.dropped },
    };
  }
  if (result.kind === "refused") {
    return {
      ok: false,
      code: "refused",
      message:
        "The model would not write questions for this case. Nothing was " +
        "recorded, and no round was spent.",
    };
  }
  if (result.kind === "error") {
    return { ok: false, code: "error", message: result.message };
  }
  return { ok: false, code: result.kind, message: result.message };
}

/** Record one answer. Verbatim — it is the user's own account. */
export async function answerClarificationQuestionAction(
  caseId: string,
  roundId: string,
  questionId: string,
  answer: string,
): Promise<ActionResult<ClarificationRoundView>> {
  return run(caseId, () =>
    answerClarificationQuestion(getDb(), {
      caseId,
      roundId,
      questionId,
      answer,
    }),
  );
}

/** "This round added nothing new" — the user's call, not the model's. */
export async function markClarificationSaturatedAction(
  caseId: string,
  roundId: string,
  saturated: boolean,
): Promise<ActionResult<ClarificationRoundView>> {
  return run(caseId, () =>
    markClarificationSaturated(getDb(), { caseId, roundId, saturated }),
  );
}

/* -------------------------------------------------------------------------- */
/* Steelman                                                                   */
/* -------------------------------------------------------------------------- */

export interface SteelmanOutcome {
  readonly steelman: SteelmanView | null;
  /** Set when the stage reported it could not write one. */
  readonly unableReason: string | null;
}

/** Write (or rewrite) the other party's strongest case. */
export async function generateSteelmanAction(
  caseId: string,
): Promise<ActionResult<SteelmanOutcome>> {
  const result = await generateSteelman(getDb(), caseId);
  refresh(caseId);

  switch (result.kind) {
    case "ok":
      return { ok: true, data: { steelman: result.steelman, unableReason: null } };
    case "unable":
      // Not a failure of the request: a real answer, already recorded as a
      // downgrade signal on the case.
      return {
        ok: true,
        data: { steelman: result.steelman, unableReason: result.reason },
      };
    case "refused":
      return { ok: false, code: "refused", message: result.message };
    case "no_material":
      return { ok: false, code: result.kind, message: result.message };
    case "invalid_refs":
      return { ok: false, code: result.kind, message: result.message };
    case "error":
      return { ok: false, code: "error", message: result.message };
  }
}

/** Record the user's answer to "they would probably say roughly this". */
export async function recordSteelmanVerdictAction(
  caseId: string,
  steelmanId: string,
  answer: SteelmanAnswer,
  text?: string,
): Promise<ActionResult<SteelmanView>> {
  return run(caseId, () =>
    recordSteelmanVerdict(getDb(), { caseId, steelmanId, answer, text }),
  );
}
