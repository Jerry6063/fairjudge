/**
 * The Message Batches round trip: submit, poll, retrieve (SPEC M4 ④).
 *
 * Follow-up questions are the one thing this product generates that nobody is
 * waiting for. The timer fires at 09:00 on a Tuesday; whether the questions
 * exist at 09:00:04 or 09:41 changes nothing for anyone. That makes the Message
 * Batches API free money — the same model, the same request, **50% of the
 * price** — and latency the only thing given up.
 *
 * Three things about the batch endpoint that shape the code below:
 *
 *   1. **`fallbacks` is not available on Batches.** The server-side fallback
 *      parameter is rejected there, so the request bodies built here carry
 *      neither `fallbacks` nor the fallback beta. It costs nothing: fallback
 *      exists to rescue a refusal by re-running on `claude-opus-4-8`, and this
 *      stage already runs on `claude-opus-4-8`. (The same reason a fable stage
 *      could not move to this path — it would be giving up its rescue.)
 *   2. **Results come back in any order.** They are keyed by `custom_id`, never
 *      by position — a batch of two whose results arrive reversed must still
 *      land on the right rows.
 *   3. **Every request in a batch is its own egress and its own result.** One
 *      may succeed while its neighbour errors, so the caller handles them one
 *      at a time rather than treating the batch as a unit.
 *
 * The provider is behind a structural interface: the tests drive the whole
 * submit → poll → retrieve path against a fake, and nothing in a test run can
 * reach the network by accident.
 */

import type Anthropic from "@anthropic-ai/sdk";

import { computeCostUsd, type TokenUsage } from "../llm/config";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/** One request inside a batch. `customId` is how its result is found again. */
export interface BatchRequest {
  readonly customId: string;
  /** A Messages API body. Built by the caller; sent verbatim. */
  readonly params: Record<string, unknown>;
}

export interface BatchHandle {
  readonly id: string;
  /** `in_progress` | `canceling` | `ended`. */
  readonly processingStatus: string;
}

/** What one request in the batch came back as. */
export type BatchEntry =
  | {
      readonly customId: string;
      readonly type: "succeeded";
      readonly text: string;
      readonly stopReason: string | null;
      readonly stopCategory: string | null;
      readonly model: string;
      readonly usage: TokenUsage;
    }
  | {
      readonly customId: string;
      readonly type: "errored" | "canceled" | "expired";
      readonly message: string;
    };

/**
 * The three calls this module needs from a provider. Implemented against the
 * Anthropic SDK below, and against a fake in the tests.
 */
export interface BatchTransport {
  create(requests: readonly BatchRequest[]): Promise<BatchHandle>;
  retrieve(batchId: string): Promise<BatchHandle>;
  results(batchId: string): Promise<readonly BatchEntry[]>;
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                    */
/* -------------------------------------------------------------------------- */

/** Batch processing is billed at half the standard token price. */
export const BATCH_PRICE_MULTIPLIER = 0.5;

/** Cost of one batched request in USD, or null when the model has no price. */
export function batchCostUsd(model: string, usage: TokenUsage): number | null {
  const standard = computeCostUsd(model, usage);
  return standard === null ? null : standard * BATCH_PRICE_MULTIPLIER;
}

/* -------------------------------------------------------------------------- */
/* Polling                                                                    */
/* -------------------------------------------------------------------------- */

export interface PollOptions {
  /** Gap between status checks. Default 15s; tests pass their own sleep. */
  readonly intervalMs?: number;
  /** Give up after this many checks. Default 240 (≈1h at 15s). */
  readonly maxPolls?: number;
  /** Injected so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type PollOutcome =
  | { readonly kind: "ended"; readonly polls: number }
  /** Still running when the budget ran out. The batch id is on the row. */
  | { readonly kind: "timeout"; readonly polls: number; readonly lastStatus: string };

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_POLLS = 240;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a batch until it ends or the budget runs out.
 *
 * A timeout is a value, not an exception: the batch is still processing on the
 * provider's side and the row still carries its id, so the next scheduler run
 * can pick the results up. What must not happen is the run pretending the
 * questions were generated.
 */
export async function awaitBatch(
  transport: BatchTransport,
  batchId: string,
  options: PollOptions = {},
): Promise<PollOutcome> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const sleep = options.sleep ?? realSleep;

  let lastStatus = "unknown";
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const handle = await transport.retrieve(batchId);
    lastStatus = handle.processingStatus;
    if (handle.processingStatus === "ended") return { kind: "ended", polls: poll };
    if (poll < maxPolls) await sleep(interval);
  }
  return { kind: "timeout", polls: maxPolls, lastStatus };
}

/* -------------------------------------------------------------------------- */
/* The Anthropic implementation                                               */
/* -------------------------------------------------------------------------- */

interface ContentBlockLike {
  type?: string;
  text?: string;
}

interface MessageLike {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content?: ContentBlockLike[] | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null;
}

interface ResultLike {
  custom_id?: string;
  result?: {
    type?: string;
    message?: MessageLike;
    error?: unknown;
  };
}

/** Concatenate text blocks; thinking and every other block type is ignored. */
function extractText(message: MessageLike): string {
  return (message.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function readUsage(message: MessageLike): TokenUsage {
  const usage = message.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Normalize one raw batch result row into a `BatchEntry`. */
export function toBatchEntry(raw: ResultLike): BatchEntry | null {
  const customId = raw.custom_id;
  if (typeof customId !== "string" || customId === "") return null;

  const type = raw.result?.type;
  if (type === "succeeded") {
    const message = raw.result?.message ?? {};
    return {
      customId,
      type: "succeeded",
      text: extractText(message),
      stopReason: message.stop_reason ?? null,
      stopCategory: message.stop_details?.category ?? null,
      model: message.model ?? "",
      usage: readUsage(message),
    };
  }
  if (type === "errored" || type === "canceled" || type === "expired") {
    return {
      customId,
      type,
      message:
        type === "errored"
          ? `batch request errored: ${JSON.stringify(raw.result?.error ?? null)}`
          : `batch request ${type}`,
    };
  }
  return {
    customId,
    type: "errored",
    message: `batch result carried an unrecognized type: ${String(type)}`,
  };
}

/**
 * The real transport.
 *
 * `messages.batches` rather than `beta.messages.batches`: the Batches API is
 * GA, and the beta surface is only needed by the fable fallback parameter —
 * which this endpoint does not accept anyway.
 */
export function anthropicBatchTransport(client: Anthropic): BatchTransport {
  return {
    async create(requests) {
      const batch = await client.messages.batches.create({
        requests: requests.map((request) => ({
          custom_id: request.customId,
          // The body is assembled and checked in `runner.ts`; the SDK's param
          // type is the narrow union of every Messages option, so the cast is
          // at this single boundary rather than smeared through the caller.
          params: request.params as unknown as Anthropic.Messages.BatchCreateParams.Request["params"],
        })),
      });
      return { id: batch.id, processingStatus: batch.processing_status };
    },

    async retrieve(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      return { id: batch.id, processingStatus: batch.processing_status };
    },

    async results(batchId) {
      const entries: BatchEntry[] = [];
      // Results stream as JSONL and arrive in an arbitrary order; the caller
      // keys them by custom_id, never by position.
      for await (const raw of await client.messages.batches.results(batchId)) {
        const entry = toBatchEntry(raw as ResultLike);
        if (entry !== null) entries.push(entry);
      }
      return entries;
    },
  };
}
