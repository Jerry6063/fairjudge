/**
 * The adverse-fact gate (SPEC M3 wave A ⑥) — the anti-"help me win" precondition.
 *
 * Judgment may not start while a fact that counts against the client is still
 * unanswered. This file drives that from three directions, because a gate with
 * one enforcement point is a gate with one bug away from being open:
 *
 *   - the pure predicate (`checkJudgmentGate`) over counts;
 *   - the stage machine, which refuses the transition into `judgment`;
 *   - `assertJudgmentAllowed`, read at the moment judgment is asked for, which
 *     is the one that still holds when a case row is already sitting in
 *     `judgment` and a new adverse fact appears behind it.
 *
 * The other half of the design is asserted here too: **contesting clears an
 * item exactly as acknowledging does.** The client is not required to agree,
 * only to have faced the material. A gate that opened only for agreement would
 * be coercion, and it would corrupt the record the judgment is written from.
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
  issues,
  utterances,
  type AckStatus,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  AdverseFactError,
  JudgmentBlockedError,
  StageMachineError,
  acknowledgeAdverseFact,
  advanceStage,
  assertJudgmentAllowed,
  canAdvance,
  checkJudgmentGate,
  collectCaseFacts,
  contestAdverseFact,
  countAdverseFacts,
  generateAdverseFacts,
  judgmentGateFor,
  listAdverseFacts,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

/**
 * A case parked at `pre_judgment` with everything entering `judgment` needs
 * EXCEPT the adverse-fact answers: one confirmed utterance, one settled issue,
 * and a locked output level. Whatever these tests then observe about the
 * transition is about the gate and nothing else.
 */
function seedCaseAtPreJudgment(): { caseId: string; utteranceId: string } {
  const [row] = db
    .insert(cases)
    .values({ stage: "pre_judgment", outputLevel: "L2", outputLevelLockedAt: new Date() })
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

  // Evidence content is verbatim Chinese — never translated (CLAUDE.md).
  const [utterance] = db
    .insert(utterances)
    .values({
      caseId: row.id,
      aiDraft: "行行行，你说得都对",
      confirmStatus: "confirmed",
    })
    .returning()
    .all();

  db.insert(issues)
    .values({
      caseId: row.id,
      category: "standard_dispute",
      aiDraft: "What counts as ending a conversation fairly.",
      evidenceRefs: [utterance.id],
      confirmStatus: "confirmed",
    })
    .run();

  return { caseId: row.id, utteranceId: utterance.id };
}

function addAdverseFact(
  caseId: string,
  utteranceId: string,
  ackStatus: AckStatus = "pending",
): string {
  const [row] = db
    .insert(adverseFacts)
    .values({
      caseId,
      aiDraft: 'You ended the exchange with "行行行，你说得都对" rather than answering it.',
      evidenceRefs: [utteranceId],
      ackStatus,
    })
    .returning()
    .all();
  return row.id;
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* The predicate                                                              */
/* -------------------------------------------------------------------------- */

describe("checkJudgmentGate", () => {
  it("is shut when no adverse fact has been surfaced at all", () => {
    const verdict = checkJudgmentGate({ total: 0, pending: 0 });

    expect(verdict.open).toBe(false);
    if (verdict.open) throw new Error("unreachable");
    // Zero rows means zero pending, so a gate that only counted pending items
    // would swing open on a case that never ran the pass.
    expect(verdict.code).toBe("not_surfaced");
  });

  it("is shut while any item is pending, and says how many", () => {
    const verdict = checkJudgmentGate({ total: 3, pending: 2 });

    expect(verdict.open).toBe(false);
    if (verdict.open) throw new Error("unreachable");
    expect(verdict.code).toBe("acknowledgement_pending");
    expect(verdict.reason).toContain("2 of 3");
  });

  it("is open once everything surfaced has been answered", () => {
    expect(checkJudgmentGate({ total: 3, pending: 0 }).open).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The gate over a real case                                                  */
/* -------------------------------------------------------------------------- */

describe("judgment is blocked while an adverse fact is pending", () => {
  it("refuses at the judgment entry point, and names the reason", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    addAdverseFact(caseId, utteranceId);

    expect(countAdverseFacts(db, caseId)).toEqual({ total: 1, pending: 1 });
    expect(judgmentGateFor(db, caseId).open).toBe(false);
    expect(() => assertJudgmentAllowed(db, caseId)).toThrow(JudgmentBlockedError);
    expect(() => assertJudgmentAllowed(db, caseId)).toThrow(/acknowledged or contested/);
  });

  it("refuses the stage transition into judgment, and does not move the row", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    addAdverseFact(caseId, utteranceId);

    const decision = canAdvance(collectCaseFacts(db, caseId), "judgment");
    expect(decision.allowed).toBe(false);
    expect(
      decision.requirements
        .filter((requirement) => !requirement.satisfied)
        .map((requirement) => requirement.id),
    ).toEqual(["adverse_facts_acknowledged"]);

    expect(() => advanceStage(db, caseId, "judgment")).toThrow(StageMachineError);
    expect(
      db.select().from(cases).where(eq(cases.id, caseId)).get()?.stage,
    ).toBe("pre_judgment");
  });

  it("refuses when the adverse-fact pass never ran", () => {
    const { caseId } = seedCaseAtPreJudgment();

    expect(judgmentGateFor(db, caseId).open).toBe(false);
    expect(canAdvance(collectCaseFacts(db, caseId), "judgment").allowed).toBe(false);
    expect(() => assertJudgmentAllowed(db, caseId)).toThrow(/never been confronted/);
  });

  it("blocks again when a later pass surfaces a new pending fact", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const answered = addAdverseFact(caseId, utteranceId);
    acknowledgeAdverseFact(db, { caseId, adverseFactId: answered });
    expect(judgmentGateFor(db, caseId).open).toBe(true);

    // A case can be sitting in `judgment` when this happens, which is why the
    // gate is read at the moment of use rather than inferred from the stage.
    advanceStage(db, caseId, "judgment");
    addAdverseFact(caseId, utteranceId);

    expect(judgmentGateFor(db, caseId).open).toBe(false);
    expect(() => assertJudgmentAllowed(db, caseId)).toThrow(JudgmentBlockedError);
  });
});

/* -------------------------------------------------------------------------- */
/* Clearing the gate                                                          */
/* -------------------------------------------------------------------------- */

describe("the gate opens once every adverse fact has an answer", () => {
  it("opens when the client acknowledges", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const id = addAdverseFact(caseId, utteranceId);

    const updated = acknowledgeAdverseFact(db, {
      caseId,
      adverseFactId: id,
      note: "我确实是这么说的",
    });

    expect(updated.ackStatus).toBe("acknowledged");
    expect(updated.ackNote).toBe("我确实是这么说的");
    expect(updated.ackedAt).not.toBeNull();
    expect(judgmentGateFor(db, caseId).open).toBe(true);
    expect(() => assertJudgmentAllowed(db, caseId)).not.toThrow();
  });

  it("opens when the client contests instead — agreement is not required", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const id = addAdverseFact(caseId, utteranceId);

    const updated = contestAdverseFact(db, {
      caseId,
      adverseFactId: id,
      note: "那句话是在她说完之后我才回的",
    });

    expect(updated.ackStatus).toBe("disputed");
    // Contesting keeps the item in the record with the rebuttal attached; it
    // does not delete it, and it does not mark the text as rejected.
    expect(updated.confirmStatus).toBe("pending");
    expect(judgmentGateFor(db, caseId).open).toBe(true);
  });

  it("opens on a mixture of acknowledged and contested items", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const first = addAdverseFact(caseId, utteranceId);
    const second = addAdverseFact(caseId, utteranceId);
    const third = addAdverseFact(caseId, utteranceId);

    acknowledgeAdverseFact(db, { caseId, adverseFactId: first });
    contestAdverseFact(db, {
      caseId,
      adverseFactId: second,
      note: "这不是我说的",
    });
    expect(judgmentGateFor(db, caseId).open).toBe(false);

    acknowledgeAdverseFact(db, { caseId, adverseFactId: third });

    const board = listAdverseFacts(db, caseId);
    expect(board.acknowledged).toBe(2);
    expect(board.contested).toBe(1);
    expect(board.counts.pending).toBe(0);
    expect(board.gate.open).toBe(true);
    expect(() => assertJudgmentAllowed(db, caseId)).not.toThrow();
  });

  it("lets the stage machine move into judgment once everything is answered", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const id = addAdverseFact(caseId, utteranceId);
    acknowledgeAdverseFact(db, { caseId, adverseFactId: id });

    expect(canAdvance(collectCaseFacts(db, caseId), "judgment").allowed).toBe(true);
    expect(advanceStage(db, caseId, "judgment").to).toBe("judgment");
    expect(
      db.select().from(cases).where(eq(cases.id, caseId)).get()?.stage,
    ).toBe("judgment");
  });

  it("refuses a contest with no reason — an empty answer is not an answer", () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const id = addAdverseFact(caseId, utteranceId);

    expect(() =>
      contestAdverseFact(db, { caseId, adverseFactId: id, note: "   " }),
    ).toThrow(AdverseFactError);
    // The gate did not budge, which is the point: contesting is a position, and
    // an empty one would be a way through without engaging.
    expect(judgmentGateFor(db, caseId).open).toBe(false);
  });

  it("refuses to answer an item belonging to another case", () => {
    const mine = seedCaseAtPreJudgment();
    const theirs = seedCaseAtPreJudgment();
    const id = addAdverseFact(theirs.caseId, theirs.utteranceId);

    expect(() =>
      acknowledgeAdverseFact(db, { caseId: mine.caseId, adverseFactId: id }),
    ).toThrow(AdverseFactError);
    expect(
      db.select().from(adverseFacts).where(eq(adverseFacts.id, id)).get()?.ackStatus,
    ).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* Regeneration cannot erase an answer                                        */
/* -------------------------------------------------------------------------- */

describe("regenerating adverse facts keeps the answers already given", () => {
  it("replaces only the unanswered items", async () => {
    const { caseId, utteranceId } = seedCaseAtPreJudgment();
    const answered = addAdverseFact(caseId, utteranceId);
    const unanswered = addAdverseFact(caseId, utteranceId);
    contestAdverseFact(db, {
      caseId,
      adverseFactId: answered,
      note: "这句话是有前因的",
    });

    const create = vi.fn(async () => ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL_FABLE,
      stop_reason: "end_turn",
      stop_details: null,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            adverse_facts: [
              {
                statement: "You did not answer the question that was put to you.",
                evidence_refs: [utteranceId],
              },
            ],
          }),
        },
      ],
      usage: {
        input_tokens: 700,
        output_tokens: 150,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: null,
      },
      _request_id: "req_test",
    }));
    const client = {
      messages: { create },
      beta: { messages: { create } },
    } as unknown as Anthropic;

    const result = await generateAdverseFacts(db, caseId, { llm: { client } });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.replaced).toBe(1);

    const ids = result.board.items.map((item) => item.id);
    expect(ids).toContain(answered);
    expect(ids).not.toContain(unanswered);

    // A fresh pending item shuts the gate again, on purpose: it has not been
    // put to the client yet.
    expect(result.board.contested).toBe(1);
    expect(result.board.counts.pending).toBe(1);
    expect(result.board.gate.open).toBe(false);
  });
});
