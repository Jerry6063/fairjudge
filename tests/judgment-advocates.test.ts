/**
 * The blind advocate pair (doc 05 §B / §B.3, approved 2026-08-17).
 *
 * Two agents, one brief per party, each arguing that party's strongest case from
 * the record; neither sees the other's output; both briefs are inputs to the
 * skeleton. The pair runs at L1 only — below it, the single steelman of the
 * absent party already is the advocate and stays a single call.
 *
 * What this file is really testing is the **blindness**, and the only honest way
 * to test it is over the bytes: the assertions below read what actually reached
 * the model on each seat, rather than checking that a prompt asked the model not
 * to peek. A blindness enforced by instruction is not enforced.
 *
 * Evidence content is Chinese and stays Chinese (CLAUDE.md).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  clarificationRounds,
  issues,
  llmCalls,
  utterances,
  type OutputLevel,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  advocateBriefAStage,
  advocateBriefBStage,
  advocateBriefSchema,
} from "../src/server/llm/stages";
import {
  ADVOCATE_WITHHELD,
  AdvocacyError,
  assignAdvocateSeats,
  buildAdvocateInput,
  checkAdvocateBrief,
  runGatedHearing,
  seatBriefs,
  serializeAdvocateBriefs,
  type AdvocateBriefRecord,
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
/* Fixture — an L1 case: both parties have spoken inside the record            */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  /** `[甲1, 甲2, 乙1, 乙2]`, all confirmed. */
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
    .values({
      caseId,
      category: "undisputed" as const,
      aiDraft: "甲 set a same-day deadline for resolving the argument.",
      evidenceRefs: [citable[1]],
      confirmStatus: "confirmed" as const,
    })
    .run();

  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber: 1,
      questions: [{ id: "q1", question: "What did you say back that evening?" }],
      answers: [
        {
          questionId: "q1",
          answer: "我说我在加班",
          answeredAt: 1_700_000_000_000,
          state: "answered" as const,
        },
      ],
    })
    .run();

  return { caseId, citable };
}

/* -------------------------------------------------------------------------- */
/* The two seats                                                              */
/* -------------------------------------------------------------------------- */

describe("the two advocate stages", () => {
  it("are one contract twice, with two audit identities", () => {
    expect(advocateBriefAStage.model).toBe(MODEL_FABLE);
    expect(advocateBriefBStage.model).toBe(MODEL_FABLE);
    expect(advocateBriefAStage.effort).toBe("high");
    expect(advocateBriefBStage.effort).toBe("high");

    // Separate names: `llm_calls.stage` has to say which seat wrote a row.
    expect(advocateBriefAStage.name).toBe("advocate_brief_a");
    expect(advocateBriefBStage.name).toBe("advocate_brief_b");

    // One schema and one prompt: two seats arguing under different rules would
    // make their disagreement a fact about the rules.
    expect(advocateBriefAStage.zodSchema).toBe(advocateBriefSchema);
    expect(advocateBriefBStage.zodSchema).toBe(advocateBriefSchema);
    expect(advocateBriefAStage.promptTemplate).toBe(
      advocateBriefBStage.promptTemplate,
    );

    // The briefs are serialized into the skeleton's pseudonymous prompt, so the
    // real names do not come back into them.
    expect(advocateBriefAStage.keepPseudonyms).toBe(true);
    expect(advocateBriefBStage.keepPseudonyms).toBe(true);
  });

  it("refuses to enforce blindness in its own prompt text", () => {
    // The prompt describes the seat; it does not ask the model to ignore
    // something it was sent, because nothing was sent for it to ignore.
    expect(advocateBriefAStage.promptTemplate).toContain(
      "That is a fact about what you were sent",
    );
  });
});

describe("seating", () => {
  it("seats the client's advocate first — doc 05 §B.2's A-first seating", () => {
    const fixture = seedCase();
    const seats = assignAdvocateSeats(db, fixture.caseId);

    expect(seats).toEqual([
      { seat: "a", party: "乙", isClient: true },
      { seat: "b", party: "甲", isClient: false },
    ]);
  });

  it("refuses a case that has no pair to seat", () => {
    const [row] = db
      .insert(cases)
      .values({ stage: "judgment", title: "solo", outputLevel: "L1" })
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

    expect(() => assignAdvocateSeats(db, row.id)).toThrowError(AdvocacyError);
  });

  it("re-seats when the register calls the other party the client", () => {
    const briefs: AdvocateBriefRecord[] = [
      { seat: "a", party: "乙", isClient: true, brief: brief("乙", "u1") },
      { seat: "b", party: "甲", isClient: false, brief: brief("甲", "u2") },
    ];

    // The filed arm: the client's advocate first.
    expect(seatBriefs(briefs, "乙").map((r) => r.party)).toEqual(["乙", "甲"]);
    // The swapped arm: the same two briefs, the other way round. Nothing was
    // renamed — a brief for 甲 is still a brief for 甲.
    expect(seatBriefs(briefs, "甲").map((r) => r.party)).toEqual(["甲", "乙"]);
  });

  it("tells the hearing the two briefs were written independently", () => {
    const text = serializeAdvocateBriefs(
      [
        { seat: "a", party: "乙", isClient: true, brief: brief("乙", "u1") },
        { seat: "b", party: "甲", isClient: false, brief: brief("甲", "u2") },
      ],
      "乙",
    );
    expect(text).toContain("Neither advocate received the other's brief");
  });
});

/* -------------------------------------------------------------------------- */
/* What each seat is handed                                                   */
/* -------------------------------------------------------------------------- */

describe("what a seat receives, and what it does not", () => {
  it("gives each seat the case file, the issues, and its own party's words", () => {
    const fixture = seedCase();
    const [seatA, seatB] = assignAdvocateSeats(db, fixture.caseId);

    const a = buildAdvocateInput(db, fixture.caseId, seatA);
    const b = buildAdvocateInput(db, fixture.caseId, seatB);

    // The shared record: both seats see every confirmed line, because an
    // advocate arguing one party's case has to read what they were answering.
    for (const input of [a, b]) {
      expect(input.text).toContain("## Case file");
      expect(input.text).toContain("Issues as fixed with the client");
      for (const id of fixture.citable) expect(input.text).toContain(id);
    }

    // Their own party's words, called out as the material they argue from.
    expect(a.ownUtteranceIds).toEqual([fixture.citable[2], fixture.citable[3]].sort());
    expect(b.ownUtteranceIds).toEqual([fixture.citable[0], fixture.citable[1]].sort());
  });

  it("withholds the other party's clarification answers, always", () => {
    const fixture = seedCase();
    const [seatA, seatB] = assignAdvocateSeats(db, fixture.caseId);

    // The client answered the clarification, so the client's advocate reads it…
    const a = buildAdvocateInput(db, fixture.caseId, seatA);
    expect(a.text).toContain("我说我在加班");

    // …and the counterparty's advocate does not. Cross-party, at every level.
    const b = buildAdvocateInput(db, fixture.caseId, seatB);
    expect(b.text).not.toContain("我说我在加班");
    expect(b.text).not.toContain("What did you say back that evening?");
  });

  it("names what it withheld rather than leaving it to be assumed", () => {
    const fixture = seedCase();
    const [seatA] = assignAdvocateSeats(db, fixture.caseId);
    const a = buildAdvocateInput(db, fixture.caseId, seatA);

    expect(a.withheld).toEqual([...ADVOCATE_WITHHELD]);
    expect(a.text).toContain("withheld_from_you");
  });

  it("is byte-stable across assemblies of an unchanged record", () => {
    const fixture = seedCase();
    const [seatA] = assignAdvocateSeats(db, fixture.caseId);
    expect(buildAdvocateInput(db, fixture.caseId, seatA).text).toBe(
      buildAdvocateInput(db, fixture.caseId, seatA).text,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Checking a returned brief                                                  */
/* -------------------------------------------------------------------------- */

function brief(party: string, ref: string) {
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
        grounded_in: [],
      },
    ],
    must_concede: [
      { concession: `${party} let the exchange run late.`, grounded_in: [ref] },
    ],
  };
}

describe("checking a returned brief", () => {
  it("rejects a brief filed for the wrong party", () => {
    const fixture = seedCase();
    const [seatA] = assignAdvocateSeats(db, fixture.caseId);

    const fault = checkAdvocateBrief(
      db,
      fixture.caseId,
      seatA,
      brief("甲", fixture.citable[2]),
    );
    expect(fault?.code).toBe("wrong_party");
  });

  it("rejects a point grounded in a line that is not citable (HARD RULE #1)", () => {
    const fixture = seedCase();
    const [seatA] = assignAdvocateSeats(db, fixture.caseId);

    const fault = checkAdvocateBrief(
      db,
      fixture.caseId,
      seatA,
      brief("乙", "not-an-utterance-id"),
    );
    expect(fault?.code).toBe("invalid_refs");
  });

  it("accepts an advocate who says the record supports no case", () => {
    const fixture = seedCase();
    const [seatA] = assignAdvocateSeats(db, fixture.caseId);

    const empty = {
      for_party: "乙",
      can_produce: false,
      unable_reason: "Nothing 乙 said survives in confirmed form.",
      headline: "",
      strongest_case: [],
      not_forced_by_the_record: [],
      must_concede: [],
    };
    expect(checkAdvocateBrief(db, fixture.caseId, seatA, empty)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The pair inside a hearing                                                  */
/* -------------------------------------------------------------------------- */

function factLayer(fixture: Fixture, client: string): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: '甲 set a same-day deadline: "这件事今天必须说清楚".',
        evidence_refs: [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: client,
        citable_utterances: { total: 4, by_client: 2, by_counterparty: 2 },
        parties_without_citable_utterance: [],
        statement: "Two confirmed lines from each of them, four in all.",
      },
      unresolved: [],
      responsibility: [
        { party: "甲", allocation: "shared", claim_ids: ["c1"] },
        { party: "乙", allocation: "shared", claim_ids: ["c1"] },
      ],
    },
  };
}

const surface: SurfaceLayer = {
  sections: [
    {
      section_id: "s1",
      kind: "finding",
      audience: "both",
      heading: "The deadline",
      text: '甲 set a same-day deadline: "这件事今天必须说清楚".',
      claim_ids: ["c1"],
    },
  ],
};

interface Recorded {
  readonly stage: string;
  readonly prompt: string;
}

function mockClient(fixture: Fixture): {
  client: Anthropic;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const create = vi.fn(async (params: unknown) => {
    const system = (params as { system?: unknown }).system;
    const systemText = typeof system === "string" ? system : JSON.stringify(system);
    const stage = systemText.includes("You are one of two advocates")
      ? "advocate"
      : systemText.includes("You are the fact-finding stage")
        ? "skeleton"
        : "narrative";

    const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
    const first = messages[0]?.content;
    const prompt = typeof first === "string" ? first : JSON.stringify(first);
    calls.push({ stage, prompt });

    const party = /Write the brief for (\S+?)\./.exec(prompt)?.[1] ?? "乙";
    const client = /"client_pseudonym"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? "乙";
    const answer =
      stage === "advocate"
        ? brief(party, party === "甲" ? fixture.citable[0] : fixture.citable[2])
        : stage === "skeleton"
          ? factLayer(fixture, client)
          : surface;

    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: JSON.stringify(answer) }],
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

describe("the pair inside a hearing", () => {
  it("runs both seats at L1, and seat B never sees seat A's brief", async () => {
    const fixture = seedCase("L1");
    const { client, calls } = mockClient(fixture);

    const hearing = await runGatedHearing(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
    });

    expect(hearing.kind).toBe("ok");
    if (hearing.kind !== "ok") return;
    expect(hearing.data.advocates.map((record) => record.party)).toEqual(["乙", "甲"]);

    const advocates = calls.filter((call) => call.stage === "advocate");
    expect(advocates).toHaveLength(2);

    // Seat A ran first and returned a brief with this sentence in it. Seat B's
    // prompt was assembled without it, which is the blindness.
    expect(advocates[1].prompt).not.toContain("乙 answered the same evening.");
    expect(advocates[1].prompt).not.toContain("How 乙 would tell this.");
    // And neither seat was shown a draft skeleton: there is none to show.
    for (const call of advocates) {
      expect(call.prompt).not.toContain("claim_id");
      expect(call.prompt).not.toContain("record_basis");
    }

    // Both briefs reach the skeleton, seated with the client's advocate first.
    const skeleton = calls.find((call) => call.stage === "skeleton");
    expect(skeleton?.prompt).toContain("Advocate briefs");
    const at = (party: string) =>
      skeleton?.prompt.indexOf(`"for_party": "${party}"`) ?? -1;
    expect(at("乙")).toBeGreaterThan(-1);
    expect(at("乙")).toBeLessThan(at("甲"));
  });

  it("does not run the pair below L1", async () => {
    const fixture = seedCase("L2");
    const { client, calls } = mockClient(fixture);

    // At L2 the fact layer may allocate nothing, so answer with an empty list.
    const hearing = await runGatedHearing(db, fixture.caseId, {
      skipGate: true,
      llm: {
        db,
        client: patchAllocations(client),
      },
    });

    expect(hearing.kind === "ok" || hearing.kind === "rejected").toBe(true);
    expect(calls.filter((call) => call.stage === "advocate")).toHaveLength(0);
  });

  it("collapses the pair when the case has reached its ceiling, and says so", async () => {
    const fixture = seedCase("L1");
    db.insert(llmCalls)
      .values({
        caseId: fixture.caseId,
        provider: "anthropic",
        model: MODEL_FABLE,
        costUsd: 9,
      })
      .run();

    const { client, calls } = mockClient(fixture);
    const hearing = await runGatedHearing(db, fixture.caseId, {
      skipGate: true,
      llm: { db, client },
    });

    expect(hearing.kind).toBe("ok");
    if (hearing.kind !== "ok") return;

    expect(calls.filter((call) => call.stage === "advocate")).toHaveLength(0);
    expect(hearing.data.advocates).toHaveLength(0);
    expect(hearing.data.plan.cuts).toContain("advocate_pair_collapsed");
    // The cut is disclosed in the document, not only in the plan object.
    expect(hearing.data.limits).toContain("pair of independent");
    // The swap pass is never cut, whatever the spend.
    expect(calls.filter((call) => call.stage === "skeleton").length).toBeGreaterThan(1);
  });
});

/** Strip the allocations from whatever the double answers — for the L2 run. */
function patchAllocations(client: Anthropic): Anthropic {
  const inner = client as unknown as {
    messages: { create: (params: unknown) => Promise<unknown> };
  };
  const create = async (params: unknown) => {
    const message = (await inner.messages.create(params)) as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(message.content[0].text) as Record<string, unknown>;
    const findings = parsed.findings as { responsibility?: unknown } | undefined;
    if (findings !== undefined) findings.responsibility = [];
    return {
      ...message,
      content: [{ type: "text", text: JSON.stringify(parsed) }],
    };
  };
  const stream = (params: unknown) => ({ finalMessage: () => create(params) });
  return {
    messages: { create, stream },
    beta: { messages: { create, stream } },
  } as unknown as Anthropic;
}
