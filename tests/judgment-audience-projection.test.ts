/**
 * The level-aware audience projection, the simultaneous release, and the
 * provenance-and-redistribution notice — doc 05 §A.3, §A.1 state 6 and §C
 * amendment 5, closing the defect SPEC recorded on 2026-08-14.
 *
 * ## The defect, in one paragraph
 *
 * `audience` was obeyed identically at every level: `self_only` was withheld
 * from the shareable copy, full stop. The first real L1 hearing marked
 * "Responsibility: 乙's share" `self_only` and "Responsibility: 甲's share"
 * `both`, so the counterparty — who had spoken, confirmed her lines and filed
 * the appeal — would have received the half against her and not the half
 * against him, while the `limits` section she did receive asserted an
 * allocation she could not see. Each reader got ammunition; neither got their
 * own accounting.
 *
 * The fixtures below reproduce the real L1 document's shape, headings included,
 * because a synthetic fixture would have let the fix pass without meeting the
 * case that forced it.
 *
 * ## Chinese in these fixtures
 *
 * Pseudonyms (甲/乙) and quoted evidence stay in their original form, verbatim,
 * exactly as the record holds them (CLAUDE.md). Everything the product itself
 * writes is English.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  cases,
  judgmentRenditions,
  judgments,
  OUTPUT_LEVELS,
  type OutputLevel,
} from "../src/server/db/schema";
import {
  NOTICE_OPENING,
  NOTICE_REDISTRIBUTION,
  RESPONSE_WITHOUT_LINK,
  RenditionError,
  SECTION_AUDIENCES,
  SECTION_KINDS,
  assertShareable,
  createDraft,
  deadRespondPointers,
  describeRelease,
  finalize,
  hasProvenanceNotice,
  isResolvableEntryPoint,
  isSelfReflectionAnnex,
  projectSection,
  provenanceNotice,
  publishToBothParties,
  readJudgment,
  readRenditionView,
  readerForRendition,
  renderRendition,
  renderShareable,
  type FactLayer,
  type SectionReader,
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
/* Fixtures — the real L1 document's shape                                    */
/* -------------------------------------------------------------------------- */

const READERS: readonly SectionReader[] = ["client", "counterparty"];

/** The section that IS the defect: the responsibility finding against the client. */
const FINDING_AGAINST_CLIENT = "resp-client";
/** The section that must stay private at every level: his own reflection annex. */
const SELF_REFLECTION_ANNEX = "annex-client";

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a deadline in writing and treated it as agreed.",
        evidence_refs: ["u-1"],
        confidence: 0.85,
        tier: "inferred",
      },
      {
        claim_id: "c2",
        statement: "乙 stopped answering for two days after the deadline message.",
        evidence_refs: ["u-2"],
        confidence: 0.8,
        tier: "inferred",
      },
      {
        claim_id: "c3",
        statement: "What either party intended by the silence is not established.",
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 9, by_client: 4, by_counterparty: 5 },
        parties_without_citable_utterance: [],
        statement:
          "Both parties have confirmed material in the record: four lines of " +
          "乙's and five of 甲's. The hearing could read both accounts.",
      },
      unresolved: [
        {
          question: "What the silence was meant to say.",
          reason: "clarification_unanswered",
          claim_ids: ["c3"],
        },
      ],
      responsibility: [
        { party: "乙", allocation: "shared", claim_ids: ["c2"] },
        { party: "甲", allocation: "shared", claim_ids: ["c1"] },
      ],
    },
  };
}

/**
 * The client's narrative, in the real L1 document's shape.
 *
 * Three `self_only` findings (two incidents and his half of the responsibility)
 * and one `self_only` annex — the section the real document headed "For 乙's
 * version alone: what the declined questions cost".
 */
function realL1SurfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "basis",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: "Nine confirmed lines, from both parties.",
        claim_ids: [],
      },
      {
        section_id: "incident",
        kind: "finding",
        audience: "self_only",
        heading: "The itinerary incident",
        text: "The deadline message was not an ultimatum on the record.",
        claim_ids: ["c1"],
      },
      {
        section_id: FINDING_AGAINST_CLIENT,
        kind: "finding",
        audience: "self_only",
        heading: "Responsibility: 乙's share",
        text:
          "Two days of silence after a question that had been put plainly is " +
          "a contribution to the disagreement, and it is a contribution 乙 made.",
        claim_ids: ["c2"],
      },
      {
        section_id: "resp-counterparty",
        kind: "finding",
        audience: "both",
        heading: "Responsibility: 甲's share",
        text: "Treating a deadline as already agreed is a contribution 甲 made.",
        claim_ids: ["c1"],
      },
      {
        section_id: "limits",
        kind: "limits",
        audience: "both",
        heading: "Limits of this judgment",
        text: "This allocates responsibility as shared between the parties.",
        claim_ids: [],
      },
      {
        section_id: SELF_REFLECTION_ANNEX,
        kind: "limits",
        audience: "self_only",
        heading: "For 乙's version alone: what the declined questions cost",
        text:
          "Three clarification questions were put and declined. Here is what " +
          "answering them would have changed, and it is worth sitting with.",
        claim_ids: [],
      },
    ],
  };
}

/** The counterparty-addressed narrative: every section `both`, and it says "you". */
function counterpartyNarrative(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "cp-basis",
        kind: "disclosure",
        audience: "both",
        heading: "What this document rests on",
        text: "Nine confirmed lines. Five of them are yours.",
        claim_ids: [],
      },
      {
        section_id: "cp-resp-client",
        kind: "finding",
        audience: "both",
        heading: "What the record shows about 乙",
        text:
          "乙 stopped answering for two days after your message, and that " +
          "silence is a contribution 乙 made to the disagreement.",
        claim_ids: ["c2"],
      },
      {
        section_id: "cp-resp-counterparty",
        kind: "finding",
        audience: "both",
        heading: "What the record shows about your own part",
        text: "You treated a deadline as already agreed before it was.",
        claim_ids: ["c1"],
      },
      {
        section_id: "cp-limits",
        kind: "limits",
        audience: "both",
        heading: "What this cannot settle",
        text: "What either of you meant by the silence is not established.",
        claim_ids: ["c3"],
      },
    ],
  };
}

function seedCase(level: OutputLevel): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "judgment",
      title: "fixture",
      outputLevel: level,
      outputLevelLockedAt: new Date(),
    })
    .returning()
    .all();
  return row.id;
}

function seedDraft(level: OutputLevel): { caseId: string; draftId: string } {
  const caseId = seedCase(level);
  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: realL1SurfaceLayer(),
  });
  return { caseId, draftId: draft.id };
}

/* -------------------------------------------------------------------------- */
/* 1. The projection, exhaustively                                            */
/* -------------------------------------------------------------------------- */

describe("projectSection — every level, audience, kind and reader", () => {
  /**
   * The expectation, written independently of the implementation.
   *
   * Stated as the rule in prose so the table cannot drift into "whatever the
   * code does": `both` is everyone's; the client's copy is complete; and
   * `self_only` reaches the counterparty only when it is a FINDING and only at
   * L1, where both parties are participants in one hearing.
   */
  function expected(
    level: OutputLevel,
    audience: (typeof SECTION_AUDIENCES)[number],
    kind: (typeof SECTION_KINDS)[number],
    reader: SectionReader,
  ): { visible: boolean; reason: string } {
    if (audience === "both") return { visible: true, reason: "addressed_to_both" };
    if (reader === "client") return { visible: true, reason: "own_copy" };
    if (kind !== "finding") {
      return { visible: false, reason: "self_reflection_annex" };
    }
    return level === "L1"
      ? { visible: true, reason: "l1_shared_finding" }
      : { visible: false, reason: "criticism_of_client" };
  }

  it("answers the whole cross product, and the answer is total", () => {
    let combinations = 0;
    for (const level of OUTPUT_LEVELS) {
      for (const audience of SECTION_AUDIENCES) {
        for (const kind of SECTION_KINDS) {
          for (const reader of READERS) {
            const actual = projectSection({ level, audience, kind, reader });
            expect(
              { ...actual },
              `level=${level} audience=${audience} kind=${kind} reader=${reader}`,
            ).toEqual(expected(level, audience, kind, reader));
            combinations += 1;
          }
        }
      }
    }
    // 4 levels x 2 audiences x 3 kinds x 2 readers. Asserted so a shrunk enum
    // cannot quietly shrink this test with it.
    expect(combinations).toBe(48);
  });

  /* THE REGRESSION, named in the defect record. */
  it("L1 + counterparty + the finding against the client: VISIBLE", () => {
    expect(
      projectSection({
        level: "L1",
        audience: "self_only",
        kind: "finding",
        reader: "counterparty",
      }),
    ).toEqual({ visible: true, reason: "l1_shared_finding" });
  });

  /* THE OTHER REGRESSION: what L1 does NOT open up. */
  it("L1 + the other party + a self-reflection annex: HIDDEN", () => {
    expect(
      projectSection({
        level: "L1",
        audience: "self_only",
        kind: "limits",
        reader: "counterparty",
      }),
    ).toEqual({ visible: false, reason: "self_reflection_annex" });
    expect(
      projectSection({
        level: "L1",
        audience: "self_only",
        kind: "disclosure",
        reader: "counterparty",
      }),
    ).toEqual({ visible: false, reason: "self_reflection_annex" });
  });

  it("L2 is unchanged: criticism of the client stays with the client", () => {
    expect(
      projectSection({
        level: "L2",
        audience: "self_only",
        kind: "finding",
        reader: "counterparty",
      }),
    ).toEqual({ visible: false, reason: "criticism_of_client" });
  });

  it("the client's own copy is complete at every level", () => {
    for (const level of OUTPUT_LEVELS) {
      for (const audience of SECTION_AUDIENCES) {
        for (const kind of SECTION_KINDS) {
          expect(
            projectSection({ level, audience, kind, reader: "client" }).visible,
          ).toBe(true);
        }
      }
    }
  });

  it("names the reader each rendition kind is for", () => {
    expect(readerForRendition("self_reflection")).toBe("client");
    expect(readerForRendition("shareable")).toBe("counterparty");
  });

  it("recognises an annex by what it is, not by its heading", () => {
    const sections = realL1SurfaceLayer().sections;
    const annexes = sections.filter(isSelfReflectionAnnex).map((s) => s.section_id);
    expect(annexes).toEqual([SELF_REFLECTION_ANNEX]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The projection, applied to the real document                            */
/* -------------------------------------------------------------------------- */

describe("renderRendition over the real L1 document", () => {
  it("sends both responsibility findings to both readers at L1", () => {
    const surface = realL1SurfaceLayer();
    const own = renderRendition(surface, "self_reflection", "L1");
    const shared = renderRendition(surface, "shareable", "L1");

    // The ammunition case: she now receives the finding against him.
    expect(shared.sectionIds).toContain(FINDING_AGAINST_CLIENT);
    expect(shared.text).toContain("Responsibility: 乙's share");
    expect(shared.text).toContain("Responsibility: 甲's share");

    // And the two copies carry the same FINDINGS, which is the framework's
    // sentence: "both responsibility findings belong to both readers".
    const findingsIn = (ids: readonly string[]) =>
      surface.sections
        .filter((s) => ids.includes(s.section_id) && s.kind === "finding")
        .map((s) => s.section_id);
    expect(findingsIn(shared.sectionIds)).toEqual(findingsIn(own.sectionIds));

    // Only the annex is withheld.
    expect(shared.omittedSectionIds).toEqual([SELF_REFLECTION_ANNEX]);
    expect(shared.text).not.toContain("what the declined questions cost");
  });

  it("keeps the L2 rule at L2 — the same document, the other level", () => {
    const shared = renderRendition(realL1SurfaceLayer(), "shareable", "L2");
    expect(shared.omittedSectionIds).toEqual([
      "incident",
      FINDING_AGAINST_CLIENT,
      SELF_REFLECTION_ANNEX,
    ]);
    expect(shared.text).not.toContain("Responsibility: 乙's share");
  });

  it("defaults to the restrictive projection when no level is given", () => {
    const omitted = renderRendition(realL1SurfaceLayer(), "shareable")
      .omittedSectionIds;
    expect(omitted).toEqual(
      renderRendition(realL1SurfaceLayer(), "shareable", "L2").omittedSectionIds,
    );
  });

  it("reports why each section landed where it did", () => {
    const shared = renderRendition(realL1SurfaceLayer(), "shareable", "L1");
    const byId = new Map(shared.projection.map((p) => [p.sectionId, p.reason]));
    expect(byId.get(FINDING_AGAINST_CLIENT)).toBe("l1_shared_finding");
    expect(byId.get(SELF_REFLECTION_ANNEX)).toBe("self_reflection_annex");
    expect(byId.get("limits")).toBe("addressed_to_both");
  });

  it("is deterministic — the same input renders the same bytes", () => {
    expect(renderRendition(realL1SurfaceLayer(), "shareable", "L1").text).toBe(
      renderRendition(realL1SurfaceLayer(), "shareable", "L1").text,
    );
  });

  it("projects the client's frozen copy at his judgment's own level", () => {
    const { draftId } = seedDraft("L1");
    finalize(db, draftId);
    const own = readRenditionView(db, draftId, "self_reflection");
    expect(own.sectionIds).toHaveLength(6);
    expect(own.omittedSectionIds).toEqual([]);
    expect(own.text).toContain("what the declined questions cost");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The provenance-and-redistribution notice                                */
/* -------------------------------------------------------------------------- */

describe("the provenance-and-redistribution notice", () => {
  const basis = {
    confirmedItems: 9,
    byClient: 4,
    byCounterparty: 5,
    clientPseudonym: "乙",
  };

  it("says what it is, what it rests on and what not to do with it", () => {
    const notice = provenanceNotice({ ...basis, level: "L1" });
    expect(notice.startsWith(NOTICE_OPENING)).toBe(true);
    expect(notice).toContain("Produced at level L1 on 9 confirmed items");
    expect(notice.endsWith(NOTICE_REDISTRIBUTION)).toBe(true);
    expect(hasProvenanceNotice(notice)).toBe(true);
  });

  it("adapts per level, and carries doc 01's one-sidedness label at L2", () => {
    const l2 = provenanceNotice({ ...basis, level: "L2" });
    // Merged, not stacked: the one-sidedness statement IS the basis clause.
    expect(l2).toContain("Produced at level L2");
    expect(l2).toContain("all of them from one person's account");
    expect(l2).toContain("The other person has not been heard");

    const l1 = provenanceNotice({ ...basis, level: "L1" });
    expect(l1).toContain("4 from 乙 and 5 from the other party");
    expect(l1).toContain("both accounts on the record");
    expect(l1).not.toContain("has not been heard");

    expect(provenanceNotice({ ...basis, level: "L3" })).toContain(
      "too thin a record to allocate anything",
    );
    expect(provenanceNotice({ ...basis, level: "refused" })).toContain(
      "nothing was decided",
    );

    // Every level produces a notice the gate recognises.
    for (const level of OUTPUT_LEVELS) {
      expect(hasProvenanceNotice(provenanceNotice({ ...basis, level }))).toBe(
        true,
      );
    }
  });

  it("cannot itself trip the checks the shareable copy runs", () => {
    for (const level of OUTPUT_LEVELS) {
      const view = renderShareable(counterpartyNarrative(), {
        level,
        basis: { ...basis, level },
        clientPseudonym: "乙",
      });
      expect(view.text.startsWith(NOTICE_OPENING)).toBe(true);
    }
  });

  it("is refused out of a document that lost it", () => {
    const view = renderShareable(counterpartyNarrative(), {
      level: "L1",
      basis: { ...basis, level: "L1" },
      clientPseudonym: "乙",
    });
    const stripped = view.text.replace(NOTICE_REDISTRIBUTION, "");
    expect(() => assertShareable(stripped)).toThrowError(RenditionError);
    try {
      assertShareable(stripped);
    } catch (error) {
      const failure = error as RenditionError;
      expect(failure.violations[0].code).toBe("frame_missing");
      expect(failure.violations[0].detail).toContain("notice");
    }
  });

  it("rides on the stored rendition and on the export path", async () => {
    const { caseId, draftId } = seedDraft("L1");
    const published = publishToBothParties(db, draftId, {
      surfaceLayer: counterpartyNarrative(),
      model: "claude-fable-5",
    });
    expect(published.kind).toBe("released");

    // The door the share screen and the token path read through.
    const shared = readRenditionView(db, draftId, "shareable");
    expect(hasProvenanceNotice(shared.text)).toBe(true);
    expect(shared.text).toContain("Produced at level L1 on 9 confirmed items");

    // The export path, which re-runs the gate over the watermarked bytes.
    const { exportRendition } = await import("../src/server/judgment");
    const doc = exportRendition(db, {
      judgmentId: draftId,
      channel: "file",
      recipient: { pseudonym: "甲" },
    });
    expect(hasProvenanceNotice(doc.text)).toBe(true);
    expect(caseId).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 3b. No document ships a link that does not open                            */
/* -------------------------------------------------------------------------- */

describe("the way in is never a dead link", () => {
  const frame = {
    level: "L1" as const,
    basis: {
      level: "L1" as const,
      confirmedItems: 9,
      byClient: 4,
      byCounterparty: 5,
      clientPseudonym: "乙",
    },
  };

  it("knows which entry points are doors and which are not", () => {
    // The tokenless prefix is the dead one: /respond is not a page.
    expect(isResolvableEntryPoint("/respond")).toBe(false);
    expect(isResolvableEntryPoint("/respond/")).toBe(false);
    expect(isResolvableEntryPoint(undefined)).toBe(false);
    expect(isResolvableEntryPoint("   ")).toBe(false);
    expect(isResolvableEntryPoint("/respond/abc123")).toBe(true);
    expect(isResolvableEntryPoint("https://example.test/r/abc")).toBe(true);
  });

  it("ends on words, not on /respond, when there is no working door", () => {
    const view = renderShareable(counterpartyNarrative(), frame);
    expect(view.text.trimEnd().endsWith(RESPONSE_WITHOUT_LINK)).toBe(true);
    expect(view.text).not.toContain("/respond");
    expect(deadRespondPointers(view.text)).toEqual([]);
    // It says who holds the door, which is the part that makes it actionable.
    expect(view.text).toContain("only the person who sent this can open one");
  });

  it("prints the link when the caller holds one that opens", () => {
    const view = renderShareable(counterpartyNarrative(), {
      ...frame,
      responseEntryPoint: "/respond/tok-abc",
    });
    expect(view.text.trimEnd().endsWith("Add your side of it here: /respond/tok-abc")).toBe(
      true,
    );
    expect(deadRespondPointers(view.text)).toEqual([]);
  });

  it("refuses a document whose own prose points at the dead route", () => {
    const narrative = counterpartyNarrative();
    expect(() =>
      renderShareable(
        {
          sections: [
            ...narrative.sections,
            {
              section_id: "cp-helpful",
              kind: "disclosure",
              audience: "both",
              heading: "How to answer",
              text: "You can add your side at /respond whenever you like.",
              claim_ids: [],
            },
          ],
        },
        frame,
      ),
    ).toThrowError(RenditionError);
  });

  it("ships no unresolvable pointer through any rendition or export path", async () => {
    const { draftId } = seedDraft("L1");
    publishToBothParties(db, draftId, {
      surfaceLayer: counterpartyNarrative(),
      model: "claude-fable-5",
    });

    const { exportRendition } = await import("../src/server/judgment");
    const documents = [
      readRenditionView(db, draftId, "self_reflection").text,
      readRenditionView(db, draftId, "shareable").text,
      exportRendition(db, {
        judgmentId: draftId,
        channel: "file",
        recipient: { pseudonym: "甲" },
      }).text,
      exportRendition(db, {
        judgmentId: draftId,
        channel: "print",
        recipient: { pseudonym: "甲" },
      }).text,
    ];

    for (const document of documents) {
      expect(deadRespondPointers(document)).toEqual([]);
      expect(document).not.toContain("/respond");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Simultaneous release                                                    */
/* -------------------------------------------------------------------------- */

describe("simultaneous release (doc 05 §A.1 state 6)", () => {
  it("writes both copies in the transaction that freezes the judgment", () => {
    const { draftId } = seedDraft("L1");
    const outcome = publishToBothParties(db, draftId, {
      surfaceLayer: counterpartyNarrative(),
      model: "claude-fable-5",
      effort: "high",
    });

    expect(outcome.kind).toBe("released");
    if (outcome.kind !== "released") return;

    const release = outcome.release;
    expect(release.state).toBe("released");
    expect(release.twoParty).toBe(true);
    expect(release.clientCopyExists).toBe(true);
    expect(release.counterpartyCopyExists).toBe(true);
    expect(release.missing).toEqual([]);
    // Not "close together" — the same instant, recorded on both rows.
    expect(release.releasedAt).not.toBeNull();
    const rows = db
      .select({
        kind: judgmentRenditions.kind,
        generatedAt: judgmentRenditions.generatedAt,
      })
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.judgmentId, draftId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0].generatedAt?.getTime()).toBe(rows[1].generatedAt?.getTime());
    expect(outcome.judgment.finalizedAt?.getTime()).toBe(
      release.releasedAt?.getTime(),
    );
  });

  it("publishes nothing at all when her copy does not hold up", () => {
    const { draftId } = seedDraft("L1");
    const broken = counterpartyNarrative();
    const outcome = publishToBothParties(db, draftId, {
      surfaceLayer: {
        sections: [
          {
            ...broken.sections[0],
            // Addressed to the wrong person: the M4 defect, in her copy.
            text: "You, 乙, submitted this case and have 5 lines on file.",
          },
        ],
      },
      model: "claude-fable-5",
    });

    expect(outcome.kind).toBe("rejected");
    // The draft is still a draft, so neither party has read anything.
    const after = readJudgment(db, draftId);
    expect(after?.status).toBe("draft");
    expect(after?.finalizedAt).toBeNull();
    const rows = db
      .select()
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.judgmentId, draftId))
      .all();
    expect(rows).toEqual([]);
  });

  it("reports a two-party version frozen without her copy as pending", () => {
    const { draftId } = seedDraft("L1");
    finalize(db, draftId);

    const release = describeRelease(db, draftId);
    expect(release?.state).toBe("pending");
    expect(release?.twoParty).toBe(true);
    expect(release?.clientCopyExists).toBe(true);
    expect(release?.counterpartyCopyExists).toBe(false);
    expect(release?.missing).toEqual(["shareable"]);
    expect(release?.releasedAt).toBeNull();
  });

  it("does not call a one-sided case pending — it is not waiting for anyone", () => {
    const { draftId } = seedDraft("L2");
    finalize(db, draftId);

    const release = describeRelease(db, draftId);
    expect(release?.state).toBe("single_party");
    expect(release?.twoParty).toBe(false);
    expect(release?.missing).toEqual([]);
  });

  it("never lets one party's reading gate the other's access", () => {
    const { draftId } = seedDraft("L1");
    publishToBothParties(db, draftId, {
      surfaceLayer: counterpartyNarrative(),
      model: "claude-fable-5",
    });

    const snapshot = (): string =>
      JSON.stringify([
        sqlite.prepare("SELECT * FROM judgments WHERE id = ?").all(draftId),
        sqlite
          .prepare("SELECT * FROM judgment_renditions WHERE judgment_id = ?")
          .all(draftId),
      ]);

    const releaseBefore = describeRelease(db, draftId);
    const rowsBefore = snapshot();

    // Both parties read their copies, in one order and then the other. If
    // either read were an unlock — or an act of any kind — one of these would
    // move something.
    readRenditionView(db, draftId, "self_reflection");
    readRenditionView(db, draftId, "shareable");
    readRenditionView(db, draftId, "shareable");
    readRenditionView(db, draftId, "self_reflection");

    expect(describeRelease(db, draftId)).toEqual(releaseBefore);
    expect(snapshot()).toBe(rowsBefore);
  });

  it("refuses to release a version whose own narrative is missing", () => {
    const caseId = seedCase("L1");
    const [row] = db
      .insert(judgments)
      .values({
        caseId,
        version: 1,
        outputLevel: "L1",
        status: "draft",
        model: "claude-fable-5",
        content: factLayer() as unknown as Record<string, unknown>,
      })
      .returning()
      .all();

    const outcome = publishToBothParties(db, row.id, {
      surfaceLayer: counterpartyNarrative(),
      model: "claude-fable-5",
    });
    expect(outcome.kind).toBe("error");
  });

  it("has nothing to say about a judgment that does not exist", () => {
    expect(describeRelease(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
