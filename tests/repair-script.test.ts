/**
 * The repair-conversation script (SPEC M4 ③).
 *
 * What is asserted here is that the script is the thing it claims to be:
 *
 *   1. **Generated from the fact layer, not from the narrative.** The prompt
 *      carries the frozen claims and nothing of the judgment's prose — a marker
 *      planted in the narrative must not appear in it. The narrative is a
 *      reading of the claims, written to persuade the person it addresses, and
 *      a script derived from it would put that rhetoric in the client's mouth.
 *   2. **The opening line is sayable.** First person, no absolutes about the
 *      other person, no verdict quoted as leverage, short enough to get out.
 *   3. **The "when it goes wrong" block is real.** A self-check made only of
 *      emotion words fails exactly when it is needed, and a pause with no return
 *      time is a walk-out.
 *   4. **It cites the record.** An unknown claim_id rejects the whole script.
 *
 * Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { caseParticipants, cases, repairScripts } from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  repairScriptSchema,
  repairScriptStage,
  type RepairScriptOutput,
} from "../src/server/llm/stages";
import {
  RepairScriptError,
  checkRepairScript,
  createDraft,
  finalize,
  generateRepairScript,
  normalizeRepairScript,
  persistRepairScript,
  readRepairScript,
  renderRepairScript,
  renderRepairScriptPrompt,
  repairScriptProvenance,
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
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

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

function clientNarrative(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text:
          "You, 乙, submitted this case. The phrase that appears only in this " +
          "narrative is PROSE-ONLY-MARKER.",
        claim_ids: [],
      },
    ],
  };
}

function script(overrides: Partial<RepairScriptOutput> = {}): RepairScriptOutput {
  return {
    opening_line:
      "I want to sort out the “我周三之前必须知道” message. I did not answer it, " +
      "and I would like to say why and hear what that evening was like for you.",
    when_it_goes_wrong: {
      pause_signal:
        "Either of us says “先停一下”, and whoever hears it stops talking.",
      flooding_self_check:
        "My voice starts getting faster and I am rehearsing my reply instead " +
        "of listening.",
      return_time: "We pick it up again after dinner tonight.",
      ...(overrides.when_it_goes_wrong ?? {}),
    },
    claim_ids: ["c1"],
    ...(overrides.opening_line === undefined
      ? {}
      : { opening_line: overrides.opening_line }),
    ...(overrides.claim_ids === undefined ? {} : { claim_ids: overrides.claim_ids }),
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

function rawJudgment(judgmentId: string): unknown {
  return sqlite.prepare("SELECT * FROM judgments WHERE id = ?").get(judgmentId);
}

function check(output: RepairScriptOutput) {
  return checkRepairScript(
    { factLayer: factLayer() },
    normalizeRepairScript("j1", output),
  );
}

/* -------------------------------------------------------------------------- */
/* The model double                                                           */
/* -------------------------------------------------------------------------- */

function mockClient(answer: (call: number) => unknown): {
  client: Anthropic;
  calls: { prompt: string }[];
} {
  const calls: { prompt: string }[] = [];
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
        input_tokens: 2000,
        output_tokens: 300,
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

describe("the repair_script stage", () => {
  it("runs fable at medium effort against its own schema", () => {
    expect(repairScriptStage.name).toBe("repair_script");
    expect(repairScriptStage.model).toBe(MODEL_FABLE);
    expect(repairScriptStage.effort).toBe("medium");
    expect(repairScriptStage.keepPseudonyms).toBe(true);
    expect(repairScriptStage.zodSchema).toBe(repairScriptSchema);
  });

  it("is written from the fact layer and never from the judgment's prose", () => {
    const prompt = renderRepairScriptPrompt("L2", factLayer());

    expect(prompt).toContain("我周三之前必须知道");
    expect(prompt).toContain("c1");
    expect(prompt).toContain("first person");
    expect(prompt).not.toContain("PROSE-ONLY-MARKER");
    // Byte-stable, so two runs over the same judgment share a cache prefix.
    expect(prompt).toBe(renderRepairScriptPrompt("L2", factLayer()));
  });
});

/* -------------------------------------------------------------------------- */
/* The opening line                                                           */
/* -------------------------------------------------------------------------- */

describe("an opening line somebody could actually say", () => {
  it("accepts one that names the event and owns a part in it", () => {
    expect(check(script())).toBeNull();
  });

  it("refuses the openings that end the conversation in its first sentence", () => {
    for (const opening of [
      "I need to talk about this: you always do this when I am busy.",
      "You made me stop replying, and I want to talk about it.",
      "The judgment found that you set a deadline, so I want to discuss it.",
      "You need to explain what you meant by “我周三之前必须知道”.",
    ]) {
      const rejection = check(script({ opening_line: opening }));
      expect(rejection, opening).not.toBeNull();
      expect(rejection?.code).toBe("repair_script_violation");
      expect(
        (rejection?.plan ?? []).some((fault) => fault.path === "opening_line"),
        opening,
      ).toBe(true);
    }
  });

  it("refuses a line with nobody speaking it", () => {
    const rejection = check(
      script({
        opening_line:
          "The conversation should begin by acknowledging what happened.",
      }),
    );
    expect(rejection?.message).toContain("not in the first person");
  });

  it("refuses a paragraph pretending to be a line", () => {
    const rejection = check(
      script({ opening_line: `I want to talk about it. ${"and how it went. ".repeat(30)}` }),
    );
    expect(rejection?.message).toContain("An opening line is a line");
  });
});

/* -------------------------------------------------------------------------- */
/* When it goes wrong                                                         */
/* -------------------------------------------------------------------------- */

describe("the block for when it goes wrong", () => {
  it("refuses a self-check made of feelings", () => {
    const rejection = check(
      script({
        when_it_goes_wrong: {
          pause_signal: "Either of us says “先停一下”.",
          flooding_self_check: "I notice that I am upset and getting frustrated.",
          return_time: "In 30 minutes.",
        },
      }),
    );

    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("no physical or behavioural sign");
    expect((rejection?.plan ?? []).map((fault) => fault.path)).toContain(
      "when_it_goes_wrong.flooding_self_check",
    );
  });

  it("accepts one that names a sign you could notice while flooded", () => {
    for (const selfCheck of [
      "My pulse is up and my jaw is tight.",
      "I am pacing, and I have started interrupting her.",
      "I am reading her message to find the part I can win on.",
    ]) {
      expect(
        check(
          script({
            when_it_goes_wrong: {
              pause_signal: "Either of us says “先停一下”.",
              flooding_self_check: selfCheck,
              return_time: "After dinner tonight.",
            },
          }),
        ),
        selfCheck,
      ).toBeNull();
    }
  });

  it("refuses a pause with no return time", () => {
    const rejection = check(
      script({
        when_it_goes_wrong: {
          pause_signal: "Either of us says “先停一下”.",
          flooding_self_check: "My voice is getting faster.",
          return_time: "When we are both calmer and ready to talk again.",
        },
      }),
    );

    expect(rejection?.message).toContain("names no time");
    expect(rejection?.message).toContain("walk-out");
  });
});

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

describe("what the script is built from", () => {
  it("refuses one citing a claim the frozen fact layer does not define", () => {
    const rejection = check(script({ claim_ids: ["c1", "c8"] }));
    expect(rejection?.message).toContain('cites claim_id "c8"');
    expect((rejection?.plan ?? []).map((fault) => fault.path)).toContain(
      "claim_ids[1]",
    );
  });

  it("resolves its claims for the screen", () => {
    const resolved = repairScriptProvenance(
      factLayer(),
      normalizeRepairScript("j1", script()),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].statement).toContain("我周三之前必须知道");
  });

  it("keeps the citations out of the text the client reads", () => {
    const text = renderRepairScript(normalizeRepairScript("j1", script()));
    expect(text).toContain("What you could open with");
    expect(text).toContain("When it goes wrong");
    expect(text).toContain("先停一下");
    // A claim id in the middle of a sentence somebody is about to say out loud
    // is the judgment intruding on the conversation.
    expect(text).not.toContain("c1");
  });
});

/* -------------------------------------------------------------------------- */
/* Generation and storage                                                     */
/* -------------------------------------------------------------------------- */

describe("generating a script from a frozen judgment", () => {
  it("stores it and leaves the judgment byte-identical", async () => {
    const { judgmentId } = seedFinalJudgment();
    const before = rawJudgment(judgmentId);
    const { client } = mockClient(() => script());

    const outcome = await generateRepairScript(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;
    expect(outcome.record.content.claim_ids).toEqual(["c1"]);
    expect(outcome.record.text).toContain("我周三之前必须知道");
    expect(outcome.record.provenance?.model).toBe(MODEL_FABLE);
    expect(outcome.record.provenance?.effort).toBe("medium");

    expect(rawJudgment(judgmentId)).toEqual(before);

    const read = readRepairScript(db, judgmentId);
    expect(read?.content.when_it_goes_wrong.return_time).toContain("after dinner");
  });

  it("hands the faults back on the retry, and stores nothing when they stand", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client, calls } = mockClient(() =>
      script({ opening_line: "You always do this when I am busy, and I hate it." }),
    );

    const outcome = await generateRepairScript(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.attempts).toBe(2);
    expect(calls[1].prompt).toContain("rejected by the server");
    expect(calls[1].prompt).toContain("You always");
    expect(readRepairScript(db, judgmentId)).toBeNull();
    expect(db.select().from(repairScripts).all()).toHaveLength(0);
  });

  it("will not derive one from a draft", () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
      surfaceLayer: clientNarrative(),
    });

    expect(() =>
      persistRepairScript(db, draft.id, normalizeRepairScript(draft.id, script()), {
        model: "claude-fable-5",
      }),
    ).toThrow(RepairScriptError);
  });

  it("does not write over the sentence a human decided to say", () => {
    const { judgmentId } = seedFinalJudgment();
    const stored = persistRepairScript(
      db,
      judgmentId,
      normalizeRepairScript(judgmentId, script()),
      { model: "claude-fable-5", effort: "medium" },
    );

    db.update(repairScripts)
      .set({ humanFinal: "I want to talk about Wednesday.", confirmStatus: "edited" })
      .where(eq(repairScripts.id, stored.id))
      .run();

    expect(readRepairScript(db, judgmentId)?.text).toBe(
      "I want to talk about Wednesday.",
    );
    expect(() =>
      persistRepairScript(
        db,
        judgmentId,
        normalizeRepairScript(judgmentId, script()),
        { model: "claude-fable-5" },
      ),
    ).toThrow(/"edited"/);
  });

  it("re-derives in place while nobody has confirmed it", () => {
    const { judgmentId } = seedFinalJudgment();
    const first = persistRepairScript(
      db,
      judgmentId,
      normalizeRepairScript(judgmentId, script()),
      { model: "claude-fable-5" },
    );
    const second = persistRepairScript(
      db,
      judgmentId,
      normalizeRepairScript(
        judgmentId,
        script({
          when_it_goes_wrong: {
            pause_signal: "Either of us says “先停一下”.",
            flooding_self_check: "My pulse is up.",
            return_time: "Tomorrow morning.",
          },
        }),
      ),
      { model: "claude-fable-5" },
    );

    expect(second.id).toBe(first.id);
    expect(second.content.when_it_goes_wrong.return_time).toBe("Tomorrow morning.");
    expect(db.select().from(repairScripts).all()).toHaveLength(1);
  });
});
