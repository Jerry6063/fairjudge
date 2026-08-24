/**
 * The judgment reading view — `/case/[id]/judgment`.
 *
 * The product's core output had been generated, validated, frozen, swap-tested
 * and made exportable, and had never once been on a screen. Every
 * milestone's acceptance said "runs / tests green / verified on the real case";
 * none of them said "a person can read it". This file is written against the
 * other half of that sentence, so it asserts things only a rendered page can be
 * wrong about:
 *
 *   1. **A stored frozen judgment renders.** Not a fixture built in this file —
 *      a judgment this product actually produced, read out of an on-disk
 *      database as it stands. Skipped when that database is absent, the same
 *      rule the golden harness follows: no case record is in the repository.
 *   2. **A citation resolves to the line somebody actually said, byte for
 *      byte.** The whole claim of the fact layer is that a reader can go from a
 *      sentence in the narrative to the evidence under it. An excerpt, a
 *      normalization, or a smart-quote substitution would break that quietly, so
 *      the assertion is on the exact stored string.
 *   3. **Rendering never mutates the judgment.** HARD RULE #6 says a final
 *      judgment is frozen, and a reading screen is the most embarrassing
 *      possible place to break it. The raw row is captured column by column
 *      before and after a render and compared byte for byte — over the fixture
 *      AND over the stored judgment.
 *
 * Nothing here writes to an on-disk database. The stored-record case opens one,
 * reads it, and asserts it did not change; the mutating fixtures all run against
 * an in-memory database (CLAUDE.md, Verification rule).
 *
 * Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page reads the process-wide database; hand it whichever one the case under
// test wants. `importActual` is how the real `createDb` stays reachable from a
// mocked module.
const holder: { db: Db } = { db: null as unknown as Db };

vi.mock("../src/server/db", () => ({
  getDb: () => holder.db,
}));

import {
  caseParticipants,
  cases,
  judgmentPolishRuns,
  utterances,
  type PolishOutcome,
} from "../src/server/db/schema";
import type { Db } from "../src/server/db";
import { loadEnvLocal } from "../src/server/env";
import {
  createDraft,
  finalize,
  readJudgment,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";
import {
  buildJudgmentReadView,
  scrubReason,
} from "../src/server/judgment/read-view";

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
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** Import and render the real page module, exactly as the route does. */
async function renderPage(caseId: string): Promise<string> {
  const pageModule = await import("../src/app/case/[id]/judgment/page");
  const element = await pageModule.default({
    params: Promise.resolve({ id: caseId }),
  });
  return renderToStaticMarkup(element);
}

/**
 * Undo React's text escaping without touching anything else.
 *
 * Deliberately not the whitespace-collapsing `visibleText` helper other suites
 * use: this file asserts byte-identity of quoted evidence, and a helper that
 * rewrote runs of spaces would make that assertion untrue in a way that still
 * passed.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Strip tags too, for assertions about what a reader sees rather than markup. */
function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
}

/**
 * The judgment row exactly as SQLite holds it.
 *
 * Every column, JSON columns included, as the raw stored strings — this is the
 * "byte-identical" the freeze rule means. Going through the ORM would compare
 * parsed objects and would not notice a re-serialization that reordered keys.
 */
function rawJudgmentRow(
  connection: Database.Database,
  judgmentId: string,
): string {
  const row = connection
    .prepare("SELECT * FROM judgments WHERE id = ?")
    .get(judgmentId);
  return JSON.stringify(row);
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement:
          '甲 said she had already asked more than once: "我提过很多次了".',
        evidence_refs: ["u-1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "u1",
        statement:
          "Whether 乙 disputes any of this cannot be settled — he has no confirmed line in the record.",
        evidence_refs: [],
        confidence: 0.1,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 1, by_client: 0, by_counterparty: 1 },
        parties_without_citable_utterance: ["乙"],
        statement:
          "This analysis could read only 甲's words. 乙 has no citable line in the record.",
      },
      unresolved: [
        {
          question: "Does 乙 contest any part of 甲's account?",
          reason: "clarification_unanswered",
          claim_ids: ["u1"],
        },
      ],
      responsibility: [],
    },
  };
}

function surfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "basis",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: "Only one party's words were available to this hearing.",
        claim_ids: [],
      },
      {
        section_id: "driving",
        kind: "finding",
        audience: "self_only",
        heading: "The driving conflict",
        text: "甲's account is that she asked repeatedly and nothing followed.",
        claim_ids: ["c1"],
      },
      {
        section_id: "open",
        kind: "finding",
        audience: "both",
        heading: "What this hearing could not settle",
        text: "Your own account of these events was never available to it.",
        claim_ids: ["u1"],
      },
    ],
  };
}

/** A case with one confirmed utterance and a frozen L2 judgment on it. */
function seedFrozenCase(): { caseId: string; judgmentId: string } {
  const [row] = db
    .insert(cases)
    .values({ stage: "judgment", title: "The driving conflict", outputLevel: "L2" })
    .returning()
    .all();

  const [counterparty] = db
    .insert(caseParticipants)
    .values({
      caseId: row.id,
      role: "respondent",
      pseudonym: "甲",
      isSubmitter: false,
    })
    .returning()
    .all();
  db.insert(caseParticipants)
    .values({
      caseId: row.id,
      role: "initiator",
      pseudonym: "乙",
      isSubmitter: true,
    })
    .run();

  db.insert(utterances)
    .values({
      id: "u-1",
      caseId: row.id,
      speakerParticipantId: counterparty.id,
      speakerLabel: "甲",
      humanFinal: "他一直不肯订位，我提过很多次了。",
      confirmStatus: "confirmed",
    })
    .run();

  const draft = createDraft(db, row.id, {
    model: "claude-fable-5",
    effort: "xhigh",
    promptVersion: "judgment_skeleton.v1",
    factLayer: factLayer(),
    surfaceLayer: surfaceLayer(),
  });
  finalize(db, draft.id);

  return { caseId: row.id, judgmentId: draft.id };
}

/** Fable's wording of the driving section, before the decoration layer saw it. */
const FABLE_ORIGINAL_DRIVING_TEXT =
  "甲 asked repeatedly. Nothing followed.";

/**
 * A polish run that was accepted — so the frozen narrative IS the polished one
 * and Fable's original survives only in the run.
 *
 * Written straight into the table, which is now the only way: the chain that
 * used to produce these rows was deleted with the polish layer, and what is
 * under test here is the reading of an archived (original, polished, diff)
 * triple — the thing that outlived it.
 */
function seedAppliedPolish(judgmentId: string): void {
  const frozen = surfaceLayer();
  const original: SurfaceLayer = {
    sections: frozen.sections.map((section) =>
      section.section_id === "driving"
        ? { ...section, text: FABLE_ORIGINAL_DRIVING_TEXT }
        : section,
    ),
  };

  db.insert(judgmentPolishRuns)
    .values({
      judgmentId,
      outcome: "applied",
      model: "gpt-5-mini",
      promptVersion: "polish.v1",
      original: original as unknown as Record<string, unknown>,
      polished: frozen as unknown as Record<string, unknown>,
      diff: {
        sections: frozen.sections.map((section) => {
          const before = original.sections.find(
            (s) => s.section_id === section.section_id,
          )!;
          return {
            section_id: section.section_id,
            changed: before.text !== section.text,
            heading: { original: before.heading, polished: section.heading },
            text: { original: before.text, polished: section.text },
          };
        }),
      } as unknown as Record<string, unknown>,
      failures: { reason: null, failures: [], entailment: null } as unknown as Record<
        string,
        unknown
      >,
      latencyMs: 1840,
    })
    .run();
}

/**
 * An archived run that did NOT rewrite the judgment — the shape of every polish
 * outcome except `applied`.
 *
 * A diff is still stored, because the chain recorded one whenever a draft came
 * back at all; the frozen text is Fable's, so the control has nothing to switch
 * to and renders inert.
 */
function seedArchivedPolish(judgmentId: string, outcome: PolishOutcome): void {
  const frozen = surfaceLayer();

  db.insert(judgmentPolishRuns)
    .values({
      judgmentId,
      outcome,
      model: "gpt-4.1-mini",
      promptVersion: "polish.v1",
      original: frozen as unknown as Record<string, unknown>,
      polished: null,
      diff: { sections: [] } as unknown as Record<string, unknown>,
      failures: {
        reason: "the polished draft was discarded and the original ships",
        failures: [],
        entailment: null,
      } as unknown as Record<string, unknown>,
      latencyMs: 2100,
    })
    .run();
}

/* -------------------------------------------------------------------------- */
/* The page renders a judgment                                                */
/* -------------------------------------------------------------------------- */

describe("the judgment reading view", () => {
  it("leads with what the judgment is before it shows any finding", async () => {
    const { caseId } = seedFrozenCase();
    const html = await renderPage(caseId);
    const text = visibleText(html);

    // The level, in the words of the table the prompt is built from — not a
    // paraphrase invented by the screen.
    expect(text).toContain(
      "One-sided analysis — only one party's material is in the record",
    );
    // The counted basis, and the fact that the reader has not spoken in it.
    expect(text).toContain("Citable lines in total");
    expect(text).toContain("You have no citable line in this record");
    // The judgment's own record-basis statement, verbatim.
    expect(text).toContain(
      "This analysis could read only 甲's words. 乙 has no citable line in the record.",
    );
    // What this level forbids — the one that matters most to a reader here.
    expect(text).toContain("Allocating responsibility, in any form");

    // And it comes before the narrative, not after it.
    expect(html.indexOf("What this judgment could read")).toBeLessThan(
      html.indexOf("The driving conflict"),
    );
  });

  it("renders the self-reflection copy including the sections written against the reader", async () => {
    const { caseId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    // Every section, in order, self_only included — the client's copy filters
    // nothing, and the criticism is the reason the product bothers.
    expect(text).toContain("What this judgment could read");
    expect(text).toContain("The driving conflict");
    expect(text).toContain("What this hearing could not settle");
    expect(text).toContain(
      "甲's account is that she asked repeatedly and nothing followed.",
    );
    expect(text).toContain("1 section written for you alone");
  });

  it("shows every claim with its id, tier, confidence and evidence grade", async () => {
    const { caseId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    expect(text).toContain("c1");
    expect(text).toContain("Shown by the record");
    expect(text).toContain("confidence 0.90");
    // No human has signed off a grade on the seeded evidence, and the screen
    // says that rather than implying a grade it does not have.
    expect(text).toContain("grade not signed off");
  });

  it("renders an unknown-tier claim as the deliberate statement it is, not as missing data", async () => {
    const { caseId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    expect(text).toContain("The record cannot say");
    expect(text).toContain("Cites nothing, and that is the finding");
    expect(text).toContain("not evidence that went missing");
  });

  it("states an empty responsibility allocation as the honest encoding it is", async () => {
    const { caseId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    expect(text).toContain("This judgment allocates responsibility to nobody");
    expect(text).toContain("no field one could be written into");
  });

  it("prints the audience marking as a stored value and does not act on it", async () => {
    const { caseId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    // The marking is shown …
    expect(text).toContain('marked "self_only"');
    expect(text).toContain('marked "both"');
    // … and explicitly not asserted to be correct, because it is a stored field
    // with a known open defect in how the rule behaves at L1.
    expect(text).toContain(
      "this screen does not verify that a section is marked correctly",
    );
    // The self_only section is on screen regardless of the marking.
    expect(text).toContain(
      "甲's account is that she asked repeatedly and nothing followed.",
    );
  });

  it("puts provenance on the page, fallback disclosure included", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    const text = visibleText(await renderPage(caseId));

    expect(text).toContain("claude-fable-5");
    expect(text).toContain("xhigh");
    expect(text).toContain("judgment_skeleton.v1");
    expect(text).toContain("Served by the fallback model");
    expect(text).toContain(judgmentId);
    expect(text).toContain("Version");
  });

  it("says a judgment cannot be edited and points a re-hearing at a new version", async () => {
    const { caseId } = seedFrozenCase();
    const html = await renderPage(caseId);
    const text = visibleText(html);

    expect(text).toContain("This judgment cannot be edited");
    expect(text).toContain("re-hearing the case writes version 2");
    // Linked, not duplicated: the diff disclosure already has its own screen.
    expect(html).toContain(`/case/${caseId}/judgment/versions`);

    // And there is no write path on this page at all.
    expect(html).not.toContain("<form");
    expect(html.toLowerCase()).not.toContain("<input");
  });

  it("shows no wording control at all when no polish ever ran", async () => {
    const { caseId } = seedFrozenCase();
    const html = await renderPage(caseId);
    const text = visibleText(html);

    // The polish layer was removed (doc 02 §1.1a), so this is now every
    // judgment the product produces. There is no second wording and no feature
    // that could have made one — a disabled control labelled "the unpolished
    // original" would advertise a capability that does not exist, and a
    // sentence explaining why the polish did not happen would describe a stage
    // that is no longer in the pipeline. Both are gone.
    expect(text).not.toContain("The unpolished original");
    expect(text).not.toContain("polish");
    expect(text).not.toContain("Polish");
    // The button was the page's only disableable control.
    expect(html).not.toContain('disabled=""');

    // The judgment itself is untouched by any of that: the document renders.
    expect(text).toContain("The driving conflict");
  });

  it("keeps the control, inert, on an archived run that changed nothing", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    // A run that happened and declined to apply. The frozen text already IS
    // Fable's original, so there is nothing to switch to — but the run is an
    // audit record of a call this product made to a second vendor, and hiding
    // it would say the judgment was never sent anywhere.
    seedArchivedPolish(judgmentId, "rejected");

    const html = await renderPage(caseId);
    const text = visibleText(html);

    expect(html).toContain("The unpolished original");
    expect(html).toContain('disabled=""');
    expect(text).toContain(
      "The polished wording failed validation and was discarded.",
    );
    // Said in the past tense, because it is: the layer is gone.
    expect(text).toContain("The polish layer has since been removed");
  });

  it("makes the toggle live, and carries the pre-polish wording, once a polish was applied", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedAppliedPolish(judgmentId);

    // The wiring: the read model carries Fable's wording beside the frozen one,
    // so the toggle has a second document to switch to.
    const view = buildJudgmentReadView(db, caseId);
    expect(view?.polish.outcome).toBe("applied");
    expect(view?.polish.polishedTextIsWhatIsShown).toBe(true);
    const driving = view?.polish.sections.find((s) => s.sectionId === "driving");
    expect(driving?.originalText).toBe(FABLE_ORIGINAL_DRIVING_TEXT);
    expect(driving?.changed).toBe(true);

    // The control: enabled, and saying which of the two wordings is on screen.
    // That button is the only disableable control on the page, so the absence
    // of a disabled attribute anywhere is the assertion that it is live.
    const html = await renderPage(caseId);
    expect(html).toContain("The unpolished original");
    expect(html).not.toContain('disabled=""');
    expect(visibleText(html)).toContain(
      "The polished wording was accepted, so the text above is the polished version.",
    );
  });

  it("renders an honest empty state rather than a draft", async () => {
    const [row] = db
      .insert(cases)
      .values({ stage: "intake", title: "Nothing decided yet" })
      .returning()
      .all();
    db.insert(caseParticipants)
      .values({
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
      })
      .run();

    const text = visibleText(await renderPage(row.id));
    expect(text).toContain("No judgment has been issued on this case yet");
    expect(text).toContain("never before");
  });
});

/* -------------------------------------------------------------------------- */
/* A citation resolves to the line somebody actually said                     */
/* -------------------------------------------------------------------------- */

describe("citations resolve to the stored utterance", () => {
  it("renders the quoted Chinese byte-identically to what is in the database", async () => {
    const { caseId } = seedFrozenCase();
    const stored = sqlite
      .prepare("SELECT human_final FROM utterances WHERE id = ?")
      .get("u-1") as { human_final: string };

    const html = await renderPage(caseId);

    // Byte-identical: not an excerpt, not normalized, not translated. Entities
    // are decoded because React escapes markup characters, and nothing else is
    // touched.
    expect(decodeEntities(html)).toContain(stored.human_final);
  });

  it("reports a citation that has left the record instead of hiding it", async () => {
    const { caseId } = seedFrozenCase();
    // The judgment is frozen and still cites this line; the line stops being
    // citable under HARD RULE #1.
    sqlite
      .prepare("UPDATE utterances SET confirm_status = 'rejected' WHERE id = ?")
      .run("u-1");

    const html = await renderPage(caseId);
    expect(visibleText(html)).toContain(
      "no longer confirmed material in this case",
    );
    // The quoted line is gone as a citation. It survives inside the claim's own
    // sentence, and must: the judgment is frozen, so its prose is exactly what
    // it was — what changed is that the record can no longer produce the line
    // behind it, and that is the distinction the notice draws.
    expect(html).not.toContain('lang="zh"');
  });
});

/* -------------------------------------------------------------------------- */
/* The page never mutates the judgment                                        */
/* -------------------------------------------------------------------------- */

describe("HARD RULE #6 on the reading path", () => {
  it("leaves the judgment row byte-identical across a render", async () => {
    const { caseId, judgmentId } = seedFrozenCase();

    const before = rawJudgmentRow(sqlite, judgmentId);
    await renderPage(caseId);
    await renderPage(caseId);
    const after = rawJudgmentRow(sqlite, judgmentId);

    expect(after).toBe(before);
  });

  it("leaves the renditions untouched too", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    const raw = () =>
      JSON.stringify(
        sqlite
          .prepare(
            "SELECT * FROM judgment_renditions WHERE judgment_id = ? ORDER BY kind",
          )
          .all(judgmentId),
      );

    const before = raw();
    await renderPage(caseId);
    expect(raw()).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Credential hygiene on a stored failure reason                              */
/* -------------------------------------------------------------------------- */

describe("scrubReason", () => {
  it("keeps the substance of a vendor failure and drops the key fragment", () => {
    const scrubbed = scrubReason(
      "model listing returned HTTP 401: Incorrect API key provided: " +
        "sk-ant-a************************************************YQAA.",
    );
    expect(scrubbed).toContain("HTTP 401");
    expect(scrubbed).toContain("Incorrect API key provided");
    expect(scrubbed).toContain("[redacted key]");
    expect(scrubbed).not.toContain("YQAA");
  });

  it("passes an ordinary reason through unchanged", () => {
    expect(scrubReason("the polished draft was discarded (2 failures)")).toBe(
      "the polished draft was discarded (2 failures)",
    );
    expect(scrubReason(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The stored judgment (acceptance)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A published judgment read from an on-disk database, when one is there.
 *
 * The default is the fictional demo record (`data/fairjudge-demo.db`, built by
 * `scripts/seed-fixture.ts`). Any other database — including a live case
 * record — is opt-in and explicit via `FAIRJUDGE_DB_PATH`. There is no default
 * that reaches a real case: a case is data in a local database, not a fixture
 * in this repository.
 *
 * Nothing is generated and nothing is written: the frozen judgment is rendered
 * as it stands, and the raw row is checked byte for byte on the way out. With
 * no database at the target this block skips, the same rule the golden harness
 * follows.
 */
const TARGET_DB = resolve(
  process.cwd(),
  process.env.FAIRJUDGE_DB_PATH ?? "data/fairjudge-demo.db",
);

/**
 * The judgment that stands in whichever database was opened, or null.
 *
 * Asked of the record rather than named by id. A literal id is a fact about one
 * machine's database, and every assertion written under it quietly becomes a
 * fact about one case — which is how a real person's case record ends up being
 * a fixture. The newest frozen judgment is whatever that database has, and the
 * assertions below are properties, not values.
 */
function newestFrozenJudgmentId(
  connection: Database.Database,
): string | null {
  const row = connection
    .prepare(
      "SELECT id FROM judgments WHERE status = 'final' " +
        "ORDER BY finalized_at DESC, version DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

describe("the stored frozen judgment on screen", () => {
  it.skipIf(!existsSync(TARGET_DB))(
    "renders, resolves its citations verbatim, and does not touch the row",
    async (ctx) => {
      loadEnvLocal();
      if (process.env.FAIRJUDGE_DB_KEY === undefined) {
        ctx.skip();
        return;
      }

      const actual = await vi.importActual<typeof import("../src/server/db")>(
        "../src/server/db",
      );
      const stored = actual.createDb(TARGET_DB);
      try {
        const judgmentId = newestFrozenJudgmentId(stored.sqlite);
        if (judgmentId === null) {
          ctx.skip();
          return;
        }
        const judgment = readJudgment(stored.db, judgmentId);
        if (judgment === null || judgment.surfaceLayer === null) {
          ctx.skip();
          return;
        }

        const before = rawJudgmentRow(stored.sqlite, judgmentId);

        holder.db = stored.db;
        const html = await renderPage(judgment.caseId);
        const text = visibleText(html);

        // HARD RULE #6, over the stored row, before anything else is asserted.
        expect(rawJudgmentRow(stored.sqlite, judgmentId)).toBe(before);

        // ① What this is, before the verdict. Which level a stored judgment was
        //    issued at is data; what the page owes the reader is the copy that
        //    belongs to the level on the row.
        const basis = judgment.factLayer.findings.record_basis;
        if (judgment.outputLevel === "L2") {
          expect(text).toContain(
            "One-sided analysis — only one party's material is in the record",
          );
        }
        expect(basis.client_pseudonym.length).toBeGreaterThan(0);
        expect(text).toContain(`Spoken by you (${basis.client_pseudonym})`);
        if (basis.citable_utterances.by_client === 0) {
          expect(text).toContain("You have no citable line in this record");
        }
        expect(text).toContain(basis.statement.slice(0, 60));

        // ② The self-reflection rendition, every section of it.
        for (const section of judgment.surfaceLayer.sections) {
          expect(html).toContain(`id="section-${section.section_id}"`);
        }

        // ③ The fact layer, every claim of it, with the unknown tier rendered as
        //    a statement rather than as a hole.
        expect(judgment.factLayer.claims.length).toBeGreaterThan(0);
        for (const claim of judgment.factLayer.claims) {
          expect(html).toContain(`id="claim-${claim.claim_id}"`);
        }
        if (judgment.factLayer.claims.some((c) => c.tier === "unknown")) {
          expect(text).toContain("Cites nothing, and that is the finding");
        }

        // A stored citation resolves to the stored line, byte for byte.
        const decoded = decodeEntities(html);
        const cited = judgment.factLayer.claims.flatMap((c) => c.evidence_refs);
        expect(cited.length).toBeGreaterThan(0);
        for (const utteranceId of new Set(cited)) {
          const line = stored.sqlite
            .prepare(
              "SELECT COALESCE(human_final, ai_draft) AS text FROM utterances WHERE id = ?",
            )
            .get(utteranceId) as { text: string };
          expect(decoded).toContain(line.text);
        }

        // ④ Provenance, on the page rather than in a log — the values the row
        //    actually carries, not the ones one judgment happened to have.
        expect(text).toContain(judgment.model);
        if (judgment.effort !== null) expect(text).toContain(judgment.effort);
        if (judgment.promptVersion !== null) {
          expect(text).toContain(judgment.promptVersion);
        }
        expect(text).toContain("Served by the fallback model");

        // ⑤ Frozen.
        expect(text).toContain("This judgment cannot be edited");
        expect(html).not.toContain("<form");

        // And the read model agrees with the page about all of it.
        const view = buildJudgmentReadView(stored.db, judgment.caseId);
        expect(view?.judgmentId).toBe(judgmentId);
        expect(view?.claims).toHaveLength(judgment.factLayer.claims.length);
        expect(view?.omittedSectionIds).toEqual([]);
        expect(view?.level.level).toBe(judgment.outputLevel);
        expect(view?.provenance.fallbackUsed).toBe(judgment.fallbackUsed);

        // ⑥ The wording control, if and only if a polish run is archived against
        //    this judgment. The polish layer was removed (doc 02 §1.1a), so a
        //    judgment issued since then has no run and shows no control at all.
        if (view?.polish.ran === true) {
          expect(text).toContain("The unpolished original");
          if (view.polish.outcome === "skipped") {
            expect(text).toContain("No polish was performed");
          }
        } else {
          expect(text).not.toContain("The unpolished original");
        }

        expect(rawJudgmentRow(stored.sqlite, judgmentId)).toBe(before);
      } finally {
        holder.db = db;
        stored.sqlite.close();
      }
    },
  );
});
