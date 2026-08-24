/**
 * The 7 / 30-day follow-up loop (SPEC M4 ④).
 *
 * A judgment that nobody checks up on is an essay. This layer turns one into a
 * pair of scheduled, behaviour-only check-ins: rows written when the judgment
 * freezes, questions generated through the Message Batches API at half price
 * because nothing here is latency-sensitive, fired by a launchd timer **and**
 * by a catch-up sweep at application start, and — when a laptop slept through a
 * due date — shown as overdue rather than skipped.
 *
 * The failure mode this is built against is silence, so every state a check-in
 * can be in is a stored state with a name, and every one of them renders.
 */

export {
  BATCH_PRICE_MULTIPLIER,
  anthropicBatchTransport,
  awaitBatch,
  batchCostUsd,
  toBatchEntry,
} from "./batch";
export type {
  BatchEntry,
  BatchHandle,
  BatchRequest,
  BatchTransport,
  PollOptions,
  PollOutcome,
} from "./batch";

export {
  EMPTY_SNAPSHOT,
  extractCommitments,
  readContractSnapshot,
} from "./commitments";
export type { CommitmentItem, ContractSnapshot } from "./commitments";

export {
  FOLLOWUP_ANSWER_FORMATS,
  FOLLOWUP_ASKS,
  FOLLOWUP_VIOLATION_CODES,
  checkFollowupQuestions,
  describeFollowupViolations,
  followupQuestionSchema,
  followupQuestionSetSchema,
  followupQuestionsStage,
  renderFollowupPrompt,
} from "./questions";
export type {
  FollowupAnswerFormat,
  FollowupAsk,
  FollowupCheckContext,
  FollowupPromptContext,
  FollowupQuestion,
  FollowupQuestionSet,
  FollowupViolation,
  FollowupViolationCode,
} from "./questions";

export {
  FOLLOWUP_OFFSETS_MS,
  catchUpSchedule,
  linkImprovementContract,
  scheduleFollowupsForJudgment,
} from "./schedule";
export type { ScheduleOptions } from "./schedule";

export {
  DEFAULT_MAX_ATTEMPTS,
  FOLLOWUP_LABELS,
  claimDueFollowups,
  completeFollowup,
  describeFollowup,
  listFollowups,
  listOverdueFollowups,
  markFailed,
  markReady,
  markSubmitted,
  readFollowup,
  skipFollowup,
  toFollowupRecord,
} from "./store";
export type {
  ClaimOptions,
  FollowupDueState,
  FollowupRecord,
  FollowupView,
  SubmittedPatch,
} from "./store";

export { readFollowupsByIds, runDueFollowups } from "./runner";
export type { RunFollowupsOptions, RunFollowupsSummary } from "./runner";
