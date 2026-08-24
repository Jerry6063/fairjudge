/**
 * Inline stage descriptors (M3).
 *
 * M3's stages live in `src/server/llm/stages/*` instead of the registry in
 * `config.ts`, so they reach `runStage` as values rather than as keys. The point
 * of these tests is that this changes WHERE a stage is declared and nothing
 * else: an inline stage gets the same gateway guarantees a registered one gets —
 * the fallback beta and `fallbacks` chain on fable with no `thinking` key, the
 * refusal check before any content is read, sticky-routing detection, a
 * pseudonymized payload, and one `llm_calls` + `egress_ledger` pair per attempt
 * (HARD RULES #3 and #7).
 *
 * The Anthropic SDK is mocked module-wide; nothing here touches the network.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createMock, betaCreateMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  betaCreateMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createMock };
    beta = { messages: { create: betaCreateMock } };
  }
  return { default: MockAnthropic };
});

import { createDb, runMigrations, type Db } from "../src/server/db";
import { egressLedger, llmCalls } from "../src/server/db/schema";
import { defineStage, runStage } from "../src/server/llm";
import {
  FALLBACK_MODEL,
  MODEL_FABLE,
  MODEL_OPUS,
  SERVER_SIDE_FALLBACK_BETA,
} from "../src/server/llm/config";
import type { StageDescriptor } from "../src/server/llm";
import type { PersonDict } from "../src/server/pseudonym";

/* -------------------------------------------------------------------------- */
/* A stage declared the way an M3 stage module declares one                    */
/* -------------------------------------------------------------------------- */

const probeSchema = z.object({
  verdict: z.string().min(1).describe("One sentence, in English."),
  confidence: z.number().min(0).max(1),
});

/**
 * Stand-in for a real M3 stage. It is a fable stage on purpose: fable is the
 * model with the extra request contract, so it is the one worth proving.
 */
const probeStage = defineStage({
  name: "m3_probe",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 2048,
  zodSchema: probeSchema,
  promptTemplate:
    "You are a test stage. Answer with the agreed JSON structure and nothing " +
    "else. Write in English; quote any evidence fragment verbatim in its own " +
    "language.",
  promptVersion: "m3_probe.v1",
});

const VALID_OUTPUT = { verdict: "Nothing conclusive here", confidence: 0.5 };

interface ResponseOverrides {
  text?: string;
  model?: string;
  stopReason?: string;
  stopDetails?: { category: string } | null;
  iterations?: Array<Record<string, unknown>> | null;
}

function anthropicResponse(overrides: ResponseOverrides = {}) {
  const {
    text = JSON.stringify(VALID_OUTPUT),
    model = MODEL_FABLE,
    stopReason = "end_turn",
    stopDetails = null,
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
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations,
    },
    _request_id: "req_test",
  };
}

function lastBody(mock: typeof createMock): Record<string, unknown> {
  const calls = mock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */

describe("runStage with an inline stage descriptor", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    createMock.mockReset();
    betaCreateMock.mockReset();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("keeps the fable contract: fallback beta, fallbacks chain, no thinking, no sampling knobs", async () => {
    betaCreateMock.mockResolvedValue(anthropicResponse());

    const result = await runStage(probeStage, { prompt: "anything" }, { db });

    expect(result.kind).toBe("ok");
    expect(createMock).not.toHaveBeenCalled();

    const body = lastBody(betaCreateMock);
    expect(body.model).toBe(MODEL_FABLE);
    expect(body.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    expect(body.fallbacks).toEqual([{ model: FALLBACK_MODEL }]);
    expect(body).not.toHaveProperty("thinking");
    expect(body.max_tokens).toBe(2048);

    const outputConfig = body.output_config as {
      effort: string;
      format: { type: string; schema: Record<string, unknown> };
    };
    expect(outputConfig.effort).toBe("high");
    expect(outputConfig.format.type).toBe("json_schema");
    expect(outputConfig.format.schema.additionalProperties).toBe(false);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("temperature");
    expect(serialized).not.toContain("top_p");
    expect(serialized).not.toContain("top_k");
  });

  it("writes the llm_calls + egress_ledger pair under the descriptor's name", async () => {
    betaCreateMock.mockResolvedValue(anthropicResponse());

    await runStage(probeStage, { prompt: "anything" }, { db });

    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].stage).toBe("m3_probe");
    expect(calls[0].provider).toBe("anthropic");
    expect(calls[0].model).toBe(MODEL_FABLE);
    expect(calls[0].effort).toBe("high");
    expect(calls[0].promptVersion).toBe("m3_probe.v1");
    expect(calls[0].inputTokens).toBe(1000);
    expect(calls[0].outputTokens).toBe(500);
    // Fable pricing: 1000 @ $10/MTok + 500 @ $50/MTok.
    expect(calls[0].costUsd).toBeCloseTo(0.035, 10);

    const ledger = db.select().from(egressLedger).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].llmCallId).toBe(calls[0].id);
    expect(ledger[0].target).toBe("anthropic");
  });

  it("detects sticky routing on an inline stage and persists the fallback", async () => {
    betaCreateMock.mockResolvedValue(
      anthropicResponse({
        model: FALLBACK_MODEL,
        iterations: [
          { type: "message", model: MODEL_FABLE },
          { type: "fallback_message", model: FALLBACK_MODEL },
        ],
      }),
    );

    const result = await runStage(probeStage, { prompt: "anything" }, { db });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.meta.fallbackUsed).toBe(true);
    expect(result.meta.model).toBe(FALLBACK_MODEL);
    // Served by opus, so billed at opus rates ($5/$25), not fable's.
    expect(result.meta.costUsd).toBeCloseTo(0.0175, 10);

    const calls = db.select().from(llmCalls).all();
    expect(calls[0].fallbackUsed).toBe(true);
    expect(calls[0].model).toBe(FALLBACK_MODEL);
    expect(JSON.parse(calls[0].fallbackMessage ?? "{}")).toMatchObject({
      type: "fallback_message",
    });
  });

  it("returns the descriptor's own output type, validated", async () => {
    betaCreateMock.mockResolvedValue(anthropicResponse());

    const result = await runStage(probeStage, { prompt: "anything" }, { db });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Typed as z.infer<typeof probeSchema>, not unknown — this line is the test.
    expect(result.data.verdict).toBe("Nothing conclusive here");
    expect(result.data.confidence).toBeCloseTo(0.5, 10);
  });

  it("checks the refusal stop_reason before reading content, and still audits it", async () => {
    betaCreateMock.mockResolvedValue(
      anthropicResponse({
        stopReason: "refusal",
        stopDetails: { category: "general_harms" },
      }),
    );

    const result = await runStage(probeStage, { prompt: "……" }, { db });

    expect(result).toEqual({ kind: "refused", category: "general_harms" });
    expect(db.select().from(llmCalls).all()[0].stopReason).toBe("refusal");
    expect(db.select().from(egressLedger).all()).toHaveLength(1);
  });

  it("re-validates the schema and retries once, auditing both attempts", async () => {
    betaCreateMock.mockResolvedValue(
      anthropicResponse({ text: JSON.stringify({ verdict: "" }) }),
    );

    const result = await runStage(probeStage, { prompt: "anything" }, { db });

    expect(betaCreateMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("schema mismatch");
    expect(db.select().from(llmCalls).all()).toHaveLength(2);
    expect(db.select().from(egressLedger).all()).toHaveLength(2);
  });

  it("runs the pseudonymization gateway over an inline prompt template", async () => {
    betaCreateMock.mockResolvedValue(anthropicResponse());
    const dict: PersonDict = [
      { canonical: "知夏", pseudonym: "甲", variants: ["夏夏"] },
    ];

    await runStage(
      probeStage,
      { prompt: "夏夏说：有事打 13800138000。", dict },
      { db },
    );

    const serialized = JSON.stringify(lastBody(betaCreateMock));
    expect(serialized).not.toContain("知夏");
    expect(serialized).not.toContain("夏夏");
    expect(serialized).not.toContain("13800138000");
    expect(serialized).toContain("{{PHONE_1}}");
    expect(serialized).toContain("甲说");
  });

  /**
   * The default is display-oriented and a persisted stage needs the opposite.
   *
   * Found by the first real hearing, twice: the skeleton restated
   * `client_pseudonym: "乙"` exactly as the dossier gave it, the gateway
   * rewrote 乙 into "Adrian" on the way back because that is what a translator
   * card wants, and the record-basis check rejected the generation for saying
   * "Adrian" where the database says 乙. The judgment stages are stored, frozen
   * and shared as documents, so they declare `keepPseudonyms`.
   */
  describe("keepPseudonyms", () => {
    const dict: PersonDict = [
      { canonical: "知夏", pseudonym: "甲", variants: ["夏夏"] },
      { canonical: "Adrian", pseudonym: "乙", variants: [] },
    ];

    it("puts the canonical names back by default — the display contract", async () => {
      betaCreateMock.mockResolvedValue(
        anthropicResponse({
          text: JSON.stringify({ verdict: "乙 answered 甲 at 13800138000.", confidence: 0.4 }),
        }),
      );

      const result = await runStage(probeStage, { prompt: "x", dict }, { db });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.data.verdict).toBe("Adrian answered 知夏 at 13800138000.");
    });

    it("leaves 甲/乙 alone when the stage declares it, and still fills PII back in", async () => {
      betaCreateMock.mockResolvedValue(
        anthropicResponse({
          text: JSON.stringify({ verdict: "乙 answered 甲 at 13800138000.", confidence: 0.4 }),
        }),
      );

      const stored: StageDescriptor<typeof probeSchema> = {
        ...probeStage,
        keepPseudonyms: true,
      };
      const result = await runStage(stored, { prompt: "x", dict }, { db });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      // Pseudonyms survive…
      expect(result.data.verdict).toContain("乙 answered 甲");
      expect(result.data.verdict).not.toContain("Adrian");
      expect(result.data.verdict).not.toContain("知夏");
      // …and the PII placeholder is still refilled: a {{PHONE_1}} left inside a
      // verbatim quote is a hole in the evidence, not a protection.
      expect(result.data.verdict).toContain("13800138000");
    });
  });

  it("masks PII in the descriptor's own prompt template, not just in caller text", async () => {
    betaCreateMock.mockResolvedValue(anthropicResponse());

    // A stage module is ordinary source, so PII can be pasted into a prompt
    // template as easily as into a message. The gateway runs over both.
    const leaky: StageDescriptor<typeof probeSchema> = {
      ...probeStage,
      promptTemplate: `${probeStage.promptTemplate} Reach the analyst on 13800138000.`,
    };

    const result = await runStage(
      leaky,
      { prompt: "or email a@b.com instead" },
      { db },
    );

    expect(result.kind).toBe("ok");
    const body = lastBody(betaCreateMock);
    expect(body.system).not.toContain("13800138000");
    expect(body.system).toContain("{{PHONE_1}}");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("13800138000");
    expect(serialized).not.toContain("a@b.com");
    expect(serialized).toContain("{{EMAIL_1}}");
  });

  it("refuses a malformed descriptor without calling the provider", async () => {
    const nameless = await runStage(
      { ...probeStage, name: "  " },
      { prompt: "anything" },
      { db },
    );
    expect(nameless).toMatchObject({ kind: "error", retryable: false });
    if (nameless.kind === "error") {
      expect(nameless.message).toContain("non-empty `name`");
    }

    const noBudget = await runStage(
      { ...probeStage, maxTokens: 0 },
      { prompt: "anything" },
      { db },
    );
    expect(noBudget).toMatchObject({ kind: "error", retryable: false });
    if (noBudget.kind === "error") {
      expect(noBudget.message).toContain("maxTokens");
    }

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("still runs registered stages by name, on the non-beta endpoint", async () => {
    createMock.mockResolvedValue(
      anthropicResponse({
        model: MODEL_OPUS,
        text: JSON.stringify({
          benign: { reading: "a", confidence: 0.3 },
          neutral: { reading: "b", confidence: 0.4 },
          negative: { reading: "c", confidence: 0.3 },
          cues: [],
        }),
      }),
    );

    const result = await runStage(
      "translate_default",
      { prompt: "你自己看着办吧" },
      { db },
    );

    expect(result.kind).toBe("ok");
    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(lastBody(createMock).thinking).toEqual({ type: "adaptive" });
    expect(db.select().from(llmCalls).all()[0].stage).toBe("translate_default");
  });
});
