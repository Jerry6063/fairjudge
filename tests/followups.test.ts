/**
 * The 7 / 30-day follow-up loop (SPEC M4 ④).
 *
 * The failure this feature exists to prevent is silence: a check-in whose due
 * date passed while the laptop was shut, that never fired, never errored, and
 * left no trace. Every test below is aimed at that, not at the happy path:
 *
 *   1. A follow-up that came due while the process was down **fires at next
 *      start** — and its window is still measured from the freeze, so catching
 *      up late does not quietly make it on time.
 *   2. It **shows as overdue in the query the UI renders**, including when the
 *      reason it has nothing to show is that generation failed.
 *   3. It **fires exactly once**: the launchd timer landing on top of the
 *      application-start catch-up must not buy the same batch twice.
 *   4. The **submit → poll → retrieve** path is exercised end to end against a
 *      fake provider, including results arriving in the wrong order, an errored
 *      request, and a refusal.
 *   5. The questions ask about **behaviour, not feelings** — enforced in code,
 *      so a model that ignores the prompt is rejected rather than believed.
 *
 * The clock is injected everywhere. Nothing here waits, and nothing here talks
 * to a network.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  cases,
  egressLedger,
  followups,
  improvementContracts,
  llmCalls,
} from "../src/server/db/schema";
import { sha256Hex } from "../src/server/llm/ledger";
import {
  FOLLOWUP_OFFSETS_MS,
  batchCostUsd,
  catchUpSchedule,
  checkFollowupQuestions,
  claimDueFollowups,
  extractCommitments,
  linkImprovementContract,
  listFollowups,
  listOverdueFollowups,
  runDueFollowups,
  scheduleFollowupsForJudgment,
  type BatchEntry,
  type BatchRequest,
  type BatchTransport,
  type FollowupQuestionSet,
} from "../src/server/followups";
import { createDraft, finalize, type FactLayer, type SurfaceLayer } from "../src/server/judgment";

let db: Db;
let sqlite: Database.Database;

/** The moment the fixture judgment is frozen. Everything is relative to it. */
const FROZE_AT = Date.parse("2026-06-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: "甲 set a deadline and treated it as already agreed.",
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
        statement: "Two confirmed lines, both 甲's. 乙 has not spoken inside the record.",
      },
      unresolved: [
        {
          question: "What did 乙 say that evening?",
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [
        { party: "甲", allocation: "contributing", claim_ids: ["c1"] },
        { party: "乙", allocation: "not_established", claim_ids: ["c2"] },
      ],
    },
  };
}

function surfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        audience: "both",
        heading: "What the record shows",
        text: "甲 stated a deadline in writing: “我周三之前必须知道”.",
        claim_ids: ["c1"],
      },
    ],
  };
}

/** A case with a judgment frozen at `FROZE_AT`, and its two check-ins. */
function seedFrozenCase(options: { readonly schedule?: boolean } = {}): {
  caseId: string;
  judgmentId: string;
} {
  const [row] = db
    .insert(cases)
    .values({
      stage: "judgment",
      title: "fixture",
      outputLevel: "L2",
      outputLevelLockedAt: new Date(FROZE_AT),
    })
    .returning()
    .all();

  vi.useFakeTimers();
  vi.setSystemTime(new Date(FROZE_AT));
  const draft = createDraft(db, row.id, {
    model: "claude-fable-5",
    effort: "xhigh",
    promptVersion: "judgment_skeleton.v1",
    factLayer: factLayer(),
    surfaceLayer: surfaceLayer(),
  });
  finalize(db, draft.id);
  vi.useRealTimers();

  if (options.schedule !== false) {
    scheduleFollowupsForJudgment(db, draft.id, { now: FROZE_AT });
  }
  return { caseId: row.id, judgmentId: draft.id };
}

function seedContract(caseId: string, judgmentId: string): string {
  const [row] = db
    .insert(improvementContracts)
    .values({
      caseId,
      judgmentId,
      status: "active",
      content: {
        commitments: [
          {
            commitment_id: "k1",
            action: "Say the deadline out loud before treating it as agreed.",
            claim_ids: ["c1"],
          },
        ],
        invitations: [
          { commitment_id: "i1", action: "甲 could answer within the day.", claim_ids: ["c1"] },
        ],
      },
    })
    .returning()
    .all();
  return row.id;
}

/* -------------------------------------------------------------------------- */
/* A fake provider                                                            */
/* -------------------------------------------------------------------------- */

const GOOD_SET: FollowupQuestionSet = {
  opening: "Seven days on, three questions about what actually happened.",
  questions: [
    {
      question_id: "q1",
      commitment_id: "k1",
      claim_refs: ["c1"],
      asks_about: "action_taken",
      question: "On how many occasions did you say the deadline out loud before acting on it?",
      answer_format: "count",
    },
    {
      question_id: "q2",
      commitment_id: null,
      claim_refs: ["c1"],
      asks_about: "noticed_by_other",
      question: "Did 甲 say or do anything different in response?",
      answer_format: "short_text",
    },
    {
      question_id: "q3",
      commitment_id: null,
      claim_refs: ["c1", "c2"],
      asks_about: "pattern_recurred",
      question: "Did a deadline get treated as agreed again without being stated?",
      answer_format: "yes_no",
    },
  ],
};

interface FakeOptions {
  /** Statuses returned by successive `retrieve` calls; the last one repeats. */
  readonly statuses?: readonly string[];
  /** Build the results for a submitted batch. Defaults to one success each. */
  readonly build?: (requests: readonly BatchRequest[]) => BatchEntry[];
  /** Throw instead of accepting the batch. An `Error` is thrown as given. */
  readonly failCreate?: string | Error;
  /** Throw on every status check, as an unreachable provider would. */
  readonly failRetrieve?: string;
  /** Accept and finish the batch, then fail to hand the results over. */
  readonly failResults?: string;
}

/** A dropped connection: no status, no abort, nothing came back. */
function connectionDrop(): Error {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function abortError(): Error {
  return Object.assign(new Error("Request was aborted."), { name: "AbortError" });
}

function succeeded(customId: string, body: unknown = GOOD_SET): BatchEntry {
  return {
    customId,
    type: "succeeded",
    text: JSON.stringify(body),
    stopReason: "end_turn",
    stopCategory: null,
    model: "claude-opus-4-8",
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

class FakeProvider implements BatchTransport {
  /**
   * Every envelope handed to `create`, accepted or not — the transport's view
   * of what left the process, which is the thing the ledger is checked against.
   */
  readonly attempted: BatchRequest[][] = [];
  /** The envelopes `create` accepted. */
  readonly submitted: BatchRequest[][] = [];
  retrieves = 0;
  resultReads = 0;
  private readonly options: FakeOptions;
  private nextId = 1;
  private results_ = new Map<string, BatchEntry[]>();

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  async create(requests: readonly BatchRequest[]): Promise<{ id: string; processingStatus: string }> {
    this.attempted.push([...requests]);
    if (this.options.failCreate !== undefined) {
      throw typeof this.options.failCreate === "string"
        ? new Error(this.options.failCreate)
        : this.options.failCreate;
    }
    this.submitted.push([...requests]);
    const id = `msgbatch_${this.nextId++}`;
    const build = this.options.build ?? ((rs) => rs.map((r) => succeeded(r.customId)));
    this.results_.set(id, build(requests));
    return { id, processingStatus: "in_progress" };
  }

  async retrieve(batchId: string): Promise<{ id: string; processingStatus: string }> {
    if (this.options.failRetrieve !== undefined) {
      this.retrieves += 1;
      throw new Error(this.options.failRetrieve);
    }
    const statuses = this.options.statuses ?? ["ended"];
    const status = statuses[Math.min(this.retrieves, statuses.length - 1)];
    this.retrieves += 1;
    return { id: batchId, processingStatus: status };
  }

  async results(batchId: string): Promise<readonly BatchEntry[]> {
    this.resultReads += 1;
    if (this.options.failResults !== undefined) throw new Error(this.options.failResults);
    return this.results_.get(batchId) ?? [];
  }
}

/** Never sleeps; the polling budget is exercised without wall-clock time. */
const noSleep = async (): Promise<void> => {};

/* -------------------------------------------------------------------------- */
/* Scheduling at freeze time                                                  */
/* -------------------------------------------------------------------------- */

describe("scheduling at freeze time", () => {
  it("writes a 7-day and a 30-day row measured from the freeze", () => {
    const { caseId } = seedFrozenCase();
    const rows = listFollowups(db, caseId, FROZE_AT);

    expect(rows.map((r) => r.kind)).toEqual(["day7", "day30"]);
    expect(rows[0].scheduledAt.getTime()).toBe(FROZE_AT + FOLLOWUP_OFFSETS_MS.day7);
    expect(rows[1].scheduledAt.getTime()).toBe(FROZE_AT + FOLLOWUP_OFFSETS_MS.day30);
    expect(rows.every((r) => r.generationStatus === "pending")).toBe(true);
    expect(rows.every((r) => r.judgmentId !== null)).toBe(true);
  });

  it("is idempotent — scheduling twice does not duplicate or move a row", () => {
    const { caseId, judgmentId } = seedFrozenCase();
    scheduleFollowupsForJudgment(db, judgmentId, { now: FROZE_AT + 3 * DAY });
    scheduleFollowupsForJudgment(db, judgmentId, { now: FROZE_AT + 5 * DAY });

    const rows = listFollowups(db, caseId, FROZE_AT);
    expect(rows).toHaveLength(2);
    // The window still belongs to the freeze, not to whenever someone re-ran it.
    expect(rows[0].scheduledAt.getTime()).toBe(FROZE_AT + FOLLOWUP_OFFSETS_MS.day7);
  });

  it("refuses a draft, because the window is measured from a freeze", () => {
    const [row] = db
      .insert(cases)
      .values({
        stage: "judgment",
        title: "fixture",
        outputLevel: "L2",
        outputLevelLockedAt: new Date(FROZE_AT),
      })
      .returning()
      .all();
    const draft = createDraft(db, row.id, {
      model: "claude-fable-5",
      factLayer: factLayer(),
    });

    expect(() => scheduleFollowupsForJudgment(db, draft.id)).toThrowError(/draft/);
    expect(listFollowups(db, row.id, FROZE_AT)).toHaveLength(0);
  });

  it("attaches an improvement contract written after the judgment froze", () => {
    const { caseId, judgmentId } = seedFrozenCase();
    expect(listFollowups(db, caseId, FROZE_AT)[0].improvementContractId).toBeNull();

    const contractId = seedContract(caseId, judgmentId);
    expect(linkImprovementContract(db, caseId, contractId)).toBe(2);
    expect(listFollowups(db, caseId, FROZE_AT)[0].improvementContractId).toBe(contractId);
  });
});

/* -------------------------------------------------------------------------- */
/* Catch-up                                                                   */
/* -------------------------------------------------------------------------- */

describe("catch-up after the process was down", () => {
  it("schedules a frozen judgment the freeze path missed, still anchored to the freeze", () => {
    const { caseId } = seedFrozenCase({ schedule: false });
    expect(listFollowups(db, caseId, FROZE_AT)).toHaveLength(0);

    // Nine days later, someone opens the laptop.
    const now = FROZE_AT + 9 * DAY;
    catchUpSchedule(db, { now });

    const rows = listFollowups(db, caseId, now);
    expect(rows).toHaveLength(2);
    // Not re-anchored to "now" — the 7-day check-in is two days late and says so.
    expect(rows[0].scheduledAt.getTime()).toBe(FROZE_AT + FOLLOWUP_OFFSETS_MS.day7);
    expect(rows[0].dueState).toBe("overdue");
    expect(rows[0].overdueByDays).toBe(2);
  });

  it("fires a follow-up whose due time passed while the process was down", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const provider = new FakeProvider();

    // The 7-day check-in came due two days ago; nothing ran in between.
    const now = FROZE_AT + 9 * DAY;
    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.claimed).toBe(1);
    expect(summary.ready).toBe(1);
    expect(summary.failed).toBe(0);
    expect(provider.submitted).toHaveLength(1);

    const rows = listFollowups(db, caseId, now);
    expect(rows[0].generationStatus).toBe("ready");
    expect(rows[0].answerable).toBe(true);
    expect((rows[0].questions as FollowupQuestionSet).questions.map((q) => q.question_id)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
    // The 30-day check-in is not due and was not touched.
    expect(rows[1].generationStatus).toBe("pending");
  });

  it("fires exactly once when two runs overlap", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const provider = new FakeProvider();
    const now = FROZE_AT + 9 * DAY;

    const first = await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });
    const second = await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0);
    // The second run bought nothing: one batch, one submitted request, ever.
    expect(provider.submitted).toHaveLength(1);
    expect(provider.submitted[0]).toHaveLength(1);

    const rows = listFollowups(db, caseId, now);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].generationStatus).toBe("ready");
  });

  it("claims nothing before the due date", async () => {
    seedFrozenCase();
    const provider = new FakeProvider();
    const summary = await runDueFollowups(db, {
      now: FROZE_AT + 6 * DAY,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.claimed).toBe(0);
    expect(provider.submitted).toHaveLength(0);
    expect(claimDueFollowups(db, { now: FROZE_AT + 6 * DAY })).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The UI query                                                               */
/* -------------------------------------------------------------------------- */

describe("what the UI sees", () => {
  it("shows a missed check-in as overdue, with how late it is", () => {
    const { caseId } = seedFrozenCase();
    const now = FROZE_AT + 12 * DAY;

    const rows = listFollowups(db, caseId, now);
    expect(rows[0].dueState).toBe("overdue");
    expect(rows[0].overdueByDays).toBe(5);
    expect(rows[1].dueState).toBe("upcoming");

    const overdue = listOverdueFollowups(db, now);
    expect(overdue.map((r) => r.id)).toEqual([rows[0].id]);
  });

  it("marks an overdue check-in with no questions as needing attention", async () => {
    const { caseId } = seedFrozenCase();
    const now = FROZE_AT + 9 * DAY;

    // Generation fails: the row is late AND has nothing to answer.
    const provider = new FakeProvider({
      build: (requests) =>
        requests.map((request) => ({
          customId: request.customId,
          type: "errored" as const,
          message: "batch request errored: overloaded",
        })),
    });
    await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });

    const rows = listFollowups(db, caseId, now);
    expect(rows[0].dueState).toBe("overdue");
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].answerable).toBe(false);
    // The reason is on the row, not only in a log.
    expect(rows[0].lastError).toContain("overloaded");
  });

  it("stops calling a check-in overdue once it is answered or skipped", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;
    await runDueFollowups(db, {
      now,
      transport: new FakeProvider(),
      poll: { sleep: noSleep },
    });

    const { completeFollowup, skipFollowup } = await import("../src/server/followups");
    const rows = listFollowups(db, caseId, now);
    completeFollowup(db, rows[0].id, { q1: "2" }, now);
    skipFollowup(db, rows[1].id);

    const after = listFollowups(db, caseId, now);
    expect(after.map((r) => r.dueState)).toEqual(["completed", "skipped"]);
    expect(listOverdueFollowups(db, now)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The batch round trip                                                       */
/* -------------------------------------------------------------------------- */

describe("the Message Batches round trip", () => {
  it("submits an opus request with no fallbacks parameter (Batches rejects it)", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const provider = new FakeProvider();
    const now = FROZE_AT + 8 * DAY;

    await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });

    const [request] = provider.submitted[0];
    expect(request.params.model).toBe("claude-opus-4-8");
    // Not available on the Batches API, and opus does not need it.
    expect(request.params).not.toHaveProperty("fallbacks");
    expect(request.params).not.toHaveProperty("betas");
    // No sampling knobs, ever (HARD RULE #7).
    expect(request.params).not.toHaveProperty("temperature");
    expect(request.params.thinking).toEqual({ type: "adaptive" });
    expect(request.params.output_config).toMatchObject({ effort: "medium" });

    // The custom_id is the row id — that is how an unordered result finds home.
    const rows = listFollowups(db, caseId, now);
    expect(request.customId).toBe(rows[0].id);
    expect(rows[0].batchId).toBe("msgbatch_1");
  });

  it("polls until the batch ends", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const provider = new FakeProvider({
      statuses: ["in_progress", "in_progress", "ended"],
    });

    const summary = await runDueFollowups(db, {
      now: FROZE_AT + 8 * DAY,
      transport: provider,
      poll: { sleep: noSleep, intervalMs: 1 },
    });

    expect(provider.retrieves).toBe(3);
    expect(provider.resultReads).toBe(1);
    expect(summary.ready).toBe(1);
  });

  it("leaves the rows submitted when the poll budget runs out, and collects them next run", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 8 * DAY;

    const stalling = new FakeProvider({ statuses: ["in_progress"] });
    const first = await runDueFollowups(db, {
      now,
      transport: stalling,
      poll: { sleep: noSleep, maxPolls: 2 },
    });

    expect(first.pending).toBe(true);
    expect(first.ready).toBe(0);
    const midRun = listFollowups(db, caseId, now)[0];
    expect(midRun.generationStatus).toBe("submitted");
    expect(midRun.batchId).toBe("msgbatch_1");
    // Still visible as a problem while it is in flight.
    expect(midRun.needsAttention).toBe(true);

    // The batch finishes; the next run collects it without paying again.
    const finishing = new FakeProvider();
    finishing.create([{ customId: midRun.id, params: {} }]); // pre-seed msgbatch_1
    const second = await runDueFollowups(db, {
      now,
      transport: finishing,
      poll: { sleep: noSleep },
    });

    expect(second.resumed).toBe(1);
    expect(listFollowups(db, caseId, now)[0].generationStatus).toBe("ready");
  });

  it("keys results by custom_id, not by position", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    // Both check-ins are due at once.
    const now = FROZE_AT + 31 * DAY;

    const provider = new FakeProvider({
      build: (requests) =>
        [...requests]
          .reverse()
          .map((request, index) =>
            succeeded(request.customId, {
              ...GOOD_SET,
              opening: `reversed-${index}-${request.customId}`,
            }),
          ),
    });

    const summary = await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });
    expect(summary.ready).toBe(2);

    for (const row of listFollowups(db, caseId, now)) {
      const stored = row.questions as FollowupQuestionSet;
      expect(stored.opening).toContain(row.id);
    }
  });

  it("records the egress at submit and backfills batch-priced usage on the same row", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 8 * DAY;

    await runDueFollowups(db, { now, transport: new FakeProvider(), poll: { sleep: noSleep } });

    const calls = db.select().from(llmCalls).where(eq(llmCalls.caseId, caseId)).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].stage).toBe("followup_questions");
    expect(calls[0].inputTokens).toBe(1200);
    expect(calls[0].outputTokens).toBe(300);
    // Half price, because it went through the batch endpoint.
    expect(calls[0].costUsd).toBeCloseTo(
      batchCostUsd("claude-opus-4-8", {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }) as number,
      10,
    );
    expect(listFollowups(db, caseId, now)[0].llmCallId).toBe(calls[0].id);
  });

  it("retries a failed generation, then stops and stays visible", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;
    const failing = () =>
      new FakeProvider({ failCreate: "529 overloaded_error" });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const summary = await runDueFollowups(db, {
        now,
        transport: failing(),
        poll: { sleep: noSleep },
      });
      expect(summary.failed).toBe(1);
      const row = listFollowups(db, caseId, now)[0];
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toContain("529");
      expect(row.generationStatus).toBe(attempt < 3 ? "pending" : "failed");
    }

    // The budget is spent: nothing is claimed again, and the row still says why.
    const after = await runDueFollowups(db, {
      now,
      transport: failing(),
      poll: { sleep: noSleep },
    });
    expect(after.claimed).toBe(0);
    const row = listFollowups(db, caseId, now)[0];
    expect(row.dueState).toBe("overdue");
    expect(row.needsAttention).toBe(true);
  });

  it("treats a refusal as a failure with its category, never as content", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;

    const provider = new FakeProvider({
      build: (requests) =>
        requests.map((request) => ({
          customId: request.customId,
          type: "succeeded" as const,
          text: "",
          stopReason: "refusal",
          stopCategory: "cyber",
          model: "claude-opus-4-8",
          usage: {
            inputTokens: 10,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        })),
    });

    const summary = await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });
    expect(summary.ready).toBe(0);
    const row = listFollowups(db, caseId, now)[0];
    expect(row.questions).toBeNull();
    expect(row.lastError).toContain("cyber");
  });
});

/* -------------------------------------------------------------------------- */
/* What the ledger says when the batch does not come back                     */
/* -------------------------------------------------------------------------- */

/**
 * Payloads that left the process always produce their audit rows (HARD RULE #7).
 *
 * The submit used to mark every prepared row failed and return *before* the
 * recording loop, so a `create` that threw put N payloads on the wire and wrote
 * zero `llm_calls` and zero `egress_ledger` rows — the same defect fixed in
 * `claude.ts` (and, while it existed, in the OpenAI polish path), on the one
 * path that sends N of them at a time.
 *
 * The rows are per request, not per batch: the ledger's question is "what left
 * this machine", N distinct payloads left it, and one row for the envelope would
 * both under-report the privacy surface and lose the per-payload hashes that
 * make the ledger checkable.
 */
describe("a batch that did not come back", () => {
  it("writes one audit pair per prepared request when the submit throws", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    // Both check-ins are due at once, so two distinct payloads leave together.
    const now = FROZE_AT + 31 * DAY;

    const provider = new FakeProvider({ failCreate: connectionDrop() });
    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.failed).toBe(2);
    expect(provider.attempted[0]).toHaveLength(2);
    expect(provider.submitted).toHaveLength(0);

    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.caseId).toBe(caseId);
      expect(call.stage).toBe("followup_questions");
      expect(call.provider).toBe("anthropic");
      expect(call.model).toBe("claude-opus-4-8");
      expect(call.stopReason).toBe("no_response:transport_error");
      // Nothing came back, so nothing is claimed about what came back. Null is
      // "unknown"; a 0 here would read as "this call consumed nothing".
      expect(call.inputTokens).toBeNull();
      expect(call.outputTokens).toBeNull();
      expect(call.cacheReadInputTokens).toBeNull();
      expect(call.cacheCreationInputTokens).toBeNull();
      expect(call.costUsd).toBeNull();
      expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    }

    // Two payloads, two hashes — and they are the hashes of the two bodies the
    // transport was actually handed, not of the envelope they travelled in.
    const ledger = db.select().from(egressLedger).all();
    expect(ledger).toHaveLength(2);
    const hashes = ledger.map((row) => row.payloadSha256).sort();
    expect(new Set(hashes).size).toBe(2);
    expect(hashes).toEqual(
      provider.attempted[0]
        .map((request) => sha256Hex(JSON.stringify(request.params)))
        .sort(),
    );
    for (const row of ledger) {
      expect(row.target).toBe("anthropic");
      expect(row.payloadBytes).toBeGreaterThan(0);
      expect(calls.some((call) => call.id === row.llmCallId)).toBe(true);
    }

    // And the check-ins themselves still say why they have no questions.
    for (const row of listFollowups(db, caseId, now)) {
      expect(row.lastError).toContain("socket hang up");
    }
  });

  it("distinguishes an aborted submit from a transport error", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;

    await runDueFollowups(db, {
      now,
      transport: new FakeProvider({ failCreate: abortError() }),
      poll: { sleep: noSleep },
    });

    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].stopReason).toBe("no_response:aborted");
    expect(db.select().from(egressLedger).all()).toHaveLength(1);
  });

  /**
   * The mirror image, and the reason this is not "record on every throw": the
   * SDK raises this before it builds a request, so no byte reached a socket. The
   * ledger may under-claim a connection it cannot confirm died; it may never
   * invent a send.
   */
  it("records nothing when the SDK refused to dispatch the batch", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 31 * DAY;

    const provider = new FakeProvider({
      failCreate: new Error(
        "Could not resolve authentication method. Expected one of apiKey, " +
          "authToken, credentials, config, or profile to be set.",
      ),
    });
    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.failed).toBe(2);
    expect(provider.attempted[0]).toHaveLength(2);
    expect(db.select().from(llmCalls).all()).toHaveLength(0);
    expect(db.select().from(egressLedger).all()).toHaveLength(0);
    // Silent in the ledger is not silent in the product: the rows still say why.
    for (const row of listFollowups(db, caseId, now)) {
      expect(row.lastError).toContain("authentication");
    }
  });

  it("says so on the row when the audit write itself fails", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;

    // A database that cannot take the audit write. `recordCall` is the only
    // thing in this run that needs a transaction (`skipSchedule` keeps the
    // catch-up sweep out of it), so this breaks the ledger write and nothing
    // else. The submit had already failed; what must not happen is that the
    // ledger gap goes unmentioned.
    const brokenDb = Object.create(db, {
      transaction: {
        value: () => {
          throw new Error("database is locked");
        },
      },
    }) as Db;

    const summary = await runDueFollowups(brokenDb, {
      now,
      transport: new FakeProvider({ failCreate: connectionDrop() }),
      poll: { sleep: noSleep },
      skipSchedule: true,
    });

    expect(summary.notes.join(" ")).toContain("ledger write failed");
    const row = listFollowups(db, caseId, now)[0];
    expect(row.lastError).toContain("socket hang up");
    expect(row.lastError).toContain("ledger write failed");
  });

  /**
   * Past the submit, the audit question is already settled: the batch was
   * accepted, so everything in it has egressed and every pair is on the record.
   * Nothing that happens during polling or retrieval can take a row back.
   */
  it("keeps the rows of a batch that was accepted and then could not be polled", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 8 * DAY;

    const provider = new FakeProvider({ failRetrieve: "502 bad gateway" });
    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    // The questions are paid for and in flight, so this is pending, not failed —
    // and the run reports it instead of throwing out of the scheduler.
    expect(summary.pending).toBe(true);
    expect(summary.submitted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.notes.join(" ")).toContain("could not be checked");

    const row = listFollowups(db, caseId, now)[0];
    expect(row.generationStatus).toBe("submitted");
    expect(row.batchId).toBe("msgbatch_1");

    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(row.llmCallId).toBe(calls[0].id);
    const ledger = db.select().from(egressLedger).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].payloadSha256).toBe(
      sha256Hex(JSON.stringify(provider.submitted[0][0].params)),
    );
  });

  it("keeps them when the results could not be read either", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 8 * DAY;

    const provider = new FakeProvider({ failResults: "410 results are gone" });
    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.failed).toBe(1);
    // The generation failed; the disclosure still happened and still counts.
    expect(db.select().from(llmCalls).all()).toHaveLength(1);
    const ledger = db.select().from(egressLedger).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].payloadSha256).toBe(
      sha256Hex(JSON.stringify(provider.submitted[0][0].params)),
    );
    expect(listFollowups(db, caseId, now)[0].lastError).toContain("results are gone");
  });
});

/* -------------------------------------------------------------------------- */
/* Behaviour, not feelings                                                    */
/* -------------------------------------------------------------------------- */

describe("the questions ask about behaviour", () => {
  const context = {
    claimIds: new Set(["c1", "c2"]),
    commitments: [
      {
        id: "k1",
        action: "Say the deadline out loud.",
        kind: "commitment" as const,
        claimRefs: ["c1"],
      },
      {
        id: "i1",
        action: "甲 could answer within the day.",
        kind: "invitation" as const,
        claimRefs: ["c1"],
      },
    ],
  };

  it("accepts a set that asks only about observable events", () => {
    expect(checkFollowupQuestions(GOOD_SET, context)).toEqual([]);
  });

  it("rejects a feelings question", () => {
    const violations = checkFollowupQuestions(
      {
        ...GOOD_SET,
        questions: [
          {
            ...GOOD_SET.questions[0],
            question: "How do you feel about the relationship now?",
          },
          ...GOOD_SET.questions.slice(1),
        ],
      },
      context,
    );
    expect(violations.map((v) => v.code)).toContain("feeling_question");
  });

  it("rejects a claim the frozen judgment never made", () => {
    const violations = checkFollowupQuestions(
      {
        ...GOOD_SET,
        questions: [{ ...GOOD_SET.questions[0], claim_refs: ["c9"] }],
      },
      context,
    );
    expect(violations.map((v) => v.code)).toEqual(["unknown_claim_ref"]);
  });

  it("refuses to check up on an invitation the counterparty never made", () => {
    const violations = checkFollowupQuestions(
      {
        ...GOOD_SET,
        questions: [{ ...GOOD_SET.questions[0], commitment_id: "i1" }],
      },
      context,
    );
    expect(violations.map((v) => v.code)).toContain("invitation_asked_as_commitment");
  });

  it("rejects a set that never asks whether the commitment happened", () => {
    const violations = checkFollowupQuestions(
      { ...GOOD_SET, questions: GOOD_SET.questions.slice(1) },
      context,
    );
    expect(violations.map((v) => v.code)).toContain("no_action_question");
  });

  it("stores nothing when the model ignores the rule", async () => {
    const { caseId, judgmentId } = seedFrozenCase();
    seedContract(caseId, judgmentId);
    const now = FROZE_AT + 9 * DAY;

    const provider = new FakeProvider({
      build: (requests) =>
        requests.map((request) =>
          succeeded(request.customId, {
            opening: "A quick check-in.",
            questions: [
              {
                question_id: "q1",
                commitment_id: "k1",
                claim_refs: ["c1"],
                asks_about: "action_taken",
                question: "How do you feel about how the week went?",
                answer_format: "short_text",
              },
            ],
          }),
        ),
    });

    const summary = await runDueFollowups(db, { now, transport: provider, poll: { sleep: noSleep } });
    expect(summary.ready).toBe(0);

    const row = listFollowups(db, caseId, now)[0];
    expect(row.questions).toBeNull();
    expect(row.lastError).toContain("feeling_question");
  });
});

/* -------------------------------------------------------------------------- */
/* The improvement-contract seam                                              */
/* -------------------------------------------------------------------------- */

describe("reading the improvement contract from the outside", () => {
  it("reads the shapes the contract layer is likely to write", () => {
    expect(
      extractCommitments({
        commitments: [{ commitment_id: "k1", action: "Do the thing.", claim_ids: ["c1"] }],
        invitations: [{ id: "i1", statement: "She could reply." }],
      }),
    ).toEqual([
      { id: "k1", action: "Do the thing.", kind: "commitment", claimRefs: ["c1"] },
      { id: "i1", action: "She could reply.", kind: "invitation", claimRefs: [] },
    ]);
  });

  it("degrades to no commitments rather than throwing on a shape it does not know", () => {
    expect(extractCommitments({ plan: "something else entirely" })).toEqual([]);
    expect(extractCommitments(null)).toEqual([]);
    expect(extractCommitments("not even an object")).toEqual([]);
  });

  it("still fires a check-in on a case that never got a contract", async () => {
    const { caseId } = seedFrozenCase();
    const now = FROZE_AT + 9 * DAY;

    // With no contract there is nothing to name, so the questions rest on the
    // claims alone — and are checked against them just as hard.
    const provider = new FakeProvider({
      build: (requests) =>
        requests.map((request) =>
          succeeded(request.customId, {
            opening: "Nine days on, two questions about what happened.",
            questions: GOOD_SET.questions
              .slice(1)
              .map((question) => ({ ...question, commitment_id: null })),
          }),
        ),
    });

    const summary = await runDueFollowups(db, {
      now,
      transport: provider,
      poll: { sleep: noSleep },
    });

    expect(summary.ready).toBe(1);
    expect(summary.notes.join(" ")).toContain("no improvement contract");
    expect(listFollowups(db, caseId, now)[0].generationStatus).toBe("ready");
  });
});

/* -------------------------------------------------------------------------- */
/* Storage-level guards                                                       */
/* -------------------------------------------------------------------------- */

describe("the storage guarantees", () => {
  it("refuses a second pair of rows for the same case", () => {
    const { caseId, judgmentId } = seedFrozenCase();
    expect(() =>
      db
        .insert(followups)
        .values({
          caseId,
          kind: "day7",
          scheduledAt: new Date(FROZE_AT),
          judgmentId,
        })
        .run(),
    ).toThrowError(/UNIQUE/i);
  });

  it("claims a due row exactly once even when claimed twice in a row", () => {
    seedFrozenCase();
    const now = FROZE_AT + 8 * DAY;
    expect(claimDueFollowups(db, { now })).toHaveLength(1);
    expect(claimDueFollowups(db, { now })).toHaveLength(0);
  });
});
