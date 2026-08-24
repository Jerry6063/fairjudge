/**
 * `defineStage` — the way an M3 stage declares itself.
 *
 * A stage is data: which model runs it, at what effort, under what token
 * ceiling, against what response schema, with what system prompt. This helper
 * adds nothing at runtime (it returns its argument); it exists so the schema's
 * type is captured at the declaration site, which is what makes `runStage(stage,
 * …)` return `z.infer<typeof stage.zodSchema>` instead of `unknown`.
 *
 * What a stage may NOT declare is behaviour. The hard rules — output level,
 * clarification budget, evidence gating, crisis referral — are enforced in code
 * around the call, never in the prompt string a stage carries. If a rule shows
 * up in `promptTemplate` and nowhere else, that is the bug CLAUDE.md warns about.
 */

import type { z } from "zod";

import type { StageDescriptor } from "../types";

/**
 * Declare a stage descriptor, preserving the exact zod schema type.
 *
 * @example
 * export const safetyScreenStage = defineStage({
 *   name: "safety_screen",
 *   model: MODEL_OPUS,
 *   effort: "high",
 *   maxTokens: 2048,
 *   zodSchema: safetyScreenSchema,
 *   promptTemplate: SAFETY_SCREEN_PROMPT,
 *   promptVersion: "safety_screen.v1",
 * });
 */
export function defineStage<TSchema extends z.ZodType>(
  descriptor: StageDescriptor<TSchema>,
): StageDescriptor<TSchema> {
  return descriptor;
}
