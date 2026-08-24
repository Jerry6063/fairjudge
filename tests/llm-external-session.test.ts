/**
 * The external-session runtime (doc 05 §B) — `src/server/llm/external.ts`.
 *
 * The second runtime replaces the socket with the model already driving the
 * surrounding session. The whole risk of that change is that the checks which
 * live *around* the API call quietly stop applying, because the thing they were
 * guarding is now a file somebody hands to a model by hand. So this file is
 * mostly one question asked in several ways: does an answer arriving through the
 * side door face the same doors as one arriving through the front?
 *
 * The test that matters most is `rejects an output citing an unconfirmed
 * utterance`. HARD RULE #1 says unconfirmed material is not citable and that an
 * invalid reference rejects the generation. On the API path that is enforced by
 * `judgment/generation.ts` around `runStage`. If ingest merely `zod.parse`d and
 * wrote the row, this channel would be a way to launder a pending line into a
 * judgment — and it would look exactly like a working feature.
 *
 * Evidence content is Chinese and stays Chinese (CLAUDE.md): it is a verbatim
 * record, and a fixture that translated it would misrepresent what the pipeline
 * reads. No model is called anywhere in this file — there is nothing to mock,
 * because prepare and ingest never open a socket.
 */

import type Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  adverseFacts,
  caseParticipants,
  cases,
  clarificationRounds,
  egressLedger,
  issues,
  llmCalls,
  steelmanVersions,
  utterances,
} from "../src/server/db/schema";
import {
  assembleJudgmentDossier,
  checkFactLayer,
  checkSurfaceLayer,
  renderLevelTask,
  renderNarrativePrompt,
  serializeJudgmentDossier,
  type FactLayer,
  type JudgmentDossier,
  type SurfaceLayer,
} from "../src/server/judgment";
import {
  EXTERNAL_BUNDLE_FORMAT,
  EXTERNAL_SESSION,
  ingestStage,
  prepareStage,
} from "../src/server/llm/external";
import {
  judgmentNarrativeStage,
  judgmentSkeletonStage,
} from "../src/server/llm/stages";
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
/* Fixture — one confirmed line each side, and pending lines that are not      */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  /** Confirmed, therefore citable. */
  readonly citable: readonly string[];
  /** On file, `confirm_status = pending`, therefore invisible and uncitable. */
  readonly pending: readonly string[];
}

function seedCase(): Fixture {
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
  const caseId = row.id;

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId,
        role: "initiator" as const,
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating" as const,
      },
      {
        caseId,
        role: "respondent" as const,
        pseudonym: "甲",
        isSubmitter: false,
        participationState: "unreachable" as const,
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
      ["我当时在加班", "我不是不在乎"].map((text) => ({
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
      answers: [],
    })
    .run();

  return { caseId, citable, pending };
}

/* -------------------------------------------------------------------------- */
/* The same inputs the API path assembles                                     */
/* -------------------------------------------------------------------------- */

const SKELETON_TASK =
  "Produce the fact layer for this case: the claims this judgment will rest " +
  "on, and the case-level findings.";

function skeletonInput(caseId: string, dossier: JudgmentDossier) {
  return {
    prompt:
      `${serializeJudgmentDossier(dossier)}\n\n${SKELETON_TASK}\n\n` +
      `${renderLevelTask(dossier.outputLevel)}`,
    caseId,
  };
}

/** A well-formed L2 fact layer over the fixture: no allocation, one unknown. */
function factLayer(fixture: Fixture, refs?: readonly string[]): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: '甲 set a same-day deadline: "这件事今天必须说清楚".',
        evidence_refs: refs ? [...refs] : [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          "What 乙 said in reply is not in the confirmed record; none of 乙's " +
          "own utterances have been confirmed.",
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
          "This judgment could read two lines, both 甲's. Not one line 乙 " +
          "spoke is confirmed, so nothing here rests on 乙's own account.",
      },
      unresolved: [
        {
          question: "What did 乙 say back after 甲's second message?",
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
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
        section_id: "s1",
        kind: "finding",
        heading: "What the record could be read from",
        text:
          "This judgment could read two lines, both 甲's. 乙 has no confirmed " +
          "line in this record.",
        claim_ids: ["c1"],
        audience: "both",
      },
      {
        section_id: "s2",
        kind: "limits",
        heading: "What this cannot decide",
        text: "With one side's words absent, no allocation is made here.",
        claim_ids: [],
        audience: "both",
      },
    ],
  };
}

function openEgressRows(caseId: string | null) {
  return db
    .select()
    .from(egressLedger)
    .where(
      caseId === null
        ? and(
            eq(egressLedger.target, EXTERNAL_SESSION),
            isNull(egressLedger.llmCallId),
          )
        : and(
            eq(egressLedger.caseId, caseId),
            isNull(egressLedger.llmCallId),
          ),
    )
    .all();
}

/* -------------------------------------------------------------------------- */
/* prepareStage                                                               */
/* -------------------------------------------------------------------------- */

describe("prepareStage", () => {
  it("assembles a translate bundle without calling anything", () => {
    const dict: PersonDict = [{ canonical: "小明", pseudonym: "甲", variants: [] }];
    const outcome = prepareStage(
      "translate_default",
      { prompt: "小明 said 随便你, and my number is 13800138000.", dict },
      { db },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    expect(outcome.bundle.format).toBe(EXTERNAL_BUNDLE_FORMAT);
    expect(outcome.bundle.stage).toBe("translate_default");
    expect(outcome.bundle.prompt_version).toBe("translate.v3");
    // HARD RULE #3 applies to this channel identically: the bundle that is about
    // to be written to a file carries the pseudonym and the placeholder, never
    // the name or the number.
    expect(outcome.bundle.user).toContain("甲");
    expect(outcome.bundle.user).not.toContain("小明");
    expect(outcome.bundle.user).not.toContain("13800138000");
    expect(outcome.bundle.user).toContain("{{PHONE_1}}");
    // The response contract travels with it.
    expect(outcome.bundle.output_schema).toMatchObject({ type: "object" });
    expect(outcome.bundle.messages.at(-1)?.content).toBe(outcome.bundle.user);
  });

  it("records the egress at emission, before the bundle is handed out", () => {
    const outcome = prepareStage("translate_default", { prompt: "他说随便你" }, { db });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const rows = db.select().from(egressLedger).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(outcome.egressId);
    expect(rows[0].target).toBe(EXTERNAL_SESSION);
    // No call yet — and there may never be one. That is the state this row
    // exists to record.
    expect(rows[0].llmCallId).toBeNull();
    expect(rows[0].model).toBeNull();
    // Nothing claims a usage record until an answer comes back.
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("writes no ledger row for a bundle it refuses to assemble", () => {
    // Assistant prefill: refused by the shared assembly step, so this is a
    // request that was never made rather than one that failed. A ledger row
    // here would invent an egress — the same rule `claude.ts` applies to a
    // request the SDK declined to dispatch.
    const outcome = prepareStage(
      "translate_default",
      { messages: [{ role: "assistant", text: "Here is the answer:" }] },
      { db },
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("last message must be a user turn");
    expect(db.select().from(egressLedger).all()).toHaveLength(0);
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("carries the judgment dossier's ids in the manifest", () => {
    const fixture = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const outcome = prepareStage(
      judgmentSkeletonStage,
      skeletonInput(fixture.caseId, dossier),
      { db },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    for (const id of fixture.citable) {
      expect(outcome.bundle.manifest.ids).toContain(id);
    }
    // The pending lines were never in the bytes, so they are not in the answer
    // to "what did this agent see".
    for (const id of fixture.pending) {
      expect(outcome.bundle.manifest.ids).not.toContain(id);
    }
    expect(outcome.bundle.manifest_hash).toHaveLength(64);
  });
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                 */
/* -------------------------------------------------------------------------- */

describe("prepare → ingest round trip", () => {
  it("accepts a hand-written valid translate output and records the call", () => {
    const input = { prompt: "他说 随便你 而已" };
    const prepared = prepareStage("translate_default", input, { db });
    expect(prepared.kind).toBe("ok");
    if (prepared.kind !== "ok") return;

    const candidate = {
      benign: { reading: "He is worn out today", confidence: 0.4 },
      neutral: { reading: "He is deferring the choice", confidence: 0.4 },
      negative: { reading: "He is withdrawing from the decision", confidence: 0.3 },
      cues: ['"随便你" — literally "up to you", but here it withdraws'],
    };

    const result = ingestStage("translate_default", input, candidate, { db });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.negative.reading).toContain("withdrawing");
    expect(result.manifestHash).toBe(prepared.bundle.manifest_hash);

    // One usage row, recorded as this channel and priced at nothing knowable.
    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe(EXTERNAL_SESSION);
    expect(calls[0].model).toBe(EXTERNAL_SESSION);
    expect(calls[0].costUsd).toBeNull();
    expect(calls[0].inputTokens).toBeNull();
    expect(calls[0].outputTokens).toBeNull();
    expect(calls[0].stage).toBe("translate_default");
    expect(calls[0].inputManifestSha256).toBe(prepared.bundle.manifest_hash);

    // One egress row for one emission — the prepare-time row, now linked.
    const egress = db.select().from(egressLedger).all();
    expect(egress).toHaveLength(1);
    expect(egress[0].id).toBe(prepared.egressId);
    expect(egress[0].llmCallId).toBe(calls[0].id);
  });

  it("round-trips the judgment skeleton with its caller's own checks", () => {
    const fixture = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, dossier);

    expect(prepareStage(judgmentSkeletonStage, input, { db }).kind).toBe("ok");

    const result = ingestStage(judgmentSkeletonStage, input, factLayer(fixture), {
      db,
      check: (data) => {
        const rejection = checkFactLayer(
          db,
          fixture.caseId,
          dossier.outputLevel,
          dossier,
          data,
        );
        return rejection === null
          ? { ok: true }
          : { ok: false, message: rejection.message };
      },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // `keepPseudonyms` holds on this channel too: the stored artifact stays
    // keyed by pseudonym rather than having the mapping table unwound into it.
    expect(result.data.claims[0].statement).toContain("甲");
    expect(db.select().from(llmCalls).all()).toHaveLength(1);
  });

  it("round-trips the judgment narrative against its frozen skeleton", () => {
    const fixture = seedCase();
    const frozen = factLayer(fixture);
    const input = { prompt: renderNarrativePrompt("L2", frozen), caseId: fixture.caseId };

    expect(prepareStage(judgmentNarrativeStage, input, { db }).kind).toBe("ok");

    const result = ingestStage(judgmentNarrativeStage, input, surfaceLayer(), {
      db,
      check: (data) => {
        const rejection = checkSurfaceLayer(frozen, data);
        return rejection === null
          ? { ok: true }
          : { ok: false, message: rejection.message };
      },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.sections).toHaveLength(2);
  });

  it("accepts a candidate handed in as file text rather than parsed JSON", () => {
    const input = { prompt: "他说 随便你" };
    prepareStage("translate_default", input, { db });

    const text = JSON.stringify({
      benign: { reading: "a", confidence: 0.3 },
      neutral: { reading: "b", confidence: 0.3 },
      negative: { reading: "c", confidence: 0.3 },
      cues: [],
    });
    expect(ingestStage("translate_default", input, text, { db }).kind).toBe("ok");
  });
});

/* -------------------------------------------------------------------------- */
/* The doors                                                                  */
/* -------------------------------------------------------------------------- */

describe("ingestStage refuses what the API path would refuse", () => {
  it("rejects an output citing an unconfirmed utterance (HARD RULE #1)", () => {
    const fixture = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, dossier);

    const prepared = prepareStage(judgmentSkeletonStage, input, { db });
    expect(prepared.kind).toBe("ok");

    // The one thing this channel must not become: a way in for a line a human
    // has not signed off. The id is real and belongs to this case — it is
    // simply `pending`, which under HARD RULE #1 means it does not exist as far
    // as anything downstream is concerned.
    const laundered = factLayer(fixture, [fixture.pending[0]]);

    const result = ingestStage(judgmentSkeletonStage, input, laundered, { db });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.code).toBe("invalid_refs");
    expect(result.message).toContain("has not been confirmed");
    expect(result.message).toContain(fixture.pending[0]);

    // Nothing was persisted, and the emission stays open so a corrected answer
    // can still be ingested against the same bundle.
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
    expect(openEgressRows(fixture.caseId)).toHaveLength(1);
  });

  it("rejects a citation to an utterance from another case", () => {
    const fixture = seedCase();
    const other = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, dossier);
    prepareStage(judgmentSkeletonStage, input, { db });

    const result = ingestStage(
      judgmentSkeletonStage,
      input,
      factLayer(fixture, [other.citable[0]]),
      { db },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.code).toBe("invalid_refs");
    expect(result.message).toContain("different case");
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("rejects a citation that was invented outright", () => {
    const fixture = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, dossier);
    prepareStage(judgmentSkeletonStage, input, { db });

    const result = ingestStage(
      judgmentSkeletonStage,
      input,
      factLayer(fixture, ["11111111-2222-4333-8444-555555555555"]),
      { db },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.code).toBe("invalid_refs");
  });

  it("rejects a candidate that does not match the stage's schema", () => {
    const input = { prompt: "他说随便你" };
    prepareStage("translate_default", input, { db });

    const result = ingestStage("translate_default", input, { benign: "nope" }, { db });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.code).toBe("schema");
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("rejects what the stage's own caller-side check rejects", () => {
    const fixture = seedCase();
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, dossier);
    prepareStage(judgmentSkeletonStage, input, { db });

    // HARD RULE #2: at L2 a responsibility finding is rejected, not trimmed.
    const overreaching = factLayer(fixture);
    const withAllocation: FactLayer = {
      ...overreaching,
      findings: {
        ...overreaching.findings,
        responsibility: [
          { party: "甲", allocation: "primary", claim_ids: ["c1"] },
        ],
      },
    };

    const result = ingestStage(judgmentSkeletonStage, input, withAllocation, {
      db,
      check: (data) => {
        const rejection = checkFactLayer(
          db,
          fixture.caseId,
          dossier.outputLevel,
          dossier,
          data,
        );
        return rejection === null
          ? { ok: true }
          : { ok: false, message: rejection.message };
      },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.code).toBe("downstream");
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("refuses an answer to a bundle this machine never emitted", () => {
    const input = { prompt: "他说随便你" };
    // No prepareStage call — so no egress row, so no question was ever asked.
    const result = ingestStage(
      "translate_default",
      input,
      {
        benign: { reading: "a", confidence: 0.3 },
        neutral: { reading: "b", confidence: 0.3 },
        negative: { reading: "c", confidence: 0.3 },
        cues: [],
      },
      { db },
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("no prepared bundle");
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });

  it("refuses a second ingest of the same bundle", () => {
    const input = { prompt: "他说随便你" };
    const candidate = {
      benign: { reading: "a", confidence: 0.3 },
      neutral: { reading: "b", confidence: 0.3 },
      negative: { reading: "c", confidence: 0.3 },
      cues: [],
    };
    prepareStage("translate_default", input, { db });

    expect(ingestStage("translate_default", input, candidate, { db }).kind).toBe("ok");
    // The emission is spoken for. A second answer to it would be a second call
    // recorded against one egress.
    const again = ingestStage("translate_default", input, candidate, { db });
    expect(again.kind).toBe("error");
    expect(db.select().from(llmCalls).all()).toHaveLength(1);
  });

  it("refuses when the record moved between prepare and ingest", () => {
    const fixture = seedCase();
    const before = assembleJudgmentDossier(db, fixture.caseId);
    const input = skeletonInput(fixture.caseId, before);
    prepareStage(judgmentSkeletonStage, input, { db });

    // A line is confirmed after the bundle went out. The dossier the answer was
    // written against is no longer the record.
    db.update(utterances)
      .set({ confirmStatus: "confirmed" })
      .where(eq(utterances.id, fixture.pending[0]))
      .run();

    const after = assembleJudgmentDossier(db, fixture.caseId);
    const result = ingestStage(
      judgmentSkeletonStage,
      skeletonInput(fixture.caseId, after),
      factLayer(fixture),
      { db },
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("changed since");
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
  });
});
