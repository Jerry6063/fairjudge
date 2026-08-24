/**
 * The front door (04-ux-design-plan.md §4.1).
 *
 * Nobody real is filed here. The two parties are fixture personas with invented
 * names, and every database in this file is in-memory — a case record about a
 * real person is not a test fixture (CLAUDE.md, Verification rule).
 *
 * Four properties, each attacked at the layer that has to keep it:
 *
 *   1. **Filing makes a case that exists at stage ①.** Not at `evidence_intake`,
 *      where the seed importer starts: the safety screen lives in stage ① and
 *      nothing may skip past it by being created somewhere else.
 *   2. **Both names are registered in the pseudonym dictionary** (HARD RULE #3).
 *      Asserted through `buildCaseDict` + `pseudonymize`, the same pair the
 *      egress path uses — a page that happens to store a name is a convention,
 *      and a dictionary that masks it is the thing the rule is about.
 *   3. **What the client asked for is on file**, including the answer the
 *      product refuses to deliver from one account.
 *   4. **The account is material held to everybody else's rules**: a
 *      recollection, graded by rule, one `pending` utterance per line, so
 *      nothing in it is citable until it is confirmed (HARD RULE #1).
 *
 * Plus the form's own refusal: `/case/new`'s action rejects a blank party name
 * rather than filing a case whose dictionary has a hole in it.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileCaseAction } from "../src/app/case/new/actions";
import {
  CaseCreationError,
  INITIATOR_PSEUDONYM,
  RESPONDENT_PSEUDONYM,
  createCase,
  listCases,
  readCaseParties,
  readClientIntent,
} from "../src/server/cases";
import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases, evidence, utterances } from "../src/server/db/schema";
import { buildCaseDict } from "../src/server/evidence/anomaly";
import { pseudonymize } from "../src/server/pseudonym";

/** Invented people. Neither name belongs to anybody. */
const CLIENT_NAME = "FIXTURE_CLIENT";
const COUNTERPARTY_NAME = "FIXTURE_RESPONDENT";
const TITLE = "The July argument about the hospital visit";
const ACCOUNT = "She said she would call and did not.\n\nI waited at the gate.";
const FIRST_LINE = "She said she would call and did not.";
const SECOND_LINE = "I waited at the gate.";

let db: Db;
let sqlite: Database.Database;

function file(overrides: Partial<Parameters<typeof createCase>[1]> = {}) {
  return createCase(db, {
    title: TITLE,
    intent: "allocate_fault",
    clientName: CLIENT_NAME,
    counterpartyName: COUNTERPARTY_NAME,
    account: ACCOUNT,
    ...overrides,
  });
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

describe("createCase — the case and its stage", () => {
  it("creates a case at stage intake, open, with no level locked", () => {
    const created = file();

    const [row] = db
      .select()
      .from(cases)
      .where(eq(cases.id, created.caseId))
      .all();

    expect(row.stage).toBe("intake");
    expect(row.title).toBe(TITLE);
    expect(row.status).toBe("open");
    // HARD RULE #2 — the level is derived from a record, and there is no record
    // yet. A case that arrived pre-levelled would be one the derivation never saw.
    expect(row.outputLevel).toBeNull();
    expect(row.outputLevelLockedAt).toBeNull();
    expect(row.stageEnteredAt).not.toBeNull();
  });

  it("does not mark a filed case as a demonstration fixture", () => {
    const created = file();
    const [row] = db
      .select({ isFixture: cases.isFixture })
      .from(cases)
      .where(eq(cases.id, created.caseId))
      .all();
    expect(row.isFixture).toBe(false);
  });

  it("trims the title and both names before storing them", () => {
    const created = file({
      title: "  Spaced out  ",
      clientName: "  FIXTURE_CLIENT ",
      counterpartyName: " FIXTURE_RESPONDENT  ",
    });

    const [row] = db
      .select({ title: cases.title })
      .from(cases)
      .where(eq(cases.id, created.caseId))
      .all();
    expect(row.title).toBe("Spaced out");

    const names = readCaseParties(db, created.caseId).map(
      (party) => party.displayName,
    );
    expect(names).toContain(CLIENT_NAME);
    expect(names).toContain(COUNTERPARTY_NAME);
  });

  it("shows up in the case list with what the list renders", () => {
    const created = file();
    const [item] = listCases(db);
    expect(item.id).toBe(created.caseId);
    expect(item.title).toBe(TITLE);
    expect(item.stage).toBe("intake");
    expect(item.outputLevel).toBeNull();
    expect(item.status).toBe("open");
    expect(item.isFixture).toBe(false);
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  it("labels an authored demonstration case as a fixture", () => {
    file({ isFixture: true });
    const [item] = listCases(db);
    expect(item.isFixture).toBe(true);
  });
});

describe("createCase — pseudonym registration (HARD RULE #3)", () => {
  it("registers both parties with their roles and pseudonyms", () => {
    const created = file();
    const parties = readCaseParties(db, created.caseId);

    expect(parties).toHaveLength(2);
    const client = parties.find((party) => party.role === "initiator")!;
    const counterparty = parties.find((party) => party.role === "respondent")!;

    expect(client.displayName).toBe(CLIENT_NAME);
    expect(client.pseudonym).toBe(INITIATOR_PSEUDONYM);
    expect(counterparty.displayName).toBe(COUNTERPARTY_NAME);
    expect(counterparty.pseudonym).toBe(RESPONDENT_PSEUDONYM);
  });

  it("makes both names maskable by the egress dictionary immediately", () => {
    const created = file();

    // The pair the egress path actually uses: the dictionary built from the
    // participant rows, and the substitution run over text.
    const dict = buildCaseDict(db, created.caseId);
    const { text, hits } = pseudonymize(
      `${CLIENT_NAME} said ${COUNTERPARTY_NAME} never called.`,
      dict,
    );

    expect(text).toBe(
      `${INITIATOR_PSEUDONYM} said ${RESPONDENT_PSEUDONYM} never called.`,
    );
    expect(text).not.toContain(CLIENT_NAME);
    expect(text).not.toContain(COUNTERPARTY_NAME);
    expect(hits).toHaveLength(2);
  });

  it("refuses a blank name rather than registering half a dictionary", () => {
    expect(() => file({ counterpartyName: "   " })).toThrow(CaseCreationError);

    // And nothing was written: a refused filing leaves no case behind.
    expect(listCases(db)).toHaveLength(0);
  });

  it("refuses two parties sharing one name", () => {
    expect(() => file({ counterpartyName: CLIENT_NAME })).toThrow(
      /maps one name to one person/,
    );
    expect(listCases(db)).toHaveLength(0);
  });
});

describe("createCase — the stated intent", () => {
  it("persists the answer, including the one that cannot be delivered", () => {
    const created = file({ intent: "allocate_fault" });
    expect(readClientIntent(db, created.caseId)).toBe("allocate_fault");
  });

  it("persists each of the three answers as given", () => {
    for (const intent of [
      "understand_what_happened",
      "allocate_fault",
      "prevent_recurrence",
    ] as const) {
      const created = file({ intent });
      expect(readClientIntent(db, created.caseId)).toBe(intent);
    }
  });

  it("refuses an intent that is not one of the three", () => {
    expect(() => file({ intent: "settle_it_for_me" as never })).toThrow(
      CaseCreationError,
    );
    expect(listCases(db)).toHaveLength(0);
  });

  it("leaves the intent null on a case created without the question", () => {
    const [row] = db
      .insert(cases)
      .values({ stage: "intake", title: "Filed by a script" })
      .returning({ id: cases.id })
      .all();
    expect(readClientIntent(db, row.id)).toBeNull();
  });
});

describe("createCase — the first account", () => {
  it("stores it as a graded recollection owned by the client", () => {
    const created = file();

    const [item] = db
      .select()
      .from(evidence)
      .where(eq(evidence.id, created.evidenceId))
      .all();

    expect(item.sourceType).toBe("recollection");
    // Graded by rule, never by whoever typed it.
    expect(item.gradeSuggested).toBe("B");
    expect(item.gradeFinal).toBe("B");
    expect(item.ownerParticipantId).toBe(created.clientParticipantId);
    expect(item.visibility).toBe("private");
    expect(item.contentSummary).toContain(FIRST_LINE);
  });

  it("splits it into one pending utterance per line, verbatim", () => {
    const created = file();

    const lines = db
      .select()
      .from(utterances)
      .where(eq(utterances.evidenceId, created.evidenceId))
      .all()
      .sort((a, b) => ((a.orderKey ?? "") < (b.orderKey ?? "") ? -1 : 1));

    expect(created.utteranceIds).toHaveLength(2);
    expect(lines.map((line) => line.humanFinal)).toEqual([
      FIRST_LINE,
      SECOND_LINE,
    ]);
    // HARD RULE #1 — typed is not confirmed, so none of it is citable yet.
    expect(lines.every((line) => line.confirmStatus === "pending")).toBe(true);
    // The label that egresses is the pseudonym, not the name.
    expect(lines.every((line) => line.speakerLabel === INITIATOR_PSEUDONYM)).toBe(
      true,
    );
    expect(
      lines.every(
        (line) => line.speakerParticipantId === created.clientParticipantId,
      ),
    ).toBe(true);
    // HARD RULE #5 is a claim about quoting somebody else from memory, and this
    // form does not make it line by line.
    expect(lines.every((line) => line.isRetold === false)).toBe(true);
  });

  it("refuses an empty account and writes nothing", () => {
    expect(() => file({ account: "   \n\n  " })).toThrow(CaseCreationError);
    expect(listCases(db)).toHaveLength(0);
    expect(db.select().from(evidence).all()).toHaveLength(0);
  });
});

describe("/case/new's action", () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }

  const VALID = {
    title: TITLE,
    intent: "allocate_fault",
    clientName: CLIENT_NAME,
    counterpartyName: COUNTERPARTY_NAME,
    account: ACCOUNT,
  };

  it("rejects a blank counterparty name, naming the field", async () => {
    const result = await fileCaseAction(
      null,
      form({ ...VALID, counterpartyName: "" }),
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("counterpartyName");
    expect(result!.code).toBe("empty_party_name");
    // The copy says why the machine needs it, not that a field is required.
    expect(result!.message).toMatch(/register/i);
  });

  it("rejects a blank client name, naming the field", async () => {
    const result = await fileCaseAction(
      null,
      form({ ...VALID, clientName: "   " }),
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("clientName");
    expect(result!.code).toBe("empty_party_name");
  });

  it("rejects a missing intent before it asks for anything else", async () => {
    const result = await fileCaseAction(null, form({ ...VALID, intent: "" }));
    expect(result!.field).toBe("intent");
    expect(result!.code).toBe("unknown_intent");
  });
});
