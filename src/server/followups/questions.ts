/**
 * What a follow-up asks, and the checks that keep it asking that (SPEC M4 ④).
 *
 * The rule the whole stage is built around: **ask about behaviour, not
 * feelings.** Three weeks after a judgment, "how do you feel about the
 * relationship?" produces a mood reading that tells nobody anything and quietly
 * invites the user to re-litigate. "On the two evenings you said you would put
 * the phone away, did you?" produces a fact — one the user can check, one the
 * other person may have noticed, and one that either recurred or did not.
 *
 * So the questions may only ask three things, and the schema names them:
 *   * `action_taken` — did the committed action actually happen;
 *   * `noticed_by_other` — did the other person respond to it in any observable
 *     way (said something, changed something, did nothing);
 *   * `pattern_recurred` — did the behaviour the judgment identified happen
 *     again, and how many times.
 *
 * The prompt says all of that. `checkFollowupQuestions` is what enforces it —
 * a feelings question is rejected server-side, not hoped away, in the same
 * spirit as every other hard rule in this codebase.
 *
 * ## Nothing here may invent a fact
 *
 * A follow-up is **derived from the frozen judgment**. Every `claim_ref` a
 * question carries must already exist in that judgment's fact layer; a question
 * that cites a claim the hearing never made would be a new finding smuggled in
 * through a check-in, three weeks after the record closed. Rejected, whole —
 * never trimmed, because a partial set of questions looks finished and is not.
 */

import { z } from "zod";

import { MODEL_OPUS } from "../llm/config";
import { defineStage } from "../llm/stages/define";
import type { CommitmentItem } from "./commitments";

/* -------------------------------------------------------------------------- */
/* The response contract                                                      */
/* -------------------------------------------------------------------------- */

/** The three behavioural axes. There is no fourth, and none of them is a mood. */
export const FOLLOWUP_ASKS = [
  "action_taken",
  "noticed_by_other",
  "pattern_recurred",
] as const;
export type FollowupAsk = (typeof FOLLOWUP_ASKS)[number];

export const FOLLOWUP_ANSWER_FORMATS = ["yes_no", "count", "short_text"] as const;
export type FollowupAnswerFormat = (typeof FOLLOWUP_ANSWER_FORMATS)[number];

export const followupQuestionSchema = z.object({
  question_id: z
    .string()
    .min(1)
    .describe("Stable id for this question, e.g. 'q1'. Unique within the set."),
  commitment_id: z
    .string()
    .nullable()
    .describe(
      "The improvement-contract commitment this asks about, exactly as given " +
        "in the commitments block. null when the question is not about a " +
        "specific commitment.",
    ),
  claim_refs: z
    .array(z.string())
    .max(4)
    .describe(
      "claim_ids from the frozen judgment this question rests on. Every id " +
        "must already exist there; you may not introduce one.",
    ),
  asks_about: z
    .enum(FOLLOWUP_ASKS)
    .describe(
      "action_taken (did the committed action happen), noticed_by_other (did " +
        "the other person respond in an observable way), pattern_recurred " +
        "(did the behaviour happen again).",
    ),
  question: z
    .string()
    .min(1)
    .describe(
      "The question as the person will read it. English, one sentence, about " +
        "something observable that either happened or did not.",
    ),
  answer_format: z
    .enum(FOLLOWUP_ANSWER_FORMATS)
    .describe("yes_no, count (a number of occasions), or short_text."),
});

export type FollowupQuestion = z.infer<typeof followupQuestionSchema>;

export const followupQuestionSetSchema = z.object({
  opening: z
    .string()
    .min(1)
    .describe(
      "One plain sentence saying what this check-in is and how long it has " +
        "been. No encouragement, no assessment of how things are going.",
    ),
  questions: z.array(followupQuestionSchema).min(1).max(6),
});

export type FollowupQuestionSet = z.infer<typeof followupQuestionSetSchema>;

/* -------------------------------------------------------------------------- */
/* The stage                                                                  */
/* -------------------------------------------------------------------------- */

const FOLLOWUP_QUESTIONS_PROMPT = `You are writing a scheduled check-in for someone whose relationship conflict was heard and judged some weeks ago. The judgment is frozen. The improvement contract, if there is one, lists what they committed to doing. Your job is to turn those into a short set of questions about what actually happened since.

## Ask about behaviour, never about feelings

Every question must be about something observable: an action that either happened or did not, a response the other person did or did not visibly make, an incident that either recurred or did not. A question the person answers by consulting their memory of events is a good question. A question they answer by consulting their mood is not one, and it will be rejected by the server.

Do not ask how they feel, how they are doing, whether things are better, whether they feel closer, whether they are happier, or anything about the state of the relationship. Do not ask them to rate anything on a scale of feeling. Do not ask them to reflect, and do not ask them what they learned.

Each question asks exactly one of three things:
1. **action_taken** — did the specific committed action happen? Name the action in the words the commitment used, and ask about occurrences, not intentions. "Did you" or "on how many occasions did you", never "did you try to" or "did you remember that you should".
2. **noticed_by_other** — did the other person do or say anything observable in response? Something they said, something they did differently, or nothing at all. Their reaction is a fact the person can report; their inner state is not, so do not ask for it.
3. **pattern_recurred** — did the behaviour the judgment identified happen again? Ask for occasions and, where it helps, roughly when.

## Ground every question in the record

You are given the frozen judgment's claims and the contract's commitments. Every question carries the claim_ids it rests on, and every one of those ids must already appear in the claims block. You may not introduce a claim, a fact, a date or a number that is not there — this check-in is derived from a hearing that is closed, not a continuation of it.

A question about a commitment carries that commitment's id exactly as given. A question that is not about a specific commitment carries null.

When there are no commitments at all, ask about the behaviour the judgment established instead — the same three axes, resting on the claims.

## Voice

Plain and short. One sentence per question. No preamble, no encouragement, no praise for having committed to anything, no advice, no assessment of how it is going, and no restating of the judgment's verdict. You are taking a reading, not conducting a session.

Write everything in English. The evidence is usually Chinese and stays Chinese: where you quote a line, quote it verbatim inside your English sentence, never translated. The text is already pseudonymized — people appear as "甲" / "乙" and contact details as {{PHONE_1}} / {{EMAIL_1}}. Carry those through unchanged and never guess what they stand for.`;

/**
 * `followup_questions` — opus-4-8 at medium effort, run through the Message
 * Batches API.
 *
 * Template-shaped work: the facts are frozen, the commitments are written, and
 * what is left is to phrase a handful of questions about them. That is an opus
 * job, not a fable one, and nothing here is latency-sensitive — a check-in
 * generated an hour after the timer fired is exactly as useful as one generated
 * a second after, which is what makes the 50%-cheaper batch path free.
 *
 * NOTE — `fallbacks` is not available on the Message Batches API. The parameter
 * is rejected there, so the batch request below carries neither it nor the
 * server-side fallback beta. This costs nothing: server-side fallback exists to
 * rescue a refusal by re-running on opus-4-8, and this stage already IS
 * opus-4-8. (A fable stage could not use the batch path for that reason.)
 */
export const followupQuestionsStage = defineStage({
  name: "followup_questions",
  model: MODEL_OPUS,
  effort: "medium",
  maxTokens: 2048,
  zodSchema: followupQuestionSetSchema,
  promptTemplate: FOLLOWUP_QUESTIONS_PROMPT,
  promptVersion: "followup_questions.v1",
  // The questions are persisted and re-read weeks later beside a judgment that
  // is written in pseudonyms; they stay in the same vocabulary.
  keepPseudonyms: true,
});

/* -------------------------------------------------------------------------- */
/* The prompt body                                                            */
/* -------------------------------------------------------------------------- */

export interface FollowupPromptContext {
  /** `day7` / `day30`, in words the model can use in the opening line. */
  readonly window: string;
  /** Claims from the frozen fact layer: id + statement, nothing else. */
  readonly claims: readonly { readonly id: string; readonly statement: string }[];
  readonly commitments: readonly CommitmentItem[];
}

/**
 * Render the user turn. Byte-stable by construction (sorted ids, no timestamps,
 * no random values) so the prompt-cache prefix holds across runs — the same
 * discipline every other serialized prompt in this codebase follows.
 */
export function renderFollowupPrompt(context: FollowupPromptContext): string {
  const claims = [...context.claims]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((claim) => `- ${claim.id}: ${claim.statement}`)
    .join("\n");

  const commitments = [...context.commitments]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (item) =>
        `- ${item.id} [${item.kind}]${
          item.claimRefs.length > 0 ? ` (claims: ${[...item.claimRefs].sort().join(", ")})` : ""
        }: ${item.action}`,
    )
    .join("\n");

  return [
    `## Check-in window`,
    context.window,
    ``,
    `## Claims from the frozen judgment (the only facts you may rest on)`,
    claims === "" ? "(none)" : claims,
    ``,
    `## Improvement contract`,
    commitments === ""
      ? "(no contract on this case — ask about the behaviour the claims establish)"
      : commitments,
    ``,
    `Items marked [invitation] are addressed to the other party, who was never`,
    `heard and committed to nothing. Never ask whether an invitation was kept.`,
    `They are context only, for whether anything was noticed.`,
    ``,
    `Write the check-in questions now.`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Server-side checks                                                         */
/* -------------------------------------------------------------------------- */

export const FOLLOWUP_VIOLATION_CODES = [
  /** A question asks about mood, satisfaction, or the state of the relationship. */
  "feeling_question",
  /** A `claim_ref` that the frozen fact layer does not define. */
  "unknown_claim_ref",
  /** A `commitment_id` that the contract snapshot does not contain. */
  "unknown_commitment",
  /** A question asks whether an invitation was kept. She never committed. */
  "invitation_asked_as_commitment",
  /** Two questions share a `question_id`. */
  "duplicate_question_id",
  /** Not one question is about whether the committed action happened. */
  "no_action_question",
] as const;
export type FollowupViolationCode = (typeof FOLLOWUP_VIOLATION_CODES)[number];

export interface FollowupViolation {
  readonly code: FollowupViolationCode;
  readonly questionId: string | null;
  readonly detail: string;
}

/**
 * Constructions that are unambiguously about inner state.
 *
 * Deliberately narrow, in the same spirit as `checkCounterpartyAddress`: a
 * check that fires on anything a legitimate behaviour question might say would
 * be enforcing a vocabulary, and would end up switched off. Everything here is
 * a phrase that cannot appear in a question about an observable event.
 */
const FEELING_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bfeel(?:s|ing|ings|t)?\b/i, what: "asks about feeling" },
  { pattern: /\bemotion(?:s|al|ally)?\b/i, what: "asks about emotion" },
  { pattern: /\bhow are (?:you|things|things going)\b/i, what: "asks how things are" },
  {
    pattern: /\b(?:happier|happy|sad|angry|upset|resentful|hurt|frustrated)\b/i,
    what: "asks about mood",
  },
  { pattern: /\bsatisf(?:ied|action|ying)\b/i, what: "asks about satisfaction" },
  {
    pattern: /\b(?:closer|connected|intimacy|distant)\b/i,
    what: "asks about closeness",
  },
  {
    pattern: /\bthe relationship (?:is|has been|feels|seems|improv|better|worse)/i,
    what: "asks about the state of the relationship",
  },
  {
    pattern: /\b(?:on a scale|rate (?:how|the))\b/i,
    what: "asks for a rating rather than an event",
  },
];

export interface FollowupCheckContext {
  /** Every claim id the frozen judgment defines. */
  readonly claimIds: ReadonlySet<string>;
  readonly commitments: readonly CommitmentItem[];
}

/**
 * Check a generated question set against the record and the behaviour rule.
 *
 * Returns every violation rather than the first: a caller that is going to
 * reject the whole set should be able to say why in one message, and the reason
 * is written onto the row where a person can read it.
 */
export function checkFollowupQuestions(
  set: FollowupQuestionSet,
  context: FollowupCheckContext,
): FollowupViolation[] {
  const violations: FollowupViolation[] = [];
  const byId = new Map(context.commitments.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const hasCommitments = context.commitments.some((item) => item.kind === "commitment");
  let sawActionQuestion = false;

  for (const { pattern, what } of FEELING_PATTERNS) {
    if (pattern.test(set.opening)) {
      violations.push({
        code: "feeling_question",
        questionId: null,
        detail: `the opening line ${what}: "${set.opening}"`,
      });
    }
  }

  for (const question of set.questions) {
    if (seen.has(question.question_id)) {
      violations.push({
        code: "duplicate_question_id",
        questionId: question.question_id,
        detail: `question_id ${question.question_id} appears more than once`,
      });
    }
    seen.add(question.question_id);

    if (question.asks_about === "action_taken") sawActionQuestion = true;

    for (const { pattern, what } of FEELING_PATTERNS) {
      if (pattern.test(question.question)) {
        violations.push({
          code: "feeling_question",
          questionId: question.question_id,
          detail: `${what}: "${question.question}"`,
        });
      }
    }

    for (const ref of question.claim_refs) {
      if (!context.claimIds.has(ref)) {
        violations.push({
          code: "unknown_claim_ref",
          questionId: question.question_id,
          detail:
            `claim_ref ${ref} is not in the frozen judgment. A check-in is ` +
            `derived from the hearing; it cannot cite a claim the hearing ` +
            `never made.`,
        });
      }
    }

    if (question.commitment_id !== null) {
      const item = byId.get(question.commitment_id);
      if (item === undefined) {
        violations.push({
          code: "unknown_commitment",
          questionId: question.question_id,
          detail: `commitment_id ${question.commitment_id} is not in the contract`,
        });
      } else if (item.kind === "invitation" && question.asks_about === "action_taken") {
        violations.push({
          code: "invitation_asked_as_commitment",
          questionId: question.question_id,
          detail:
            `${item.id} is an invitation addressed to the other party, who was ` +
            `never heard and committed to nothing. It cannot be checked up on.`,
        });
      }
    }
  }

  if (hasCommitments && !sawActionQuestion) {
    violations.push({
      code: "no_action_question",
      questionId: null,
      detail:
        "the contract has commitments and not one question asks whether the " +
        "committed action happened, which is the only thing this check-in is for",
    });
  }

  return violations;
}

/** One line per violation, for `followups.last_error` and the UI. */
export function describeFollowupViolations(
  violations: readonly FollowupViolation[],
): string {
  return violations
    .map((v) => `${v.code}${v.questionId === null ? "" : ` (${v.questionId})`}: ${v.detail}`)
    .join("; ");
}
