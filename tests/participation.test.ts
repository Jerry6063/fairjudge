/**
 * Counterparty participation (M3 wave A, stage ⑥).
 *
 * The module is one read and one write, and both of them exist to serve a gate
 * somewhere else: the stage machine refuses to enter issue fixing while the
 * counterparty is `pending`. So what is worth asserting is not that a column can
 * be written — it is that the row this module writes is the same row
 * `collectCaseFacts` reads, and that the two agree about which participant the
 * counterparty is. If they ever disagree, the screen would settle a gate that
 * stays shut, which is the worst possible failure mode for a precondition: a
 * user doing the right thing and being told nothing happened.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  type ParticipationState,
} from "../src/server/db/schema";
import {
  PARTICIPATION_ANSWERS,
  PARTICIPATION_META,
  ParticipationError,
  collectCaseFacts,
  readParticipation,
  setCounterpartyParticipation,
} from "../src/server/pipeline";

let db: Db;
let sqlite: Database.Database;

/** A case with both parties, the respondent left at the default `pending`. */
function seedCase(): string {
  const [row] = db.insert(cases).values({ stage: "participation" }).returning().all();
  db.insert(caseParticipants)
    .values([
      {
        caseId: row.id,
        role: "initiator",
        displayName: "Adrian",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        displayName: "知夏",
        pseudonym: "甲",
        isSubmitter: false,
      },
    ])
    .run();
  return row.id;
}

function stateOf(caseId: string, pseudonym: string): ParticipationState {
  const found = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .find((p) => p.pseudonym === pseudonym);
  if (found === undefined) throw new Error(`no participant ${pseudonym}`);
  return found.participationState;
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

describe("the read model", () => {
  it("picks the non-submitter as the counterparty", () => {
    const caseId = seedCase();
    const board = readParticipation(db, caseId);

    expect(board.counterparty?.pseudonym).toBe("甲");
    expect(board.submitter?.pseudonym).toBe("乙");
  });

  it("is unsettled while the counterparty is pending", () => {
    const caseId = seedCase();
    expect(readParticipation(db, caseId).settled).toBe(false);
  });

  it("reports settled once an answer is recorded", () => {
    const caseId = seedCase();
    setCounterpartyParticipation(db, caseId, "refused");
    expect(readParticipation(db, caseId).settled).toBe(true);
  });

  it("returns a null counterparty rather than throwing on a one-party case", () => {
    const [row] = db.insert(cases).values({ stage: "intake" }).returning().all();
    const board = readParticipation(db, row.id);

    expect(board.counterparty).toBeNull();
    expect(board.settled).toBe(false);
  });
});

describe("recording an answer", () => {
  it("writes the counterparty and leaves the submitter alone", () => {
    const caseId = seedCase();
    setCounterpartyParticipation(db, caseId, "unaware");

    expect(stateOf(caseId, "甲")).toBe("unaware");
    expect(stateOf(caseId, "乙")).toBe("participating");
  });

  it("accepts every answer the screen offers", () => {
    const caseId = seedCase();
    for (const answer of PARTICIPATION_ANSWERS) {
      setCounterpartyParticipation(db, caseId, answer);
      expect(stateOf(caseId, "甲")).toBe(answer);
    }
  });

  it("refuses a case with no second party", () => {
    const [row] = db.insert(cases).values({ stage: "intake" }).returning().all();

    expect(() => setCounterpartyParticipation(db, row.id, "refused")).toThrow(
      ParticipationError,
    );
  });
});

describe("the gate it exists to open", () => {
  it("is the same row the stage machine reads", () => {
    const caseId = seedCase();
    expect(collectCaseFacts(db, caseId).counterpartyParticipation).toBe("pending");

    setCounterpartyParticipation(db, caseId, "unreachable");

    // The precondition on `issue_framing` is "settled and not pending"; this is
    // the assertion that the screen and the gate are looking at one column.
    expect(collectCaseFacts(db, caseId).counterpartyParticipation).toBe(
      "unreachable",
    );
  });
});

describe("the vocabulary", () => {
  it("excludes pending — the absence of an answer is not one of them", () => {
    expect(PARTICIPATION_ANSWERS).not.toContain("pending");
  });

  it("has copy for every state the column can hold, pending included", () => {
    const described = Object.keys(PARTICIPATION_META);
    for (const answer of PARTICIPATION_ANSWERS) {
      expect(described).toContain(answer);
    }
    expect(described).toContain("pending");
  });
});
