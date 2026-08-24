/**
 * The external-session runtime — doc 05 §B.
 *
 * The product is growing a second way to run the same stages: instead of this
 * process opening a socket to Anthropic, it hands the assembled request to the
 * model already driving the surrounding session (a Claude Code skill), and hands
 * the answer back. The transport changes and the cost goes to zero. **Nothing
 * else may change**, and this module exists to make that a property of the code:
 *
 *   - `prepareStage` is `prepareRequest` plus a ledger row. It does not build a
 *     prompt of its own, does not re-fetch a dossier its own way, and does not
 *     have a second opinion about pseudonymization — HARD RULE #3 applies to
 *     this egress channel exactly as it applies to the API one, because it is
 *     literally the same function that produces the bytes.
 *   - `ingestStage` re-runs the same assembly, so the answer is checked against
 *     the request that produced it, then validates the candidate the way the API
 *     path validates a response: `zod.parse` on the structured output, then the
 *     downstream checks the stage's callers run. HARD RULE #1 is not one of the
 *     injectable ones — every citation in every ingested output is audited
 *     against SQLite here, unconditionally, because a channel where the model is
 *     not on the other end of a socket is exactly the channel where "the caller
 *     will check it" stops being true.
 *
 * ## Where the ledger row goes, and why it is not at the end
 *
 * `claude.ts` learned this the expensive way and says so at length: the payload
 * is hashed and written to `egress_ledger` BEFORE the send, because a request
 * that times out has disclosed the case just the same, and a ledger that only
 * records round trips that completed is a ledger with a hole exactly where the
 * failures are.
 *
 * This channel has the same hole in a different shape. Between `prepareStage`
 * and `ingestStage` sits a file on disk and a model this process does not own.
 * The bundle may be read and never answered; it may be answered wrongly and
 * rejected; it may be abandoned. In every one of those the case has left this
 * process. So the `egress_ledger` row is written by `prepareStage`, at the
 * moment the bytes are handed out, and `ingestStage` writes `llm_calls` and
 * LINKS that row rather than inserting a second one describing the same bytes.
 *
 * The trade is deliberate and it points the same way as `claude.ts`'s: a bundle
 * that is prepared and then dropped leaves a ledger row for an exposure that
 * arguably never reached anyone. That is an over-claim about bytes this process
 * really did materialize outside the gateway, and it is the error worth making.
 * The other one — a prepared case sitting in a file with nothing in the ledger
 * about it — is the audit hole.
 *
 * ## What the rows say
 *
 * `provider` / `model` are `"external_session"`. Not a lie about a vendor: no
 * vendor was paid and no model id is knowable from in here (the surrounding
 * session's model is not this process's business, and guessing it would put a
 * fiction in the provenance column). Tokens and cost are null — unknown, never
 * 0 — which is how the removed-vendor archives and the dead-stream branch in
 * `claude.ts` already record a call whose bill nobody can state.
 */

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb, type Db } from "../db";
import { egressLedger, type CaseStage, type OutputLevel } from "../db/schema";
import {
  checkEvidenceRefs,
  type EvidenceRefRejection,
} from "../pipeline/evidence-refs";
import {
  STAGE_META,
  STAGE_SEQUENCE,
  canAdvance,
  collectCaseFacts,
  requirementsFor,
} from "../pipeline/stage-machine";
import {
  prepareRequest,
  type InputManifest,
  type PreparedRequest,
  type StageSelector,
} from "./claude";
import type { StageName, StageOutput } from "./config";
import { recordCall, recordEgress, sha256Hex } from "./ledger";
import type { StageDescriptor, StageInput } from "./types";
import type { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** Format marker of the emitted bundle. Bumped when its shape changes. */
export const EXTERNAL_BUNDLE_FORMAT = "fairjudge.external_stage.v1";

/**
 * What `llm_calls.provider`, `llm_calls.model` and `egress_ledger.target` carry
 * on this channel. One constant so the three cannot drift.
 */
export const EXTERNAL_SESSION = "external_session";

/** One conversation turn, exactly as the API path would have sent it. */
export interface BundleMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Everything the surrounding session needs to run one stage, and nothing this
 * process would not have put on the wire itself.
 */
export interface PreparedBundle {
  readonly format: typeof EXTERNAL_BUNDLE_FORMAT;
  /** Stage name — what the audit rows are attributed to. */
  readonly stage: string;
  readonly case_id: string | null;
  readonly prompt_version: string;
  /** The stage's system prompt, past the pseudonymization gateway. */
  readonly system: string;
  /**
   * The last user turn. Every stage in this product is single-turn today, so
   * this is normally the whole request; `messages` is the general form and
   * `user` is always the last entry in it.
   */
  readonly user: string;
  readonly messages: readonly BundleMessage[];
  /** The stage's zod schema as json_schema — the response contract. */
  readonly output_schema: Record<string, unknown>;
  readonly manifest: InputManifest;
  readonly manifest_hash: string;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The bundle's bytes — what is written out, and what is hashed into the ledger.
 *
 * Deterministic by construction: the literal in `buildBundle` fixes the key
 * order, the prompt is byte-stable upstream (CLAUDE.md prompt-cache discipline),
 * and `toJsonSchemaFormat` is a pure function of the stage's zod schema. Two
 * preparations of an unchanged record produce identical bytes, which is what
 * lets `ingestStage` find its own emission by hash instead of being told about
 * it.
 */
export function serializeBundle(bundle: PreparedBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function buildBundle(
  request: PreparedRequest,
  caseId: string | null,
): PreparedBundle {
  const messages: BundleMessage[] = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return {
    format: EXTERNAL_BUNDLE_FORMAT,
    stage: request.stage,
    case_id: caseId,
    prompt_version: request.def.promptVersion,
    system: request.system,
    // `prepareRequest` has already refused anything whose last turn is not a
    // user turn, so this is total.
    user: messages[messages.length - 1].content,
    messages,
    output_schema: request.format.schema,
    manifest: request.manifest.manifest,
    manifest_hash: request.manifest.sha256,
  };
}

/* -------------------------------------------------------------------------- */
/* The stage machine, on this channel                                         */
/* -------------------------------------------------------------------------- */

/**
 * Stages that produce a judgment, and therefore may only run on a case that has
 * reached the stage which licenses one.
 *
 * Named by string rather than by importing the descriptors, because
 * `llm/stages/*` imports this layer's siblings and a judgment stage should not
 * have to be registered in two places to be governed. Anything named
 * `judgment_*` is a judgment call; a new one is covered the day it is written.
 */
function isJudgmentStage(stage: string): boolean {
  return stage.startsWith("judgment_");
}

/** The first stage at which a judgment may be produced at all. */
const JUDGMENT_STAGE: CaseStage = "judgment";

/**
 * Refuse a judgment call on a case that has not got there yet — in the state
 * machine's own words.
 *
 * ## Why this is here and not in the CLI
 *
 * The acceptance walkthrough drove `stage:prepare --stage judgment_skeleton`
 * and `stage:ingest` on a case still sitting at `intake`, and both succeeded.
 * Everything the pipeline puts between filing and judgment — the safety screen,
 * grading, the clarification rounds, the steelman, the adverse-fact
 * confrontation — is enforced by `canAdvance` refusing a transition, and a
 * generation path that never asks about the stage skips all of it at once. The
 * API path is not exposed to this because a judgment is generated from a screen
 * the case has to have arrived at; a channel whose front door is a command with
 * a `--stage` flag has no such geometry, so the precondition has to be code.
 *
 * It sits in this module rather than in `scripts/fairjudge-cli.ts` for the
 * reason the CLI's own header gives: a check in the caller is a check the next
 * caller does not have. `prepareStage` and `ingestStage` are the door.
 *
 * ## What it checks, and in whose words
 *
 * The stage index, and then the machine's own entry requirements for
 * `judgment` — `requirementsFor`, the same table `canAdvance` consults and the
 * same `Requirement.blocker` sentences the stepper renders. Nothing is reworded
 * here; a second vocabulary for the same facts would hide which precondition
 * actually failed. The requirements are re-read at the moment of use rather than
 * trusted from the stage column, for the reason `assertJudgmentAllowed` gives:
 * a case can reach `judgment` and then have a new adverse fact surfaced behind
 * it, and "the case is at the judgment stage" is a stale answer to "may a
 * judgment run right now".
 *
 * A stage with no case attached is left alone: there is no record to judge it
 * against, and `auditIngestedRefs` already refuses any output from such a call
 * that tries to cite something.
 */
export function judgmentStageBlocker(
  db: Db,
  stage: string,
  caseId: string | null,
): string | null {
  if (!isJudgmentStage(stage) || caseId === null) return null;

  const facts = collectCaseFacts(db, caseId);
  const reached =
    STAGE_SEQUENCE.indexOf(facts.stage) >= STAGE_SEQUENCE.indexOf(JUDGMENT_STAGE);

  const unmet = requirementsFor(facts, JUDGMENT_STAGE).filter(
    (requirement) => !requirement.satisfied,
  );
  if (reached && unmet.length === 0) return null;

  // `canAdvance` phrases the structural refusals — a skipped stage, a case the
  // safety screen refused — and it phrases them better than a sentence written
  // here would, because it is the sentence the user has already met elsewhere.
  const decision = canAdvance(facts, JUDGMENT_STAGE);
  const headline = decision.allowed
    ? `${STAGE_META[JUDGMENT_STAGE].title} has not been entered yet.`
    : decision.reason;

  const lines = [
    `${stage} produces a judgment, and case ${caseId} is at ` +
      `${facts.stage} (${STAGE_META[facts.stage].title.toLowerCase()}). ` +
      headline,
    ...unmet.map((requirement) => `  ${requirement.id}: ${requirement.blocker}`),
  ];
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* prepareStage                                                               */
/* -------------------------------------------------------------------------- */

export interface ExternalOptions {
  /** Database for the audit rows. Defaults to the process-wide client. */
  readonly db?: Db;
  /** Injectable clock, so tests can assert the retention window. */
  readonly now?: Date;
}

export interface PrepareOptions extends ExternalOptions {
  /**
   * Emit a second copy of a bundle that is still open. See `openEmission`.
   *
   * Off by default, and it is the caller saying "I know the first copy is
   * unanswered and I want another one anyway" — a bundle handed to a session
   * that never came back, most often. It does not close the first row; it adds
   * a second, and both then describe bytes that really did leave.
   */
  readonly reopen?: boolean;
}

/**
 * The emission an answer to these bytes would be recorded against: an egress
 * row for this exact payload with no `llm_call` linked to it yet.
 *
 * One query, used from both ends, because the two ends have to agree on what
 * "open" means. `ingestStage` asks in order to find the bundle its candidate
 * answers; `prepareStage` asks in order to refuse to create a second one.
 *
 * ## Why a second open row is a fault rather than a duplicate
 *
 * The link between a bundle and its answer is the payload hash, and nothing
 * else — this channel has no request id, because the thing on the other end is
 * a session rather than a server. Two open rows for one payload therefore make
 * the ingest ambiguous: the answer is recorded against whichever row the
 * ordering happens to return, and the walkthrough found the consequence — an
 * answer that had already been ingested was accepted a second time, because the
 * twin was still open and the second ingest consumed it. Nothing about the
 * second ingest was legitimate; it simply found an unspoken-for row.
 *
 * One open question per payload keeps "has this bundle been answered?" a
 * question the ledger can answer.
 */
function openEmission(
  db: Db,
  payloadSha256: string,
): { readonly id: string; readonly createdAt: Date } | undefined {
  return db
    .select({ id: egressLedger.id, createdAt: egressLedger.createdAt })
    .from(egressLedger)
    .where(
      and(
        eq(egressLedger.target, EXTERNAL_SESSION),
        eq(egressLedger.payloadSha256, payloadSha256),
        isNull(egressLedger.llmCallId),
      ),
    )
    .orderBy(desc(egressLedger.createdAt))
    .get();
}

export type PrepareOutcome =
  | {
      readonly kind: "ok";
      readonly bundle: PreparedBundle;
      /** The exact bytes to write out. Hashing anything else breaks the link. */
      readonly json: string;
      /** The `egress_ledger` row this emission was recorded under. */
      readonly egressId: string;
    }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string };

/**
 * Assemble one stage for the surrounding session, and record the egress.
 *
 * Everything about the request is `prepareRequest`'s — same dossier text the
 * caller would have handed `runStage`, same dictionary pseudonymization and PII
 * scrub, same byte-stable serialization, same zod→json_schema conversion, same
 * input manifest. No model is called and no API key is needed.
 *
 * The ledger row is written before the bundle is returned. See the module note:
 * once these bytes leave this function nothing in this process governs where
 * they go, so this is the last moment at which recording them is still honest.
 */
export function prepareStage<S extends StageName>(
  stage: S,
  input: StageInput,
  options?: PrepareOptions,
): PrepareOutcome;
export function prepareStage(
  stage: StageDescriptor,
  input: StageInput,
  options?: PrepareOptions,
): PrepareOutcome;
export function prepareStage(
  stage: StageSelector,
  input: StageInput,
  options: PrepareOptions = {},
): PrepareOutcome {
  const prepared = prepareRequest(stage, input);
  if (!prepared.ok) return prepared.error;

  const caseId = input.caseId ?? null;
  const bundle = buildBundle(prepared.request, caseId);
  const json = serializeBundle(bundle);

  let db: Db;
  try {
    db = options.db ?? getDb();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", retryable: false, message };
  }

  // Before the ledger row, and therefore before anything is handed out: a case
  // that may not be judged yet does not get a bundle it could be judged from.
  const blocked = judgmentStageBlocker(db, prepared.request.stage, caseId);
  if (blocked !== null) {
    return { kind: "error", retryable: false, message: blocked };
  }

  // One open question per payload. Asked before the ledger write for the same
  // reason the judgment gate is: a bundle this channel cannot later match an
  // answer to unambiguously is a bundle worth not handing out.
  const payloadSha256 = sha256Hex(json);
  if (options.reopen !== true) {
    const already = openEmission(db, payloadSha256);
    if (already !== undefined) {
      return {
        kind: "error",
        retryable: false,
        message:
          `an identical bundle for stage ${prepared.request.stage} is already ` +
          `open in the egress ledger (payload ${payloadSha256.slice(0, 12)}…, ` +
          `prepared ${already.createdAt.toISOString()}) and has not been ` +
          `answered. An answer is matched to its bundle by that payload alone, ` +
          `so a second open copy would leave two rows one answer could be ` +
          `recorded against. Answer the open one, or change the record and ` +
          `prepare the bundle that follows from it; \`reopen\` emits a second ` +
          `copy deliberately.`,
      };
    }
  }

  let egressId: string;
  try {
    ({ egressId } = recordEgress(db, {
      caseId,
      target: EXTERNAL_SESSION,
      // Unknown by construction — whichever model reads this bundle is not this
      // process's to name.
      model: null,
      payloadSha256,
      payloadBytes: Buffer.byteLength(json, "utf8"),
      sentAt: options.now,
    }));
  } catch (error) {
    // A bundle whose emission cannot be recorded is not a bundle worth handing
    // out — the same answer `runStage` gives when its audit write fails.
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      retryable: false,
      message: `ledger write failed, so nothing was emitted: ${message}`,
    };
  }

  return { kind: "ok", bundle, json, egressId };
}

/* -------------------------------------------------------------------------- */
/* Downstream validation                                                      */
/* -------------------------------------------------------------------------- */

/** Why an ingest was refused by the server rather than by a schema. */
export type IngestRejectionCode =
  /** The candidate was not JSON, or not the stage's shape. */
  | "schema"
  /** HARD RULE #1: a citation that does not exist or is not confirmed. */
  | "invalid_refs"
  /** A stage-specific check the caller supplied said no. */
  | "downstream";

/**
 * A stage-specific check, supplied by whoever would have run it on the API path.
 *
 * The judgment stages need one: `checkFactLayer` wants the locked level, the
 * dossier's own arithmetic and the contract, and `checkSurfaceLayer` wants the
 * frozen fact layer the narrative may not out-run. None of that is knowable from
 * inside the gateway, and reaching up into `judgment/` from here would invert
 * the layering to save a callback. Stages with no downstream checks (translate)
 * pass nothing.
 *
 * It is deliberately NOT where citations are checked. See `auditIngestedRefs`.
 */
export type DownstreamCheck<T> = (
  data: T,
) => { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Audit every citation anywhere in an ingested output — HARD RULE #1, on this
 * channel, with nothing optional about it.
 *
 * Generic rather than per-stage: the walk collects every `evidence_refs` array
 * in the value, whatever shape the stage's schema gave it, and puts the ids
 * through `checkEvidenceRefs` — the one module that decides whether a reference
 * may stand, the same one `judgment/generation.ts` and the wave-A stages call.
 * Existence, case membership, audience and confirmed status are its answers, not
 * this module's.
 *
 * What it does not decide is whether an item was allowed to cite *nothing*. An
 * empty list is legal for an `unknown`-tier claim and illegal for a wave-A item,
 * and that is the stage contract's call — it belongs to the `DownstreamCheck`.
 * Here, an id that is present must hold up.
 */
function auditIngestedRefs(
  db: Db,
  caseId: string | null,
  data: unknown,
): readonly EvidenceRefRejection[] {
  const refs = collectEvidenceRefs(data);
  if (refs.length === 0) return [];
  if (caseId === null) {
    return [
      {
        ref: String(refs[0]),
        fault: "unknown",
        status: null,
        detail:
          "this output cites evidence but the stage was prepared without a " +
          "case, so there is no record to check the citation against",
      },
    ];
  }
  return checkEvidenceRefs(db, caseId, refs).rejected;
}

/** Every value of every `evidence_refs` array, at any depth. */
function collectEvidenceRefs(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "evidence_refs" && Array.isArray(item)) out.push(...item);
      else collectEvidenceRefs(item, out);
    }
  }
  return out;
}

function describeRefRejections(
  rejected: readonly EvidenceRefRejection[],
): string {
  const lines = rejected.map((r) => `- ${r.ref} — ${r.detail}`);
  return (
    `${rejected.length} citation(s) in this output cannot stand:\n` +
    lines.join("\n")
  );
}

/* -------------------------------------------------------------------------- */
/* ingestStage                                                                */
/* -------------------------------------------------------------------------- */

export interface IngestOptions<T = unknown> extends ExternalOptions {
  /** The stage-specific checks this stage's caller runs on the API path. */
  readonly check?: DownstreamCheck<T>;
  /**
   * Wall-clock milliseconds attributable to this stage, if the caller measured
   * any. Written to `llm_calls.latency_ms`; 0 when nothing was measured, which
   * is the honest reading of "this process did not wait for anything".
   */
  readonly latencyMs?: number;
}

export type IngestOutcome<T> =
  | {
      readonly kind: "ok";
      readonly data: T;
      readonly llmCallId: string;
      readonly egressId: string;
      readonly manifestHash: string;
    }
  | {
      readonly kind: "rejected";
      readonly code: IngestRejectionCode;
      readonly message: string;
    }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string };

/**
 * Take one candidate output for a stage that was prepared earlier, validate it
 * the way the API path validates a response, and — only if it holds — persist
 * the call.
 *
 * `stage` and `input` are the same pair that was prepared. The assembly is
 * re-run rather than trusted from a file, which buys two things: the response is
 * restored through the pipeline that masked the request (the placeholder map is
 * process-local and cannot be shipped in a bundle), and the emission is found by
 * hashing the re-derived bytes. A record that changed since the bundle was
 * emitted therefore hashes differently, finds no open egress row, and is refused
 * by name instead of being quietly heard against a case that has moved.
 *
 * Nothing is written on a rejection. The egress row stays open, so a corrected
 * answer to the same bundle can still be ingested against it.
 */
export function ingestStage<S extends StageName>(
  stage: S,
  input: StageInput,
  candidate: unknown,
  options?: IngestOptions<StageOutput<S>>,
): IngestOutcome<StageOutput<S>>;
export function ingestStage<TSchema extends z.ZodType>(
  stage: StageDescriptor<TSchema>,
  input: StageInput,
  candidate: unknown,
  options?: IngestOptions<z.infer<TSchema>>,
): IngestOutcome<z.infer<TSchema>>;
export function ingestStage(
  stage: StageSelector,
  input: StageInput,
  candidate: unknown,
  options: IngestOptions = {},
): IngestOutcome<unknown> {
  const prepared = prepareRequest(stage, input);
  if (!prepared.ok) return { ...prepared.error, kind: "error" as const };
  const request = prepared.request;
  const caseId = input.caseId ?? null;

  let db: Db;
  try {
    db = options.db ?? getDb();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", retryable: false, message };
  }

  // --- may this case be judged at all, right now? --------------------------
  //
  // Re-asked here rather than trusted from the preparation: the record moves
  // between the two calls, and this is the one that writes.
  const blocked = judgmentStageBlocker(db, request.stage, caseId);
  if (blocked !== null) {
    return { kind: "error", retryable: false, message: blocked };
  }

  // --- find the emission this answer belongs to ----------------------------
  const json = serializeBundle(buildBundle(request, caseId));
  const payloadSha256 = sha256Hex(json);
  const open = openEmission(db, payloadSha256);

  if (open === undefined) {
    return {
      kind: "error",
      retryable: false,
      message:
        `no prepared bundle for stage ${request.stage} is open in the egress ` +
        `ledger (looked for payload ${payloadSha256.slice(0, 12)}…). Either it ` +
        `was never prepared, it has already been ingested, or the case record ` +
        `changed since — prepare it again and answer the new bundle.`,
    };
  }

  // --- the response contract, exactly as the API path reads it -------------
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) {
    return { kind: "rejected", code: "schema", message: parsed.message };
  }
  const validated = request.def.zodSchema.safeParse(parsed.value);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return {
      kind: "rejected",
      code: "schema",
      message: `schema mismatch: ${issues}`,
    };
  }

  // A stage that declares `keepPseudonyms` keeps 甲/乙 exactly as written — the
  // same branch `runStage` takes, for the same reason (HARD RULE #3's mapping
  // table is not unwound into a stored artifact).
  const data = request.pipeline.restoreDeep(validated.data, {
    pseudonyms: request.def.keepPseudonyms !== true,
  });

  // --- HARD RULE #1, unconditional on this channel -------------------------
  const rejectedRefs = auditIngestedRefs(db, caseId, data);
  if (rejectedRefs.length > 0) {
    return {
      kind: "rejected",
      code: "invalid_refs",
      message: describeRefRejections(rejectedRefs),
    };
  }

  // --- whatever this stage's caller checks on the API path -----------------
  if (options.check) {
    const verdict = options.check(data);
    if (!verdict.ok) {
      return { kind: "rejected", code: "downstream", message: verdict.message };
    }
  }

  // --- persist, through the same writer the API path uses ------------------
  try {
    const recorded = recordCall(db, {
      caseId,
      stage: request.stage,
      provider: EXTERNAL_SESSION,
      model: EXTERNAL_SESSION,
      effort: request.def.effort,
      promptVersion: request.def.promptVersion,
      // Null, not 0: nobody counted these tokens and nobody was billed.
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      costUsd: null,
      latencyMs: options.latencyMs ?? 0,
      // There is no provider stop_reason on this channel; naming the channel is
      // the honest value, and it keeps the column's "how did this end" meaning.
      stopReason: EXTERNAL_SESSION,
      fallbackUsed: false,
      fallbackMessage: null,
      requestId: null,
      payloadSha256,
      payloadBytes: Buffer.byteLength(json, "utf8"),
      inputManifest: request.manifest.json,
      inputManifestSha256: request.manifest.sha256,
      // Link, never a second insert: this payload already has its ledger row.
      egressId: open.id,
      sentAt: options.now,
    });
    return {
      kind: "ok",
      data,
      llmCallId: recorded.llmCallId,
      egressId: recorded.egressId,
      manifestHash: request.manifest.sha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      retryable: false,
      message: `ledger write failed: ${message}`,
    };
  }
}

/** A candidate arrives as parsed JSON or as the text of a file. */
function parseCandidate(
  candidate: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof candidate !== "string") return { ok: true, value: candidate };
  if (candidate.trim() === "") return { ok: false, message: "candidate is empty" };
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `not valid JSON: ${message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Re-exports for callers that only speak this channel                        */
/* -------------------------------------------------------------------------- */

export type { InputManifest, OutputLevel };
