/**
 * Steelmanning (M3 wave A ④).
 *
 * Two things are under test, and neither of them is "does the prose read well".
 *
 *   1. **The other side is argued from the record or not at all** (HARD RULE
 *      #1). Every `grounded_in` ref is resolved against the case file's handle
 *      table, which only ever contains confirmed rows. A ref that is not a live
 *      handle — invented, or the real id of a line nobody confirmed — rejects
 *      the whole generation. Nothing is persisted with the bad point quietly
 *      removed, because that is how a failure disappears into a plausible page.
 *   2. **Failing to produce one is recorded, not swallowed.** A refusal, a
 *      `can_produce: false`, and a user who cannot recognize the other party
 *      each set `cases.downgrade_signal` with a reason. Output-level derivation
 *      reads it later; the judgment has to disclose it.
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
  steelmanVersions,
  utterances,
  type ConfirmStatus,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  STEELMAN_DOWNGRADE_PREFIX,
  SteelmanError,
  assembleCaseFile,
  generateSteelman,
  readSteelman,
  recordSteelmanVerdict,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

/** Evidence: stays in the language it was said in, here and everywhere. */
const CONFIRMED_LINE = "你会先跟我讲吗？";
const RETOLD_LINE = "他说他早就跟我讲过两次了";
const PENDING_LINE = "这句还没有人确认过";

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
  options: { isRetold?: boolean } = {},
): string {
  const [row] = db
    .insert(utterances)
    .values({
      caseId,
      aiDraft: text,
      confirmStatus,
      speakerLabel: "甲",
      isRetold: options.isRetold ?? false,
    })
    .returning()
    .all();
  return row.id;
}

/** One confirmed line, so the case file has exactly one handle: `U1`. */
function seedArguableCase(): string {
  const caseId = seedCase();
  addUtterance(caseId, CONFIRMED_LINE, "confirmed");
  return caseId;
}

function caseRow(caseId: string) {
  return db.select().from(cases).where(eq(cases.id, caseId)).get();
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

/** A well-formed steelman citing `refs`. */
function steelmanPayload(refs: readonly string[]) {
  return {
    can_produce: true,
    unable_reason: null,
    headline:
      "They would say they were being asked to prove something they had " +
      "already answered.",
    account: [
      {
        point: "They had already given an answer and were asked again.",
        grounded_in: [...refs],
      },
    ],
    most_likely_rebuttals: [
      {
        your_claim: "That they never took the question seriously.",
        their_answer: "They would say they answered it the first time.",
        grounded_in: [...refs],
      },
    ],
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
/* Grounding (HARD RULE #1)                                                   */
/* -------------------------------------------------------------------------- */

describe("grounding the other side's case", () => {
  it("persists a version whose points resolve to confirmed lines", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue(anthropicResponse(steelmanPayload(["U1"])));

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.steelman.version).toBe(1);
    expect(result.steelman.verdict).toBe("pending");
    expect(result.steelman.confirmStatus).toBe("pending");

    const draft = result.steelman.aiDraft ?? "";
    // The quote itself, not the per-assembly handle that briefly stood for it.
    expect(draft).toContain(CONFIRMED_LINE);
    expect(draft).not.toContain("U1");
    expect(draft).toContain("What they would most likely rebut");
    expect(caseRow(caseId)?.downgradeSignal).toBe(false);
  });

  it("renders a recollection as a recollection (HARD RULE #5)", async () => {
    const caseId = seedCase();
    addUtterance(caseId, RETOLD_LINE, "confirmed", { isRetold: true });
    betaCreateMock.mockResolvedValue(anthropicResponse(steelmanPayload(["U1"])));

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.steelman.aiDraft).toContain("as you recall it");
    expect(result.steelman.aiDraft).toContain(RETOLD_LINE);
  });

  it("rejects the whole generation over one invented ref", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue(
      anthropicResponse(steelmanPayload(["U1", "U99"])),
    );

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("invalid_refs");
    if (result.kind !== "invalid_refs") return;
    expect(result.attempts).toBe(2);
    expect(result.message).toContain("U99");
    // Not persisted with the bad point stripped. Not persisted at all.
    expect(db.select().from(steelmanVersions).all()).toHaveLength(0);
  });

  it("rejects a ref pointing at an unconfirmed line, even a real id", async () => {
    const caseId = seedArguableCase();
    const pendingId = addUtterance(caseId, PENDING_LINE, "pending");

    // The id exists in the database; it is simply not citable, so it never got
    // a handle. Citing it is the same failure as inventing one.
    betaCreateMock.mockResolvedValue(
      anthropicResponse(steelmanPayload([pendingId])),
    );

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("invalid_refs");
    expect(db.select().from(steelmanVersions).all()).toHaveLength(0);
    // And it never saw the line in the first place.
    const file = assembleCaseFile(db, caseId);
    expect(file.utterances.map((u) => u.text)).not.toContain(PENDING_LINE);
  });

  it("rejects a point that rests on nothing", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue(
      anthropicResponse({
        ...steelmanPayload(["U1"]),
        account: [{ point: "They were simply right.", grounded_in: ["U404"] }],
      }),
    );

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("invalid_refs");
    expect(db.select().from(steelmanVersions).all()).toHaveLength(0);
  });

  it("takes the retry: a second attempt that grounds itself is accepted", async () => {
    const caseId = seedArguableCase();
    betaCreateMock
      .mockResolvedValueOnce(anthropicResponse(steelmanPayload(["U7"])))
      .mockResolvedValue(anthropicResponse(steelmanPayload(["U1"])));

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.attempts).toBe(2);
    expect(db.select().from(steelmanVersions).all()).toHaveLength(1);
  });

  it("will not argue the other side from nothing", async () => {
    const caseId = seedCase();
    addUtterance(caseId, PENDING_LINE, "pending");

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("no_material");
    expect(betaCreateMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The downgrade signal                                                       */
/* -------------------------------------------------------------------------- */

describe("the downgrade signal", () => {
  it("records a steelman the model says it cannot write", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue(
      anthropicResponse({
        can_produce: false,
        unable_reason:
          "every line attributed to them is the submitter's recollection.",
        headline: "",
        account: [],
        most_likely_rebuttals: [],
      }),
    );

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("unable");
    if (result.kind !== "unable") return;
    expect(result.steelman.verdict).toBe("unable");

    const row = caseRow(caseId);
    expect(row?.downgradeSignal).toBe(true);
    expect(row?.downgradeReason).toContain(STEELMAN_DOWNGRADE_PREFIX);
    expect(row?.downgradeReason).toContain("recollection");
    // The empty answer is a record, not a gap: it is on the case as a version.
    expect(db.select().from(steelmanVersions).all()).toHaveLength(1);
  });

  it("records a refusal — the other side went unargued either way", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue({
      ...anthropicResponse(steelmanPayload(["U1"])),
      stop_reason: "refusal",
      stop_details: { category: "general_harms" },
      content: [],
    });

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("refused");
    expect(caseRow(caseId)?.downgradeSignal).toBe(true);
    expect(db.select().from(steelmanVersions).all()).toHaveLength(0);
  });

  it("does not downgrade on a transport failure — that says nothing about the record", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockRejectedValue(new Error("socket hang up"));

    const result = await generateSteelman(db, caseId);

    expect(result.kind).toBe("error");
    expect(caseRow(caseId)?.downgradeSignal).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The user's verdict                                                         */
/* -------------------------------------------------------------------------- */

describe("what the user answers to it", () => {
  async function generated(caseId: string) {
    betaCreateMock.mockResolvedValue(anthropicResponse(steelmanPayload(["U1"])));
    const result = await generateSteelman(db, caseId);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    return result.steelman;
  }

  it("accepts it: they would probably say roughly this", async () => {
    const caseId = seedArguableCase();
    const steelman = await generated(caseId);

    const answered = recordSteelmanVerdict(db, {
      caseId,
      steelmanId: steelman.id,
      answer: "accepted",
    });

    expect(answered.verdict).toBe("accepted");
    expect(answered.confirmStatus).toBe("confirmed");
    expect(answered.verdictAt).not.toBeNull();
    expect(readSteelman(db, caseId).answered).toBe(true);
    expect(caseRow(caseId)?.downgradeSignal).toBe(false);
  });

  it("rebuts it in the user's own words, without a downgrade", async () => {
    const caseId = seedArguableCase();
    const steelman = await generated(caseId);

    const answered = recordSteelmanVerdict(db, {
      caseId,
      steelmanId: steelman.id,
      answer: "rebutted",
      text: "他更可能会说：我当时根本没听见。",
    });

    expect(answered.verdict).toBe("rebutted");
    expect(answered.confirmStatus).toBe("edited");
    expect(answered.rebuttal).toBe("他更可能会说：我当时根本没听见。");
    expect(answered.humanFinal).toBe("他更可能会说：我当时根本没听见。");
    expect(caseRow(caseId)?.downgradeSignal).toBe(false);

    expect(() =>
      recordSteelmanVerdict(db, {
        caseId,
        steelmanId: steelman.id,
        answer: "rebutted",
        text: "   ",
      }),
    ).toThrowError(SteelmanError);
  });

  it("records 'I cannot recognize them in this' as a downgrade, not as agreement", async () => {
    const caseId = seedArguableCase();
    const steelman = await generated(caseId);

    const answered = recordSteelmanVerdict(db, {
      caseId,
      steelmanId: steelman.id,
      answer: "unable",
    });

    expect(answered.verdict).toBe("unable");
    const row = caseRow(caseId);
    expect(row?.downgradeSignal).toBe(true);
    expect(row?.downgradeReason).toContain(STEELMAN_DOWNGRADE_PREFIX);

    const board = readSteelman(db, caseId);
    expect(board.answered).toBe(true);
    expect(board.downgradeSignal).toBe(true);

    // Terminal: the way back is a new version, not a second verdict on this one.
    expect(() =>
      recordSteelmanVerdict(db, {
        caseId,
        steelmanId: steelman.id,
        answer: "accepted",
      }),
    ).toThrowError(/set aside/);
  });

  it("lifts its own downgrade when a later version is accepted", async () => {
    const caseId = seedArguableCase();
    betaCreateMock.mockResolvedValue(
      anthropicResponse({
        can_produce: false,
        unable_reason: "nothing they said survives in this record.",
        headline: "",
        account: [],
        most_likely_rebuttals: [],
      }),
    );
    const first = await generateSteelman(db, caseId);
    expect(first.kind).toBe("unable");
    expect(caseRow(caseId)?.downgradeSignal).toBe(true);

    const second = await generated(caseId);
    expect(second.version).toBe(2);
    recordSteelmanVerdict(db, {
      caseId,
      steelmanId: second.id,
      answer: "accepted",
    });

    expect(caseRow(caseId)?.downgradeSignal).toBe(false);
    expect(caseRow(caseId)?.downgradeReason).toBeNull();
  });

  it("leaves a downgrade some other stage recorded exactly where it is", async () => {
    const caseId = seedArguableCase();
    const steelman = await generated(caseId);
    db.update(cases)
      .set({
        downgradeSignal: true,
        downgradeReason: "Participation: the other party was never reachable.",
      })
      .where(eq(cases.id, caseId))
      .run();

    recordSteelmanVerdict(db, {
      caseId,
      steelmanId: steelman.id,
      answer: "accepted",
    });

    const row = caseRow(caseId);
    expect(row?.downgradeSignal).toBe(true);
    expect(row?.downgradeReason).toBe(
      "Participation: the other party was never reachable.",
    );
  });

  it("refuses a verdict on a steelman that belongs to another case", async () => {
    const caseId = seedArguableCase();
    const steelman = await generated(caseId);
    const otherCase = seedArguableCase();

    expect(() =>
      recordSteelmanVerdict(db, {
        caseId: otherCase,
        steelmanId: steelman.id,
        answer: "accepted",
      }),
    ).toThrowError(/not on this case/);
  });
});
