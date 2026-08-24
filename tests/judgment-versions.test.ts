/**
 * Freezing at the service boundary, and the disclosure that makes a re-hearing
 * legitimate (M3 wave B ⑫, HARD RULE #6).
 *
 * Three properties, each asserted against the database rather than against a
 * return value:
 *
 *   1. **A final judgment cannot be edited through the service door.** The call
 *      throws, and the stored row is byte-identical afterwards — including its
 *      `updated_at`, because a freeze that still touches the row is not one.
 *   2. **Regeneration is version + 1, pointing at what it replaced**, and the
 *      predecessor is not modified in the process.
 *   3. **The comparison says what changed and who produced it.** HARD RULE #6
 *      does not permit a re-hearing and then ask for a diff; the diff is the
 *      condition. A version served by the fallback model says so in words,
 *      because "fable said this" and "the fallback said this after fable was
 *      unavailable" are different provenances.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases, judgments } from "../src/server/db/schema";
import {
  JudgmentStoreError,
  compareJudgmentVersions,
  createDraft,
  describeVersionComparison,
  diffLines,
  editJudgment,
  finalize,
  listVersionSides,
  readJudgment,
  regenerateJudgment,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";

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

function seedCase(): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "judgment",
      title: "fixture",
      outputLevel: "L2",
      outputLevelLockedAt: new Date(),
    })
    .returning()
    .all();
  return row.id;
}

function factLayer(
  overrides: {
    readonly confidence?: number;
    readonly allocation?: "contributing" | "primary";
    readonly extraClaim?: boolean;
  } = {},
): FactLayer {
  const { confidence = 0.9, allocation = "contributing", extraClaim = false } = overrides;
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a deadline and treated it as already agreed.",
        evidence_refs: ["u-1"],
        confidence,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement: "乙's own words are not in the confirmed record.",
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
      ...(extraClaim
        ? [
            {
              claim_id: "c3",
              statement: "甲 repeated the deadline the next day.",
              evidence_refs: ["u-2"],
              confidence: 0.6,
              tier: "inferred" as const,
            },
          ]
        : []),
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 2, by_client: 0, by_counterparty: 2 },
        parties_without_citable_utterance: ["乙"],
        statement:
          "Two confirmed lines, both 甲's. 乙 has not spoken inside the record.",
      },
      unresolved: [
        {
          question: "What did 乙 say that evening?",
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [
        { party: "甲", allocation, claim_ids: ["c1"] },
        { party: "乙", allocation: "not_established", claim_ids: ["c2"] },
      ],
    },
  };
}

function surfaceLayer(text?: string): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the record shows",
        text:
          text ??
          "甲 stated a deadline in writing: “我周三之前必须知道”.\nWhat 乙 answered is not in the record.",
        claim_ids: ["c1"],
      },
    ],
  };
}

function seedFinalV1(): { caseId: string; judgmentId: string } {
  const caseId = seedCase();
  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    promptVersion: "judgment_skeleton.v1",
    factLayer: factLayer(),
    surfaceLayer: surfaceLayer(),
  });
  finalize(db, draft.id);
  return { caseId, judgmentId: draft.id };
}

function rawRow(judgmentId: string) {
  return db.select().from(judgments).where(eq(judgments.id, judgmentId)).get();
}

/* -------------------------------------------------------------------------- */
/* The freeze                                                                 */
/* -------------------------------------------------------------------------- */

describe("a final judgment cannot be edited", () => {
  it("throws at the service door and leaves the row untouched", () => {
    const { judgmentId } = seedFinalV1();
    const before = rawRow(judgmentId);

    expect(() =>
      editJudgment(db, judgmentId, { surfaceLayer: surfaceLayer("rewritten") }),
    ).toThrowError(JudgmentStoreError);

    try {
      editJudgment(db, judgmentId, { model: "something-else" });
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("frozen");
      // The message has to send the caller to the door that is open.
      expect((error as Error).message).toContain("createNextVersion");
    }

    expect(rawRow(judgmentId)).toEqual(before);
  });

  it("still allows a draft to be written", () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
    });

    const updated = editJudgment(db, draft.id, { surfaceLayer: surfaceLayer() });
    expect(updated.surfaceLayer?.sections).toHaveLength(1);
    expect(updated.status).toBe("draft");
  });
});

/* -------------------------------------------------------------------------- */
/* Regeneration                                                               */
/* -------------------------------------------------------------------------- */

describe("regeneration", () => {
  it("produces version 2 pointing at version 1, without touching it", () => {
    const { caseId, judgmentId } = seedFinalV1();
    const before = rawRow(judgmentId);

    const v2 = regenerateJudgment(db, caseId, {
      model: "claude-opus-4-8",
      effort: "xhigh",
      fallbackUsed: true,
      factLayer: factLayer({ allocation: "primary", extraClaim: true }),
      surfaceLayer: surfaceLayer(
        "甲 stated a deadline in writing: “我周三之前必须知道”.\n甲 repeated it the next day.",
      ),
    });

    expect(v2.version).toBe(2);
    expect(v2.supersedesJudgmentId).toBe(judgmentId);
    expect(v2.status).toBe("draft");
    expect(rawRow(judgmentId)).toEqual(before);

    expect(listVersionSides(db, caseId).map((side) => side.version)).toEqual([1, 2]);
  });

  it("refuses to fork the chain", () => {
    const { caseId } = seedFinalV1();
    regenerateJudgment(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    });

    // A second re-hearing of version 1 would make "which judgment stands"
    // unanswerable; the chain is a line.
    const v1 = readJudgment(db, listVersionSides(db, caseId)[0].judgmentId);
    expect(() =>
      regenerateJudgment(db, caseId, {
        predecessorId: v1?.id,
        model: "claude-fable-5",
        factLayer: factLayer(),
      }),
    ).toThrowError(/already re-heard/);
  });
});

/* -------------------------------------------------------------------------- */
/* The comparison                                                             */
/* -------------------------------------------------------------------------- */

describe("the version comparison", () => {
  it("surfaces the diff, the serving model and fallback_used", () => {
    const { caseId, judgmentId } = seedFinalV1();
    const v2 = regenerateJudgment(db, caseId, {
      model: "claude-opus-4-8",
      effort: "xhigh",
      fallbackUsed: true,
      factLayer: factLayer({ confidence: 0.75, allocation: "primary", extraClaim: true }),
      surfaceLayer: surfaceLayer(
        "甲 stated a deadline in writing: “我周三之前必须知道”.\n甲 repeated it the next day.",
      ),
    });
    finalize(db, v2.id);

    const comparison = compareJudgmentVersions(db, caseId);
    expect(comparison).not.toBeNull();
    if (comparison === null) return;

    expect(comparison.before.judgmentId).toBe(judgmentId);
    expect(comparison.after.version).toBe(2);
    expect(comparison.identical).toBe(false);

    // The skeleton diff: one claim added, one changed, one allocation moved.
    expect(comparison.claimsAdded.map((claim) => claim.claimId)).toEqual(["c3"]);
    expect(comparison.claimsChanged.map((claim) => claim.claimId)).toEqual(["c1"]);
    expect(comparison.claimsChanged[0].changed).toContain("confidence");
    expect(comparison.allocationChanges).toEqual([
      { party: "甲", before: "contributing", after: "primary" },
    ]);

    // The narrative diff, line by line.
    expect(comparison.sectionsChanged).toHaveLength(1);
    const added = comparison.sectionsChanged[0].diff.filter((line) => line.op === "added");
    expect(added.map((line) => line.text)).toContain("甲 repeated it the next day.");

    // Provenance, in words, including the fallback.
    expect(comparison.modelChanged).toBe(true);
    expect(comparison.fallbackChanged).toBe(true);
    expect(comparison.disclosure).toContain("claude-fable-5");
    expect(comparison.disclosure).toContain("claude-opus-4-8");
    expect(comparison.disclosure).toContain("fallback");
    expect(comparison.disclosure).toContain("has not been altered");

    expect(describeVersionComparison(comparison)).toContain("fallback_used=true");
  });

  it("says so plainly when nothing differs", () => {
    const { caseId } = seedFinalV1();
    regenerateJudgment(db, caseId, {
      model: "claude-fable-5",
      effort: "xhigh",
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    });

    const comparison = compareJudgmentVersions(db, caseId);
    expect(comparison?.identical).toBe(true);
    expect(comparison?.disclosure).toContain("Nothing in the skeleton");
  });

  it("has nothing to compare while there is only one version", () => {
    const { caseId } = seedFinalV1();
    expect(compareJudgmentVersions(db, caseId)).toBeNull();
  });
});

describe("the line diff", () => {
  it("keeps unchanged lines and marks the rest", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(diff).toEqual([
      { op: "same", text: "a" },
      { op: "removed", text: "b" },
      { op: "added", text: "B" },
      { op: "same", text: "c" },
      { op: "added", text: "d" },
    ]);
  });

  it("is stable: the same input diffs the same way twice", () => {
    const before = "one\ntwo\nthree";
    const after = "one\nthree\nfour";
    expect(diffLines(before, after)).toEqual(diffLines(before, after));
  });
});
