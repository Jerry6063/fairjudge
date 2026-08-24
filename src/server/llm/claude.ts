// The single Anthropic call path — HARD RULE #7.
//
// No other module may talk to the provider. Everything the rule demands is
// enforced here, in code, so it cannot drift into prompt text:
//
//   * fable calls carry `betas: ["server-side-fallback-2026-06-01"]` +
//     `fallbacks: [{model: "claude-opus-4-8"}]` and omit `thinking` entirely
//     (thinking is always on for that model and any explicit config is a 400);
//     opus calls go through the non-beta endpoint with `thinking: {adaptive}`.
//   * `temperature` / `top_p` / `top_k` are never constructed (the models we
//     use reject them, and sampling knobs are not how this product is steered).
//   * no assistant prefill — the last turn must be a user turn.
//   * `stop_reason === "refusal"` is checked before any content is read, and
//     surfaces as a domain result, never an exception.
//   * `usage.iterations` is inspected for a `fallback_message` entry (sticky
//     routing) and the answer is persisted with the call.
//   * every attempt writes `llm_calls` + `egress_ledger` — including the
//     attempts that never came back. This path carries the whole case: the
//     confirmed utterances, the assembled dossier, the quoted evidence. A
//     request that timed out or dropped its connection put all of it on the
//     wire, so the payload is hashed BEFORE the send and the pair is written
//     from the catch, with token counts and cost left null (unknown, not zero)
//     and `stop_reason` recording that nothing came back. The one request that
//     is deliberately not recorded is one the SDK refused to dispatch: no byte
//     reached a socket, and a row claiming otherwise is a false entry. The
//     ledger may under-claim a connection it cannot confirm died; it may never
//     invent a send.
//
// Structured output: the stage's zod schema is converted to json_schema for
// `output_config.format`, and the response is re-validated with the same zod
// schema after `JSON.parse`. A schema violation is retried exactly once with the
// validation error attached, then returned as an error.
//
// ## Assembly is separable from transport
//
// Everything from the caller's text down to the bytes of the request is a pure
// function — `prepareRequest` below — and `runStage` is that function plus a
// socket. The split is not decoration: a second runtime (doc 05 §B) drives the
// same stages through the model already running the surrounding session, and it
// has to send *the same bytes* — the same dossier, the same pseudonymization,
// the same byte-stable serialization, the same json_schema — or it is a
// different product wearing this one's audit trail. `llm/external.ts` is that
// runtime, and it calls `prepareRequest` rather than reimplementing it, which is
// what makes "the same" a fact about the code instead of a claim in a comment.

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import { getDb, type Db } from "../db";
import {
  FALLBACK_MODEL,
  MAX_NONSTREAMING_TOKENS,
  SERVER_SIDE_FALLBACK_BETA,
  STAGE_REGISTRY,
  computeCostUsd,
  isFableModel,
  toJsonSchemaFormat,
  type JsonSchemaFormat,
  type StageDefinition,
  type StageName,
  type StageOutput,
  type TokenUsage,
} from "./config";
import { EgressPipeline } from "./egress";
import { recordCall, sha256Hex, type CallRecord } from "./ledger";
// Which SDK failures never reached a socket, and why the ones that did came
// back empty. Shared with the Message Batches submit in `followups/runner.ts`,
// which asks the same SDK the same questions (see `undelivered.ts`).
import { neverDispatched, requestIdOf, undeliveredReason } from "./undelivered";
import type {
  RunStageOptions,
  StageDescriptor,
  StageInput,
  StageMessage,
  StageResult,
} from "./types";

/** One schema-validation retry, i.e. at most two provider calls per run. */
const MAX_ATTEMPTS = 2;

/** Validation detail forwarded to the model on a retry, truncated. */
const MAX_RETRY_DETAIL = 400;

/* -------------------------------------------------------------------------- */
/* Response reading                                                           */
/* -------------------------------------------------------------------------- */

// Read through a narrow structural view rather than the SDK's `Message` /
// `BetaMessage` unions: the two endpoints return different shapes (only the
// beta one carries `usage.iterations`) and the fields below are all the gateway
// needs from either.

interface IterationLike {
  type?: string;
  model?: string;
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  iterations?: IterationLike[] | null;
}

interface ContentBlockLike {
  type?: string;
  text?: string;
}

interface ResponseLike {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content?: ContentBlockLike[] | null;
  usage?: UsageLike | null;
  _request_id?: string | null;
}

function readUsage(response: ResponseLike): TokenUsage {
  const usage = response.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** What `llm_calls` can honestly say about tokens when nothing came back. */
interface PartialUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

/**
 * Token counts from a request that never produced a message.
 *
 * `readUsage` zero-fills a missing counter, which is right when the provider
 * answered: it reported the field, and the field was empty. Nothing answered
 * here, so a missing counter is *unknown*, and null is the only honest value —
 * a 0 in a usage row reads as "this call consumed nothing".
 *
 * A stream that died mid-response is the one case with something to say. The
 * SDK keeps a running snapshot of the message it was assembling, so whatever
 * `message_start` and the deltas had already reported (input tokens almost
 * always, output tokens as far as they got) is real and is recorded as the
 * partial count it is, beside a `stop_reason` that says the response never
 * finished. Everything the snapshot does not carry stays null.
 */
function readPartialUsage(response: ResponseLike | undefined): PartialUsage {
  const usage = response?.usage ?? {};
  const count = (value: number | null | undefined): number | null =>
    typeof value === "number" ? value : null;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadInputTokens: count(usage.cache_read_input_tokens),
    cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
  };
}

/** Sticky-routing detection: a `fallback_message` entry in `usage.iterations`. */
function readFallback(response: ResponseLike): IterationLike | undefined {
  const iterations = response.usage?.iterations;
  if (!Array.isArray(iterations)) return undefined;
  return iterations.find((entry) => entry?.type === "fallback_message");
}

/** Concatenate the text blocks; thinking and other block types are ignored. */
function extractText(response: ResponseLike): string {
  const blocks = response.content ?? [];
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

type OutboundMessage = { role: "user" | "assistant"; content: string };

// What `.stream()` accepts on each endpoint, taken off the method rather than
// named: the two aliases the SDK exports for these (`MessageStreamParams`,
// `BetaMessageStreamParams`) are not both reachable from the `Anthropic`
// namespace, and a deep import into `resources/` would pin a path the SDK is
// free to move. Structurally these are the non-streaming bodies `buildBody`
// already returns, minus the `stream` discriminant.
type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];
type BetaStreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/**
 * The part of the SDK's stream helpers this module touches.
 *
 * Structural for the same reason `ResponseLike` is: `MessageStream` and
 * `BetaMessageStream` are separate classes over separate message types, and the
 * gateway wants the same three things from either — the assembled message, what
 * had been assembled when it died, and whether it died because it was aborted.
 * The last two only matter on the failure path, and both are optional here so a
 * stream helper that does not expose them simply reports nothing.
 */
interface StreamLike {
  finalMessage(): Promise<unknown>;
  /** Running snapshot of the message being assembled, if any. */
  readonly currentMessage?: unknown;
  readonly aborted?: boolean;
  readonly request_id?: string | null;
}

/**
 * Assemble the request body for a stage.
 *
 * Two shapes, one branch, because the models differ: `claude-fable-5` needs the
 * fallback beta and must not receive a `thinking` key at all, while the opus
 * family is a plain `messages.create` with adaptive thinking. Neither branch
 * ever constructs a sampling parameter.
 */
function buildBody(
  def: StageDefinition,
  system: string,
  messages: readonly OutboundMessage[],
  format: JsonSchemaFormat,
):
  | Anthropic.MessageCreateParamsNonStreaming
  | Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const common = {
    model: def.model,
    max_tokens: def.maxTokens,
    system,
    messages: [...messages],
    output_config: { effort: def.effort, format },
  };

  if (isFableModel(def.model)) {
    return {
      ...common,
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: [{ model: FALLBACK_MODEL }],
    } satisfies Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  }

  return {
    ...common,
    thinking: { type: "adaptive" },
  } satisfies Anthropic.MessageCreateParamsNonStreaming;
}

/* -------------------------------------------------------------------------- */
/* Input manifest                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What one call serialized into its prompt — doc 05 §B.3.
 *
 * "What did this agent see" is supposed to be a ledger answer, not a
 * prompt-reading exercise, so every call records the ids that were actually in
 * its bytes together with the prompt version they were in the bytes of.
 */
export interface InputManifest {
  /** Sorted, de-duplicated. Empty is a legitimate answer, not a missing one. */
  readonly ids: readonly string[];
  readonly prompt_version: string;
}

/**
 * Row ids as they appear inside a serialized record. `pk()` is `randomUUID`,
 * so every durable id in this product has this shape.
 */
const ROW_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * The wave-A case file's per-assembly citation handles (`U1`, `E7`, `V2`).
 *
 * Matched only as the value of a `"ref"` key, which is the one place
 * `serializeCaseFile` emits them — a bare `U1` also occurs in evidence text, and
 * a manifest that swallowed those would be describing the conversation rather
 * than the record. The handles are in the manifest at all because for those
 * stages they are the *entire* id space: `case-file.ts` deliberately keeps the
 * database ids server-side, so a UUID-only manifest of a wave-A call would read
 * as "this agent saw nothing".
 */
const CASE_FILE_HANDLE = /"ref"\s*:\s*"([A-Za-z]{1,3}\d+)"/g;

/**
 * Derive the manifest from the assembled outbound text.
 *
 * Derived, not declared, and that is the point. A caller that hands in a list of
 * what it believes it serialized can be wrong — it is a second implementation of
 * the serializer, kept in sync by hand — whereas the bytes cannot disagree with
 * themselves. It costs one regex pass over text this process was about to hash
 * anyway.
 *
 * Reads the prompt as it stands AFTER the pseudonymization gateway, because that
 * is what leaves. Neither id space survives a scrub (ids are not names and not
 * PII), so in practice the two texts agree — but the one that is asked is the
 * one that goes.
 */
export function buildManifest(
  promptVersion: string,
  texts: readonly string[],
): InputManifest {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ROW_ID)) ids.add(match[0].toLowerCase());
    for (const match of text.matchAll(CASE_FILE_HANDLE)) ids.add(match[1]);
  }
  return { ids: [...ids].sort(), prompt_version: promptVersion };
}

/**
 * The manifest's byte-stable serialization — the exact bytes hashed and stored.
 *
 * Written key by key rather than through `JSON.stringify(object)` so the order
 * is a property of this function instead of a property of how the literal above
 * happens to be written. Same discipline as the prompt bodies (CLAUDE.md), for
 * the same reason: the hash is only worth having if identical input produces it.
 */
export function serializeManifest(manifest: InputManifest): string {
  return JSON.stringify({
    ids: [...manifest.ids],
    prompt_version: manifest.prompt_version,
  });
}

/** The manifest and its hash, in the pair the audit row wants. */
export interface ManifestRecord {
  readonly manifest: InputManifest;
  readonly json: string;
  readonly sha256: string;
}

export function manifestRecord(
  promptVersion: string,
  texts: readonly string[],
): ManifestRecord {
  const manifest = buildManifest(promptVersion, texts);
  const json = serializeManifest(manifest);
  return { manifest, json, sha256: sha256Hex(json) };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

let cachedClient: Anthropic | undefined;

/** Lazily-built shared client; reads `ANTHROPIC_API_KEY` from the environment. */
function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

/** HTTP statuses worth retrying (the SDK retries some of these itself). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function describeError(error: unknown): {
  retryable: boolean;
  message: string;
} {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof status === "number") {
    return {
      retryable: isRetryableStatus(status),
      message: `${status}: ${message}`,
    };
  }
  // No HTTP status: connection error, timeout, or an abort — worth retrying.
  return { retryable: true, message };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Write the `llm_calls` + `egress_ledger` pair for one attempt.
 *
 * Returns the reason it could not be written, or `undefined` on success. A
 * payload that left the process without a ledger row is exactly the state the
 * ledger exists to make impossible, so the caller never swallows the answer:
 * on the answered path it fails the run, and on the failure path it is appended
 * to the error the run was already returning.
 */
function writeAudit(db: Db, record: CallRecord): string | undefined {
  try {
    recordCall(db, record);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `ledger write failed: ${message}`;
  }
}

/* -------------------------------------------------------------------------- */
/* runStage                                                                   */
/* -------------------------------------------------------------------------- */

/** Either form `runStage` accepts: a registry key, or a stage described inline. */
export type StageSelector = StageName | StageDescriptor;

type Resolved =
  | { readonly ok: true; readonly name: string; readonly def: StageDefinition }
  | { readonly ok: false; readonly message: string };

/**
 * Reduce either form of stage to the (name, definition) pair the rest of the
 * gateway runs on.
 *
 * An inline descriptor is validated here rather than trusted: it arrives from a
 * module the registry never saw, and the three things checked below are the
 * ones that would otherwise fail deep inside the SDK or, worse, quietly write
 * an unattributable audit row.
 */
function resolveStage(selector: StageSelector): Resolved {
  if (typeof selector === "string") {
    const def: StageDefinition | undefined = STAGE_REGISTRY[selector];
    if (!def) return { ok: false, message: `unknown stage: ${selector}` };
    return { ok: true, name: selector, def };
  }

  const name = selector.name.trim();
  if (name === "") {
    return {
      ok: false,
      message:
        "an inline stage descriptor needs a non-empty `name` — it is what the " +
        "llm_calls / egress_ledger rows are attributed to",
    };
  }
  if (selector.model.trim() === "") {
    return { ok: false, message: `inline stage ${name}: \`model\` is empty` };
  }
  if (!Number.isInteger(selector.maxTokens) || selector.maxTokens <= 0) {
    return {
      ok: false,
      message: `inline stage ${name}: \`maxTokens\` must be a positive integer`,
    };
  }

  return {
    ok: true,
    name,
    def: {
      // Anthropic unless a stage says otherwise, which none does: the OpenAI
      // polish path was the only stage that ever set this, and it is gone. The
      // field stays because `llm_calls.provider` is written from it and the
      // ledger's answer to "to whom" should keep coming from the stage rather
      // than from a constant nobody would think to check.
      provider: selector.provider ?? "anthropic",
      model: selector.model,
      effort: selector.effort,
      maxTokens: selector.maxTokens,
      zodSchema: selector.zodSchema,
      promptTemplate: selector.promptTemplate,
      promptVersion: selector.promptVersion,
      keepPseudonyms: selector.keepPseudonyms,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* prepareRequest — assembly, with no transport in it                         */
/* -------------------------------------------------------------------------- */

/** One assembled request, before anything decides how to deliver it. */
export interface PreparedRequest {
  /** The name the audit rows are attributed to. */
  readonly stage: string;
  readonly def: StageDefinition;
  /** System prompt, past the gateway. */
  readonly system: string;
  /** Conversation turns, past the gateway. Last one is always `user`. */
  readonly messages: readonly OutboundMessage[];
  /** The stage's zod schema as `output_config.format`. */
  readonly format: JsonSchemaFormat;
  readonly manifest: ManifestRecord;
  /**
   * The live scrub state. Restoration on the way back is this object's job and
   * only this object's — the placeholder map is process-local and is never
   * serialized (HARD RULE #3), so a response can only be restored by the
   * pipeline that masked it.
   */
  readonly pipeline: EgressPipeline;
}

export type PrepareResult =
  | { readonly ok: true; readonly request: PreparedRequest }
  | {
      readonly ok: false;
      readonly error: { kind: "error"; retryable: false; message: string };
    };

/**
 * Everything between a caller's text and the bytes of a request — and nothing
 * else.
 *
 * Pure: no client, no database, no clock, no network. It resolves the stage,
 * checks the turn shape, runs the egress gateway (HARD RULE #3), converts the
 * zod schema to json_schema, and computes the input manifest over the assembled
 * text. What it returns is a complete description of what would be sent, which
 * is why both runtimes can be built on it — `runStage` puts it on a socket,
 * `llm/external.ts` writes it to a file.
 *
 * Failures come back as the same `kind: "error"` value `runStage` returns, so
 * the caller that wanted a stage result can return it unchanged.
 */
export function prepareRequest(
  stage: StageSelector,
  input: StageInput,
): PrepareResult {
  const fail = (message: string): PrepareResult => ({
    ok: false,
    error: { kind: "error", retryable: false, message },
  });

  const resolved = resolveStage(stage);
  if (!resolved.ok) return fail(resolved.message);
  const { name: stageName, def } = resolved;

  const turns = collectTurns(input);
  if (turns.length === 0) {
    return fail("stage input requires either `prompt` or a non-empty `messages`");
  }
  if (turns[turns.length - 1].role !== "user") {
    // Assistant prefill is rejected by every model this product uses.
    return fail(
      "the last message must be a user turn (assistant prefill is not allowed)",
    );
  }

  // --- egress gateway ------------------------------------------------------
  const pipeline = new EgressPipeline(input.dict ?? []);
  const system = pipeline.apply(def.promptTemplate);
  const messages: OutboundMessage[] = turns.map((turn) => ({
    role: turn.role,
    content: pipeline.apply(turn.text),
  }));

  const blocked = residualPii(pipeline, system, messages);
  if (blocked) return { ok: false, error: blocked };

  return {
    ok: true,
    request: {
      stage: stageName,
      def,
      system,
      messages,
      format: toJsonSchemaFormat(def.zodSchema),
      manifest: manifestFor(def, system, messages),
      pipeline,
    },
  };
}

/** The manifest over one assembled turn list. Recomputed per attempt. */
function manifestFor(
  def: StageDefinition,
  system: string,
  messages: readonly OutboundMessage[],
): ManifestRecord {
  return manifestRecord(def.promptVersion, [
    system,
    ...messages.map((message) => message.content),
  ]);
}

/**
 * Run one stage end to end — either a registered one (by name) or one described
 * inline.
 *
 * Pipeline: caller text -> pseudonymize -> PII scrub -> request -> provider ->
 * refusal check -> JSON parse -> zod re-validation -> restore for display.
 *
 * Both forms take exactly this path: there is one request builder, one refusal
 * check, one fallback detector and one audit write, and `resolveStage` collapses
 * the two forms before any of them run. An inline stage is a different place to
 * keep the model/prompt/schema, never a different set of guarantees.
 *
 * Never throws: transport failures, refusals and schema violations all come back
 * as `StageResult` variants so callers branch instead of catching.
 */
export async function runStage<S extends StageName>(
  stage: S,
  input: StageInput,
  options?: RunStageOptions,
): Promise<StageResult<StageOutput<S>>>;
export async function runStage<TSchema extends z.ZodType>(
  stage: StageDescriptor<TSchema>,
  input: StageInput,
  options?: RunStageOptions,
): Promise<StageResult<z.infer<TSchema>>>;
export async function runStage(
  stage: StageSelector,
  input: StageInput,
  options: RunStageOptions = {},
): Promise<StageResult<unknown>> {
  // --- assembly (pure; shared with the external-session runtime) -----------
  const prepared = prepareRequest(stage, input);
  if (!prepared.ok) return prepared.error;
  const {
    stage: stageName,
    def,
    system,
    pipeline,
    format,
  } = prepared.request;
  // The one mutable part of the assembly: a schema-validation retry appends a
  // turn, so this list is copied out of the (readonly) prepared request.
  const messages: OutboundMessage[] = [...prepared.request.messages];

  // --- provider loop -------------------------------------------------------
  let client: Anthropic;
  let db: Db;
  try {
    client = options.client ?? getClient();
    db = options.db ?? getDb();
  } catch (error) {
    // A missing API key or an unopenable database is a configuration fault.
    const { message } = describeError(error);
    return { kind: "error", retryable: false, message };
  }

  const useBeta = isFableModel(def.model);
  // Which transport this stage's own budget requires. See the note at the call.
  const streamed = def.maxTokens > MAX_NONSTREAMING_TOKENS;

  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  let fallbackUsedAny = false;
  let servingModel = def.model;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const body = buildBody(def, system, messages, format);
    // Per attempt, not once per run: a retry appends a turn, and this attempt's
    // row must describe this attempt's prompt. (The correction turn carries no
    // ids, so in practice the second manifest equals the first — recomputing is
    // what keeps that a result rather than an assumption.)
    const manifest = manifestFor(def, system, messages);
    // The exact object handed to the SDK, serialized BEFORE the send. `betas`
    // rides as a header rather than a body field, but it is part of what this
    // call disclosed, so it is hashed. Taking the hash here rather than after
    // the response is what lets the ledger describe what left the process on
    // the paths where nothing comes back.
    const payload = JSON.stringify(body);

    const startedAt = Date.now();
    let raw: unknown;
    // Held on the streaming path so the failure branch can ask a dead stream
    // what it had already received. Undefined on the non-streaming path.
    let stream: StreamLike | undefined;
    try {
      // Streamed over the wire ONLY when the budget demands it, and assembled
      // before anybody sees it either way.
      //
      // Nothing here renders a token as it arrives, and nothing may: every
      // stage returns ONE structured document that is re-validated with
      // `zod.parse` and then audited against the record (HARD RULE #1) before
      // it is worth anything. `finalMessage()` waits for the whole object and
      // returns exactly the shape `create` did — `content`, `usage` (with
      // `iterations`, so sticky-routing detection still works), `stop_reason`
      // (so a `refusal` is still checked before content is read) and
      // `_request_id` — so everything below this line is unchanged.
      //
      // The reason is the transport, not the product: the SDK refuses a
      // non-streaming request whose `max_tokens` could run past ten minutes
      // (`MAX_NONSTREAMING_TOKENS`), and on the real case an L1 fact layer at
      // effort `max` did not fit under that ceiling — it came back truncated at
      // 21333, which is a broken JSON body and a failed hearing. Sizing the
      // judgment to the transport was the alternative, and it is the wrong way
      // round: a hearing gets the tokens the record needs (SPEC M5 ⑥).
      if (streamed) {
        // Kept in a variable rather than chained: a stream that dies mid-
        // response has egressed the whole payload just the same, and the object
        // is the only account of how far it got.
        stream = useBeta
          ? client.beta.messages.stream(body as BetaStreamParams)
          : client.messages.stream(body as StreamParams);
        raw = await stream.finalMessage();
      } else {
        raw = useBeta
          ? await client.beta.messages.create(
              body as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
            )
          : await client.messages.create(
              body as Anthropic.MessageCreateParamsNonStreaming,
            );
      }
    } catch (error) {
      const { retryable, message } = describeError(error);

      // The payload is already gone. A timeout, an abort and a dropped
      // connection each get their pair, hashed from what was sent — the only
      // exception being a request the SDK refused to dispatch (see
      // `neverDispatched`), where recording an egress would invent one.
      if (neverDispatched(error)) {
        return { kind: "error", retryable, message };
      }

      // On the streaming path the half-built snapshot is what the provider had
      // told us when the line died: possibly the serving model, possibly a
      // fallback iteration, possibly partial token counts. Off that path — and
      // when the stream never got that far — every one of them is null.
      const partial = stream?.currentMessage as ResponseLike | undefined;
      const deadFallback = partial ? readFallback(partial) : undefined;
      const deadFallbackUsed = deadFallback !== undefined;
      // The stream's own account of why it died outranks reading the error.
      const undelivered = undeliveredReason(error, stream?.aborted === true);

      const auditGap = writeAudit(db, {
        caseId: input.caseId ?? null,
        stage: stageName,
        provider: def.provider,
        model: deadFallbackUsed
          ? (deadFallback?.model ?? FALLBACK_MODEL)
          : (partial?.model ?? def.model),
        effort: def.effort,
        promptVersion: def.promptVersion,
        ...readPartialUsage(partial),
        // Never priced on this path. A completed exchange's tokens are a bill;
        // a dead stream's partial counts are not, and pricing them would put a
        // number that reads like one into the cost column.
        costUsd: null,
        // This attempt's own clock. A retry's row reports the retry, not the
        // whole exchange.
        latencyMs: Date.now() - startedAt,
        stopReason: `no_response:${undelivered}`,
        fallbackUsed: deadFallbackUsed,
        fallbackMessage: deadFallback ? JSON.stringify(deadFallback) : null,
        requestId:
          partial?._request_id ?? stream?.request_id ?? requestIdOf(error),
        payloadSha256: sha256Hex(payload),
        payloadBytes: Buffer.byteLength(payload, "utf8"),
        // The manifest describes what was SENT, so a request that died on the
        // wire has one for exactly the same reason it has a payload hash: those
        // ids were disclosed whether or not anything came back.
        inputManifest: manifest.json,
        inputManifestSha256: manifest.sha256,
      });

      return {
        kind: "error",
        retryable,
        // The call had already failed; the audit failure cannot change that
        // outcome. What must not happen is that the gap goes unmentioned.
        message: auditGap === undefined ? message : `${message} (${auditGap})`,
      };
    }
    const latencyMs = Date.now() - startedAt;
    totalLatencyMs += latencyMs;

    const response = raw as ResponseLike;
    const usage = readUsage(response);
    const fallbackEntry = readFallback(response);
    const fallbackUsed = fallbackEntry !== undefined;
    fallbackUsedAny ||= fallbackUsed;
    servingModel = fallbackUsed
      ? (fallbackEntry?.model ?? FALLBACK_MODEL)
      : (response.model ?? def.model);

    const costUsd = computeCostUsd(servingModel, usage);
    totalCostUsd += costUsd ?? 0;

    const gap = writeAudit(db, {
      caseId: input.caseId ?? null,
      stage: stageName,
      provider: def.provider,
      model: servingModel,
      effort: def.effort,
      promptVersion: def.promptVersion,
      ...usage,
      costUsd,
      latencyMs,
      stopReason: response.stop_reason ?? null,
      fallbackUsed,
      fallbackMessage: fallbackEntry ? JSON.stringify(fallbackEntry) : null,
      requestId: response._request_id ?? null,
      payloadSha256: sha256Hex(payload),
      payloadBytes: Buffer.byteLength(payload, "utf8"),
      inputManifest: manifest.json,
      inputManifestSha256: manifest.sha256,
    });
    if (gap !== undefined) {
      // Content that cannot be accounted for is not content worth returning.
      return { kind: "error", retryable: false, message: gap };
    }

    // HARD RULE #7: check the stop reason before touching content.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      return category ? { kind: "refused", category } : { kind: "refused" };
    }
    if (response.stop_reason === "max_tokens") {
      return {
        kind: "error",
        retryable: true,
        message: `response truncated at max_tokens (${def.maxTokens})`,
      };
    }

    const validated = validate(def, extractText(response));
    if (validated.ok) {
      return {
        kind: "ok",
        // A stage that declares `keepPseudonyms` gets 甲/乙 back exactly as the
        // model wrote them: its output is stored and re-validated against a
        // record keyed by pseudonym, not rendered into a card.
        data: pipeline.restoreDeep(validated.value, {
          pseudonyms: def.keepPseudonyms !== true,
        }),
        meta: {
          model: servingModel,
          effort: def.effort,
          fallbackUsed: fallbackUsedAny,
          costUsd: totalCostUsd,
          latencyMs: totalLatencyMs,
        },
      };
    }

    if (attempt === MAX_ATTEMPTS - 1) {
      return {
        kind: "error",
        retryable: true,
        message: `structured output failed validation after ${MAX_ATTEMPTS} attempts: ${validated.message}`,
      };
    }
    messages.push({
      role: "user",
      content: pipeline.apply(retryInstruction(validated.message)),
    });
  }

  /* c8 ignore next 5 -- the loop always returns; this satisfies the compiler. */
  return {
    kind: "error",
    retryable: true,
    message: "stage exhausted its attempts without a result",
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function collectTurns(input: StageInput): StageMessage[] {
  if (input.messages && input.messages.length > 0) return [...input.messages];
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    return [{ role: "user", text: input.prompt }];
  }
  return [];
}

/**
 * Block egress when the regex layer still recognizes PII in the assembled
 * payload. The warning text names the pattern type only — never the value.
 */
function residualPii(
  pipeline: EgressPipeline,
  system: string,
  messages: readonly OutboundMessage[],
): { kind: "error"; retryable: false; message: string } | undefined {
  const warnings = [system, ...messages.map((m) => m.content)].flatMap((text) =>
    pipeline.residualPii(text),
  );
  if (warnings.length === 0) return undefined;
  const kinds = [...new Set(warnings.map((w) => w.kind))].join(", ");
  return {
    kind: "error",
    retryable: false,
    message: `egress blocked by the pseudonymization gateway: ${warnings.length} unscrubbed fragment(s) (${kinds})`,
  };
}

type Validated = { ok: true; value: unknown } | { ok: false; message: string };

/** JSON.parse then zod re-validation, per the structured-output contract. */
function validate(def: StageDefinition, text: string): Validated {
  if (text.trim().length === 0) {
    return { ok: false, message: "response contained no text block" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `not valid JSON: ${message}` };
  }
  const result = def.zodSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `schema mismatch: ${issues}` };
  }
  return { ok: true, value: result.data };
}

function retryInstruction(reason: string): string {
  const detail = reason.slice(0, MAX_RETRY_DETAIL);
  return `Your previous output did not match the agreed JSON structure; validation failed: ${detail}\nProduce the output again, strictly conforming to the schema, with no explanatory text around it.`;
}
