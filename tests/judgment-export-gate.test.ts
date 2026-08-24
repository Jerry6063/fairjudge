/**
 * The shareable-export gate (SPEC M4 ⑥) — the last thing that runs before a copy
 * of a judgment leaves the machine.
 *
 * Five properties, and they are all about the same moment: a document written
 * from one person's account is handed to somebody else and cannot be recalled.
 *
 *   1. **A real name or a registered nickname blocks the export**, and the
 *      refusal names what it found and what it should have been. Including when
 *      the name is split by an invisible character — metadata is stripped before
 *      anything is scanned, so hiding a name from the reader also stops hiding it
 *      from the check.
 *   2. **The quote rule is attribution-scoped, not a length filter.** The
 *      recipient's own words survive at any length — they are the evidence basis
 *      of the document she is holding — and somebody else's long verbatim quote
 *      is caught.
 *   3. **`self_reflection` is never exported**, by the same rule that mints it no
 *      share token.
 *   4. **Every export writes exactly one audit row**, and a blocked one writes
 *      none, because what is audited is egress and a refused document never left.
 *   5. **There is no one-click social share**, and asking for one gets a refusal
 *      with a reason rather than a missing button.
 *
 * The fixture uses the same names the pseudonym tests use (知夏 → 甲, Adrian → 乙).
 * Evidence and names are Chinese and stay Chinese, verbatim (CLAUDE.md).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { caseParticipants, cases } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import { buildCaseDict } from "../src/server/evidence/anomaly";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  ExportBlockedError,
  MAX_THIRD_PARTY_QUOTE_CHARS,
  NOTICE_OPENING,
  NOTICE_REDISTRIBUTION,
  RESPONSE_WITHOUT_LINK,
  deadRespondPointers,
  hasProvenanceNotice,
  RESPONSE_PROMPT,
  assertShareable,
  checkQuoteAttribution,
  composeWatermark,
  createDraft,
  deriveNameFragments,
  exportRendition,
  finalize,
  findVerbatimQuotes,
  listExports,
  persistShareableNarrative,
  readJudgment,
  readRenditionView,
  scanRealNames,
  stripExportMetadata,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";
import type { PersonDict } from "../src/server/pseudonym";

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
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** 22 characters of 甲's own message — comfortably over the third-party cap. */
const LONG_QUOTE = "我周三之前必须知道，不然我没法安排接下来的事";

/**
 * A stored judgment on disk, when this machine has one. Read-only where used.
 *
 * The default is the fictional demo record (`data/fairjudge-demo.db`, built by
 * `scripts/seed-fixture.ts`). Any other database — including a live case record
 * — is opt-in and explicit via `FAIRJUDGE_DB_PATH`. There is no default that
 * reaches a real case: a case is data in a local database, not a fixture in this
 * repository.
 */
const TARGET_DB = resolve(
  process.cwd(),
  process.env.FAIRJUDGE_DB_PATH ?? "data/fairjudge-demo.db",
);

/**
 * The judgment that stands in whichever database was opened, or null.
 *
 * Asked of the record rather than named by id — a literal id is a fact about
 * one machine's database, and every assertion written under it quietly becomes
 * a fact about one case.
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

/** Registered variants have nowhere to live on the participant row yet. */
const DICT_WITH_VARIANTS: PersonDict = [
  { canonical: "知夏", pseudonym: "甲", variants: ["夏夏", "小夏"] },
  { canonical: "Adrian", pseudonym: "乙", variants: [] },
];

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
    .run();

  return row.id;
}

function factLayer(): FactLayer {
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
        text: "You, 乙, submitted this case. Two lines are on file, both 甲's.",
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "What this asks of you",
        text: "You read a deadline as an ultimatum and stopped answering.",
        claim_ids: ["c1", "c2"],
      },
    ],
  };
}

/**
 * The counterparty's copy: 甲 is "you", 乙 is a third party. `firstText` is what
 * each test varies — it is the sentence the gate is being asked about.
 */
function counterpartyNarrative(firstText?: string): SurfaceLayer {
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
          "You were never asked for your account, so nothing here settles what " +
          "either of you meant by any of it.",
        claim_ids: [],
      },
    ],
  };
}

interface Seeded {
  readonly caseId: string;
  readonly judgmentId: string;
}

/** A frozen judgment with a stored counterparty narrative. */
function seedExportable(firstText?: string): Seeded {
  const caseId = seedCase();
  const draft = createDraft(db, caseId, {
    model: MODEL_FABLE,
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: clientNarrative(),
  });
  finalize(db, draft.id);
  persistShareableNarrative(db, draft.id, counterpartyNarrative(firstText), {
    model: MODEL_FABLE,
    effort: "high",
    promptVersion: "shareable_narrative.v1",
  });
  return { caseId, judgmentId: draft.id };
}

function refusal(run: () => unknown): ExportBlockedError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExportBlockedError) return error;
    throw error;
  }
  throw new Error("expected the export to be refused, and it was not");
}

/* -------------------------------------------------------------------------- */
/* A clean export                                                             */
/* -------------------------------------------------------------------------- */

describe("exporting a shareable rendition", () => {
  it("watermarks it, keeps the frame intact, and audits exactly one copy", () => {
    const { caseId, judgmentId } = seedExportable();
    const now = new Date("2026-08-10T09:30:00.000Z");

    const doc = exportRendition(db, {
      judgmentId,
      channel: "file",
      now,
    });

    // The watermark leads, so the document underneath is unchanged: the label
    // still opens the judgment and the way in is still the last line.
    expect(doc.text.startsWith(doc.watermark)).toBe(true);
    expect(doc.watermark).toContain(doc.exportId.slice(0, 8));
    expect(doc.watermark).toContain("2026-08-10");
    expect(doc.watermark).toContain("judgment v1");
    // It names no one: the id resolves to the audit row, which knows who.
    expect(doc.watermark).not.toContain("知夏");
    expect(doc.watermark).not.toContain("甲");

    expect(hasProvenanceNotice(doc.text)).toBe(true);
    // No dead link ships. `/respond` on its own is not a page — the exported
    // copy ends on words telling her how to ask for a way in, and the string
    // that does not resolve is nowhere in the bytes.
    expect(doc.text.trimEnd().endsWith(RESPONSE_WITHOUT_LINK)).toBe(true);
    expect(doc.text).not.toContain("/respond");
    expect(deadRespondPointers(doc.text)).toEqual([]);
    // The bytes that leave still pass the share gate — that is the last check
    // the export runs, asserted here over the same string.
    expect(() => assertShareable(doc.text, "/respond", "乙")).not.toThrow();

    // The evidence is the same evidence, quoted verbatim.
    expect(doc.text).toContain(LONG_QUOTE);

    // One audit row, and it describes what left: what, when, which rendition,
    // which recipient.
    const audit = listExports(db, judgmentId);
    expect(audit).toHaveLength(1);
    expect(audit[0].id).toBe(doc.exportId);
    expect(audit[0].caseId).toBe(caseId);
    expect(audit[0].kind).toBe("shareable");
    expect(audit[0].judgmentVersion).toBe(1);
    expect(audit[0].renditionRevision).toBe(1);
    expect(audit[0].recipientPseudonym).toBe("甲");
    expect(audit[0].recipientParticipantId).not.toBeNull();
    expect(audit[0].channel).toBe("file");
    expect(audit[0].exportedAt.toISOString()).toBe(now.toISOString());
    expect(audit[0].byteSize).toBe(Buffer.byteLength(doc.text, "utf8"));
    // The hash is of the exact bytes returned — enough to say whether a copy
    // found later is this one, without storing the document twice.
    expect(audit[0].contentSha256).toBe(
      createHash("sha256").update(doc.text, "utf8").digest("hex"),
    );
  });

  it("writes one row per export, not one per judgment", () => {
    const { judgmentId } = seedExportable();

    const first = exportRendition(db, { judgmentId, channel: "file" });
    const second = exportRendition(db, { judgmentId, channel: "print" });

    const audit = listExports(db, judgmentId);
    expect(audit).toHaveLength(2);
    expect(new Set(audit.map((row) => row.id))).toEqual(
      new Set([first.exportId, second.exportId]),
    );
    expect(new Set(audit.map((row) => row.channel))).toEqual(
      new Set(["file", "print"]),
    );
    // Two copies, two watermarks, two hashes: a leaked copy resolves to the
    // export that produced it rather than to "one of the times this was shared".
    expect(first.contentSha256).not.toBe(second.contentSha256);
  });

  it("records the recipient it was told about, and refuses to guess", () => {
    const { judgmentId } = seedExportable();

    const doc = exportRendition(db, {
      judgmentId,
      channel: "clipboard",
      recipient: { pseudonym: "甲" },
    });
    expect(doc.recipientPseudonym).toBe("甲");

    const blocked = refusal(() =>
      exportRendition(db, {
        judgmentId,
        channel: "file",
        recipient: { participantId: randomUUID() },
      }),
    );
    expect(blocked.code).toBe("recipient_unknown");
    expect(listExports(db, judgmentId)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

describe("the real-name scan", () => {
  it("blocks a copy carrying a real name, and names the hit", () => {
    const { judgmentId } = seedExportable(
      `知夏, this was written from two messages of yours: “${LONG_QUOTE}” is one.`,
    );

    const blocked = refusal(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    );

    expect(blocked.code).toBe("real_name_present");
    // What it found, and what it should have been.
    expect(blocked.message).toContain("知夏");
    expect(blocked.message).toContain("甲");
    expect(blocked.violations[0].excerpt).toContain("知夏");
    // A refused export writes no audit row: nothing left the machine.
    expect(listExports(db, judgmentId)).toHaveLength(0);
  });

  it("blocks a registered nickname variant", () => {
    const { judgmentId } = seedExportable(
      `The record holds two of your messages; in one, 夏夏, you wrote “${LONG_QUOTE}”.`,
    );

    // Variants come from the dictionary the caller passes: the participant row
    // has nowhere to store one yet, so the default case dict knows only the
    // canonical name.
    const blocked = refusal(() =>
      exportRendition(db, {
        judgmentId,
        channel: "file",
        dict: DICT_WITH_VARIANTS,
      }),
    );

    expect(blocked.code).toBe("real_name_present");
    expect(blocked.message).toContain("夏夏");
    expect(blocked.message).toMatch(/nickname or alternative spelling/);
    expect(listExports(db, judgmentId)).toHaveLength(0);
  });

  it("catches a name split by an invisible character", () => {
    // A zero-width space between the two characters: invisible to a reader, and
    // — before this gate strips it — invisible to a scan looking for the name.
    const { judgmentId } = seedExportable(
      `\u77E5\u200B\u590F, two of your messages are the whole record here: “${LONG_QUOTE}”.`,
    );

    const blocked = refusal(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    );
    expect(blocked.code).toBe("real_name_present");
    expect(blocked.message).toContain("知夏");
  });

  it("strips what a reader cannot see before anything else runs", () => {
    const { judgmentId } = seedExportable(
      `<!-- prepared for 知夏 -->This was written from two messages of yours. ` +
        `In one you wrote “${LONG_QUOTE}”.\u200B`,
    );

    const doc = exportRendition(db, { judgmentId, channel: "file" });

    // The comment is gone, so the name it carried never reaches a reader — and
    // there is no per-copy invisible marking left in the bytes either.
    expect(doc.text).not.toContain("<!--");
    expect(doc.text).not.toContain("知夏");
    expect(doc.text).not.toMatch(/[\u200B-\u200F\uFEFF]/);
    expect(listExports(db, judgmentId)).toHaveLength(1);
  });

  it("derives the fragments of a name that people actually say", () => {
    expect(deriveNameFragments("知夏明")).toEqual(["夏明"]);
    expect(deriveNameFragments("欧阳知夏")).toEqual(["阳知夏", "知夏"]);
    // Two characters give a one-character given name, which is a word far more
    // often than it is a name. Nothing is derived from it.
    expect(deriveNameFragments("知夏")).toEqual([]);
    expect(deriveNameFragments("Adrian")).toEqual([]);
    expect(deriveNameFragments("Adrian Cole")).toEqual(["Adrian", "Cole"]);

    const hits = scanRealNames("夏明 came by that evening.", [
      { canonical: "知夏明", pseudonym: "丙", variants: [] },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "derived_fragment",
      found: "夏明",
      pseudonym: "丙",
    });
  });

  it("leaves a document that carries only pseudonyms alone", () => {
    expect(
      scanRealNames("甲 wrote to 乙 that evening.", DICT_WITH_VARIANTS),
    ).toEqual([]);
    expect(stripExportMetadata("---\ntitle: x\n---\nbody\n")).toBe("body");
  });
});

/* -------------------------------------------------------------------------- */
/* Quotes                                                                     */
/* -------------------------------------------------------------------------- */

describe("the quote rule", () => {
  const audience = { recipientPseudonym: "甲", otherPseudonyms: ["乙"] };

  it("finds verbatim spans in both scripts' quotation marks", () => {
    const spans = findVerbatimQuotes(
      `You wrote “${LONG_QUOTE}”, and later 「短的」.`,
    );
    expect(spans.map((span) => span.content)).toEqual([LONG_QUOTE, "短的"]);
    expect(spans[0].length).toBeGreaterThan(MAX_THIRD_PARTY_QUOTE_CHARS);
    expect(spans[1].length).toBe(2);
  });

  it("lets the recipient's own long quotes through", () => {
    for (const line of [
      `In one message you wrote “${LONG_QUOTE}”.`,
      `甲 put it plainly at the time: “${LONG_QUOTE}”.`,
      `Your own message that evening — “${LONG_QUOTE}” — is the whole basis of this.`,
    ]) {
      expect(checkQuoteAttribution(line, audience)).toEqual([]);
    }
  });

  /**
   * The shape that refuted the first version of this rule: the
   * recipient's own words, ABOUT the other party, so his pseudonym sits between
   * the attribution verb and the quote. Most of a one-sided judgment's evidence
   * looks like this, and mentioning 乙 does not make him the speaker — "you
   * stated" does. Invented text in the shape a counterparty narrative has.
   */
  it("reads the speaker off the attribution verb, not off who is mentioned", () => {
    const line =
      "The confirmed record shows you stated that 乙 mixed up the reservation " +
      "date and never checked it, so the table was gone when you arrived: " +
      "“订位的日子他记错了也不核对，到了饭店才发现根本没有位子”.";
    expect(checkQuoteAttribution(line, audience)).toEqual([]);

    // The same sentence with the speech verb moved onto 乙 is somebody else's
    // words, and is caught.
    expect(
      checkQuoteAttribution(
        `You were told that 乙 said “订位的日子他记错了也不核对，到了饭店才发现根本没有位子”.`,
        audience,
      ),
    ).toHaveLength(1);
  });

  it("catches a long quote that is somebody else's, or nobody's", () => {
    const attributed = checkQuoteAttribution(
      `乙 put it this way: “${LONG_QUOTE}”.`,
      audience,
    );
    expect(attributed).toHaveLength(1);
    expect(attributed[0].code).toBe("third_party_quote");
    expect(attributed[0].excerpt).toContain(LONG_QUOTE);
    // It is refused, not shortened: a trimmed quote is an edited record.
    expect(attributed[0].detail).toMatch(/not shortened/);

    // No attribution at all is the re-identification case the rule is for.
    expect(checkQuoteAttribution(`“${LONG_QUOTE}”`, audience)).toHaveLength(1);

    // A short one from anybody is fine — the rule is about reproducing a
    // passage, not about mentioning a phrase.
    expect(checkQuoteAttribution("乙 said “今天不行”.", audience)).toEqual([]);
  });

  it("blocks the export on a third party's long quote and lets the recipient's own stand", () => {
    const third = seedExportable(
      `You were written about here. 乙 put it this way: “${LONG_QUOTE}”.`,
    );
    const blocked = refusal(() =>
      exportRendition(db, { judgmentId: third.judgmentId, channel: "file" }),
    );
    expect(blocked.code).toBe("third_party_quote");
    expect(listExports(db, third.judgmentId)).toHaveLength(0);

    // Fresh case: the identical quote, attributed to the person receiving the
    // copy. It is her own message and it survives the gate untouched.
    sqlite.close();
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);

    const own = seedExportable(
      `This was written from two messages of yours. In one you wrote “${LONG_QUOTE}”.`,
    );
    const doc = exportRendition(db, { judgmentId: own.judgmentId, channel: "file" });
    expect(doc.text).toContain(LONG_QUOTE);
    expect(listExports(db, own.judgmentId)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What never leaves                                                          */
/* -------------------------------------------------------------------------- */

describe("what the gate refuses outright", () => {
  it("never exports the self-reflection copy", () => {
    const { judgmentId } = seedExportable();

    const blocked = refusal(() =>
      exportRendition(db, {
        judgmentId,
        kind: "self_reflection",
        channel: "file",
      }),
    );

    expect(blocked.code).toBe("not_shareable");
    expect(blocked.message).toMatch(/written for the client alone/);
    // Same rule as the share token, and it refuses before anything is rendered.
    expect(blocked.message).toMatch(/no share token is (ever )?minted/i);
    expect(listExports(db, judgmentId)).toHaveLength(0);
  });

  it("refuses a one-click social share, by name", () => {
    const { judgmentId } = seedExportable();

    const blocked = refusal(() =>
      exportRendition(db, { judgmentId, channel: "wechat_moments" }),
    );
    expect(blocked.code).toBe("social_share_refused");
    expect(blocked.message).toMatch(/decision rather than a gap/);

    expect(
      refusal(() => exportRendition(db, { judgmentId, channel: "carrier pigeon" }))
        .code,
    ).toBe("unknown_channel");

    expect(listExports(db, judgmentId)).toHaveLength(0);
  });

  it("refuses a draft, and a judgment with no counterparty narrative", () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: MODEL_FABLE,
      factLayer: factLayer(),
      surfaceLayer: clientNarrative(),
    });

    expect(refusal(() => exportRendition(db, { judgmentId: draft.id, channel: "file" })).code).toBe(
      "not_final",
    );

    // Frozen, but nothing has been written to the other party yet: the shareable
    // rendition row exists and is empty, and an empty one is not a document.
    finalize(db, draft.id);
    expect(() =>
      exportRendition(db, { judgmentId: draft.id, channel: "file" }),
    ).toThrowError(/counterparty-addressed narrative/);
    expect(listExports(db, draft.id)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The watermark                                                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* A stored judgment (M4 ⑥, acceptance)                                       */
/* -------------------------------------------------------------------------- */

/**
 * The gate, run over a document the machine actually holds.
 *
 * Read-only on purpose: it runs the checks and asserts on them, and never calls
 * `exportRendition`, because an export writes an audit row and a test run is not
 * a copy anybody received. Nothing here is case-specific — the judgment is
 * whichever frozen one the target database holds, and its parties come off the
 * participant rows — so the check is about the gate, not about a case. Skips
 * when there is no database, no key, or no frozen judgment to read.
 */
describe("a stored judgment's shareable copy, against the gate", () => {
  it.skipIf(!existsSync(TARGET_DB))(
    "carries no real name and no unattributed long quote",
    (ctx) => {
      loadEnvLocal();
      if (process.env.FAIRJUDGE_DB_KEY === undefined) {
        ctx.skip();
        return;
      }

      const real = createDb(TARGET_DB);
      try {
        const judgmentId = newestFrozenJudgmentId(real.sqlite);
        if (judgmentId === null) {
          ctx.skip();
          return;
        }

        const judgment = readJudgment(real.db, judgmentId);
        if (judgment === null || judgment.surfaceLayer === null) {
          ctx.skip();
          return;
        }

        let text: string;
        try {
          text = stripExportMetadata(
            readRenditionView(real.db, judgmentId, "shareable").text,
          );
        } catch {
          // No counterparty narrative has been generated for this judgment yet,
          // so there is no shareable copy to gate. Reported, not failed.
          ctx.skip();
          return;
        }

        const parties = real.db
          .select()
          .from(caseParticipants)
          .where(eq(caseParticipants.caseId, judgment.caseId))
          .all();
        const recipient =
          parties.find((party) => !party.isSubmitter)?.pseudonym ?? "甲";
        const others = [
          ...new Set([
            ...parties.map((party) => party.pseudonym),
            judgment.factLayer.findings.record_basis.client_pseudonym,
          ]),
        ].filter((pseudonym) => pseudonym !== recipient);

        // The dictionary the export path would use, from the participant rows.
        expect(scanRealNames(text, buildCaseDict(real.db, judgment.caseId))).toEqual(
          [],
        );
        expect(
          checkQuoteAttribution(text, {
            recipientPseudonym: recipient,
            otherPseudonyms: others,
          }),
        ).toEqual([]);
      } finally {
        real.sqlite.close();
      }
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The watermark                                                              */
/* -------------------------------------------------------------------------- */

describe("the watermark", () => {
  it("carries the export id and a date the share gate cannot mistake for a ratio", () => {
    const watermark = composeWatermark({
      exportId: "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8",
      judgmentVersion: 2,
      exportedAt: new Date("2026-08-10T23:59:59.000Z"),
    });

    expect(watermark).toContain("0f3c1a2b");
    expect(watermark).toContain("judgment v2");
    // ISO with hyphens on purpose: `08/10` reads as a numeric split to the
    // shareable language check, which would refuse a document over its own
    // watermark.
    expect(watermark).toContain("2026-08-10");
    expect(watermark).not.toContain("/");
  });
});
