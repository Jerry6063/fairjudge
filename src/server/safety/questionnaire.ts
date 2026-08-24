/**
 * The intake safety questionnaire — the half of the deterministic layer that
 * asks instead of guessing.
 *
 * Pattern matching over a transcript is inference; a direct question is not.
 * "Are you afraid of them?" answered `yes` is not a keyword hit that might be
 * a figure of speech — it is the user saying so, and it therefore carries the
 * same weight as an explicit pattern with none of the false-positive risk.
 * This module is pure (no IO, no model): the questions are constants and
 * `answersToSignals` is a fold over them.
 *
 * Three answer options rather than two, because "I don't know" is the answer a
 * person actually gives to these questions early on, and forcing it into `no`
 * is how a screening instrument loses the cases it exists to find. `unsure`
 * produces an ambiguous signal, which escalates — the same recall rule the
 * pattern layer follows (see `domain/safety-rules.ts`).
 *
 * The questions are English (CLAUDE.md: the system's own words). The answers
 * are the user's own words and are stored verbatim, in whatever language they
 * were written.
 */

import type { SafetyAnswer } from "../db/schema";
import type { SafetyFlagCategory, SafetySignal, SafetySource } from "../domain/safety-rules";

/** Fixed choices for a screening question. */
export const SAFETY_CHOICES = ["yes", "no", "unsure"] as const;
export type SafetyChoice = (typeof SAFETY_CHOICES)[number];

export interface SafetyQuestion {
  /** Stable id. Survives a reworded question, which is why answers key on it. */
  readonly id: string;
  /** The question as the user sees it. */
  readonly text: string;
  /** One line under the question, saying why it is being asked. */
  readonly why: string;
  readonly kind: "choice" | "free_text";
  /**
   * Category a flagging answer maps to. Null for the free-text question, whose
   * answer is scanned by the pattern layer instead.
   */
  readonly category: SafetyFlagCategory | null;
}

/**
 * The screen, in the order it is asked: the sharpest question first, so a
 * person who is going to stop reading has already answered the one that
 * matters most.
 */
export const SAFETY_QUESTIONS: readonly SafetyQuestion[] = [
  {
    id: "fear_of_partner",
    text: "Are you afraid of the other person — of how they might react, or of what they might do?",
    why: "Fear changes what an account of a conflict means, so it is asked before anything is weighed.",
    kind: "choice",
    category: "fear",
  },
  {
    id: "physical_harm",
    text: "Has the other person ever hurt you physically, or threatened to?",
    why: "Including pushing, grabbing, blocking a door, or breaking things near you.",
    kind: "choice",
    category: "physical_violence",
  },
  {
    id: "control",
    text: "Does the other person decide where you go, who you see, or what money you can use?",
    why: "Control over movement, contact and money is the pattern behind many conflicts that look like arguments.",
    kind: "choice",
    category: "coercive_control",
  },
  {
    id: "monitoring",
    text: "Does the other person check your phone, track where you are, or read your messages without your agreement?",
    why: "Monitoring is asked separately because it is easy to normalize.",
    kind: "choice",
    category: "monitoring",
  },
  {
    id: "self_harm",
    text: "Have you or the other person talked about ending your life, or about hurting yourself, in the last two weeks?",
    why: "If either of you has, this stops being a question about who was right.",
    kind: "choice",
    category: "self_harm",
  },
  {
    id: "anything_else",
    text: "Is there anything else about your safety that should be known before this case goes any further?",
    why: "Write in whatever language you like — it is kept exactly as you write it.",
    kind: "free_text",
    category: null,
  },
];

/** The question with this id, or undefined. */
export function findSafetyQuestion(id: string): SafetyQuestion | undefined {
  return SAFETY_QUESTIONS.find((question) => question.id === id);
}

/** True for an answer that is one of the fixed choices. */
function asChoice(answer: string): SafetyChoice | null {
  const normalized = answer.trim().toLowerCase();
  return (SAFETY_CHOICES as readonly string[]).includes(normalized)
    ? (normalized as SafetyChoice)
    : null;
}

/**
 * Signals from the choice questions.
 *
 * `yes` → explicit (the user said it). `unsure` → ambiguous (escalates).
 * `no` and anything unrecognised → nothing. An answer to an unknown question
 * id is ignored rather than guessed at: a stale form should not be able to
 * invent a category.
 */
export function answersToSignals(
  answers: readonly SafetyAnswer[],
): SafetySignal[] {
  const signals: SafetySignal[] = [];

  for (const answer of answers) {
    const question = findSafetyQuestion(answer.id);
    if (question === undefined || question.category === null) continue;

    const choice = asChoice(answer.answer);
    if (choice === null || choice === "no") continue;

    signals.push({
      origin: "question",
      ruleId: `question:${question.id}`,
      category: question.category,
      confidence: choice === "yes" ? "explicit" : "ambiguous",
      sourceId: question.id,
      sourceKind: "answer",
      excerpt: choice,
    });
  }

  return signals;
}

/**
 * Free-text answers, as sources for the pattern layer.
 *
 * Choice answers are excluded — they are already handled by
 * `answersToSignals`, and scanning the literal string "no" would be noise.
 */
export function answerSources(
  answers: readonly SafetyAnswer[],
): SafetySource[] {
  return answers.flatMap((answer) => {
    const question = findSafetyQuestion(answer.id);
    if (question?.kind !== "free_text") return [];
    if (answer.answer.trim() === "") return [];
    return [{ id: answer.id, kind: "answer" as const, text: answer.answer }];
  });
}

/**
 * Normalize a submitted form into `SafetyAnswer[]`, storing the question text
 * as it was actually asked (the audit value of the row depends on that).
 */
export function buildSafetyAnswers(
  raw: Readonly<Record<string, string | undefined>>,
): SafetyAnswer[] {
  return SAFETY_QUESTIONS.flatMap((question) => {
    const value = raw[question.id];
    if (value === undefined) return [];
    return [{ id: question.id, question: question.text, answer: value }];
  });
}
