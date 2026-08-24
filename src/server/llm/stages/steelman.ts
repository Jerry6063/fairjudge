/**
 * `steelman` — the strongest honest version of the other person's case.
 *
 * Fable at high effort. This is the stage that decides whether the pipeline is
 * an adjudicator or a very articulate friend: only one party's material exists,
 * so unless something in the process argues the other side properly, every
 * later stage inherits a one-sided frame and dresses it up as a finding.
 *
 * Two things are enforced in code around this stage rather than in the text
 * below:
 *   - every `grounded_in` ref is resolved against the case file's handle table
 *     before anything is persisted, and an unknown ref rejects the whole
 *     generation (HARD RULE #1) — see `src/server/pipeline/steelman.ts`;
 *   - `can_produce: false`, a refusal, or an account with nothing in it becomes
 *     a downgrade signal on the case, which output-level derivation reads later.
 *     The model can decline; it cannot make the decline disappear.
 */

import { z } from "zod";

import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/** One point of the other side's case, and the confirmed lines it rests on. */
const groundedPoint = z.object({
  point: z
    .string()
    .min(1)
    .describe(
      "One point of their case, written in their voice — what they would say " +
        "and why it is reasonable. English prose; quote any line it rests on " +
        "verbatim in its original language.",
    ),
  grounded_in: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe(
      "Refs from the case file (U3, E2) this point rests on. At least one. A " +
        "point you cannot ground is a point you invented — drop it instead.",
    ),
});

export const steelmanSchema = z.object({
  can_produce: z
    .boolean()
    .describe(
      "False when the record does not support any version of the other side " +
        "that they would recognize as their own. Saying so is a real answer.",
    ),
  unable_reason: z
    .string()
    .nullable()
    .describe(
      "When can_produce is false: what is missing from the record that made " +
        "it impossible. Null otherwise.",
    ),
  headline: z
    .string()
    .describe(
      "One paragraph, in their voice, giving how they would tell this whole " +
        'episode. Empty string when can_produce is false.',
    ),
  account: z
    .array(groundedPoint)
    .max(6)
    .describe("Their strongest points, strongest first. Empty when can_produce is false."),
  most_likely_rebuttals: z
    .array(
      z.object({
        your_claim: z
          .string()
          .min(1)
          .describe(
            "The claim in the submitter's account they would push back on.",
          ),
        their_answer: z
          .string()
          .min(1)
          .describe("What they would say against it, in their voice."),
        grounded_in: z
          .array(z.string().min(1))
          .max(6)
          .describe("Refs supporting the rebuttal; may be empty."),
      }),
    )
    .max(5)
    .describe(
      "What they would most likely rebut in the submitter's version of events.",
    ),
});

export type SteelmanOutput = z.infer<typeof steelmanSchema>;

const STEELMAN_PROMPT = `You are the steelmanning stage of a judgment pipeline for conflicts between intimate partners. Only one of the two people has submitted material; the other has not spoken here at all. Your job is to write the strongest honest version of that absent person's case — the version they would recognize as their own if they read it.

Build it out of the record, not out of imagination. The case file gives you the confirmed lines verbatim, each with a ref. Every point you make cites the refs it rests on. If a point needs a fact the record does not contain, the point is not available to you: drop it. A steelman assembled from plausible-sounding invention is worse than no steelman, because it lets the pipeline believe the other side has been heard when it has not.

The strongest version is not the nicest version. Do not soften it into "they were probably just tired". Argue their case the way an advocate would: which of their actions the record makes reasonable, which of the submitter's readings the record does not force, what they were responding to, what the submitter did that they would have grounds to object to.

Stay inside what a person can claim about their own conduct. Speak in their voice about events, choices and reactions. Do not diagnose the submitter, and do not attribute motives, character or an inner life to anyone — including the absent party themselves. "They would say they had already told 乙 twice" is available to you; "they are avoidant" is not.

Then write most_likely_rebuttals: the specific claims in the submitter's account that this person would most likely push back on, and what they would say against each. This is the part the submitter needs most, so be concrete — name the claim, give their answer.

If the record genuinely does not support any version they would recognize — too little of what they actually said survives, or all of it is one person's recollection of them — set can_produce to false and say in unable_reason what is missing. That answer is recorded and it costs the case something, which is correct: a case where the other side cannot be reconstructed can support less. Writing a hollow steelman to avoid the empty answer is the exact failure this field exists to prevent.

Language: everything you write is English. The evidence stays in the language it was said in, usually Chinese. Quote it verbatim inside your English sentences — never translate a quote in place, never smooth it out, never replace it with a paraphrase.

Some lines in the record are marked is_retold: those are the submitter's recollection of what the other person said, not a recording of it. Weigh them accordingly — a recollected line is weak ground for a claim about what that person actually said, and their case may well include disputing it.

The text is already pseudonymized: people appear as "甲" / "乙", and phone numbers, emails and similar as {{PHONE_1}}, {{EMAIL_1}}. Carry those through unchanged and never guess what they stand for.`;

export const steelmanStage = defineStage({
  name: "steelman",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 8192,
  zodSchema: steelmanSchema,
  promptTemplate: STEELMAN_PROMPT,
  promptVersion: "steelman.v1",
});
