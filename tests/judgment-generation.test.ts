/**
 * Judgment generation and gated publication (SPEC M3 wave B ⑦ / ⑧).
 *
 * The fixture is the real case's shape, because the real case is what forced
 * this design (SPEC M3 decision record, 2026-08-09): the counterparty 甲 has two
 * confirmed lines, the client 乙 has five that are all still
 * `confirm_status = pending`, and under HARD RULE #1 that means the client has
 * never spoken inside the record. Every issue item and every adverse fact
 * therefore cites one of the same two lines, both of them 甲's.
 *
 * Four failures are what this file exists to catch, and none of them would be
 * visible to a reader of the finished document:
 *
 *   1. **A narrative that out-runs its skeleton.** A section resting on a
 *      claim_id the fact layer never defined is an assertion nothing was
 *      checked for, printed in the same typeface as the ones that were.
 *   2. **A responsibility split at a level that forbids one.** L2 means one
 *      side was heard; allocating responsibility between two people when one of
 *      them has not spoken is the failure the level exists to prevent, and the
 *      constraint has to bind in code — a rule that lives only in prompt text
 *      is a request.
 *   3. **A citation that does not hold** (HARD RULE #1), and a judgment that
 *      **understates the size of its own evidentiary hole**. The record's
 *      asymmetry is arithmetic read out of SQLite, not a sentence handed to the
 *      model, so a restatement that disagrees with the database is rejected.
 *   4. **Body text reaching the user before it was validated.** Everything the
 *      model writes is buffered, persisted as a draft and checked before
 *      anything is published; the progress channel carries phases, summarized
 *      thinking and heartbeats, and the test below reads every byte it would
 *      have emitted to prove no sentence of the judgment is among them.
 *
 * Evidence content is Chinese and stays Chinese (CLAUDE.md): it is a verbatim
 * record, and translating it in a fixture would make the fixture lie about what
 * the pipeline reads.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  adverseFacts,
  caseParticipants,
  cases,
  clarificationRounds,
  issues,
  steelmanVersions,
  utterances,
  type OutputLevel,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  judgmentNarrativeStage,
  judgmentSkeletonStage,
} from "../src/server/llm/stages";
import {
  assembleJudgmentDossier,
  checkLevelConstraints,
  computeRecordAsymmetry,
  encodeProgressEvent,
  generateJudgment,
  levelConstraints,
  readCurrentJudgment,
  readJudgment,
  renderLevelTask,
  runJudgmentNarrative,
  runJudgmentSkeleton,
  serializeJudgmentDossier,
  verifyRecordBasis,
  type FactLayer,
  type JudgmentProgressEvent,
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
/* Fixture — the real case's shape                                            */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  /** The two confirmed lines. Both spoken by the counterparty 甲. */
  readonly citable: readonly string[];
  /** The client's own lines — all `pending`, so all invisible to a stage. */
  readonly pending: readonly string[];
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

  // 甲's lines: confirmed by the client, out of screenshots the client
  // submitted. These are the only two things anything may cite.
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

  // The client's own five lines, none of them confirmed. HARD RULE #1 makes
  // them invisible: not "weighted less", absent.
  const pending = db
    .insert(utterances)
    .values(
      ["我当时在加班", "我不是不在乎", "我需要一点时间", "别这样说", "我们明天再谈"].map(
        (text) => ({
          caseId,
          speakerParticipantId: client.id,
          speakerLabel: "乙",
          aiDraft: text,
          confirmStatus: "pending" as const,
        }),
      ),
    )
    .returning()
    .all()
    .map((u) => u.id);

  db.insert(issues)
    .values([
      {
        caseId,
        category: "undisputed" as const,
        aiDraft: "甲 set a same-day deadline for resolving the argument.",
        evidenceRefs: [citable[1]],
        confirmStatus: "confirmed" as const,
      },
      {
        caseId,
        category: "standard_dispute" as const,
        aiDraft: "What counts as showing you care within a reasonable time.",
        evidenceRefs: [citable[0]],
        confirmStatus: "confirmed" as const,
      },
    ])
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

  // After `npm run purge:operator` the seeded case's answers sit at `declined`
  // — a legitimate state meaning the client never answered.
  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber: 1,
      questions: [
        { id: "q1", question: "What did you say back after 甲's second message?" },
        { id: "q2", question: "Had this deadline been discussed before that day?" },
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

  return { caseId, citable, pending };
}

/* -------------------------------------------------------------------------- */
/* Model doubles                                                              */
/* -------------------------------------------------------------------------- */

/** A well-formed L2 fact layer over the fixture: no allocation, one unknown. */
function factLayer(fixture: Fixture): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: '甲 set a same-day deadline: "这件事今天必须说清楚".',
        evidence_refs: [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          '甲 treated the delay as evidence of not caring — "你要是真在乎就不会拖到现在".',
        evidence_refs: [fixture.citable[0]],
        confidence: 0.6,
        tier: "inferred",
      },
      {
        claim_id: "c3",
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
          claim_ids: ["c3"],
        },
      ],
      responsibility: [],
    },
  };
}

/** A surface layer that stays inside the skeleton. */
function surfaceLayer(marker: string): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: `Two lines, both 甲's. ${marker}`,
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "both",
        heading: "The deadline",
        text: '甲 set a same-day deadline: "这件事今天必须说清楚".',
        claim_ids: ["c1", "c2"],
      },
      {
        section_id: "s3",
        kind: "limits",
        audience: "self_only",
        heading: "What this cannot decide",
        text: "Nothing here establishes what 乙 said in reply.",
        claim_ids: [],
      },
    ],
  };
}

/** Which of the two judgment calls a request is. Read off the system prompt. */
function stageOf(params: unknown): "skeleton" | "narrative" | "other" {
  const system = (params as { system?: unknown }).system;
  const text = typeof system === "string" ? system : JSON.stringify(system);
  if (text.includes("You are the fact-finding stage")) return "skeleton";
  if (text.includes("You are the drafting stage")) return "narrative";
  /* c8 ignore next -- no other stage runs in this file. */
  return "other";
}

interface Recorded {
  readonly stage: "skeleton" | "narrative" | "other";
  readonly prompt: string;
}

/**
 * An Anthropic double that answers each judgment call from `answer`.
 *
 * Records the user turn of every request so the tests can assert what actually
 * reached the model — the level constraints and the counted record basis are
 * supposed to be IN the prompt, and "we meant to put them there" is not an
 * assertion.
 */
function mockClient(
  answer: (stage: "skeleton" | "narrative" | "other", call: number) => unknown,
): { client: Anthropic; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const create = vi.fn(async (params: unknown) => {
    const stage = stageOf(params);
    const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
    const first = messages[0]?.content;
    calls.push({
      stage,
      prompt: typeof first === "string" ? first : JSON.stringify(first),
    });
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: JSON.stringify(answer(stage, calls.length)) }],
      usage: {
        input_tokens: 4000,
        output_tokens: 900,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: null,
      },
      _request_id: "req_test",
    };
  });

  // The gateway streams a stage whose budget exceeds the SDK's non-streaming
  // ceiling (`judgment_skeleton` is one), so the double answers on both
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

/* -------------------------------------------------------------------------- */
/* The stage descriptors                                                      */
/* -------------------------------------------------------------------------- */

describe("the two judgment stages", () => {
  it("both run fable at xhigh and declare the contract's own schemas", () => {
    expect(judgmentSkeletonStage.model).toBe(MODEL_FABLE);
    expect(judgmentSkeletonStage.effort).toBe("xhigh");
    expect(judgmentNarrativeStage.model).toBe(MODEL_FABLE);
    expect(judgmentNarrativeStage.effort).toBe("xhigh");

    // The skeleton's schema is the fact layer and the narrative's is the
    // surface layer — the shapes are imported from the contract, not restated,
    // so a change there cannot leave a stage behind.
    expect(judgmentSkeletonStage.zodSchema.safeParse(factLayer(seedCase())).success).toBe(
      true,
    );
    expect(
      judgmentNarrativeStage.zodSchema.safeParse(surfaceLayer("x")).success,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The record's asymmetry, as a fact                                          */
/* -------------------------------------------------------------------------- */

describe("the record's asymmetry is computed from the database", () => {
  it("counts who has spoken inside the confirmed record, and who has not", () => {
    const fixture = seedCase();
    const asymmetry = computeRecordAsymmetry(db, fixture.caseId);

    expect(asymmetry.citableUtterances).toEqual({
      total: 2,
      byClient: 0,
      byCounterparty: 2,
      unattributed: 0,
    });
  });

  it("names the client among the parties with no citable line", () => {
    const fixture = seedCase();
    const asymmetry = computeRecordAsymmetry(db, fixture.caseId);

    expect(asymmetry.clientPseudonym).toBe("乙");
    expect(asymmetry.partiesWithoutCitableUtterance).toEqual(["乙"]);
    expect(asymmetry.singleVoice).toBe(true);

    // The five pending lines are counted as withheld, by status — the judgment
    // cannot say how thin its record is without them.
    expect(asymmetry.uncitableUtterances.total).toBe(5);
    expect(asymmetry.uncitableUtterances.byStatus).toEqual([
      { status: "pending", count: 5 },
    ]);
  });

  it("counts which claims rest on whose words", () => {
    const fixture = seedCase();
    const asymmetry = computeRecordAsymmetry(db, fixture.caseId);

    const client = asymmetry.parties.find((p) => p.isClient)!;
    const other = asymmetry.parties.find((p) => !p.isClient)!;

    expect(client.citableUtterances).toBe(0);
    expect(client.submittedUtterances).toBe(5);
    expect(client.issueItemsRestingOnTheirWords).toBe(0);
    expect(client.adverseFactsRestingOnTheirWords).toBe(0);

    expect(other.citableUtterances).toBe(2);
    expect(other.issueItemsRestingOnTheirWords).toBe(2);
    expect(other.adverseFactsRestingOnTheirWords).toBe(1);
  });

  it("moves when the record moves — it is not a canned sentence", () => {
    const fixture = seedCase();
    db.update(utterances)
      .set({ confirmStatus: "confirmed" })
      .where(eq(utterances.id, fixture.pending[0]))
      .run();

    const asymmetry = computeRecordAsymmetry(db, fixture.caseId);
    expect(asymmetry.citableUtterances.byClient).toBe(1);
    expect(asymmetry.partiesWithoutCitableUtterance).toEqual([]);
    expect(asymmetry.singleVoice).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* What actually reaches the prompt                                           */
/* -------------------------------------------------------------------------- */

describe("the assembled prompt", () => {
  it("carries the locked level's constraints and the counted record basis", () => {
    const fixture = seedCase("L2");
    const dossier = assembleJudgmentDossier(db, fixture.caseId);
    const text = serializeJudgmentDossier(dossier);

    expect(dossier.outputLevel).toBe("L2");
    // The L2 constraint block, generated from the same table the validator
    // reads — not a sentence written twice.
    expect(text).toContain("findings.responsibility must");
    expect(text).toContain("responsibility_split_allowed");
    expect(text).toContain('"responsibility_split_allowed": false');

    // The numbers, not a disclaimer about them.
    expect(text).toContain('"by_client": 0');
    expect(text).toContain('"by_counterparty": 2');
    expect(text).toContain('"parties_without_citable_utterance"');

    // HARD RULE #1: the client's pending lines are nowhere in the bytes.
    for (const line of ["我当时在加班", "我不是不在乎", "我们明天再谈"]) {
      expect(text).not.toContain(line);
    }
    // …and the confirmed ones are, verbatim.
    expect(text).toContain("这件事今天必须说清楚");
  });

  it("serializes byte-stably — two assemblies of one record are identical", () => {
    const fixture = seedCase();
    const first = serializeJudgmentDossier(
      assembleJudgmentDossier(db, fixture.caseId),
    );
    const second = serializeJudgmentDossier(
      assembleJudgmentDossier(db, fixture.caseId),
    );
    expect(first).toBe(second);
  });

  it("hands the narrative call the skeleton and never the record", async () => {
    const fixture = seedCase();
    const { client, calls } = mockClient((stage) =>
      stage === "skeleton" ? factLayer(fixture) : surfaceLayer("ok"),
    );

    await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    const narrative = calls.find((call) => call.stage === "narrative")!;
    expect(narrative.prompt).toContain("Judgment skeleton (frozen");
    expect(narrative.prompt).toContain("c1");
    // The evidence block, the issue lists and the adverse facts are the
    // skeleton's inputs, not the narrative's. A second look at the record is
    // how a narrative acquires a claim nobody checked.
    expect(narrative.prompt).not.toContain("EVIDENCE");
    expect(narrative.prompt).not.toContain("Adverse facts about the client");
  });
});

/* -------------------------------------------------------------------------- */
/* HARD RULE #2 — the level constrains the generation, in code                */
/* -------------------------------------------------------------------------- */

describe("the output level is enforced on what comes back", () => {
  it("L2 permits no responsibility allocation at all", () => {
    const fixture = seedCase();
    const withSplit: FactLayer = {
      ...factLayer(fixture),
      findings: {
        ...factLayer(fixture).findings,
        responsibility: [{ party: "甲", allocation: "primary", claim_ids: ["c1"] }],
      },
    };

    expect(levelConstraints("L2").allowsResponsibilitySplit).toBe(false);
    const violations = checkLevelConstraints("L2", withSplit);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("responsibility_not_permitted");
    expect(violations[0].path).toBe("fact_layer.findings.responsibility");
  });

  it('rejects "not_established" too — it is still a row addressed to a party', () => {
    const fixture = seedCase();
    const base = factLayer(fixture);
    const hedged: FactLayer = {
      ...base,
      findings: {
        ...base.findings,
        responsibility: [
          { party: "甲", allocation: "not_established", claim_ids: ["c3"] },
        ],
      },
    };
    expect(checkLevelConstraints("L2", hedged)).toHaveLength(1);
  });

  it("L1 permits one — the constraint is per level, not a blanket ban", () => {
    const fixture = seedCase("L1");
    const base = factLayer(fixture);
    const allocated: FactLayer = {
      ...base,
      findings: {
        ...base.findings,
        responsibility: [
          { party: "甲", allocation: "shared", claim_ids: ["c1"] },
          { party: "乙", allocation: "contributing", claim_ids: ["c2"] },
        ],
      },
    };
    expect(levelConstraints("L1").allowsResponsibilitySplit).toBe(true);
    // A two-way finding: the thing the level exists for (SPEC M5 ⑥).
    expect(checkLevelConstraints("L1", allocated)).toHaveLength(0);
    // And the same fact layer at L2 — the difference is the level, not the
    // document. The rejection is keyed on the table entry, not on a branch.
    const atL2 = checkLevelConstraints("L2", allocated);
    expect(atL2).toHaveLength(1);
    expect(atL2[0].code).toBe("responsibility_not_permitted");
  });

  it("rejects a percentage of responsibility at every level, L1 included", () => {
    const fixture = seedCase("L1");
    const base = factLayer(fixture);
    const withPercentage: FactLayer = {
      ...base,
      claims: [
        {
          ...base.claims[0],
          statement: "甲 carries 70% of the responsibility for the escalation.",
        },
        ...base.claims.slice(1),
      ],
      findings: {
        ...base.findings,
        responsibility: [{ party: "甲", allocation: "primary", claim_ids: ["c1"] }],
      },
    };

    for (const level of ["L1", "L2", "L3"] as const) {
      const violations = checkLevelConstraints(level, withPercentage);
      const codes = violations.map((v) => v.code);
      expect(codes).toContain("numeric_responsibility_split");
      expect(violations[0].path).toBe("fact_layer.claims[0] (c1).statement");
    }

    // A ratio and the Chinese construction are the same offence.
    for (const statement of [
      "Responsibility divides 70/30 between them.",
      "甲 占七成责任，乙 占三成。",
    ]) {
      const layer: FactLayer = {
        ...base,
        claims: [{ ...base.claims[0], statement }, ...base.claims.slice(1)],
      };
      expect(
        checkLevelConstraints("L1", layer).map((v) => v.code),
      ).toContain("numeric_responsibility_split");
    }
  });

  it("does not mistake a clock time for a split of responsibility", () => {
    const fixture = seedCase("L1");
    const base = factLayer(fixture);
    const timed: FactLayer = {
      ...base,
      claims: [
        {
          ...base.claims[0],
          statement: "甲 sent the second message at 23:30, on 8/9.",
        },
        ...base.claims.slice(1),
      ],
    };
    expect(checkLevelConstraints("L1", timed)).toHaveLength(0);

    // The same shape inside a sentence about responsibility is the offence.
    const split: FactLayer = {
      ...base,
      claims: [
        {
          ...base.claims[0],
          statement: "Responsibility here runs 70/30 against 甲.",
        },
        ...base.claims.slice(1),
      ],
    };
    expect(checkLevelConstraints("L1", split).map((v) => v.code)).toContain(
      "numeric_responsibility_split",
    );
  });

  it("leaves a percentage inside a verbatim quote alone — that is evidence", () => {
    const fixture = seedCase("L1");
    const base = factLayer(fixture);
    const quoted: FactLayer = {
      ...base,
      claims: [
        {
          ...base.claims[0],
          // 甲 said it. The record keeps what she said; suppressing it to pass
          // our own check would be rewriting evidence (CLAUDE.md).
          statement: '甲 put a number on it herself: "这事你占七成责任".',
        },
        ...base.claims.slice(1),
      ],
    };
    expect(checkLevelConstraints("L1", quoted)).toHaveLength(0);
  });

  it("stops an L1 hearing that put a number on responsibility", async () => {
    const fixture = seedCase("L1");
    const base = factLayer(fixture);
    const { client } = mockClient(() => ({
      ...base,
      claims: [
        {
          ...base.claims[0],
          statement: "On this record 甲 carries about 60 percent of it.",
        },
        ...base.claims.slice(1),
      ],
      findings: {
        ...base.findings,
        responsibility: [{ party: "甲", allocation: "primary", claim_ids: ["c1"] }],
      },
    }));

    const result = await runJudgmentSkeleton(db, fixture.caseId, {
      llm: { client },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.rejection.code).toBe("level_violation");
    expect(result.rejection.message).toMatch(/numeric_responsibility_split/);
    expect(readCurrentJudgment(db, fixture.caseId)).toBeNull();
  });

  it("tells the model what its level licenses, in code-assembled words", () => {
    // The instruction is generated from the same table the validator reads, so
    // "L1 may allocate" cannot be true in the check and absent from the ask.
    const atL1 = renderLevelTask("L1");
    expect(atL1).toContain("Working inside L1");
    expect(atL1).toContain("permits a responsibility finding");
    expect(atL1).toContain("No share of responsibility may be written as a number");

    const atL2 = renderLevelTask("L2");
    expect(atL2).toContain("findings.responsibility MUST be an empty list");
    expect(atL2).toContain('An allocation of "not_established" is still a row');
  });

  it("rejects an L2 generation that allocates responsibility, and saves nothing", async () => {
    const fixture = seedCase("L2");
    const base = factLayer(fixture);
    const { client } = mockClient(() => ({
      ...base,
      findings: {
        ...base.findings,
        responsibility: [{ party: "甲", allocation: "primary", claim_ids: ["c1"] }],
      },
    }));

    const result = await runJudgmentSkeleton(db, fixture.caseId, {
      llm: { client },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.rejection.code).toBe("level_violation");
    expect(result.attempts).toBe(2);
    expect(readCurrentJudgment(db, fixture.caseId)).toBeNull();
  });

  it("stops the whole hearing rather than trimming the allocation", async () => {
    const fixture = seedCase("L2");
    const base = factLayer(fixture);
    const { client, calls } = mockClient((stage) =>
      stage === "skeleton"
        ? {
            ...base,
            findings: {
              ...base.findings,
              responsibility: [
                { party: "甲", allocation: "contributing", claim_ids: ["c2"] },
              ],
            },
          }
        : surfaceLayer("never reached"),
    );

    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.step).toBe("skeleton");
    expect(outcome.rejection.code).toBe("level_violation");
    // The narrative was never asked for, and no row was written.
    expect(calls.filter((call) => call.stage === "narrative")).toHaveLength(0);
    expect(readCurrentJudgment(db, fixture.caseId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The one-way rule — the narrative may not out-run the skeleton              */
/* -------------------------------------------------------------------------- */

describe("a narrative citing a claim the skeleton does not define", () => {
  it("is rejected server-side, by claim_id", async () => {
    const fixture = seedCase();
    const skeleton = factLayer(fixture);
    const invented: SurfaceLayer = {
      sections: [
        {
          section_id: "s1",
          kind: "finding",
          audience: "both",
          heading: "A finding nobody checked",
          text: "乙 apologized the same evening.",
          claim_ids: ["c9"],
        },
      ],
    };
    const { client } = mockClient(() => invented);

    const result = await runJudgmentNarrative(
      db,
      fixture.caseId,
      "L2",
      skeleton,
      { llm: { client } },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.rejection.code).toBe("contract_violation");
    expect(result.rejection.contract?.map((v) => v.code)).toContain(
      "unknown_claim_id",
    );
    expect(result.rejection.message).toContain("c9");
  });

  it("fails the whole hearing, leaving the draft unpublished", async () => {
    const fixture = seedCase();
    const { client } = mockClient((stage) =>
      stage === "skeleton"
        ? factLayer(fixture)
        : {
            sections: [
              {
                section_id: "s1",
                kind: "finding",
                audience: "both",
                heading: "Out-running the skeleton",
                text: "乙 had already explained the delay.",
                claim_ids: ["c1", "c42"],
              },
            ],
          },
    );

    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.step).toBe("narrative");
    expect(outcome.rejection.code).toBe("contract_violation");

    // Nothing is published, and the draft that was written is still a draft
    // with no narrative attached — the offending section was not dropped to
    // salvage a judgment that would then read as complete.
    expect(readCurrentJudgment(db, fixture.caseId)).toBeNull();
    const draft = readJudgment(db, outcome.draftId!)!;
    expect(draft.status).toBe("draft");
    expect(draft.surfaceLayer).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* HARD RULE #1, and the record's own arithmetic                              */
/* -------------------------------------------------------------------------- */

describe("what a claim may rest on", () => {
  it("rejects a claim citing an unconfirmed line", async () => {
    const fixture = seedCase();
    const base = factLayer(fixture);
    const { client } = mockClient(() => ({
      ...base,
      claims: [
        {
          ...base.claims[0],
          // One of the client's own five lines — on file, and pending.
          evidence_refs: [fixture.pending[0]],
        },
        base.claims[1],
        base.claims[2],
      ],
    }));

    const result = await runJudgmentSkeleton(db, fixture.caseId, {
      llm: { client },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.rejection.code).toBe("invalid_refs");
    expect(result.rejection.citations?.faults[0].rejected[0].fault).toBe(
      "unconfirmed",
    );
  });

  it("lets an unknown-tier claim stand with no citation at all", async () => {
    const fixture = seedCase();
    const { client } = mockClient((stage) =>
      stage === "skeleton" ? factLayer(fixture) : surfaceLayer("ok"),
    );

    const result = await runJudgmentSkeleton(db, fixture.caseId, {
      llm: { client },
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.data.claims[2].evidence_refs).toEqual([]);
  });

  it("rejects a judgment that understates its own evidentiary hole", async () => {
    const fixture = seedCase();
    const base = factLayer(fixture);
    const { client } = mockClient(() => ({
      ...base,
      findings: {
        ...base.findings,
        record_basis: {
          ...base.findings.record_basis,
          // The record says 0. Claiming 3 would let the disclosure paragraph
          // describe a case that does not exist.
          citable_utterances: { total: 5, by_client: 3, by_counterparty: 2 },
          parties_without_citable_utterance: [],
        },
      },
    }));

    const result = await runJudgmentSkeleton(db, fixture.caseId, {
      llm: { client },
    });

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.rejection.code).toBe("record_basis_mismatch");
    expect(result.rejection.recordBasis?.map((m) => m.path)).toContain(
      "citable_utterances.by_client",
    );
  });

  it("accepts the counts when they match the database", () => {
    const fixture = seedCase();
    const asymmetry = computeRecordAsymmetry(db, fixture.caseId);
    expect(
      verifyRecordBasis(asymmetry, factLayer(fixture).findings.record_basis),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Gated publication                                                          */
/* -------------------------------------------------------------------------- */

describe("publication is gated", () => {
  it("buffers, persists a draft, validates, then publishes in one piece", async () => {
    const fixture = seedCase();
    const { client } = mockClient((stage) =>
      stage === "skeleton" ? factLayer(fixture) : surfaceLayer("published"),
    );

    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") throw new Error("unreachable");

    const judgment = outcome.judgment;
    expect(judgment.status).toBe("final");
    expect(judgment.version).toBe(1);
    expect(judgment.outputLevel).toBe("L2");
    expect(judgment.model).toBe(MODEL_FABLE);
    expect(judgment.effort).toBe("xhigh");
    expect(judgment.surfaceLayer).not.toBeNull();

    // The judgment that stands is the published one, and both renditions were
    // minted in the same transaction that froze it.
    expect(readCurrentJudgment(db, fixture.caseId)?.id).toBe(judgment.id);
  });

  it("refuses to run while an adverse fact is unanswered", async () => {
    const fixture = seedCase();
    db.insert(adverseFacts)
      .values({
        caseId: fixture.caseId,
        aiDraft: "You did not answer the question that was put to you.",
        evidenceRefs: [fixture.citable[0]],
        ackStatus: "pending" as const,
      })
      .run();

    const { client, calls } = mockClient(() => factLayer(fixture));
    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The progress channel carries no judgment                                   */
/* -------------------------------------------------------------------------- */

describe("the progress stream", () => {
  /** Every byte that would have reached a viewer, as the route encodes it. */
  function wire(events: readonly JudgmentProgressEvent[]): string {
    return events.map(encodeProgressEvent).join("");
  }

  it("never carries a sentence of the judgment", async () => {
    const fixture = seedCase();
    const SENTINEL = "UNVALIDATED-BODY-TEXT-SENTINEL";
    const { client } = mockClient((stage) =>
      stage === "skeleton" ? factLayer(fixture) : surfaceLayer(SENTINEL),
    );

    const events: JudgmentProgressEvent[] = [];
    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: (event) => events.push(event),
      now: () => 0,
    });

    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") throw new Error("unreachable");

    const stream = wire(events);

    // The marker is in the published judgment…
    expect(JSON.stringify(outcome.judgment.surfaceLayer)).toContain(SENTINEL);
    // …and nowhere in what the viewer was sent.
    expect(stream).not.toContain(SENTINEL);

    // The one caller-supplied value on the wire is the published row's id, and
    // it is an opaque handle rather than text: the body is fetched with it, not
    // from it. Take it out before scanning for fragments — a random id whose hex
    // happens to contain "c1" is not a leak, and a test that reads it as one
    // fails roughly one run in eight for a reason that has nothing to do with
    // the guarantee under test.
    const done = events.find((event) => event.type === "done");
    expect(done).toEqual({
      type: "done",
      judgmentId: outcome.judgment.id,
      version: outcome.judgment.version,
    });
    const scanned = stream.split(outcome.judgment.id).join("<judgment-id>");

    // No heading, quote or claim from either layer is anywhere in the rest.
    for (const fragment of [
      "这件事今天必须说清楚",
      "What this judgment could read",
      "The deadline",
      "c1",
      "claim",
    ]) {
      expect(scanned).not.toContain(fragment);
    }
  });

  it("carries only summarized thinking, phases, heartbeats and a terminal event", async () => {
    const fixture = seedCase();
    const { client } = mockClient((stage) =>
      stage === "skeleton" ? factLayer(fixture) : surfaceLayer("ok"),
    );

    const events: JudgmentProgressEvent[] = [];
    await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: (event) => events.push(event),
      now: () => 0,
    });

    const kinds = new Set(events.map((event) => event.type));
    expect([...kinds].sort()).toEqual(["done", "heartbeat", "phase", "thinking"]);

    // SPEC ⑧ permits summarized thinking and nothing else.
    for (const event of events) {
      if (event.type === "thinking") expect(event.display).toBe("summarized");
    }

    // The terminal event is a pointer, not a payload: an id and a version.
    const done = events.find((event) => event.type === "done")!;
    expect(Object.keys(done).sort()).toEqual(["judgmentId", "type", "version"]);
  });

  it("reports a failure as a code, never as the fault report", async () => {
    const fixture = seedCase();
    const base = factLayer(fixture);
    const { client } = mockClient(() => ({
      ...base,
      findings: {
        ...base.findings,
        responsibility: [{ party: "甲", allocation: "primary", claim_ids: ["c1"] }],
      },
    }));

    const events: JudgmentProgressEvent[] = [];
    const outcome = await generateJudgment(db, fixture.caseId, {
      llm: { client },
      onProgress: (event) => events.push(event),
      now: () => 0,
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");

    const failed = events.find((event) => event.type === "failed")!;
    expect(failed.type).toBe("failed");
    if (failed.type !== "failed") throw new Error("unreachable");
    expect(failed.code).toBe("rejected");

    // The server-side report names the allocation and quotes the model back.
    // None of that is on the wire.
    expect(outcome.rejection.message).toContain("primary");
    expect(wire(events)).not.toContain("primary");
    expect(wire(events)).not.toContain("findings.responsibility");
  });
});
