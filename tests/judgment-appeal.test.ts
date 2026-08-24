/**
 * The appeal channel (SPEC M4 ⑤).
 *
 * A judgment is frozen (HARD RULE #6), so "you got this wrong" cannot be an
 * edit. It is a re-hearing: version n + 1, through the same chain, at effort
 * `max`, with the grounds and whatever has been confirmed since — and the diff
 * against the previous version is the disclosure that makes re-hearing allowed
 * at all.
 *
 * What this file is here to catch:
 *
 *   1. **Judgment shopping.** One appeal per judgment version. A second filing
 *      against the same version is refused in the service layer, before a token
 *      is spent, and the refusal survives the whole act rather than only the
 *      convenience wrapper.
 *   2. **A frozen row moving.** The predecessor is compared byte-for-byte across
 *      the re-hearing, raw out of SQLite.
 *   3. **An appeal burned by a failure.** A re-hearing that produced no version
 *      has not used the appeal up: the row stays, the status returns to
 *      `submitted`, and it can be heard again.
 *   4. **A re-hearing that does not see the new material.** The dossier is
 *      reassembled, so a line confirmed after the first judgment is in it — and a
 *      re-hearing restating the old record counts is rejected against the
 *      database, exactly as the first hearing would have been.
 *
 * Evidence content is Chinese and stays Chinese (CLAUDE.md): it is a verbatim
 * record, and a translated fixture would lie about what the pipeline reads.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  adverseFacts,
  appeals,
  caseParticipants,
  cases,
  clarificationRounds,
  issues,
  judgments,
  steelmanVersions,
  utterances,
  type OutputLevel,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  confirmOwnLine,
  submitStatement,
} from "../src/server/participation/submission";
import { appealRehearingStage } from "../src/server/llm/stages";
import {
  AppealError,
  appealJudgment,
  assembleJudgmentDossier,
  createDraft,
  describeAppealDiff,
  factLayerSchema,
  fileAppeal,
  finalize,
  findNumericResponsibilitySplits,
  hearAppeal,
  listAppealsForJudgment,
  readAppeal,
  readAppealByActor,
  readAppealForJudgment,
  readJudgment,
  readJudgmentChain,
  renderAppealPrompt,
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
/* Fixture — the real case's shape: 甲 spoke twice, 乙 never on the record     */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  readonly citable: readonly string[];
  readonly pending: readonly string[];
  /** 乙, who brought the case. The appellant in every pre-M5 filing. */
  readonly client: string;
  /** 甲, the party the case is about. She may appeal it too (SPEC M5 ⑤). */
  readonly counterparty: string;
  /**
   * A line 甲 submitted and confirmed HERSELF, on the `"L1"` fixture only.
   *
   * The fixture cannot simply write `L1` onto the case column any more: a
   * re-hearing re-derives the level before it assembles the successor's dossier
   * (SPEC M5 ⑥), so a level nothing in the record supports is relocked down to
   * what the record does support. Which is the point — the L1 in this fixture
   * has to be bought the way the product buys it.
   */
  readonly counterpartyOwned: string | null;
}

function seedCase(level: OutputLevel = "L2"): Fixture {
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
  const caseId = row.id;

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
        participationState: "unreachable",
      },
    ])
    .returning()
    .all();
  const client = parties.find((p) => p.isSubmitter)!;
  const counterparty = parties.find((p) => !p.isSubmitter)!;

  const citable = db
    .insert(utterances)
    .values([
      {
        caseId,
        speakerParticipantId: counterparty.id,
        speakerLabel: "甲",
        aiDraft: "你要是真在乎就不会拖到现在",
        confirmStatus: "confirmed" as const,
      },
      {
        caseId,
        speakerParticipantId: counterparty.id,
        speakerLabel: "甲",
        aiDraft: "这件事今天必须说清楚",
        confirmStatus: "confirmed" as const,
      },
    ])
    .returning()
    .all()
    .map((u) => u.id);

  const pending = db
    .insert(utterances)
    .values(
      ["我当时在加班", "我不是不在乎", "我需要一点时间"].map((text) => ({
        caseId,
        speakerParticipantId: client.id,
        speakerLabel: "乙",
        aiDraft: text,
        confirmStatus: "pending" as const,
      })),
    )
    .returning()
    .all()
    .map((u) => u.id);

  db.insert(issues)
    .values({
      caseId,
      category: "undisputed" as const,
      aiDraft: "甲 set a same-day deadline for resolving the argument.",
      evidenceRefs: [citable[1]],
      confirmStatus: "confirmed" as const,
    })
    .run();

  db.insert(adverseFacts)
    .values({
      caseId,
      aiDraft: "You let the exchange run past what 甲 had asked for.",
      evidenceRefs: [citable[0]],
      ackStatus: "acknowledged" as const,
      ackNote: "确实拖了",
    })
    .run();

  db.insert(steelmanVersions)
    .values({
      caseId,
      version: 1,
      verdict: "accepted" as const,
      aiDraft: "甲 would say they had already raised this twice and got nothing.",
    })
    .run();

  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber: 1,
      questions: [
        { id: "q1", question: "What did you say back after 甲's second message?" },
      ],
      answers: [
        {
          questionId: "q1",
          answer: "",
          answeredAt: null,
          state: "declined" as const,
          declineNote: "not answered by the client",
        },
      ],
    })
    .run();

  // What L1 actually costs (SPEC M5 ⑥): material she owns, confirmed by her,
  // reaching the case record through her own `granted / case_record` event.
  // Written through the product's own path, so the fixture cannot be right
  // about a state the code cannot produce.
  let counterpartyOwned: string | null = null;
  if (level === "L1") {
    const submitted = submitStatement(db, {
      caseId,
      participantId: counterparty.id,
      text: "我那天等到十一点，他一句话都没回。",
    });
    counterpartyOwned = submitted.utteranceIds[0];
    confirmOwnLine(db, {
      caseId,
      participantId: counterparty.id,
      evidenceId: submitted.evidenceId,
      utteranceId: counterpartyOwned,
    });
    db.update(caseParticipants)
      .set({ participationState: "written_response" })
      .where(eq(caseParticipants.id, counterparty.id))
      .run();
  }

  return {
    caseId,
    citable,
    pending,
    client: client.id,
    counterparty: counterparty.id,
    counterpartyOwned,
  };
}

/** The skeleton version 1 was issued on: 乙 has no citable line at all. */
function factLayerV1(fixture: Fixture): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a same-day deadline: “这件事今天必须说清楚”.",
        evidence_refs: [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          "甲 treated the delay as evidence of not caring — “你要是真在乎就不会拖到现在”.",
        evidence_refs: [fixture.citable[0]],
        confidence: 0.6,
        tier: "inferred",
      },
      {
        claim_id: "c3",
        statement: "What 乙 said in reply is not in the confirmed record.",
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
          "Two lines, both 甲's. Not one line 乙 spoke is confirmed, so nothing " +
          "here rests on 乙's own account.",
      },
      unresolved: [
        {
          question: "What did 乙 say back after 甲's second message?",
          reason: "clarification_unanswered",
          claim_ids: ["c3"],
        },
      ],
      responsibility: [],
    },
  };
}

/**
 * The re-hearing's skeleton after one of 乙's lines was confirmed: c2 drops from
 * `inferred` to `unknown`, and a claim about 乙's own words appears.
 */
function factLayerV2(fixture: Fixture, confirmedClientUtteranceId: string): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a same-day deadline: “这件事今天必须说清楚”.",
        evidence_refs: [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          "Whether the delay meant 乙 did not care cannot be settled on this " +
          "record.",
        evidence_refs: [],
        confidence: 0.1,
        tier: "unknown",
      },
      {
        claim_id: "c4",
        statement: "乙 gave a reason at the time: “我当时在加班”.",
        evidence_refs: [confirmedClientUtteranceId],
        confidence: 0.8,
        tier: "high_confidence",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 3, by_client: 1, by_counterparty: 2 },
        parties_without_citable_utterance: [],
        statement:
          "Three lines now: two of 甲's and one of 乙's, confirmed after the " +
          "first hearing. The record is still thin on both sides.",
      },
      unresolved: [
        {
          question: "What did 甲 understand by the delay?",
          reason: "record_silent",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [],
    },
  };
}

function surfaceLayer(marker: string, claimIds: string[]): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: `${marker}`,
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "both",
        heading: "The deadline",
        text: "甲 set a same-day deadline: “这件事今天必须说清楚”.",
        claim_ids: claimIds,
      },
    ],
  };
}

/** Version 1, frozen, exactly as the product would have issued it. */
function seedJudgment(fixture: Fixture): string {
  const draft = createDraft(db, fixture.caseId, {
    model: MODEL_FABLE,
    effort: "xhigh",
    promptVersion: "judgment_skeleton.v1",
    factLayer: factLayerV1(fixture),
    surfaceLayer: surfaceLayer("Two lines, both 甲's.", ["c1", "c2"]),
  });
  return finalize(db, draft.id).id;
}

/** Confirm one of the client's lines — the "newly confirmed material" case. */
function confirmClientLine(fixture: Fixture): string {
  const id = fixture.pending[0];
  db.update(utterances)
    .set({ confirmStatus: "confirmed", humanFinal: "我当时在加班" })
    .where(eq(utterances.id, id))
    .run();
  return id;
}

/** The raw judgment row, as bytes, for the freeze assertion. */
function rawJudgment(judgmentId: string): unknown {
  return sqlite.prepare("SELECT * FROM judgments WHERE id = ?").get(judgmentId);
}

/* -------------------------------------------------------------------------- */
/* The model double                                                           */
/* -------------------------------------------------------------------------- */

type Step = "rehearing" | "narrative" | "other";

function stepOf(params: unknown): Step {
  const system = (params as { system?: unknown }).system;
  const text = typeof system === "string" ? system : JSON.stringify(system);
  if (text.includes("You are the appeal stage")) return "rehearing";
  if (text.includes("You are the drafting stage")) return "narrative";
  /* c8 ignore next -- no other stage runs in this file. */
  return "other";
}

interface Recorded {
  readonly step: Step;
  readonly prompt: string;
}

function mockClient(answer: (step: Step, call: number) => unknown): {
  client: Anthropic;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const create = vi.fn(async (params: unknown) => {
    const step = stepOf(params);
    const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
    const first = messages[0]?.content;
    calls.push({
      step,
      prompt: typeof first === "string" ? first : JSON.stringify(first),
    });
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: JSON.stringify(answer(step, calls.length)) }],
      usage: {
        input_tokens: 5000,
        output_tokens: 1200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: null,
      },
      _request_id: "req_test",
    };
  });

  // The gateway streams a stage whose budget exceeds the SDK's non-streaming
  // ceiling (`appeal_rehearing` is one), so the double answers on both
  // transports from the same recording. `finalMessage()` is what the gateway
  // reads, and it returns the same object `create` does.
  const stream = (params: unknown) => ({ finalMessage: () => create(params) });

  return {
    client: {
      messages: { create, stream },
      beta: { messages: { create, stream } },
    } as unknown as Anthropic,
    calls,
  };
}

const GROUNDS =
  "判决说我“把事情拖过了甲要求的时间”，但那天我在加班，这条已经补确认了，请重新看一次。";

/* -------------------------------------------------------------------------- */
/* The stage                                                                  */
/* -------------------------------------------------------------------------- */

describe("the appeal_rehearing stage", () => {
  it("runs fable at max effort and returns a fact layer, not a commentary", () => {
    expect(appealRehearingStage.name).toBe("appeal_rehearing");
    expect(appealRehearingStage.model).toBe(MODEL_FABLE);
    expect(appealRehearingStage.effort).toBe("max");
    expect(appealRehearingStage.keepPseudonyms).toBe(true);
    // The shape is the contract's own, imported rather than restated beside it.
    expect(appealRehearingStage.zodSchema).toBe(factLayerSchema);
  });

  it("puts the record, the appealed skeleton and the grounds in the prompt", () => {
    const fixture = seedCase();
    seedJudgment(fixture);

    // Assembled the same way the hearing assembles it — confirmed material only.
    const prompt = renderAppealPrompt(
      assembleJudgmentDossier(db, fixture.caseId),
      {
        grounds: GROUNDS,
        previousVersion: 1,
        previousFactLayer: factLayerV1(fixture),
        appellant: { pseudonym: "乙", isSubmitter: true },
      },
    );

    // The evidence, verbatim.
    expect(prompt).toContain("这件事今天必须说清楚");
    // What is being appealed…
    expect(prompt).toContain("The judgment under appeal (version 1 — frozen)");
    expect(prompt).toContain("c3");
    // …and the grounds, in the client's own words, labelled as an assertion.
    expect(prompt).toContain(GROUNDS);
    expect(prompt).toContain("It confirms nothing and cannot be cited.");
    expect(prompt).toContain("乙, who brought this case");
    // The level arrives as an instruction, generated from the level table.
    expect(prompt).toContain("Working inside L2");
    expect(prompt).toContain("findings.responsibility MUST be an empty list");
  });

  it("says whose grounds these are, by pseudonym, when she is the appellant", () => {
    const fixture = seedCase();
    seedJudgment(fixture);

    const prompt = renderAppealPrompt(
      assembleJudgmentDossier(db, fixture.caseId),
      {
        grounds: "这份判决把我说成拖延的人，我那天等到十一点。",
        previousVersion: 1,
        previousFactLayer: factLayerV1(fixture),
        appellant: { pseudonym: "甲", isSubmitter: false },
      },
    );

    expect(prompt).toContain("甲, the party this case is about, who did not bring it");
    // The pseudonym, never a name (HARD RULE #3), and never "the client".
    expect(prompt).not.toContain("乙, who brought this case");
  });
});

/* -------------------------------------------------------------------------- */
/* Filing — one appeal per version                                            */
/* -------------------------------------------------------------------------- */

describe("filing an appeal", () => {
  it("records the grounds verbatim and what the record held at the time", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);

    const appeal = fileAppeal(db, judgmentId, { grounds: GROUNDS, actorParticipantId: fixture.client });

    expect(appeal.originalJudgmentId).toBe(judgmentId);
    expect(appeal.status).toBe("submitted");
    expect(appeal.newJudgmentId).toBeNull();
    // Verbatim, untranslated, unnormalized — it is the appellant's statement.
    expect(appeal.grounds).toBe(GROUNDS);
    expect(appeal.record?.citable_at_original).toBe(2);
    expect(readAppealForJudgment(db, judgmentId)?.id).toBe(appeal.id);
  });

  it("refuses a second appeal by the same party against the same version", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);

    fileAppeal(db, judgmentId, {
      grounds: GROUNDS,
      actorParticipantId: fixture.client,
    });

    let thrown: unknown;
    try {
      fileAppeal(db, judgmentId, {
        grounds: "再看一次。",
        actorParticipantId: fixture.client,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppealError);
    expect((thrown as AppealError).code).toBe("already_appealed");
    expect((thrown as AppealError).message).toMatch(
      /One appeal per version per party/,
    );

    // And exactly one row exists: the refusal is not a warning.
    expect(db.select().from(appeals).all()).toHaveLength(1);
  });

  it("refuses an appeal with no grounds, and one against a draft", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);

    expect(() => fileAppeal(db, judgmentId, { grounds: "   ", actorParticipantId: fixture.client })).toThrowError(
      /grounds/i,
    );

    const other = seedCase();
    const draft = createDraft(db, other.caseId, {
      model: MODEL_FABLE,
      factLayer: factLayerV1(other),
    });
    expect(() =>
      fileAppeal(db, draft.id, {
        grounds: GROUNDS,
        actorParticipantId: fixture.client,
      }),
    ).toThrowError(/draft/);
  });
});

/* -------------------------------------------------------------------------- */
/* SPEC M5 ⑤ — the appeal has an actor, and the rule is per actor             */
/* -------------------------------------------------------------------------- */

describe("who is appealing", () => {
  it("lets her appeal the same version his appeal is already filed against", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);

    const his = fileAppeal(db, judgmentId, {
      grounds: GROUNDS,
      actorParticipantId: fixture.client,
    });
    // The line M4's shareable copy already promised her. His filing is not an
    // answer to it, and it must not be a lock on it either.
    const hers = fileAppeal(db, judgmentId, {
      grounds: "判决里说的是我，但没有一句我说的话是我自己交上来的。",
      actorParticipantId: fixture.counterparty,
    });

    expect(hers.id).not.toBe(his.id);
    expect(hers.originalJudgmentId).toBe(judgmentId);
    expect(his.actorParticipantId).toBe(fixture.client);
    expect(hers.actorParticipantId).toBe(fixture.counterparty);
    // Two rows against one version, one per party, both `submitted`.
    expect(db.select().from(appeals).all()).toHaveLength(2);
    const filed = listAppealsForJudgment(db, judgmentId);
    expect(filed).toHaveLength(2);
    expect(new Set(filed.map((appeal) => appeal.id))).toEqual(
      new Set([his.id, hers.id]),
    );
    expect(filed.every((appeal) => appeal.status === "submitted")).toBe(true);
    expect(readAppealByActor(db, judgmentId, fixture.counterparty)?.id).toBe(
      hers.id,
    );
  });

  it("still spends her one appeal: a second filing of hers is refused", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);

    fileAppeal(db, judgmentId, {
      grounds: "第一次。",
      actorParticipantId: fixture.counterparty,
    });

    let thrown: unknown;
    try {
      fileAppeal(db, judgmentId, {
        grounds: "再看一次。",
        actorParticipantId: fixture.counterparty,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppealError).code).toBe("already_appealed");
    // Her pseudonym, not her name, and not "the client".
    expect((thrown as AppealError).message).toContain("甲 has already appealed");
    expect(db.select().from(appeals).all()).toHaveLength(1);
  });

  it("is enforced by the database, not only by the check above it", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const caseId = fixture.caseId;

    fileAppeal(db, judgmentId, {
      grounds: GROUNDS,
      actorParticipantId: fixture.client,
    });

    // Straight past the service layer, the way a second code path or a racing
    // request would arrive. The unique index is what makes the rule true.
    expect(() =>
      db
        .insert(appeals)
        .values({
          caseId,
          originalJudgmentId: judgmentId,
          actorParticipantId: fixture.client,
          reason: "绕过去再来一次。",
          status: "submitted",
        })
        .run(),
    ).toThrowError(/UNIQUE/i);

    // …and it is scoped to the actor: hers goes in beside his.
    expect(() =>
      db
        .insert(appeals)
        .values({
          caseId,
          originalJudgmentId: judgmentId,
          actorParticipantId: fixture.counterparty,
          reason: "我也不同意。",
          status: "submitted",
        })
        .run(),
    ).not.toThrow();
  });

  it("refuses somebody who is not a party to the case", () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const stranger = seedCase();

    let thrown: unknown;
    try {
      fileAppeal(db, judgmentId, {
        grounds: "我也想说两句。",
        actorParticipantId: stranger.counterparty,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppealError);
    expect((thrown as AppealError).code).toBe("actor_not_on_case");
    expect(db.select().from(appeals).all()).toHaveLength(0);
  });

  it("hears her appeal at L1 and issues v2 with a two-way finding", async () => {
    // The whole M5 payoff in one path (SPEC M5 ⑤ + ⑥): she is a party, she
    // files against the version that named her, and the re-hearing runs at the
    // level the case is now locked at — where a responsibility finding
    // addressed to both of them is permitted, and was rejected at L2.
    const fixture = seedCase("L1");
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);

    const twoWay: FactLayer = (() => {
      const base = factLayerV2(fixture, confirmed);
      return {
        ...base,
        claims: [
          ...base.claims,
          {
            claim_id: "c5",
            statement: "甲 says she waited until eleven: “我那天等到十一点，他一句话都没回。”",
            evidence_refs: [fixture.counterpartyOwned!],
            confidence: 0.8,
            tier: "high_confidence",
          },
        ],
        findings: {
          ...base.findings,
          // Four lines now — the fourth is hers, submitted by her, and it is
          // what moved this case to L1 in the first place.
          record_basis: {
            ...base.findings.record_basis,
            citable_utterances: { total: 4, by_client: 1, by_counterparty: 3 },
            statement:
              "Four lines: three of 甲's — one of them submitted by her — and " +
              "one of 乙's, confirmed after the first hearing.",
          },
          responsibility: [
            { party: "甲", allocation: "shared", claim_ids: ["c1", "c5"] },
            { party: "乙", allocation: "contributing", claim_ids: ["c4"] },
          ],
        },
      };
    })();

    const hers = fileAppeal(db, judgmentId, {
      grounds: "判决里说的是我，但没有一句我说的话是我自己交上来的。",
      actorParticipantId: fixture.counterparty,
    });

    const { client } = mockClient((step) =>
      step === "rehearing"
        ? twoWay
        : surfaceLayer("Three lines now, one of them 乙's.", ["c1", "c4"]),
    );
    const outcome = await hearAppeal(db, hers.id, { llm: { db, client } });

    expect(outcome.kind).toBe("reheard");
    if (outcome.kind !== "reheard") throw new Error("unreachable");
    expect(outcome.judgment.version).toBe(2);
    expect(outcome.judgment.outputLevel).toBe("L1");
    expect(outcome.judgment.factLayer.findings.responsibility).toEqual([
      { party: "甲", allocation: "shared", claim_ids: ["c1", "c5"] },
      { party: "乙", allocation: "contributing", claim_ids: ["c4"] },
    ]);
    // Qualitative, and no number anywhere near it.
    expect(
      findNumericResponsibilitySplits(outcome.judgment.factLayer),
    ).toHaveLength(0);
    // v1 is frozen and still says what it said, at the level it was written at.
    const previous = readJudgment(db, judgmentId)!;
    expect(previous.status).toBe("final");
    expect(previous.factLayer.findings.responsibility).toEqual([]);
    expect(outcome.diff.allocationChanges.length).toBeGreaterThan(0);
  });

  it("hears her appeal at L2 and issues v2 through the same frozen chain", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);

    const hers = fileAppeal(db, judgmentId, {
      grounds: "判决里说的是我，但没有一句我说的话是我自己交上来的。",
      actorParticipantId: fixture.counterparty,
    });

    const { client, calls } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Three lines now, one of them 乙's.", ["c1", "c4"]),
    );
    const outcome = await hearAppeal(db, hers.id, { llm: { db, client } });

    expect(outcome.kind).toBe("reheard");
    if (outcome.kind !== "reheard") throw new Error("unreachable");
    expect(outcome.judgment.version).toBe(2);
    expect(outcome.judgment.supersedesJudgmentId).toBe(judgmentId);
    // The predecessor is untouched, and her grounds were labelled as hers.
    expect(readJudgment(db, judgmentId)?.status).toBe("final");
    const rehearing = calls.find((call) => call.step === "rehearing")!;
    expect(rehearing.prompt).toContain(
      "甲, the party this case is about, who did not bring it",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The hearing                                                                */
/* -------------------------------------------------------------------------- */

describe("hearing an appeal", () => {
  it("issues version 2 through the frozen chain and surfaces the diff", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);

    const beforeBytes = JSON.stringify(rawJudgment(judgmentId));
    const { client, calls } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Three lines now, one of them 乙's.", ["c1", "c4"]),
    );

    const outcome = await appealJudgment(
      db,
      judgmentId,
      { grounds: GROUNDS, actorParticipantId: fixture.client },
      { llm: { db, client } },
    );

    expect(outcome.kind).toBe("reheard");
    if (outcome.kind !== "reheard") return;

    // ① Version 2, through the existing chain, pointing at what it replaced.
    expect(outcome.judgment.version).toBe(2);
    expect(outcome.judgment.status).toBe("final");
    expect(outcome.judgment.supersedesJudgmentId).toBe(judgmentId);
    expect(outcome.judgment.effort).toBe("max");
    expect(outcome.judgment.promptVersion).toBe("appeal_rehearing.v1");
    expect(readJudgmentChain(db, fixture.caseId).map((j) => j.version)).toEqual([
      1, 2,
    ]);

    // ② The frozen predecessor did not move. Byte-identical row.
    expect(JSON.stringify(rawJudgment(judgmentId))).toBe(beforeBytes);

    // ③ The diff HARD RULE #6 asks for: added, removed, retiered — plus who
    //    served it and whether the fallback did.
    expect(outcome.diff.claimsAdded.map((c) => c.claimId)).toEqual(["c4"]);
    expect(outcome.diff.claimsRemoved.map((c) => c.claimId)).toEqual(["c3"]);
    expect(outcome.diff.claimsRetiered).toEqual([
      expect.objectContaining({
        claimId: "c2",
        before: "inferred",
        after: "unknown",
      }),
    ]);
    expect(outcome.diff.after.model).toBe(MODEL_FABLE);
    expect(outcome.diff.after.fallbackUsed).toBe(false);
    expect(outcome.diff.identical).toBe(false);
    expect(outcome.diff.disclosure).toMatch(/has not been altered/);

    // ④ The material that arrived between the two hearings, as a number.
    expect(outcome.material).toEqual({
      citableAtOriginal: 2,
      citableNow: 3,
      newlyCitable: 1,
    });

    // ⑤ The appeal row closes onto the version it produced.
    const appeal = readAppeal(db, outcome.appealId);
    expect(appeal?.status).toBe("resolved");
    expect(appeal?.newJudgmentId).toBe(outcome.judgment.id);

    // ⑥ The re-hearing actually saw the appeal and the new line.
    const rehearing = calls.find((call) => call.step === "rehearing");
    expect(rehearing?.prompt).toContain(GROUNDS);
    expect(rehearing?.prompt).toContain("我当时在加班");

    expect(describeAppealDiff(outcome.diff)).toContain("inferred → unknown");
  });

  it("refuses a second appeal after the version has been re-heard", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);
    const { client } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Three lines now.", ["c1", "c4"]),
    );

    const first = await appealJudgment(
      db,
      judgmentId,
      { grounds: GROUNDS, actorParticipantId: fixture.client },
      { llm: { db, client } },
    );
    expect(first.kind).toBe("reheard");

    // The same version, a second time: refused before any model call.
    await expect(
      appealJudgment(db, judgmentId, { grounds: "还是不对。", actorParticipantId: fixture.client }, { llm: { db, client } }),
    ).rejects.toThrowError(AppealError);

    // No third version was opened.
    expect(readJudgmentChain(db, fixture.caseId)).toHaveLength(2);
    expect(db.select().from(appeals).all()).toHaveLength(1);

    // The rule is per VERSION, not per case: the version the appeal produced can
    // itself be appealed, which is the consequence of stating it that way.
    const v2 = readJudgmentChain(db, fixture.caseId)[1];
    expect(() => fileAppeal(db, v2.id, { grounds: "第二版也不对。", actorParticipantId: fixture.client })).not.toThrow();
  });

  it("refuses to appeal a version that has already been replaced", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);
    const { client } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Three lines now.", ["c1", "c4"]),
    );

    await appealJudgment(db, judgmentId, { grounds: GROUNDS, actorParticipantId: fixture.client }, { llm: { db, client } });

    // Delete the appeal row so the "already appealed" guard cannot be what
    // refuses this — what must refuse it is that v1 no longer stands.
    db.delete(appeals).where(eq(appeals.originalJudgmentId, judgmentId)).run();

    let thrown: unknown;
    try {
      fileAppeal(db, judgmentId, { grounds: "再来一次。", actorParticipantId: fixture.client });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppealError).code).toBe("not_current");
  });

  /**
   * The re-hearing restates the record basis of the FIRST hearing, after a line
   * was confirmed in between. That is a fact layer describing a record that no
   * longer exists, and it is rejected against the database — which is also how
   * this test proves the newly confirmed line reached the hearing at all.
   */
  it("rejects a re-hearing that restates the old record, and does not burn the appeal", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    confirmClientLine(fixture);

    const { client, calls } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV1(fixture)
        : surfaceLayer("unchanged", ["c1", "c2"]),
    );

    const outcome = await appealJudgment(
      db,
      judgmentId,
      { grounds: GROUNDS, actorParticipantId: fixture.client },
      { llm: { db, client } },
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.step).toBe("rehearing");
    expect(outcome.rejection.code).toBe("record_basis_mismatch");
    expect(outcome.rejection.message).toContain("citable_utterances.total");

    // One retry with the fault named, then refused. No version was opened.
    expect(calls.filter((call) => call.step === "rehearing")).toHaveLength(2);
    expect(calls[1].prompt).toContain("rejected by the server");
    expect(readJudgmentChain(db, fixture.caseId)).toHaveLength(1);

    // The appeal was NOT consumed: nothing was produced, so it is still the
    // client's to have heard. It goes back to `submitted` and can be re-run.
    const appeal = readAppeal(db, outcome.appealId);
    expect(appeal?.status).toBe("submitted");
    expect(appeal?.newJudgmentId).toBeNull();
  });

  it("hears a filed appeal on a second attempt after a transport failure", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);
    const appeal = fileAppeal(db, judgmentId, { grounds: GROUNDS, actorParticipantId: fixture.client });

    const failing = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
      beta: {
        messages: {
          create: vi.fn(async () => {
            throw new Error("connection reset");
          }),
        },
      },
    } as unknown as Anthropic;

    const first = await hearAppeal(db, appeal.id, { llm: { db, client: failing } });
    expect(first.kind).toBe("error");
    expect(readAppeal(db, appeal.id)?.status).toBe("submitted");

    const { client } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Second attempt.", ["c1", "c4"]),
    );
    const second = await hearAppeal(db, appeal.id, { llm: { db, client } });

    expect(second.kind).toBe("reheard");
    if (second.kind !== "reheard") return;
    expect(second.judgment.version).toBe(2);
    expect(readAppeal(db, appeal.id)?.newJudgmentId).toBe(second.judgment.id);
  });

  /**
   * The nastiest of the retry cases: the skeleton landed as a draft version 2
   * and the narrative call died. The chain does not fork, so a second hearing
   * has to continue that draft rather than open another — otherwise one dropped
   * connection makes the appeal permanently unhearable.
   */
  it("continues the draft it already opened when the narrative call died", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);
    const appeal = fileAppeal(db, judgmentId, { grounds: GROUNDS, actorParticipantId: fixture.client });

    // The re-hearing streams (its budget is over the SDK's non-streaming
    // ceiling) and the narrative does not, so this double answers on both and
    // fails the narrative whichever transport asks for it.
    const halfwayCreate = vi.fn(async (params: unknown) => {
            if (stepOf(params) === "narrative") throw new Error("connection reset");
            return {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: MODEL_FABLE,
              stop_reason: "end_turn",
              stop_details: null,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(factLayerV2(fixture, confirmed)),
                },
              ],
              usage: {
                input_tokens: 5000,
                output_tokens: 1200,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                iterations: null,
              },
              _request_id: "req_test",
            };
    });
    const halfwayStream = (params: unknown) => ({
      finalMessage: () => halfwayCreate(params),
    });
    const halfway = {
      messages: { create: halfwayCreate, stream: halfwayStream },
      beta: { messages: { create: halfwayCreate, stream: halfwayStream } },
    } as unknown as Anthropic;

    const first = await hearAppeal(db, appeal.id, { llm: { db, client: halfway } });
    expect(first.kind).toBe("error");

    // A draft version 2 is on the chain, and it is not the judgment that stands.
    const chain = readJudgmentChain(db, fixture.caseId);
    expect(chain).toHaveLength(2);
    expect(chain[1].status).toBe("draft");

    const { client } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Heard again after the line dropped.", ["c1", "c4"]),
    );
    const second = await hearAppeal(db, appeal.id, { llm: { db, client } });

    expect(second.kind).toBe("reheard");
    if (second.kind !== "reheard") return;
    expect(second.judgment.id).toBe(chain[1].id);
    expect(second.judgment.version).toBe(2);
    expect(second.judgment.status).toBe("final");
    // Still two versions: the draft was continued, not duplicated.
    expect(readJudgmentChain(db, fixture.caseId)).toHaveLength(2);
    expect(readAppeal(db, appeal.id)?.status).toBe("resolved");
  });

  it("will not hear one appeal twice", async () => {
    const fixture = seedCase();
    const judgmentId = seedJudgment(fixture);
    const confirmed = confirmClientLine(fixture);
    const { client } = mockClient((step) =>
      step === "rehearing"
        ? factLayerV2(fixture, confirmed)
        : surfaceLayer("Three lines now.", ["c1", "c4"]),
    );

    const outcome = await appealJudgment(
      db,
      judgmentId,
      { grounds: GROUNDS, actorParticipantId: fixture.client },
      { llm: { db, client } },
    );
    expect(outcome.kind).toBe("reheard");

    const again = await hearAppeal(db, outcome.appealId, { llm: { db, client } });
    expect(again.kind).toBe("blocked");
    if (again.kind !== "blocked") return;
    expect(again.message).toMatch(/already heard/);
    expect(db.select().from(judgments).all()).toHaveLength(2);
  });
});
