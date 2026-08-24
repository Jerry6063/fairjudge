// Public surface of the LLM gateway. Import from here, never from `claude.ts`
// directly — HARD RULE #7: every model call goes through `runStage`.

export { runStage } from "./claude";
export type { StageSelector } from "./claude";

// M3 stage descriptors (and the helper they are declared with) live in
// `./stages`; `runStage` takes one of those in place of a registry key.
export { defineStage } from "./stages";

export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  FALLBACK_MODEL,
  MODEL_FABLE,
  MODEL_OPUS,
  MODEL_PRICING,
  SERVER_SIDE_FALLBACK_BETA,
  STAGE_REGISTRY,
  computeCostUsd,
  evidenceAnomalySchema,
  isFableModel,
  toJsonSchemaFormat,
  translationSchema,
} from "./config";

export type {
  CacheTtl,
  EvidenceAnomalyOutput,
  JsonSchemaFormat,
  ModelPricing,
  StageDefinition,
  StageName,
  StageOutput,
  TokenUsage,
  TranslationOutput,
} from "./config";

export { EGRESS_RETENTION_DAYS, recordCall, sha256Hex } from "./ledger";
export type { CallRecord, RecordedCall } from "./ledger";

export { EgressPipeline } from "./egress";

export type {
  RunStageOptions,
  StageDescriptor,
  StageInput,
  StageMessage,
  StageMeta,
  StageResult,
  StageRole,
} from "./types";
