"use server";

// Server actions for the case shell.
//
// The only thing the client may ask for is "move this case into that stage".
// Whether that is allowed is decided here, from the database, by the same
// `advanceStage` the tests drive — the request carries no facts of its own, so
// there is nothing in it for a stale page (or a hand-written POST) to assert.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../lib/action-result";
import { getDb } from "../../../server/db";
import { CASE_STAGES, type CaseStage } from "../../../server/db/schema";
import {
  StageMachineError,
  advanceStage,
  type StageMachineErrorCode,
} from "../../../server/pipeline";

const advanceSchema = z.object({
  caseId: z.string().min(1),
  target: z.enum(CASE_STAGES),
});

/**
 * Fallback copy per refusal code. `preconditions_unmet` is not here on purpose:
 * that refusal already carries the specific unmet requirements, and a generic
 * sentence would be worse than the real reason.
 */
const ERROR_COPY: Readonly<Record<StageMachineErrorCode, string>> = {
  case_not_found: "This case is no longer in the database. Refresh the page.",
  unknown_stage: "That is not a stage of this pipeline.",
  not_forward: "A case only moves forward, one stage at a time.",
  stage_skipped: "Stages are entered one at a time — this one would skip ahead.",
  safety_refused:
    "The safety screen refused this case. It stays on the referral path.",
  preconditions_unmet: "This stage is not reachable yet.",
};

export interface AdvanceActionData {
  readonly stage: CaseStage;
}

/** Advance one case into `target`, or return why the machine refused. */
export async function advanceCaseStageAction(
  input: unknown,
): Promise<ActionResult<AdvanceActionData>> {
  const parsed = advanceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message: "That was not a valid stage request. Refresh the page.",
    };
  }

  try {
    const outcome = advanceStage(getDb(), parsed.data.caseId, parsed.data.target);
    revalidatePath(`/case/${parsed.data.caseId}`);
    return { ok: true, data: { stage: outcome.to } };
  } catch (cause) {
    if (cause instanceof StageMachineError) {
      const detail = cause.unmet.map((r) => r.blocker).join(" ");
      return {
        ok: false,
        code: cause.code,
        message:
          detail === "" ? ERROR_COPY[cause.code] : `${ERROR_COPY[cause.code]} ${detail}`,
      };
    }
    // Unexpected: keep the detail server-side, hand the user something actionable.
    console.error("[case] advanceCaseStageAction failed", cause);
    return {
      ok: false,
      code: "unexpected",
      message: "Could not move the case. Refresh the page and try again.",
    };
  }
}
