/**
 * The clarification loop FSM (M3 wave A ③) — HARD RULE #4.
 *
 * The budget is ≤3 rounds × ≤3 questions, and the point of this file is that
 * **server-side counters** enforce it, not the schema. So the mechanism is
 * driven directly, with no model anywhere near it: `recordClarificationRound`
 * is handed a fourth round and refuses, and is handed five questions and writes
 * three. If `clarificationQuestionsSchema.max(3)` were deleted tomorrow, every
 * assertion below would still pass — which is what "the schema is a backstop,
 * not the mechanism" has to mean to be worth writing down.
 *
 * The last group asserts the other half of what a round is built from: the case
 * file handed to the stage contains confirmed material and nothing else, so an
 * unconfirmed line is not merely uncitable (HARD RULE #1), it is absent from
 * the bytes the model is shown.
 *
 * The Anthropic SDK is mocked module-wide; nothing here touches the network.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  caseParticipants,
  cases,
  clarificationRounds,
  events,
  utterances,
  type ConfirmStatus,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  CLARIFICATION_BUDGET,
  ClarificationError,
  answerClarificationQuestion,
  assembleCaseFile,
  buildClarificationPrompt,
  markClarificationSaturated,
  readClarification,
  recordClarificationRound,
  runClarificationRound,
  withinQuestionBudget,
  type DraftQuestion,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

/** Utterance content is evidence: it stays in the language it was said in. */
const CONFIRMED_LINE = "行行行，你说得都对";
const EDITED_LINE = "你会先跟我讲吗？";
const PENDING_LINE = "这句还没有人确认过";
const REJECTED_LINE = "这句被审阅者删掉了";

function seedCase(): string {
  const [row] = db.insert(cases).values({ stage: "clarification" }).returning().all();
  db.insert(caseParticipants)
    .values([
      {
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
        participationState: "pending",
      },
    ])
    .run();
  return row.id;
}

function addUtterance(
  caseId: string,
  text: string,
  confirmStatus: ConfirmStatus,
): string {
  const [row] = db
    .insert(utterances)
    .values({
      caseId,
      aiDraft: text,
      humanFinal: confirmStatus === "edited" ? text : null,
      confirmStatus,
      speakerLabel: "甲",
    })
    .returning()
    .all();
  return row.id;
}

/** A case with one confirmed line, so the record can carry a round. */
function seedAnsweredCase(): string {
  const caseId = seedCase();
  addUtterance(caseId, CONFIRMED_LINE, "confirmed");
  db.insert(events).values({ caseId, title: "The argument", inTimeline: true }).run();
  return caseId;
}

function draft(n: number): DraftQuestion[] {
  return Array.from({ length: n }, (_, at) => ({
    question: `Question ${at + 1}: what happened next?`,
    targetsClaim: `U1 — “${CONFIRMED_LINE}”`,
    whyNeeded: `Reason ${at + 1}.`,
  }));
}

function storedQuestions(caseId: string, roundNumber: number) {
  const row = db
    .select()
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .all()
    .find((r) => r.roundNumber === roundNumber);
  return row?.questions ?? [];
}

/* -------------------------------------------------------------------------- */
/* Model plumbing                                                             */
/* -------------------------------------------------------------------------- */

function anthropicResponse(payload: unknown) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_FABLE,
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    _request_id: "req_test",
  };
}

function questionPayload(n: number, canProceed = false) {
  return {
    questions: Array.from({ length: n }, (_, at) => ({
      question: `Model question ${at + 1}?`,
      targets_claim: `U1 — “${CONFIRMED_LINE}”`,
      why_needed: `Because ${at + 1}.`,
    })),
    can_proceed: canProceed,
  };
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
  createMock.mockReset();
  betaCreateMock.mockReset();
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* The round counter                                                          */
/* -------------------------------------------------------------------------- */

describe("the round counter (HARD RULE #4: ≤3 rounds)", () => {
  it("refuses a fourth round in server code, and writes nothing", () => {
    const caseId = seedAnsweredCase();

    for (let round = 1; round <= CLARIFICATION_BUDGET.maxRounds; round += 1) {
      const recorded = recordClarificationRound(db, {
        caseId,
        questions: draft(1),
      });
      expect(recorded.round.roundNumber).toBe(round);
      answerClarificationQuestion(db, {
        caseId,
        roundId: recorded.round.id,
        questionId: recorded.round.questions[0].id,
        answer: "我记得他先走的",
      });
    }

    expect(() =>
      recordClarificationRound(db, { caseId, questions: draft(1) }),
    ).toThrowError(ClarificationError);

    try {
      recordClarificationRound(db, { caseId, questions: draft(1) });
      expect.unreachable("a fourth round must be refused");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ClarificationError);
      expect((cause as ClarificationError).code).toBe("budget_exhausted");
    }

    const rows = db
      .select()
      .from(clarificationRounds)
      .where(eq(clarificationRounds.caseId, caseId))
      .all();
    expect(rows).toHaveLength(CLARIFICATION_BUDGET.maxRounds);
    expect(readClarification(db, caseId).canAskAnother).toBe(false);
  });

  it("refuses a fourth round on the model path too, before spending a token", async () => {
    const caseId = seedAnsweredCase();
    for (let round = 1; round <= 3; round += 1) {
      const recorded = recordClarificationRound(db, { caseId, questions: [] });
      expect(recorded.round.open).toBe(false);
    }

    const result = await runClarificationRound(db, caseId);

    expect(result.kind).toBe("budget_exhausted");
    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(
      db.select().from(clarificationRounds).where(eq(clarificationRounds.caseId, caseId)).all(),
    ).toHaveLength(3);
  });

  it("will not open a second round while one is still unanswered", async () => {
    const caseId = seedAnsweredCase();
    recordClarificationRound(db, { caseId, questions: draft(2) });

    expect(() =>
      recordClarificationRound(db, { caseId, questions: draft(1) }),
    ).toThrowError(/still waiting for answers/);

    const result = await runClarificationRound(db, caseId);
    expect(result.kind).toBe("round_open");
    expect(betaCreateMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The question counter                                                       */
/* -------------------------------------------------------------------------- */

describe("the question counter (HARD RULE #4: ≤3 questions per round)", () => {
  it("refuses a fourth question in one round, and says that it did", () => {
    const caseId = seedAnsweredCase();

    const recorded = recordClarificationRound(db, { caseId, questions: draft(4) });

    expect(recorded.asked).toBe(3);
    expect(recorded.dropped).toBe(1);
    expect(recorded.round.questions).toHaveLength(3);
    expect(storedQuestions(caseId, 1)).toHaveLength(3);
    // The fourth was never written, so there is no id to answer it with.
    expect(recorded.round.questions.map((q) => q.id)).toEqual([
      "r1q1",
      "r1q2",
      "r1q3",
    ]);
    expect(() =>
      answerClarificationQuestion(db, {
        caseId,
        roundId: recorded.round.id,
        questionId: "r1q4",
        answer: "试图回答第四个问题",
      }),
    ).toThrowError(/not part of this round/);
  });

  it("keeps three when the model returns five — the counter, not the schema", () => {
    const caseId = seedAnsweredCase();

    // Exactly what a model answer with five questions turns into once it
    // reaches persistence. Nothing validated this list; the cap did the work.
    const recorded = recordClarificationRound(db, { caseId, questions: draft(5) });

    expect(recorded.asked).toBe(3);
    expect(recorded.dropped).toBe(2);
    expect(storedQuestions(caseId, 1)).toHaveLength(3);
  });

  it("caps a five-question generation end to end, whichever layer catches it", async () => {
    const caseId = seedAnsweredCase();
    betaCreateMock.mockResolvedValue(anthropicResponse(questionPayload(5)));

    const result = await runClarificationRound(db, caseId);

    // In practice the schema backstop fires first (the gateway re-validates
    // with zod and the run fails), so nothing is written at all. Either way the
    // invariant the rule cares about holds: no round on this case holds more
    // than three questions, and a five-question round exists nowhere.
    const rows = db
      .select()
      .from(clarificationRounds)
      .where(eq(clarificationRounds.caseId, caseId))
      .all();
    for (const row of rows) {
      expect((row.questions ?? []).length).toBeLessThanOrEqual(
        CLARIFICATION_BUDGET.maxQuestionsPerRound,
      );
    }
    expect(result.kind).not.toBe("ok");
  });

  it("drops blank questions before the cap, not after", () => {
    const kept = withinQuestionBudget([
      { question: "  " },
      { question: "One?" },
      { question: "" },
      { question: "Two?" },
      { question: "Three?" },
      { question: "Four?" },
    ]);
    expect(kept.kept.map((q) => q.question)).toEqual(["One?", "Two?", "Three?"]);
    expect(kept.dropped).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Answering and closing                                                      */
/* -------------------------------------------------------------------------- */

describe("answering a round", () => {
  it("closes the round when the last answer lands, then allows the next", async () => {
    const caseId = seedAnsweredCase();
    betaCreateMock.mockResolvedValue(anthropicResponse(questionPayload(3)));

    const run = await runClarificationRound(db, caseId);
    expect(run.kind).toBe("ok");
    if (run.kind !== "ok") return;
    expect(run.round.roundNumber).toBe(1);
    expect(run.asked).toBe(3);
    expect(run.dropped).toBe(0);

    const [first, second, third] = run.round.questions;
    answerClarificationQuestion(db, {
      caseId,
      roundId: run.round.id,
      questionId: first.id,
      answer: "第一个回答",
    });
    answerClarificationQuestion(db, {
      caseId,
      roundId: run.round.id,
      questionId: second.id,
      answer: "第二个回答",
    });
    expect(readClarification(db, caseId).openRound?.answered).toBe(2);
    expect(readClarification(db, caseId).canAskAnother).toBe(false);

    const closed = answerClarificationQuestion(db, {
      caseId,
      roundId: run.round.id,
      questionId: third.id,
      answer: "第三个回答",
    });
    expect(closed.open).toBe(false);
    expect(closed.closedAt).not.toBeNull();

    const board = readClarification(db, caseId);
    expect(board.roundsUsed).toBe(1);
    expect(board.roundsRemaining).toBe(2);
    expect(board.canAskAnother).toBe(true);
    // The answers are stored verbatim — they are the user's own words.
    expect(board.rounds[0].questions[0].answer).toBe("第一个回答");
  });

  it("refuses a blank answer and an answer to a closed round", () => {
    const caseId = seedAnsweredCase();
    const recorded = recordClarificationRound(db, { caseId, questions: draft(1) });
    const questionId = recorded.round.questions[0].id;

    expect(() =>
      answerClarificationQuestion(db, {
        caseId,
        roundId: recorded.round.id,
        questionId,
        answer: "   ",
      }),
    ).toThrowError(/not an answer/);

    answerClarificationQuestion(db, {
      caseId,
      roundId: recorded.round.id,
      questionId,
      answer: "他当时在开车",
    });
    expect(() =>
      answerClarificationQuestion(db, {
        caseId,
        roundId: recorded.round.id,
        questionId,
        answer: "其实我想改一下",
      }),
    ).toThrowError(/closed/);
  });

  it("settles the loop when a round adds nothing new", () => {
    const caseId = seedAnsweredCase();
    const recorded = recordClarificationRound(db, { caseId, questions: draft(1) });
    answerClarificationQuestion(db, {
      caseId,
      roundId: recorded.round.id,
      questionId: recorded.round.questions[0].id,
      answer: "没有别的了",
    });
    expect(readClarification(db, caseId).settled).toBe(false);

    markClarificationSaturated(db, { caseId, roundId: recorded.round.id });

    const board = readClarification(db, caseId);
    expect(board.settled).toBe(true);
    // Settled is not the same question as exhausted: two rounds are still there
    // if the user wants them.
    expect(board.canAskAnother).toBe(true);
  });

  it("treats a round with nothing worth asking as a closed round", () => {
    const caseId = seedAnsweredCase();
    const recorded = recordClarificationRound(db, {
      caseId,
      questions: [],
      canProceed: true,
    });
    expect(recorded.asked).toBe(0);
    expect(recorded.round.open).toBe(false);
    expect(readClarification(db, caseId).settled).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* What the prompt is built from (HARD RULE #1, on the way in)                */
/* -------------------------------------------------------------------------- */

describe("the case file the round is written from", () => {
  it("contains zero unconfirmed utterances", () => {
    const caseId = seedCase();
    addUtterance(caseId, CONFIRMED_LINE, "confirmed");
    addUtterance(caseId, EDITED_LINE, "edited");
    addUtterance(caseId, PENDING_LINE, "pending");
    addUtterance(caseId, REJECTED_LINE, "rejected");

    const file = assembleCaseFile(db, caseId);
    const texts = file.utterances.map((u) => u.text);

    expect(texts).toContain(CONFIRMED_LINE);
    expect(texts).toContain(EDITED_LINE);
    expect(texts).not.toContain(PENDING_LINE);
    expect(texts).not.toContain(REJECTED_LINE);
    expect(file.utterances).toHaveLength(2);

    // Not merely absent from the list — absent from the bytes the stage is
    // handed. An unconfirmed line cannot be cited because it was never shown.
    const { prompt } = buildClarificationPrompt(db, caseId, 1);
    expect(prompt).toContain(CONFIRMED_LINE);
    expect(prompt).toContain(EDITED_LINE);
    expect(prompt).not.toContain(PENDING_LINE);
    expect(prompt).not.toContain(REJECTED_LINE);

    // Every handle in the table points at a row a human signed off.
    for (const [, id] of file.utteranceRefs) {
      const row = db.select().from(utterances).where(eq(utterances.id, id)).get();
      expect(["confirmed", "edited"]).toContain(row?.confirmStatus);
    }
  });

  it("serializes byte-stably, so the cache prefix survives a second assembly", () => {
    const caseId = seedAnsweredCase();
    const first = buildClarificationPrompt(db, caseId, 1).prompt;
    const second = buildClarificationPrompt(db, caseId, 1).prompt;
    expect(second).toBe(first);
    expect(first).not.toMatch(/created_at|updated_at/);
  });

  it("refuses to run a round on a case with nothing confirmed", async () => {
    const caseId = seedCase();
    addUtterance(caseId, PENDING_LINE, "pending");

    const result = await runClarificationRound(db, caseId);

    expect(result.kind).toBe("no_material");
    expect(betaCreateMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Gateway outcomes                                                           */
/* -------------------------------------------------------------------------- */

describe("what a failed generation does", () => {
  it("opens no round when the model refuses", async () => {
    const caseId = seedAnsweredCase();
    betaCreateMock.mockResolvedValue({
      ...anthropicResponse(questionPayload(1)),
      stop_reason: "refusal",
      stop_details: { category: "general_harms" },
      content: [],
    });

    const result = await runClarificationRound(db, caseId);

    expect(result.kind).toBe("refused");
    expect(readClarification(db, caseId).roundsUsed).toBe(0);
  });

  it("opens no round on a transport failure", async () => {
    const caseId = seedAnsweredCase();
    betaCreateMock.mockRejectedValue(new Error("socket hang up"));

    const result = await runClarificationRound(db, caseId);

    expect(result.kind).toBe("error");
    expect(readClarification(db, caseId).roundsUsed).toBe(0);
  });
});
