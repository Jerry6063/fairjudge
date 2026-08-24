/**
 * Dual-version renditions (M3 wave B ⑪, M4 ①).
 *
 * The thing under test is a refusal. `self_reflection` carries the criticism
 * written for the client, so the server does not mint a share token for it —
 * not "the button is hidden", not "the UI does not offer it": the service
 * function throws, and it throws again if the database row is doctored to say
 * the rendition is shareable.
 *
 * The second thing is what a shareable document is allowed to say. It opens with
 * a label naming what it is, it ends by inviting a conversation and pointing at
 * where the other party can answer, and it carries neither win/lose framing nor
 * a responsibility percentage. Those are asserted on the text that actually
 * leaves the machine, because that is the only text a recipient sees.
 *
 * Since M4 there is a third thing: the shareable copy is a narrative of its own,
 * written to the counterparty from the same frozen fact layer, so the fixture
 * seeds two narratives. A judgment with no counterparty narrative has no
 * shareable copy at all — asserted below, because the alternative (fall back to
 * filtering the client's copy) is the defect this milestone removed.
 *
 * Evidence quoted in the fixtures is Chinese, verbatim, and untranslated — and
 * is deliberately used to prove the language check does not scan it.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases, judgmentRenditions } from "../src/server/db/schema";
import {
  INVITATION_TEXT,
  JudgmentStoreError,
  NOTICE_OPENING,
  NOTICE_REDISTRIBUTION,
  RESPONSE_WITHOUT_LINK,
  hasProvenanceNotice,
  RESPONSE_PROMPT,
  RenditionError,
  checkShareableLanguage,
  createDraft,
  finalize,
  hashShareToken,
  mintShareToken,
  persistShareableNarrative,
  readRenditionView,
  readSharedRendition,
  renderShareable,
  type FactLayer,
  type ShareableFrame,
  type SurfaceLayer,
} from "../src/server/judgment";

/**
 * What every pure `renderShareable` call in this file frames its document with.
 *
 * L2 is the restrictive projection and the level these fixtures are written at;
 * the L1 widening has its own tests in `judgment-contract.test.ts` (the
 * projection) and below (the notice per level).
 */
const L2_FRAME: ShareableFrame = {
  level: "L2",
  basis: {
    level: "L2",
    confirmedItems: 2,
    byClient: 0,
    byCounterparty: 2,
    clientPseudonym: "乙",
  },
};

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

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a deadline and treated it as already agreed.",
        evidence_refs: ["u-1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement: "乙's own words are not in the confirmed record.",
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
        { party: "甲", allocation: "contributing", claim_ids: ["c1"] },
        { party: "乙", allocation: "not_established", claim_ids: ["c2"] },
      ],
    },
  };
}

function surfaceLayer(
  overrides: { readonly bothText?: string; readonly selfText?: string } = {},
): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the record shows",
        text:
          overrides.bothText ??
          "甲 stated a deadline in writing and treated it as settled: " +
            "“我周三之前必须知道”. What 乙 answered is not in the confirmed record.",
        claim_ids: ["c1"],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "What this asks of you",
        text:
          overrides.selfText ??
          "You read a deadline as an ultimatum and stopped answering. Nothing " +
            "in the record shows you said that at the time.",
        claim_ids: ["c1", "c2"],
      },
      {
        section_id: "s3",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text: "Only one account was available, so nothing here settles intent.",
        claim_ids: [],
      },
    ],
  };
}

/**
 * The counterparty's copy (M4 ①) — the same two claims, written to 甲.
 *
 * Deliberately not a rephrasing of the client's sections: 甲 is "you" here, 乙
 * is a named third party, and the document says the one thing the client's copy
 * has no reason to say — that its reader was never asked.
 */
function counterpartyLayer(
  overrides: { readonly bothText?: string } = {},
): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "t1",
        kind: "finding",
        audience: "both",
        heading: "What the record holds",
        text:
          overrides.bothText ??
          "This was written from two messages of yours. In one of them you " +
            "put a date on the answer you wanted and treated it as agreed: " +
            "“我周三之前必须知道”. What 乙 replied that evening is not in the " +
            "confirmed record, and neither is anything you have not sent in " +
            "writing.",
        claim_ids: ["c1"],
      },
      {
        section_id: "t2",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text:
          "You were never asked for your account, so nothing here settles " +
          "what either of you meant by any of it.",
        claim_ids: [],
      },
    ],
  };
}

/**
 * A finalized judgment, which is when renditions come into existence.
 *
 * `withCounterpartyNarrative: false` leaves the shareable row empty — the state
 * a judgment is in between freezing and the shareable_narrative stage running.
 */
function seedFinalJudgment(
  overrides: {
    readonly bothText?: string;
    readonly selfText?: string;
    readonly counterpartyText?: string;
    readonly withCounterpartyNarrative?: boolean;
  } = {},
): { caseId: string; judgmentId: string } {
  const caseId = seedCase();
  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: surfaceLayer(overrides),
  });
  finalize(db, draft.id);

  if (overrides.withCounterpartyNarrative !== false) {
    persistShareableNarrative(
      db,
      draft.id,
      counterpartyLayer({ bothText: overrides.counterpartyText }),
      { model: "claude-fable-5", effort: "high" },
    );
  }

  return { caseId, judgmentId: draft.id };
}

/* -------------------------------------------------------------------------- */
/* The two audiences                                                          */
/* -------------------------------------------------------------------------- */

describe("the two renditions", () => {
  it("gives the client the criticism and withholds it from the shareable copy", () => {
    const { judgmentId } = seedFinalJudgment();

    const own = readRenditionView(db, judgmentId, "self_reflection");
    expect(own.criticismSectionIds).toEqual(["s2"]);
    expect(own.sectionIds).toEqual(["s1", "s2", "s3"]);
    expect(own.text).toContain("You read a deadline as an ultimatum");
    expect(own.shareable).toBe(false);

    const shared = readRenditionView(db, judgmentId, "shareable");
    expect(shared.text).not.toContain("You read a deadline as an ultimatum");
    expect(shared.shareable).toBe(true);
    // Not the client's sections at all: a different document over the same
    // claims, so there is nothing of the client's copy left to filter.
    expect(shared.sectionIds).toEqual(["t1", "t2"]);
  });

  it("frames the shareable copy: label first, invitation and a way in last", () => {
    const { judgmentId } = seedFinalJudgment();
    const shared = readRenditionView(db, judgmentId, "shareable");

    expect(shared.text.startsWith(NOTICE_OPENING)).toBe(true);
    expect(hasProvenanceNotice(shared.text)).toBe(true);
    expect(shared.text).toContain(INVITATION_TEXT);
    // The way in is words, not a dead link: `/respond` on its own is not a
    // page, and a pointer that fails when she follows it is worse than being
    // told plainly that the sender holds the invitation.
    expect(shared.text.trimEnd().endsWith(RESPONSE_WITHOUT_LINK)).toBe(true);
    expect(shared.text).not.toContain("/respond");

    // Same evidence, quoted verbatim, in both copies: the two documents rest on
    // one frozen fact layer and differ in who they are talking to.
    expect(shared.text).toContain("我周三之前必须知道");
  });

  /**
   * The M3 defect, stated as a rule. There is no fallback to filtering: a
   * judgment whose counterparty narrative has not been generated has no
   * shareable copy, and asking for one says so instead of handing back the
   * client's copy with sections removed.
   */
  it("has no shareable copy until the counterparty narrative exists", () => {
    const { judgmentId } = seedFinalJudgment({
      withCounterpartyNarrative: false,
    });

    expect(() => readRenditionView(db, judgmentId, "shareable")).toThrowError(
      RenditionError,
    );
    try {
      readRenditionView(db, judgmentId, "shareable");
    } catch (error) {
      expect((error as RenditionError).code).toBe("shareable_narrative_missing");
    }

    // The client's copy is unaffected: it is the judgment's own narrative.
    expect(readRenditionView(db, judgmentId, "self_reflection").text).toContain(
      "You read a deadline as an ultimatum",
    );
  });

  it("re-derives the frame instead of trusting the stored blob", () => {
    const { judgmentId } = seedFinalJudgment();

    // Doctor the stored rendition, the way an UPDATE or a bad migration would.
    db.update(judgmentRenditions)
      .set({ content: "甲 lost. Nothing else to say." })
      .where(eq(judgmentRenditions.judgmentId, judgmentId))
      .run();

    const shared = readRenditionView(db, judgmentId, "shareable");
    expect(hasProvenanceNotice(shared.text)).toBe(true);
    expect(shared.text).not.toContain("Nothing else to say");
  });
});

/* -------------------------------------------------------------------------- */
/* Forbidden language                                                         */
/* -------------------------------------------------------------------------- */

describe("what a shareable rendition may not say", () => {
  it("rejects win/lose framing", () => {
    expect(() =>
      renderShareable(surfaceLayer({ bothText: "On the deadline, 甲 wins and 乙 is at fault." }), L2_FRAME),
    ).toThrowError(RenditionError);

    try {
      renderShareable(surfaceLayer({ bothText: "On the deadline, 甲 wins and 乙 is at fault." }), L2_FRAME);
    } catch (error) {
      const failure = error as RenditionError;
      expect(failure.code).toBe("unsafe_language");
      expect(failure.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("rejects a responsibility percentage", () => {
    expect(() =>
      renderShareable(surfaceLayer({ bothText: "乙 carries about 70% of the responsibility here." }), L2_FRAME),
    ).toThrowError(/percentage/i);

    // The other three shapes an allocation arrives in.
    for (const text of [
      "The split is roughly 70/30 between them.",
      "乙 carries seventy per cent of it.",
      "这事你占七成责任。",
    ]) {
      expect(checkShareableLanguage(text).length).toBeGreaterThan(0);
    }
  });

  /**
   * Found on the first real judgment: its `limits` section ends "…and no
   * percentage, ratio or score — should be read as answering it", and the check
   * refused to share the document for saying so. A rule that fires on the
   * disclaimer as readily as on the offence silences the sentence the recipient
   * most needs.
   */
  it("allows the judgment to say the word while refusing the thing", () => {
    const disclaimer =
      "This hearing made no allocation of responsibility, and no sentence in " +
      "it — and no percentage, ratio or score — should be read as answering " +
      "that question.";

    expect(checkShareableLanguage(disclaimer)).toEqual([]);
    const view = renderShareable(surfaceLayer({ bothText: disclaimer }), L2_FRAME);
    expect(view.text).toContain("no percentage, ratio or score");
  });

  it("does not scan verbatim evidence, which it may not edit either way", () => {
    // The counterparty's own message contains both a win/lose framing and a
    // number. Quoting it is a fact about the record; suppressing it would be
    // rewriting evidence to pass our own check.
    const quoting =
      "甲 put it to 乙 in these words: “你到底认不认错，这事你占七成责任，" +
      "70% 是你的问题”. What 乙 answered is not in the confirmed record.";

    expect(checkShareableLanguage(quoting)).toEqual([]);
    const view = renderShareable(surfaceLayer({ bothText: quoting }), L2_FRAME);
    expect(view.text).toContain("你到底认不认错");

    // The same words in the judgment's own voice are refused.
    expect(() =>
      renderShareable(
        {
          sections: [
            {
              section_id: "s1",
              kind: "finding",
              audience: "both",
              heading: "Finding",
              text: "This is 70% 乙's responsibility.",
              claim_ids: ["c1"],
            },
          ],
        },
        L2_FRAME,
      ),
    ).toThrowError(RenditionError);
  });

  it("leaves the self-reflection copy alone — it is allowed to be hard", () => {
    const { judgmentId } = seedFinalJudgment({
      selfText: "You lost your temper and stopped answering. That is on you.",
    });

    const own = readRenditionView(db, judgmentId, "self_reflection");
    expect(own.text).toContain("That is on you");
  });

  it("does not mistake 'won't' for a win", () => {
    expect(checkShareableLanguage("甲 won't say what changed.")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Share tokens                                                               */
/* -------------------------------------------------------------------------- */

describe("share tokens", () => {
  it("refuses to mint one for a self-reflection rendition", () => {
    const { judgmentId } = seedFinalJudgment();

    expect(() => mintShareToken(db, judgmentId, "self_reflection")).toThrowError(
      JudgmentStoreError,
    );
    try {
      mintShareToken(db, judgmentId, "self_reflection");
    } catch (error) {
      expect((error as JudgmentStoreError).code).toBe("not_shareable");
    }

    // And nothing was written on the way to refusing.
    const rows = db
      .select()
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.judgmentId, judgmentId))
      .all();
    expect(rows.every((row) => row.shareTokenHash === null)).toBe(true);
  });

  it("still refuses when the row is doctored to say it is shareable", () => {
    const { judgmentId } = seedFinalJudgment();

    db.update(judgmentRenditions)
      .set({ shareable: true })
      .where(eq(judgmentRenditions.kind, "self_reflection"))
      .run();

    expect(() => mintShareToken(db, judgmentId, "self_reflection")).toThrowError(
      JudgmentStoreError,
    );
  });

  it("mints one for the shareable rendition, storing only its hash", () => {
    const { judgmentId } = seedFinalJudgment();
    const minted = mintShareToken(db, judgmentId, "shareable");

    expect(minted.token.length).toBeGreaterThan(20);
    expect(hasProvenanceNotice(minted.text)).toBe(true);
    // The way in carries the token, so the recipient lands somewhere they can answer.
    expect(minted.text.trimEnd().endsWith(`/respond/${minted.token}`)).toBe(true);

    const row = db
      .select()
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.kind, "shareable"))
      .get();
    expect(row?.shareTokenHash).toBe(hashShareToken(minted.token));
    expect(row?.shareTokenHash).not.toBe(minted.token);
    expect(row?.shareExpiresAt).not.toBeNull();
  });

  it("opens the shared document for a valid token and nothing else", () => {
    const { judgmentId } = seedFinalJudgment();
    const minted = mintShareToken(db, judgmentId, "shareable");

    const opened = readSharedRendition(db, minted.token);
    expect(opened.kind).toBe("shareable");
    expect(hasProvenanceNotice(opened.text)).toBe(true);
    expect(opened.text).not.toContain("You read a deadline as an ultimatum");

    expect(() => readSharedRendition(db, "not-a-token")).toThrowError(RenditionError);
  });

  it("refuses an expired token", () => {
    const { judgmentId } = seedFinalJudgment();
    const minted = mintShareToken(db, judgmentId, "shareable", { ttlMs: 1000 });

    const later = new Date(minted.expiresAt.getTime() + 1);
    expect(() => readSharedRendition(db, minted.token, { now: later })).toThrowError(
      /expired/,
    );
  });

  it("refuses to share a draft", () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
      surfaceLayer: surfaceLayer(),
    });

    expect(() => mintShareToken(db, draft.id, "shareable")).toThrowError(RenditionError);
    try {
      mintShareToken(db, draft.id, "shareable");
    } catch (error) {
      expect((error as RenditionError).code).toBe("not_final");
    }
  });
});
