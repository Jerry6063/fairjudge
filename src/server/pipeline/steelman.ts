/**
 * Steelmanning (SPEC M3 wave A ④) — the other party's strongest case.
 *
 * Only one person has submitted anything. Unless something in the pipeline
 * argues the other side properly, every later stage inherits a one-sided frame
 * and prints it as a finding. This module is that something.
 *
 * Three properties are enforced here rather than asked for in the prompt:
 *
 *   1. **It is written from the record, not from imagination.** Every point the
 *      stage returns carries `grounded_in` refs, and every ref is resolved
 *      against the case file's handle table before anything is persisted. The
 *      handle table contains citable rows and nothing else, so an unknown ref
 *      is either invented or points at material a human has not confirmed —
 *      both reject the whole generation, never just the offending point
 *      (HARD RULE #1). Resolved utterance handles are then run through
 *      `checkEvidenceRefs`, the same validator the rest of the pipeline uses,
 *      so "citable" keeps one definition in the codebase.
 *   2. **Failure is recorded, not swallowed.** A model that declines, or that
 *      reports it cannot write a version the other party would recognize, or a
 *      user who cannot recognize them in what was written — each of those sets
 *      `cases.downgrade_signal` with a one-line reason. Output-level derivation
 *      reads it later, and the judgment has to disclose it. A case where the
 *      other side cannot be reconstructed supports less, and saying so is the
 *      point of the field.
 *   3. **The handles never leave this module.** Case-file refs (`U1`, `E2`) are
 *      per-assembly, so the persisted draft quotes the line itself instead of
 *      the handle that briefly stood for it.
 */

import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  cases,
  steelmanVersions,
  type ConfirmStatus,
  type SteelmanVerdict,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions } from "../llm";
import { steelmanStage, type SteelmanOutput } from "../llm/stages";
import {
  assembleCaseFile,
  findUtteranceByRef,
  resolveUtteranceRef,
  serializeCaseFile,
  type CaseFile,
} from "./case-file";
import { checkEvidenceRefs } from "./evidence-refs";
import type { Reader } from "./stage-machine";

/** One generation, one retry — the same budget the other citing stages get. */
export const MAX_STEELMAN_ATTEMPTS = 2;

/**
 * Marker on `cases.downgrade_reason` for the signals this module owns.
 *
 * It exists so the flag can be cleared again without stepping on a signal some
 * other stage recorded: a later accepted steelman clears a steelman downgrade
 * and leaves anything else alone.
 */
export const STEELMAN_DOWNGRADE_PREFIX = "Steelman: ";

/** The user turn appended after the case file. */
const STEELMAN_TASK =
  "Write the strongest honest version of the absent party's case from the " +
  "record above. Every point cites the refs it rests on (U…, E…, V… as they " +
  "appear above). If the record cannot support a version they would recognize " +
  "as their own, set can_produce to false and say what is missing.";

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

export interface SteelmanView {
  readonly id: string;
  readonly version: number;
  /** The machine's draft, or the explanation of why there is none. */
  readonly aiDraft: string | null;
  /** The user's own version of what the other party would say. */
  readonly humanFinal: string | null;
  readonly confirmStatus: ConfirmStatus;
  readonly verdict: SteelmanVerdict;
  readonly rebuttal: string | null;
  readonly verdictAt: Date | null;
  /** True when the stage itself reported it could not write one. */
  readonly unable: boolean;
}

export interface SteelmanBoard {
  readonly caseId: string;
  /** Newest version, or null when the stage has never run. */
  readonly current: SteelmanView | null;
  /** Every version, newest first. */
  readonly versions: readonly SteelmanView[];
  /** The `participation` entry requirement: answered means not `pending`. */
  readonly answered: boolean;
  readonly downgradeSignal: boolean;
  readonly downgradeReason: string | null;
}

function toView(row: typeof steelmanVersions.$inferSelect): SteelmanView {
  return {
    id: row.id,
    version: row.version,
    aiDraft: row.aiDraft,
    humanFinal: row.humanFinal,
    confirmStatus: row.confirmStatus,
    verdict: row.verdict,
    rebuttal: row.rebuttal,
    verdictAt: row.verdictAt,
    unable: row.verdict === "unable",
  };
}

/** Every steelman version on one case, plus the case's downgrade state. */
export function readSteelman(db: Reader, caseId: string): SteelmanBoard {
  const versions = db
    .select()
    .from(steelmanVersions)
    .where(eq(steelmanVersions.caseId, caseId))
    .orderBy(desc(steelmanVersions.version))
    .all()
    .map(toView);

  const caseRow = db
    .select({
      downgradeSignal: cases.downgradeSignal,
      downgradeReason: cases.downgradeReason,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();

  const current = versions[0] ?? null;

  return {
    caseId,
    current,
    versions,
    answered: current !== null && current.verdict !== "pending",
    downgradeSignal: caseRow?.downgradeSignal ?? false,
    downgradeReason: caseRow?.downgradeReason ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* The downgrade signal                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Record that this case can support less than it otherwise would.
 *
 * A fact about the record, not a verdict on anyone: the other side could not be
 * reconstructed, so the analysis has less to stand on. Written as a flag plus
 * one line of prose, because the judgment has to disclose the reason and not
 * merely the fact (HARD RULE #2's neighbour — the level is derived from state
 * like this one, never chosen by a model).
 */
export function setSteelmanDowngrade(
  db: Db,
  caseId: string,
  reason: string,
): void {
  db.update(cases)
    .set({
      downgradeSignal: true,
      downgradeReason: `${STEELMAN_DOWNGRADE_PREFIX}${reason}`,
    })
    .where(eq(cases.id, caseId))
    .run();
}

/**
 * Lift a steelman downgrade, and only a steelman downgrade.
 *
 * A signal another stage recorded is left exactly where it is — the prefix is
 * what makes that check possible.
 */
export function clearSteelmanDowngrade(db: Db, caseId: string): void {
  const row = db
    .select({ reason: cases.downgradeReason })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();
  if (row?.reason?.startsWith(STEELMAN_DOWNGRADE_PREFIX) !== true) return;

  db.update(cases)
    .set({ downgradeSignal: false, downgradeReason: null })
    .where(eq(cases.id, caseId))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Reference resolution (HARD RULE #1)                                        */
/* -------------------------------------------------------------------------- */

export type SteelmanRefKind = "utterance" | "event" | "material";

export interface ResolvedSteelmanRef {
  /** The handle as the model wrote it. */
  readonly ref: string;
  readonly kind: SteelmanRefKind;
  /** The database id behind the handle. Never rendered into the draft. */
  readonly id: string;
  /**
   * The citation as the reader sees it: the line itself, not the handle.
   * HARD RULE #5 is applied here — a recollection says so in the text.
   */
  readonly rendered: string;
}

export interface SteelmanRefRejection {
  readonly ref: string;
  readonly detail: string;
}

interface RefCheck {
  readonly resolved: readonly ResolvedSteelmanRef[];
  readonly rejected: readonly SteelmanRefRejection[];
}

function renderUtteranceCitation(
  file: CaseFile,
  ref: string,
): string | null {
  const line = findUtteranceByRef(file, ref);
  if (line === null) return null;
  const who = line.speaker ?? "someone unattributed";
  // HARD RULE #5 lives in the render layer, and this is the render layer for a
  // quote that ends up inside the persisted draft.
  return line.isRetold
    ? `as you recall it, ${who} said: “${line.text}”`
    : `${who}: “${line.text}”`;
}

/**
 * Resolve the handles one generation used.
 *
 * A handle that is not live in this assembly fails: the table only ever
 * contains confirmed, human-signed-off rows, so "not a live handle" covers the
 * invented ref and the unconfirmed line in one lookup. Utterance handles are
 * additionally run through `checkEvidenceRefs` — belt and braces, and it keeps
 * the confirmed-status question answered by the one function that owns it.
 */
export function resolveSteelmanRefs(
  db: Db,
  caseId: string,
  file: CaseFile,
  refs: readonly unknown[],
): RefCheck {
  const resolved: ResolvedSteelmanRef[] = [];
  const rejected: SteelmanRefRejection[] = [];
  const seen = new Set<string>();

  for (const raw of refs) {
    if (typeof raw !== "string" || raw.trim() === "") {
      rejected.push({
        ref: JSON.stringify(raw) ?? String(raw),
        detail: "not a citation handle",
      });
      continue;
    }
    const ref = raw.trim();
    if (seen.has(ref)) continue;
    seen.add(ref);

    const utteranceId = resolveUtteranceRef(file, ref);
    if (utteranceId !== null) {
      const check = checkEvidenceRefs(db, caseId, [utteranceId]);
      if (!check.ok) {
        /* c8 ignore next 5 -- unreachable unless the handle table drifts from
           the citable query; kept because that drift is exactly the failure
           HARD RULE #1 exists to catch. */
        rejected.push({
          ref,
          detail: check.rejected[0]?.detail ?? "that line is not citable",
        });
        continue;
      }
      const rendered = renderUtteranceCitation(file, ref);
      /* c8 ignore next -- the handle resolved above, so the line is there. */
      if (rendered === null) continue;
      resolved.push({ ref, kind: "utterance", id: utteranceId, rendered });
      continue;
    }

    const event = file.timeline.find((item) => item.ref === ref);
    if (event !== undefined) {
      const name = event.title ?? event.label ?? "an event";
      const when = event.when === null ? "undated" : event.when;
      resolved.push({
        ref,
        kind: "event",
        id: event.id,
        rendered: `event — ${name} (${when})`,
      });
      continue;
    }

    const material = file.material.find((item) => item.ref === ref);
    if (material !== undefined) {
      resolved.push({
        ref,
        kind: "material",
        id: material.id,
        rendered:
          `material — grade ${material.grade}, ${material.sourceType}` +
          (material.summary === null ? "" : `: ${material.summary}`),
      });
      continue;
    }

    rejected.push({
      ref,
      detail:
        "no such reference in this case file — it is either invented or " +
        "points at material nobody has confirmed",
    });
  }

  return { resolved, rejected };
}

/* -------------------------------------------------------------------------- */
/* Auditing and rendering one generation                                      */
/* -------------------------------------------------------------------------- */

interface GroundedFault {
  readonly label: string;
  readonly statement: string;
  readonly uncited: boolean;
  readonly rejected: readonly SteelmanRefRejection[];
}

interface GroundedAudit {
  readonly ok: boolean;
  readonly faults: readonly GroundedFault[];
  /** Per-item resolved citations, keyed by the item's label. */
  readonly citations: ReadonlyMap<string, readonly ResolvedSteelmanRef[]>;
}

/**
 * Check every grounded claim in one steelman.
 *
 * `most_likely_rebuttals` may cite nothing — a rebuttal is what the other party
 * would say about a claim, and "they would simply deny it" rests on no line in
 * the record. The account itself may not: a point of their case with nothing
 * behind it is invention, which is the failure this stage is most prone to.
 */
function auditSteelman(
  db: Db,
  caseId: string,
  file: CaseFile,
  data: SteelmanOutput,
): GroundedAudit {
  const faults: GroundedFault[] = [];
  const citations = new Map<string, readonly ResolvedSteelmanRef[]>();

  data.account.forEach((point, at) => {
    const label = `account[${at}]`;
    const check = resolveSteelmanRefs(db, caseId, file, point.grounded_in);
    citations.set(label, check.resolved);
    if (check.rejected.length > 0 || check.resolved.length === 0) {
      faults.push({
        label,
        statement: point.point,
        uncited: point.grounded_in.length === 0,
        rejected: check.rejected,
      });
    }
  });

  data.most_likely_rebuttals.forEach((rebuttal, at) => {
    const label = `most_likely_rebuttals[${at}]`;
    const check = resolveSteelmanRefs(db, caseId, file, rebuttal.grounded_in);
    citations.set(label, check.resolved);
    if (check.rejected.length > 0) {
      faults.push({
        label,
        statement: rebuttal.your_claim,
        uncited: false,
        rejected: check.rejected,
      });
    }
  });

  return { ok: faults.length === 0, faults, citations };
}

/** The fault report — read by the user on failure and by the model on retry. */
function describeFaults(audit: GroundedAudit): string {
  const lines = audit.faults.map((fault) => {
    const reasons =
      fault.rejected.length > 0
        ? fault.rejected.map((r) => `${r.ref} — ${r.detail}`)
        : ["it rests on nothing in the record"];
    return `- ${fault.label} ("${fault.statement}"): ${reasons.join("; ")}`;
  });
  return (
    `${audit.faults.length} point(s) rest on a reference that cannot stand:\n` +
    lines.join("\n")
  );
}

/**
 * Render the steelman as the prose the user reviews.
 *
 * Handles are resolved away on purpose: `U1` means nothing outside the assembly
 * that minted it, so the citation carries the quoted line instead. Quotes stay
 * in the language they were said in — an English frame around Chinese evidence
 * is the expected shape, and translating it here would substitute this module's
 * judgment for the speaker's words.
 */
export function renderSteelmanDraft(
  data: SteelmanOutput,
  citations: ReadonlyMap<string, readonly ResolvedSteelmanRef[]>,
): string {
  const parts: string[] = [data.headline.trim()];

  if (data.account.length > 0) {
    parts.push("How they would put their case");
    data.account.forEach((point, at) => {
      const cited = citations.get(`account[${at}]`) ?? [];
      const rests = cited.map((c) => `    · ${c.rendered}`).join("\n");
      parts.push(
        `${at + 1}. ${point.point}` + (rests === "" ? "" : `\n  Rests on:\n${rests}`),
      );
    });
  }

  if (data.most_likely_rebuttals.length > 0) {
    parts.push("What they would most likely rebut");
    data.most_likely_rebuttals.forEach((rebuttal, at) => {
      const cited = citations.get(`most_likely_rebuttals[${at}]`) ?? [];
      const rests = cited.map((c) => `    · ${c.rendered}`).join("\n");
      parts.push(
        `• Your account: ${rebuttal.your_claim}\n` +
          `  Their answer: ${rebuttal.their_answer}` +
          (rests === "" ? "" : `\n  Rests on:\n${rests}`),
      );
    });
  }

  return parts.filter((part) => part !== "").join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

export type SteelmanRunResult =
  | {
      readonly kind: "ok";
      readonly steelman: SteelmanView;
      readonly board: SteelmanBoard;
      readonly attempts: number;
    }
  /** The stage reported it cannot write one. Persisted, and downgraded. */
  | {
      readonly kind: "unable";
      readonly steelman: SteelmanView;
      readonly board: SteelmanBoard;
      readonly reason: string;
    }
  | { readonly kind: "no_material"; readonly message: string }
  | {
      readonly kind: "invalid_refs";
      readonly message: string;
      readonly attempts: number;
    }
  /** The model declined. Also a downgrade: the other side went unargued. */
  | {
      readonly kind: "refused";
      readonly category?: string;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly message: string;
    };

/** Persist one new version, numbered from what is already on the case. */
function insertVersion(
  db: Db,
  caseId: string,
  values: {
    readonly aiDraft: string;
    readonly verdict: SteelmanVerdict;
    readonly confirmStatus: ConfirmStatus;
  },
): SteelmanView {
  const row = db.transaction((tx) => {
    const newest = tx
      .select({ version: steelmanVersions.version })
      .from(steelmanVersions)
      .where(eq(steelmanVersions.caseId, caseId))
      .orderBy(desc(steelmanVersions.version))
      .get();

    const [written] = tx
      .insert(steelmanVersions)
      .values({
        caseId,
        version: (newest?.version ?? 0) + 1,
        aiDraft: values.aiDraft,
        verdict: values.verdict,
        confirmStatus: values.confirmStatus,
        verdictAt: values.verdict === "pending" ? null : new Date(),
      })
      .returning()
      .all();
    return written;
  });
  return toView(row);
}

/**
 * The exact bytes this stage is handed, for one case.
 *
 * Exported for the external-session runtime, which has to assemble the identical
 * request without a socket. The case file comes back with the prompt because its
 * emptiness is the caller's decision: a steelman built from unconfirmed material
 * is a guess about a person who is not here to correct it, and both runtimes
 * refuse rather than ask for one.
 */
export function buildSteelmanPrompt(
  db: Db,
  caseId: string,
): { readonly prompt: string; readonly file: CaseFile } {
  const file = assembleCaseFile(db, caseId);
  return { prompt: `${serializeCaseFile(file)}\n\n${STEELMAN_TASK}`, file };
}

/** What both runtimes say when there is nothing confirmed to argue from. */
export const NO_STEELMAN_MATERIAL =
  "Nothing in this case has been confirmed yet. A steelman assembled " +
  "from unconfirmed material would be a guess about a person who is " +
  "not here to correct it.";

export type SteelmanPersistResult =
  | { readonly kind: "ok"; readonly steelman: SteelmanView; readonly board: SteelmanBoard }
  | {
      readonly kind: "unable";
      readonly steelman: SteelmanView;
      readonly board: SteelmanBoard;
      readonly reason: string;
    }
  | { readonly kind: "invalid_refs"; readonly message: string };

/**
 * Write one validated steelman as the next version on the case.
 *
 * Split out of `generateSteelman` so the external-session channel persists
 * through the same three decisions rather than a copy of them: `can_produce:
 * false` is a real answer and is recorded as a version plus a downgrade signal;
 * a producible one is audited against the case file and rendered by
 * `renderSteelmanDraft`; an ungroundable one writes nothing at all.
 *
 * The case file is re-assembled here rather than handed in, so the refs are
 * checked against the record as it stands at the moment of the write.
 */
export function persistSteelman(
  db: Db,
  caseId: string,
  data: SteelmanOutput,
): SteelmanPersistResult {
  if (!data.can_produce) {
    const reason =
      data.unable_reason === null || data.unable_reason.trim() === ""
        ? "the record does not support any version the other party would " +
          "recognize as their own."
        : data.unable_reason.trim();
    const steelman = insertVersion(db, caseId, {
      aiDraft:
        `No version of the other party's case could be written from this ` +
        `record.\n\n${reason}`,
      verdict: "unable",
      confirmStatus: "pending",
    });
    setSteelmanDowngrade(
      db,
      caseId,
      `no version of the other party's case could be written from this ` +
        `record — ${reason}`,
    );
    return {
      kind: "unable",
      steelman,
      board: readSteelman(db, caseId),
      reason,
    };
  }

  const file = assembleCaseFile(db, caseId);
  const audit = auditSteelman(db, caseId, file, data);
  if (!audit.ok) {
    return {
      kind: "invalid_refs",
      message:
        `The other party's case was argued from material that does not hold. ` +
        `Nothing was saved.\n\n${describeFaults(audit)}`,
    };
  }

  const steelman = insertVersion(db, caseId, {
    aiDraft: renderSteelmanDraft(data, audit.citations),
    verdict: "pending",
    confirmStatus: "pending",
  });
  return { kind: "ok", steelman, board: readSteelman(db, caseId) };
}

/**
 * Write the other party's case, validate it, persist it.
 *
 * Never throws: a refusal, an unwritable steelman, a transport failure and an
 * ungroundable claim are all outcomes the caller renders. Only `kind: "ok"` and
 * `kind: "unable"` have written a version row.
 *
 * A transport error does NOT set the downgrade signal. The signal is a claim
 * about the record — that the other side cannot be reconstructed from it — and
 * a network failure says nothing about the record. A refusal does set it: the
 * model looked at this material and declined to argue that side, and the case
 * proceeds without the other side having been argued either way.
 */
export async function generateSteelman(
  db: Db,
  caseId: string,
  options: { readonly llm?: RunStageOptions } = {},
): Promise<SteelmanRunResult> {
  const { prompt: base, file } = buildSteelmanPrompt(db, caseId);
  if (file.utterances.length === 0) {
    return { kind: "no_material", message: NO_STEELMAN_MATERIAL };
  }

  const dict = buildCaseDict(db, caseId);
  let lastAudit: GroundedAudit | null = null;

  for (let attempt = 1; attempt <= MAX_STEELMAN_ATTEMPTS; attempt += 1) {
    const prompt =
      lastAudit === null
        ? base
        : `${base}\n\nYour previous answer was rejected. ` +
          `${describeFaults(lastAudit)}\n\n` +
          `Every ref must be copied exactly from the case file above. A ref ` +
          `that is not in it does not exist as far as this case is concerned, ` +
          `and a point you cannot ground has to be dropped rather than cited ` +
          `loosely. Produce the complete answer again, from the same record.`;

    const result = await runStage(
      steelmanStage,
      { prompt, dict, caseId },
      { db, ...options.llm },
    );

    if (result.kind === "refused") {
      setSteelmanDowngrade(
        db,
        caseId,
        "the model declined to write the other party's case, so this case " +
          "was never argued from the other side.",
      );
      return {
        kind: "refused",
        ...(result.category === undefined ? {} : { category: result.category }),
        message:
          "The model would not write the other party's case. That is recorded " +
          "as a downgrade signal: this case proceeds without the other side " +
          "having been argued.",
      };
    }
    if (result.kind === "error") {
      return {
        kind: "error",
        retryable: result.retryable,
        message: result.message,
      };
    }

    // One persist for both runtimes: "cannot be written" is recorded as a
    // version plus the downgrade signal, a producible one is audited and
    // rendered, and an ungroundable one writes nothing.
    const written = persistSteelman(db, caseId, result.data);
    if (written.kind === "unable") return written;
    if (written.kind === "ok") {
      return {
        kind: "ok",
        steelman: written.steelman,
        board: written.board,
        attempts: attempt,
      };
    }

    // Refused on citations. The audit is re-run only to phrase the correction —
    // the persist already decided, and this is what the model is told about it.
    lastAudit = auditSteelman(db, caseId, file, result.data);
  }

  /* c8 ignore next -- the loop only exits here with an audit in hand. */
  const audit = lastAudit as GroundedAudit;
  return {
    kind: "invalid_refs",
    attempts: MAX_STEELMAN_ATTEMPTS,
    message:
      `The other party's case was argued from material that does not hold, ` +
      `twice. Nothing was saved.\n\n${describeFaults(audit)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* The user's verdict                                                         */
/* -------------------------------------------------------------------------- */

export type SteelmanErrorCode =
  | "not_found"
  | "terminal"
  | "empty_rebuttal";

export class SteelmanError extends Error {
  readonly code: SteelmanErrorCode;

  constructor(code: SteelmanErrorCode, message: string) {
    super(message);
    this.name = "SteelmanError";
    this.code = code;
  }
}

/** What the user answered to "they would probably say roughly this". */
export type SteelmanAnswer = "accepted" | "rebutted" | "unable";

/**
 * Record the user's answer to the steelman.
 *
 * The three answers are not three flavours of the same thing:
 *   - `accepted` — they would recognize themselves in this. The case keeps
 *     whatever it had.
 *   - `rebutted` — the user writes what the other party would *actually* say.
 *     That is engagement, not failure: the other side is still argued, in the
 *     user's own words, and no downgrade follows.
 *   - `unable` — the user cannot recognize the other party in any version of
 *     this. That is a fact about the record, and it sets the downgrade signal.
 */
export function recordSteelmanVerdict(
  db: Db,
  input: {
    readonly caseId: string;
    readonly steelmanId: string;
    readonly answer: SteelmanAnswer;
    /** Required for `rebutted`: the user's own version, verbatim. */
    readonly text?: string;
  },
): SteelmanView {
  const row = db
    .select()
    .from(steelmanVersions)
    .where(
      and(
        eq(steelmanVersions.id, input.steelmanId),
        eq(steelmanVersions.caseId, input.caseId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new SteelmanError(
      "not_found",
      "That steelman is not on this case. Refresh the page.",
    );
  }
  if (row.confirmStatus === "rejected") {
    throw new SteelmanError(
      "terminal",
      "This version was set aside. Generate a new one rather than reviving it.",
    );
  }

  const text = input.text?.trim() ?? "";
  if (input.answer === "rebutted" && text === "") {
    throw new SteelmanError(
      "empty_rebuttal",
      "Write what they would actually say. An empty rebuttal records nothing, " +
        "and the other side stays unargued either way.",
    );
  }

  const patch =
    input.answer === "accepted"
      ? {
          verdict: "accepted" as const,
          confirmStatus: "confirmed" as const,
          verdictAt: new Date(),
        }
      : input.answer === "rebutted"
        ? {
            verdict: "rebutted" as const,
            confirmStatus: "edited" as const,
            humanFinal: text,
            rebuttal: text,
            verdictAt: new Date(),
          }
        : {
            verdict: "unable" as const,
            confirmStatus: "rejected" as const,
            verdictAt: new Date(),
          };

  const [written] = db
    .update(steelmanVersions)
    .set(patch)
    .where(eq(steelmanVersions.id, row.id))
    .returning()
    .all();

  if (input.answer === "unable") {
    setSteelmanDowngrade(
      db,
      input.caseId,
      "you could not recognize the other party in any version of their case " +
        "that this record supports.",
    );
  } else {
    // The record now carries an argued other side, so a steelman downgrade
    // recorded by an earlier version no longer describes it.
    clearSteelmanDowngrade(db, input.caseId);
  }

  return toView(written);
}
