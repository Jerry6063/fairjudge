/**
 * The scheduler run: everything that is due, generated and stored (SPEC M4 ④).
 *
 * One entry point, called from three places that must all be safe to run on top
 * of each other — the launchd timer, the application-start catch-up, and a
 * human running `npm run followups:run` because they want to know. The
 * exactly-once guarantee lives in `claimDueFollowups`, so this function does
 * not have to coordinate with itself.
 *
 * The order is deliberate:
 *
 *   1. **Collect first.** Rows left `submitted` by a run that died (or by a
 *      batch that was still processing when the last run gave up) are picked up
 *      before anything new is submitted. Otherwise a laptop that sleeps mid-run
 *      would strand a paid-for batch and re-submit the same questions.
 *   2. **Then schedule.** The catch-up sweep fills in any case whose freeze did
 *      not schedule its check-ins.
 *   3. **Then claim, submit, poll, retrieve.**
 *
 * Nothing here throws for an expected outcome. A refusal, a transport failure,
 * a batch that is still running and a generation that failed its checks are all
 * recorded on the row and reported in the summary, because the one thing this
 * feature may not do is fail quietly.
 *
 * The same goes for the audit trail. Every request handed to the transport
 * writes its own `llm_calls` + `egress_ledger` pair (HARD RULE #7), whether or
 * not the batch was accepted: a submit that threw still put one payload per
 * prepared request on the wire, and one payload per prepared request is what
 * the ledger records. The single silent case is a batch the SDK refused to
 * dispatch, where no byte reached a socket.
 */

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../db";
import { followups, llmCalls } from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { readJudgment } from "../judgment/contract";
import { toJsonSchemaFormat } from "../llm/config";
import { EgressPipeline } from "../llm/egress";
import { recordCall, sha256Hex, type CallRecord } from "../llm/ledger";
// The same reading of an SDK failure the Messages gateway uses: whether any
// byte reached a socket, and why nothing came back if one did.
import { neverDispatched, requestIdOf, undeliveredReason } from "../llm/undelivered";
import {
  anthropicBatchTransport,
  awaitBatch,
  batchCostUsd,
  type BatchEntry,
  type BatchRequest,
  type BatchTransport,
  type PollOptions,
  type PollOutcome,
} from "./batch";
import { readContractSnapshot, type ContractSnapshot } from "./commitments";
import {
  checkFollowupQuestions,
  describeFollowupViolations,
  followupQuestionSetSchema,
  followupQuestionsStage,
  renderFollowupPrompt,
} from "./questions";
import { catchUpSchedule } from "./schedule";
import {
  claimDueFollowups,
  markFailed,
  markReady,
  markSubmitted,
  toFollowupRecord,
  type FollowupRecord,
} from "./store";

/* -------------------------------------------------------------------------- */
/* Options and summary                                                        */
/* -------------------------------------------------------------------------- */

export interface RunFollowupsOptions {
  /** Injected clock. The reason the catch-up story is testable at all. */
  readonly now?: number;
  /** Provider transport. Tests pass a fake; nothing reaches the network. */
  readonly transport?: BatchTransport;
  /** Anthropic client, when the default transport is used. */
  readonly client?: Anthropic;
  /** Polling budget for the batch. */
  readonly poll?: PollOptions;
  /** Rows claimed in one run. */
  readonly limit?: number;
  /** Attempts before a row stops being retried and stays `failed`. */
  readonly maxAttempts?: number;
  /** Skip the catch-up scheduling sweep (the freeze path already scheduled). */
  readonly skipSchedule?: boolean;
}

export interface RunFollowupsSummary {
  /** Follow-up rows created by the catch-up sweep. */
  readonly scheduled: number;
  /** Rows claimed as due in this run. */
  readonly claimed: number;
  /** Rows whose request made it into a batch. */
  readonly submitted: number;
  /** Rows that now carry checked questions. */
  readonly ready: number;
  /** Rows whose generation failed (retryable or exhausted). */
  readonly failed: number;
  /** Rows collected from a batch submitted by an earlier run. */
  readonly resumed: number;
  /** Batch ids this run touched. */
  readonly batchIds: readonly string[];
  /** True when a batch was still processing when the poll budget ran out. */
  readonly pending: boolean;
  /** One line per row that did not end `ready`. Printed by the CLI. */
  readonly notes: readonly string[];
}

const EMPTY_SUMMARY: RunFollowupsSummary = {
  scheduled: 0,
  claimed: 0,
  submitted: 0,
  ready: 0,
  failed: 0,
  resumed: 0,
  batchIds: [],
  pending: false,
  notes: [],
};

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

export async function runDueFollowups(
  db: Db,
  options: RunFollowupsOptions = {},
): Promise<RunFollowupsSummary> {
  const now = options.now ?? Date.now();
  const notes: string[] = [];
  const batchIds = new Set<string>();

  let transport: BatchTransport;
  try {
    transport = options.transport ?? anthropicBatchTransport(options.client ?? new Anthropic());
  } catch (error) {
    // A missing API key is a configuration fault, not a follow-up failure: no
    // row is claimed, so nothing is marked as attempted.
    return {
      ...EMPTY_SUMMARY,
      notes: [`follow-up generation is not configured: ${describe(error)}`],
    };
  }

  // 1. Anything an earlier run paid for and never collected.
  const resumed = await collectSubmitted(db, transport, now, notes, batchIds);

  // 2. Anything a freeze should have scheduled and did not.
  const scheduled = options.skipSchedule === true ? 0 : catchUpSchedule(db, { now }).length;

  // 3. Everything due.
  const claimed = claimDueFollowups(db, {
    now,
    limit: options.limit,
    maxAttempts: options.maxAttempts,
  });
  if (claimed.length === 0) {
    return {
      ...EMPTY_SUMMARY,
      scheduled,
      resumed: resumed.ready + resumed.failed,
      ready: resumed.ready,
      failed: resumed.failed,
      batchIds: [...batchIds],
      pending: resumed.pending,
      notes,
    };
  }

  const prepared: PreparedRequest[] = [];
  let failed = resumed.failed;

  for (const followup of claimed) {
    const request = prepare(db, followup, notes, options.maxAttempts);
    if (request === null) {
      failed += 1;
      continue;
    }
    prepared.push(request);
  }

  if (prepared.length === 0) {
    return {
      ...EMPTY_SUMMARY,
      scheduled,
      claimed: claimed.length,
      ready: resumed.ready,
      failed,
      resumed: resumed.ready + resumed.failed,
      batchIds: [...batchIds],
      pending: resumed.pending,
      notes,
    };
  }

  // --- submit ---------------------------------------------------------------
  const sentAt = new Date(now);
  const submitStartedAt = Date.now();
  let batch;
  try {
    batch = await transport.create(
      prepared.map(
        (request): BatchRequest => ({
          customId: request.customId,
          params: request.params,
        }),
      ),
    );
  } catch (error) {
    const reason = `batch submit failed: ${describe(error)}`;

    // HARD RULE #7, on the path where it is easiest to forget: `prepared.length`
    // payloads were handed to the transport, so `prepared.length` pairs of audit
    // rows are written — one per request, each hashed from its own body. Not one
    // row for the batch: the ledger's question is "what left this machine", N
    // distinct payloads left it, and a single row would both under-report the
    // privacy surface and lose the per-payload hashes that make the ledger
    // checkable against the requests it claims to describe.
    //
    // Unless nothing left. A batch the SDK refused to dispatch (no resolvable
    // credentials) never reached a socket, and a row claiming otherwise is a
    // false entry — the same asymmetry `claude.ts` keeps. The
    // ledger may under-claim a connection it cannot confirm died; it may never
    // invent a send. A create() that failed after the envelope was on the wire
    // is unknowable from here, so it is recorded.
    const dispatched = !neverDispatched(error);
    const failedLatencyMs = Date.now() - submitStartedAt;
    const stopReason = `no_response:${undeliveredReason(error)}`;
    const requestId = requestIdOf(error);

    for (const request of prepared) {
      // Tokens and cost stay null throughout: nothing came back, and a 0 in a
      // usage row reads as "this call consumed nothing" rather than "unknown".
      const gap = dispatched
        ? writeAudit(db, {
            caseId: request.followup.caseId,
            stage: followupQuestionsStage.name,
            provider: "anthropic",
            model: followupQuestionsStage.model,
            effort: followupQuestionsStage.effort,
            promptVersion: followupQuestionsStage.promptVersion,
            inputTokens: null,
            outputTokens: null,
            cacheReadInputTokens: null,
            cacheCreationInputTokens: null,
            costUsd: null,
            latencyMs: failedLatencyMs,
            stopReason,
            fallbackUsed: false,
            fallbackMessage: null,
            requestId,
            payloadSha256: sha256Hex(request.payload),
            payloadBytes: Buffer.byteLength(request.payload, "utf8"),
            sentAt,
          }).gap
        : null;

      // The submit had already failed; a failed audit write cannot change that
      // outcome. What must not happen is that the gap goes unmentioned, so it
      // rides on the row's own error and in the run's notes.
      const rowReason = gap === null ? reason : `${reason} (${gap})`;
      markFailed(db, request.followup.id, rowReason, { maxAttempts: options.maxAttempts });
      notes.push(`${request.followup.id}: ${rowReason}`);
    }
    return {
      ...EMPTY_SUMMARY,
      scheduled,
      claimed: claimed.length,
      ready: resumed.ready,
      failed: failed + prepared.length,
      resumed: resumed.ready + resumed.failed,
      batchIds: [...batchIds],
      pending: resumed.pending,
      notes,
    };
  }
  const submitLatencyMs = Date.now() - submitStartedAt;
  batchIds.add(batch.id);

  // The egress happened at submit, so that is when it is written to the ledger
  // (HARD RULE #7). One pair of audit rows per request, because one request is
  // one disclosure — the usage is filled in on the same `llm_calls` row when
  // the results come back, rather than counted twice.
  for (const request of prepared) {
    const { llmCallId, gap } = writeAudit(db, {
      caseId: request.followup.caseId,
      stage: followupQuestionsStage.name,
      provider: "anthropic",
      model: followupQuestionsStage.model,
      effort: followupQuestionsStage.effort,
      promptVersion: followupQuestionsStage.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: null,
      latencyMs: submitLatencyMs,
      stopReason: null,
      fallbackUsed: false,
      fallbackMessage: null,
      requestId: batch.id,
      payloadSha256: sha256Hex(request.payload),
      payloadBytes: Buffer.byteLength(request.payload, "utf8"),
      sentAt,
    });
    if (gap !== null) {
      // The payload has already left the process; an unwritable ledger is an
      // integrity problem worth naming, but not a reason to drop the answer.
      notes.push(`${request.followup.id}: ${gap}`);
    }

    markSubmitted(db, request.followup.id, {
      batchId: batch.id,
      batchCustomId: request.customId,
      llmCallId,
      improvementContractId: request.snapshot.contractId,
      commitments: request.snapshot.items,
    });
  }

  // --- poll -----------------------------------------------------------------
  // Everything below this line happens to a batch the provider has accepted:
  // every payload has already egressed and every audit pair is already written,
  // so no failure from here on can take a row out of the ledger. What it can do
  // is decide whether the questions arrive now or on the next run.
  let outcome: PollOutcome;
  try {
    outcome = await awaitBatch(transport, batch.id, options.poll);
  } catch (error) {
    // A provider that cannot be reached for a status check has not lost the
    // batch — the id is on the rows, they stay `submitted`, and `collectSubmitted`
    // picks them up next run, which is the same answer it gives a batch it could
    // not check there. Re-submitting would buy the same questions twice.
    notes.push(
      `batch ${batch.id} could not be checked: ${describe(error)}; the rows ` +
        `stay 'submitted' and the next run collects them`,
    );
    return {
      ...EMPTY_SUMMARY,
      scheduled,
      claimed: claimed.length,
      submitted: prepared.length,
      ready: resumed.ready,
      failed,
      resumed: resumed.ready + resumed.failed,
      batchIds: [...batchIds],
      pending: true,
      notes,
    };
  }
  if (outcome.kind === "timeout") {
    notes.push(
      `batch ${batch.id} was still ${outcome.lastStatus} after ${outcome.polls} ` +
        `polls; the rows stay 'submitted' and the next run collects them`,
    );
    return {
      ...EMPTY_SUMMARY,
      scheduled,
      claimed: claimed.length,
      submitted: prepared.length,
      ready: resumed.ready,
      failed,
      resumed: resumed.ready + resumed.failed,
      batchIds: [...batchIds],
      pending: true,
      notes,
    };
  }

  // --- retrieve -------------------------------------------------------------
  const applied = await applyResults(db, transport, batch.id, prepared, notes, {
    maxAttempts: options.maxAttempts,
    now,
  });

  return {
    scheduled,
    claimed: claimed.length,
    submitted: prepared.length,
    ready: resumed.ready + applied.ready,
    failed: failed + applied.failed,
    resumed: resumed.ready + resumed.failed,
    batchIds: [...batchIds],
    pending: resumed.pending,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Preparing one request                                                      */
/* -------------------------------------------------------------------------- */

interface PreparedRequest {
  readonly followup: FollowupRecord;
  readonly customId: string;
  readonly params: Record<string, unknown>;
  /** Exactly what will leave the process, for the egress hash. */
  readonly payload: string;
  readonly snapshot: ContractSnapshot;
  readonly claimIds: ReadonlySet<string>;
  /**
   * The scrub state for this request, kept so PII placeholders can be put back
   * when the answer arrives. A run that dies between submit and retrieve loses
   * it — the resume path restores nothing, which leaves `{{PHONE_1}}` visible
   * rather than guessing.
   */
  readonly pipeline: EgressPipeline;
}

const WINDOW_LABEL: Readonly<Record<string, string>> = {
  day7: "7 days after the judgment was issued",
  day30: "30 days after the judgment was issued",
};

/**
 * Assemble one follow-up's request, or mark it failed and return null.
 *
 * Everything that can make a check-in impossible is decided here, before any
 * money is spent: a judgment that has gone missing, a fact layer with no
 * claims, or a payload the pseudonymization gateway will not let out.
 */
function prepare(
  db: Db,
  followup: FollowupRecord,
  notes: string[],
  maxAttempts: number | undefined,
): PreparedRequest | null {
  const fail = (reason: string): null => {
    markFailed(db, followup.id, reason, { maxAttempts });
    notes.push(`${followup.id}: ${reason}`);
    return null;
  };

  if (followup.judgmentId === null) {
    return fail(
      "no judgment on this follow-up; a check-in is derived from a frozen " +
        "judgment and there is nothing to derive it from",
    );
  }
  const judgment = readJudgment(db, followup.judgmentId);
  if (judgment === null) return fail(`judgment ${followup.judgmentId} is gone`);
  if (judgment.status === "draft") {
    return fail(`judgment ${followup.judgmentId} is not frozen`);
  }

  const claims = judgment.factLayer.claims.map((claim) => ({
    id: claim.claim_id,
    statement: claim.statement,
  }));
  if (claims.length === 0) {
    return fail(`judgment ${followup.judgmentId} has no claims to ask about`);
  }

  const snapshot = readContractSnapshot(
    db,
    followup.caseId,
    followup.improvementContractId,
  );
  if (snapshot.note !== null) notes.push(`${followup.id}: ${snapshot.note}`);

  const prompt = renderFollowupPrompt({
    window: WINDOW_LABEL[followup.kind] ?? followup.kind,
    claims,
    commitments: snapshot.items,
  });

  // HARD RULE #3: the same gateway every other egress goes through, in the same
  // order — dictionary pseudonymization, then the PII scrub, then a residual
  // check that blocks rather than "mostly" masks.
  const pipeline = new EgressPipeline(buildCaseDict(db, followup.caseId));
  const system = pipeline.apply(followupQuestionsStage.promptTemplate);
  const user = pipeline.apply(prompt);

  const residual = [system, user].flatMap((text) => pipeline.residualPii(text));
  if (residual.length > 0) {
    const kinds = [...new Set(residual.map((warning) => warning.kind))].join(", ");
    return fail(
      `egress blocked by the pseudonymization gateway: ${residual.length} ` +
        `unscrubbed fragment(s) (${kinds})`,
    );
  }

  // No `fallbacks`, and no fallback beta: the Batches API does not accept them
  // (see batch.ts). Nothing is lost — this stage is already opus-4-8, which is
  // what a fallback would have routed to.
  const params: Record<string, unknown> = {
    model: followupQuestionsStage.model,
    max_tokens: followupQuestionsStage.maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    thinking: { type: "adaptive" },
    output_config: {
      effort: followupQuestionsStage.effort,
      format: toJsonSchemaFormat(followupQuestionsStage.zodSchema),
    },
  };

  return {
    followup,
    // The row id is the join key: results come back in any order, and this is
    // how each one finds the row it belongs to.
    customId: followup.id,
    params,
    payload: JSON.stringify(params),
    snapshot,
    claimIds: new Set(claims.map((claim) => claim.id)),
    pipeline,
  };
}

/* -------------------------------------------------------------------------- */
/* Applying results                                                           */
/* -------------------------------------------------------------------------- */

interface ApplyOptions {
  readonly maxAttempts?: number;
  readonly now: number;
}

async function applyResults(
  db: Db,
  transport: BatchTransport,
  batchId: string,
  prepared: readonly PreparedRequest[],
  notes: string[],
  options: ApplyOptions,
): Promise<{ ready: number; failed: number }> {
  let entries: readonly BatchEntry[];
  try {
    entries = await transport.results(batchId);
  } catch (error) {
    const reason = `batch ${batchId} results could not be read: ${describe(error)}`;
    for (const request of prepared) {
      markFailed(db, request.followup.id, reason, {
        maxAttempts: options.maxAttempts,
      });
      notes.push(`${request.followup.id}: ${reason}`);
    }
    return { ready: 0, failed: prepared.length };
  }

  // Keyed by custom_id — results arrive in an arbitrary order and a batch of
  // two whose results come back reversed must still land on the right rows.
  const byCustomId = new Map(entries.map((entry) => [entry.customId, entry]));

  let ready = 0;
  let failed = 0;
  for (const request of prepared) {
    const entry = byCustomId.get(request.customId);
    if (entry === undefined) {
      const reason = `batch ${batchId} came back without a result for this request`;
      markFailed(db, request.followup.id, reason, {
        maxAttempts: options.maxAttempts,
      });
      notes.push(`${request.followup.id}: ${reason}`);
      failed += 1;
      continue;
    }

    const stored = storeEntry(db, request, entry, notes, options);
    if (stored) ready += 1;
    else failed += 1;
  }
  return { ready, failed };
}

/**
 * Validate and store one result. Returns true when the row became `ready`.
 *
 * The order of checks mirrors `runStage`: the stop reason is read before any
 * content, then JSON, then the zod contract, then the server-side checks that
 * the prompt cannot be trusted to have kept.
 */
function storeEntry(
  db: Db,
  request: PreparedRequest,
  entry: BatchEntry,
  notes: string[],
  options: ApplyOptions,
): boolean {
  const fail = (reason: string): boolean => {
    markFailed(db, request.followup.id, reason, { maxAttempts: options.maxAttempts });
    notes.push(`${request.followup.id}: ${reason}`);
    return false;
  };

  if (entry.type !== "succeeded") return fail(entry.message);

  backfillUsage(db, request.followup.llmCallId ?? readLlmCallId(db, request.followup.id), entry);

  if (entry.stopReason === "refusal") {
    return fail(
      `the model declined to write this check-in` +
        (entry.stopCategory === null ? "" : ` (${entry.stopCategory})`),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch (error) {
    return fail(`response was not valid JSON: ${describe(error)}`);
  }

  const validated = followupQuestionSetSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return fail(`response did not match the question schema: ${issues}`);
  }

  // Pseudonyms stay pseudonyms — the questions are stored and read weeks later
  // beside a judgment written in the same vocabulary. PII placeholders are put
  // back, because a `{{PHONE_1}}` inside a quoted line is a hole in it.
  const restored = request.pipeline.restoreDeep(validated.data, { pseudonyms: false });

  const violations = checkFollowupQuestions(restored, {
    claimIds: request.claimIds,
    commitments: request.snapshot.items,
  });
  if (violations.length > 0) {
    return fail(`questions rejected — ${describeFollowupViolations(violations)}`);
  }

  markReady(db, request.followup.id, restored, options.now);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Resuming a batch an earlier run left behind                                */
/* -------------------------------------------------------------------------- */

/**
 * Collect results for rows still marked `submitted`.
 *
 * This is the half that makes a sleeping laptop survivable: a run that
 * submitted a batch and then lost the process leaves rows pointing at a batch
 * the provider is still working on, and those rows must be picked up rather
 * than re-submitted. The pseudonym state from the original request is gone, so
 * PII placeholders are left as placeholders — visible and wrong-looking, which
 * is the right failure mode for something that cannot be reconstructed.
 */
async function collectSubmitted(
  db: Db,
  transport: BatchTransport,
  now: number,
  notes: string[],
  batchIds: Set<string>,
): Promise<{ ready: number; failed: number; pending: boolean }> {
  const rows = db
    .select()
    .from(followups)
    .where(
      and(eq(followups.generationStatus, "submitted"), isNotNull(followups.batchId)),
    )
    .all()
    .map(toFollowupRecord);

  if (rows.length === 0) return { ready: 0, failed: 0, pending: false };

  const grouped = new Map<string, FollowupRecord[]>();
  for (const row of rows) {
    const list = grouped.get(row.batchId as string) ?? [];
    list.push(row);
    grouped.set(row.batchId as string, list);
  }

  let ready = 0;
  let failed = 0;
  let pending = false;

  for (const [batchId, batchRows] of grouped) {
    batchIds.add(batchId);
    let handle;
    try {
      handle = await transport.retrieve(batchId);
    } catch (error) {
      notes.push(`batch ${batchId} could not be checked: ${describe(error)}`);
      pending = true;
      continue;
    }
    if (handle.processingStatus !== "ended") {
      notes.push(
        `batch ${batchId} from an earlier run is still ${handle.processingStatus} ` +
          `(${batchRows.length} check-in(s) waiting on it)`,
      );
      pending = true;
      continue;
    }

    const rebuilt = batchRows.map((row) => rebuild(db, row));
    const applied = await applyResults(db, transport, batchId, rebuilt, notes, { now });
    ready += applied.ready;
    failed += applied.failed;
  }

  return { ready, failed, pending };
}

/**
 * Rebuild just enough of a `PreparedRequest` to validate a result that arrived
 * after the run that asked for it is gone. The prompt is not rebuilt — only the
 * checks need to run, and they need the claim ids and the commitments snapshot
 * that were stored on the row precisely so this is possible.
 */
function rebuild(db: Db, followup: FollowupRecord): PreparedRequest {
  const judgment =
    followup.judgmentId === null ? null : readJudgment(db, followup.judgmentId);
  const claimIds = new Set(
    (judgment?.factLayer.claims ?? []).map((claim) => claim.claim_id),
  );
  const snapshot = readContractSnapshot(
    db,
    followup.caseId,
    followup.improvementContractId,
  );

  return {
    followup,
    customId: followup.batchCustomId ?? followup.id,
    params: {},
    payload: "",
    snapshot,
    claimIds,
    // No scrub state survives a restart; an empty pipeline restores nothing.
    pipeline: new EgressPipeline(),
  };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

interface AuditOutcome {
  /** The `llm_calls` row the usage is backfilled onto, when one was written. */
  readonly llmCallId: string | null;
  /** Why the pair could not be written, or null. Never swallowed. */
  readonly gap: string | null;
}

/**
 * Write the `llm_calls` + `egress_ledger` pair for one request in a batch.
 *
 * One helper for both submit outcomes, because the egress half does not depend
 * on the outcome: the payload hash and byte count are properties of what was
 * handed over, known before the transport was called. What differs is only what
 * the usage half can honestly say afterwards.
 *
 * A payload that left the process without a ledger row is exactly the state the
 * ledger exists to make impossible, so the reason is returned rather than
 * thrown away — the caller puts it on the row and in the run's notes. It does
 * not abandon the check-in: unlike the judgment path there is nothing here to
 * withhold, the request is already with the provider either way.
 */
function writeAudit(db: Db, record: CallRecord): AuditOutcome {
  try {
    return { llmCallId: recordCall(db, record).llmCallId, gap: null };
  } catch (error) {
    return { llmCallId: null, gap: `ledger write failed: ${describe(error)}` };
  }
}

function readLlmCallId(db: Db, followupId: string): string | null {
  const row = db
    .select({ llmCallId: followups.llmCallId })
    .from(followups)
    .where(eq(followups.id, followupId))
    .get();
  return row?.llmCallId ?? null;
}

/**
 * Fill the usage in on the `llm_calls` row this request was written under.
 *
 * The row is created at submit with zero tokens, because that is when the
 * payload left the process and the ledger must not lie about when that
 * happened. The tokens are only known when the batch comes back, so they are
 * written onto the same row — one call, one row, counted once, at batch prices.
 */
function backfillUsage(db: Db, llmCallId: string | null, entry: BatchEntry): void {
  if (llmCallId === null || entry.type !== "succeeded") return;
  const model = entry.model === "" ? followupQuestionsStage.model : entry.model;

  db.update(llmCalls)
    .set({
      model,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadInputTokens: entry.usage.cacheReadInputTokens,
      cacheCreationInputTokens: entry.usage.cacheCreationInputTokens,
      costUsd: batchCostUsd(model, entry.usage),
      stopReason: entry.stopReason,
    })
    .where(eq(llmCalls.id, llmCallId))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rows a run touched, for the CLI's report. Kept here rather than in `store.ts`
 * because it is a reporting convenience, not part of the lifecycle.
 */
export function readFollowupsByIds(db: Db, ids: readonly string[]): FollowupRecord[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(followups)
    .where(inArray(followups.id, [...ids]))
    .all()
    .map(toFollowupRecord);
}
