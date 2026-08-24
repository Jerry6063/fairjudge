/**
 * `advocate_brief_a` / `advocate_brief_b` — the blind advocate pair (doc 05 §B,
 * approved 2026-08-17).
 *
 * Two agents, one brief per party, each arguing that party's strongest case from
 * the record. Neither sees the other's output; both briefs are inputs to the
 * skeleton. The pair runs at L1 only — L2 has one participant and the existing
 * single steelman of the absent party already IS the advocate, and stays a
 * single call.
 *
 * ## Why two descriptors and one schema
 *
 * The barrel's convention is one stage per module. This module holds two,
 * because the two seats are the same contract twice: what an advocate brief IS
 * has to have one definition, or the skeleton receives two documents it must
 * compare and they are not the same shape. What the two descriptors buy is the
 * audit — `llm_calls.stage` says which seat produced a row, so a pair that ran
 * (or a seat that did not) is legible in the ledger rather than inferred from
 * timestamps.
 *
 * ## Blindness is a property of the input, not of this prompt
 *
 * The prompt below tells the advocate what it is doing. It does not ask it to
 * ignore the other brief, because asking would be the failure mode CLAUDE.md
 * names: a rule that lives in prompt text is a request. `judgment/advocacy.ts`
 * assembles what each seat is handed, and the other advocate's output, any draft
 * skeleton, and the other party's clarification answers are absent from those
 * bytes. An advocate cannot be influenced by a document it was never sent.
 *
 * ## Why an advocate is allowed to concede
 *
 * `must_concede` is required, not optional garnish. A brief that concedes
 * nothing is not the strongest case a party has — it is the loudest one, and the
 * skeleton reading two of them would be choosing between two pieces of
 * advocacy with no purchase on either. The concessions are where the two briefs
 * touch the same facts, which is what makes their remaining disagreement
 * informative rather than decorative.
 */

import { z } from "zod";

import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/** One point of a party's case, and the confirmed lines it rests on. */
const groundedPoint = z.object({
  point: z
    .string()
    .min(1)
    .describe(
      "One point of this party's case, in their voice — what they would say " +
        "and why the record makes it reasonable. English prose; quote any line " +
        "it rests on verbatim in its original language.",
    ),
  grounded_in: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe(
      "Utterance ids from the EVIDENCE block this point rests on. At least " +
        "one. A point you cannot ground is a point you invented — drop it.",
    ),
});

export const advocateBriefSchema = z.object({
  for_party: z
    .string()
    .min(1)
    .describe(
      "The pseudonym of the party you are arguing for, copied from your " +
        "instructions. The server checks it against the seat it gave you.",
    ),
  can_produce: z
    .boolean()
    .describe(
      "False when the confirmed record supports no case for this party that " +
        "they would recognize as their own. Saying so is a real answer.",
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
      "One paragraph, in this party's voice, giving how they would tell this " +
        "whole episode. Empty string when can_produce is false.",
    ),
  strongest_case: z
    .array(groundedPoint)
    .max(6)
    .describe(
      "This party's strongest points, strongest first. Empty when " +
        "can_produce is false.",
    ),
  not_forced_by_the_record: z
    .array(
      z.object({
        reading: z
          .string()
          .min(1)
          .describe(
            "A reading of these events that runs against this party, stated " +
              "fairly rather than as a straw version of it.",
          ),
        why_not_forced: z
          .string()
          .min(1)
          .describe(
            "Why the confirmed record permits that reading without requiring " +
              "it. Not a denial that the lines exist — an argument about what " +
              "they do and do not settle.",
          ),
        grounded_in: z
          .array(z.string().min(1))
          .max(6)
          .describe("Utterance ids bearing on it; may be empty."),
      }),
    )
    .max(5)
    .describe(
      "The readings against this party that the record allows but does not " +
        "compel. This is the work: an adverse reading the record DOES compel " +
        "belongs in must_concede instead.",
    ),
  must_concede: z
    .array(
      z.object({
        concession: z
          .string()
          .min(1)
          .describe(
            "Something the record establishes that this party cannot argue " +
              "away, stated plainly and without hedging.",
          ),
        grounded_in: z
          .array(z.string().min(1))
          .min(1)
          .max(6)
          .describe("Utterance ids that establish it. At least one."),
      }),
    )
    .max(5)
    .describe(
      "What this party has to concede. A brief with nothing here is asserting " +
        "the record is unanimous in one party's favour, which no record of a " +
        "relationship is; leave it empty only when can_produce is false.",
    ),
});

export type AdvocateBriefOutput = z.infer<typeof advocateBriefSchema>;

const ADVOCATE_PROMPT = `You are one of two advocates in a judgment pipeline for conflicts between intimate partners. Each of you was given one party to argue for. You are writing the strongest honest version of your party's case from the confirmed record — the version they would recognize as their own if they read it.

You have not been shown the other advocate's brief, and there is no draft judgment for you to agree or disagree with. That is a fact about what you were sent, not a restriction you are being asked to honour: those documents are absent from your input. Write your party's case as well as it can honestly be written and let the comparison happen elsewhere. Do not speculate about what the other advocate is arguing, and do not write around an imagined opponent.

Build the brief out of the record, not out of imagination. The EVIDENCE block gives you the confirmed lines verbatim, each with an id. Every point you make cites the ids it rests on. If a point needs a fact the record does not contain, the point is not available to you: drop it. A brief assembled from plausible-sounding invention is worse than no brief, because it lets the pipeline believe a party has been argued for when they have not.

The strongest version is not the nicest version, and it is not the loudest one either. Argue the way an advocate argues: which of your party's actions the record makes reasonable, what they were responding to, which adverse readings the record permits without requiring — and, in must_concede, what the record establishes against them that no argument can move. An advocate who concedes nothing has not read the file.

Stay inside what a person can claim about their own conduct. Speak in your party's voice about events, choices and reactions. Do not diagnose anyone, and do not attribute motives, character or an inner life to either party — including your own. "They had already said this twice" is available to you; "they are avoidant" is not, and neither is "the other party was being manipulative".

If the record genuinely does not support any case your party would recognize — too little of what they actually said survives, or all of it is somebody else's recollection of them — set can_produce to false and say in unable_reason what is missing. That answer is recorded and it costs the case something, which is correct. Writing a hollow brief to avoid the empty answer is the exact failure this field exists to prevent.

Language: everything you write is English. The evidence stays in the language it was said in, usually Chinese. Quote it verbatim inside your English sentences — never translate a quote in place, never smooth it out, never replace it with a paraphrase.

Some lines in the record are marked is_retold: those are one person's recollection of what the other said, not a recording of it. Weigh them accordingly — a recollected line is weak ground for a claim about what somebody actually said, and your party's case may well include disputing it.

The text is already pseudonymized: people appear as "甲" / "乙", and phone numbers, emails and similar as {{PHONE_1}}, {{EMAIL_1}}. Carry those through unchanged and never guess what they stand for.`;

/**
 * Seat A. Which party that is, is decided by the caller and carried in the
 * input; the descriptor is the seat, not the person.
 */
export const advocateBriefAStage = defineStage({
  name: "advocate_brief_a",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 8192,
  zodSchema: advocateBriefSchema,
  promptTemplate: ADVOCATE_PROMPT,
  promptVersion: "advocate_brief.v1",
  // The briefs are serialized into the skeleton's prompt, whose whole naming
  // system is pseudonymous, and the fact layer's record basis is compared
  // against a database keyed by pseudonym. Putting the real names back here
  // would put them straight back into the next egress.
  keepPseudonyms: true,
});

/** Seat B. Identical contract, separate audit identity. */
export const advocateBriefBStage = defineStage({
  name: "advocate_brief_b",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 8192,
  zodSchema: advocateBriefSchema,
  promptTemplate: ADVOCATE_PROMPT,
  promptVersion: "advocate_brief.v1",
  keepPseudonyms: true,
});

/** The two seats, in the order the pair is run and recorded. */
export const ADVOCATE_STAGES = [advocateBriefAStage, advocateBriefBStage] as const;
