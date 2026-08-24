// Per-call audit writes — HARD RULE #7 ("every call writes llm_calls + egress_ledger").
//
// Two rows per provider call, always: `llm_calls` is the usage/cost record
// (tokens, cost, stop_reason, fallback detection, latency) and `egress_ledger`
// is the data-egress record (what left the process, hashed, with a 30-day
// expiry so "current exposure" can be queried). Retries write their own pair —
// an attempt that left the process is an egress event whether or not it was
// usable.
//
// `provider` is written as `"anthropic"` on every call this product makes today.
// It is still a column and still an enum with two values because the rows from
// the removed OpenAI polish layer are `"openai"` and are staying: the ledger's
// job is to answer "what has left this machine, to whom", and a vendor this
// product used and stopped using is part of that answer.
//
// The payload itself is never stored: only its SHA-256 and byte length.

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import { egressLedger, llmCalls } from "../db/schema";
import type { LlmEffort, LlmProvider } from "../db/schema";

/** Retention window after which an egress record is considered expired. */
export const EGRESS_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Everything one provider call contributes to the audit tables. */
export interface CallRecord {
  caseId?: string | null;
  /** Registry stage name. */
  stage: string;
  provider: LlmProvider;
  /** Model that actually served the response. */
  model: string;
  effort?: LlmEffort | null;
  promptVersion?: string | null;
  /**
   * `null` means "unknown", which is not the same as 0. A request that left the
   * process and never came back still gets its rows (see `undelivered.ts`), and
   * it has no token counts to report: writing 0 there would claim the vendor was
   * handed nothing.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  /** `null` when the serving model has no price-list entry. */
  costUsd: number | null;
  latencyMs: number;
  /** Checked before reading content; `"refusal"` is an expected value here. */
  stopReason: string | null;
  /** True when `usage.iterations` reported a `fallback_message`. */
  fallbackUsed: boolean;
  /** Serialized `fallback_message` iteration entry, when present. */
  fallbackMessage: string | null;
  requestId?: string | null;
  /** SHA-256 of the exact request body that left the process. */
  payloadSha256: string;
  payloadBytes: number;
  /**
   * The input manifest — the ids this call serialized into its prompt, sorted,
   * with the prompt version they were serialized under (doc 05 §B.3). Byte-stable
   * JSON; see `llm_calls.input_manifest`. Omitted means "not computed", which is
   * the pre-manifest era and nothing else.
   */
  inputManifest?: string | null;
  inputManifestSha256?: string | null;
  /**
   * An `egress_ledger` row already written for this payload.
   *
   * The API path has nothing to put here: the bytes and the call are the same
   * event, so the pair is written together. The external-session path is not
   * like that — the bundle leaves the process when it is emitted, and whether it
   * is ever ingested is somebody else's decision — so its ledger row is written
   * at emission and this links it to the call that came back. One egress, one
   * row: the alternative is a second insert describing the same bytes, and a
   * ledger that double-counts an exposure is as wrong as one that misses it.
   */
  egressId?: string | null;
  /** Defaults to now; injectable so tests can assert the expiry window. */
  sentAt?: Date;
}

export interface RecordedCall {
  llmCallId: string;
  egressId: string;
  expiryAt: Date;
}

/** Everything one *emission* contributes to the ledger, with no call yet. */
export interface EgressRecord {
  caseId?: string | null;
  /** Where the payload went. `"external_session"` for the prepared-bundle path. */
  target: string;
  /** Null when no model id is knowable from inside this process. */
  model?: string | null;
  payloadSha256: string;
  payloadBytes: number;
  /** Defaults to now; injectable so tests can assert the expiry window. */
  sentAt?: Date;
}

export interface RecordedEgress {
  egressId: string;
  expiryAt: Date;
}

/**
 * Write an `egress_ledger` row for a payload that has left the process without
 * (yet) being a provider call — the prepared bundle of `llm/external.ts`.
 *
 * `llm_call_id` stays null until an ingest links it, and may stay null forever:
 * a bundle that was emitted and never answered is exactly the case this row
 * exists to record. The same lesson as the dead-stream branch in `claude.ts` —
 * the ledger describes what left, not what came back.
 */
export function recordEgress(db: Db, record: EgressRecord): RecordedEgress {
  const sentAt = record.sentAt ?? new Date();
  const expiryAt = new Date(sentAt.getTime() + EGRESS_RETENTION_DAYS * DAY_MS);

  const [row] = db
    .insert(egressLedger)
    .values({
      llmCallId: null,
      caseId: record.caseId ?? null,
      target: record.target,
      model: record.model ?? null,
      payloadSha256: record.payloadSha256,
      payloadBytes: record.payloadBytes,
      expiryAt,
      createdAt: sentAt,
    })
    .returning()
    .all();

  return { egressId: row.id, expiryAt };
}

/**
 * Write the `llm_calls` + `egress_ledger` pair for one provider call.
 *
 * Both rows go in one transaction: a usage record without its egress record (or
 * vice versa) would leave the audit trail lying about what left the process.
 *
 * Throws on failure — a call that reached the network but cannot be accounted
 * for is an integrity problem, not something to swallow. `runStage` converts the
 * throw into an error result.
 */
export function recordCall(db: Db, record: CallRecord): RecordedCall {
  const sentAt = record.sentAt ?? new Date();
  const expiryAt = new Date(sentAt.getTime() + EGRESS_RETENTION_DAYS * DAY_MS);

  return db.transaction((tx) => {
    const [call] = tx
      .insert(llmCalls)
      .values({
        caseId: record.caseId ?? null,
        stage: record.stage,
        provider: record.provider,
        model: record.model,
        effort: record.effort ?? null,
        promptVersion: record.promptVersion ?? null,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadInputTokens: record.cacheReadInputTokens,
        cacheCreationInputTokens: record.cacheCreationInputTokens,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        stopReason: record.stopReason,
        fallbackUsed: record.fallbackUsed,
        fallbackMessage: record.fallbackMessage,
        requestId: record.requestId ?? null,
        inputManifest: record.inputManifest ?? null,
        inputManifestSha256: record.inputManifestSha256 ?? null,
        createdAt: sentAt,
      })
      .returning()
      .all();

    // Either the egress for this payload is already on file (it left at
    // emission), in which case it is linked, or it is written here beside the
    // call. Never both.
    const [egress] = record.egressId
      ? tx
          .update(egressLedger)
          .set({ llmCallId: call.id })
          .where(eq(egressLedger.id, record.egressId))
          .returning()
          .all()
      : tx
          .insert(egressLedger)
          .values({
            llmCallId: call.id,
            caseId: record.caseId ?? null,
            target: record.provider,
            model: record.model,
            payloadSha256: record.payloadSha256,
            payloadBytes: record.payloadBytes,
            expiryAt,
            createdAt: sentAt,
          })
          .returning()
          .all();

    if (egress === undefined) {
      // The caller named an egress row that is not there. Inserting one instead
      // would make the ledger agree with itself by inventing the thing it was
      // asked to find; the transaction rolls back and the caller hears about it.
      throw new Error(
        `egress_ledger row ${record.egressId} does not exist — refusing to ` +
          `record a call against an egress that was never written.`,
      );
    }

    return { llmCallId: call.id, egressId: egress.id, expiryAt: egress.expiryAt };
  });
}
