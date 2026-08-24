// Public IO types for the LLM gateway (`src/server/llm/`).
//
// Every model call in the product goes through `runStage`, so these types are
// the only contract callers (API routes, scripts) need. Domain code never sees
// an SDK type: a refusal is a value (`kind: "refused"`), not an exception, and
// a transport failure is a value too (`kind: "error"`).

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import type { Db } from "../db";
import type { LlmEffort, LlmProvider } from "../db/schema";
import type { PersonDict } from "../pseudonym";

/**
 * A stage handed to `runStage` inline, instead of by registry name.
 *
 * Same fields the registry entries carry, plus the `name` the audit rows are
 * written under — which is why it is required: an `llm_calls` row with no stage
 * name is an unattributable egress. `provider` defaults to `"anthropic"`.
 *
 * This exists so M3's stages can live in `src/server/llm/stages/*` (SPEC M3
 * decision record, 2026-08-09) without every one of them growing `config.ts`.
 * It buys nothing else: an inline stage takes exactly the same path through the
 * gateway as a registered one — fallback beta on fable, refusal check before
 * content, sticky-routing detection, pseudonymized egress, `llm_calls` +
 * `egress_ledger` per attempt.
 */
export interface StageDescriptor<TSchema extends z.ZodType = z.ZodType> {
  /** Recorded as `llm_calls.stage`. Must be non-empty and stable over time. */
  readonly name: string;
  /** Defaults to `"anthropic"`. */
  readonly provider?: LlmProvider;
  readonly model: string;
  readonly effort: LlmEffort;
  readonly maxTokens: number;
  /** Response contract: converted to json_schema, then re-validated locally. */
  readonly zodSchema: TSchema;
  /** System prompt. Never carries hard-rule enforcement — that lives in code. */
  readonly promptTemplate: string;
  /** Bumped whenever `promptTemplate` changes, for reproducibility. */
  readonly promptVersion: string;
  /**
   * Leave 甲/乙 in the returned value instead of putting the real names back.
   *
   * The gateway's default is display-oriented: pseudonyms out, canonical names
   * back in, so a translator card reads naturally. A stage whose output is
   * **persisted** needs the opposite, and says so here — the judgment is stored,
   * re-validated and shared as a document, and its record basis is compared
   * against a database keyed by pseudonym. (Found the hard way: the first real
   * hearing was rejected twice for restating `client_pseudonym` as the client's
   * display name, which is exactly what the gateway had just rewritten 乙 into.)
   *
   * PII placeholders are restored regardless — see `EgressPipeline.restore`.
   */
  readonly keepPseudonyms?: boolean;
}

/** Conversation roles the gateway accepts. Assistant prefill is never allowed. */
export type StageRole = "user" | "assistant";

/** One turn of caller-supplied conversation text (pre-pseudonymization). */
export interface StageMessage {
  role: StageRole;
  text: string;
}

/**
 * Caller input for one stage run.
 *
 * Supply either `prompt` (single user turn) or `messages` (multi-turn). The
 * stage's own system prompt comes from the registry, never from the caller.
 */
export interface StageInput {
  /** Single user turn. Ignored when `messages` is supplied. */
  prompt?: string;
  /** Multi-turn conversation. Takes precedence over `prompt`. */
  messages?: readonly StageMessage[];
  /**
   * Person dictionary for the deterministic pseudonymization layer. May be
   * empty (M1) — the regex PII layer runs regardless.
   */
  dict?: PersonDict;
  /** Optional case association for the audit rows. */
  caseId?: string | null;
}

/** Accounting/provenance for a successful run, safe to surface in the UI. */
export interface StageMeta {
  /** Model that actually served the response (may be the fallback model). */
  model: string;
  /** Effort level requested for the stage. */
  effort: LlmEffort | null;
  /** True when server-side fallback served any attempt (sticky routing). */
  fallbackUsed: boolean;
  /** Total USD cost of every attempt in this run (0 when pricing is unknown). */
  costUsd: number;
  /** Total wall-clock milliseconds spent inside the provider calls. */
  latencyMs: number;
}

/**
 * Discriminated result of a stage run. A refusal and a transport error are both
 * expected outcomes, so callers must branch instead of catching.
 */
export type StageResult<T> =
  | { kind: "ok"; data: T; meta: StageMeta }
  | { kind: "refused"; category?: string }
  | { kind: "error"; retryable: boolean; message: string };

/** Infrastructure overrides — tests inject an in-memory Db and a mock client. */
export interface RunStageOptions {
  /** Database for the audit rows. Defaults to the process-wide client. */
  db?: Db;
  /** Anthropic client. Defaults to a lazily-built singleton. */
  client?: Anthropic;
}
