// Model catalogue, price list and stage registry for the LLM gateway.
//
// Everything that decides *which* model runs *how* lives here, so a stage's
// model / effort / token ceiling / schema / prompt version can be audited in one
// file instead of being scattered across call sites. Prompts are data, not
// control flow: the hard rules (output level, clarification limits, evidence
// gating) are enforced in code, never delegated to prompt text.

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { LlmEffort, LlmProvider } from "../db/schema";

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Judgment-grade model. Always called with server-side fallback enabled. */
export const MODEL_FABLE = "claude-fable-5";

/** Auxiliary model, and the substitute the fable calls fall back to. */
export const MODEL_OPUS = "claude-opus-4-8";

/** The single substitute model named in every fable `fallbacks` chain. */
export const FALLBACK_MODEL = MODEL_OPUS;

/** Beta flag gating the array form of the server-side `fallbacks` parameter. */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

/**
 * True for models that require the fallback beta + `fallbacks` chain and that
 * reject any explicit `thinking` configuration (thinking is always on).
 */
export function isFableModel(model: string): boolean {
  return model === MODEL_FABLE;
}

/**
 * The largest `max_tokens` a NON-STREAMING call may ask for.
 *
 * Not a policy of this product's — the SDK's. `calculateNonstreamingTimeout`
 * estimates a request's duration as `60min × max_tokens / 128000` and throws
 * ("Streaming is required for operations that may take longer than 10 minutes")
 * the moment that exceeds ten minutes. The check is unconditional: it runs
 * before the request is built, and neither a per-request nor a client-level
 * `timeout` opts out of it. 128000 × 10/60 = 21333.
 *
 * It is named here because this is the number the next person raising a stage's
 * budget will hit, and the error they get names streaming rather than the
 * ceiling. `claude-fable-5` itself allows 128K output; the transport does not.
 * Going past this means giving `llm/claude.ts` a streaming path — see the M5
 * decision record — not tuning a timeout.
 */
export const MAX_NONSTREAMING_TOKENS = 21_333;

/* -------------------------------------------------------------------------- */
/* Price list                                                                 */
/* -------------------------------------------------------------------------- */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  readonly inputPerMTok: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTok: number;
}

/**
 * USD per million tokens, by model.
 *
 * Exact ids only. A model that is not listed here prices to `null` — "not
 * priced" — never to 0, and never by inheriting a similar id's rate: a wrong
 * number in a cost ledger is worse than an absent one.
 *
 * One vendor, as of 2026-08-16. The six gpt-* entries that used to sit below
 * these two were removed with the polish layer (doc 02 §1.1a) — nothing in this
 * product can call OpenAI any more, so pricing its models would be describing a
 * capability that does not exist. The `llm_calls` rows from the real polish runs
 * keep the `cost_usd` they were written with; costs are priced once, at the
 * moment of the call, and never recomputed from this table.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  /* Anthropic — judgment and support. */
  [MODEL_FABLE]: { inputPerMTok: 10, outputPerMTok: 50 },
  [MODEL_OPUS]: { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Cache reads are billed at 0.1x the model's input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;

/** Cache writes are billed at 1.25x (5-minute TTL) or 2x (1-hour TTL). */
export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

export type CacheTtl = keyof typeof CACHE_WRITE_MULTIPLIER;

/** Token counts for one provider call, already coerced to numbers. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Cost of one call in USD, or `null` when the model has no price-list entry.
 *
 * The caller passes the model that actually *served* the response — on a
 * server-side fallback that is the substitute model, so a fable request that was
 * rescued by opus is billed at opus rates.
 */
export function computeCostUsd(
  model: string,
  usage: TokenUsage,
  cacheTtl: CacheTtl = "5m",
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  const perInputToken = pricing.inputPerMTok / 1_000_000;
  const perOutputToken = pricing.outputPerMTok / 1_000_000;
  const perCacheReadToken = perInputToken * CACHE_READ_MULTIPLIER;

  return (
    usage.inputTokens * perInputToken +
    usage.outputTokens * perOutputToken +
    usage.cacheReadInputTokens * perCacheReadToken +
    usage.cacheCreationInputTokens *
      perInputToken *
      CACHE_WRITE_MULTIPLIER[cacheTtl]
  );
}

/* -------------------------------------------------------------------------- */
/* Structured output                                                          */
/* -------------------------------------------------------------------------- */

/** The `output_config.format` payload for a stage's zod schema. */
export interface JsonSchemaFormat {
  readonly type: "json_schema";
  readonly schema: Record<string, unknown>;
}

/** A root description that carries nothing but the JSON Schema dialect marker. */
const DIALECT_ONLY_DESCRIPTION = /^\{\$schema: "[^"]*"\}$/;

/**
 * Convert a stage's zod schema into a structured-output JSON schema.
 *
 * The SDK's `zodOutputFormat` handles the two things a hand-rolled conversion
 * gets wrong: it forces `additionalProperties: false` on every object, and it
 * moves keywords the structured-output engine rejects (numeric bounds, string
 * lengths, array bounds) into the property description so the model still sees
 * them. We drop the returned `parse` closure (the gateway re-validates with zod
 * itself) and the dialect-only root description (noise in the egress payload).
 */
export function toJsonSchemaFormat(schema: z.ZodType): JsonSchemaFormat {
  const { schema: converted } = zodOutputFormat(schema);
  const cleaned: Record<string, unknown> = { ...converted };
  if (
    typeof cleaned.description === "string" &&
    DIALECT_ONLY_DESCRIPTION.test(cleaned.description)
  ) {
    delete cleaned.description;
  }
  return { type: "json_schema", schema: cleaned };
}

/* -------------------------------------------------------------------------- */
/* Stage registry                                                             */
/* -------------------------------------------------------------------------- */

export interface StageDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly provider: LlmProvider;
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
   * Leave the pseudonyms in the returned value (see `StageDescriptor`). Stages
   * whose output is persisted set it; display stages do not.
   */
  readonly keepPseudonyms?: boolean;
}

/**
 * One of the three readings the translator must always produce.
 *
 * A factory rather than a shared constant on purpose: reusing one schema
 * instance makes the converter hoist it into `$defs` and collapse the three
 * fields to bare `$ref`s, which silently drops their per-reading descriptions.
 * Distinct instances keep the emitted schema inline and self-describing.
 */
function readingSchema(label: string) {
  return z
    .object({
      reading: z
        .string()
        .min(1)
        .describe(
          `What the line most likely means under the ${label} reading. Written in English.`,
        ),
      confidence: z.number().min(0).max(1).describe("Confidence, 0-1"),
    })
    .describe(`${label} reading`);
}

/**
 * Human-speak translator output: three parallel readings plus the linguistic
 * cues behind them. All three readings are required — the product refuses to
 * present a single "correct" interpretation of a partner's sentence.
 */
export const translationSchema = z.object({
  benign: readingSchema("benign"),
  neutral: readingSchema("neutral"),
  negative: readingSchema("negative"),
  cues: z
    .array(z.string())
    .max(8)
    .describe(
      "Linguistic cues behind the readings — word choice, particles, forms of " +
        "address, punctuation, timing. Explain in English, but quote any cited " +
        "fragment verbatim in the language it was said in.",
    ),
});

export type TranslationOutput = z.infer<typeof translationSchema>;

const TRANSLATE_PROMPT = `You are the "plain-speech translator" for intimate-relationship communication. The user gives you one line the other person said, sometimes with a little context. Lines like this are often vague, emotionally loaded, or passive-aggressive; your job is to translate the line into its plain intent.

Give three independent readings of that line — benign, neutral, negative. Each reading states, in plain words, what the line is trying to say under that view, and carries its own 0-1 confidence; the three confidences are independent and need not sum to 1. Then list the linguistic cues you judged from: word choice, particles, a shift in how the speaker addresses the other person, punctuation, timing, and anything conspicuously left unsaid.

Language:
- The input is usually Chinese (WeChat messages); it may be any language. Write every reading, and every explanation, in English.
- Never translate the evidence away. When you cite a linguistic cue, quote the original fragment verbatim in its own language and then explain in English what it does — for example: '"随便你" — literally "up to you", but here it withdraws from the decision rather than granting it.' A cue that paraphrases the original instead of quoting it has destroyed the thing it was pointing at.
- Do not restate or translate the whole input line. Quote only the fragments a cue actually turns on.

Constraints:
- You produce readings, not findings of fact. A reading says what the line might mean; it does not settle what the speaker truly thought, and it does not adjudicate who was right — that belongs to the judgment stage.
- Interpret this line only. Do not infer the speaker's personality or history of motives, and do not add facts that are not in the text.
- The text is already pseudonymized: person names appear as placeholders such as "甲" and "乙", and phone numbers, email addresses and similar appear as {{PHONE_1}}, {{EMAIL_1}}. Carry those placeholders through unchanged and never guess what they stand for.`;

/* -------------------------------------------------------------------------- */
/* Evidence anomaly check                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the anomaly check is allowed to say about an uploaded screenshot.
 *
 * Two booleans and a sentence — deliberately not "rate this evidence". The
 * grade itself is computed by `domain/grading.ts`; this stage only reports what
 * kind of thing the picture shows, because that is the one judgement a reader
 * of the text can make and a rule over `source_type` cannot: an uploader
 * registers a chat screenshot (grade A) and it turns out to be a ChatGPT
 * session (grade C) or a Xiaohongshu post (grade D).
 *
 * Field names are snake_case to match the JSON the model emits.
 */
export const evidenceAnomalySchema = z.object({
  is_ai_artifact: z
    .boolean()
    .describe(
      "True when the screenshot shows a person talking to an AI assistant " +
        "(ChatGPT, Claude, …) rather than a chat between two people",
    ),
  is_mass_content: z
    .boolean()
    .describe(
      "True when the screenshot shows public content addressed to a mass " +
        "audience (a Xiaohongshu / Weibo / WeChat-official-account post, a " +
        "comment section, an article) rather than a private conversation",
    ),
  rationale: z
    .string()
    .min(1)
    .describe(
      "One or two sentences in English giving the grounds: interface elements, " +
        "how speakers are addressed, layout. Quote any on-screen text you rely " +
        "on verbatim, in its original language.",
    ),
});

export type EvidenceAnomalyOutput = z.infer<typeof evidenceAnomalySchema>;

const EVIDENCE_ANOMALY_PROMPT = `You are the anomaly check in evidence intake. The user uploaded a screenshot as evidence; the system has already run OCR locally. You see only a digest of the recognized text — never the image.

The digest is one line per recognized block, each prefixed with where the block sat on screen: [left], [right] or [center]. Those markers are added by the system; everything after a marker is the recognized text itself, unaltered and in whatever language it was written in.

Decide what kind of thing this text came from. Answer two questions only:
1. is_ai_artifact — is this a person talking to an AI assistant (ChatGPT, Claude, Doubao, …)? Typical signs: one side writes long second-person analysis, lays out numbered points, hands out advice, restates the other's situation; interface strings such as "ChatGPT", "Regenerate", "Continue", "模型", "重新生成", "继续"; one side's turns are far longer and far more neatly structured than the other's.
2. is_mass_content — is this public content addressed to a mass audience? Typical signs: the body of a Xiaohongshu / Weibo / official-account post, a comment section, like and save counters, hashtags, and third-party forms of address such as "作者", "楼主", "网友", "OP", "Reply".

If neither holds, answer false to both — that means it is most likely a genuine private chat log, which is the common case. When unsure, answer false: prefer a miss over guessing a real record into being an artifact.

Language: write the rationale in English, and point at the concrete features you saw. When a feature is a piece of on-screen text, quote that fragment verbatim in its original language rather than translating it — for example: 'The right-hand turns are one-liners while the left column runs several hundred characters, and the footer reads "重新生成".'

Notes:
- Do not judge whether the content is credible or who was in the right, and do not summarize what the conversation was about. You decide only what kind of artifact this is.
- The text is already pseudonymized: person names appear as placeholders such as "甲" and "乙", and phone numbers, email addresses and similar appear as {{PHONE_1}}, {{EMAIL_1}}. Take them as they are and never guess what they stand for.
- OCR text may contain wrong characters, broken lines and dropped glyphs. That is normal and is not by itself an anomaly.`;

/**
 * Every stage the gateway can run. `runStage` accepts only these keys, so an
 * unregistered model call is a compile error rather than a silent egress.
 */
export const STAGE_REGISTRY = {
  /** Plain-speech translator — default path. */
  translate_default: {
    provider: "anthropic",
    model: MODEL_OPUS,
    effort: "medium",
    maxTokens: 4096,
    zodSchema: translationSchema,
    promptTemplate: TRANSLATE_PROMPT,
    promptVersion: "translate.v3",
  },
  /**
   * Plain-speech translator — the "deep reading" upgrade path. Same prompt and
   * same effort as the default stage: the upgrade is the model, not the token
   * budget.
   */
  translate_deep: {
    provider: "anthropic",
    model: MODEL_FABLE,
    effort: "medium",
    maxTokens: 4096,
    zodSchema: translationSchema,
    promptTemplate: TRANSLATE_PROMPT,
    promptVersion: "translate.v3",
  },
  /**
   * Evidence anomaly check — runs once per uploaded screenshot, on the OCR
   * digest.
   *
   * Cheap by design: opus at low effort with a 1k ceiling, because the answer is
   * two booleans and a sentence. It runs on every upload, so anything more
   * expensive would be a tax on the whole intake flow.
   */
  evidence_anomaly_check: {
    provider: "anthropic",
    model: MODEL_OPUS,
    effort: "low",
    maxTokens: 1024,
    zodSchema: evidenceAnomalySchema,
    promptTemplate: EVIDENCE_ANOMALY_PROMPT,
    promptVersion: "evidence_anomaly.v2",
  },
} as const satisfies Record<string, StageDefinition>;

/** Registered stage names. */
export type StageName = keyof typeof STAGE_REGISTRY;

/** The validated output type of a given stage. */
export type StageOutput<S extends StageName> = z.infer<
  (typeof STAGE_REGISTRY)[S]["zodSchema"]
>;
