/**
 * The post-judgment screen (SPEC M4 ②③, the surfacing half).
 *
 * Rendered against the real page component, not a copy of it, because the two
 * things this screen owes a reader are things a unit test one layer down cannot
 * see:
 *
 *   1. **An invitation does not look like a commitment.** At L2 the other party
 *      was never heard. Her items appear under their own heading, labelled, with
 *      the reason printed — and an item the server demoted from a commitment
 *      says so on its face. A screen that renders both lists the same way undoes
 *      the rule the storage layer enforces.
 *   2. **Every item shows what it rests on.** Not the claim id alone, which
 *      nobody can look up, but the claim's own sentence — the difference between
 *      this contract and relationship advice.
 *
 * Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page reads the process-wide database; hand it the in-memory one.
// `importActual` is how the real `createDb` stays reachable from a mocked module.
const holder: { db: Db } = { db: null as unknown as Db };

vi.mock("../src/server/db", () => ({
  getDb: () => holder.db,
}));

import { caseParticipants, cases } from "../src/server/db/schema";
import type { Db } from "../src/server/db";
import {
  createDraft,
  finalize,
  normalizeImprovementContract,
  normalizeRepairScript,
  persistImprovementContract,
  persistRepairScript,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";

let db: Db;
let sqlite: Database.Database;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../src/server/db")>(
    "../src/server/db",
  );
  ({ db, sqlite } = actual.createDb(":memory:"));
  actual.runMigrations(db);
  holder.db = db;
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 put a date on the answer she wanted: “我周三之前必须知道”.",
        evidence_refs: ["u-1"],
        confidence: 0.9,
        tier: "high_confidence",
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
      unresolved: [],
      responsibility: [],
    },
  };
}

function surfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: "Two confirmed lines, both 甲's.",
        claim_ids: [],
      },
    ],
  };
}

function seedCase(): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "post_judgment",
      title: "fixture",
      outputLevel: "L2",
      outputLevelLockedAt: new Date(),
    })
    .returning()
    .all();

  db.insert(caseParticipants)
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
        participationState: "unreachable",
      },
    ])
    .run();

  return row.id;
}

function seedJudgment(caseId: string): string {
  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: surfaceLayer(),
  });
  finalize(db, draft.id);
  return draft.id;
}

async function renderPage(caseId: string): Promise<string> {
  const pageModule = await import("../src/app/case/[id]/post_judgment/page");
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

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

describe("the post-judgment screen", () => {
  it("says what is missing rather than rendering an empty page", async () => {
    const caseId = seedCase();
    seedJudgment(caseId);

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Not generated yet");
    expect(text).toContain("npm run judgment:plan");
  });

  it("shows a commitment with the claim it rests on, in full", async () => {
    const caseId = seedCase();
    const judgmentId = seedJudgment(caseId);

    persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", {
        items: [
          {
            item_id: "k1",
            bound_party: "client",
            trigger: "when 甲 puts a date on something she is asking for",
            action: "I answer that evening with a yes, a no, or a date",
            observable: "she has a written reply from me before midnight",
            within_days: 3,
            claim_ids: ["c1"],
          },
        ],
      }),
      { model: "claude-fable-5", effort: "high" },
    );

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Commitment");
    expect(text).toContain("I answer that evening");
    expect(text).toContain("within 3 days");
    // Provenance: the id AND the claim's own sentence, verbatim and Chinese.
    expect(text).toContain("c1");
    expect(text).toContain("我周三之前必须知道");
    expect(text).toContain("high_confidence");
    expect(text).toContain("claude-fable-5");
  });

  it("labels her item an invitation and says why, on the item itself", async () => {
    const caseId = seedCase();
    const judgmentId = seedJudgment(caseId);

    persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", {
        items: [
          {
            item_id: "k1",
            bound_party: "client",
            trigger: "when 甲 asks something I do not want to answer",
            action: "I answer it the same evening, even badly",
            observable: "there is a reply from me that night",
            within_days: 2,
            claim_ids: ["c1"],
          },
          {
            item_id: "k2",
            bound_party: "counterparty",
            trigger: "when she has asked and heard nothing by the evening",
            action: "she says so once, in one message",
            observable: "there is a message from her saying she is waiting",
            within_days: 7,
            claim_ids: ["c1"],
          },
        ],
      }),
      { model: "claude-fable-5", effort: "high" },
    );

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("Invitations — not commitments");
    expect(text).toContain("never gave her account and has agreed to nothing");
    expect(text).toContain("recorded as an invitation");
    expect(text).toContain("she says so once");
    // And the label is on the item, not only on the heading above it.
    expect(text).toContain("Invitation binds the other party");
  });

  it("renders the script as three things and a line to say", async () => {
    const caseId = seedCase();
    const judgmentId = seedJudgment(caseId);

    persistRepairScript(
      db,
      judgmentId,
      normalizeRepairScript(judgmentId, {
        opening_line:
          "I want to talk about the “我周三之前必须知道” message. I did not answer it.",
        when_it_goes_wrong: {
          pause_signal: "Either of us says “先停一下”.",
          flooding_self_check: "My voice speeds up and my jaw tightens.",
          return_time: "After dinner tonight.",
        },
        claim_ids: ["c1"],
      }),
      { model: "claude-fable-5", effort: "medium" },
    );

    const text = visibleText(await renderPage(caseId));
    expect(text).toContain("What you could open with");
    expect(text).toContain("I did not answer it");
    expect(text).toContain("Pause signal");
    expect(text).toContain("先停一下");
    expect(text).toContain("How you will know you are flooded");
    expect(text).toContain("When you come back");
    expect(text).toContain("After dinner tonight");
  });
});
