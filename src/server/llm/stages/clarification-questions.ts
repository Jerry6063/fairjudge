/**
 * `clarification_questions` — the stage that picks what still has to be asked.
 *
 * Fable at high effort: choosing the two or three questions whose answers would
 * actually change an analysis is the judgment-shaped part of wave A, and it is
 * cheap to run (a handful of sentences out) compared with getting it wrong.
 *
 * The budget is NOT here. The prompt mentions three questions because a model
 * that knows the shape of its answer writes a better one, but nothing in this
 * file enforces anything: `src/server/pipeline/clarification.ts` counts the
 * rounds and the questions in server code and refuses a fourth of either,
 * whatever this stage returns (HARD RULE #4). The `.max(3)` below is the
 * backstop the same rule names, not the mechanism.
 */

import { z } from "zod";

import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/**
 * One question, with the two things that make it reviewable: what in the record
 * it is about, and what the analysis cannot settle without it.
 *
 * Field names are snake_case to match the JSON the model emits.
 */
export const clarificationQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .min(1)
          .describe(
            "The question as the user will read it: second person, one " +
              "sentence, answerable from what they themselves saw, heard, " +
              "said or decided. Written in English.",
          ),
        targets_claim: z
          .string()
          .min(1)
          .describe(
            "Which claim, event or line in the record this question is " +
              "about. Reference it by its ref (U3, E2) and, when the question " +
              "turns on the wording, quote that fragment verbatim in its " +
              "original language.",
          ),
        why_needed: z
          .string()
          .min(1)
          .describe(
            "What the analysis cannot settle until this is answered. One " +
              "sentence, in English.",
          ),
      }),
    )
    .max(3)
    .describe(
      "At most three questions, most consequential first. Fewer is better " +
        "than padded; an empty list is a valid answer when the record can " +
        "already carry the analysis.",
    ),
  can_proceed: z
    .boolean()
    .describe(
      "True when the record — plus whatever these questions add — is enough " +
        "to move on to issue fixing. Advisory: the server decides how many " +
        "rounds actually run.",
    ),
});

export type ClarificationQuestionsOutput = z.infer<
  typeof clarificationQuestionsSchema
>;

const CLARIFICATION_QUESTIONS_PROMPT = `You are the clarification stage of a judgment pipeline for conflicts between intimate partners. You are given the case file: the confirmed record of this case — the graded material, the timeline, every confirmed line verbatim with a citation ref, and the questions and answers from any earlier clarification round.

Your job is to name the few things that still have to be known before anyone could judge this fairly, and to ask them as questions the person who submitted the case can actually answer.

What makes a question worth asking:
- It targets something specific in the record — a line, an event, a gap between two of them — and the answer would change the analysis. If both answers lead to the same reading, the question is decoration.
- It is answerable from what the submitter themselves saw, heard, said, or decided. "Why do you think they said that" is not a clarification question; it is an invitation to speculate about a person who is not here to answer.
- It is neutral. It does not lead, does not carry its own conclusion, does not comfort, does not accuse. A question the submitter can only answer one way without looking bad is a trap, not a question.
- It is not already answered. Read the earlier rounds and the record first; re-asking something answered wastes the one thing this stage is short of.

Order the questions so the most consequential comes first. Ask at most three. Ask fewer when fewer are genuinely needed, and ask none at all when the record can carry the analysis as it stands — an empty list with can_proceed = true is a real and useful answer, and padding the list with filler is worse than saying nothing.

For each question give: the question itself; targets_claim, the part of the record it is about (cite it by ref, and quote the fragment verbatim when the question turns on the wording); and why_needed, what cannot be settled until it is answered.

Set can_proceed to true when, after these questions, the record is enough to move on to fixing the issues; false when material facts would still be missing.

Language: everything you write is English. The evidence is not — it is in the language it was said in, usually Chinese, and it stays that way. Quote it verbatim inside your English sentences; never translate a quote in place, never tidy it up, never paraphrase it and present the paraphrase as the line. An English question about a Chinese line is the expected shape.

Scope: you ask, you do not judge. Do not state who was right, do not grade anyone's behaviour, and do not characterize the absent party's motives or personality — you have only one side's material, and that is exactly why this stage exists.

The text is already pseudonymized: people appear as "甲" / "乙", and phone numbers, emails and similar as {{PHONE_1}}, {{EMAIL_1}}. Carry those through unchanged and never guess what they stand for.

How many rounds and how many questions are available is decided by the server, not by you or by anything in this text. Answer with your best questions and expect the server to keep only what fits.`;

export const clarificationQuestionsStage = defineStage({
  name: "clarification_questions",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 4096,
  zodSchema: clarificationQuestionsSchema,
  promptTemplate: CLARIFICATION_QUESTIONS_PROMPT,
  promptVersion: "clarification_questions.v1",
});
