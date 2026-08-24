/**
 * The judgment data contract (SPEC M3 wave B ⑦ / ⑪ / ⑫, HARD RULE #6).
 *
 * Three properties carry this file, and they are the three ways a judgment can
 * be wrong in a way no reader would notice:
 *
 *   1. **The narrative may not out-run the skeleton.** A section resting on a
 *      claim id the fact layer never defined is a sentence no evidence was
 *      checked for, printed in the same typeface as the ones that were.
 *   2. **A final judgment is frozen.** Not "we avoid editing it" — the write is
 *      refused and the row is byte-identical afterwards, which is what these
 *      tests assert rather than trusting the return value.
 *   3. **A re-hearing is a new version that points at what it replaced**, and
 *      the predecessor is never touched in the process.
 *
 * The fixtures are shaped like the real case on purpose (SPEC M3 decision
 * record, 2026-08-09): two citable utterances, both the counterparty's, and
 * none of the client's own words confirmed. That is why `record_basis` carries
 * counts and why an `unknown`-tier claim cites nothing — the shape has to be
 * able to say "the client has never spoken inside this record" without
 * inventing a citation for it.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases, type OutputLevel } from "../src/server/db/schema";
import {
  JudgmentContractError,
  JudgmentStoreError,
  assertJudgmentContract,
  assertShareTokenAllowed,
  createDraft,
  createNextVersion,
  finalize,
  listRenditions,
  parseFactLayer,
  parseSurfaceLayer,
  readCurrentJudgment,
  readJudgment,
  readJudgmentChain,
  readRendition,
  renderRendition,
  updateDraft,
  validateJudgmentContract,
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

/** A case with a level already locked onto it — the state judgment starts from. */
function seedCase(level: OutputLevel | null = "L2"): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "judgment",
      title: "fixture",
      outputLevel: level,
      outputLevelLockedAt: level === null ? null : new Date(),
    })
    .returning()
    .all();
  return row.id;
}

/**
 * The real case's shape: every claim that can cite anything cites one of the
 * same two confirmed lines, both spoken by 甲, and what 乙 said at the time is
 * an `unknown` claim citing nothing at all.
 *
 * The `evidence_refs` here are opaque ids. This module never asks whether they
 * exist — that is HARD RULE #1, answered against SQLite in
 * `pipeline/evidence-refs.ts`, and having two answers to it would be the bug.
 */
function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 stated a deadline and treated it as already agreed.",
        evidence_refs: ["u-jia-1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          "乙 read 甲's message as an ultimatum rather than a request, on the " +
          "strength of its wording.",
        evidence_refs: ["u-jia-1", "u-jia-2"],
        confidence: 0.55,
        tier: "inferred",
      },
      {
        claim_id: "c3",
        statement:
          "What 乙 actually said in reply is not in the confirmed record; " +
          "none of 乙's own utterances have been confirmed.",
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 2, by_client: 0, by_counterparty: 2 },
        parties_without_citable_utterance: ["乙"],
        statement:
          "This judgment could read two confirmed lines, both of them 甲's. " +
          "None of 乙's own messages have been confirmed, so 乙 has not spoken " +
          "inside the record at all; everything said about 乙 here is read off " +
          "甲's words.",
      },
      unresolved: [
        {
          question: "What did 乙 reply on the evening in question?",
          reason: "clarification_unanswered",
          claim_ids: ["c3"],
        },
      ],
      responsibility: [
        { party: "甲", allocation: "contributing", claim_ids: ["c1"] },
        { party: "乙", allocation: "not_established", claim_ids: ["c3"] },
      ],
    },
  };
}

function surfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the record shows",
        text: "甲 set a deadline and wrote as though it had already been agreed.",
        claim_ids: ["c1"],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "The part that is yours to sit with",
        text:
          "Reading a request as an ultimatum is a choice you made about the " +
          "wording, and it is worth asking what made that reading the obvious one.",
        claim_ids: ["c2"],
      },
      {
        section_id: "s3",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text:
          "Your own replies are not in the confirmed record, so nothing here " +
          "rests on what you actually said at the time.",
        // A limits section is not required to cite anything, but this one does:
        // the gap it describes is claim c3, the unknown-tier one.
        claim_ids: ["c3"],
      },
      {
        section_id: "s4",
        kind: "disclosure",
        audience: "both",
        heading: "What this rests on",
        text: "Two confirmed utterances, both 甲's.",
        claim_ids: [],
      },
    ],
  };
}

/** Raw row, straight out of SQLite — for byte-identical comparisons. */
function rawJudgment(id: string): unknown {
  return sqlite.prepare("SELECT * FROM judgments WHERE id = ?").get(id);
}

const MODEL = "claude-fable-5";

function draft(caseId: string, surface: SurfaceLayer | null = null) {
  return createDraft(db, caseId, {
    model: MODEL,
    effort: "xhigh",
    promptVersion: "judgment.v1",
    factLayer: factLayer(),
    surfaceLayer: surface,
  });
}

/* -------------------------------------------------------------------------- */
/* The tiers                                                                  */
/* -------------------------------------------------------------------------- */

describe("claim tiers", () => {
  it("accepts the real case's shape: two cited claims and one that cites nothing", () => {
    const parsed = parseFactLayer(factLayer());
    expect(parsed.claims.map((c) => c.tier)).toEqual([
      "high_confidence",
      "inferred",
      "unknown",
    ]);
  });

  it("refuses an unknown claim that cites the record", () => {
    const bad = factLayer();
    bad.claims[2].evidence_refs = ["u-jia-1"];

    expect(() => parseFactLayer(bad)).toThrow(JudgmentContractError);
    try {
      parseFactLayer(bad);
    } catch (error) {
      const violations = (error as JudgmentContractError).violations;
      expect(violations[0].path).toContain("claims.2.evidence_refs");
      expect(violations[0].detail).toContain("must cite nothing");
    }
  });

  it("refuses an unknown claim that is confident anyway", () => {
    const bad = factLayer();
    bad.claims[2].confidence = 0.8;
    expect(() => parseFactLayer(bad)).toThrow(/unknown/);
  });

  it("refuses a cited tier that cites nothing (HARD RULE #1 in the shape)", () => {
    const bad = factLayer();
    bad.claims[0].evidence_refs = [];
    expect(() => parseFactLayer(bad)).toThrow(/cites nothing/);
  });

  it("refuses a high_confidence claim that is not confident", () => {
    const bad = factLayer();
    bad.claims[0].confidence = 0.4;
    expect(() => parseFactLayer(bad)).toThrow(/high_confidence/);
  });
});

/* -------------------------------------------------------------------------- */
/* Case-level findings                                                        */
/* -------------------------------------------------------------------------- */

describe("record basis", () => {
  it("refuses to record zero client utterances without naming the client as silent", () => {
    const bad = factLayer();
    bad.findings.record_basis.parties_without_citable_utterance = [];

    expect(() => parseFactLayer(bad)).toThrow(JudgmentContractError);
    try {
      parseFactLayer(bad);
    } catch (error) {
      expect((error as JudgmentContractError).message).toContain(
        "parties_without_citable_utterance",
      );
    }
  });

  it("refuses counts that do not add up", () => {
    const bad = factLayer();
    bad.findings.record_basis.citable_utterances = {
      total: 2,
      by_client: 2,
      by_counterparty: 2,
    };
    expect(() => parseFactLayer(bad)).toThrow(/exceeds total/);
  });

  it("keeps `clarification_unanswered` available as a real state", () => {
    // The operator-authored answers were purged, which leaves the questions
    // asked and unanswered — a fact the judgment states rather than hides.
    const parsed = parseFactLayer(factLayer());
    expect(parsed.findings.unresolved[0].reason).toBe("clarification_unanswered");
  });

  it("carries no numeric responsibility field to fill in", () => {
    const parsed = parseFactLayer(factLayer());
    for (const item of parsed.findings.responsibility) {
      expect(Object.keys(item).sort()).toEqual(["allocation", "claim_ids", "party"]);
      expect(typeof item.allocation).toBe("string");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The validator                                                              */
/* -------------------------------------------------------------------------- */

describe("the narrative may not out-run the skeleton", () => {
  it("rejects a section resting on a claim_id the fact layer does not define", () => {
    const surface = surfaceLayer();
    surface.sections[0].claim_ids = ["c9"];

    const check = validateJudgmentContract(factLayer(), surface);
    expect(check.ok).toBe(false);
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0].code).toBe("unknown_claim_id");
    expect(check.violations[0].path).toBe("surface_layer.sections[0].claim_ids[0]");
    expect(check.violations[0].detail).toContain("c9");

    expect(() => assertJudgmentContract(factLayer(), surface)).toThrow(
      JudgmentContractError,
    );
  });

  it("rejects a findings reference to a claim that does not exist", () => {
    const facts = factLayer();
    facts.findings.responsibility[0].claim_ids = ["c7"];

    const check = validateJudgmentContract(facts, surfaceLayer());
    expect(check.ok).toBe(false);
    expect(check.violations[0].code).toBe("unknown_claim_id");
    expect(check.violations[0].path).toContain("findings.responsibility[0]");
  });

  it("reports a duplicated claim id", () => {
    const facts = factLayer();
    facts.claims[1].claim_id = "c1";

    const check = validateJudgmentContract(facts, null);
    expect(check.violations.map((v) => v.code)).toContain("duplicate_claim_id");
  });

  it("reports a duplicated section id", () => {
    const surface = surfaceLayer();
    surface.sections[1].section_id = "s1";

    const check = validateJudgmentContract(factLayer(), surface);
    expect(check.violations.map((v) => v.code)).toContain("duplicate_section_id");
  });

  it("refuses a finding section that rests on nothing, in the schema and in the validator", () => {
    const surface = surfaceLayer();
    surface.sections[0].claim_ids = [];

    expect(() => parseSurfaceLayer(surface)).toThrow(/rests on no claim/);

    const check = validateJudgmentContract(factLayer(), surface);
    expect(check.violations.map((v) => v.code)).toContain("uncited_finding_section");
  });

  it("lets disclosure and limits sections stand uncited", () => {
    const check = validateJudgmentContract(factLayer(), surfaceLayer());
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
  });

  it("reports a claim the narrative never uses, without calling it a violation", () => {
    const whole = validateJudgmentContract(factLayer(), surfaceLayer());
    expect(whole.unusedClaimIds).toEqual([]);

    const surface = surfaceLayer();
    surface.sections = surface.sections.filter((s) => s.section_id !== "s1");

    const check = validateJudgmentContract(factLayer(), surface);
    // c1 is still cited by a responsibility finding, so it is not an error that
    // no paragraph rests on it — but the reader never sees it, and that is
    // worth saying out loud.
    expect(check.ok).toBe(true);
    expect(check.unusedClaimIds).toEqual(["c1"]);
  });

  it("validates a skeleton with no narrative yet — the two-step gap is legal", () => {
    const check = validateJudgmentContract(factLayer(), null);
    expect(check.ok).toBe(true);
    expect(check.unusedClaimIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Renditions                                                                 */
/* -------------------------------------------------------------------------- */

describe("renditions", () => {
  it("keeps the criticism in self_reflection and withholds it from shareable", () => {
    const surface = surfaceLayer();

    const self = renderRendition(surface, "self_reflection");
    expect(self.shareable).toBe(false);
    expect(self.sectionIds).toEqual(["s1", "s2", "s3", "s4"]);
    expect(self.omittedSectionIds).toEqual([]);
    expect(self.text).toContain("yours to sit with");

    const shared = renderRendition(surface, "shareable");
    expect(shared.shareable).toBe(true);
    expect(shared.sectionIds).toEqual(["s1", "s3", "s4"]);
    expect(shared.omittedSectionIds).toEqual(["s2"]);
    expect(shared.text).not.toContain("yours to sit with");
  });

  it("renders the same input to the same bytes", () => {
    expect(renderRendition(surfaceLayer(), "shareable").text).toBe(
      renderRendition(surfaceLayer(), "shareable").text,
    );
  });

  it("refuses a share token for the self-reflection rendition", () => {
    expect(() => assertShareTokenAllowed("self_reflection")).toThrow(
      JudgmentStoreError,
    );
    expect(() => assertShareTokenAllowed("shareable")).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Drafts                                                                     */
/* -------------------------------------------------------------------------- */

describe("drafts", () => {
  it("issues a judgment at the level locked onto the case, never one passed in", () => {
    const caseId = seedCase("L3");
    const record = draft(caseId);

    expect(record.version).toBe(1);
    expect(record.status).toBe("draft");
    expect(record.outputLevel).toBe("L3");
    expect(record.supersedesJudgmentId).toBeNull();
    expect(record.surfaceLayer).toBeNull();
  });

  it("refuses a case with no locked level", () => {
    const caseId = seedCase(null);
    expect(() => draft(caseId)).toThrow(JudgmentStoreError);
    try {
      draft(caseId);
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("output_level_not_locked");
    }
  });

  it("refuses a case locked at refused — that path renders resources, not a judgment", () => {
    const caseId = seedCase("refused");
    try {
      draft(caseId);
      expect.unreachable("a refused case must not get a judgment");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("output_level_refused");
    }
  });

  it("refuses an unknown case", () => {
    try {
      draft("no-such-case");
      expect.unreachable("unknown case");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("case_not_found");
    }
  });

  it("writes nothing when the narrative cites a claim that does not exist", () => {
    const caseId = seedCase();
    const surface = surfaceLayer();
    surface.sections[0].claim_ids = ["c9"];

    expect(() =>
      createDraft(db, caseId, {
        model: MODEL,
        factLayer: factLayer(),
        surfaceLayer: surface,
      }),
    ).toThrow(JudgmentContractError);

    expect(readJudgmentChain(db, caseId)).toEqual([]);
  });

  it("attaches the narrative to an existing skeleton", () => {
    const caseId = seedCase();
    const skeleton = draft(caseId);

    const withNarrative = updateDraft(db, skeleton.id, {
      surfaceLayer: surfaceLayer(),
    });

    expect(withNarrative.surfaceLayer?.sections).toHaveLength(4);
    expect(readJudgment(db, skeleton.id)?.surfaceLayer?.sections[0].section_id).toBe(
      "s1",
    );
  });

  it("refuses a second chain on the same case", () => {
    const caseId = seedCase();
    draft(caseId);
    try {
      draft(caseId);
      expect.unreachable("a case gets one chain");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("chain_exists");
    }
  });

  it("refuses to finalize half a judgment", () => {
    const caseId = seedCase();
    const skeleton = draft(caseId);
    try {
      finalize(db, skeleton.id);
      expect.unreachable("no narrative yet");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("surface_layer_missing");
    }
    expect(readJudgment(db, skeleton.id)?.status).toBe("draft");
  });
});

/* -------------------------------------------------------------------------- */
/* Freezing (HARD RULE #6)                                                    */
/* -------------------------------------------------------------------------- */

describe("a final judgment is frozen", () => {
  it("mints both renditions in the transaction that freezes it", () => {
    const caseId = seedCase();
    const record = finalize(db, draft(caseId, surfaceLayer()).id);

    expect(record.status).toBe("final");
    expect(record.finalizedAt).toBeInstanceOf(Date);

    const renditions = listRenditions(db, record.id);
    expect(renditions.map((r) => r.kind)).toEqual(["self_reflection", "shareable"]);
    expect(readRendition(db, record.id, "self_reflection")?.shareable).toBe(false);
    expect(readRendition(db, record.id, "shareable")?.shareable).toBe(true);
    expect(readRendition(db, record.id, "shareable")?.content).not.toContain(
      "yours to sit with",
    );
    expect(readCurrentJudgment(db, caseId)?.id).toBe(record.id);
  });

  it("refuses an update to a final row and leaves the row byte-identical", () => {
    const caseId = seedCase();
    const record = finalize(db, draft(caseId, surfaceLayer()).id);
    const before = JSON.stringify(rawJudgment(record.id));

    try {
      updateDraft(db, record.id, { model: "claude-opus-4-8" });
      expect.unreachable("a final judgment is not rewritten");
    } catch (error) {
      expect(error).toBeInstanceOf(JudgmentStoreError);
      expect((error as JudgmentStoreError).code).toBe("frozen");
    }

    // Not "the call returned an error" — the bytes on disk did not move.
    expect(JSON.stringify(rawJudgment(record.id))).toBe(before);
  });

  it("refuses a second finalize", () => {
    const caseId = seedCase();
    const record = finalize(db, draft(caseId, surfaceLayer()).id);
    const before = JSON.stringify(rawJudgment(record.id));

    try {
      finalize(db, record.id);
      expect.unreachable("already final");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("frozen");
    }
    expect(JSON.stringify(rawJudgment(record.id))).toBe(before);
  });

  it("refuses a layer rewrite on a final row", () => {
    const caseId = seedCase();
    const record = finalize(db, draft(caseId, surfaceLayer()).id);

    const softened = surfaceLayer();
    softened.sections = softened.sections.filter((s) => s.audience !== "self_only");

    expect(() => updateDraft(db, record.id, { surfaceLayer: softened })).toThrow(
      JudgmentStoreError,
    );
    expect(readJudgment(db, record.id)?.surfaceLayer?.sections).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* The version chain                                                          */
/* -------------------------------------------------------------------------- */

describe("the version chain", () => {
  it("regenerates as version + 1 pointing at its predecessor, without touching it", () => {
    const caseId = seedCase();
    const v1 = finalize(db, draft(caseId, surfaceLayer()).id);
    const before = JSON.stringify(rawJudgment(v1.id));

    const v2 = createNextVersion(db, {
      predecessorId: v1.id,
      model: MODEL,
      effort: "max",
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    });

    expect(v2.version).toBe(2);
    expect(v2.status).toBe("draft");
    expect(v2.supersedesJudgmentId).toBe(v1.id);
    expect(v2.caseId).toBe(caseId);
    expect(v2.outputLevel).toBe(v1.outputLevel);

    // The frozen row is untouched — including its status. What replaced it is
    // recorded on the successor, which is what migration 0005 is for.
    expect(JSON.stringify(rawJudgment(v1.id))).toBe(before);
    expect(readJudgment(db, v1.id)?.status).toBe("final");
  });

  it("links a three-version chain and keeps the standing judgment unambiguous", () => {
    const caseId = seedCase();
    const v1 = finalize(db, draft(caseId, surfaceLayer()).id);
    const v2 = finalize(
      db,
      createNextVersion(db, {
        predecessorId: v1.id,
        model: MODEL,
        factLayer: factLayer(),
        surfaceLayer: surfaceLayer(),
      }).id,
    );
    const v3 = createNextVersion(db, {
      predecessorId: v2.id,
      model: MODEL,
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    });

    const chain = readJudgmentChain(db, caseId);
    expect(chain.map((j) => j.version)).toEqual([1, 2, 3]);
    expect(chain.map((j) => j.supersedesJudgmentId)).toEqual([null, v1.id, v2.id]);

    // v3 is still a draft, so the judgment that stands is v2.
    expect(readCurrentJudgment(db, caseId)?.id).toBe(v2.id);
    expect(readJudgment(db, v3.id)?.status).toBe("draft");
  });

  it("does not fork: a predecessor may be re-heard once", () => {
    const caseId = seedCase();
    const v1 = finalize(db, draft(caseId, surfaceLayer()).id);
    const next = {
      predecessorId: v1.id,
      model: MODEL,
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    };
    createNextVersion(db, next);

    try {
      createNextVersion(db, next);
      expect.unreachable("the chain is a line, not a tree");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("already_superseded");
    }
    expect(readJudgmentChain(db, caseId).map((j) => j.version)).toEqual([1, 2]);
  });

  it("writes nothing when the regenerated judgment breaks the contract", () => {
    const caseId = seedCase();
    const v1 = finalize(db, draft(caseId, surfaceLayer()).id);
    const surface = surfaceLayer();
    surface.sections[1].claim_ids = ["c42"];

    expect(() =>
      createNextVersion(db, {
        predecessorId: v1.id,
        model: MODEL,
        factLayer: factLayer(),
        surfaceLayer: surface,
      }),
    ).toThrow(JudgmentContractError);

    expect(readJudgmentChain(db, caseId).map((j) => j.version)).toEqual([1]);
  });

  it("refuses to re-hear a judgment that does not exist", () => {
    try {
      createNextVersion(db, {
        predecessorId: "nope",
        model: MODEL,
        factLayer: factLayer(),
      });
      expect.unreachable("unknown predecessor");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("judgment_not_found");
    }
  });
});
