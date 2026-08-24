/**
 * HARD RULE #3's two sentences about names, both of which were untrue.
 *
 * The rule says a registered person's name is replaced by their pseudonym, and
 * that an unregistered person name blocks egress. The acceptance walkthrough
 * found a prepared bundle carrying "…at the Ridgeway allotment with Nikhil…" in
 * clear, over a line asserting "The text is already pseudonymized", on a case
 * where Nikhil was a registered party. Two separate holes met there:
 *
 *   1. `buildCaseDict` registered `{canonical: displayName, variants: []}`. The
 *      dictionary therefore held the full name — the form nobody writes — and
 *      not the given name, which is the form everybody writes.
 *   2. `detectUnregisteredNames` was an M0 stub that reported residual PII and
 *      nothing else, so the rule's second sentence had no implementation at all.
 *
 * Both are fixed in the dictionary layer rather than at a call site, which is
 * what makes the fix reach the API path and the external-session path together:
 * `buildCaseDict` is the one builder in the product, and `prepareRequest` is the
 * one assembly. The last test here is the proof of that.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCase } from "../src/server/cases/create";
import { createDb, runMigrations, type Db } from "../src/server/db";
import { adverseFacts, cases } from "../src/server/db/schema";
import { buildCaseDict } from "../src/server/evidence/anomaly";
import { prepareRequest } from "../src/server/llm/claude";
import { prepareStage } from "../src/server/llm/external";
import { judgmentSkeletonStage } from "../src/server/llm/stages";
import {
  deriveNameFragments,
  detectUnregisteredNames,
  pseudonymize,
} from "../src/server/pseudonym";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/** A case whose parties have the kind of names a real filing carries. */
function seedCase(): string {
  const created = createCase(db, {
    title: "The allotment weekend",
    intent: "understand_what_happened",
    clientName: "Dara Osei",
    counterpartyName: "Nikhil Raman",
    account: "He said he would be back by seven and was not.",
  });
  // Enough for the judgment stage to be reachable, so the bundle tests are
  // testing the gateway rather than the stage machine.
  db.update(cases)
    .set({ stage: "judgment", outputLevel: "L2", outputLevelLockedAt: new Date() })
    .run();
  db.insert(adverseFacts)
    .values({
      caseId: created.caseId,
      aiDraft: "You did not send the message you said you would.",
      ackStatus: "acknowledged" as const,
    })
    .run();
  return created.caseId;
}

describe("deriveNameFragments", () => {
  it("splits a Latin name into the parts people actually say", () => {
    expect(deriveNameFragments("Nikhil Raman").sort()).toEqual([
      "Nikhil",
      "Raman",
    ]);
  });

  it("takes the given name off a Han name, for one- and two-character surnames", () => {
    expect(deriveNameFragments("顾明远")).toContain("明远");
    expect(deriveNameFragments("欧阳明远")).toContain("明远");
  });

  it("never derives a single character, which is a word far more often than a name", () => {
    expect(deriveNameFragments("知夏")).toEqual([]);
    expect(deriveNameFragments("Li Bo")).toEqual([]);
  });
});

describe("the dictionary a case is masked with", () => {
  it("registers each party's name fragments as variants", () => {
    const caseId = seedCase();

    const dict = buildCaseDict(db, caseId);
    const counterparty = dict.find((entry) => entry.canonical === "Nikhil Raman");

    expect(counterparty?.variants.sort()).toEqual(["Nikhil", "Raman"]);
  });

  it("substitutes a bare given name, and still prefers the full name when it is there", () => {
    const caseId = seedCase();
    const dict = buildCaseDict(db, caseId);

    expect(
      pseudonymize("at the Ridgeway allotment with Nikhil", dict).text,
    ).toBe("at the Ridgeway allotment with 甲");
    // Longest match first: the full name is never chopped into two hits.
    expect(pseudonymize("Nikhil Raman was there", dict).text).toBe(
      "甲 was there",
    );
  });
});

describe("the unregistered-name block", () => {
  it("blocks a person nobody registered", () => {
    const dict = buildCaseDict(db, seedCase());

    const warnings = detectUnregisteredNames(
      "She spent the afternoon with Priya and came back late.",
      dict,
    );

    expect(warnings.map((w) => w.kind)).toEqual(["unregistered_name"]);
    expect(warnings[0].original).toBe("Priya");
    expect(warnings[0].detail).toContain("not registered");
  });

  it("blocks on an attribution as well as an introduction", () => {
    const warnings = detectUnregisteredNames("Priya said she had waited.", []);
    expect(warnings.map((w) => w.original)).toEqual(["Priya"]);
  });

  it("says nothing about a registered person — that is the substitution layer's job", () => {
    const dict = buildCaseDict(db, seedCase());
    expect(detectUnregisteredNames("an evening with Nikhil", dict)).toEqual([]);
    expect(detectUnregisteredNames("an evening with Nikhil Raman", dict)).toEqual(
      [],
    );
  });

  it("does not fire on ordinary prose, which is the failure that turns a check off", () => {
    // Every one of these puts a capitalized word exactly where a name would go.
    // A block that fired here would be switched off within a day, and a block
    // that is off is worse than the leak it was written for.
    for (const text of [
      "Every claim must cite a confirmed utterance.",
      "Answer with the level you were given, and nothing about Their motives.",
      "The exchange ran from Monday to Wednesday.",
      "They said it was already settled.",
      "a message sent by Them, about This",
    ]) {
      expect(detectUnregisteredNames(text, [])).toEqual([]);
    }
  });

  it("still reports residual PII, which was all it used to do", () => {
    const warnings = detectUnregisteredNames("联系13812345678", []);
    expect(warnings.map((w) => w.kind)).toEqual(["residual_pii"]);
  });
});

describe("the gateway, on both channels", () => {
  it("hands out a bundle with the given name substituted, not carried", () => {
    const caseId = seedCase();

    const outcome = prepareStage(
      judgmentSkeletonStage,
      {
        prompt: "乙 says he was at the Ridgeway allotment with Nikhil that day.",
        caseId,
        dict: buildCaseDict(db, caseId),
      },
      { db },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.bundle.user).toContain("with 甲 that day");
    // The bytes that are hashed into the ledger are the bytes that left, so it
    // is the serialized bundle that has to be clean, not just the field.
    expect(outcome.json).not.toContain("Nikhil");
    expect(outcome.json).not.toContain("Dara");
  });

  it("blocks the bundle outright when a third party is named and unregistered", () => {
    const caseId = seedCase();

    const outcome = prepareStage(
      judgmentSkeletonStage,
      {
        prompt: "乙 says he was at the allotment with Priya that day.",
        caseId,
        dict: buildCaseDict(db, caseId),
      },
      { db },
    );

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("egress blocked by the pseudonymization gateway");
    expect(outcome.message).toContain("unregistered_name");
  });

  it("is the same hole and the same fix on the API path", () => {
    // `runStage` builds its request with `prepareRequest` and its dictionary
    // with `buildCaseDict` — the two functions under test here. Asserting on the
    // assembly is asserting on the API path: there is no second assembly for a
    // fix to be missing from, and no socket is opened to find that out.
    const caseId = seedCase();
    const dict = buildCaseDict(db, caseId);

    const masked = prepareRequest(judgmentSkeletonStage, {
      prompt: "an argument about the weekend with Nikhil",
      caseId,
      dict,
    });
    expect(masked.ok).toBe(true);
    if (!masked.ok) return;
    expect(masked.request.messages[0].content).toContain("with 甲");

    const blocked = prepareRequest(judgmentSkeletonStage, {
      prompt: "an argument about the weekend with Priya",
      caseId,
      dict,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.message).toContain("unregistered_name");
  });
});
