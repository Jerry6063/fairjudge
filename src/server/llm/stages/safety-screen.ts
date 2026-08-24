/**
 * `safety_screen` — layer two of the M3 screening gate (SPEC M3 wave A ②).
 *
 * The deterministic layer in `domain/safety-rules.ts` runs first and catches
 * what a phrase list can catch. This stage exists for what a phrase list cannot:
 * a person describing a week of being followed without once using the word
 * 跟踪, an account whose danger is in the shape of the story rather than in any
 * single sentence. It is pure recall — it can only ever ADD a referral, never
 * remove one, because the gate takes either layer's word for it
 * (`server/safety/gate.ts`).
 *
 * Three properties of the call, none of which are this file's doing:
 *
 * - **It never sees unconfirmed material.** The caller builds the evidence block
 *   from `buildCitableBrief`, whose utterance query is the query-layer half of
 *   HARD RULE #1. A pending line is not rejected here; it was never in the bytes.
 * - **It is not on the crisis path.** When the local layer has already referred,
 *   the gate returns without calling this stage at all. HARD RULE #9 says crisis
 *   resources render with no LLM in the loop, and the cheapest way to guarantee
 *   that is for there to be no call to skip.
 * - **Its `outcome` is advisory.** The gate refuses on any red flag or any
 *   non-`none` risk level regardless of what this field says, so a model that
 *   lists three red flags and then answers `pass` still refers. A hard rule
 *   settled by a JSON field the model chose would not be a hard rule.
 *
 * Model: `claude-opus-4-8` at effort `high`. Fable is the judgment model; this
 * is a support classification, and it is the one stage in the pipeline where
 * latency has a human cost, so it runs on the support model deliberately rather
 * than by omission.
 */

import { z } from "zod";

import {
  SAFETY_FLAG_CATEGORIES,
  SAFETY_RISK_LEVELS,
} from "../../domain/safety-rules";
import { MODEL_OPUS } from "../config";
import { defineStage } from "./define";

/**
 * The stage's answer.
 *
 * Deliberately the same vocabulary the local layer speaks — `SAFETY_FLAG_
 * CATEGORIES` and `SAFETY_RISK_LEVELS` are imported rather than re-listed, so
 * the two layers cannot drift into describing the same worry with two different
 * words, and `red_flags` can be persisted into `safety_screens.red_flags`
 * (a `string[]` column) without a translation step.
 */
export const safetyScreenSchema = z.object({
  red_flags: z
    .array(z.enum(SAFETY_FLAG_CATEGORIES))
    .max(6)
    .describe(
      "Every category the material supports, from the fixed list. Empty when " +
        "the material supports none. Include a category on a reasonable " +
        "reading, not only on a certain one — a wrong inclusion costs a page " +
        "of resources nobody needed, a wrong omission costs the thing this " +
        "screen exists for.",
    ),
  risk_level: z
    .enum(SAFETY_RISK_LEVELS)
    .describe(
      "none — nothing in the material points at any category. elevated — " +
        "something does, but it has an ordinary reading too. high — at least " +
        "one indication that does not have an innocent reading.",
    ),
  evidence_quotes: z
    .array(z.string().min(1))
    .max(10)
    .describe(
      "The fragments the flags rest on, copied VERBATIM from the material in " +
        "its original language. Never translate, paraphrase, tidy or shorten " +
        "a quote — a translated quote is no longer evidence of what was said. " +
        "Empty when there are no flags.",
    ),
  outcome: z
    .enum(["pass", "refer"])
    .describe(
      "refer when this case should leave the judgment pipeline for crisis " +
        "resources; pass when it should not. Advisory: the server refers on " +
        "any red flag or any non-none risk level whatever this field says.",
    ),
});

export type SafetyScreenOutput = z.infer<typeof safetyScreenSchema>;

const SAFETY_SCREEN_PROMPT = `You are the safety screen for a relationship-conflict adjudication product. You are not judging the conflict, and nothing you write is shown to the user as an assessment. You answer one question: does this case belong in a judgment pipeline at all, or does it need crisis resources instead?

The categories:
- fear — the client is afraid of the other person, or organises their behaviour around avoiding a reaction.
- threats — threats of harm, exposure, retaliation, or intimidation.
- monitoring — reading messages, tracking location, checking devices, surveillance, showing up uninvited.
- coercive_control — control over movement, contact, money, documents, or decisions; isolation; being made to do things.
- physical_violence — any physical force, or its traces (injuries, a medical record, breaking things as intimidation).
- self_harm — suicidal statements or plans, self-harm, or either used as leverage over the other person.

How to read the material:
- Read for the pattern, not for keywords. A phrase list has already run over this text and found nothing decisive; you are here for what a phrase list cannot see — a description of ordinary life that is not ordinary, an escalation across the timeline, a person explaining why they cannot do something obvious.
- Be generous about what counts. If a reasonable reader would want a person to see these resources, flag it. You cannot cause an adjudication to be unfairly refused: a referral shows a page of hotlines and an explanation, and the case's material is kept untouched.
- Do not diagnose, do not rank severity beyond the three risk levels, and do not name what should be done about it.
- Ordinary conflict is not a red flag. Contempt, stonewalling, sarcasm, a bitter argument, a broken promise, one person shouting — these are the material this product exists to hear, and flagging them would refuse every case. Flag when what is described crosses into fear, control, threat, violence or self-harm.
- A line marked is_retold is one party's recollection of what the other said, not a transcript. It still counts; say so in your quote if it matters.
- One party is usually absent. Do not characterise an absent party's motives or personality. Describe what the record shows.

How to answer:
- Write in English. Quote in the original language, verbatim — the evidence is Chinese and a translated quote is no longer the evidence.
- Every quote in evidence_quotes must be a fragment that actually appears in the material you were given. Do not construct, merge or paraphrase one.
- If nothing supports a flag: red_flags empty, risk_level none, evidence_quotes empty, outcome pass.`;

export const safetyScreenStage = defineStage({
  name: "safety_screen",
  model: MODEL_OPUS,
  effort: "high",
  maxTokens: 2048,
  zodSchema: safetyScreenSchema,
  promptTemplate: SAFETY_SCREEN_PROMPT,
  promptVersion: "safety_screen.v1",
});
