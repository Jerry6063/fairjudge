/**
 * HARD RULE #1 — unconfirmed material is not citable, and an invalid
 * `evidence_ref` rejects the generation that produced it.
 *
 * The rule has two halves and this file drives both:
 *
 *   1. **Query layer.** A stage is only ever shown confirmed material, so an
 *      unconfirmed line cannot be cited by accident.
 *   2. **Validation layer.** Anything a model returns is checked against the
 *      database anyway, because the interesting failure is not an accident: it
 *      is a model that emits an id nobody showed it. Such a reference rejects
 *      the whole generation — one retry with the faults named, then an error.
 *
 * The assertion that matters most is the negative one, repeated in every case
 * below: **nothing is persisted**. A bad citation that is silently dropped, or
 * an item stripped out so the rest can be saved, would leave a clean-looking
 * list on screen with the failure erased — which is the exact outcome the rule
 * exists to prevent. So each rejection test also asserts the `issues` /
 * `adverse_facts` tables are still empty, and the mixed-list test asserts the
 * *good* item was thrown away along with the bad one.
 *
 * The model is a stub client injected into the gateway; nothing here touches
 * the network.
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
  type ConfirmStatus,
} from "../src/server/db/schema";
import { MODEL_FABLE } from "../src/server/llm/config";
import {
  EvidenceRefError,
  assertCitations,
  auditCitations,
  buildCitableBrief,
  checkEvidenceRefs,
  describeCitationFaults,
  generateAdverseFacts,
  generateIssues,
  listAdverseFacts,
  listIssues,
  renderBrief,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

function seedCase(): string {
  const [row] = db.insert(cases).values({ stage: "issue_framing" }).returning().all();
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

/**
 * Insert one utterance and return its id.
 *
 * The content is Chinese and stays Chinese: this is evidence, not copy
 * (CLAUDE.md — a record of what a person said is never translated).
 */
function addUtterance(
  caseId: string,
  text: string,
  confirmStatus: ConfirmStatus,
): string {
  const [row] = db
    .insert(utterances)
    .values({
      caseId,
      aiDraft: text,
      confirmStatus,
      humanFinal: confirmStatus === "edited" ? text : null,
    })
    .returning()
    .all();
  return row.id;
}

/* -------------------------------------------------------------------------- */
/* A stub provider                                                            */
/* -------------------------------------------------------------------------- */

function providerResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_FABLE,
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 800,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    _request_id: "req_test",
  };
}

/** The part of the outbound request body these tests read back. */
interface OutboundBody {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

/**
 * A client that answers with `replies` in order, repeating the last one when it
 * runs out. Returning the same bad answer twice is exactly the case the retry
 * budget exists for.
 */
function stubClient(replies: readonly unknown[]) {
  const create = vi.fn(async (_body: OutboundBody) => {
    const at = Math.min(create.mock.calls.length - 1, replies.length - 1);
    return providerResponse(JSON.stringify(replies[at]));
  });
  const client = {
    messages: { create },
    beta: { messages: { create } },
  } as unknown as Anthropic;
  return { client, create };
}

/** The three-list payload, with the two unused lists left empty. */
function issuePayload(
  items: readonly { statement: string; evidence_refs: readonly string[] }[],
) {
  return {
    undisputed_facts: items,
    disputes_of_fact: [],
    disputes_of_standard: [],
  };
}

/** Text of the user turns sent on the Nth call (1-based). */
function promptOfCall(
  create: ReturnType<typeof stubClient>["create"],
  nth: number,
): string {
  return create.mock.calls[nth - 1][0].messages
    .map((message) => message.content)
    .join("\n");
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* The query layer: what a stage is allowed to see                            */
/* -------------------------------------------------------------------------- */

describe("the brief a citing stage is written from", () => {
  it("contains confirmed and edited lines, and nothing else", () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行，你说得都对", "confirmed");
    const edited = addUtterance(caseId, "你会先跟我讲吗？", "edited");
    addUtterance(caseId, "我没说过这句", "pending");
    addUtterance(caseId, "这条已经删了", "rejected");

    const brief = buildCitableBrief(db, caseId);

    expect(brief.utterances.map((u) => u.id).sort()).toEqual(
      [confirmed, edited].sort(),
    );
    // The evidence block a model reads must not contain unconfirmed text at all.
    const rendered = renderBrief(brief);
    expect(rendered).toContain("行行行，你说得都对");
    expect(rendered).not.toContain("我没说过这句");
    expect(rendered).not.toContain("这条已经删了");
  });

  it("marks the submitting party as the client", () => {
    const caseId = seedCase();
    addUtterance(caseId, "行行行", "confirmed");

    const brief = buildCitableBrief(db, caseId);

    expect(brief.client?.pseudonym).toBe("乙");
    expect(renderBrief(brief)).toContain('"is_client": true');
  });

  it("is byte-stable across reads (prompt-cache discipline)", () => {
    const caseId = seedCase();
    addUtterance(caseId, "行行行", "confirmed");
    addUtterance(caseId, "你会先跟我讲吗？", "edited");

    expect(renderBrief(buildCitableBrief(db, caseId))).toBe(
      renderBrief(buildCitableBrief(db, caseId)),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The validator                                                              */
/* -------------------------------------------------------------------------- */

describe("checkEvidenceRefs", () => {
  it("accepts a confirmed or edited utterance of this case", () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行", "confirmed");
    const edited = addUtterance(caseId, "你会先跟我讲吗？", "edited");

    const check = checkEvidenceRefs(db, caseId, [confirmed, edited]);

    expect(check.ok).toBe(true);
    expect(check.valid).toEqual([confirmed, edited]);
    expect(check.rejected).toEqual([]);
  });

  it("rejects an id that exists nowhere", () => {
    const caseId = seedCase();
    addUtterance(caseId, "行行行", "confirmed");

    const check = checkEvidenceRefs(db, caseId, ["utt_does_not_exist"]);

    expect(check.ok).toBe(false);
    expect(check.valid).toEqual([]);
    expect(check.rejected[0].fault).toBe("unknown");
  });

  it.each<ConfirmStatus>(["pending", "rejected"])(
    "rejects a %s utterance, and says which status it found",
    (status) => {
      const caseId = seedCase();
      const unconfirmed = addUtterance(caseId, "我没说过这句", status);

      const check = checkEvidenceRefs(db, caseId, [unconfirmed]);

      expect(check.ok).toBe(false);
      expect(check.valid).toEqual([]);
      expect(check.rejected[0].fault).toBe("unconfirmed");
      expect(check.rejected[0].status).toBe(status);
      expect(check.rejected[0].detail).toContain(status);
    },
  );

  it("rejects a confirmed utterance that belongs to another case", () => {
    const mine = seedCase();
    const theirs = seedCase();
    const foreign = addUtterance(theirs, "别人的案子", "confirmed");

    const check = checkEvidenceRefs(db, mine, [foreign]);

    expect(check.ok).toBe(false);
    expect(check.rejected[0].fault).toBe("foreign_case");
  });

  it("rejects a value that is not an id at all", () => {
    const caseId = seedCase();

    const check = checkEvidenceRefs(db, caseId, [null, 42, "", "   "]);

    expect(check.ok).toBe(false);
    expect(check.rejected.map((r) => r.fault)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
  });

  it("collapses a repeated legal citation instead of failing it", () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行", "confirmed");

    const check = checkEvidenceRefs(db, caseId, [confirmed, confirmed]);

    expect(check.ok).toBe(true);
    expect(check.valid).toEqual([confirmed]);
  });
});

describe("auditCitations", () => {
  it("faults an item that cites nothing at all", () => {
    const caseId = seedCase();

    const audit = auditCitations(db, caseId, [
      { label: "undisputed_facts[0]", statement: "They argued.", evidenceRefs: [] },
    ]);

    expect(audit.ok).toBe(false);
    expect(audit.faults[0].uncited).toBe(true);
    expect(describeCitationFaults(audit)).toContain("cites no evidence at all");
  });

  it("fails the whole audit when one item of several is bad", () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行", "confirmed");

    const audit = auditCitations(db, caseId, [
      {
        label: "undisputed_facts[0]",
        statement: "Grounded item.",
        evidenceRefs: [confirmed],
      },
      {
        label: "disputes_of_fact[0]",
        statement: "Invented item.",
        evidenceRefs: ["utt_ghost"],
      },
    ]);

    expect(audit.ok).toBe(false);
    // The good item is still reported as accepted, but `ok` is what callers
    // branch on — a caller that persisted `accepted` on a failed audit would be
    // doing the partial save this rule forbids.
    expect(audit.accepted.map((a) => a.label)).toEqual(["undisputed_facts[0]"]);
    expect(describeCitationFaults(audit)).toContain("utt_ghost");
  });

  it("throws from assertCitations, carrying the audit", () => {
    const caseId = seedCase();

    expect(() =>
      assertCitations(db, caseId, [
        { label: "x[0]", statement: "Invented.", evidenceRefs: ["utt_ghost"] },
      ]),
    ).toThrow(EvidenceRefError);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: a generation that cites badly is thrown away                   */
/* -------------------------------------------------------------------------- */

describe("issue fixing rejects a generation with a bad citation", () => {
  it("rejects a fabricated evidence_ref and saves nothing", async () => {
    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const { client, create } = stubClient([
      issuePayload([
        { statement: "A claim resting on nothing.", evidence_refs: ["utt_ghost"] },
      ]),
    ]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("invalid_refs");
    if (result.kind !== "invalid_refs") throw new Error("unreachable");
    expect(result.attempts).toBe(2);
    expect(result.message).toContain("utt_ghost");
    expect(result.audit.faults[0].rejected[0].fault).toBe("unknown");

    // Retried once, with the fault named rather than a bare "try again".
    expect(create).toHaveBeenCalledTimes(2);
    expect(promptOfCall(create, 2)).toContain("utt_ghost");

    // The load-bearing assertion: the bad citation did not disappear into a
    // saved-but-shorter list. Nothing was written at all.
    expect(db.select().from(issues).where(eq(issues.caseId, caseId)).all()).toEqual(
      [],
    );
    expect(listIssues(db, caseId).total).toBe(0);
  });

  it("rejects a reference to an unconfirmed utterance and saves nothing", async () => {
    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对", "confirmed");
    // Real row, real id — and not citable, because no human has signed it off.
    const unconfirmed = addUtterance(caseId, "我没说过这句", "pending");

    const { client, create } = stubClient([
      issuePayload([
        {
          statement: "A claim resting on an unreviewed line.",
          evidence_refs: [unconfirmed],
        },
      ]),
    ]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("invalid_refs");
    if (result.kind !== "invalid_refs") throw new Error("unreachable");
    expect(result.audit.faults[0].rejected[0].fault).toBe("unconfirmed");
    expect(result.audit.faults[0].rejected[0].status).toBe("pending");
    expect(create).toHaveBeenCalledTimes(2);
    expect(listIssues(db, caseId).total).toBe(0);
  });

  it("throws away the good items too — there is no partial save", async () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const { client } = stubClient([
      {
        undisputed_facts: [
          { statement: "Properly grounded.", evidence_refs: [confirmed] },
        ],
        disputes_of_fact: [
          { statement: "Grounded in a ghost.", evidence_refs: ["utt_ghost"] },
        ],
        disputes_of_standard: [],
      },
    ]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("invalid_refs");
    expect(listIssues(db, caseId).total).toBe(0);
  });

  it("accepts a second attempt that fixes the citation", async () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const { client, create } = stubClient([
      issuePayload([{ statement: "Ungrounded.", evidence_refs: ["utt_ghost"] }]),
      issuePayload([
        { statement: "Grounded on the second try.", evidence_refs: [confirmed] },
      ]),
    ]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.attempts).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);

    const board = listIssues(db, caseId);
    expect(board.total).toBe(1);
    const [item] = board.lists.flatMap((list) => list.items);
    expect(item.aiDraft).toBe("Grounded on the second try.");
    expect(item.citations.map((c) => c.utteranceId)).toEqual([confirmed]);
    // The citation renders with the evidence verbatim, never translated.
    expect(item.citations[0].text).toBe("行行行，你说得都对");
    expect(item.citations[0].stale).toBe(false);
  });

  it("refuses to run at all when nothing in the case is confirmed", async () => {
    const caseId = seedCase();
    addUtterance(caseId, "我没说过这句", "pending");

    const { client, create } = stubClient([issuePayload([])]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("no_material");
    // No material means no egress: the model is never asked.
    expect(create).not.toHaveBeenCalled();
  });

  it("persists the validated ids, not the array the model returned", async () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const { client } = stubClient([
      issuePayload([
        {
          statement: "Cited twice, saved once.",
          evidence_refs: [confirmed, confirmed],
        },
      ]),
    ]);

    const result = await generateIssues(db, caseId, { llm: { client } });

    expect(result.kind).toBe("ok");
    const [row] = db.select().from(issues).where(eq(issues.caseId, caseId)).all();
    expect(row.evidenceRefs).toEqual([confirmed]);
  });
});

describe("adverse facts reject a generation with a bad citation", () => {
  it("rejects a fabricated evidence_ref and saves nothing", async () => {
    const caseId = seedCase();
    addUtterance(caseId, "你会先跟我讲吗？", "confirmed");

    const { client, create } = stubClient([
      {
        adverse_facts: [
          {
            statement: "You said something you cannot be shown to have said.",
            evidence_refs: ["utt_ghost"],
          },
        ],
      },
    ]);

    const result = await generateAdverseFacts(db, caseId, { llm: { client } });

    expect(result.kind).toBe("invalid_refs");
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      db.select().from(adverseFacts).where(eq(adverseFacts.caseId, caseId)).all(),
    ).toEqual([]);
  });

  it("rejects a reference to an unconfirmed utterance and saves nothing", async () => {
    const caseId = seedCase();
    addUtterance(caseId, "你会先跟我讲吗？", "confirmed");
    const unconfirmed = addUtterance(caseId, "我没说过这句", "pending");

    const { client } = stubClient([
      {
        adverse_facts: [
          {
            statement: "Held against you on an unreviewed line.",
            evidence_refs: [unconfirmed],
          },
        ],
      },
    ]);

    const result = await generateAdverseFacts(db, caseId, { llm: { client } });

    expect(result.kind).toBe("invalid_refs");
    if (result.kind !== "invalid_refs") throw new Error("unreachable");
    expect(result.audit.faults[0].rejected[0].fault).toBe("unconfirmed");
    expect(listAdverseFacts(db, caseId).items).toEqual([]);
  });

  it("persists a valid generation as pending acknowledgement", async () => {
    const caseId = seedCase();
    const confirmed = addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const { client } = stubClient([
      {
        adverse_facts: [
          {
            statement: 'You closed the conversation down with "行行行，你说得都对".',
            evidence_refs: [confirmed],
          },
        ],
      },
    ]);

    const result = await generateAdverseFacts(db, caseId, { llm: { client } });

    expect(result.kind).toBe("ok");
    const board = listAdverseFacts(db, caseId);
    expect(board.items).toHaveLength(1);
    expect(board.items[0].ackStatus).toBe("pending");
    expect(board.items[0].citations[0].utteranceId).toBe(confirmed);
    // Surfacing them is not clearing them: the gate is shut until they are
    // answered.
    expect(board.gate.open).toBe(false);
  });
});
