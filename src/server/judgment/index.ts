// Public surface of the judgment layer. Today that is the data contract: what
// a judgment is made of, whether a given one holds together, and how it is
// written, frozen and re-heard. Generation, the swap test and the post-judgment
// documents land beside it and all speak these types.

export {
  CLAIM_TIERS,
  CONTRACT_ID_PATTERN,
  CONTRACT_VIOLATION_CODES,
  HIGH_CONFIDENCE_FLOOR,
  RESPONSIBILITY_ALLOCATIONS,
  SECTION_AUDIENCES,
  SECTION_KINDS,
  UNKNOWN_CONFIDENCE_CEILING,
  UNRESOLVED_REASONS,
  JudgmentContractError,
  JudgmentStoreError,
  assertJudgmentContract,
  assertShareTokenAllowed,
  claimSchema,
  createDraft,
  createNextVersion,
  describeViolations,
  factLayerSchema,
  finalize,
  findingsSchema,
  judgmentSectionSchema,
  listRenditions,
  parseFactLayer,
  parseSurfaceLayer,
  readCurrentJudgment,
  readJudgment,
  readJudgmentChain,
  isSelfReflectionAnnex,
  projectSection,
  readRendition,
  readerForRendition,
  recordBasisSchema,
  renderRendition,
  renditionKindSchema,
  responsibilitySchema,
  surfaceLayerSchema,
  unresolvedQuestionSchema,
  updateDraft,
  validateJudgmentContract,
} from "./contract";

// The record's asymmetry, as arithmetic rather than as a canned sentence: who
// has confirmed speech in this case, how much, and which claims rest on whose
// words. Passed into the prompt as numbers, and checked against the numbers the
// generation restates.
export {
  computeRecordAsymmetry,
  describeRecordBasisMismatches,
  serializeRecordAsymmetry,
  verifyRecordBasis,
} from "./asymmetry";

export type {
  PartyRecordShare,
  RecordAsymmetry,
  RecordBasisMismatch,
} from "./asymmetry";

// HARD RULE #2 on the generation side: what a level licenses, stated once and
// used twice — in the prompt block, and in the check on what comes back.
export {
  checkLevelConstraints,
  describeLevelViolations,
  findNumericResponsibilitySplits,
  levelConstraints,
} from "./levels";

export type {
  AllocationWithholding,
  LevelConstraints,
  LevelViolation,
  LevelViolationCode,
} from "./levels";

// The swap test as a publication gate (doc 05 §B.2). It decides one thing —
// whether this generation earned the allocation it wrote — and never touches
// the level.
export {
  SWAP_ALLOCATION_DELTA_THRESHOLD,
  SWAP_LIMITS_HEADING,
  allocationRows,
  measureSwapDelta,
  needsRehearing,
  resolveSwapGate,
  swapDisagreements,
  swapLimitsText,
  withholdAllocation,
} from "./swap-gate";

export type {
  AllocationRow,
  SwapDelta,
  SwapGateDisposition,
  SwapGateOutcome,
  SwapPass,
} from "./swap-gate";

// The cost ceiling and its degradation order (doc 05 §B.5).
export {
  BATCH_DISCOUNT,
  CASE_COST_CEILING_USD,
  DEGRADATIONS,
  ESTIMATED_STEP_COST_USD,
  planCaseSpend,
  readCaseSpend,
  shouldBatchPostJudgment,
} from "./cost";

export type {
  CaseSpend,
  CaseSpendPlan,
  Degradation,
  PlanCaseSpendOptions,
} from "./cost";

// The blind advocate pair's input assembly (doc 05 §B.3). Blindness is a
// property of what each seat is serialized, never of the prompt they share.
export {
  ADVOCATE_INPUT_FORMAT,
  ADVOCATE_SEATS,
  ADVOCATE_TASK_NOTE,
  ADVOCATE_WITHHELD,
  AdvocacyError,
  advocateTask,
  assignAdvocateSeats,
  buildAdvocateInput,
  checkAdvocateBrief,
  clarificationForParty,
  seatBriefs,
  serializeAdvocateBriefs,
} from "./advocacy";

export type {
  AdvocateAssignment,
  AdvocateBriefRecord,
  AdvocateFault,
  AdvocateFaultCode,
  AdvocateInput,
  AdvocateSeat,
} from "./advocacy";

// The dossier the two judgment stages are written from.
export {
  JUDGMENT_DOSSIER_FORMAT,
  assembleJudgmentDossier,
  serializeJudgmentDossier,
} from "./dossier";

export type { DossierSection, JudgmentDossier } from "./dossier";

// Generation: the two model calls and every check between them.
export {
  MAX_JUDGMENT_ATTEMPTS,
  SKELETON_TASK,
  checkFactLayer,
  checkSurfaceLayer,
  renderLevelTask,
  renderNarrativePrompt,
  hearingLimits,
  runAdvocatePair,
  runChecked,
  runGatedHearing,
  runJudgmentNarrative,
  runJudgmentSkeleton,
  skeletonProvenance,
} from "./generation";

export type {
  GatedHearing,
  JudgmentProvenance,
  JudgmentRejection,
  JudgmentRejectionCode,
  JudgmentRunOptions,
  JudgmentStepResult,
} from "./generation";

// Gated publication (SPEC ⑧): buffer, persist as draft, validate, publish whole
// — and, for a two-party version, publish to both parties in the same instant
// (doc 05 §A.1 state 6): `publishToBothParties` writes her copy inside the
// transaction that freezes the judgment, `describeRelease` says which path a
// given version took.
export {
  SERVER_LIMITS_SECTION_ID,
  describeRelease,
  generateJudgment,
  publishToBothParties,
  readPublished,
  withServerLimits,
} from "./publication";
export type {
  CounterpartyNarrative,
  GenerateJudgmentOptions,
  JudgmentRunOutcome,
  ReleaseState,
  ReleaseView,
  SimultaneousReleaseOutcome,
} from "./publication";

// The progress channel. Its event type is the guarantee that no body text can
// reach a viewer before the judgment is published.
export {
  JUDGMENT_FAILURE_CODES,
  JUDGMENT_PHASES,
  doneEvent,
  encodeProgressEvent,
  failedEvent,
  heartbeatEvent,
  judgmentProgress,
  phaseEvent,
  thinkingEvent,
} from "./progress";

export type {
  JudgmentFailureCode,
  JudgmentPhase,
  JudgmentProgressEvent,
  JudgmentProgressState,
} from "./progress";

export type {
  Claim,
  ClaimTier,
  ContractCheck,
  ContractViolation,
  ContractViolationCode,
  FactLayer,
  Findings,
  JudgmentDraftInput,
  JudgmentDraftPatch,
  JudgmentRecord,
  JudgmentSection,
  JudgmentStoreErrorCode,
  CounterpartyCopy,
  NextVersionInput,
  RecordBasis,
  Rendition,
  RenditionRecord,
  ResponsibilityAllocation,
  ResponsibilityFinding,
  SectionAudience,
  SectionKind,
  SectionProjection,
  SectionProjectionInput,
  SectionReader,
  SectionVisibilityReason,
  SurfaceLayer,
  UnresolvedQuestion,
  UnresolvedReason,
} from "./contract";

/*
 * Placeholder locking — kept after the GPT polish layer that used to call it was
 * removed (doc 02 §1.1a). It is the general mechanism for sending text to a
 * model to be rewritten without letting the model touch the facts inside it, and
 * HARD RULE #8 now requires it of any future rewriting layer. It has no caller
 * in this repository today; that is a statement about the caller, not about the
 * mechanism.
 */

export {
  ANY_TOKEN_PATTERN,
  EMPTY_LOCK_STATE,
  LOCK_TOKEN_PATTERN,
  PLACEHOLDER_KINDS,
  findTokens,
  lockSurfaceLayer,
  lockText,
  refillSurfaceLayer,
  refillText,
} from "./placeholders";
export type {
  LockResult,
  LockState,
  LockedSurface,
  PlaceholderEntry,
  PlaceholderKind,
  PlaceholderMap,
} from "./placeholders";

/*
 * The polish archive. `judgment_polish_runs` is closed to new rows — nothing in
 * this repository writes one any more — and stays readable because the rows it
 * already holds are the audit record of what this product sent to a second
 * vendor and what came back.
 */

export { readPolishRuns } from "./polish-history";
export type {
  ArchivedEntailment,
  ArchivedPolishFailure,
  PolishRunRecord,
  SectionDiff,
} from "./polish-history";

// The swap test (SPEC M3 wave B ⑨) — the same record heard twice with the
// parties' address terms exchanged. Reports measured differences and named
// flags; never a score, and never a threshold nothing calibrated it against.
export {
  ROLE_TERMS,
  SWAP_ARMS,
  SWAP_FLAGS,
  SwapTestError,
  assessDegeneracy,
  buildSwapDictionary,
  describeSwapTest,
  diffSkeletons,
  flagDifferences,
  mapSkeletonBack,
  persistSwapTest,
  readSwapTests,
  runSwapTest,
  swapCaseFile,
  swapJudgmentDossier,
  swapPseudonyms,
} from "./swap-test";

export type {
  AllocationComparison,
  ClaimView,
  Degeneracy,
  PairedClaim,
  PseudonymPair,
  RecordBasisComparison,
  RoleTermOccurrence,
  RunSwapTestOptions,
  SkeletonRun,
  SkeletonRunner,
  SwapArm,
  SwapArmRecord,
  SwapDictionary,
  SwapDifferences,
  SwapFlag,
  SwapFlagCode,
  SwapTestErrorCode,
  SwapTestRecord,
  SwapTestReport,
  SwappedCaseFile,
} from "./swap-test";

// Dual-version renditions (SPEC M3 wave B ⑪) — the client's copy carries the
// criticism, the shareable copy carries the provenance-and-redistribution
// notice, an invitation and no verdict, and no share token is ever minted for
// the first one.
export {
  DEFAULT_RESPONSE_ENTRY_POINT,
  INVITATION_HEADING,
  INVITATION_TEXT,
  NOTICE_BASIS_OPENING,
  NOTICE_OPENING,
  NOTICE_REDISTRIBUTION,
  RESPONSE_PROMPT,
  RESPONSE_WITHOUT_LINK,
  SHARE_TOKEN_TTL_MS,
  RenditionError,
  assertShareable,
  checkCounterpartyAddress,
  checkShareableLanguage,
  deadRespondPointers,
  findProvenanceNotice,
  hasProvenanceNotice,
  hashShareToken,
  isResolvableEntryPoint,
  mintShareToken,
  readRenditionView,
  readShareableNarrative,
  noticeBasisFor,
  noticeBasisFrom,
  provenanceNotice,
  readSharedRendition,
  responseClosing,
  DISAGREEMENT_HEADING,
  DISAGREEMENT_RULE,
  renderDisagreement,
  renderJudgmentRendition,
  renderSelfReflection,
  renderShareable,
  stripVerbatimQuotes,
} from "./rendition";

export type {
  Disagreement,
  DisagreementReading,
  MintShareTokenOptions,
  NoticeBasis,
  RenditionErrorCode,
  RenditionView,
  RenditionViolation,
  ShareToken,
  ShareableFrame,
  ShareableOptions,
} from "./rendition";

// M4 ①: the shareable copy is written to the counterparty from the frozen fact
// layer, not filtered out of the client's copy. Generated, checked, and stored
// on the rendition row — the judgment itself is never written again.
export {
  checkShareableNarrative,
  generateShareableRendition,
  persistShareableNarrative,
  renderShareableNarrativePrompt,
  runShareableNarrative,
} from "./shareable-narrative";

export type {
  ShareableNarrativeContext,
  ShareableNarrativeOptions,
  ShareableNarrativeProvenance,
  ShareableRenditionOutcome,
  StoredShareableNarrative,
} from "./shareable-narrative";

// Freezing at the service boundary and the version-comparison view
// (SPEC M3 wave B ⑫, HARD RULE #6): a final judgment cannot be edited, a
// re-hearing is version + 1, and the diff plus the serving model is the
// disclosure that makes the re-hearing legitimate.
export {
  compareJudgmentRecords,
  compareJudgmentVersions,
  describeVersionComparison,
  diffLines,
  editJudgment,
  hasChanges,
  listVersionSides,
  regenerateJudgment,
} from "./versions";

export type {
  AllocationChange,
  ClaimChange,
  ClaimSnapshot,
  DiffLine,
  DiffOp,
  RegenerateInput,
  SectionChange,
  VersionComparison,
  VersionSide,
} from "./versions";

// M4 ②: the improvement contract. Derived from the frozen fact layer, one to
// three items, each tied to claims — and at any level below L1 only the client
// can be bound, because the other party was never heard. That rule is code:
// the generation boundary demotes an item addressed to her to an invitation,
// and the storage door refuses to write one as a commitment at all.
export {
  CONTRACT_CONTENT_VERSION,
  CONTRACT_ITEM_KINDS,
  MAX_CONTRACT_ITEMS,
  ImprovementContractError,
  boundPartiesAllowed,
  checkImprovementContract,
  contractProvenanceSchema,
  generateImprovementContract,
  improvementContractContentSchema,
  mayBind,
  normalizeImprovementContract,
  persistImprovementContract,
  readImprovementContract,
  renderImprovementContract,
  renderImprovementContractPrompt,
  resolveClaimProvenance,
  runImprovementContract,
  storedContractItemSchema,
} from "./improvement-contract";

export type {
  ClaimProvenance,
  ContractFault,
  ContractItemKind,
  ContractProvenanceRecord,
  ContractRenderOptions,
  ImprovementContractContent,
  ImprovementContractContext,
  ImprovementContractErrorCode,
  ImprovementContractOptions,
  ImprovementContractOutcome,
  ImprovementContractProvenance,
  ImprovementContractRecord,
  StoredContractItem,
} from "./improvement-contract";

// M4 ③: the repair-conversation script — the opening line, and the block for
// the moment it goes wrong. Generated from the fact layer, never from the
// narrative: the prose is a reading of the claims written to persuade its
// reader, and this is text somebody is going to say out loud.
export {
  REPAIR_SCRIPT_CONTENT_VERSION,
  RepairScriptError,
  checkRepairScript,
  generateRepairScript,
  normalizeRepairScript,
  persistRepairScript,
  readRepairScript,
  renderRepairScript,
  renderRepairScriptPrompt,
  repairScriptContentSchema,
  repairScriptProvenance,
  runRepairScript,
} from "./repair-script";

export type {
  RepairScriptContent,
  RepairScriptContext,
  RepairScriptErrorCode,
  RepairScriptOptions,
  RepairScriptOutcome,
  RepairScriptProvenance,
  RepairScriptRecord,
} from "./repair-script";

// M4 ⑤ / M5 ⑤: the appeal channel. A frozen judgment is not edited and not
// annotated — disagreeing with it produces version n + 1 through the same chain,
// heard at effort `max` with the grounds and whatever has been confirmed since,
// and the diff against the previous version is the disclosure that makes the
// re-hearing legitimate. One appeal per version PER PARTY, refused in the
// service layer and enforced by a unique index: the anti-shopping rule stops one
// person re-rolling the dice, it does not let one person spend the other's turn.
export {
  AppealError,
  appealJudgment,
  describeAppealDiff,
  fileAppeal,
  hearAppeal,
  listAppeals,
  listAppealsForJudgment,
  readAppeal,
  readAppealByActor,
  readAppealForJudgment,
  readAppealParty,
  renderAppealPrompt,
  summarizeAppealDiff,
} from "./appeal";

export type {
  AppealDiff,
  AppealErrorCode,
  AppealHearingOptions,
  AppealMaterial,
  AppealOutcome,
  AppealParty,
  AppealRecord,
  FileAppealInput,
  RetierChange,
} from "./appeal";

// M4 ⑥: the export gate — the last thing that runs before a copy leaves the
// machine. Real names and nickname variants block; a long verbatim quote blocks
// unless it is the recipient's own words; the document is watermarked and
// metadata-stripped; self_reflection never leaves; every export that happens is
// audited, and one that is refused writes nothing because nothing left.
//
// M5 ③ adds one more refusal to both this door and the share-token door: a party
// who has withdrawn consent for documents naming them. `NamedRenditionRevokedError`
// is re-exported here because `mintShareToken` and `readSharedRendition` raise it
// unflattened — it carries who withdrew and which copies had already left — so a
// caller of this module can catch every refusal without reaching into `access/`.
export { NamedRenditionRevokedError } from "../access/consent";

export {
  ExportBlockedError,
  MAX_THIRD_PARTY_QUOTE_CHARS,
  REFUSED_SHARE_CHANNELS,
  assertExportAllowed,
  checkQuoteAttribution,
  composeWatermark,
  deriveNameFragments,
  exportRendition,
  findVerbatimQuotes,
  isRecipientQuote,
  listCaseExports,
  listExports,
  scanRealNames,
  stripExportMetadata,
} from "./export-gate";

export type {
  ExportAuditRecord,
  ExportRecipient,
  ExportRefusalCode,
  ExportRequest,
  ExportViolation,
  ExportedDocument,
  NameHit,
  NameHitKind,
  QuoteAudience,
  QuoteSpan,
  WatermarkInput,
} from "./export-gate";
