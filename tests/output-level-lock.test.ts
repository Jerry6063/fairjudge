/**
 * Locking the output level onto a case — the pass path (SPEC M3 wave B, HARD
 * RULE #2).
 *
 * `tests/output-level.test.ts` drives the rule. This file drives the wiring: the
 * facts are read out of SQLite, handed to the same pure function, and written
 * down once. Three fixtures, because three answers have to come out of the same
 * code path:
 *
 *   - the seeded real case's shape → L2 (two confirmed lines, both the
 *     counterparty's, over C/D-only material);
 *   - a C-grade-dominant case with nothing confirmed → L3;
 *   - a case a safety screen refused → refused, without any of the above being
 *     consulted.
 *
 * And one property that is not about the level at all: a lock is a lock. Locking
 * twice at the same answer is a no-op; locking over a different answer throws.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordConsent } from "../src/server/access";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  safetyScreens,
  utterances,
  type EvidenceGrade,
} from "../src/server/db/schema";
import {
  OutputLevelError,
  lockOutputLevel,
  readOutputLevel,
  relockOutputLevel,
} from "../src/server/pipeline";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface SeedOptions {
  /** Graded material, as `grade_final` letters (the human column). */
  readonly grades?: readonly EvidenceGrade[];
  /** Lines by the client (乙). `confirmed` decides whether they are citable. */
  readonly clientLines?: readonly { text: string; confirmed: boolean }[];
  /** Lines by the counterparty (甲). */
  readonly counterpartyLines?: readonly { text: string; confirmed: boolean }[];
  /**
   * Material 甲 submitted herself (SPEC M5 ⑥): owned by her, shared into the
   * case record. This is the fact the L1 upgrade turns on, and it is a different
   * fact from a line she spoke — every line in `counterpartyLines` is hers to
   * speak and the client's to have submitted.
   */
  readonly counterpartyOwnLines?: readonly { text: string; confirmed: boolean }[];
  /**
   * Whether she has granted `case_record` — the consent event her submission
   * writes. Her rows stay `private` either way; the grant is what puts them in
   * the case, and revoking it takes them back out (M5 decision record).
   */
  readonly counterpartyGrantsRecord?: boolean;
  readonly counterpartyState?:
    | "pending"
    | "participating"
    | "written_response"
    | "refused"
    | "unreachable"
    | "unaware";
  readonly downgradeSignal?: boolean;
  /** Record a refusing safety screen. */
  readonly refused?: boolean;
}

function seedCase(options: SeedOptions = {}): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "pre_judgment",
      title: "fixture",
      downgradeSignal: options.downgradeSignal ?? false,
    })
    .returning()
    .all();

  const parties = db
    .insert(caseParticipants)
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
        participationState: options.counterpartyState ?? "pending",
      },
    ])
    .returning()
    .all();
  const counterparty = parties.find((party) => !party.isSubmitter)!;

  for (const grade of options.grades ?? []) {
    db.insert(evidence)
      .values({
        caseId: row.id,
        sourceType:
          grade === "A"
            ? "firsthand"
            : grade === "B"
              ? "recollection"
              : grade === "C"
                ? "ai_processed"
                : "public_sentiment",
        gradeFinal: grade,
        gradeConfirmedAt: new Date(),
      })
      .run();
  }

  const lines = [
    ...(options.clientLines ?? []).map((line) => ({ ...line, speaker: "乙" })),
    ...(options.counterpartyLines ?? []).map((line) => ({
      ...line,
      speaker: "甲",
    })),
  ];
  for (const [at, line] of lines.entries()) {
    db.insert(utterances)
      .values({
        caseId: row.id,
        speakerLabel: line.speaker,
        orderKey: `a${at}`,
        aiDraft: line.text,
        humanFinal: line.confirmed ? line.text : null,
        confirmStatus: line.confirmed ? "confirmed" : "pending",
      })
      .run();
  }

  // Hers: written the way `/respond` writes what she sends — her id stamped on
  // the row, `human_final` with no ai_draft (no machine wrote it), the row left
  // `private`, and the `case_record` grant recorded as its own event.
  const ownLines = options.counterpartyOwnLines ?? [];
  for (const [at, line] of ownLines.entries()) {
    db.insert(utterances)
      .values({
        caseId: row.id,
        speakerParticipantId: counterparty.id,
        speakerLabel: "甲",
        orderKey: `b${at}`,
        humanFinal: line.text,
        confirmStatus: line.confirmed ? "confirmed" : "pending",
        ownerParticipantId: counterparty.id,
        visibility: "private",
      })
      .run();
  }
  if (ownLines.length > 0 && options.counterpartyGrantsRecord !== false) {
    recordConsent(db, {
      caseId: row.id,
      actorParticipantId: counterparty.id,
      kind: "granted",
      scope: "case_record",
    });
  }

  if (options.refused === true) {
    db.insert(safetyScreens)
      .values({
        caseId: row.id,
        screenType: "keyword",
        outcome: "refuse",
        redFlags: ["physical_violence"],
        rationale: "fixture",
        referralShown: true,
      })
      .run();
  }

  return row.id;
}

/**
 * The seeded real case's shape, as the database holds it after the operator
 * purge: 12 C + 2 D graded items, the client's own five lines all still
 * `pending`, and two confirmed lines — both spoken by 甲. Only the shape
 * (counts, grades, confirmation states) mirrors the case; every line text
 * below is invented.
 */
function seedRealCaseShape(): string {
  return seedCase({
    grades: [
      ...(Array(12).fill("C") as EvidenceGrade[]),
      ...(Array(2).fill("D") as EvidenceGrade[]),
    ],
    clientLines: [
      { text: "几点？", confirmed: false },
      { text: "订好了不就直接说了？", confirmed: false },
      { text: "服务员负责收拾", confirmed: false },
      { text: "你会先跟我讲吗？", confirmed: false },
      { text: "我记性不好，当时没记住", confirmed: false },
    ],
    counterpartyLines: [
      {
        text: "我不认为是我要求高，订位的日子他记错了也不核对，到了饭店才发现根本没有位子 我压根没往心里去。",
        confirmed: true,
      },
      {
        text: "订位这件事他从来不上心，我说了不下十次。他反倒问我 你会先跟我讲吗？",
        confirmed: true,
      },
    ],
    counterpartyState: "pending",
  });
}

/* -------------------------------------------------------------------------- */
/* The three answers                                                          */
/* -------------------------------------------------------------------------- */

describe("locking the level on the passing path", () => {
  it("locks the real case at L2 and says why in its own words", () => {
    const caseId = seedRealCaseShape();

    const before = readOutputLevel(db, caseId);
    expect(before.locked).toBeNull();
    expect(before.decision.level).toBe("L2");

    const view = lockOutputLevel(db, caseId);
    expect(view.locked).toBe("L2");
    expect(view.lockedAt).toBeInstanceOf(Date);
    expect(view.stale).toBe(false);

    // The level is on the case row, which is what the stage machine reads.
    const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
    expect(row?.outputLevel).toBe("L2");
    expect(row?.outputLevelLockedAt).toBeInstanceOf(Date);

    // And the reasoning is the sharp version, not the generic label.
    const codes = view.decision.findings.map((finding) => finding.code);
    expect(codes).toContain("client_never_spoke_in_the_record");
    expect(codes).toContain("no_first_hand_material");
    expect(view.decision.inputs.evidence.citableUtterances).toEqual({
      total: 2,
      byClient: 0,
      byCounterparty: 2,
    });
    expect(view.decision.inputs.evidence.counts).toEqual({
      A: 0,
      B: 0,
      C: 12,
      D: 2,
    });
  });

  it("locks a C-grade-dominant case with nothing confirmed at L3", () => {
    const caseId = seedCase({
      grades: ["C", "C", "C", "C", "D"],
      clientLines: [{ text: "几点？", confirmed: false }],
      counterpartyState: "participating",
    });

    const view = lockOutputLevel(db, caseId);
    expect(view.locked).toBe("L3");
    expect(view.decision.reason).toBe("no_citable_record");
  });

  it("locks a red-flagged case as refused, from the screen the gate wrote", () => {
    const caseId = seedCase({
      grades: ["A", "A"],
      counterpartyLines: [{ text: "我不认为是我要求高", confirmed: true }],
      counterpartyState: "participating",
      refused: true,
    });

    const view = lockOutputLevel(db, caseId);
    expect(view.locked).toBe("refused");
    expect(view.decision.reason).toBe("safety_refusal");
    // Nothing about the relationship is reported on a refused case.
    expect(view.decision.findings.map((f) => f.code)).toEqual([
      "safety_refusal",
    ]);
  });

  it("counts only what a human graded, and only what a human confirmed", () => {
    const caseId = seedRealCaseShape();
    // An ungraded item and an unconfirmed line are invisible to the derivation
    // exactly as they are invisible to a citing prompt.
    db.insert(evidence)
      .values({ caseId, sourceType: "firsthand", gradeSuggested: "A" })
      .run();

    const view = readOutputLevel(db, caseId);
    expect(view.decision.inputs.evidence.counts.A).toBe(0);
    expect(view.decision.level).toBe("L2");
  });

  it("moves to L1 once the counterparty has put material of her own in", () => {
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyOwnLines: [{ text: "我那天等到十一点", confirmed: true }],
      counterpartyState: "written_response",
    });
    const view = lockOutputLevel(db, caseId);
    expect(view.locked).toBe("L1");
    expect(view.decision.reason).toBe("bilateral");
    expect(view.decision.inputs.evidence.hasClientConfirmed).toBe(true);
    expect(view.decision.inputs.evidence.hasCounterpartyConfirmed).toBe(true);
  });

  it("holds an otherwise bilateral case at L2 on the wave-A downgrade signal", () => {
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyOwnLines: [{ text: "我那天等到十一点", confirmed: true }],
      counterpartyState: "written_response",
      downgradeSignal: true,
    });
    const view = lockOutputLevel(db, caseId);
    expect(view.locked).toBe("L2");
    expect(view.decision.reason).toBe("steelman_unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* SPEC M5 ⑥ — the L1 upgrade, read off the record                            */
/* -------------------------------------------------------------------------- */

describe("the L1 upgrade path", () => {
  it("stays at L2 while the client is the only one who has submitted anything", () => {
    // The real case with the participation column filled in as favourably as it
    // can be: every citable line is 甲's, and every one of them is 乙's material.
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyState: "participating",
    });

    const view = readOutputLevel(db, caseId);
    expect(view.decision.level).toBe("L2");
    expect(view.decision.reason).toBe("one_sided_material");
    expect(view.decision.inputs.evidence.hasCounterpartyConfirmed).toBe(false);
    expect(view.decision.findings.map((f) => f.code)).toContain(
      "counterparty_submitted_nothing",
    );
  });

  it("does not count her unconfirmed material — signing off is the act", () => {
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyOwnLines: [{ text: "我那天等到十一点", confirmed: false }],
      counterpartyState: "participating",
    });

    const view = readOutputLevel(db, caseId);
    expect(view.decision.inputs.evidence.hasCounterpartyConfirmed).toBe(false);
    expect(view.decision.level).toBe("L2");
  });

  it("does not count her material before she has granted the case record", () => {
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyOwnLines: [{ text: "我那天等到十一点", confirmed: true }],
      counterpartyGrantsRecord: false,
      counterpartyState: "participating",
    });

    const view = readOutputLevel(db, caseId);
    expect(view.decision.inputs.evidence.hasCounterpartyConfirmed).toBe(false);
    expect(view.decision.level).toBe("L2");
  });

  it("follows her revocation back down — consent is an event, not a bit", () => {
    const caseId = seedCase({
      grades: ["A"],
      counterpartyLines: [{ text: "我压根没往心里去", confirmed: true }],
      counterpartyOwnLines: [{ text: "我那天等到十一点", confirmed: true }],
      counterpartyState: "participating",
    });
    expect(readOutputLevel(db, caseId).decision.level).toBe("L1");

    // She takes it back out of the case record. Nothing is deleted; it is
    // simply no longer material this hearing may read, so the level it bought
    // goes with it.
    const counterparty = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.caseId, caseId))
      .all()
      .find((party) => !party.isSubmitter)!;
    recordConsent(db, {
      caseId,
      actorParticipantId: counterparty.id,
      kind: "revoked",
      scope: "case_record",
      note: "我不想让这些进案子。",
    });

    const view = readOutputLevel(db, caseId);
    expect(view.decision.inputs.evidence.hasCounterpartyConfirmed).toBe(false);
    expect(view.decision.level).toBe("L2");
  });

});

/* -------------------------------------------------------------------------- */
/* A lock is a lock                                                           */
/* -------------------------------------------------------------------------- */

describe("the lock", () => {
  it("is idempotent while the answer has not moved", () => {
    const caseId = seedRealCaseShape();
    const first = lockOutputLevel(db, caseId);
    const second = lockOutputLevel(db, caseId);

    expect(second.locked).toBe("L2");
    expect(second.lockedAt?.getTime()).toBe(first.lockedAt?.getTime());
  });

  it("refuses to rewrite itself when the record moves underneath it", () => {
    const caseId = seedRealCaseShape();
    expect(lockOutputLevel(db, caseId).locked).toBe("L2");

    // The other party arrives, and puts a line of her own into the case
    // record — which now derives L1 (SPEC M5 ⑥).
    const counterparty = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.caseId, caseId))
      .all()
      .find((party) => !party.isSubmitter)!;
    db.insert(utterances)
      .values({
        caseId,
        speakerParticipantId: counterparty.id,
        speakerLabel: "甲",
        orderKey: "z0",
        aiDraft: "我那天等到十一点",
        humanFinal: "我那天等到十一点",
        confirmStatus: "confirmed",
        ownerParticipantId: counterparty.id,
        visibility: "case",
      })
      .run();

    const view = readOutputLevel(db, caseId);
    expect(view.locked).toBe("L2");
    expect(view.decision.level).toBe("L1");
    expect(view.stale).toBe(true);

    expect(() => lockOutputLevel(db, caseId)).toThrowError(OutputLevelError);
    expect(() => lockOutputLevel(db, caseId)).toThrowError(/locked at L2/);

    // And the column did not move.
    const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
    expect(row?.outputLevel).toBe("L2");
  });

  it("reports a missing case rather than inventing a level for it", () => {
    expect(() => readOutputLevel(db, "no-such-case")).toThrowError(
      OutputLevelError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Moving the lock — the one act allowed to (SPEC M5 ⑥)                       */
/* -------------------------------------------------------------------------- */

describe("relocking, which only a re-hearing does", () => {
  /** Give the counterparty a confirmed line of her own, in the case record. */
  function sheSubmits(caseId: string): void {
    const counterparty = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.caseId, caseId))
      .all()
      .find((party) => !party.isSubmitter)!;
    db.insert(utterances)
      .values({
        caseId,
        speakerParticipantId: counterparty.id,
        speakerLabel: "甲",
        orderKey: "z0",
        humanFinal: "我那天等到十一点",
        confirmStatus: "confirmed",
        ownerParticipantId: counterparty.id,
        visibility: "private",
      })
      .run();
    recordConsent(db, {
      caseId,
      actorParticipantId: counterparty.id,
      kind: "granted",
      scope: "case_record",
    });
  }

  it("moves a stale lock to what the record derives now", () => {
    const caseId = seedRealCaseShape();
    const first = lockOutputLevel(db, caseId);
    expect(first.locked).toBe("L2");

    sheSubmits(caseId);
    expect(readOutputLevel(db, caseId).stale).toBe(true);

    const moved = relockOutputLevel(db, caseId);
    expect(moved.locked).toBe("L1");
    expect(moved.stale).toBe(false);
    expect(moved.lockedAt?.getTime()).toBeGreaterThanOrEqual(
      first.lockedAt!.getTime(),
    );

    const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
    expect(row?.outputLevel).toBe("L1");
  });

  it("leaves a lock that still matches the record alone, timestamp included", () => {
    const caseId = seedRealCaseShape();
    const first = lockOutputLevel(db, caseId);

    const again = relockOutputLevel(db, caseId);
    expect(again.locked).toBe("L2");
    // "It did not move" and "it moved to the same value" are different facts.
    expect(again.lockedAt?.getTime()).toBe(first.lockedAt?.getTime());
  });

  it("locks a case that was never locked, rather than requiring one first", () => {
    const caseId = seedRealCaseShape();
    expect(readOutputLevel(db, caseId).locked).toBeNull();

    expect(relockOutputLevel(db, caseId).locked).toBe("L2");
  });

  it("moves the level DOWN when the record loses what bought it", () => {
    // The direction that matters most: she withdrew the grant, so her material
    // is out of the case record and L1 is no longer supported. A relock that
    // only ever promoted would be a ratchet, and a ratchet on this column would
    // let a re-hearing allocate responsibility on a record that no longer has
    // two sides in it.
    const caseId = seedRealCaseShape();
    sheSubmits(caseId);
    expect(lockOutputLevel(db, caseId).locked).toBe("L1");

    const counterparty = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.caseId, caseId))
      .all()
      .find((party) => !party.isSubmitter)!;
    recordConsent(db, {
      caseId,
      actorParticipantId: counterparty.id,
      kind: "revoked",
      scope: "case_record",
    });

    expect(relockOutputLevel(db, caseId).locked).toBe("L2");
  });
});
