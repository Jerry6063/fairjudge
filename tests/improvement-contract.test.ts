/**
 * The improvement contract (SPEC M4 ②).
 *
 * The three things asserted here are the three ways this feature fails in every
 * product that has it:
 *
 *   1. **It says nothing.** "Communicate more" cannot be kept and cannot be
 *      broken, so the 7-day follow-up asking whether it happened has no
 *      question to ask. A vague item is refused item by item, and the whole
 *      contract is refused with it — nothing is trimmed, because a contract
 *      that quietly loses an item still reads as finished.
 *   2. **It binds somebody who was never asked.** This case was heard at L2:
 *      甲 gave no account and agreed to nothing. An item addressed to her is
 *      demoted to an invitation on the way in and labelled one, and the storage
 *      door refuses to write a commitment against her at all — the two halves
 *      of the same rule, tested separately, because only the second one is the
 *      invariant.
 *   3. **It rests on nothing.** An item citing a claim_id the frozen fact layer
 *      does not define is relationship advice wearing the judgment's authority.
 *      Refused, and nothing is stored.
 *
 * Plus the property M4 keeps having to prove: deriving a document from a frozen
 * judgment leaves that judgment byte-identical (HARD RULE #6).
 *
 * Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { caseParticipants, cases, improvementContracts } from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  improvementContractSchema,
  improvementContractStage,
  type ImprovementContractOutput,
} from "../src/server/llm/stages";
import {
  ImprovementContractError,
  boundPartiesAllowed,
  checkImprovementContract,
  createDraft,
  finalize,
  generateImprovementContract,
  normalizeImprovementContract,
  persistImprovementContract,
  readImprovementContract,
  renderImprovementContract,
  renderImprovementContractPrompt,
  resolveClaimProvenance,
  type FactLayer,
  type ImprovementContractContent,
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
/* Fixture — the real case's shape: 甲 spoke, 乙 brought the case             */
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

/** The client's copy of the judgment. Only here to prove it is not an input. */
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
          "both 甲's. The phrase that keeps recurring in this narrative is " +
          "PROSE-ONLY-MARKER.",
        claim_ids: [],
      },
    ],
  };
}

/** An item that survives every check: an occasion, an act, a visible result. */
function goodClientItem(
  overrides: Partial<ImprovementContractOutput["items"][number]> = {},
): ImprovementContractOutput["items"][number] {
  return {
    item_id: "k1",
    bound_party: "client",
    trigger:
      "when 甲 puts a date on something she is asking for, as in “我周三之前必须知道”",
    action:
      "I answer that evening with a yes, a no, or the date I will have an answer",
    observable:
      "she has a written reply from me before midnight on the day she asked",
    within_days: 3,
    claim_ids: ["c1"],
    ...overrides,
  };
}

/** The same shape, addressed to the party who was never heard. */
function counterpartyItem(
  overrides: Partial<ImprovementContractOutput["items"][number]> = {},
): ImprovementContractOutput["items"][number] {
  return {
    item_id: "k2",
    bound_party: "counterparty",
    trigger: "when she has asked something and has not heard back by the evening",
    action: "she says so once, in one message, rather than waiting",
    observable: "there is a message from her saying she is still waiting",
    within_days: 7,
    claim_ids: ["c1"],
    ...overrides,
  };
}

/** The failure mode this whole check exists for. */
function vagueItem(): ImprovementContractOutput["items"][number] {
  return {
    item_id: "k9",
    bound_party: "client",
    trigger: "in general, going forward",
    action: "communicate more and be more considerate",
    observable: "she feels heard",
    within_days: 7,
    claim_ids: ["c1"],
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
  return sqlite.prepare("SELECT * FROM judgments WHERE id = ?").get(judgmentId);
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
        input_tokens: 3000,
        output_tokens: 400,
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

describe("the improvement_contract stage", () => {
  it("runs fable at high effort against its own schema", () => {
    expect(improvementContractStage.name).toBe("improvement_contract");
    expect(improvementContractStage.model).toBe(MODEL_FABLE);
    expect(improvementContractStage.effort).toBe("high");
    expect(improvementContractStage.keepPseudonyms).toBe(true);
    expect(improvementContractStage.zodSchema).toBe(improvementContractSchema);
  });

  it("is built from the frozen fact layer, not from the judgment's prose", () => {
    const prompt = renderImprovementContractPrompt("L2", factLayer());

    // The skeleton is in it, quotes and ids and all.
    expect(prompt).toContain("我周三之前必须知道");
    expect(prompt).toContain("c1");
    expect(prompt).toContain("One-sided analysis");
    // Who may be bound travels with the level (the rule is enforced in code
    // regardless, but a model that is told it usually keeps it).
    expect(prompt).toContain("may_be_bound");
    expect(prompt).toContain("stored as an invitation");
    // And the narrative is nowhere near it.
    expect(prompt).not.toContain("PROSE-ONLY-MARKER");
  });

  it("sends the same bytes twice for the same judgment", () => {
    expect(renderImprovementContractPrompt("L2", factLayer())).toBe(
      renderImprovementContractPrompt("L2", factLayer()),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Who may be bound                                                           */
/* -------------------------------------------------------------------------- */

describe("who a contract may bind", () => {
  it("binds only the client anywhere the other party was not heard", () => {
    expect(boundPartiesAllowed("L1")).toEqual(["client", "counterparty"]);
    expect(boundPartiesAllowed("L2")).toEqual(["client"]);
    expect(boundPartiesAllowed("L3")).toEqual(["client"]);
    expect(boundPartiesAllowed("refused")).toEqual(["client"]);
  });

  it("demotes an item addressed to her to an invitation at L2", () => {
    const content = normalizeImprovementContract("j1", "L2", {
      items: [goodClientItem(), counterpartyItem()],
    });

    expect(content.items.map((item) => item.kind)).toEqual([
      "commitment",
      "invitation",
    ]);
    // The demotion is in the data, not only in the label: a product that
    // rewrites what a model asked for owes the record of having done it.
    expect(content.items[1].demoted_from_commitment).toBe(true);
    expect(content.items[1].bound_party).toBe("counterparty");
    // Nothing was dropped — "she is invited to X" is a true sentence where
    // "she will do X" is not.
    expect(content.items[1].action).toContain("she says so once");
  });

  it("keeps it a commitment at L1, where she was heard", () => {
    const content = normalizeImprovementContract("j1", "L1", {
      items: [counterpartyItem()],
    });
    expect(content.items[0].kind).toBe("commitment");
    expect(content.items[0].demoted_from_commitment).toBe(false);

    // And the check agrees: the rule is about whether she was heard, not a
    // blanket ban on ever binding her. At L1 the only thing missing is that
    // nobody undertook anything on the client's side.
    const rejection = checkImprovementContract(
      { level: "L1", factLayer: factLayer() },
      content,
    );
    expect(rejection?.message).toContain("Not one item binds the client");
    expect(rejection?.message).not.toContain("has not been heard");
    expect(
      checkImprovementContract(
        { level: "L1", factLayer: factLayer() },
        normalizeImprovementContract("j1", "L1", {
          items: [goodClientItem(), counterpartyItem()],
        }),
      ),
    ).toBeNull();
  });

  it("labels the invitation as one in the rendered contract", () => {
    const content = normalizeImprovementContract("j1", "L2", {
      items: [goodClientItem(), counterpartyItem()],
    });
    const text = renderImprovementContract(content, {
      counterpartyPseudonym: "甲",
    });

    expect(text).toContain("What you are committing to");
    expect(text).toContain("Invitations to 甲 — not commitments");
    expect(text).toContain("Recorded as an invitation, not a commitment");
    expect(text).toContain("has not been heard");
  });
});

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

const context = { level: "L2" as const, factLayer: factLayer() };

function check(items: ImprovementContractOutput["items"]) {
  return checkImprovementContract(
    context,
    normalizeImprovementContract("j1", "L2", { items }),
  );
}

describe("what a commitment has to be", () => {
  it("lets a concrete one through", () => {
    expect(check([goodClientItem()])).toBeNull();
  });

  it("rejects the vague one, and says why for each part of it", () => {
    const rejection = check([vagueItem()]);

    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("improvement_contract_violation");
    const paths = (rejection?.plan ?? []).map((fault) => fault.path);
    expect(paths).toContain("items[0].trigger");
    expect(paths).toContain("items[0].action");
    expect(paths).toContain("items[0].observable");
    expect(rejection?.message).toContain("communicate more");
    expect(rejection?.message).toContain("no occasion in its trigger");
    expect(rejection?.message).toContain("inside somebody's head");
  });

  it("rejects a disposition even when it is phrased warmly", () => {
    for (const action of [
      "be more considerate about her evenings",
      "work on my defensiveness",
      "try to answer her sooner",
      "make an effort to check in",
      "improve how we handle deadlines",
    ]) {
      const rejection = check([goodClientItem({ action })]);
      expect(rejection, action).not.toBeNull();
      expect(
        (rejection?.plan ?? []).some((fault) => fault.path === "items[0].action"),
        action,
      ).toBe(true);
    }
  });

  it("does not fire on an item that names an act in ordinary words", () => {
    for (const action of [
      "I send her one message saying what I decided, even if the answer is no",
      "I put the date she asked about in the shared calendar",
      "I read her message out loud before I reply to it",
    ]) {
      expect(check([goodClientItem({ action })]), action).toBeNull();
    }
  });

  it("insists the trigger names an occasion", () => {
    const rejection = check([
      goodClientItem({ trigger: "whenever possible, as often as I can" }),
    ]);
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("whenever possible");
    expect(rejection?.message).toContain("satisfied by whatever happened anyway");
  });

  it("insists the observation is observable", () => {
    const rejection = check([
      goodClientItem({ observable: "she understands that I was not avoiding her" }),
    ]);
    expect(rejection?.message).toContain("SEE or HEAR");
  });

  it("rejects a week that is not a week", () => {
    const content = normalizeImprovementContract("j1", "L2", {
      items: [goodClientItem()],
    });
    const stretched: ImprovementContractContent = {
      ...content,
      items: [{ ...content.items[0], within_days: 30 }],
    };
    const rejection = checkImprovementContract(context, stretched);
    expect(rejection?.message).toContain("30 day(s)");
  });

  it("rejects a contract in which the client is bound to nothing", () => {
    const rejection = check([counterpartyItem()]);
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("Not one item binds the client");
  });
});

describe("what a commitment has to rest on", () => {
  it("rejects an item citing a claim the frozen fact layer does not define", () => {
    const rejection = check([goodClientItem({ claim_ids: ["c1", "c7"] })]);

    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("improvement_contract_violation");
    expect(rejection?.message).toContain('cites claim_id "c7"');
    expect(rejection?.message).toContain("never checked against the evidence");
    expect((rejection?.plan ?? []).map((fault) => fault.path)).toContain(
      "items[0].claim_ids[1]",
    );
  });

  it("resolves cited ids to the claims themselves, for the screen", () => {
    const resolved = resolveClaimProvenance(factLayer(), ["c1", "c7"]);
    expect(resolved[0].statement).toContain("我周三之前必须知道");
    expect(resolved[0].tier).toBe("high_confidence");
    // A missing id is shown, not hidden: every write path refuses one, so its
    // presence on a screen means a row is out of step with its judgment.
    expect(resolved[1].statement).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

describe("generating a contract from a frozen judgment", () => {
  it("stores her item as an invitation and leaves the judgment untouched", async () => {
    const { judgmentId } = seedFinalJudgment();
    const before = rawJudgment(judgmentId);
    const { client } = mockClient(() => ({
      items: [goodClientItem(), counterpartyItem()],
    }));

    const outcome = await generateImprovementContract(db, judgmentId, {
      llm: { db, client },
      counterpartyPseudonym: "甲",
    });

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;

    expect(outcome.record.commitments).toHaveLength(1);
    expect(outcome.record.invitations).toHaveLength(1);
    expect(outcome.record.invitations[0].demoted_from_commitment).toBe(true);
    expect(outcome.record.text).toContain("Invitations to 甲 — not commitments");

    // The evidence travels through unchanged and untranslated.
    expect(outcome.record.text).toContain("我周三之前必须知道");

    // HARD RULE #6: the frozen row is not read for update, not touched, and
    // byte-identical afterwards.
    expect(rawJudgment(judgmentId)).toEqual(before);
  });

  it("carries the model's own faults back to it on the retry", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client, calls } = mockClient(() => ({ items: [vagueItem()] }));

    const outcome = await generateImprovementContract(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.rejection.code).toBe("improvement_contract_violation");

    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("rejected by the server");
    expect(calls[1].prompt).toContain("communicate more");

    // Nothing was stored, and nothing was half-stored.
    expect(readImprovementContract(db, judgmentId)).toBeNull();
    expect(db.select().from(improvementContracts).all()).toHaveLength(0);
  });

  it("refuses a contract that cites a claim the skeleton never made", async () => {
    const { judgmentId } = seedFinalJudgment();
    const { client } = mockClient(() => ({
      items: [goodClientItem({ claim_ids: ["c9"] })],
    }));

    const outcome = await generateImprovementContract(db, judgmentId, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.message).toContain('cites claim_id "c9"');
    expect(readImprovementContract(db, judgmentId)).toBeNull();
  });

  it("will not derive one from a draft", async () => {
    const caseId = seedCase();
    const draft = createDraft(db, caseId, {
      model: "claude-fable-5",
      factLayer: factLayer(),
      surfaceLayer: clientNarrative(),
    });
    const { client, calls } = mockClient(() => ({ items: [goodClientItem()] }));

    const outcome = await generateImprovementContract(db, draft.id, {
      llm: { db, client },
    });

    expect(outcome.kind).toBe("blocked");
    // And it did not spend a model call finding that out.
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The storage door                                                           */
/* -------------------------------------------------------------------------- */

describe("what may be written to improvement_contracts", () => {
  const provenance = { model: "claude-fable-5", effort: "high" as const };

  it("refuses a commitment binding the party who was never heard", () => {
    const { judgmentId } = seedFinalJudgment();

    // Hand-built: the generation path demotes this before it ever gets here,
    // which is exactly why the storage door has to refuse it independently.
    const forced: ImprovementContractContent = {
      version: 1,
      output_level: "L2",
      judgment_id: judgmentId,
      items: [
        {
          ...counterpartyItem(),
          kind: "commitment",
          claim_ids: ["c1"],
          demoted_from_commitment: false,
        },
        {
          ...goodClientItem(),
          kind: "commitment",
          claim_ids: ["c1"],
          demoted_from_commitment: false,
        },
      ],
    };

    let thrown: unknown = null;
    try {
      persistImprovementContract(db, judgmentId, forced, provenance);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ImprovementContractError);
    const error = thrown as ImprovementContractError;
    expect(error.code).toBe("contract_invalid");
    expect(error.message).toContain("commitment binding the counterparty");
    expect(error.faults.map((fault) => fault.path)).toContain("items[0].kind");
    expect(readImprovementContract(db, judgmentId)).toBeNull();
  });

  it("re-derives in place while the contract is still a draft", () => {
    const { judgmentId } = seedFinalJudgment();
    const first = persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", { items: [goodClientItem()] }),
      provenance,
    );
    const second = persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", {
        items: [goodClientItem({ item_id: "k5", within_days: 1 })],
      }),
      provenance,
    );

    expect(second.id).toBe(first.id);
    expect(second.content.items[0].item_id).toBe("k5");
    expect(db.select().from(improvementContracts).all()).toHaveLength(1);
    // Provenance is carried inside the JSON: the table has no model column and
    // M4 adds no migration for one.
    expect(second.content.generated_by?.model).toBe("claude-fable-5");
    expect(second.content.generated_by?.effort).toBe("high");
  });

  it("does not write over a contract somebody is living by", () => {
    const { judgmentId } = seedFinalJudgment();
    const stored = persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", { items: [goodClientItem()] }),
      provenance,
    );

    db.update(improvementContracts)
      .set({ status: "active" })
      .where(eq(improvementContracts.id, stored.id))
      .run();

    expect(() =>
      persistImprovementContract(
        db,
        judgmentId,
        normalizeImprovementContract(judgmentId, "L2", {
          items: [goodClientItem({ item_id: "k6" })],
        }),
        provenance,
      ),
    ).toThrow(/is "active"/);

    expect(readImprovementContract(db, judgmentId)?.content.items[0].item_id).toBe(
      "k1",
    );
  });

  it("prefers a human's edit when one exists", () => {
    const { judgmentId } = seedFinalJudgment();
    const stored = persistImprovementContract(
      db,
      judgmentId,
      normalizeImprovementContract(judgmentId, "L2", { items: [goodClientItem()] }),
      provenance,
    );

    db.update(improvementContracts)
      .set({ humanFinal: "The one thing I am actually going to do.", confirmStatus: "edited" })
      .where(eq(improvementContracts.id, stored.id))
      .run();

    const read = readImprovementContract(db, judgmentId);
    expect(read?.text).toBe("The one thing I am actually going to do.");
    // The structure is untouched by the edit — the items are still checkable.
    expect(read?.commitments).toHaveLength(1);
  });
});
