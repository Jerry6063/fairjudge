/**
 * The share screen (`/case/[id]/share`) — the one screen that shows the one
 * artifact that ever leaves this machine.
 *
 * Six properties, and every one of them is about a document reaching a person
 * who never agreed to any of it:
 *
 *   1. **The preview is the document.** Byte-identical to the stored
 *      counterparty rendition, rendered into the page without being trimmed,
 *      summarized or re-wrapped. A preview that showed something else would be
 *      the most consequential lie in the product.
 *   2. **A real name blocks, and the screen names the hit.** Not "export
 *      refused" — which name, which pseudonym it should have been, and the text
 *      around it.
 *   3. **`self_reflection` can never reach this screen.** The criticism written
 *      for the client alone is refused by the gate's own rule, and its text does
 *      not appear in the rendered page.
 *   4. **Revoked consent shuts both doors**, and the refusal carries who
 *      withdrew, in their own words.
 *   5. **Every export writes exactly one audit row.** A refused one writes none.
 *   6. **The L1 audience defect is stated on screen**, above the document,
 *      whenever the judgment being previewed is L1.
 *
 * Rendered against the real page component and the real server actions, because
 * every one of these is a property of the screen rather than of a function it
 * calls. Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The page and the actions talk to the process-wide database and to Next's
 * cache; both are replaced so the whole screen runs in-process. */
let actionDb: Db;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../src/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/db")>();
  return { ...actual, getDb: () => actionDb };
});

import { revokeNamedRendition } from "../src/server/access/consent";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  clarificationRounds,
  judgmentRenditions,
} from "../src/server/db/schema";
import {
  ExportBlockedError,
  NOTICE_OPENING,
  NOTICE_REDISTRIBUTION,
  hasProvenanceNotice,
  RESPONSE_PROMPT,
  createDraft,
  finalize,
  listCaseExports,
  persistShareableNarrative,
  readJudgment,
  readRenditionView,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";
import {
  COOLING_OFF_MIN_MS,
  previewShareableDocument,
  readSendIntent,
  readSharePreview,
} from "../src/server/judgment/share-view";

const { exportShareableCopyAction, mintShareLinkAction } = await import(
  "../src/app/case/[id]/share/actions"
);

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
  actionDb = db;
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** 22 characters of 甲's own message — comfortably over the third-party cap. */
const LONG_QUOTE = "我周三之前必须知道，不然我没法安排接下来的事";

/** The criticism written for the client alone. Must never reach this screen. */
const SELF_ONLY_TEXT =
  "You read a deadline as an ultimatum and stopped answering for four days.";

/** An answer to the doc 01 question that doc 01 has no objection to. */
const PLAIN_INTENT = "I want her to feel that I finally heard what she asked for.";

function seedCase(level: "L1" | "L2" = "L2"): {
  caseId: string;
  clientId: string;
  counterpartyId: string;
} {
  const [row] = db
    .insert(cases)
    .values({
      stage: "post_judgment",
      title: "fixture",
      outputLevel: level,
      outputLevelLockedAt: new Date(),
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
        // Real names live here and nowhere else; they never leave the machine.
        displayName: "Adrian",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        displayName: "知夏",
        isSubmitter: false,
        participationState: "unreachable",
      },
    ])
    .returning()
    .all();

  return {
    caseId: row.id,
    clientId: parties[0].id,
    counterpartyId: parties[1].id,
  };
}

function factLayer(level: "L1" | "L2" = "L2"): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: `甲 put a date on the answer she wanted: “${LONG_QUOTE}”.`,
        evidence_refs: ["u-1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement: "乙 did not reply for four days after that message.",
        evidence_refs: ["u-2"],
        confidence: 0.8,
        tier: "high_confidence",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances:
          level === "L1"
            ? { total: 9, by_client: 4, by_counterparty: 5 }
            : { total: 2, by_client: 0, by_counterparty: 2 },
        parties_without_citable_utterance: level === "L1" ? [] : ["乙"],
        statement:
          level === "L1"
            ? "Nine confirmed lines, four 乙's and five 甲's. Both parties have spoken inside the record."
            : "Two confirmed lines, both 甲's. 乙 has not spoken inside the record.",
      },
      unresolved: [],
      responsibility:
        level === "L1"
          ? [
              { party: "乙", allocation: "shared", claim_ids: ["c1", "c2"] },
              { party: "甲", allocation: "shared", claim_ids: ["c1"] },
            ]
          : [],
    },
  };
}

/** The client's copy. Second person throughout — that is what it is for. */
function clientNarrative(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: "You, 乙, submitted this case. Two lines are on file, both 甲's.",
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "Responsibility: 乙's share",
        text: SELF_ONLY_TEXT,
        claim_ids: ["c1", "c2"],
      },
    ],
  };
}

/**
 * The counterparty's copy: 甲 is "you", 乙 is a third party.
 *
 * `firstText` is what each test varies — it is the sentence the gate is being
 * asked about. The default carries 甲's own 22-character message, which is the
 * quote the attribution rule exempts.
 */
function counterpartyNarrative(
  firstText?: string,
  limitsText?: string,
): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "t1",
        kind: "finding",
        audience: "both",
        heading: "What the record holds",
        text:
          firstText ??
          `This was written from two messages of yours. In one you wrote “${LONG_QUOTE}”.`,
        claim_ids: ["c1"],
      },
      {
        section_id: "t2",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text:
          limitsText ??
          "You were never asked for your account, so nothing here settles what " +
            "either of you meant by any of it.",
        claim_ids: [],
      },
    ],
  };
}

interface Seeded {
  readonly caseId: string;
  readonly clientId: string;
  readonly counterpartyId: string;
  readonly judgmentId: string;
}

interface SeedOptions {
  readonly level?: "L1" | "L2";
  readonly firstText?: string;
  readonly limitsText?: string;
  /** Leave the document freshly written, so the cool-down is still running. */
  readonly fresh?: boolean;
}

/** A frozen judgment with a stored counterparty narrative, ready to share. */
function seedShareable(options: SeedOptions = {}): Seeded {
  const level = options.level ?? "L2";
  const { caseId, clientId, counterpartyId } = seedCase(level);

  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer: factLayer(level),
    surfaceLayer: clientNarrative(),
  });
  finalize(db, draft.id);
  persistShareableNarrative(
    db,
    draft.id,
    counterpartyNarrative(options.firstText, options.limitsText),
    {
      model: "claude-fable-5",
      effort: "high",
      promptVersion: "shareable_narrative.v1",
    },
  );

  // The cool-down runs from when the document was written. Backdate it unless
  // the test is about the pause itself: every other property here is about what
  // happens once the pause has run, and waiting 24 hours is not a test.
  if (options.fresh !== true) {
    db.update(judgmentRenditions)
      .set({ generatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) })
      .where(eq(judgmentRenditions.judgmentId, draft.id))
      .run();
  }

  return { caseId, clientId, counterpartyId, judgmentId: draft.id };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

async function renderPage(caseId: string): Promise<string> {
  const pageModule = await import("../src/app/case/[id]/share/page");
  const element = await pageModule.default({
    params: Promise.resolve({ id: caseId }),
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
    .replace(/\s+/g, " ");
}

/** React's own text escaping, so a byte assertion can be made against markup. */
function escapeForMarkup(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/* -------------------------------------------------------------------------- */
/* 1. The preview is the document                                             */
/* -------------------------------------------------------------------------- */

describe("the document on screen", () => {
  it("is the stored counterparty rendition, byte for byte", async () => {
    const { caseId, judgmentId } = seedShareable();

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // The same string the export path derives, from the same function.
    const stored = readRenditionView(db, judgmentId, "shareable").text;
    expect(read.preview.document).toBe(stored);

    // And it reaches the page unchanged — not trimmed, not re-wrapped, not
    // summarized. Asserted on the raw markup, so whitespace counts.
    const html = await renderPage(caseId);
    expect(html).toContain(escapeForMarkup(stored));
  });

  it("shows the frame the recipient actually reads", async () => {
    const { caseId } = seedShareable();
    const text = visibleText(await renderPage(caseId));

    // The label she reads first, the evidence in the middle, the way in last.
    expect(hasProvenanceNotice(text)).toBe(true);
    expect(text).toContain(LONG_QUOTE);
    expect(text).toContain(`${RESPONSE_PROMPT} /respond`);
    expect(text).toContain("What the record holds");
  });

  it("says what is missing instead of rendering an empty screen", async () => {
    const { caseId } = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      effort: "xhigh",
      factLayer: factLayer(),
      surfaceLayer: clientNarrative(),
    });
    finalize(db, draft.id);
    // No counterparty narrative generated: there is no shareable copy at all.

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("There is no document to show");
    expect(text).toContain("no counterparty-addressed narrative");
    expect(text).toContain("npm run judgment:shareable");
    // And nothing from the client's copy leaked into the empty state.
    expect(text).not.toContain(SELF_ONLY_TEXT);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. A real name blocks, and the screen names the hit                        */
/* -------------------------------------------------------------------------- */

describe("the real-name scan", () => {
  it("blocks the export and names the hit on screen", async () => {
    const { caseId } = seedShareable({
      firstText:
        `This was written from two messages of yours, 知夏. In one you wrote ` +
        `“${LONG_QUOTE}”.`,
    });

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const scan = read.preview.gate.checks.find(
      (check) => check.id === "real_name_scan",
    );
    expect(scan?.verdict).toBe("blocked");
    expect(read.preview.gate.blocked).toBe(true);

    const text = visibleText(await renderPage(caseId));
    // Which name, which pseudonym it should have been, and where.
    expect(text).toContain("would refuse this export");
    expect(text).toContain('"知夏" appears at character');
    expect(text).toContain('It should be "甲"');
    // The dictionary it was scanned against is on the page too, so a clean pass
    // elsewhere can be read as meaning something.
    expect(text).toContain("知夏 → 甲");
  });

  it("refuses the export itself, and writes no audit row", async () => {
    const { caseId, judgmentId } = seedShareable({
      firstText: `知夏, this was written from two messages of yours. You wrote “${LONG_QUOTE}”.`,
    });

    const result = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("real_name_present");
    expect(result.message).toContain("知夏");
    // A refused document never left, so there is nothing to audit.
    expect(listCaseExports(db, caseId)).toHaveLength(0);
  });

  it("says so plainly when the dictionary is empty", async () => {
    const { caseId } = seedShareable();
    db.update(caseParticipants)
      .set({ displayName: null })
      .where(eq(caseParticipants.caseId, caseId))
      .run();

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("this scan proves nothing");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The self-reflection copy can never reach this screen                    */
/* -------------------------------------------------------------------------- */

describe("the client's own copy", () => {
  it("is refused by the preview path, by the gate's own rule", () => {
    const { judgmentId } = seedShareable();
    const judgment = readJudgment(db, judgmentId);
    expect(judgment).not.toBeNull();
    if (judgment === null) return;

    let thrown: unknown;
    try {
      previewShareableDocument(db, judgment, "self_reflection");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExportBlockedError);
    expect((thrown as ExportBlockedError).code).toBe("not_shareable");
  });

  it("does not appear anywhere in the rendered screen", async () => {
    const { caseId } = seedShareable();
    const html = await renderPage(caseId);
    const text = visibleText(html);

    // The criticism written for the client alone, in full and in fragments.
    expect(html).not.toContain(SELF_ONLY_TEXT);
    expect(text).not.toContain("stopped answering for four days");
    // The client-addressed sentence from his own copy is absent too.
    expect(text).not.toContain("You, 乙, submitted this case");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Consent                                                                 */
/* -------------------------------------------------------------------------- */

describe("revoked consent", () => {
  it("blocks token minting, in the words of the person who withdrew", async () => {
    const { caseId, judgmentId, counterpartyId } = seedShareable();

    // One copy leaves first, so the refusal has to account for it.
    const escaped = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(escaped.ok).toBe(true);

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: counterpartyId,
      note: "别把写我的东西发给任何人",
    });

    const result = await mintShareLinkAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("consent_revoked");
    expect(result.message).toContain("甲");
    // Her own words, verbatim, never normalized or translated.
    expect(result.message).toContain("别把写我的东西发给任何人");
    // And the honest half: this stops the next copy, not the last one.
    expect(result.message).toContain("cannot be recalled");
    expect(result.message).toContain("Revoking stops the next copy");

    // No token hash was written; the refusal happened before any state changed.
    const row = db
      .select({ hash: judgmentRenditions.shareTokenHash })
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.judgmentId, judgmentId))
      .all();
    expect(row.every((entry) => entry.hash === null)).toBe(true);
  });

  it("blocks the export too, and writes no audit row", async () => {
    const { caseId, judgmentId, counterpartyId } = seedShareable();
    revokeNamedRendition(db, { caseId, actorParticipantId: counterpartyId });

    const result = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("consent_revoked");
    expect(listCaseExports(db, caseId)).toHaveLength(0);
  });

  it("is the current state on screen, with its history and what cannot be recalled", async () => {
    const { caseId, judgmentId, counterpartyId } = seedShareable();

    // One copy leaves first, so the screen has something unrecallable to show.
    const exported = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(exported.ok).toBe(true);

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: counterpartyId,
      note: "我不同意把这份东西发出去",
    });

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Withdrawn — both doors are shut");
    expect(text).toContain("我不同意把这份东西发出去");
    expect(text).toContain("already left, and cannot be recalled");
    expect(text).toContain("not recallable");
    // The log is a history, not a flag: the event is listed as an event.
    expect(text).toContain("revoked");
    expect(text).toContain("named_rendition");
  });

  it("says nobody has been asked, rather than implying a refusal", async () => {
    const { caseId } = seedShareable();
    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("never asked, which is not the same as having said no");
    expect(text).toContain("The consent log is empty");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Every export writes exactly one audit row                               */
/* -------------------------------------------------------------------------- */

describe("the export audit", () => {
  it("writes exactly one row per copy taken", async () => {
    const { caseId, judgmentId } = seedShareable();

    const first = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(listCaseExports(db, caseId)).toHaveLength(1);

    const second = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "clipboard",
    });
    expect(second.ok).toBe(true);
    expect(listCaseExports(db, caseId)).toHaveLength(2);

    // The row identifies the exact bytes and nothing more.
    const rows = listCaseExports(db, caseId);
    expect(rows[0].contentSha256).toBe(first.data.contentSha256);
    expect(rows[0].recipientPseudonym).toBe("甲");
    expect(rows[0].channel).toBe("file");
    expect(rows[1].channel).toBe("clipboard");
    // The watermark carries the audit row's own id and nobody's name.
    expect(first.data.watermark).toContain(first.data.exportId.slice(0, 8));
    expect(first.data.watermark).not.toContain("知夏");
    expect(first.data.text.startsWith(first.data.watermark)).toBe(true);
  });

  it("shows the log on the screen", async () => {
    const { caseId, judgmentId } = seedShareable();
    const result = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("1 copy has left the machine");
    expect(text).toContain(result.data.contentSha256);
    expect(text).toContain("to 甲 via file");
  });

  it("offers no route that transmits anything", async () => {
    const { caseId } = seedShareable();
    const html = await renderPage(caseId);

    // No mail-to, no social intent, no upload target anywhere on the page.
    expect(html).not.toMatch(/mailto:/i);
    expect(html).not.toMatch(/wa\.me|api\.whatsapp|twitter\.com\/intent|t\.me\//i);
    expect(visibleText(html)).toContain("there is no fourth");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The L1 audience defect                                                  */
/* -------------------------------------------------------------------------- */

describe("the known L1 audience defect", () => {
  it("is stated plainly, above the document, when the judgment is L1", async () => {
    const { caseId } = seedShareable({
      level: "L1",
      limitsText:
        "This judgment allocates responsibility as shared between the parties, " +
        "and you have not been asked for your account of any of it.",
    });

    const html = await renderPage(caseId);
    const text = visibleText(html);

    expect(text).toContain("At L1 the audience rule inverts, and this judgment is L1");
    expect(text).toContain("She receives the finding against herself");
    // The concrete evidence, from this judgment: the withheld section's heading,
    // the allocations the fact layer holds, and the assertion she does receive.
    expect(text).toContain("Responsibility: 乙's share");
    expect(text).toContain("乙: shared");
    expect(text).toContain("甲: shared");
    expect(text).toContain("allocates responsibility as shared between the parties");
    // And it is above the document, not a footnote under it.
    expect(html.indexOf("audience rule inverts")).toBeLessThan(
      html.indexOf("What 甲 receives, in full"),
    );
    // The withheld section is named, never printed.
    expect(html).not.toContain(SELF_ONLY_TEXT);
  });

  it("says the export gate will not catch it", async () => {
    const { caseId } = seedShareable({ level: "L1" });
    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // Every gate check passes, and the document is still unfair.
    expect(read.preview.gate.blocked).toBe(false);
    expect(read.preview.l1Defect).not.toBeNull();

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("The export gate will not catch this");
  });

  it("does not fire at L2, where the same rule is doing its job", async () => {
    const { caseId } = seedShareable({ level: "L2" });
    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.preview.l1Defect).toBeNull();

    const text = visibleText(await renderPage(caseId));
    expect(text).not.toContain("audience rule inverts");
  });
});

/* -------------------------------------------------------------------------- */
/* The quote rule, reported rather than asserted                              */
/* -------------------------------------------------------------------------- */

describe("the quote rule on screen", () => {
  it("shows the exempted quote and says why it was exempted", async () => {
    const { caseId } = seedShareable();

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const exempt = read.preview.gate.quotes.find(
      (quote) => quote.outcome === "exempt_recipient_own_words",
    );
    expect(exempt?.quote).toContain(LONG_QUOTE);
    expect(exempt?.length).toBeGreaterThan(15);

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Exempt");
    // The quote itself is on screen — a ruling nobody can see is not auditable.
    expect(text).toContain(LONG_QUOTE);
    expect(text).toContain("her own words being quoted back to her");
    expect(text).toContain("The run-up the attribution test read");
  });

  it("blocks somebody else's long quote and shows that too", async () => {
    const { caseId } = seedShareable({
      firstText:
        `You were waiting on an answer. 乙 wrote “${LONG_QUOTE}” about the trip, ` +
        `and nothing followed it.`,
    });

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const blockedQuote = read.preview.gate.quotes.find(
      (quote) => quote.outcome === "blocked",
    );
    expect(blockedQuote?.quote).toContain(LONG_QUOTE);

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Refused");
    expect(text).toContain("a trimmed quote is an edited record");
  });
});

/* -------------------------------------------------------------------------- */
/* The pre-send step: the pause and the question                              */
/* -------------------------------------------------------------------------- */

describe("the cool-down buffer", () => {
  it("blocks both doors while it is still running", async () => {
    const { caseId, judgmentId } = seedShareable({ fresh: true });

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.preview.coolingOff.state).toBe("waiting");
    expect(read.preview.coolingOff.elapsed).toBe(false);

    const minted = await mintShareLinkAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
    });
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.code).toBe("cooling_off");

    // The file is the door that actually leaves a copy, so it is closed too.
    const exported = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.code).toBe("cooling_off");
    expect(listCaseExports(db, caseId)).toHaveLength(0);

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("left to run");
    expect(text).toContain("not from when you opened this page");
  });

  it("runs from when the document was written, not from a click", () => {
    const { caseId, judgmentId } = seedShareable({ fresh: true });
    const written = new Date(Date.now() - COOLING_OFF_MIN_MS - 60_000);
    db.update(judgmentRenditions)
      .set({ generatedAt: written })
      .where(eq(judgmentRenditions.judgmentId, judgmentId))
      .run();

    const read = readSharePreview(db, caseId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.preview.coolingOff.anchor?.getTime()).toBe(written.getTime());
    expect(read.preview.coolingOff.elapsed).toBe(true);
  });
});

describe("the doc 01 question", () => {
  it("refuses an unanswered one before anything leaves", async () => {
    const { caseId, judgmentId } = seedShareable();

    const result = await exportShareableCopyAction({
      caseId,
      judgmentId,
      intent: "   ",
      acknowledgedWarning: false,
      channel: "file",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("intent_unanswered");
    expect(listCaseExports(db, caseId)).toHaveLength(0);
  });

  it("warns on the answer doc 01 names, and sends nothing on that submission", async () => {
    const { caseId, judgmentId } = seedShareable();

    const first = await mintShareLinkAction({
      caseId,
      judgmentId,
      intent: "I want her to realize she was wrong about all of it.",
      acknowledgedWarning: false,
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe("intent_flagged");
    expect(first.message).toContain("defensiveness");

    // Sending anyway is a second, deliberate act with the warning on screen.
    const second = await mintShareLinkAction({
      caseId,
      judgmentId,
      intent: "I want her to realize she was wrong about all of it.",
      acknowledgedWarning: true,
    });
    expect(second.ok).toBe(true);
  });

  it("reads both scripts, and stores nothing either way", () => {
    expect(readSendIntent("我想让她认错").flagged).toBe(true);
    expect(readSendIntent("我想让她内疚一下").flagged).toBe(true);
    expect(readSendIntent("I want an apology from her.").flagged).toBe(true);
    expect(readSendIntent("I want her to admit she was wrong.").flagged).toBe(true);
    expect(readSendIntent(PLAIN_INTENT).flagged).toBe(false);
    expect(readSendIntent("ok").answered).toBe(false);
    // Verbatim: the sender's own words are not normalized on the way through.
    expect(readSendIntent("  我想让她认错  ").answer).toBe("我想让她认错");
  });

  it("does not warn on the sender's own remorse, which is the good answer", () => {
    // These are made of the same words and mean the opposite. Warning on them
    // would teach people that the question is a hurdle rather than a question.
    expect(readSendIntent("I want to apologize to her for not answering.").flagged).toBe(
      false,
    );
    expect(readSendIntent("I regret how I handled the whole week.").flagged).toBe(false);
    expect(readSendIntent("我想为那几天没回她道歉").flagged).toBe(false);
    expect(readSendIntent("I feel guilty about going quiet on her.").flagged).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* What the document tells her                                                */
/* -------------------------------------------------------------------------- */

describe("the pre-send disclosures", () => {
  it("quotes the document rather than asserting things about it", async () => {
    const { caseId } = seedShareable();
    const text = visibleText(await renderPage(caseId));

    expect(text).toContain("It tells her what made this and what it rests on.");
    expect(text).toContain("It invites her to answer, and tells her where.");
    // Each one is checked against the bytes, and the sentence is printed. The
    // first disclosure quotes the provenance-and-redistribution notice (doc 05
    // §C amendment 5), which at L2 is also where doc 01's one-sidedness label
    // now lives — one notice, not two stacked.
    expect(text).toContain("In the document");
    expect(text).toContain("An AI-mediated document, not a human judgment.");
    expect(text).toContain("The other person has not been heard");
    expect(text).toContain("Nothing has been decided that your side cannot change");
  });

  it("counts the clarification questions the sender left unanswered", async () => {
    const { caseId } = seedShareable();

    // Three questions put to the client, none of them answered — the state the
    // real case is in, and the one this disclosure exists for.
    db.insert(clarificationRounds)
      .values({
        caseId,
        roundNumber: 1,
        questions: [
          { id: "q1", question: "What did you say to her on the Wednesday?" },
          { id: "q2", question: "Had you already booked anything by then?" },
          { id: "q3", question: "When did you next reply to her?" },
        ],
        answers: [],
      })
      .run();

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("3 clarification questions put to you were never answered");
    expect(text).toContain("From the record");
    // The gap is named as the sender's, and one of the questions is quoted.
    expect(text).toContain("The gaps are yours, not hers");
    expect(text).toContain("What did you say to her on the Wednesday?");
  });
});

/* -------------------------------------------------------------------------- */
/* A minted link                                                              */
/* -------------------------------------------------------------------------- */

describe("minting a link", () => {
  it("returns the token once, stores only its hash, and says the route is unbuilt", async () => {
    const { caseId, judgmentId } = seedShareable();

    const result = await mintShareLinkAction({
      caseId,
      judgmentId,
      intent: PLAIN_INTENT,
      acknowledgedWarning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.link).toBe(`/respond/${result.data.token}`);
    expect(result.data.routeUnbuilt).toBe(true);

    const row = db
      .select({
        hash: judgmentRenditions.shareTokenHash,
        expires: judgmentRenditions.shareExpiresAt,
      })
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.judgmentId, judgmentId))
      .all()
      .find((entry) => entry.hash !== null);

    expect(row?.hash).toBeDefined();
    expect(row?.hash).not.toBe(result.data.token);
    expect(row?.expires).not.toBeNull();
  });
});
