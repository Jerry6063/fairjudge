/**
 * Public surface of the safety screening gate (SPEC M3 wave A ②).
 *
 * ⚠️ **This barrel reaches the LLM module.** `gate.ts` imports `runStage`, so
 * anything importing this file imports the Anthropic client transitively. That
 * is correct for a server action running the screen, and wrong for the
 * crisis-referral page: HARD RULE #9 says the referral renders with no LLM in
 * the loop, and the way that rule is kept here is that the page imports
 * `./screen-record` and `./resources` directly and never this file.
 *
 * If you are adding a module to the crisis path, import the leaves.
 * `tests/safety-referral.test.ts` walks the referral page's imports on disk and
 * fails if `server/llm` is reachable from it, so a barrel import added by
 * mistake fails the suite rather than production at the worst moment.
 */

/* Layer one — deterministic, pure, no IO. Re-exported from `domain/` because
   the pattern list is domain logic that the gate happens to use, not a piece of
   the gate. */
export {
  SAFETY_CATEGORY_LABELS,
  SAFETY_FLAG_CATEGORIES,
  SAFETY_PATTERNS,
  SAFETY_RISK_LEVELS,
  combineSafetySignals,
  scanForSafetySignals,
  scanText,
  screenForSafety,
} from "../domain/safety-rules";

export type {
  LocalSafetyScreen,
  PatternConfidence,
  SafetyFlagCategory,
  SafetyPattern,
  SafetyRiskLevel,
  SafetySignal,
  SafetySource,
} from "../domain/safety-rules";

/* The questionnaire — the half of layer one that asks instead of inferring. */
export {
  SAFETY_CHOICES,
  SAFETY_QUESTIONS,
  answerSources,
  answersToSignals,
  buildSafetyAnswers,
  findSafetyQuestion,
} from "./questionnaire";

export type { SafetyChoice, SafetyQuestion } from "./questionnaire";

/* Crisis resources — a constant. No IO, no model, ever. */
export {
  CRISIS_RESOURCES,
  FORBIDDEN_REFERRAL_PHRASES,
  REFERRAL_EXPLANATION,
  REFERRAL_HEADLINE,
  REFERRAL_NEXT_STEPS,
  REFERRAL_RESOURCE_NOTE,
  REGION_LABELS,
  RESOURCE_REGIONS,
  findForbiddenReferralPhrases,
  resourcesForRegion,
} from "./resources";

export type { CrisisResource, ResourceRegion } from "./resources";

/* Persistence and the referral read model. Model-free by construction. */
export {
  buildReferralView,
  caseIsReferred,
  latestRefusal,
  listSafetyScreens,
  lockCaseAsRefused,
  recordSafetyScreen,
} from "./screen-record";

export type {
  ReferralView,
  SafetyScreenRecord,
  SafetyScreenRow,
} from "./screen-record";

/* The gate itself. THIS is the import that pulls in the LLM module. */
export {
  SafetyReferralError,
  assertSafetyClearedForJudgment,
  modelLayerFlags,
  runIntakeSafetyGate,
  runPreJudgmentSafetyGate,
  runSafetyGate,
  screenBeforeJudgment,
} from "./gate";

export type {
  ModelLayerState,
  SafetyGateInput,
  SafetyGateResult,
  SafetyPhase,
} from "./gate";
