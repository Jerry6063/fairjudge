/**
 * The swap test as a publication gate, the cost ceiling, and the disagreement
 * display (doc 05 §B.2 / §B.5 / §B.1.d, approved 2026-08-17).
 *
 * Three failures this file exists to catch, none of them visible in a finished
 * document:
 *
 *   1. **A pass-two that saw pass one.** The measurement's whole meaning is that
 *      the two hearings were independent. A second pass handed the first pass's
 *      skeleton measures agreement with a document, and would agree with almost
 *      anything. The test below reads every byte that reached the model on the
 *      swapped arm and asserts the first arm's claim ids are not among them.
 *   2. **An allocation that moved with the names, published anyway.** The gate
 *      withholds it, in code, before the narrative is written — so the narrative
 *      is written from a fact layer that has no allocation in it to narrate.
 *   3. **A cut nobody was told about.** Every degradation the cost ceiling makes
 *      writes its own sentence into the document's limits, composed here rather
 *      than requested from a model.
 *
 * And one thing that must NOT happen: none of this touches the case's output
 * level (HARD RULE #2). A withheld allocation is a failed generation, not a
 * demoted case.
 *
 * Evidence content is Chinese and stays Chinese (CLAUDE.md).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  issues,
  llmCalls,
  utterances,
  type OutputLevel,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import { judgmentSkeletonRehearingStage } from "../src/server/llm/stages";
import {
  CASE_COST_CEILING_USD,
  SWAP_ALLOCATION_DELTA_THRESHOLD,
  checkLevelConstraints,
  generateJudgment,
  measureSwapDelta,
  planCaseSpend,
  readCaseSpend,
  readCurrentJudgment,
  renderDisagreement,
  resolveSwapGate,
  runGatedHearing,
  withholdAllocation,
  type FactLayer,
  type SurfaceLayer,
  type SwapPass,
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
/* Fixture — an L1 case: both parties have spoken inside the record            */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  /** Two lines each, confirmed. `[甲1, 甲2, 乙1, 乙2]`. */
  readonly citable: readonly string[];
}

function seedCase(level: OutputLevel = "L1"): Fixture {
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
        participationState: "participating",
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
      {
        caseId,
        speakerParticipantId: client.id,
        speakerLabel: "乙",
        aiDraft: "我当时在加班",
        confirmStatus: "confirmed" as const,
      },
      {
        caseId,
        speakerParticipantId: client.id,
        speakerLabel: "乙",
        aiDraft: "我们明天再谈",
        confirmStatus: "confirmed" as const,
      },
    ])
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
        aiDraft: "Whether the delay was a refusal or a scheduling problem.",
        evidenceRefs: [citable[0], citable[2]],
        confirmStatus: "confirmed" as const,
      },
    ])
    .run();

  return { caseId, citable };
}

/* -------------------------------------------------------------------------- */
/* Model doubles                                                              */
/* -------------------------------------------------------------------------- */

type Allocation = "primary" | "shared" | "contributing" | "not_established";

/**
 * A well-formed L1 fact layer. `client` is the pseudonym the arm's own register
 * marks as the submitter, which is exactly what the register exchange moves.
 */
function factLayer(
  fixture: Fixture,
  client: string,
  allocations: readonly { party: string; allocation: Allocation }[],
): FactLayer {
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
        statement: '乙 gave working late as the reason: "我当时在加班".',
        evidence_refs: [fixture.citable[2]],
        confidence: 0.85,
        tier: "high_confidence",
      },
      {
        claim_id: "c3",
        statement: "Whether the deadline had been agreed before that day is not in the record.",
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: client,
        citable_utterances: { total: 4, by_client: 2, by_counterparty: 2 },
        parties_without_citable_utterance: [],
        statement:
          "Both parties have confirmed lines in this record: two each, four in all.",
      },
      unresolved: [
        {
          question: "Had the same-day deadline been discussed before that day?",
          reason: "record_silent",
          claim_ids: ["c3"],
        },
      ],
      responsibility: allocations.map((item) => ({
        party: item.party,
        allocation: item.allocation,
        claim_ids: item.party === "甲" ? ["c1"] : ["c2"],
      })),
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
        text: "Four confirmed lines, two from each of them.",
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
    ],
  };
}

/** An advocate brief that grounds everything in one real line. */
function advocateBrief(party: string, ref: string): unknown {
  return {
    for_party: party,
    can_produce: true,
    unable_reason: null,
    headline: `How ${party} would tell this.`,
    strongest_case: [
      { point: `${party} answered the same evening.`, grounded_in: [ref] },
    ],
    not_forced_by_the_record: [
      {
        reading: `That ${party} was stalling.`,
        why_not_forced: "The record shows the timing, not the intent behind it.",
        grounded_in: [ref],
      },
    ],
    must_concede: [
      { concession: `${party} did let the exchange run late.`, grounded_in: [ref] },
    ],
  };
}

type Stage = "advocate" | "skeleton" | "narrative" | "other";

function stageOf(params: unknown): Stage {
  const system = (params as { system?: unknown }).system;
  const text = typeof system === "string" ? system : JSON.stringify(system);
  if (text.includes("You are one of two advocates")) return "advocate";
  if (text.includes("You are the fact-finding stage")) return "skeleton";
  if (text.includes("You are the drafting stage")) return "narrative";
  /* c8 ignore next */
  return "other";
}

/** Which pseudonym this arm's own record-basis block names as the submitter. */
function armClient(prompt: string): string {
  return /"client_pseudonym"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? "";
}

interface Recorded {
  readonly stage: Stage;
  readonly prompt: string;
  readonly effort: string | undefined;
}

function mockClient(
  answer: (stage: Stage, prompt: string, call: number) => unknown,
): { client: Anthropic; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const create = vi.fn(async (params: unknown) => {
    const stage = stageOf(params);
    const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
    const first = messages[0]?.content;
    const prompt = typeof first === "string" ? first : JSON.stringify(first);
    calls.push({
      stage,
      prompt,
      effort: (params as { output_config?: { effort?: string } }).output_config
        ?.effort,
    });
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [
        { type: "text", text: JSON.stringify(answer(stage, prompt, calls.length)) },
      ],
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

  const stream = (params: unknown) => ({ finalMessage: () => create(params) });

  return {
    client: {
      messages: { create, stream },
      beta: { messages: { create, stream } },
    } as unknown as Anthropic,
    calls,
  };
}

/**
 * The scenario the gate exists for: the allocation is exactly exchanged when the
 * register is, and stays exchanged when the case is re-heard.
 */
function flippingAnswers(fixture: Fixture) {
  return (stage: Stage, prompt: string): unknown => {
    if (stage === "advocate") {
      const party = /Write the brief for (\S+?)\./.exec(prompt)?.[1] ?? "甲";
      return advocateBrief(party, party === "甲" ? fixture.citable[0] : fixture.citable[2]);
    }
    if (stage === "narrative") return surfaceLayer();
    const client = armClient(prompt);
    // Whoever the file calls the client comes out carrying the lighter share.
    return client === "乙"
      ? factLayer(fixture, client, [
          { party: "甲", allocation: "primary" },
          { party: "乙", allocation: "contributing" },
        ])
      : factLayer(fixture, client, [
          { party: "甲", allocation: "contributing" },
          { party: "乙", allocation: "primary" },
        ]);
  };
}

/** The allocation holds however the register is arranged. */
function steadyAnswers(fixture: Fixture) {
  return (stage: Stage, prompt: string): unknown => {
    if (stage === "advocate") {
      const party = /Write the brief for (\S+?)\./.exec(prompt)?.[1] ?? "甲";
      return advocateBrief(party, party === "甲" ? fixture.citable[0] : fixture.citable[2]);
    }
    if (stage === "narrative") return surfaceLayer();
    return factLayer(fixture, armClient(prompt), [
      { party: "甲", allocation: "shared" },
      { party: "乙", allocation: "shared" },
    ]);
  };
}

/* -------------------------------------------------------------------------- */
/* The measurement                                                            */
/* -------------------------------------------------------------------------- */

function pass(
  n: 1 | 2,
  filed: readonly { party: string; allocation: Allocation }[],
  swapped: readonly { party: string; allocation: Allocation }[],
): SwapPass {
  const parties = [...new Set([...filed, ...swapped].map((a) => a.party))].sort();
  const differences = {
    pairedClaims: [],
    claimsOnlyInFiled: [],
    claimsOnlyInSwapped: [],
    allocations: parties.map((party) => {
      const a = filed.find((item) => item.party === party)?.allocation ?? null;
      const b = swapped.find((item) => item.party === party)?.allocation ?? null;
      return { party, filed: a, swapped: b, changed: a !== b };
    }),
    recordBasis: {
      filedTotal: 4,
      swappedTotal: 4,
      totalsAgree: true,
      filedClient: "乙",
      swappedClient: "甲",
      filedClientCorrect: true,
      swappedClientCorrect: true,
    },
    unresolvedOnlyInFiled: [],
    unresolvedOnlyInSwapped: [],
  };

  return {
    pass: n,
    delta: measureSwapDelta(differences),
    filedAllocations: filed,
    swappedAllocations: swapped,
    filedClient: "乙",
    swappedClient: "甲",
  };
}

describe("the delta the gate measures", () => {
  it("counts allocations that moved, and allows none to", () => {
    expect(SWAP_ALLOCATION_DELTA_THRESHOLD).toBe(0);

    const held = pass(
      1,
      [{ party: "甲", allocation: "shared" }],
      [{ party: "甲", allocation: "shared" }],
    );
    expect(held.delta).toMatchObject({ delta: 0, exceeded: false });

    const moved = pass(
      1,
      [
        { party: "甲", allocation: "primary" },
        { party: "乙", allocation: "contributing" },
      ],
      [
        { party: "甲", allocation: "contributing" },
        { party: "乙", allocation: "primary" },
      ],
    );
    expect(moved.delta).toMatchObject({ delta: 2, exceeded: true });
  });
});

describe("resolving the gate", () => {
  it("publishes intact when the allocation survived the exchange", () => {
    const outcome = resolveSwapGate({
      passes: [
        pass(
          1,
          [{ party: "甲", allocation: "shared" }],
          [{ party: "甲", allocation: "shared" }],
        ),
      ],
    });

    expect(outcome.disposition).toBe("published_intact");
    expect(outcome.allocationWithheld).toBe(false);
    expect(outcome.disagreements).toHaveLength(0);
    expect(outcome.disclosure).toContain("heard twice");
  });

  it("withholds the allocation when the re-hearing did not settle it", () => {
    const moved = [
      pass(
        1,
        [{ party: "甲", allocation: "primary" }],
        [{ party: "甲", allocation: "contributing" }],
      ),
      pass(
        2,
        [{ party: "甲", allocation: "primary" }],
        [{ party: "甲", allocation: "contributing" }],
      ),
    ];
    const outcome = resolveSwapGate({ passes: moved });

    expect(outcome.disposition).toBe("allocation_withheld");
    expect(outcome.allocationWithheld).toBe(true);
    expect(outcome.rehearingRun).toBe(true);
    expect(outcome.disagreements).toHaveLength(1);
    expect(outcome.disagreements[0].readings).toHaveLength(2);
  });

  it("says so when the re-hearing was given up to the ceiling", () => {
    const outcome = resolveSwapGate({
      passes: [
        pass(
          1,
          [{ party: "甲", allocation: "primary" }],
          [{ party: "甲", allocation: "shared" }],
        ),
      ],
      rehearingCut: true,
    });

    expect(outcome.allocationWithheld).toBe(true);
    expect(outcome.rehearingRun).toBe(false);
    expect(outcome.disclosure).toContain("spending ceiling");
  });

  it("decides nothing when neither hearing allocated anything", () => {
    const outcome = resolveSwapGate({ passes: [pass(1, [], [])] });
    expect(outcome.disposition).toBe("not_applicable");
    expect(outcome.allocationWithheld).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The gate is enforced where artifact validity lives                          */
/* -------------------------------------------------------------------------- */

describe("checkLevelConstraints enforces the withholding", () => {
  it("rejects an L1 fact layer that still carries a withheld allocation", () => {
    const fixture = seedCase("L1");
    const carrying = factLayer(fixture, "乙", [
      { party: "甲", allocation: "primary" },
      { party: "乙", allocation: "contributing" },
    ]);

    // Without the gate, this is a perfectly valid L1 fact layer.
    expect(checkLevelConstraints("L1", carrying)).toHaveLength(0);

    const violations = checkLevelConstraints("L1", carrying, {
      allocationWithheld: true,
      reason: "It did not survive exchanging the parties' positions.",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("allocation_withheld_by_swap_gate");
    // The level is not what failed, and the message has to say so.
    expect(violations[0].detail).toContain("the level itself is untouched");
  });

  it("passes once the allocation has actually been withheld", () => {
    const fixture = seedCase("L1");
    const withheld = withholdAllocation(
      factLayer(fixture, "乙", [{ party: "甲", allocation: "primary" }]),
    );

    expect(withheld.findings.responsibility).toHaveLength(0);
    // The claims the allocation rested on stay: what failed was the conclusion.
    expect(withheld.claims).toHaveLength(3);
    expect(
      checkLevelConstraints("L1", withheld, {
        allocationWithheld: true,
        reason: "…",
      }),
    ).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The disagreement display                                                    */
/* -------------------------------------------------------------------------- */

describe("the disagreement display", () => {
  it("sets the readings side by side and never merges them", () => {
    const text = renderDisagreement([
      {
        subject: "How responsibility was allocated",
        readings: [
          { seat: "Heard with 乙 seated first", reading: "甲: primary; 乙: contributing" },
          { seat: "Heard with 甲 seated first", reading: "甲: contributing; 乙: primary" },
        ],
      },
    ]);

    expect(text).toContain("甲: primary; 乙: contributing");
    expect(text).toContain("甲: contributing; 乙: primary");
    expect(text).toContain("set side by side rather than merged");
  });

  it("renders nothing when nothing diverged, and drops a lone reading", () => {
    expect(renderDisagreement([])).toBe("");
    expect(
      renderDisagreement([
        { subject: "x", readings: [{ seat: "only seat", reading: "one answer" }] },
      ]),
    ).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* The cost ceiling                                                            */
/* -------------------------------------------------------------------------- */

describe("the per-case cost ceiling", () => {
  it("reads what the case has already spent, and flags unpriced calls", () => {
    const fixture = seedCase();
    db.insert(llmCalls)
      .values([
        { caseId: fixture.caseId, provider: "anthropic", model: MODEL_FABLE, costUsd: 1.5 },
        { caseId: fixture.caseId, provider: "anthropic", model: MODEL_FABLE, costUsd: 0.25 },
        { caseId: fixture.caseId, provider: "anthropic", model: "unpriced", costUsd: null },
      ])
      .run();

    const spend = readCaseSpend(db, fixture.caseId);
    expect(spend).toMatchObject({ spentUsd: 1.75, calls: 3, unpricedCalls: 1 });
  });

  it("cuts in the order doc 05 §B.5 fixes, and discloses each cut", () => {
    const fixture = seedCase();
    const at = (spentUsd: number) =>
      planCaseSpend(db, fixture.caseId, {
        level: "L1",
        spend: { caseId: fixture.caseId, spentUsd, calls: 0, unpricedCalls: 0 },
      });

    expect(CASE_COST_CEILING_USD).toBe(10);

    // Room for everything.
    const full = at(1);
    expect(full.cuts).toEqual([]);
    expect(full.rehearingAvailable).toBe(true);
    expect(full.advocatePairAvailable).toBe(true);

    // First cut: the re-hearing.
    const one = at(7);
    expect(one.cuts).toEqual(["rehearing_cut"]);
    expect(one.advocatePairAvailable).toBe(true);
    expect(one.disclosures[0]).toContain("re-hearing");

    // Second cut: the advocate pair.
    const two = at(7.7);
    expect(two.cuts).toEqual(["rehearing_cut", "advocate_pair_collapsed"]);
    expect(two.advocatePairAvailable).toBe(false);

    // Third cut: the post-judgment documents.
    const three = at(8);
    expect(three.cuts).toEqual([
      "rehearing_cut",
      "advocate_pair_collapsed",
      "post_judgment_batched",
    ]);
    expect(three.postJudgmentInline).toBe(false);

    // Past every cut: nothing else is given up, and the overrun is disclosed.
    const over = at(20);
    expect(over.overCeiling).toBe(true);
    expect(over.disclosures.join(" ")).toContain("not cut at any price");
  });

  it("never claims to have collapsed a pair the level never had", () => {
    const fixture = seedCase("L2");
    const plan = planCaseSpend(db, fixture.caseId, {
      level: "L2",
      spend: { caseId: fixture.caseId, spentUsd: 9, calls: 0, unpricedCalls: 0 },
    });
    expect(plan.cuts).not.toContain("advocate_pair_collapsed");
    expect(plan.advocatePairAvailable).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end                                                                  */
/* -------------------------------------------------------------------------- */

describe("the gate, end to end", () => {
  it("hears the swapped arm without showing it the first arm's output", async () => {
    const fixture = seedCase("L1");
    const { client, calls } = mockClient(flippingAnswers(fixture));

    await runGatedHearing(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
    });

    const skeletons = calls.filter((call) => call.stage === "skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);

    // The swapped arm is the one whose own register calls 甲 the client.
    const swapped = skeletons.filter((call) => armClient(call.prompt) === "甲");
    expect(swapped.length).toBeGreaterThan(0);
    for (const arm of swapped) {
      // Nothing the first pass RETURNED may appear in what the second is asked.
      // The sentence below exists only in the first arm's fact layer.
      expect(arm.prompt).not.toContain(
        "Both parties have confirmed lines in this record",
      );
      expect(arm.prompt).not.toContain("high_confidence");
      expect(arm.prompt).not.toContain("Judgment skeleton (frozen");
      expect(arm.prompt).not.toContain("Your previous answer was rejected");
    }
  });

  it("re-hears at effort max, then withholds the allocation and shows both readings", async () => {
    const fixture = seedCase("L1");
    const { client, calls } = mockClient(flippingAnswers(fixture));

    const outcome = await generateJudgment(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") return;

    expect(outcome.gate.disposition).toBe("allocation_withheld");
    expect(outcome.gate.rehearingRun).toBe(true);
    expect(calls.some((call) => call.effort === "max")).toBe(true);
    expect(judgmentSkeletonRehearingStage.effort).toBe("max");

    // The published fact layer carries no allocation…
    const published = readCurrentJudgment(db, fixture.caseId);
    expect(published?.factLayer.findings.responsibility).toEqual([]);

    // …the document says why, and shows the two readings instead of one…
    const limits = published?.surfaceLayer?.sections.find(
      (section) => section.section_id === "server_limits",
    );
    expect(limits?.kind).toBe("limits");
    expect(limits?.audience).toBe("both");
    expect(limits?.text).toContain("No allocation of responsibility is stated");
    // Both readings, whole, side by side. Party order inside a reading is
    // sorted, so the two lines differ only in what each hearing concluded.
    expect(limits?.text).toContain("乙: contributing; 甲: primary");
    expect(limits?.text).toContain("乙: primary; 甲: contributing");
    expect(limits?.text).toContain("set side by side rather than merged");

    // …and the case is still locked at L1. The level is never the lever.
    const row = db
      .select({ outputLevel: cases.outputLevel })
      .from(cases)
      .where(eq(cases.id, fixture.caseId))
      .get();
    expect(row?.outputLevel).toBe("L1");
    expect(published?.outputLevel).toBe("L1");
  });

  it("publishes the allocation when it survives the exchange, and discloses the test", async () => {
    const fixture = seedCase("L1");
    const { client, calls } = mockClient(steadyAnswers(fixture));

    const outcome = await generateJudgment(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
      onProgress: () => {},
    });

    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") return;
    expect(outcome.gate.disposition).toBe("published_intact");
    // No re-hearing was bought, so no call ran at effort max.
    expect(calls.some((call) => call.effort === "max")).toBe(false);

    const published = readCurrentJudgment(db, fixture.caseId);
    expect(published?.factLayer.findings.responsibility).toHaveLength(2);
    const limits = published?.surfaceLayer?.sections.find(
      (section) => section.section_id === "server_limits",
    );
    expect(limits?.text).toContain("came back the same either way");
    expect(limits?.text).not.toContain("No allocation of responsibility is stated");
  });

  it("spends nothing on a swap pass at a level that allocates nothing", async () => {
    const fixture = seedCase("L2");
    const { client, calls } = mockClient((stage, prompt) =>
      stage === "narrative"
        ? surfaceLayer()
        : factLayer(fixture, armClient(prompt), []),
    );

    const hearing = await runGatedHearing(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
    });

    expect(hearing.kind).toBe("ok");
    if (hearing.kind !== "ok") return;
    expect(calls.filter((call) => call.stage === "skeleton")).toHaveLength(1);
    expect(calls.filter((call) => call.stage === "advocate")).toHaveLength(0);
    expect(hearing.data.gate.disposition).toBe("not_applicable");
    // Nothing to disclose: the level's own limits already say it allocated none.
    expect(hearing.data.limits).toBe("");
  });
});
