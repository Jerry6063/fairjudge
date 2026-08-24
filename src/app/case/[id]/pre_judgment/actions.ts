"use server";

// Server actions for the pre-judgment confrontation (SPEC M3 wave A ⑥).
//
// Three requests: surface the facts that count against the client, then
// acknowledge or contest one of them. The gate on judgment is not enforced
// here — it is read from the database at the moment judgment is asked for
// (`assertJudgmentAllowed`) and again by the stage machine on the transition
// into `judgment`. This file only records what the client said.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb } from "../../../../server/db";
import {
  AdverseFactError,
  OutputLevelError,
  acknowledgeAdverseFact,
  contestAdverseFact,
  generateAdverseFacts,
  lockOutputLevel,
  type AdverseFactBoard,
  type AdverseFactView,
  type OutputLevelView,
} from "../../../../server/pipeline";

const caseOnly = z.object({ caseId: z.string().min(1) });

const ackSchema = z.object({
  caseId: z.string().min(1),
  adverseFactId: z.string().min(1),
  note: z.string().nullish(),
});

const contestSchema = z.object({
  caseId: z.string().min(1),
  adverseFactId: z.string().min(1),
  note: z.string(),
});

const BAD_REQUEST = {
  ok: false as const,
  code: "bad_request",
  message: "That was not a valid request. Refresh the page.",
};

function asActionFailure(cause: unknown): ActionResult<never> {
  if (cause instanceof AdverseFactError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  throw cause;
}

export interface AdverseFactGenerationData {
  readonly board: AdverseFactBoard;
  readonly created: number;
  readonly replaced: number;
  /** 2 when the first answer cited something that does not hold. */
  readonly attempts: number;
}

/** Read the client's own material for what counts against them. */
export async function generateAdverseFactsAction(
  input: unknown,
): Promise<ActionResult<AdverseFactGenerationData>> {
  const parsed = caseOnly.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;

  const result = await generateAdverseFacts(getDb(), parsed.data.caseId);

  switch (result.kind) {
    case "ok":
      revalidatePath(`/case/${parsed.data.caseId}/pre_judgment`);
      return {
        ok: true,
        data: {
          board: result.board,
          created: result.created,
          replaced: result.replaced,
          attempts: result.attempts,
        },
      };
    case "invalid_refs":
      return { ok: false, code: "invalid_refs", message: result.message };
    case "no_material":
      return { ok: false, code: "no_material", message: result.message };
    case "refused":
      return {
        ok: false,
        code: "refused",
        message:
          "The model declined to work on this material. Nothing was saved.",
      };
    case "error":
      return { ok: false, code: "error", message: result.message };
  }
}

/** "Yes, that happened." The optional note is the client's own words. */
export async function acknowledgeAdverseFactAction(
  input: unknown,
): Promise<ActionResult<AdverseFactView>> {
  const parsed = ackSchema.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const item = acknowledgeAdverseFact(getDb(), {
      caseId: parsed.data.caseId,
      adverseFactId: parsed.data.adverseFactId,
      note: parsed.data.note ?? null,
    });
    revalidatePath(`/case/${parsed.data.caseId}/pre_judgment`);
    return { ok: true, data: item };
  } catch (cause) {
    return asActionFailure(cause);
  }
}

/** "That is not what happened, and here is why." The reason is required. */
export async function contestAdverseFactAction(
  input: unknown,
): Promise<ActionResult<AdverseFactView>> {
  const parsed = contestSchema.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const item = contestAdverseFact(getDb(), parsed.data);
    revalidatePath(`/case/${parsed.data.caseId}/pre_judgment`);
    return { ok: true, data: item };
  } catch (cause) {
    return asActionFailure(cause);
  }
}

/**
 * Lock the output level onto the case (HARD RULE #2).
 *
 * The request carries a case id and nothing else — there is no field here for a
 * level, and there could not be one. `lockOutputLevel` re-reads the record and
 * derives the answer itself, so neither this screen nor a hand-written POST can
 * ask for a level the evidence does not support.
 */
export async function lockOutputLevelAction(
  input: unknown,
): Promise<ActionResult<OutputLevelView>> {
  const parsed = caseOnly.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const view = lockOutputLevel(getDb(), parsed.data.caseId);
    revalidatePath(`/case/${parsed.data.caseId}/pre_judgment`);
    revalidatePath(`/case/${parsed.data.caseId}`);
    return { ok: true, data: view };
  } catch (cause) {
    if (cause instanceof OutputLevelError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}
