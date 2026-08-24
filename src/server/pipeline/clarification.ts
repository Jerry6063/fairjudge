/**
 * The clarification loop (SPEC M3 wave A ③) — HARD RULE #4, in code.
 *
 * The budget is **≤3 rounds × ≤3 questions**, and this module is the thing that
 * enforces it. Two counters do the work, and neither of them reads anything a
 * model returned:
 *
 *   1. `recordClarificationRound` counts the rounds already on the case with
 *      `SELECT count(*)`, inside the write transaction, and refuses a fourth.
 *   2. The same function keeps the first `MAX_CLARIFICATION_QUESTIONS` of
 *      whatever list it is handed and reports how many it dropped. A generation
 *      containing five questions produces a round with three, whatever the
 *      answer said about itself.
 *
 * The `.max(3)` on `clarificationQuestionsSchema` is the backstop CLAUDE.md
 * names, not the mechanism. It runs first in practice — a provider that honours
 * `maxItems` never sends four, and `zod.parse` in the gateway rejects it if one
 * does — but it is a property of a schema that a prompt could be talked around,
 * so nothing here depends on it having fired. Delete the `.max(3)` and every
 * guarantee below still holds; delete this module's counters and none of them do.
 *
 * Everything is synchronous and takes an explicit `Db` except the one function
 * that calls the model, so the tests drive exactly the code path the server
 * action does.
 */

import { and, asc, count, eq, isNull } from "drizzle-orm";

import type { Db } from "../db";
import {
  clarificationRounds,
  type ClarificationAnswer,
  type ClarificationQuestion,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta as StageRunMeta } from "../llm";
import { clarificationQuestionsStage } from "../llm/stages";
import { assembleCaseFile, serializeCaseFile, type CaseFile } from "./case-file";
import { MAX_CLARIFICATION_ROUNDS, type Reader } from "./stage-machine";

/* -------------------------------------------------------------------------- */
/* The budget                                                                 */
/* -------------------------------------------------------------------------- */

/** ≤3 questions per round (HARD RULE #4). The rounds cap lives in the machine. */
export const MAX_CLARIFICATION_QUESTIONS = 3;

/** Both halves of the budget, for the UI and for anyone reading the rule. */
export const CLARIFICATION_BUDGET = {
  maxRounds: MAX_CLARIFICATION_ROUNDS,
  maxQuestionsPerRound: MAX_CLARIFICATION_QUESTIONS,
} as const;

/* -------------------------------------------------------------------------- */
/* Stored shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A stored question, plus the two fields that make it reviewable.
 *
 * `clarification_rounds.questions` is a JSON column typed `{id, question}[]`.
 * The stage also returns `targets_claim` (what in the record the question is
 * about) and `why_needed` (what cannot be settled until it is answered), and
 * there is no column for either. They ride along inside the same JSON object as
 * optional keys: `StoredQuestion` extends `ClarificationQuestion`, so it is
 * assignable wherever the column expects one, and every other reader —
 * `case-file.ts` in particular — still sees exactly the `{id, question}` it asks
 * for. They are optional rather than nullable because a row written before this
 * module reads back without them, and that is not a defect.
 */
interface StoredQuestion extends ClarificationQuestion {
  readonly targetsClaim?: string;
  readonly whyNeeded?: string;
}

/** A question on its way in: no id yet, and nothing decided about the budget. */
export interface DraftQuestion {
  readonly question: string;
  readonly targetsClaim?: string | null;
  readonly whyNeeded?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

export interface ClarificationQuestionView {
  readonly id: string;
  readonly question: string;
  /** What in the record it is about; null on rows written without it. */
  readonly targetsClaim: string | null;
  /** What the analysis cannot settle until it is answered. */
  readonly whyNeeded: string | null;
  /**
   * The reply, verbatim — evidence, never normalized. Null while open AND null
   * when declined: a declined question has no answer, and anything downstream
   * that reads this field must see nothing rather than a sentence to quote.
   */
  readonly answer: string | null;
  readonly answeredAt: number | null;
  /** The client said they are not answering this one. A settled state. */
  readonly declined: boolean;
  /** Why, in one line. Never a stand-in for an answer. */
  readonly declineNote: string | null;
  readonly declinedAt: number | null;
}

export interface ClarificationRoundView {
  readonly id: string;
  readonly roundNumber: number;
  readonly questions: readonly ClarificationQuestionView[];
  /** Questions with a real reply. A declined one is settled but not answered. */
  readonly answered: number;
  /** Questions the client explicitly refused to answer. */
  readonly declined: number;
  /** True while at least one question is unanswered (`closed_at` is null). */
  readonly open: boolean;
  readonly closedAt: Date | null;
  /** The user's "this round added nothing new". */
  readonly saturated: boolean;
  /** The stage's own `can_proceed`. Advisory — the counters decide. */
  readonly canProceed: boolean;
}

export interface ClarificationBoard {
  readonly caseId: string;
  readonly budget: typeof CLARIFICATION_BUDGET;
  readonly rounds: readonly ClarificationRoundView[];
  /** Rounds spent. The fourth is refused whatever else is true. */
  readonly roundsUsed: number;
  readonly roundsRemaining: number;
  /** The round still waiting for answers, or null. */
  readonly openRound: ClarificationRoundView | null;
  /**
   * Whether a new round may be opened at all: nothing is open, and the budget
   * has something left. `canAskAnother` is not the same question as `settled` —
   * a case can be free to move on and still have a round available.
   */
  readonly canAskAnother: boolean;
  /**
   * The loop has produced what it is going to produce.
   *
   * Deliberately the same predicate as `clarification_settled` in the stage
   * machine's entry requirements for `participation`; the two must move
   * together. The machine remains the authority — screens render its wording,
   * not this flag.
   */
  readonly settled: boolean;
}

/** One round row → the view. */
function toView(
  row: typeof clarificationRounds.$inferSelect,
): ClarificationRoundView {
  const stored: readonly StoredQuestion[] = row.questions ?? [];
  const answers: readonly ClarificationAnswer[] = row.answers ?? [];
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));

  const questions: ClarificationQuestionView[] = stored.map((question) => {
    const entry = byQuestion.get(question.id);
    // A row written before the state field existed carries a reply and no
    // state; that is an answer, not a decline.
    const declined = entry?.state === "declined";
    return {
      id: question.id,
      question: question.question,
      targetsClaim: question.targetsClaim ?? null,
      whyNeeded: question.whyNeeded ?? null,
      answer: declined ? null : (entry?.answer ?? null),
      answeredAt: declined ? null : (entry?.answeredAt ?? null),
      declined,
      declineNote: declined ? (entry?.declineNote ?? null) : null,
      declinedAt: declined ? (entry?.declinedAt ?? null) : null,
    };
  });

  return {
    id: row.id,
    roundNumber: row.roundNumber,
    questions,
    answered: questions.filter((q) => q.answer !== null).length,
    declined: questions.filter((q) => q.declined).length,
    open: row.closedAt === null,
    closedAt: row.closedAt,
    saturated: row.saturated,
    canProceed: row.canProceed,
  };
}

/** Every round on one case, with the budget resolved against them. */
export function readClarification(db: Reader, caseId: string): ClarificationBoard {
  const rounds = db
    .select()
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .orderBy(asc(clarificationRounds.roundNumber))
    .all()
    .map(toView);

  const roundsUsed = rounds.length;
  const openRound = rounds.find((round) => round.open) ?? null;
  const closedRounds = rounds.filter((round) => !round.open);

  // Mirrors `clarification_settled` in stage-machine.ts. Saturation counts from
  // any round (the user can mark it the moment they see it); `can_proceed` only
  // counts from a closed one, because a round the user has not answered has not
  // yet had the chance to change the answer.
  const settled =
    closedRounds.length >= MAX_CLARIFICATION_ROUNDS ||
    (closedRounds.length > 0 &&
      (rounds.some((round) => round.saturated) ||
        closedRounds.some((round) => round.canProceed)));

  return {
    caseId,
    budget: CLARIFICATION_BUDGET,
    rounds,
    roundsUsed,
    roundsRemaining: Math.max(0, MAX_CLARIFICATION_ROUNDS - roundsUsed),
    openRound,
    canAskAnother: openRound === null && roundsUsed < MAX_CLARIFICATION_ROUNDS,
    settled,
  };
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type ClarificationErrorCode =
  /** A fourth round. Refused by the counter, not by anything a model said. */
  | "budget_exhausted"
  /** The current round is still waiting for answers. */
  | "round_open"
  | "round_not_found"
  /** A closed round is a record; it is not edited after the fact. */
  | "round_closed"
  /** No question with that id in this round — including one over the budget. */
  | "unknown_question"
  | "empty_answer";

export class ClarificationError extends Error {
  readonly code: ClarificationErrorCode;

  constructor(code: ClarificationErrorCode, message: string) {
    super(message);
    this.name = "ClarificationError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* The counters                                                               */
/* -------------------------------------------------------------------------- */

/** Rounds already on this case. One `SELECT count(*)`; no model in sight. */
function countRounds(db: Reader, caseId: string): number {
  const [row] = db
    .select({ n: count() })
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .all();
  return row?.n ?? 0;
}

/** Rounds still waiting for answers. A second one may not be opened over them. */
function countOpenRounds(db: Reader, caseId: string): number {
  const [row] = db
    .select({ n: count() })
    .from(clarificationRounds)
    .where(
      and(
        eq(clarificationRounds.caseId, caseId),
        isNull(clarificationRounds.closedAt),
      ),
    )
    .all();
  return row?.n ?? 0;
}

/**
 * Apply the per-round question cap.
 *
 * Pure, exported, and tested on its own: this is the half of HARD RULE #4 that
 * a schema `maxItems` is only the backstop for. Blank questions are dropped
 * before the cap, so three real questions and two empty strings still yield
 * three questions rather than one.
 */
export function withinQuestionBudget(questions: readonly DraftQuestion[]): {
  readonly kept: readonly DraftQuestion[];
  readonly dropped: number;
} {
  const usable = questions.filter((q) => q.question.trim() !== "");
  const kept = usable.slice(0, MAX_CLARIFICATION_QUESTIONS);
  return { kept, dropped: usable.length - kept.length };
}

export interface RecordedRound {
  readonly round: ClarificationRoundView;
  /** Questions actually asked (≤ the per-round cap). */
  readonly asked: number;
  /** Questions the budget refused. Surfaced, never silently swallowed. */
  readonly dropped: number;
}

/**
 * Open a round with the questions it will ask.
 *
 * This is the enforcement point. It is exported (rather than being an internal
 * step of `runClarificationRound`) precisely so the budget can be driven and
 * tested without a model anywhere near it: whatever the caller hands over, a
 * fourth round throws and a fourth question is dropped.
 *
 * A round with no questions is legal and closes immediately — "there is nothing
 * left worth asking" is a real outcome of a round, and it costs a round of the
 * budget because a round is what produced it.
 */
export function recordClarificationRound(
  db: Db,
  input: {
    readonly caseId: string;
    readonly questions: readonly DraftQuestion[];
    readonly canProceed?: boolean;
  },
): RecordedRound {
  const { caseId, canProceed = false } = input;
  const { kept, dropped } = withinQuestionBudget(input.questions);

  const row = db.transaction((tx) => {
    // Re-counted inside the transaction: the decision that authorizes the
    // write is made against the database as it is at write time.
    const used = countRounds(tx, caseId);
    if (used >= MAX_CLARIFICATION_ROUNDS) {
      throw new ClarificationError(
        "budget_exhausted",
        `Clarification is capped at ${MAX_CLARIFICATION_ROUNDS} rounds, and ` +
          `this case has used all ${used}. There is no fourth round to open.`,
      );
    }

    if (countOpenRounds(tx, caseId) > 0) {
      throw new ClarificationError(
        "round_open",
        "The current round is still waiting for answers. Answer it before " +
          "asking for another — a round is what the next one is written from.",
      );
    }

    const roundNumber = used + 1;
    const questions: StoredQuestion[] = kept.map((question, at) => ({
      id: `r${roundNumber}q${at + 1}`,
      question: question.question.trim(),
      ...(question.targetsClaim != null && question.targetsClaim.trim() !== ""
        ? { targetsClaim: question.targetsClaim.trim() }
        : {}),
      ...(question.whyNeeded != null && question.whyNeeded.trim() !== ""
        ? { whyNeeded: question.whyNeeded.trim() }
        : {}),
    }));

    const [inserted] = tx
      .insert(clarificationRounds)
      .values({
        caseId,
        roundNumber,
        questions,
        answers: [],
        canProceed,
        // Nothing to answer means nothing to wait for.
        closedAt: questions.length === 0 ? new Date() : null,
      })
      .returning()
      .all();
    return inserted;
  });

  return { round: toView(row), asked: row.questions?.length ?? 0, dropped };
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                  */
/* -------------------------------------------------------------------------- */

function loadRound(db: Reader, caseId: string, roundId: string) {
  const row = db
    .select()
    .from(clarificationRounds)
    .where(
      and(
        eq(clarificationRounds.id, roundId),
        eq(clarificationRounds.caseId, caseId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new ClarificationError(
      "round_not_found",
      "That clarification round is not on this case. Refresh the page.",
    );
  }
  return row;
}

/**
 * Write one entry into an open round, and close the round when the last
 * question is settled.
 *
 * Both ways of settling a question — answering it and declining it — land here,
 * because "the round is complete" must mean exactly one thing. If the two paths
 * each decided completeness for themselves, a round could be closed by one rule
 * and re-opened by the other.
 *
 * An id that is not one of this round's questions is refused. That is the
 * budget counter seen from the other end — a question the cap dropped was never
 * written, so there is nothing here to settle, and no amount of client-side
 * insistence turns a fourth question into a real one.
 */
function settleQuestion(
  db: Db,
  input: { readonly caseId: string; readonly roundId: string; readonly questionId: string },
  entry: ClarificationAnswer,
): ClarificationRoundView {
  const updated = db.transaction((tx) => {
    const row = loadRound(tx, input.caseId, input.roundId);
    if (row.closedAt !== null) {
      throw new ClarificationError(
        "round_closed",
        "This round is closed. Its answers are part of the record the next " +
          "round was written from, so they are not rewritten afterwards.",
      );
    }

    const questions: readonly StoredQuestion[] = row.questions ?? [];
    if (!questions.some((question) => question.id === input.questionId)) {
      throw new ClarificationError(
        "unknown_question",
        "That question is not part of this round.",
      );
    }

    const previous: readonly ClarificationAnswer[] = row.answers ?? [];
    const answers: ClarificationAnswer[] = [
      ...previous.filter((a) => a.questionId !== input.questionId),
      entry,
    ].sort((a, b) => (a.questionId < b.questionId ? -1 : 1));

    const complete = questions.every((question) =>
      answers.some((a) => a.questionId === question.id),
    );

    const [written] = tx
      .update(clarificationRounds)
      .set({ answers, closedAt: complete ? new Date() : null })
      .where(eq(clarificationRounds.id, row.id))
      .returning()
      .all();
    return written;
  });

  return toView(updated);
}

/**
 * Record one answer, and close the round when the last one lands.
 *
 * The answer is stored verbatim: it is the user's own words about their own
 * case, which makes it evidence, and evidence is never tidied up.
 */
export function answerClarificationQuestion(
  db: Db,
  input: {
    readonly caseId: string;
    readonly roundId: string;
    readonly questionId: string;
    readonly answer: string;
  },
): ClarificationRoundView {
  const answer = input.answer.trim();
  if (answer === "") {
    throw new ClarificationError(
      "empty_answer",
      "An empty answer is not an answer. Say what you know, or say that you " +
        "do not know — both are useful; a blank is not.",
    );
  }

  return settleQuestion(db, input, {
    questionId: input.questionId,
    answer,
    answeredAt: Date.now(),
    state: "answered",
  });
}

/**
 * Record that the client is not answering this question.
 *
 * A legitimate answer, and the reason it exists as its own state rather than as
 * a blank: these questions are about someone's private life, and refusing one is
 * a thing a real person is entitled to do. What the product may not do is turn
 * that refusal into either of the two lies available to it — pretend the
 * question is still open (which would hold the loop hostage), or let something
 * downstream read a placeholder sentence as if the client had spoken.
 *
 * So the round still closes and the budget is still spent, but
 * `ClarificationQuestionView.answer` stays null, and every reader that walks the
 * record — the case file the next stage is written from, and the judgment's own
 * findings — sees a question that went unanswered.
 *
 * `note` is one line about why. It may be the client's own words; it may be the
 * system's, as when `npm run purge:operator` removes an answer the client never
 * wrote. It is never quoted as an answer.
 */
export function declineClarificationQuestion(
  db: Db,
  input: {
    readonly caseId: string;
    readonly roundId: string;
    readonly questionId: string;
    readonly note?: string | null;
  },
): ClarificationRoundView {
  const note = input.note?.trim();
  return settleQuestion(db, input, {
    questionId: input.questionId,
    answer: "",
    answeredAt: null,
    state: "declined",
    declinedAt: Date.now(),
    ...(note !== undefined && note !== "" ? { declineNote: note } : {}),
  });
}

/**
 * Mark a round as having added nothing new.
 *
 * The user's call, not the model's: `can_proceed` is what the stage thinks, and
 * this is what the person who answered the questions thinks. Either one closes
 * the loop early (see the `participation` entry requirement); neither can open
 * a round the budget has spent.
 */
export function markClarificationSaturated(
  db: Db,
  input: {
    readonly caseId: string;
    readonly roundId: string;
    readonly saturated?: boolean;
  },
): ClarificationRoundView {
  const saturated = input.saturated ?? true;
  const updated = db.transaction((tx) => {
    const row = loadRound(tx, input.caseId, input.roundId);
    const [written] = tx
      .update(clarificationRounds)
      .set({ saturated })
      .where(eq(clarificationRounds.id, row.id))
      .returning()
      .all();
    return written;
  });
  return toView(updated);
}

/* -------------------------------------------------------------------------- */
/* The stage run                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The user turn appended after the case file.
 *
 * The round number is information, not permission — the stage's own prompt says
 * outright that how many rounds exist is the server's business. Nothing here
 * tells the model how much budget is left, because a model that knows it is on
 * its last round has a reason to pad.
 */
function clarificationTask(roundNumber: number): string {
  return (
    `This is clarification round ${roundNumber}. Everything above is the ` +
    `confirmed record of this case, including the answers to any earlier ` +
    `round.\n\n` +
    `Name what still has to be known before this could be judged fairly, as ` +
    `questions the person who submitted the case can answer from what they ` +
    `themselves saw, heard, said or decided. Ask nothing that is already ` +
    `answered above.`
  );
}

/**
 * Assemble the exact bytes the stage is handed.
 *
 * Exported because it is the cheapest possible proof of HARD RULE #1 on the way
 * *in*: the case file is built from confirmed material only, so an unconfirmed
 * line is not merely uncitable, it is absent from the prompt. A test can read
 * this string and look for what should not be in it.
 */
export function buildClarificationPrompt(
  db: Reader,
  caseId: string,
  roundNumber: number,
): { readonly prompt: string; readonly file: CaseFile } {
  const file = assembleCaseFile(db, caseId);
  return {
    prompt: `${serializeCaseFile(file)}\n\n${clarificationTask(roundNumber)}`,
    file,
  };
}

export type ClarificationRunResult =
  | {
      readonly kind: "ok";
      readonly round: ClarificationRoundView;
      readonly asked: number;
      /** Questions the server budget refused, whatever the model returned. */
      readonly dropped: number;
      readonly canProceed: boolean;
      readonly meta: StageRunMeta;
    }
  /** The counter refused: three rounds are all there are. */
  | { readonly kind: "budget_exhausted"; readonly message: string }
  | { readonly kind: "round_open"; readonly message: string }
  /** Nothing is confirmed yet, so there is no record to ask questions about. */
  | { readonly kind: "no_material"; readonly message: string }
  | { readonly kind: "refused"; readonly category?: string }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly message: string;
    };

/**
 * Run one clarification round end to end: case file → stage → persisted round.
 *
 * Never throws. The budget refusals come back as values because they are
 * answers the screen renders, not bugs — and they are checked twice, once here
 * before a token is spent and once again inside the write transaction, where
 * the decision actually binds.
 */
export async function runClarificationRound(
  db: Db,
  caseId: string,
  options: { readonly llm?: RunStageOptions } = {},
): Promise<ClarificationRunResult> {
  const board = readClarification(db, caseId);

  if (board.openRound !== null) {
    return {
      kind: "round_open",
      message:
        `Round ${board.openRound.roundNumber} is still waiting for answers. ` +
        `The next round is written from them.`,
    };
  }
  if (board.roundsUsed >= MAX_CLARIFICATION_ROUNDS) {
    return {
      kind: "budget_exhausted",
      message:
        `Clarification is capped at ${MAX_CLARIFICATION_ROUNDS} rounds and ` +
        `this case has used all ${board.roundsUsed}. What is not known by now ` +
        `stays not known, and the analysis has to say so.`,
    };
  }

  const roundNumber = board.roundsUsed + 1;
  const { prompt, file } = buildClarificationPrompt(db, caseId, roundNumber);

  if (file.utterances.length === 0) {
    return {
      kind: "no_material",
      message:
        "Nothing in this case has been confirmed yet, so there is no record " +
        "to ask questions about. Confirm the transcription first.",
    };
  }

  const result = await runStage(
    clarificationQuestionsStage,
    { prompt, dict: buildCaseDict(db, caseId), caseId },
    { db, ...options.llm },
  );

  if (result.kind === "refused") {
    return result.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: result.category };
  }
  if (result.kind === "error") {
    return { kind: "error", retryable: result.retryable, message: result.message };
  }

  try {
    const recorded = recordClarificationRound(db, {
      caseId,
      questions: result.data.questions.map((question) => ({
        question: question.question,
        targetsClaim: question.targets_claim,
        whyNeeded: question.why_needed,
      })),
      canProceed: result.data.can_proceed,
    });
    return {
      kind: "ok",
      round: recorded.round,
      asked: recorded.asked,
      dropped: recorded.dropped,
      canProceed: result.data.can_proceed,
      meta: result.meta,
    };
  } catch (cause) {
    // A round opened between the pre-flight check and the write. The counter
    // inside the transaction is the one that binds; report what it said.
    if (cause instanceof ClarificationError) {
      return cause.code === "budget_exhausted"
        ? { kind: "budget_exhausted", message: cause.message }
        : { kind: "round_open", message: cause.message };
    }
    /* c8 ignore next -- anything else here is a bug, not an answer. */
    throw cause;
  }
}
