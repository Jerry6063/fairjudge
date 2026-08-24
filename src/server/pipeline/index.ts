// Public surface of the case pipeline. Stage transitions happen here and
// nowhere else: the UI asks whether a move is legal, it never decides.

export {
  MAX_CLARIFICATION_ROUNDS,
  PIPELINE_STAGES,
  STAGE_META,
  STAGE_SEQUENCE,
  StageMachineError,
  advanceStage,
  blockersForNextStage,
  canAdvance,
  collectCaseFacts,
  describePipeline,
  nextStage,
  requirementsFor,
} from "./stage-machine";

export type {
  AdvanceDecision,
  AdvanceOutcome,
  CaseFacts,
  PipelineStage,
  Reader,
  Requirement,
  StageMachineErrorCode,
  StageMeta,
  StageStatus,
} from "./stage-machine";

// HARD RULE #1 — reference validation, and the brief a citing stage is written
// from. The set of ids the model is shown and the set the validator accepts are
// read from the same query, so they cannot drift.
export {
  CITABLE_CONFIRM_STATUSES,
  EvidenceRefError,
  assertCitations,
  auditCitations,
  buildCitableBrief,
  checkEvidenceRefs,
  describeCitationFaults,
  renderBrief,
} from "./evidence-refs";

export type {
  BriefParticipant,
  BriefUtterance,
  CitableBrief,
  CitationAudit,
  CitingItem,
  EvidenceRefCheck,
  EvidenceRefFault,
  EvidenceRefRejection,
  ItemCitationFault,
} from "./evidence-refs";

export { MAX_CITATION_ATTEMPTS, runCitedStage } from "./cited-generation";
export type { CitedRunInput, CitedRunResult } from "./cited-generation";

// Issue fixing — the three lists (M3 wave A ⑤).
export {
  ISSUE_LIST_META,
  IssueError,
  confirmIssue,
  editIssue,
  generateIssues,
  listIssues,
  rejectIssue,
} from "./issue-fixing";

export type {
  IssueBoard,
  IssueCitation,
  IssueErrorCode,
  IssueGenerationResult,
  IssueItem,
  IssueList,
} from "./issue-fixing";

// Adverse-fact pre-acknowledgment (M3 wave A ⑥).
export {
  AdverseFactError,
  JudgmentBlockedError,
  acknowledgeAdverseFact,
  assertJudgmentAllowed,
  contestAdverseFact,
  countAdverseFacts,
  generateAdverseFacts,
  judgmentGateFor,
  listAdverseFacts,
} from "./adverse-facts";

export type {
  AdverseFactBoard,
  AdverseFactCitation,
  AdverseFactErrorCode,
  AdverseFactGenerationResult,
  AdverseFactView,
} from "./adverse-facts";

// The gate itself: one definition, enforced at the stage transition and again
// at the judgment entry point.
export {
  adverseFactsSettled,
  adverseFactsSurfaced,
  checkJudgmentGate,
} from "./judgment-gate";

export type {
  AdverseFactCounts,
  JudgmentGateCode,
  JudgmentGateVerdict,
} from "./judgment-gate";

// The case file every wave-A stage reads: confirmed material only, serialized
// byte-stably (HARD RULE #1 on the way in, prompt-cache discipline on the way
// out).
export {
  CASE_FILE_FORMAT,
  assembleCaseFile,
  findUtteranceByRef,
  resolveUtteranceRef,
  serializeCaseFile,
  stableStringify,
} from "./case-file";

export type {
  CaseFile,
  CaseFileEvent,
  CaseFileMaterial,
  CaseFileParty,
  CaseFileRound,
  CaseFileSection,
  CaseFileUtterance,
} from "./case-file";

// Clarification — the ≤3 × ≤3 budget, counted in server code (HARD RULE #4).
export {
  CLARIFICATION_BUDGET,
  MAX_CLARIFICATION_QUESTIONS,
  ClarificationError,
  answerClarificationQuestion,
  buildClarificationPrompt,
  declineClarificationQuestion,
  markClarificationSaturated,
  readClarification,
  recordClarificationRound,
  runClarificationRound,
  withinQuestionBudget,
} from "./clarification";

export type {
  ClarificationBoard,
  ClarificationErrorCode,
  ClarificationQuestionView,
  ClarificationRoundView,
  ClarificationRunResult,
  DraftQuestion,
  RecordedRound,
} from "./clarification";

// Counterparty participation (stage ⑥) — the fact issue framing waits on.
export {
  PARTICIPATION_ANSWERS,
  PARTICIPATION_META,
  ParticipationError,
  applyParticipationReset,
  deriveCounterpartyParticipation,
  readParticipation,
  readParticipationEvidence,
  resetCounterpartyParticipation,
  setCounterpartyParticipation,
} from "./participation";

export type {
  ParticipantView,
  ParticipationAnswer,
  ParticipationBoard,
  ParticipationDerivation,
  ParticipationErrorCode,
  ParticipationEvidence,
  ParticipationMeta,
  ParticipationReset,
} from "./participation";

// HARD RULE #2 — the level is derived in code and locked onto the case. The
// rule itself is `domain/output-level.ts`; this is the I/O around it.
export {
  OutputLevelError,
  collectOutputLevelInputs,
  lockOutputLevel,
  readOutputLevel,
  relockOutputLevel,
} from "./output-level";

export type { OutputLevelErrorCode, OutputLevelView } from "./output-level";

// Removing operator-authored material from a real case record — the cleanup
// wave B starts from (SPEC M3 decision record, 2026-08-09 "contamination").
export {
  OPERATOR_ANSWER_MARKER,
  PURGE_DECLINE_NOTE,
  applyOperatorPurge,
  isOperatorAuthored,
  purgeOperatorAnswers,
} from "./operator-purge";

export type { PurgeChange, PurgeKept, PurgeReport } from "./operator-purge";

// Steelmanning — the other party's strongest case, and the downgrade signal
// recorded when it cannot be written or cannot be recognized.
export {
  MAX_STEELMAN_ATTEMPTS,
  STEELMAN_DOWNGRADE_PREFIX,
  SteelmanError,
  clearSteelmanDowngrade,
  generateSteelman,
  readSteelman,
  recordSteelmanVerdict,
  renderSteelmanDraft,
  resolveSteelmanRefs,
  setSteelmanDowngrade,
} from "./steelman";

export type {
  ResolvedSteelmanRef,
  SteelmanAnswer,
  SteelmanBoard,
  SteelmanErrorCode,
  SteelmanRefKind,
  SteelmanRefRejection,
  SteelmanRunResult,
  SteelmanView,
} from "./steelman";
