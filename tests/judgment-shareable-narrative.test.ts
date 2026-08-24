/**
 * The counterparty-addressed shareable rendition (SPEC M4 ①).
 *
 * M3's real run exposed one defect, in the only artifact of this product that
 * ever reaches another person. The shareable copy was the client's narrative
 * with the `self_only` sections filtered out, and a filter cannot change who the
 * surviving sentences are talking to: the document 甲 would have been handed
 * opened with "You, 乙, submitted this case" and told her that three
 * clarification questions had been put to her.
 *
 * Four things are asserted here, and the fourth is the one that matters:
 *
 *   1. the shareable copy is GENERATED to the counterparty from the frozen fact
 *      layer, not filtered out of the client's copy;
 *   2. a narrative that introduces a `claim_id` the frozen skeleton does not
 *      define is rejected, and nothing is stored;
 *   3. regenerating a rendition leaves the frozen judgment row byte-identical —
 *      renditions are derived artifacts with their own lifecycle (HARD RULE #6);
 *   4. **over a stored judgment**, not a fixture built in this file: no
 *      second-person reference to the client survives in the shareable
 *      rendition a database actually holds, and that rendition is a second
 *      document rather than the M3 projection of the client's copy. The
 *      fixtures in this repo were written by the hand that wrote the code and
 *      missed this class of defect once already, so the assertion that the
 *      defect is gone is also made against a document nobody here authored.
 *
 * Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  judgmentRenditions,
} from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import { MODEL_FABLE } from "../src/server/llm/config";
import { shareableNarrativeStage } from "../src/server/llm/stages";
import {
  RenditionError,
  checkCounterpartyAddress,
  createDraft,
  finalize,
  generateShareableRendition,
  persistShareableNarrative,
  readJudgment,
  readRenditionView,
  readShareableNarrative,
  renderRendition,
  renderShareableNarrativePrompt,
  surfaceLayerSchema,
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
/* Fixture — a one-sided record: 甲 spoke, 乙 brought the case                */
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
      responsibility: [],
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
        text:
          "You, 乙, submitted this case. The record holds two confirmed lines, " +
          "both 甲's: “我周三之前必须知道” among them. Three clarification " +
          "questions were put to you and came back unanswered.",
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "What this asks of you",
        text:
          "You read a deadline as an ultimatum and stopped answering. Nothing " +
          "in the record shows you said that at the time.",
        claim_ids: ["c1", "c2"],
      },
    ],
  };
}

/** A counterparty copy that holds up: 甲 is "you", 乙 is a third party. */
function counterpartyNarrative(
  overrides: { readonly firstText?: string; readonly claimIds?: string[] } = {},
): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "t1",
        kind: "finding",
        audience: "both",
        heading: "What the record holds",
        text:
          overrides.firstText ??
          "This was written from two messages of yours. In one you put a date " +
            "on the answer you wanted: “我周三之前必须知道”. 乙 brought this " +
            "case; what he said in reply is not in the confirmed record.",
        claim_ids: overrides.claimIds ?? ["c1"],
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

function seedFinalJudgment(): { caseId: string; judgmentId: string } {
  const caseId = seedCase();
  const draft = createDraft(db, caseId, {
    model: "claude-fable-5",
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: clientNarrative(),
  });
  finalize(db, draft.id);
  return { caseId, judgmentId: draft.id };
}

/** The raw judgment row, as bytes, for the freeze assertion. */
function rawJudgment(judgmentId: string): unknown {
  return sqlite
    .prepare("SELECT * FROM judgments WHERE id = ?")
    .get(judgmentId);
}

/* -------------------------------------------------------------------------- */
/* The model double                                                           */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly prompt: string;
}

function mockClient(answer: (call: number) => unknown): {
  client: Anthropic;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const create = vi.fn(async (params: unknown) => {
    const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
    const first = messages[0]?.content;
    calls.push({
      prompt: typeof first === "string" ? first : JSON.stringify(first),
    });
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: JSON.stringify(answer(calls.length)) }],
      usage: {
        input_tokens: 3000,
        output_tokens: 700,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: null,
      },
      _request_id: "req_test",
    };
  });

  return {
    client: {
      messages: { create },
      beta: { messages: { create } },
    } as unknown as Anthropic,
    calls,
  };
}

/* -------------------------------------------------------------------------- */
/* The stage                                                                  */
/* -------------------------------------------------------------------------- */

describe("the shareable_narrative stage", () => {
  it("runs fable at high effort against the contract's own surface schema", () => {
    expect(shareableNarrativeStage.name).toBe("shareable_narrative");
    expect(shareableNarrativeStage.model).toBe(MODEL_FABLE);
    expect(shareableNarrativeStage.effort).toBe("high");
    expect(shareableNarrativeStage.keepPseudonyms).toBe(true);
    // The shape is imported from the contract, not restated beside it.
    expect(shareableNarrativeStage.zodSchema).toBe(surfaceLayerSchema);
  });

  it("puts the frozen skeleton and the client's third-person role in the prompt", () => {
    const prompt = renderShareableNarrativePrompt("L2", factLayer());

    expect(prompt).toContain("我周三之前必须知道");
    expect(prompt).toContain("c1");
    // Who the reader is, and who the client is, are IN the prompt — "we meant
    // to tell it" is not an assertion.
    expect(prompt).toContain('never as "you"');
    expect(prompt).toContain("乙");
    // The level constraints travel with it (HARD RULE #2).
    expect(prompt).toContain("One-sided analysis");
  });
});

/* -------------------------------------------------------------------------- */
/* The address check                                                          */
/* -------------------------------------------------------------------------- */

describe("who a shareable document is talking to", () => {
  it("catches the shapes the first real judgment produced", () => {
    expect(
      checkCounterpartyAddress("You, 乙, submitted this case.", "乙"),
    ).not.toEqual([]);
    expect(
      checkCounterpartyAddress(
        "Three clarification questions were put to you.",
        "乙",
      ),
    ).not.toEqual([]);
    expect(
      checkCounterpartyAddress("You acknowledged each adverse fact.", "乙"),
    ).not.toEqual([]);

    // The role half needs no pseudonym: a document with no idea who the client
    // is still may not tell its reader that clarification was put to them.
    expect(checkCounterpartyAddress("The questions put to you.")).not.toEqual([]);
  });

  it("leaves alone what the document is supposed to say to her", () => {
    for (const line of [
      "Your account can be added to the same record, in your own words.",
      "You were never asked for your account before this was written.",
      "Nothing has been decided that your side cannot change.",
      "You have no confirmed line in this record, because nothing of yours was submitted.",
      "乙 brought this case; what he said in reply is not in the record.",
    ]) {
      expect(checkCounterpartyAddress(line, "乙")).toEqual([]);
    }
  });

  /**
   * "Asked" and "declined" are things the parties also do to each other, and a
   * counterparty who turned down the invitation to take part declined something
   * real. Those two are scoped to a sentence about the hearing; the rest are
   * acts only the client performs.
   */
  it("scopes the ambiguous verbs to the hearing", () => {
    expect(
      checkCounterpartyAddress("You declined to take part in any of it.", "乙"),
    ).toEqual([]);
    expect(
      checkCounterpartyAddress(
        "You declined the clarification questions.",
        "乙",
      ),
    ).not.toEqual([]);
    expect(
      checkCounterpartyAddress("乙 asked you 「你会先跟我讲吗？」.", "乙"),
    ).toEqual([]);
  });

  it("does not scan verbatim evidence, which it may not edit either way", () => {
    // 乙 wrote this to 甲. It contains the second person, in Chinese, and it is
    // his message — not the judgment addressing anyone.
    expect(
      checkCounterpartyAddress(
        "乙 put it this way: “你到底有没有把我说的话放在心上”.",
        "乙",
      ),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

describe("generating the counterparty's copy", () => {
  it("writes a second narrative and never the client's, filtered", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client } = mockClient(() => counterpartyNarrative());

    const outcome = await generateShareableRendition(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;
    expect(outcome.revision).toBe(1);

    const view = readRenditionView(db, judgmentId, "shareable");
    expect(view.sectionIds).toEqual(["t1", "t2"]);
    expect(view.text).toContain("You were never asked for your account");
    // The evidence is the same evidence, quoted verbatim.
    expect(view.text).toContain("我周三之前必须知道");
    // And nothing of the client's copy came along.
    expect(view.text).not.toContain("You, 乙, submitted this case");
    expect(view.text).not.toContain("You read a deadline as an ultimatum");

    // Provenance sits on the rendition, not on the judgment.
    const row = db
      .select()
      .from(judgmentRenditions)
      .where(eq(judgmentRenditions.kind, "shareable"))
      .get();
    expect(row?.model).toBe(MODEL_FABLE);
    expect(row?.effort).toBe("high");
    expect(row?.promptVersion).toBe("shareable_narrative.v1");
    expect(row?.generatedAt).toBeInstanceOf(Date);
  });

  it("rejects a narrative that introduces a claim the skeleton never made", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client, calls } = mockClient(() =>
      counterpartyNarrative({ claimIds: ["c1", "c99"] }),
    );

    const outcome = await generateShareableRendition(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.code).toBe("contract_violation");
    expect(outcome.rejection.contract?.[0].code).toBe("unknown_claim_id");
    expect(outcome.rejection.message).toContain("c99");

    // It was put to the model a second time with the fault named, and then
    // refused outright. Nothing was stored either way.
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("rejected by the server");
    expect(readShareableNarrative(db, judgmentId)).toBeNull();
    expect(() => readRenditionView(db, judgmentId, "shareable")).toThrowError(
      RenditionError,
    );
  });

  /**
   * The M3 defect itself, handed back by the model. A document that says "You,
   * 乙, submitted this case" and "put to you" is describing the reader's partner
   * to the reader, and both halves of the address check fire on it.
   */
  it("rejects a narrative that talks to the client", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client } = mockClient(() =>
      counterpartyNarrative({
        firstText:
          "You, 乙, submitted this case. Three clarification questions were " +
          "put to you and came back unanswered.",
      }),
    );

    const outcome = await generateShareableRendition(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.message).toContain("second person");
    expect(readShareableNarrative(db, judgmentId)).toBeNull();
  });

  it("rejects a section marked as the client's alone", () => {
    const { judgmentId } = seedFinalJudgment();
    const narrative = counterpartyNarrative();

    expect(() =>
      persistShareableNarrative(
        db,
        judgmentId,
        {
          sections: [
            { ...narrative.sections[0], audience: "self_only" },
            narrative.sections[1],
          ],
        },
        { model: MODEL_FABLE },
      ),
    ).toThrowError(/self_only/);
  });

  it("rejects a copy of the client's own sections", () => {
    const { judgmentId } = seedFinalJudgment();

    expect(() =>
      persistShareableNarrative(
        db,
        judgmentId,
        {
          sections: [
            {
              section_id: "t1",
              kind: "disclosure",
              audience: "both",
              heading: "What this judgment could read",
              // Byte-identical to the client's disclosure section.
              text: clientNarrative().sections[0].text,
              claim_ids: [],
            },
          ],
        },
        { model: MODEL_FABLE },
      ),
    ).toThrowError(RenditionError);
  });
});

/* -------------------------------------------------------------------------- */
/* Renditions have their own lifecycle (M4 ③, HARD RULE #6)                   */
/* -------------------------------------------------------------------------- */

describe("regenerating a rendition", () => {
  it("bumps the rendition and leaves the frozen judgment byte-identical", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client } = mockClient((call) =>
      counterpartyNarrative({
        firstText:
          call === 1
            ? "This was written from two messages of yours: “我周三之前必须知道” " +
              "is one of them. 乙 brought the case."
            : "Second pass, plainer: two of your messages are the whole record " +
              "here, “我周三之前必须知道” among them. 乙 brought the case.",
      }),
    );

    const first = await generateShareableRendition(db, judgmentId, {
      llm: { db, client },
    });
    expect(first.kind).toBe("generated");

    const before = JSON.stringify(rawJudgment(judgmentId));
    const judgmentBefore = readJudgment(db, judgmentId);

    const second = await generateShareableRendition(db, judgmentId, {
      llm: { db, client },
    });
    expect(second.kind).toBe("generated");
    if (second.kind !== "generated") return;

    // The rendition moved…
    expect(second.revision).toBe(2);
    expect(second.view.text).toContain("Second pass, plainer");
    expect(readRenditionView(db, judgmentId, "shareable").text).toContain(
      "Second pass, plainer",
    );

    // …and the judgment did not. Byte-identical row, including updated_at.
    expect(JSON.stringify(rawJudgment(judgmentId))).toBe(before);
    expect(readJudgment(db, judgmentId)?.surfaceLayer).toEqual(
      judgmentBefore?.surfaceLayer,
    );
    expect(readJudgment(db, judgmentId)?.status).toBe("final");
  });

  it("refuses to derive one from a draft", () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
      surfaceLayer: clientNarrative(),
    });

    expect(() =>
      persistShareableNarrative(db, draft.id, counterpartyNarrative(), {
        model: MODEL_FABLE,
      }),
    ).toThrowError(/draft/);
  });
});

/* -------------------------------------------------------------------------- */
/* The stored judgment (M4 ①, acceptance)                                     */
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
 * Nothing is generated and nothing is written here — the frozen judgment and its
 * shareable rendition are read as they stand, and a judgment whose counterparty
 * copy has not been generated yet skips rather than generating one.
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
 * a fixture.
 */
function newestFrozenJudgmentId(connection: Database.Database): string | null {
  const row = connection
    .prepare(
      "SELECT id FROM judgments WHERE status = 'final' " +
        "ORDER BY finalized_at DESC, version DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

describe("the stored judgment's shareable rendition", () => {
  it.skipIf(!existsSync(TARGET_DB))(
    "addresses the counterparty, and never the client, in the second person",
    (ctx) => {
      loadEnvLocal();
      if (process.env.FAIRJUDGE_DB_KEY === undefined) {
        ctx.skip();
        return;
      }

      const stored = createDb(TARGET_DB);
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

        // Who the client is comes off the judgment, not out of this file.
        const client = judgment.factLayer.findings.record_basis.client_pseudonym;
        expect(client.length).toBeGreaterThan(0);

        // Is there a counterparty-addressed narrative at all? The same question
        // the read view and the share path ask — "is there a surface layer on
        // the shareable row" — because generating one here would spend money
        // and write to the record.
        const narrative = stored.sqlite
          .prepare(
            "SELECT surface_layer IS NOT NULL AS present FROM judgment_renditions " +
              "WHERE judgment_id = ? AND kind = 'shareable'",
          )
          .get(judgmentId) as { present: number } | undefined;
        if (narrative?.present !== 1) {
          ctx.skip();
          return;
        }

        // ① The document that would actually be handed to the other party.
        const shared = readRenditionView(stored.db, judgmentId, "shareable");
        expect(checkCounterpartyAddress(shared.text, client)).toEqual([]);
        // The client is in it — as a third party, by pseudonym. A document that
        // simply never mentions him would pass the check above and fail the
        // reader.
        expect(shared.text).toContain(client);

        // ② The same check, over the projection M3 shipped: the client's frozen
        //    narrative with the self_only sections filtered out. That the
        //    shareable copy is a second document rather than that projection is
        //    what the milestone changed. Whether a particular narrative trips
        //    the address check is a property of that narrative — the client's
        //    copy is written to the client, so it usually does — so what is
        //    asserted here is the shape of whatever the check found, not that
        //    it found something.
        const filtered = renderRendition(judgment.surfaceLayer, "shareable");
        expect(shared.text).not.toBe(filtered.text);
        const defects = checkCounterpartyAddress(filtered.text, client);
        if (defects.length > 0) {
          expect(defects.map((d) => d.detail).join(" ")).toMatch(
            /second person|apposition/,
          );
        }
      } finally {
        stored.sqlite.close();
      }
    },
  );
});
