/**
 * The counterparty's entry screen (SPEC M5 ②) — `/respond/[token]`.
 *
 * Everything here runs against a **local fixture persona**. No invitation is
 * sent anywhere by this suite or by the code it exercises: `issueInviteToken`
 * returns a string to its caller and the machinery stops (SPEC M5, scope
 * boundary). Nobody real is invited to anything.
 *
 * The screen is rendered through the real page module, not a copy of it,
 * because the four things it owes its reader are things a unit test one layer
 * down cannot see:
 *
 *   1. **The judgment is not on it.** Not the narrative, not a claim, not a
 *      finding — only a dated, labelled link. The document was written from one
 *      side; putting it first would turn the rest of the page into a reply to
 *      it. Asserted against the rendered markup AND against the read model, so
 *      it cannot come back through a component that reaches one layer deeper.
 *   2. **The steelman is on it**, in full, above the exits. It is the one
 *      artifact proving the machine argued her side before she arrived.
 *   3. **A refused link shows nothing.** Replayed, expired or invented: the page
 *      says so in plain words and carries no title, no pseudonym, no case id, no
 *      steelman, no judgment.
 *   4. **The three exits are equal.** Same markup, same weight, no primary
 *      button — declining is a recorded answer, not the thing you do when you
 *      fail to find the real button.
 *
 * Evidence content is Chinese and stays Chinese: these are records of what
 * people said, quoted verbatim inside English prose (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page reads the process-wide database; hand it the in-memory one.
// `importActual` is how the real `createDb` stays reachable from a mocked module.
const holder: { db: Db } = { db: null as unknown as Db };

vi.mock("../src/server/db", () => ({
  getDb: () => holder.db,
}));

import {
  issueInviteToken,
  redeemInviteToken,
  shareMaterialIntoCase,
} from "../src/server/access";
import type { Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  files,
  steelmanVersions,
  utterances,
} from "../src/server/db/schema";
import {
  createDraft,
  finalize,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";
import { buildCounterpartyEntry } from "../src/server/participation/entry";
import { declineParticipation } from "../src/server/participation/submission";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** The case's one-line framing, as the client wrote it. */
const CASE_TITLE = "谁该先开口";

/** A line of hers, as it sits in his material. Verbatim, untranslated. */
const HER_LINE = "我周三之前必须知道。";
/** A second line of hers, stored as his recollection rather than a record. */
const HER_RETOLD_LINE = "她说她那天在医院。";

/** The steelman: the machine's version of her case, written before she arrived. */
const STEELMAN_TEXT =
  "甲 asked for a decision and got silence. Read from her side, the delay is " +
  "not impatience — it is three days of being unable to plan anything, after " +
  "asking a question that had a deadline inside it.";

/** A claim in the frozen fact layer. Must not appear on the entry screen. */
const JUDGMENT_CLAIM =
  "乙 did not answer a question that carried a date, and the delay ran to three days.";
/** The narrative surface. Must not appear on the entry screen either. */
const JUDGMENT_NARRATIVE =
  "The cost of the silence fell on the person who had asked for a date.";

let db: Db;
let sqlite: Database.Database;
let caseId: string;
let clientId: string;
let respondentId: string;
let evidenceId: string;
/** Her confirmed line — what the fixture judgment's one claim rests on. */
let herUtteranceId: string;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../src/server/db")>(
    "../src/server/db",
  );
  ({ db, sqlite } = actual.createDb(":memory:"));
  actual.runMigrations(db);
  holder.db = db;
  seedCase();
});

afterEach(() => {
  sqlite.close();
});

/** A case, its two parties, and one item of his material with her words in it. */
function seedCase(): void {
  const [row] = db
    .insert(cases)
    .values({
      stage: "participation",
      title: CASE_TITLE,
      outputLevel: "L2",
      outputLevelLockedAt: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-07-01T00:00:00Z"),
    })
    .returning()
    .all();
  caseId = row.id;

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId,
        role: "initiator",
        displayName: "FIXTURE_CLIENT",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId,
        role: "respondent",
        displayName: "FIXTURE_RESPONDENT",
        pseudonym: "甲",
        isSubmitter: false,
      },
    ])
    .returning()
    .all();
  clientId = parties.find((party) => party.isSubmitter)!.id;
  respondentId = parties.find((party) => !party.isSubmitter)!.id;

  const [file] = db
    .insert(files)
    .values({
      caseId,
      kind: "screenshot",
      sha256: "sha-fixture-1",
      storagePath: "blobs/fixture.png",
      mimeType: "image/png",
      ownerParticipantId: clientId,
    })
    .returning()
    .all();

  // Left at the default `private`, owned by the submitter — the shape the real
  // case has after migration 0011's backfill.
  const [item] = db
    .insert(evidence)
    .values({
      caseId,
      fileId: file.id,
      sourceType: "firsthand",
      gradeSuggested: "A",
      gradeFinal: "A",
      gradeConfirmedAt: new Date("2026-07-02T00:00:00Z"),
      contentSummary: "微信聊天记录",
      ownerParticipantId: clientId,
      createdAt: new Date("2026-07-02T00:00:00Z"),
    })
    .returning()
    .all();
  evidenceId = item.id;

  const lines = db
    .insert(utterances)
    .values([
      {
        caseId,
        evidenceId,
        aiDraft: HER_LINE,
        humanFinal: HER_LINE,
        confirmStatus: "confirmed",
        speakerParticipantId: respondentId,
        speakerLabel: "甲",
        orderKey: "a0",
        ownerParticipantId: clientId,
      },
      {
        caseId,
        evidenceId,
        aiDraft: HER_RETOLD_LINE,
        confirmStatus: "pending",
        isRetold: true,
        speakerParticipantId: respondentId,
        speakerLabel: "甲",
        orderKey: "a1",
        ownerParticipantId: clientId,
      },
      {
        caseId,
        evidenceId,
        aiDraft: "我那几天在赶项目。",
        humanFinal: "我那几天在赶项目。",
        confirmStatus: "confirmed",
        speakerParticipantId: clientId,
        speakerLabel: "乙",
        orderKey: "a2",
        ownerParticipantId: clientId,
      },
    ])
    .returning()
    .all();
  herUtteranceId = lines[0].id;
}

function seedSteelman(
  overrides: Partial<typeof steelmanVersions.$inferInsert> = {},
): void {
  db.insert(steelmanVersions)
    .values({
      caseId,
      version: 1,
      aiDraft: STEELMAN_TEXT,
      confirmStatus: "confirmed",
      verdict: "accepted",
      verdictAt: new Date("2026-07-10T00:00:00Z"),
      ...overrides,
    })
    .run();
}

function seedJudgment(): string {
  const factLayer: FactLayer = {
    claims: [
      {
        claim_id: "c1",
        statement: JUDGMENT_CLAIM,
        evidence_refs: [herUtteranceId],
        confidence: 0.8,
        tier: "inferred",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 2, by_client: 1, by_counterparty: 1 },
        parties_without_citable_utterance: [],
        statement: "Two confirmed lines, one from each party.",
      },
      unresolved: [],
      responsibility: [],
    },
  };
  const surfaceLayer: SurfaceLayer = {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the silence cost",
        text: JUDGMENT_NARRATIVE,
        claim_ids: ["c1"],
      },
    ],
  };

  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer,
    surfaceLayer,
  });
  finalize(db, draft.id);
  return draft.id;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

async function renderPage(token: string): Promise<string> {
  const pageModule = await import("../src/app/respond/[token]/page");
  const element = await pageModule.default({
    params: Promise.resolve({ token }),
  });
  return renderToStaticMarkup(element);
}

/** Rendered markup reduced to the words a reader sees. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;/g, "'")
    .replace(/\s+/g, " ");
}

function liveToken(): string {
  return issueInviteToken(db, respondentId).token;
}

function respondentRow() {
  return db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, respondentId))
    .get()!;
}

/**
 * Every row in the database, as one comparable value.
 *
 * Used to assert that rendering the entry screen writes nothing (doc 05 §A.5
 * question 3). Checking `respond_state` alone would have passed for a page that
 * stamped `last_seen_at`, wrote a consent event, or touched an `updated_at`
 * three tables over — and "nothing is recorded" is a claim about all of them.
 */
function snapshot(): string {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];

  return JSON.stringify(
    tables.map((table) => [
      table.name,
      sqlite.prepare(`SELECT * FROM "${table.name}"`).all(),
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* What the screen leads with                                                 */
/* -------------------------------------------------------------------------- */

describe("a valid invitation", () => {
  it("says what this is and who brought it, before anything else", async () => {
    seedSteelman();
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain(
      "Someone has asked a machine to look at a disagreement you are part of",
    );
    expect(text).toContain("the person this record calls 乙");
    expect(text).toContain("2026-07-01");
    // Her own marker, so she knows which one she is everywhere else.
    expect(text).toContain("甲");
    // The client's one-line framing, verbatim and untranslated.
    expect(text).toContain(CASE_TITLE);

    // The order doc 05 §A.5 fixes, and it is not the order M5 shipped. Question
    // 2 is "who made it and what it already says about you", and its first
    // answer is the steelman — the only thing on the page written FOR her —
    // before the summary of how much of her speech somebody else has filed.
    // Then the document, linked. Then what happens if she closes the tab. Then
    // the three exits, last, because every question has to be answered before
    // she is asked for anything.
    const whatThisIs = text.indexOf("Someone has asked a machine");
    const steelman = text.indexOf("The strongest version of your side");
    const holdings = text.indexOf("What is already on file about you");
    const judgment = text.indexOf("The document that was written without you");
    const closing = text.indexOf("What happens if you close this tab");
    const exits = text.indexOf("What you can do from here");
    expect(whatThisIs).toBeGreaterThanOrEqual(0);
    expect(steelman).toBeGreaterThan(whatThisIs);
    expect(holdings).toBeGreaterThan(steelman);
    expect(judgment).toBeGreaterThan(holdings);
    expect(closing).toBeGreaterThan(judgment);
    expect(exits).toBeGreaterThan(closing);
  });

  it("summarizes what is held about her, with provenance and no material", async () => {
    seedSteelman();
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("What is already on file about you");
    expect(text).toContain("1 item of material");
    expect(text).toContain("by 乙");
    expect(text).toContain("None of it came from you");
    expect(text).toContain("2026-07-02");
    // Provenance, item by item: what kind, whose, when, what grade.
    expect(text).toContain("First-hand record");
    expect(text).toContain("grade A");
    expect(text).toContain("submitted by 乙 on 2026-07-02");
    expect(text).toContain("3 lines, 2 quoted as yours");

    // A summary she can act on — counts, not the record itself. Her own words
    // are on file and are NOT read back to her here.
    expect(text).not.toContain(HER_LINE);
    expect(text).not.toContain(HER_RETOLD_LINE);
    expect(text).not.toContain("微信聊天记录");
  });

  it("counts what is confirmed and what is only somebody's recollection", async () => {
    seedSteelman();
    const html = await renderPage(liveToken());
    const text = visibleText(html);

    expect(text).toContain("Lines quoted as yours");
    expect(text).toContain("Of those, confirmed");
    expect(text).toContain("Of those, recalled");
    // 2 attributed to her, 1 confirmed, 1 retold — the third line is his.
    expect(html).toContain(">2</dd>");
    expect(html).toContain(">1</dd>");
    expect(text).toContain(
      "Only confirmed lines may be quoted in anything the machine writes",
    );
  });

  it("does not count material she has not put into the case record", async () => {
    // Her own private material is outside the case record until she shares it —
    // the query layer's rule (SPEC M5 ①), not this page's.
    db.insert(evidence)
      .values({
        caseId,
        sourceType: "firsthand",
        gradeFinal: "A",
        ownerParticipantId: respondentId,
        createdAt: new Date("2026-07-20T00:00:00Z"),
      })
      .run();
    seedSteelman();

    expect(visibleText(await renderPage(liveToken()))).toContain(
      "1 item of material",
    );

    shareMaterialIntoCase(db, {
      caseId,
      ownerParticipantId: respondentId,
      note: "我把我这边的东西也放进来。",
    });

    const after = visibleText(await renderPage(liveToken()));
    expect(after).toContain("2 items of material");
    expect(after).toContain("by 乙 and 甲");
    // And the sentence that would now be false is gone.
    expect(after).not.toContain("None of it came from you");
  });
});

/* -------------------------------------------------------------------------- */
/* The steelman                                                               */
/* -------------------------------------------------------------------------- */

describe("the steelman of her own position", () => {
  it("renders in full, above the exits", async () => {
    seedSteelman();
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain(STEELMAN_TEXT);
    expect(text).toContain(
      "The strongest version of your side that this machine could write without you",
    );
    expect(text).toContain("before you arrived");
    expect(text).toContain("(version 1)");
    // The client's answer to it is a fact about the record and is stated.
    expect(text).toContain("said it was a fair statement of your position");

    const steelman = text.indexOf(STEELMAN_TEXT);
    const exits = text.indexOf("What you can do from here");
    expect(steelman).toBeGreaterThan(0);
    expect(exits).toBeGreaterThan(steelman);
  });

  it("shows the machine's own draft when the client rewrote it, and says so", async () => {
    const HIS_REWRITE = "她其实只是想要一个答复，别的都不重要。";
    seedSteelman({ humanFinal: HIS_REWRITE, verdict: "rebutted" });

    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain(STEELMAN_TEXT);
    // His version of her position is not put in her mouth on this screen.
    expect(text).not.toContain(HIS_REWRITE);
    expect(text).toContain("They also rewrote it");
    expect(text).toContain("said it is not what you would say");
  });

  it("says the machine could not write one, rather than showing a blank", async () => {
    seedSteelman({ aiDraft: null, verdict: "unable" });
    db.update(cases)
      .set({
        downgradeSignal: true,
        downgradeReason: "Steelman: the record has nothing from her side to build on.",
      })
      .where(eq(cases.id, caseId))
      .run();

    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("reported that it could not do it from what it has");
    expect(text).toContain("a fact about the record, not a finding about you");
    // The stage's own marker on the reason is bookkeeping, not her sentence.
    expect(text).toContain("the record has nothing from her side to build on");
    expect(text).not.toContain("Steelman:");
  });

  it("says nothing has been written when the stage never ran", async () => {
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("No version of your side has been written yet");
    expect(text).toContain("a fact about the record, not a finding about you");
  });
});

/* -------------------------------------------------------------------------- */
/* The judgment is named, never rendered                                      */
/* -------------------------------------------------------------------------- */

describe("the judgment", () => {
  it("is absent from the screen — text, claims and narrative alike", async () => {
    seedSteelman();
    seedJudgment();

    const html = await renderPage(liveToken());
    const text = visibleText(html);

    expect(text).not.toContain(JUDGMENT_NARRATIVE);
    expect(text).not.toContain(JUDGMENT_CLAIM);
    expect(text).not.toContain("What the silence cost");
    // Nor anywhere in the markup — an attribute is still a leak.
    expect(html).not.toContain(JUDGMENT_NARRATIVE);
    expect(html).not.toContain(JUDGMENT_CLAIM);
  });

  it("is not even in the read model the screen renders from", async () => {
    seedSteelman();
    seedJudgment();

    const outcome = buildCounterpartyEntry(db, liveToken());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The strongest form of the assertion: a component cannot render text the
    // read model never selected, and a later edit that wants to has to add the
    // column and argue for it.
    const serialized = JSON.stringify(outcome.view);
    expect(serialized).not.toContain(JUDGMENT_NARRATIVE);
    expect(serialized).not.toContain(JUDGMENT_CLAIM);
    expect(outcome.view.judgment).toMatchObject({ exists: true, version: 1 });
  });

  it("is linked and labelled, after the exits", async () => {
    seedSteelman();
    seedJudgment();

    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("The document that was written without you");
    expect(text).toContain("a one-sided analysis, written from one account only");
    expect(text).toContain("It is not on this screen on purpose");
    expect(text).toContain("the transparency view");
  });

  it("says plainly that nothing has been written, when nothing has", async () => {
    seedSteelman();
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("Nothing has been written about this case yet");
  });

  it("does not offer a draft as a document", async () => {
    seedSteelman();
    createDraft(db, caseId, {
      model: "claude-fable-5",
      effort: "xhigh",
      factLayer: {
        claims: [
          {
            claim_id: "c1",
            statement: JUDGMENT_CLAIM,
            evidence_refs: [herUtteranceId],
            confidence: 0.8,
            tier: "inferred",
          },
        ],
        findings: {
          record_basis: {
            client_pseudonym: "乙",
            citable_utterances: { total: 2, by_client: 1, by_counterparty: 1 },
            parties_without_citable_utterance: [],
            statement: "Two confirmed lines, one from each party.",
          },
          unresolved: [],
          responsibility: [],
        },
      },
      surfaceLayer: {
        sections: [
          {
            section_id: "s1",
            kind: "finding",
            audience: "both",
            heading: "What the silence cost",
            text: JUDGMENT_NARRATIVE,
            claim_ids: ["c1"],
          },
        ],
      },
    });

    // A draft is work in progress; nothing is handed to anybody out of one —
    // the same rule `mintShareToken` enforces on the export side.
    const text = visibleText(await renderPage(liveToken()));
    expect(text).toContain("Nothing has been written about this case yet");
    expect(text).not.toContain(JUDGMENT_NARRATIVE);
  });
});

/* -------------------------------------------------------------------------- */
/* The three exits                                                            */
/* -------------------------------------------------------------------------- */

describe("what she can do from here", () => {
  it("offers three doors, and declining is one of them", async () => {
    seedSteelman();
    const token = liveToken();
    const html = await renderPage(token);
    const text = visibleText(html);

    const base = `/respond/${encodeURIComponent(token)}`;
    expect(html).toContain(`href="${base}/submit"`);
    expect(html).toContain(`href="${base}/data"`);
    // Declining has its own screen now, so that the exit for the person who
    // wants nothing to do with this does not open the form for taking part.
    expect(html).toContain(`href="${base}/decline"`);

    expect(text).toContain("Add your account");
    expect(text).toContain("Decline");
    expect(text).toContain("Read everything held about you first");
    expect(text).toContain("Doing nothing is also an answer");
  });

  it("gives the three the same weight, with no primary button", async () => {
    seedSteelman();
    const html = await renderPage(liveToken());

    // Every exit anchor carries the identical class list: no bright button for
    // participating and no grey link for saying no.
    const exitClasses = [...html.matchAll(/<a\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('href="/respond/'))
      .map((tag) => /class="([^"]*)"/.exec(tag)?.[1] ?? "")
      .filter((cls) => cls.includes("rounded-xl"));
    expect(exitClasses).toHaveLength(3);
    expect(new Set(exitClasses).size).toBe(1);
  });

  it("never links into the client's side of the product", async () => {
    seedSteelman();
    seedJudgment();
    const html = await renderPage(liveToken());

    // She is the person the case is about, not a user of the client's
    // workspace. A link is the kind of thing that gets added by habit.
    for (const route of ["/case/", "/evidence", "/timeline", "/translate"]) {
      expect(html).not.toContain(`href="${route}`);
    }
    expect(html).not.toContain(caseId);
  });

  it("records nothing at all — opening the page is not an act", async () => {
    seedSteelman();
    seedJudgment();
    const token = liveToken();
    const before = snapshot();

    // Doc 05 §A.5 question 3, asserted against the database rather than against
    // the sentence the page prints. `markInviteOpened` used to run here and
    // moved `respond_state` invited → opened; it is gone, and so is the state
    // transition. Three renders, byte-identical record.
    await renderPage(token);
    await renderPage(token);
    await renderPage(token);

    expect(snapshot()).toEqual(before);
    expect(respondentRow().respondState).toBe("invited");
  });

  it("says so on the screen, in as many words", async () => {
    seedSteelman();
    const text = visibleText(await renderPage(liveToken()));

    expect(text).toContain("What happens if you close this tab");
    expect(text).toContain(
      "Opening this page is not reported to anyone and reading is not recorded as an act",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The decline screen                                                         */
/* -------------------------------------------------------------------------- */

/** Renders `/respond/[token]/decline` through the real page module. */
async function renderDecline(token: string): Promise<string> {
  const pageModule = await import("../src/app/respond/[token]/decline/page");
  const element = await pageModule.default({
    params: Promise.resolve({ token }),
  });
  return renderToStaticMarkup(element);
}

describe("the decline screen", () => {
  it("states all four consequences before the act, not after it", async () => {
    const text = visibleText(await renderDecline(liveToken()));

    // Doc 05 §A.4, verbatim in substance: refused by her own act; the existing
    // judgment stands unchanged at its one-sided level; later versions state
    // "invited, declined" as a fact and may infer nothing from it; she keeps
    // this door.
    expect(text).toContain("What declining does, exactly");
    expect(text).toContain("recorded as refused, by your own act");
    expect(text).toContain("stands unchanged");
    expect(text).toContain("invited on a date, declined on a date");
    expect(text).toContain("Nothing may be inferred from it");
    expect(text).toContain("You keep this door");
    expect(text).toContain("Nothing is written until you confirm");
  });

  it("records nothing by being opened", async () => {
    const token = liveToken();
    const before = snapshot();

    await renderDecline(token);
    await renderDecline(token);

    expect(snapshot()).toEqual(before);
    expect(respondentRow().respondState).toBe("invited");
  });

  it("becomes the record of the act, and offers the reversal", async () => {
    const token = liveToken();
    declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: "我不想参与这件事。",
    });

    const text = visibleText(await renderDecline(token));

    expect(text).toContain("Recorded: you are not taking part");
    // Her words, verbatim and untranslated.
    expect(text).toContain("我不想参与这件事。");
    expect(text).toContain("No further invitation can be created for you");
    expect(text).toContain("Your link no longer expires");
    expect(text).toContain("Take this answer back");
  });

  it("keeps the other two doors in view at the same weight", async () => {
    const token = liveToken();
    const html = await renderDecline(token);
    const base = `/respond/${encodeURIComponent(token)}`;

    expect(html).toContain(`href="${base}/submit"`);
    expect(html).toContain(`href="${base}/data"`);
    for (const route of ["/case/", "/evidence", "/timeline", "/translate"]) {
      expect(html).not.toContain(`href="${route}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A link that does not work                                                  */
/* -------------------------------------------------------------------------- */

describe("a token that is refused", () => {
  /** Every string this case could leak. None may appear on a refusal page. */
  function caseContent(): readonly string[] {
    return [
      CASE_TITLE,
      HER_LINE,
      HER_RETOLD_LINE,
      STEELMAN_TEXT,
      JUDGMENT_CLAIM,
      JUDGMENT_NARRATIVE,
      "微信聊天记录",
      caseId,
      evidenceId,
      "甲",
      "乙",
      "FIXTURE_CLIENT",
      "FIXTURE_RESPONDENT",
    ];
  }

  function expectNoCaseContent(html: string): void {
    const text = visibleText(html);
    for (const secret of caseContent()) {
      expect(html).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
  }

  it("refuses a replayed token without pretending it never existed", async () => {
    seedSteelman();
    seedJudgment();
    const token = liveToken();
    expect(redeemInviteToken(db, token).ok).toBe(true);

    const html = await renderPage(token);
    const text = visibleText(html);

    expect(text).toContain("This link did not open anything");
    expect(text).toContain("already been used");
    expect(text).toContain("Nothing has gone wrong on your side");
    expectNoCaseContent(html);
  });

  it("opens for the identity token she got in exchange for the invitation", async () => {
    // The seam the L1 run walked into: the invitation is single-use, so a party
    // who has joined holds a SPENT link plus an identity token. `/submit` and
    // `/data` resolve either; this screen used to resolve only the first, so
    // the page explaining what any of this is became unreachable at exactly the
    // moment she took part.
    seedSteelman();
    seedJudgment();
    const redeemed = redeemInviteToken(db, liveToken());
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("unreachable");

    const text = visibleText(await renderPage(redeemed.identityToken));

    expect(text).not.toContain("This link did not open anything");
    expect(text).toContain("Someone has asked a machine to look at a disagreement");
    // The branch that could never render before.
    expect(text).toContain("You have already set up your side of this");
    // And it is still the entry screen: the steelman, not the judgment.
    expect(text).toContain(STEELMAN_TEXT);
    expect(text).not.toContain(JUDGMENT_NARRATIVE);
  });

  it("refuses an expired token", async () => {
    seedSteelman();
    seedJudgment();
    const now = new Date("2026-08-10T12:00:00Z");
    const invite = issueInviteToken(db, respondentId, { ttlMs: 1000, now });

    // The page reads the wall clock, and the fixture's expiry is in the past by
    // the time this line runs — which is the situation being tested.
    const html = await renderPage(invite.token);
    const text = visibleText(html);

    expect(text).toContain("This link did not open anything");
    expect(text).toContain("expired");
    expectNoCaseContent(html);
  });

  it("refuses a token nobody minted, and one that is empty", async () => {
    seedSteelman();
    seedJudgment();
    issueInviteToken(db, respondentId);

    for (const token of ["not-a-token-anyone-minted", "   "]) {
      const html = await renderPage(token);
      expect(visibleText(html)).toContain("This link did not open anything");
      expect(visibleText(html)).toContain("not one this machine issued");
      expectNoCaseContent(html);
    }
  });

  it("offers no way onward from a refusal", async () => {
    seedSteelman();
    seedJudgment();
    const html = await renderPage("not-a-token-anyone-minted");

    // No submit route, no transparency view, no case: a link that cannot be
    // verified is not a way to reach anything.
    expect(html).not.toContain("href=");
  });

  it("does not record anything about a party whose link was refused", async () => {
    seedSteelman();
    issueInviteToken(db, respondentId);
    expect(respondentRow().respondState).toBe("invited");

    await renderPage("not-a-token-anyone-minted");
    expect(respondentRow().respondState).toBe("invited");
  });
});
