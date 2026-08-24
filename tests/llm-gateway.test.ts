/**
 * LLM gateway tests. The Anthropic SDK is mocked module-wide — these tests
 * never touch the network, and no API key is required to run them.
 *
 * Coverage maps onto the hard rules in CLAUDE.md §7 and the M1 acceptance list:
 * the happy path with accounting metadata, refusal-as-a-value, sticky-routing
 * detection persisted to `llm_calls`, one schema-revalidation retry, the
 * absence of sampling parameters in every request, and the pseudonymization
 * gateway actually masking PII before egress.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, betaCreateMock, streamMock, betaStreamMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    betaCreateMock: vi.fn(),
    streamMock: vi.fn(),
    betaStreamMock: vi.fn(),
  }),
);

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createMock, stream: streamMock };
    beta = { messages: { create: betaCreateMock, stream: betaStreamMock } };
  }
  return { default: MockAnthropic };
});

import { createDb, runMigrations, type Db } from "../src/server/db";
import { egressLedger, llmCalls } from "../src/server/db/schema";
import { runStage } from "../src/server/llm";
import {
  FALLBACK_MODEL,
  MAX_NONSTREAMING_TOKENS,
  MODEL_FABLE,
  MODEL_OPUS,
  MODEL_PRICING,
  SERVER_SIDE_FALLBACK_BETA,
  computeCostUsd,
  toJsonSchemaFormat,
  translationSchema,
} from "../src/server/llm/config";
import { EGRESS_RETENTION_DAYS, sha256Hex } from "../src/server/llm/ledger";
import type { StageDescriptor } from "../src/server/llm";
import type { PersonDict } from "../src/server/pseudonym";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

// Model output, so English — but a cue quotes the original fragment verbatim,
// which is exactly what the translator prompt requires.
const VALID_OUTPUT = {
  benign: { reading: "He is just worn out today", confidence: 0.4 },
  neutral: { reading: "He is stating an arrangement", confidence: 0.4 },
  negative: { reading: "He is hinting at dissatisfaction", confidence: 0.2 },
  cues: ['the softener "而已" ("that\'s all")', "no time is mentioned"],
};

interface ResponseOverrides {
  text?: string;
  model?: string;
  stopReason?: string;
  stopDetails?: { category: string } | null;
  inputTokens?: number;
  outputTokens?: number;
  iterations?: Array<Record<string, unknown>> | null;
}

function anthropicResponse(overrides: ResponseOverrides = {}) {
  const {
    text = JSON.stringify(VALID_OUTPUT),
    model = MODEL_OPUS,
    stopReason = "end_turn",
    stopDetails = null,
    inputTokens = 1000,
    outputTokens = 500,
    iterations = null,
  } = overrides;

  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    stop_reason: stopReason,
    stop_details: stopDetails,
    content: stopReason === "refusal" ? [] : [{ type: "text", text }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations,
    },
    _request_id: "req_test",
  };
}

/** Every key name appearing anywhere in a (possibly nested) value. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function lastBody(mock: typeof createMock): Record<string, unknown> {
  const calls = mock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Fixtures for requests that never came back                                 */
/* -------------------------------------------------------------------------- */

/**
 * A stage whose budget puts it over the SDK's non-streaming ceiling, so the
 * gateway takes the streaming transport. Fable on purpose: the streamed stages
 * in this product are the judgment ones, and they are the calls that carry the
 * confirmed utterances and the assembled dossier.
 */
const STREAMED_STAGE: StageDescriptor<typeof translationSchema> = {
  name: "streamed_probe",
  model: MODEL_FABLE,
  effort: "max",
  maxTokens: MAX_NONSTREAMING_TOKENS + 1,
  zodSchema: translationSchema,
  promptTemplate:
    "You are a test stage. Answer with the agreed JSON structure and nothing else.",
  promptVersion: "streamed_probe.v1",
};

interface DeadStreamOptions {
  /** What `finalMessage()` rejects with. */
  readonly error: unknown;
  /** The half-built message the SDK had assembled when the line died. */
  readonly currentMessage?: unknown;
  readonly aborted?: boolean;
  readonly requestId?: string | null;
}

/**
 * A stream helper that accepts the request and then never finishes it — the
 * shape `MessageStream` / `BetaMessageStream` leave behind when a response dies
 * halfway: `finalMessage()` rejects, `currentMessage` holds however much of the
 * message had arrived, and `aborted` says whether it was cut off.
 */
function deadStream(options: DeadStreamOptions) {
  return () => ({
    aborted: options.aborted ?? false,
    request_id: options.requestId ?? null,
    currentMessage: options.currentMessage,
    finalMessage: () => Promise.reject(options.error),
  });
}

/** The SDK's abort error: no HTTP status, an `AbortError` name. */
function abortError() {
  return Object.assign(new Error("Request was aborted."), {
    name: "AbortError",
  });
}

/** A dropped connection: no status, no abort, nothing came back. */
function connectionDrop() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

/* -------------------------------------------------------------------------- */

describe("llm gateway — runStage", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    createMock.mockReset();
    betaCreateMock.mockReset();
    streamMock.mockReset();
    betaStreamMock.mockReset();
    // The SDK's own contract, so a streamed stage behaves like a non-streamed
    // one unless a test says otherwise: `finalMessage()` resolves to exactly
    // what `create` would have returned.
    streamMock.mockImplementation((params: unknown) => ({
      finalMessage: () => createMock(params),
    }));
    betaStreamMock.mockImplementation((params: unknown) => ({
      finalMessage: () => betaCreateMock(params),
    }));
  });

  afterEach(() => {
    sqlite.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Happy path                                                             */
  /* ---------------------------------------------------------------------- */

  describe("successful run", () => {
    it("returns validated data with accounting metadata", async () => {
      createMock.mockResolvedValue(anthropicResponse());

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;

      expect(result.data).toEqual(VALID_OUTPUT);
      expect(result.meta.model).toBe(MODEL_OPUS);
      expect(result.meta.effort).toBe("medium");
      expect(result.meta.fallbackUsed).toBe(false);
      // 1000 input @ $5/MTok + 500 output @ $25/MTok
      expect(result.meta.costUsd).toBeCloseTo(0.0175, 10);
      expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("sends an opus request with adaptive thinking and a json_schema format", async () => {
      createMock.mockResolvedValue(anthropicResponse());

      await runStage("translate_default", { prompt: "你自己看着办吧" }, { db });

      expect(betaCreateMock).not.toHaveBeenCalled();
      const body = lastBody(createMock);

      expect(body.model).toBe(MODEL_OPUS);
      expect(body.max_tokens).toBe(4096);
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body).not.toHaveProperty("betas");
      expect(body).not.toHaveProperty("fallbacks");

      const outputConfig = body.output_config as {
        effort: string;
        format: { type: string; schema: Record<string, unknown> };
      };
      expect(outputConfig.effort).toBe("medium");
      expect(outputConfig.format.type).toBe("json_schema");
      expect(outputConfig.format.schema.additionalProperties).toBe(false);
      expect(outputConfig.format.schema.required).toEqual(
        expect.arrayContaining(["benign", "neutral", "negative", "cues"]),
      );

      // Assistant prefill is never constructed.
      const messages = body.messages as Array<{ role: string }>;
      expect(messages.every((m) => m.role === "user")).toBe(true);
    });

    it("writes one llm_calls row and one egress_ledger row per call", async () => {
      createMock.mockResolvedValue(anthropicResponse());

      await runStage("translate_default", { prompt: "你自己看着办吧" }, { db });

      const calls = db.select().from(llmCalls).all();
      expect(calls).toHaveLength(1);
      expect(calls[0].stage).toBe("translate_default");
      expect(calls[0].provider).toBe("anthropic");
      expect(calls[0].model).toBe(MODEL_OPUS);
      expect(calls[0].effort).toBe("medium");
      expect(calls[0].promptVersion).toBe("translate.v3");
      expect(calls[0].inputTokens).toBe(1000);
      expect(calls[0].outputTokens).toBe(500);
      expect(calls[0].stopReason).toBe("end_turn");
      expect(calls[0].fallbackUsed).toBe(false);
      expect(calls[0].requestId).toBe("req_test");
      expect(calls[0].costUsd).toBeCloseTo(0.0175, 10);

      const ledger = db.select().from(egressLedger).all();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].llmCallId).toBe(calls[0].id);
      expect(ledger[0].target).toBe("anthropic");
      expect(ledger[0].model).toBe(MODEL_OPUS);

      // The recorded hash is of the exact body handed to the SDK.
      const payload = JSON.stringify(lastBody(createMock));
      expect(ledger[0].payloadSha256).toBe(sha256Hex(payload));
      expect(ledger[0].payloadBytes).toBe(Buffer.byteLength(payload, "utf8"));

      const windowMs =
        ledger[0].expiryAt.getTime() - ledger[0].createdAt.getTime();
      expect(windowMs).toBe(EGRESS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Refusal                                                                */
  /* ---------------------------------------------------------------------- */

  describe("refusal", () => {
    it("maps stop_reason refusal onto a domain result without throwing", async () => {
      createMock.mockResolvedValue(
        anthropicResponse({
          stopReason: "refusal",
          stopDetails: { category: "general_harms" },
        }),
      );

      const result = await runStage("translate_default", { prompt: "……" }, { db });

      expect(result).toEqual({ kind: "refused", category: "general_harms" });
    });

    it("still records the refused call in both audit tables", async () => {
      createMock.mockResolvedValue(
        anthropicResponse({ stopReason: "refusal", stopDetails: null }),
      );

      const result = await runStage("translate_default", { prompt: "……" }, { db });
      expect(result.kind).toBe("refused");

      const calls = db.select().from(llmCalls).all();
      expect(calls).toHaveLength(1);
      expect(calls[0].stopReason).toBe("refusal");
      expect(db.select().from(egressLedger).all()).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Sticky routing                                                         */
  /* ---------------------------------------------------------------------- */

  describe("fable stage and sticky routing", () => {
    it("attaches the fallback beta + chain and omits thinking entirely", async () => {
      betaCreateMock.mockResolvedValue(
        anthropicResponse({ model: MODEL_FABLE }),
      );

      await runStage("translate_deep", { prompt: "你自己看着办吧" }, { db });

      expect(createMock).not.toHaveBeenCalled();
      const body = lastBody(betaCreateMock);

      expect(body.model).toBe(MODEL_FABLE);
      expect(body.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
      expect(body.fallbacks).toEqual([{ model: FALLBACK_MODEL }]);
      // Fable rejects any explicit thinking configuration.
      expect(body).not.toHaveProperty("thinking");
    });

    it("detects a fallback_message iteration, prices it at opus rates and persists the flag", async () => {
      betaCreateMock.mockResolvedValue(
        anthropicResponse({
          model: FALLBACK_MODEL,
          iterations: [
            {
              type: "message",
              model: MODEL_FABLE,
              input_tokens: 1000,
              output_tokens: 0,
            },
            {
              type: "fallback_message",
              model: FALLBACK_MODEL,
              input_tokens: 1000,
              output_tokens: 500,
            },
          ],
        }),
      );

      const result = await runStage(
        "translate_deep",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.meta.fallbackUsed).toBe(true);
      expect(result.meta.model).toBe(FALLBACK_MODEL);
      // Priced at opus ($5/$25), not fable ($10/$50).
      expect(result.meta.costUsd).toBeCloseTo(0.0175, 10);

      const calls = db.select().from(llmCalls).all();
      expect(calls).toHaveLength(1);
      expect(calls[0].fallbackUsed).toBe(true);
      expect(calls[0].model).toBe(FALLBACK_MODEL);
      expect(JSON.parse(calls[0].fallbackMessage ?? "{}")).toMatchObject({
        type: "fallback_message",
        model: FALLBACK_MODEL,
      });
    });

    it("leaves fallback_used false when no fallback iteration is present", async () => {
      betaCreateMock.mockResolvedValue(
        anthropicResponse({ model: MODEL_FABLE }),
      );

      const result = await runStage(
        "translate_deep",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.meta.fallbackUsed).toBe(false);
      // Fable pricing: 1000 * $10/MTok + 500 * $50/MTok.
      expect(result.meta.costUsd).toBeCloseTo(0.035, 10);
      expect(db.select().from(llmCalls).all()[0].fallbackUsed).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Schema re-validation                                                   */
  /* ---------------------------------------------------------------------- */

  describe("schema re-validation", () => {
    it("retries once with the validation error, then returns an error result", async () => {
      createMock.mockResolvedValue(
        anthropicResponse({
          text: JSON.stringify({ benign: { reading: "x" } }),
        }),
      );

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(createMock).toHaveBeenCalledTimes(2);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("schema mismatch");

      // The retry carries the validation failure back to the model.
      const retryMessages = lastBody(createMock).messages as Array<{
        role: string;
        content: string;
      }>;
      expect(retryMessages).toHaveLength(2);
      expect(retryMessages[1].role).toBe("user");
      expect(retryMessages[1].content).toContain(
        "did not match the agreed JSON structure",
      );

      // Both attempts left the process, so both are accounted for.
      expect(db.select().from(llmCalls).all()).toHaveLength(2);
      expect(db.select().from(egressLedger).all()).toHaveLength(2);
    });

    it("recovers when the retry validates, summing the cost of both attempts", async () => {
      createMock
        .mockResolvedValueOnce(anthropicResponse({ text: "not json at all" }))
        .mockResolvedValueOnce(anthropicResponse());

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.data).toEqual(VALID_OUTPUT);
      expect(result.meta.costUsd).toBeCloseTo(0.035, 10);
      expect(db.select().from(llmCalls).all()).toHaveLength(2);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Sampling parameters                                                    */
  /* ---------------------------------------------------------------------- */

  it("never puts temperature / top_p / top_k in a request payload", async () => {
    createMock.mockResolvedValue(anthropicResponse());
    betaCreateMock.mockResolvedValue(anthropicResponse({ model: MODEL_FABLE }));

    await runStage("translate_default", { prompt: "你自己看着办吧" }, { db });
    await runStage("translate_deep", { prompt: "你自己看着办吧" }, { db });

    const bodies = [...createMock.mock.calls, ...betaCreateMock.mock.calls].map(
      (call) => call[0] as unknown,
    );
    expect(bodies).toHaveLength(2);

    for (const body of bodies) {
      const keys = collectKeys(body);
      expect(keys).not.toContain("temperature");
      expect(keys).not.toContain("top_p");
      expect(keys).not.toContain("top_k");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("temperature");
      expect(serialized).not.toContain("top_p");
      expect(serialized).not.toContain("top_k");
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Pseudonymization gateway                                               */
  /* ---------------------------------------------------------------------- */

  describe("pseudonymization gateway", () => {
    const DICT: PersonDict = [
      { canonical: "知夏", pseudonym: "甲", variants: ["夏夏"] },
    ];

    it("replaces PII and real names before the payload leaves the process", async () => {
      createMock.mockResolvedValue(anthropicResponse());

      await runStage(
        "translate_default",
        {
          prompt: "夏夏说：有事打我手机 13800138000，或者发 a@b.com。",
          dict: DICT,
        },
        { db },
      );

      const serialized = JSON.stringify(lastBody(createMock));
      expect(serialized).not.toContain("13800138000");
      expect(serialized).not.toContain("a@b.com");
      expect(serialized).not.toContain("知夏");
      expect(serialized).not.toContain("夏夏");
      expect(serialized).toContain("{{PHONE_1}}");
      expect(serialized).toContain("{{EMAIL_1}}");
      expect(serialized).toContain("甲说");
    });

    it("scrubs PII even when the person dictionary is empty", async () => {
      createMock.mockResolvedValue(anthropicResponse());

      await runStage("translate_default", { prompt: "打 13800138000 给我" }, { db });

      const serialized = JSON.stringify(lastBody(createMock));
      expect(serialized).not.toContain("13800138000");
      expect(serialized).toContain("{{PHONE_1}}");
    });

    it("restores pseudonyms and placeholders in the returned data", async () => {
      createMock.mockResolvedValue(
        anthropicResponse({
          text: JSON.stringify({
            ...VALID_OUTPUT,
            benign: {
              reading: "甲 just wants you to call {{PHONE_1}}",
              confidence: 0.5,
            },
          }),
        }),
      );

      const result = await runStage(
        "translate_default",
        { prompt: "知夏说：打 13800138000 给我", dict: DICT },
        { db },
      );

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.data.benign.reading).toBe(
        "知夏 just wants you to call 13800138000",
      );
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Input and transport failures                                           */
  /* ---------------------------------------------------------------------- */

  describe("failure paths", () => {
    it("rejects an empty input without calling the provider", async () => {
      const result = await runStage("translate_default", {}, { db });

      expect(result).toEqual({
        kind: "error",
        retryable: false,
        message:
          "stage input requires either `prompt` or a non-empty `messages`",
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("rejects a trailing assistant turn (no prefill)", async () => {
      const result = await runStage(
        "translate_default",
        {
          messages: [
            { role: "user", text: "你自己看着办吧" },
            { role: "assistant", text: '{"benign":' },
          ],
        },
        { db },
      );

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("prefill");
      expect(createMock).not.toHaveBeenCalled();
    });

    it("classifies a 429 as retryable and a 400 as not", async () => {
      createMock.mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { status: 429 }),
      );
      const rateLimited = await runStage(
        "translate_default",
        { prompt: "x" },
        { db },
      );
      expect(rateLimited).toMatchObject({ kind: "error", retryable: true });

      createMock.mockRejectedValueOnce(
        Object.assign(new Error("bad request"), { status: 400 }),
      );
      const badRequest = await runStage(
        "translate_default",
        { prompt: "x" },
        { db },
      );
      expect(badRequest).toMatchObject({ kind: "error", retryable: false });
    });

    it("reports a truncated response instead of parsing it", async () => {
      createMock.mockResolvedValue(
        anthropicResponse({ stopReason: "max_tokens", text: '{"benign"' }),
      );

      const result = await runStage(
        "translate_default",
        { prompt: "x" },
        { db },
      );

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("max_tokens");
      // The truncated attempt is still an egress event.
      expect(db.select().from(egressLedger).all()).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Requests that never came back                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Bytes that left the process always produce both audit rows (HARD RULE #7).
   *
   * The audit used to be written after the response was awaited, so a call that
   * timed out, was aborted or lost its connection wrote nothing at all — and on
   * this path "nothing" means the confirmed utterances, the assembled dossier
   * and the quoted evidence were on the wire with no record that they had ever
   * left. Under-reporting the privacy surface is the failure that matters here,
   * so the rows are written from the failure path too, hashed from what was
   * sent rather than from what came back.
   */
  describe("a request that never came back", () => {
    it("writes both rows when the call is aborted mid-flight", async () => {
      createMock.mockRejectedValue(abortError());

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("error");

      const calls = db.select().from(llmCalls).all();
      expect(calls).toHaveLength(1);
      expect(calls[0].stage).toBe("translate_default");
      expect(calls[0].provider).toBe("anthropic");
      expect(calls[0].model).toBe(MODEL_OPUS);
      expect(calls[0].effort).toBe("medium");
      expect(calls[0].promptVersion).toBe("translate.v3");
      // Nothing came back, so nothing is claimed about what came back. Null is
      // "unknown"; a 0 here would read as "this call consumed nothing".
      expect(calls[0].stopReason).toBe("no_response:aborted");
      expect(calls[0].inputTokens).toBeNull();
      expect(calls[0].outputTokens).toBeNull();
      expect(calls[0].cacheReadInputTokens).toBeNull();
      expect(calls[0].cacheCreationInputTokens).toBeNull();
      expect(calls[0].costUsd).toBeNull();
      expect(calls[0].latencyMs).toBeGreaterThanOrEqual(0);

      const ledger = db.select().from(egressLedger).all();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].llmCallId).toBe(calls[0].id);
      expect(ledger[0].target).toBe("anthropic");
      // The size and the fingerprint of the exposure are known even though the
      // answer never was: this is the exact body handed to the SDK.
      const payload = JSON.stringify(lastBody(createMock));
      expect(ledger[0].payloadSha256).toBe(sha256Hex(payload));
      expect(ledger[0].payloadBytes).toBe(Buffer.byteLength(payload, "utf8"));
      expect(ledger[0].payloadBytes).toBeGreaterThan(0);
    });

    it("writes both rows when the connection drops", async () => {
      createMock.mockRejectedValue(connectionDrop());

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result).toMatchObject({ kind: "error", retryable: true });

      const calls = db.select().from(llmCalls).all();
      expect(calls).toHaveLength(1);
      // A different fact from an abort, and a reader should not have to guess.
      expect(calls[0].stopReason).toBe("no_response:transport_error");
      expect(calls[0].costUsd).toBeNull();

      const ledger = db.select().from(egressLedger).all();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].payloadSha256).toBe(
        sha256Hex(JSON.stringify(lastBody(createMock))),
      );
    });

    /**
     * The mirror image, and the reason this is not simply "write a row on every
     * throw": the SDK raises these before it builds a request, so no byte
     * reached a socket. The ledger may over-report a connection it could not
     * confirm died; it may never invent a send.
     */
    it("records nothing when the SDK refused to dispatch the request", async () => {
      createMock.mockRejectedValue(
        new Error(
          "Could not resolve authentication method. Expected one of apiKey, " +
            "authToken, credentials, config, or profile to be set.",
        ),
      );

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("error");
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(db.select().from(llmCalls).all()).toHaveLength(0);
      expect(db.select().from(egressLedger).all()).toHaveLength(0);
    });

    it("records nothing for a call refused before the provider was reached", async () => {
      const result = await runStage(
        "translate_default",
        {
          messages: [
            { role: "user", text: "你自己看着办吧" },
            { role: "assistant", text: '{"benign":' },
          ],
        },
        { db },
      );

      expect(result.kind).toBe("error");
      expect(createMock).not.toHaveBeenCalled();
      expect(db.select().from(llmCalls).all()).toHaveLength(0);
      expect(db.select().from(egressLedger).all()).toHaveLength(0);
    });

    /**
     * One logical call, two attempts, two rows — the schema-revalidation retry
     * keeps its per-attempt accounting when the retry is the attempt that dies.
     */
    it("accounts for the retry separately when the retry is the one that dies", async () => {
      createMock
        .mockResolvedValueOnce(
          anthropicResponse({ text: JSON.stringify({ benign: { reading: "x" } }) }),
        )
        .mockRejectedValueOnce(connectionDrop());

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db },
      );

      expect(result.kind).toBe("error");
      expect(createMock).toHaveBeenCalledTimes(2);

      const calls = db.select().from(llmCalls).all();
      expect(calls.map((call) => call.stopReason)).toEqual([
        "end_turn",
        "no_response:transport_error",
      ]);
      // The answered attempt keeps its own usage; the dead one claims none.
      expect(calls[0].inputTokens).toBe(1000);
      expect(calls[1].inputTokens).toBeNull();

      // Two distinct payloads: the retry carried the validation complaint back,
      // and the failure row is hashed from the payload the retry actually sent.
      const ledger = db.select().from(egressLedger).all();
      expect(ledger).toHaveLength(2);
      expect(ledger[0].payloadSha256).not.toBe(ledger[1].payloadSha256);
      expect(ledger[1].payloadSha256).toBe(
        sha256Hex(JSON.stringify(lastBody(createMock))),
      );
    });

    it("says so in the error when the audit row itself could not be written", async () => {
      createMock.mockRejectedValue(connectionDrop());
      // A database that cannot take the audit write. The call was already lost;
      // what must not happen is that the ledger gap goes unmentioned.
      const brokenDb = Object.create(db, {
        transaction: {
          value: () => {
            throw new Error("database is locked");
          },
        },
      }) as Db;

      const result = await runStage(
        "translate_default",
        { prompt: "你自己看着办吧" },
        { db: brokenDb },
      );

      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("socket hang up");
      expect(result.message).toContain("ledger write failed");
    });

    /* -------------------------------------------------------------------- */
    /* The streaming transport                                              */
    /* -------------------------------------------------------------------- */

    /**
     * A stream that dies mid-response has egressed the whole payload just the
     * same. It is also the one failure with something left to report: the SDK
     * keeps a running snapshot of the message it was assembling, so part of the
     * usage may be known even though the response is not.
     */
    describe("on the streaming transport", () => {
      it("records the pair with whatever partial usage the dead stream had", async () => {
        betaStreamMock.mockImplementation(
          deadStream({
            error: new Error("terminated"),
            currentMessage: {
              model: MODEL_FABLE,
              stop_reason: null,
              content: [
                { type: "text", text: '{"benign":{"reading":"He is just' },
              ],
              // What `message_start` and the deltas had reported by then. No
              // cache counters arrived at all.
              usage: { input_tokens: 5000, output_tokens: 120 },
            },
          }),
        );

        const result = await runStage(
          STREAMED_STAGE,
          { prompt: "你自己看着办吧" },
          { db },
        );

        expect(result.kind).toBe("error");
        // It took the streaming transport, not `create`.
        expect(betaStreamMock).toHaveBeenCalledTimes(1);
        expect(betaCreateMock).not.toHaveBeenCalled();

        const calls = db.select().from(llmCalls).all();
        expect(calls).toHaveLength(1);
        expect(calls[0].stage).toBe("streamed_probe");
        expect(calls[0].model).toBe(MODEL_FABLE);
        expect(calls[0].stopReason).toBe("no_response:transport_error");
        // What the half-built message did report is recorded as what it is…
        expect(calls[0].inputTokens).toBe(5000);
        expect(calls[0].outputTokens).toBe(120);
        // …and what it never reported stays unknown.
        expect(calls[0].cacheReadInputTokens).toBeNull();
        expect(calls[0].cacheCreationInputTokens).toBeNull();
        // Partial counts are not a bill, so they are not priced as one.
        expect(calls[0].costUsd).toBeNull();

        const ledger = db.select().from(egressLedger).all();
        expect(ledger).toHaveLength(1);
        expect(ledger[0].llmCallId).toBe(calls[0].id);
        const payload = JSON.stringify(lastBody(betaStreamMock));
        expect(ledger[0].payloadSha256).toBe(sha256Hex(payload));
        expect(ledger[0].payloadBytes).toBe(Buffer.byteLength(payload, "utf8"));
      });

      it("calls a dead stream aborted when the stream says it was", async () => {
        betaStreamMock.mockImplementation(
          deadStream({
            error: new Error("Request was aborted."),
            aborted: true,
            requestId: "req_streamed",
          }),
        );

        const result = await runStage(STREAMED_STAGE, { prompt: "x" }, { db });

        expect(result.kind).toBe("error");
        const calls = db.select().from(llmCalls).all();
        expect(calls).toHaveLength(1);
        expect(calls[0].stopReason).toBe("no_response:aborted");
        // Nothing was assembled, so nothing is claimed — but the request id the
        // stream did get is worth keeping for a vendor-side follow-up.
        expect(calls[0].requestId).toBe("req_streamed");
        expect(calls[0].inputTokens).toBeNull();
        expect(db.select().from(egressLedger).all()).toHaveLength(1);
      });

      /** Sticky routing is still detected on a stream that died. */
      it("records the fallback the dead stream had already reported", async () => {
        betaStreamMock.mockImplementation(
          deadStream({
            error: connectionDrop(),
            currentMessage: {
              model: FALLBACK_MODEL,
              usage: {
                input_tokens: 800,
                iterations: [
                  { type: "fallback_message", model: FALLBACK_MODEL },
                ],
              },
            },
          }),
        );

        const result = await runStage(STREAMED_STAGE, { prompt: "x" }, { db });

        expect(result.kind).toBe("error");
        const calls = db.select().from(llmCalls).all();
        expect(calls).toHaveLength(1);
        expect(calls[0].fallbackUsed).toBe(true);
        expect(calls[0].model).toBe(FALLBACK_MODEL);
        expect(JSON.parse(calls[0].fallbackMessage ?? "{}")).toMatchObject({
          type: "fallback_message",
          model: FALLBACK_MODEL,
        });
        expect(calls[0].inputTokens).toBe(800);
        expect(calls[0].outputTokens).toBeNull();
      });

      it("still returns the answer when the stream completes", async () => {
        betaCreateMock.mockResolvedValue(
          anthropicResponse({ model: MODEL_FABLE }),
        );

        const result = await runStage(
          STREAMED_STAGE,
          { prompt: "你自己看着办吧" },
          { db },
        );

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.data).toEqual(VALID_OUTPUT);
        const calls = db.select().from(llmCalls).all();
        expect(calls).toHaveLength(1);
        expect(calls[0].stopReason).toBe("end_turn");
        expect(calls[0].inputTokens).toBe(1000);
      });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Price list and schema conversion                                           */
/* -------------------------------------------------------------------------- */

describe("computeCostUsd", () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  it("prices fable at 10/50 and opus at 5/25 per MTok", () => {
    expect(computeCostUsd(MODEL_FABLE, usage)).toBeCloseTo(60, 10);
    expect(computeCostUsd(MODEL_OPUS, usage)).toBeCloseTo(30, 10);
  });

  it("applies the cache multipliers (read 0.1x, write 1.25x / 2x)", () => {
    const cached = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    // opus input is $5/MTok: 1M read @0.1x + 1M write @1.25x = 0.5 + 6.25
    expect(computeCostUsd(MODEL_OPUS, cached)).toBeCloseTo(6.75, 10);
    // Same, with the 1-hour write multiplier: 0.5 + 10
    expect(computeCostUsd(MODEL_OPUS, cached, "1h")).toBeCloseTo(10.5, 10);
  });

  it("returns null rather than guessing for an unpriced model", () => {
    expect(computeCostUsd("claude-unknown-9", usage)).toBeNull();
  });

  /**
   * The price list is one vendor again.
   *
   * Six gpt-* entries were removed with the polish layer (doc 02 §1.1a). This
   * asserts they are actually gone rather than merely uncalled: a price list
   * that still quotes a vendor the product cannot reach invites someone to
   * conclude the path still exists. The archived `llm_calls` rows keep the
   * `cost_usd` they were written with — cost is priced at the moment of the
   * call and never recomputed — so removing the rates does not rewrite history.
   */
  it("prices Anthropic models only, and nothing else", () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual(
      [MODEL_FABLE, MODEL_OPUS].sort(),
    );
    for (const model of ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o", "gpt-5"]) {
      expect(computeCostUsd(model, usage)).toBeNull();
    }
  });
});

describe("toJsonSchemaFormat", () => {
  it("closes every object and keeps the three required readings", () => {
    const { type, schema } = toJsonSchemaFormat(translationSchema);

    expect(type).toBe("json_schema");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["benign", "neutral", "negative", "cues"]),
    );

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const reading of ["benign", "neutral", "negative"]) {
      // Inline (not collapsed into a shared $ref), so each keeps its label.
      expect(properties[reading].type).toBe("object");
      expect(properties[reading].description).toBeTypeOf("string");
      expect(properties[reading].additionalProperties).toBe(false);
      expect(properties[reading].required).toEqual(
        expect.arrayContaining(["reading", "confidence"]),
      );
    }

    // The JSON Schema dialect marker never leaks into the egress payload.
    expect(JSON.stringify(schema)).not.toContain("$schema");
  });
});
