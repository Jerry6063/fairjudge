/**
 * Home of the M3 pipeline stages (SPEC M3 decision record, 2026-08-09: new
 * stages live here rather than growing `src/server/llm/config.ts`, which was
 * becoming one crowded registry file).
 *
 * One module per stage, one line in this barrel. A stage declared here is
 * handed to `runStage` as a value:
 *
 *     import { runStage } from "../../llm";
 *     import { safetyScreenStage } from "../../llm/stages";
 *
 *     const result = await runStage(safetyScreenStage, { prompt, caseId });
 *
 * Passing the descriptor instead of a registry key changes where the stage is
 * declared and nothing else. The call still goes through the one gateway
 * (HARD RULE #7): fable gets the fallback beta plus its `fallbacks` chain and no
 * `thinking` key, `stop_reason === "refusal"` is checked before any content is
 * read, `usage.iterations` is inspected for sticky routing, the payload is
 * pseudonymized on the way out, and every attempt writes `llm_calls` +
 * `egress_ledger` under the descriptor's `name`.
 *
 * Conventions for a stage module:
 *   - `<stage>.ts` exports its zod schema, its output type, and one
 *     `defineStage({...})` const named `<stage>Stage`.
 *   - `name` matches the file and is what the audit rows are attributed to, so
 *     it must stay stable; `promptVersion` is what moves when the prompt does.
 *   - The prompt is English (CLAUDE.md language policy). The evidence it
 *     analyses is Chinese and stays Chinese — an English prompt reading Chinese
 *     material and reporting in English is the expected shape.
 *   - Anything a hard rule enforces belongs in the caller, not the prompt.
 *
 * Wave A stages land here as their agents build them (safety_screen,
 * clarification_questions, steelman, issue_framing, adverse_facts); wave B adds
 * the judgment skeleton, the narrative and the swap test.
 *
 * One stage has been removed rather than added: `polish_entailment` existed only
 * to guard the GPT polish layer, and went out with it on 2026-08-16 (doc 02
 * §1.1a). Every stage below is Anthropic, which is now the whole list.
 */

export { defineStage } from "./define";

export { safetyScreenSchema, safetyScreenStage } from "./safety-screen";
export type { SafetyScreenOutput } from "./safety-screen";

export { issueFixingSchema, issueFixingStage } from "./issue-fixing";
export type { IssueFixingOutput } from "./issue-fixing";

export { adverseFactsSchema, adverseFactsStage } from "./adverse-facts";
export type { AdverseFactsOutput } from "./adverse-facts";

export {
  clarificationQuestionsSchema,
  clarificationQuestionsStage,
} from "./clarification-questions";
export type { ClarificationQuestionsOutput } from "./clarification-questions";

export { steelmanSchema, steelmanStage } from "./steelman";
export type { SteelmanOutput } from "./steelman";

// The blind advocate pair (doc 05 §B, 2026-08-17). Two seats, one contract,
// L1 only: below L1 the single steelman of the absent party already is the
// advocate. Blindness is enforced by what `judgment/advocacy.ts` serializes for
// each seat, never by the prompt they share.
export {
  ADVOCATE_STAGES,
  advocateBriefAStage,
  advocateBriefBStage,
  advocateBriefSchema,
} from "./advocate-brief";
export type { AdvocateBriefOutput } from "./advocate-brief";

// Wave B — the two-step judgment (SPEC ⑦). Both declare the judgment
// contract's own schemas as their response format rather than restating the
// shape, so "what a judgment is made of" has one definition.
export {
  judgmentSkeletonRehearingStage,
  judgmentSkeletonStage,
} from "./judgment-skeleton";
export { judgmentNarrativeStage } from "./judgment-narrative";

// M4 ①: the same frozen fact layer, written to the other party. A second
// narrative rather than a filtered projection of the first — filtering leaves
// the sentences addressed to whoever the first one was written for.
export { shareableNarrativeStage } from "./shareable-narrative";

// M4 ②/③: the two derived documents that are supposed to change the week after
// the judgment. Both are generated from the frozen fact layer, and both have
// their rules enforced in `judgment/improvement-contract.ts` and
// `judgment/repair-script.ts` rather than in the prompts below.
export {
  COMMITMENT_PARTIES,
  MAX_COMMITMENT_DAYS,
  commitmentItemSchema,
  improvementContractSchema,
  improvementContractStage,
} from "./improvement-contract";
export type {
  CommitmentItem,
  CommitmentParty,
  ImprovementContractOutput,
} from "./improvement-contract";

export {
  MAX_OPENING_LINE_CHARS,
  repairScriptSchema,
  repairScriptStage,
  whenItGoesWrongSchema,
} from "./repair-script";
export type { RepairScriptOutput } from "./repair-script";

// M4 ⑤: the case heard again at effort `max`, with the appeal grounds and
// whatever has been confirmed since. Returns a fact layer, because an appeal
// produces a judgment rather than a commentary on one.
export { appealRehearingStage } from "./appeal-rehearing";
