"use server";

// Server actions for stage ① — intake and safety screening.
//
// One request: run the screen. The form carries answers, never a verdict —
// whether this case is refused is decided by `runSafetyGate`, which runs the
// deterministic layer first and only calls a model if that layer found nothing
// (HARD RULE #9). The action returns a summary for the screen to render; the
// authoritative record is the `safety_screens` rows the gate wrote, and on a
// referral the `output_level = 'refused'` it locked onto the case.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb } from "../../../../server/db";
import type { SafetyOutcome } from "../../../../server/db/schema";
import type {
  SafetyFlagCategory,
  SafetyRiskLevel,
} from "../../../../server/domain/safety-rules";
import { buildSafetyAnswers, runIntakeSafetyGate } from "../../../../server/safety";

const screenSchema = z.object({
  caseId: z.string().min(1),
  /** Raw form values keyed by question id; unknown ids are dropped downstream. */
  answers: z.record(z.string(), z.string()),
});

/** What the screen shows after a run. The rows are the real record. */
export interface SafetyScreenSummary {
  /** The only field the page branches on. */
  readonly decision: "pass" | "refer";
  readonly outcome: SafetyOutcome;
  readonly riskLevel: SafetyRiskLevel;
  readonly categories: readonly SafetyFlagCategory[];
  /** English prose covering both layers. */
  readonly rationale: string;
  /** `safety_screens` rows this run wrote (one per layer that ran). */
  readonly screensWritten: number;
  /** What became of the model layer — `ran`, or why it did not. */
  readonly modelLayer: string;
}

/**
 * Run the intake screen over this case's questionnaire answers and confirmed
 * material.
 *
 * Never rejects on a model problem: the gate treats a refusal and a transport
 * failure as outcomes, because the deterministic half has already run either
 * way and half a screen is recorded as incomplete rather than clean.
 */
export async function runIntakeSafetyScreenAction(
  input: unknown,
): Promise<ActionResult<SafetyScreenSummary>> {
  const parsed = screenSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message: "That was not a valid screening request. Refresh the page.",
    };
  }

  const answers = buildSafetyAnswers(parsed.data.answers);

  try {
    const result = await runIntakeSafetyGate(
      getDb(),
      parsed.data.caseId,
      answers,
    );
    revalidatePath(`/case/${parsed.data.caseId}/intake`);
    revalidatePath(`/case/${parsed.data.caseId}`);

    return {
      ok: true,
      data: {
        decision: result.decision,
        outcome: result.outcome,
        riskLevel: result.riskLevel,
        categories: result.categories,
        rationale: result.rationale,
        screensWritten: result.screens.length,
        modelLayer: result.model.kind,
      },
    };
  } catch (cause) {
    // Reaching here means the write failed, not that the screen found nothing.
    // Saying so plainly matters more here than anywhere else in the product.
    console.error("[intake] runIntakeSafetyScreenAction failed", cause);
    return {
      ok: false,
      code: "unexpected",
      message:
        "The safety screen could not be recorded, so this case has not been " +
        "screened. Nothing downstream may treat it as cleared.",
    };
  }
}
