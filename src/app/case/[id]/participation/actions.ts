"use server";

// Server actions for stage ⑥ — counterparty participation.
//
// One request: record what happened when the other party was asked. The form
// sends one of the five answers and nothing else; which row it lands on is
// re-derived from the database inside `setCounterpartyParticipation`, so a
// stale page cannot settle a participant that is not the counterparty.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb } from "../../../../server/db";
import {
  PARTICIPATION_ANSWERS,
  ParticipationError,
  setCounterpartyParticipation,
  type ParticipationBoard,
} from "../../../../server/pipeline";

const settleSchema = z.object({
  caseId: z.string().min(1),
  state: z.enum(PARTICIPATION_ANSWERS),
});

/** Record the counterparty's participation state. */
export async function setParticipationAction(
  input: unknown,
): Promise<ActionResult<ParticipationBoard>> {
  const parsed = settleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message:
        "That is not one of the five answers. Refresh the page and pick again.",
    };
  }

  try {
    const board = setCounterpartyParticipation(
      getDb(),
      parsed.data.caseId,
      parsed.data.state,
    );
    revalidatePath(`/case/${parsed.data.caseId}/participation`);
    revalidatePath(`/case/${parsed.data.caseId}`);
    return { ok: true, data: board };
  } catch (cause) {
    if (cause instanceof ParticipationError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}
