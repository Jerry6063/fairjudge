/**
 * Judgment generation — the two model calls, and every check between them
 * (SPEC M3 wave B ⑦).
 *
 * The order of operations is the module:
 *
 *     dossier (confirmed material only)
 *       -> skeleton call -> VALIDATE -> frozen fact layer
 *       -> narrative call (skeleton only) -> VALIDATE -> surface layer
 *
 * Validation sits between each model call and anything that consumes its
 * output. Nothing here writes to the database — persistence and publication are
 * `judgment/publication.ts`, and they only ever run on a result that passed.
 *
 * ## What is checked, and why each one rejects the whole generation
 *
 * Skeleton:
 *   1. **Citations** (HARD RULE #1) — every `evidence_refs` id must exist in
 *      this case and be confirmed. Checked against SQLite by
 *      `pipeline/evidence-refs.ts`, the same module the wave-A stages use.
 *   2. **Level constraints** (HARD RULE #2) — the level is read off the case,
 *      the constraint block was in the prompt, and the returned fact layer is
 *      re-checked against the same table. At L2 a non-empty
 *      `findings.responsibility` is rejected.
 *   3. **Record basis** — the counts the model restates must equal the counts
 *      computed from the database. A judgment may choose its words about the
 *      hole in its evidence; it may not choose the size of the hole.
 *   4. **Contract coherence** — id uniqueness and every internal claim
 *      reference resolving.
 *
 * Narrative:
 *   5. **The one-way rule** — a section resting on a `claim_id` the skeleton
 *      does not define rejects the judgment.
 *
 * None of these repairs anything. A hallucinated citation that is quietly
 * deleted, or a narrative section that is quietly dropped, leaves a document
 * that reads as complete with the failure erased — which is the exact outcome
 * the rules exist to prevent. One retry with the faults named, then the truth.
 *
 * ## Why the narrative call cannot see the dossier
 *
 * `runJudgmentNarrative` takes a `FactLayer` and builds its prompt from that
 * alone. Not a convention — a signature. The stage has no access to the record,
 * so a claim it did not receive is a claim it cannot ground, and the one-way
 * rule is enforced by what the second call is physically given as well as by
 * the validator that checks what comes back.
 */

import type { z } from "zod";

import type { Db } from "../db";
import type { OutputLevel } from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta } from "../llm";
import {
  advocateBriefAStage,
  advocateBriefBStage,
  judgmentNarrativeStage,
  judgmentSkeletonRehearingStage,
  judgmentSkeletonStage,
  type AdvocateBriefOutput,
} from "../llm/stages";
import { assertJudgmentAllowed } from "../pipeline/adverse-facts";
import { assembleCaseFile, stableStringify, type JsonValue } from "../pipeline/case-file";
import {
  auditCitations,
  describeCitationFaults,
  type CitationAudit,
  type CitingItem,
} from "../pipeline/evidence-refs";
import {
  advocateTask,
  assignAdvocateSeats,
  buildAdvocateInput,
  checkAdvocateBrief,
  serializeAdvocateBriefs,
  ADVOCATE_TASK_NOTE,
  type AdvocateAssignment,
  type AdvocateBriefRecord,
} from "./advocacy";
import {
  describeRecordBasisMismatches,
  verifyRecordBasis,
  type RecordBasisMismatch,
} from "./asymmetry";
import {
  describeViolations,
  validateJudgmentContract,
  type ContractViolation,
  type FactLayer,
  type SurfaceLayer,
} from "./contract";
import { planCaseSpend, type CaseSpendPlan } from "./cost";
import {
  assembleJudgmentDossier,
  serializeJudgmentDossier,
  type JudgmentDossier,
} from "./dossier";
import {
  checkLevelConstraints,
  describeLevelViolations,
  levelConstraints,
  type LevelViolation,
} from "./levels";
import {
  allocationRows,
  measureSwapDelta,
  resolveSwapGate,
  swapLimitsText,
  withholdAllocation,
  type SwapGateOutcome,
  type SwapPass,
} from "./swap-gate";
import {
  buildSwapDictionary,
  diffSkeletons,
  swapJudgmentDossier,
} from "./swap-test";

/** One generation, one retry. A third attempt does not learn anything new. */
export const MAX_JUDGMENT_ATTEMPTS = 2;

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a generation was refused by the server rather than by the model. */
export type JudgmentRejectionCode =
  /** HARD RULE #1: a citation that does not exist or is not confirmed. */
  | "invalid_refs"
  /** HARD RULE #2: the fact layer broke the locked level's constraints. */
  | "level_violation"
  /** The restated record counts do not match the database. */
  | "record_basis_mismatch"
  /** Ids collide, or something cites a claim the fact layer never defined. */
  | "contract_violation"
  /**
   * M4 ①: the document broke a rule that exists only for the copy the other
   * party receives — it carried a section written for the client alone, spoke
   * to the client in the second person, reproduced the client's own prose, or
   * failed the share gate.
   */
  | "shareable_violation"
  /**
   * M4 ②: the improvement contract cited a claim the fact layer does not
   * define, bound a party the level does not allow to be bound, or was vague
   * enough that nothing could ever have counted as keeping it.
   */
  | "improvement_contract_violation"
  /**
   * M4 ③: the repair script cited an unknown claim, opened with an accusation
   * rather than something sayable, or left the "when it goes wrong" block
   * without a bodily self-check or a return time.
   */
  | "repair_script_violation"
  /**
   * Doc 05 §B: an advocate brief was filed for the wrong party, or grounded a
   * point in a line that does not exist or is not confirmed.
   */
  | "advocate_violation";

export interface JudgmentRejection {
  readonly code: JudgmentRejectionCode;
  /** The full fault report — server-side detail, never streamed to a user. */
  readonly message: string;
  readonly citations?: CitationAudit;
  readonly levelViolations?: readonly LevelViolation[];
  readonly recordBasis?: readonly RecordBasisMismatch[];
  readonly contract?: readonly ContractViolation[];
  /** Faults specific to the counterparty's copy. See `shareable_violation`. */
  readonly shareable?: readonly {
    readonly path: string;
    readonly detail: string;
  }[];
  /**
   * Faults in a post-judgment derived document — the improvement contract or
   * the repair script (M4 ②/③). One shape for both because they are checked
   * the same way: a list of paths, each with the sentence a person and a model
   * are both owed about what is wrong with it.
   */
  readonly plan?: readonly {
    readonly path: string;
    readonly detail: string;
  }[];
}

export type JudgmentStepResult<T> =
  | {
      readonly kind: "ok";
      readonly data: T;
      readonly meta: StageMeta;
      readonly attempts: number;
    }
  | {
      readonly kind: "rejected";
      readonly rejection: JudgmentRejection;
      readonly attempts: number;
    }
  /** Nothing in this case is citable, so nothing may be adjudicated. */
  | { readonly kind: "no_material"; readonly message: string }
  | { readonly kind: "refused"; readonly category?: string }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly message: string;
    };

/** Provenance carried from a stage run onto the judgment row. */
export interface JudgmentProvenance {
  readonly model: string;
  readonly effort: "xhigh";
  readonly promptVersion: string;
  readonly fallbackUsed: boolean;
}

export function skeletonProvenance(meta: StageMeta): JudgmentProvenance {
  return {
    model: meta.model,
    effort: "xhigh",
    promptVersion: judgmentSkeletonStage.promptVersion,
    fallbackUsed: meta.fallbackUsed,
  };
}

/* -------------------------------------------------------------------------- */
/* The retry loop                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run one judgment stage with one retry, checking the result before returning
 * it.
 *
 * `check` returns null when the output stands, or the rejection describing why
 * it does not. The retry re-states the faults and asks for the whole answer
 * again — it never asks for a patch, because a patched answer is one the model
 * assembled from an answer it already knows was wrong.
 *
 * Exported for the derived documents that are generated after the judgment is
 * frozen (M4: the counterparty-addressed narrative, and the stages that follow
 * it). They are checked the same way and must retry the same way; a second copy
 * of this loop is a second policy on what "rejected" means.
 */
export async function runChecked<T>(
  basePrompt: string,
  call: (prompt: string) => Promise<
    | { kind: "ok"; data: T; meta: StageMeta }
    | { kind: "refused"; category?: string }
    | { kind: "error"; retryable: boolean; message: string }
  >,
  check: (data: T) => JudgmentRejection | null,
): Promise<JudgmentStepResult<T>> {
  let last: JudgmentRejection | null = null;

  for (let attempt = 1; attempt <= MAX_JUDGMENT_ATTEMPTS; attempt += 1) {
    const prompt =
      last === null ? basePrompt : `${basePrompt}\n\n${correction(last)}`;

    const result = await call(prompt);

    if (result.kind === "refused") {
      return result.category === undefined
        ? { kind: "refused" }
        : { kind: "refused", category: result.category };
    }
    if (result.kind === "error") {
      return {
        kind: "error",
        retryable: result.retryable,
        message: result.message,
      };
    }

    const rejection = check(result.data);
    if (rejection === null) {
      return { kind: "ok", data: result.data, meta: result.meta, attempts: attempt };
    }
    last = rejection;
  }

  /* c8 ignore next -- the loop only exits here with a rejection in hand. */
  const rejection = last as JudgmentRejection;
  return { kind: "rejected", rejection, attempts: MAX_JUDGMENT_ATTEMPTS };
}

/** The correction handed to the model on the retry. */
function correction(rejection: JudgmentRejection): string {
  return (
    `Your previous answer was rejected by the server and nothing was saved.\n\n` +
    `${rejection.message}\n\n` +
    `Produce the complete answer again, from the same input. Do not patch the ` +
    `previous one.`
  );
}

/* -------------------------------------------------------------------------- */
/* Step one — the skeleton                                                    */
/* -------------------------------------------------------------------------- */

/** Claims, flattened into the shape the citation auditor reads. */
function citingClaims(factLayer: FactLayer): CitingItem[] {
  return factLayer.claims.map((claim, at) => ({
    label: `claims[${at}] (${claim.claim_id})`,
    statement: claim.statement,
    evidenceRefs: claim.evidence_refs,
  }));
}

/**
 * Check a returned fact layer against everything the server knows.
 *
 * Exported because publication re-runs it on the persisted draft: the checks
 * that authorize a publish are the same ones that authorized the draft, run
 * again at the moment of use rather than trusted from earlier in the request.
 */
export function checkFactLayer(
  db: Db,
  caseId: string,
  level: OutputLevel,
  dossier: JudgmentDossier,
  factLayer: FactLayer,
  /**
   * The swap gate's verdict on this generation, when there is one (doc 05
   * §B.2). Absent means no gate has run — which is the state of every hearing
   * before its swap pass, including the swap pass's own arm.
   */
  swap?: { readonly allocationWithheld: boolean; readonly reason: string },
): JudgmentRejection | null {
  // 1. HARD RULE #1 — the citations, against SQLite.
  //
  // `unknown`-tier claims cite nothing by contract, so they are excluded here:
  // the auditor treats an empty ref list as a fault (every wave-A item must
  // cite something), and an unknown claim citing nothing is the correct shape,
  // not a missing citation. The contract's own check is what guarantees an
  // unknown claim is uncited and a non-unknown one is not.
  const citing = citingClaims(factLayer).filter(
    (_, at) => factLayer.claims[at].tier !== "unknown",
  );
  const audit = auditCitations(db, caseId, citing);
  if (!audit.ok) {
    return {
      code: "invalid_refs",
      message: describeCitationFaults(audit),
      citations: audit,
    };
  }

  // 2. HARD RULE #2 — the level the case is locked at, re-checked in code —
  //    and, alongside it, whether this generation earned the allocation it is
  //    carrying (doc 05 §B.2; the level itself is untouched either way).
  const levelViolations = checkLevelConstraints(level, factLayer, swap);
  if (levelViolations.length > 0) {
    return {
      code: "level_violation",
      message: describeLevelViolations(levelViolations),
      levelViolations,
    };
  }

  // 3. The record's own arithmetic, computed from the database.
  const mismatches = verifyRecordBasis(
    dossier.asymmetry,
    factLayer.findings.record_basis,
  );
  if (mismatches.length > 0) {
    return {
      code: "record_basis_mismatch",
      message: describeRecordBasisMismatches(mismatches),
      recordBasis: mismatches,
    };
  }

  // 4. Internal coherence. No narrative yet — that is the legitimate state
  //    between step one and step two.
  const contract = validateJudgmentContract(factLayer, null);
  if (!contract.ok) {
    return {
      code: "contract_violation",
      message: describeViolations(contract.violations, "The fact layer"),
      contract: contract.violations,
    };
  }

  return null;
}

/**
 * The task turn appended after the dossier.
 *
 * Exported because `scripts/fairjudge-cli.ts` shows the operator the exact
 * prompt a hearing will be sent, and was carrying a commented copy of this
 * string to do it. Two copies of a prompt are two prompts: the one that drifts
 * is the one nobody is running, and the operator reading it is being shown a
 * hearing that does not exist.
 */
export const SKELETON_TASK =
  "Produce the fact layer for this case: the claims this judgment will rest " +
  "on, and the case-level findings. Ground every claim that is not tier " +
  '"unknown" in at least one utterance id from the EVIDENCE block above, ' +
  "restate the record-basis counts exactly as given, and stay inside the " +
  "output-level constraints — the server re-checks all three and rejects the " +
  "whole generation on any of them.";

/**
 * What the locked level tells this generation to DO — assembled from
 * `LEVEL_RULES`, never written out per level here (SPEC M5 ⑥, HARD RULE #2).
 *
 * The dossier already carries the level's `requires` / `forbids` block, which is
 * the description. This is the instruction, and it exists because L1 changed the
 * answer to one question the description leaves implicit: at L2 and L3 the
 * responsibility list must be empty, and at L1 filling it in is the point of the
 * level. A model reading "responsibility_split_allowed: true" and a task turn
 * that says nothing about it will write a one-sided document at a level that was
 * unlocked by both parties putting material in.
 *
 * Every sentence below is selected by `allowsResponsibilitySplit`, so changing
 * which levels may allocate changes what is asked for as well as what is
 * checked. Nothing here asks the model to decide anything about its own level:
 * the level arrives locked, and `checkLevelConstraints` re-checks what comes
 * back against the same table this text was generated from.
 */
export function renderLevelTask(level: OutputLevel): string {
  const rules = levelConstraints(level);
  const responsibility = rules.allowsResponsibilitySplit
    ? `This level permits a responsibility finding, and expects one where the ` +
      `record supports it: fill findings.responsibility with one row per party ` +
      `you can say something about, each with a qualitative allocation and the ` +
      `claim_ids it rests on. A hearing that could read both parties and ` +
      `allocated nothing has to say why, in a limits section.`
    : `findings.responsibility MUST be an empty list at this level. An ` +
      `allocation of "not_established" is still a row addressed to a party and ` +
      `is rejected the same way; if this hearing did not allocate ` +
      `responsibility, say so in a limits section instead.`;

  return (
    `## Working inside ${level} (locked on this case before you were asked)\n` +
    `${rules.label}.\n` +
    `${responsibility}\n` +
    `No share of responsibility may be written as a number — no percentage, ` +
    `ratio or score — in any statement, at any level. The server scans this ` +
    `fact layer's own prose for one (quoted evidence excluded, because what a ` +
    `party said is theirs) and rejects the whole generation on a hit.`
  );
}

export interface JudgmentRunOptions {
  readonly llm?: RunStageOptions;
  /** Skip the adverse-fact gate check. Tests only; never in a server path. */
  readonly skipGate?: boolean;
  /**
   * Hear a dossier the caller assembled, instead of reading the record.
   *
   * The swap test is why this exists (SPEC ⑨): its second arm puts the same
   * record to the model with the party register exchanged, and without a seam
   * here there is no way in — `assembleJudgmentDossier` reads SQLite, and the
   * swapped register is deliberately never a state of the database.
   *
   * It is a narrow seam on purpose. The dossier carries its own asymmetry, and
   * `checkFactLayer` verifies the restated counts against **that** object, so a
   * caller passing a doctored dossier gets a hearing checked against the
   * doctored numbers — self-consistent, and no longer a check on the record.
   * Two things stay outside its reach regardless: citations are audited against
   * SQLite by `caseId` (HARD RULE #1 cannot be bypassed by handing in a
   * document), and the level constraints come from the dossier's own level,
   * which `swapJudgmentDossier` copies rather than chooses. Nothing produced
   * from an injected dossier is published — `publication.ts` assembles its own.
   */
  readonly dossier?: JudgmentDossier;
  /**
   * The blind advocate pair's briefs, when the pair ran (L1, doc 05 §B).
   *
   * Seated by the dossier being heard, so the swapped arm reads the same two
   * briefs in the other order (`seatBriefs`). Absent below L1 and whenever the
   * cost ceiling collapsed the pair back into the single steelman call.
   */
  readonly briefs?: readonly AdvocateBriefRecord[];
  /**
   * Which hearing this is. `judgmentSkeletonRehearingStage` is the same hearing
   * at effort `max` — what a failed swap test buys (doc 05 §B.2 step 3).
   */
  readonly skeletonStage?: typeof judgmentSkeletonStage;
  /** The swap gate's verdict, when one has been resolved. See `checkFactLayer`. */
  readonly swap?: { readonly allocationWithheld: boolean; readonly reason: string };
}

/**
 * Step one: the fact layer.
 *
 * Runs the adverse-fact gate first (SPEC ⑥ is a hard precondition, and this is
 * its second enforcement point — the stage machine is the first), then assembles
 * the dossier, then calls fable at `xhigh`.
 */
export async function runJudgmentSkeleton(
  db: Db,
  caseId: string,
  options: JudgmentRunOptions = {},
): Promise<
  JudgmentStepResult<FactLayer> & { readonly dossier?: JudgmentDossier }
> {
  if (options.skipGate !== true) assertJudgmentAllowed(db, caseId);

  const dossier = options.dossier ?? assembleJudgmentDossier(db, caseId);
  if (dossier.asymmetry.citableUtterances.total === 0) {
    return {
      kind: "no_material",
      message:
        "Nothing in this case has been confirmed, so there is nothing a " +
        "judgment could be grounded in. Confirm the transcription first — " +
        "unconfirmed lines are invisible to every stage downstream.",
    };
  }

  // The pair, when it ran, sits between the record and the task turn: it is
  // material the hearing reads, not an instruction about how to hear. Seated by
  // THIS dossier's client marker, so the swapped arm reads the same two briefs
  // in the other order without anything being renamed.
  const briefs =
    options.briefs === undefined || options.briefs.length === 0
      ? ""
      : `\n\n## Advocate briefs (one per party, written independently)\n` +
        `${serializeAdvocateBriefs(options.briefs, dossier.asymmetry.clientPseudonym)}` +
        `\n\n${ADVOCATE_TASK_NOTE}`;

  const basePrompt =
    `${serializeJudgmentDossier(dossier)}${briefs}\n\n${SKELETON_TASK}\n\n` +
    `${renderLevelTask(dossier.outputLevel)}`;
  const dict = buildCaseDict(db, caseId);
  const stage = options.skeletonStage ?? judgmentSkeletonStage;

  const result = await runChecked<FactLayer>(
    basePrompt,
    (prompt) => runStage(stage, { prompt, dict, caseId }, { db, ...options.llm }),
    (data) =>
      checkFactLayer(
        db,
        caseId,
        dossier.outputLevel,
        dossier,
        data,
        options.swap,
      ),
  );

  return { ...result, dossier };
}

/* -------------------------------------------------------------------------- */
/* Step two — the narrative                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The prompt for step two: the frozen skeleton, and the constraints of the
 * level it was written under. No dossier, no evidence block, no record.
 *
 * Byte-stable — `stableStringify` sorts every object's keys and the fact layer
 * carries no timestamps.
 */
export function renderNarrativePrompt(
  level: OutputLevel,
  factLayer: FactLayer,
): string {
  const rules = levelConstraints(level);
  return (
    `## Output level (locked on this case; enforced in code)\n` +
    `${stableStringify({
      level,
      label: rules.label,
      requires: [...rules.requires],
      forbids: [...rules.forbids],
      responsibility_split_allowed: rules.allowsResponsibilitySplit,
    })}\n\n` +
    `## Judgment skeleton (frozen — this is the entire factual basis you have)\n` +
    // The fact layer is plain JSON by construction (it round-trips through a
    // JSON column), so the cast asserts nothing the schema does not already
    // guarantee; `stableStringify` sorts the keys.
    `${stableStringify(factLayer as unknown as JsonValue)}\n\n` +
    `Write the judgment from this skeleton. Every section's claim_ids must be ` +
    `ids defined in the skeleton above; a section citing anything else is ` +
    `rejected by the server and the whole judgment fails.`
  );
}

/**
 * Check a returned surface layer against the skeleton it must not out-run.
 *
 * Exported for the same reason `checkFactLayer` is: publication re-runs it.
 */
export function checkSurfaceLayer(
  factLayer: FactLayer,
  surfaceLayer: SurfaceLayer,
): JudgmentRejection | null {
  const contract = validateJudgmentContract(factLayer, surfaceLayer);
  if (contract.ok) return null;
  return {
    code: "contract_violation",
    message: describeViolations(contract.violations, "The narrative"),
    contract: contract.violations,
  };
}

/**
 * Step two: the narrative, from the frozen skeleton alone.
 *
 * The `factLayer` parameter is the whole input. The database is passed only for
 * the audit rows and the pseudonym dictionary — nothing about the record enters
 * this prompt.
 */
export async function runJudgmentNarrative(
  db: Db,
  caseId: string,
  level: OutputLevel,
  factLayer: FactLayer,
  options: JudgmentRunOptions = {},
): Promise<JudgmentStepResult<SurfaceLayer>> {
  const basePrompt = renderNarrativePrompt(level, factLayer);
  const dict = buildCaseDict(db, caseId);

  return runChecked<SurfaceLayer>(
    basePrompt,
    (prompt) =>
      runStage(
        judgmentNarrativeStage,
        { prompt, dict, caseId },
        { db, ...options.llm },
      ),
    (data) => checkSurfaceLayer(factLayer, data),
  );
}

/* -------------------------------------------------------------------------- */
/* The blind advocate pair (doc 05 §B, L1 only)                               */
/* -------------------------------------------------------------------------- */

/**
 * Run both advocate seats and return their briefs.
 *
 * The two calls are made from two independently assembled inputs
 * (`buildAdvocateInput`), and neither input contains the other seat's output —
 * seat A's brief does not exist when seat A runs, and it is not serialized into
 * seat B's. That is the entire blindness mechanism, and it is a fact about the
 * bytes rather than a request in a prompt.
 *
 * Sequential rather than concurrent, for the same reason `runSwapTest` fixes its
 * arm order: a run should be reproducible from the audit rows, and two
 * concurrent calls write `llm_calls` in whichever order they finish.
 *
 * A seat that returns `can_produce: false` is kept, not dropped. "The record
 * supports no case for this party" is the answer the skeleton needs, and losing
 * it would let the hearing believe a party was argued for when they were not.
 */
export async function runAdvocatePair(
  db: Db,
  caseId: string,
  options: JudgmentRunOptions = {},
): Promise<JudgmentStepResult<readonly AdvocateBriefRecord[]>> {
  const seats = assignAdvocateSeats(db, caseId);
  const stages = [advocateBriefAStage, advocateBriefBStage] as const;
  const dict = buildCaseDict(db, caseId);
  const briefs: AdvocateBriefRecord[] = [];

  let meta: StageMeta | null = null;
  let attempts = 0;

  for (const [index, assignment] of seats.entries()) {
    const input = buildAdvocateInput(db, caseId, assignment);
    const basePrompt = `${input.text}\n\n${advocateTask(assignment)}`;
    const stage = stages[index];

    const result = await runChecked<AdvocateBriefOutput>(
      basePrompt,
      (prompt) => runStage(stage, { prompt, dict, caseId }, { db, ...options.llm }),
      (data) => toAdvocateRejection(db, caseId, assignment, data),
    );

    if (result.kind !== "ok") return result;

    briefs.push({
      seat: assignment.seat,
      party: assignment.party,
      isClient: assignment.isClient,
      brief: result.data,
    });
    meta = result.meta;
    attempts += result.attempts;
  }

  /* c8 ignore next 3 -- `assignAdvocateSeats` returns two seats or throws. */
  if (meta === null) {
    return { kind: "error", retryable: false, message: "No advocate seat ran." };
  }

  return { kind: "ok", data: briefs, meta, attempts };
}

function toAdvocateRejection(
  db: Db,
  caseId: string,
  assignment: AdvocateAssignment,
  brief: AdvocateBriefOutput,
): JudgmentRejection | null {
  const fault = checkAdvocateBrief(db, caseId, assignment, brief);
  if (fault === null) return null;
  return fault.citations === undefined
    ? { code: "advocate_violation", message: fault.message }
    : {
        code: "advocate_violation",
        message: fault.message,
        citations: fault.citations,
      };
}

/* -------------------------------------------------------------------------- */
/* The gated hearing (doc 05 §B.2 / §B.5)                                     */
/* -------------------------------------------------------------------------- */

/** One hearing, its swap pass, and everything the two of them decided. */
export interface GatedHearing {
  /** What ships: the surviving hearing's fact layer, allocation withheld if so. */
  readonly factLayer: FactLayer;
  /** The fact layer as the model returned it, before any withholding. */
  readonly heardFactLayer: FactLayer;
  readonly dossier: JudgmentDossier;
  readonly gate: SwapGateOutcome;
  readonly plan: CaseSpendPlan;
  /** The briefs, when the pair ran. Empty below L1 and when the pair was cut. */
  readonly advocates: readonly AdvocateBriefRecord[];
  /**
   * The limits body publication writes into the document, composed in code:
   * the swap disclosure, the disagreement display where the seats diverged, and
   * one sentence per cut the cost ceiling made.
   */
  readonly limits: string;
}

/**
 * Hear the case, test the hearing, and decide what may be published.
 *
 * The sequence, and the sequence is the guarantee (doc 05 §B.2):
 *
 *     [advocate pair, L1 only] -> skeleton (A-first seating)
 *       -> swap pass (same inputs, register exchanged, PASS ONE'S OUTPUT NOT
 *          AMONG THEM)
 *       -> delta ≤ threshold ? publish : re-hear at effort max -> swap again
 *       -> still > threshold ? withhold the allocation, in code, before the
 *          narrative is written
 *
 * The swap pass is built from a swapped **dossier**, not from pass one's
 * skeleton: `runJudgmentSkeleton` is called a second time with `dossier` set to
 * `swapJudgmentDossier(...)`, and there is no parameter on it through which a
 * fact layer could be handed to a hearing. Independence is therefore a property
 * of the function's signature rather than a discipline this function observes.
 *
 * ## What happens when the swap pass cannot run
 *
 * It is refused rather than skipped. A case with three parties has no exchange
 * to make, and an arm that failed produced no comparison — in both states the
 * allocation is **withheld**, because "we could not test this" and "this passed"
 * are not the same sentence and only one of them is true. The swap pass is on
 * doc 05 §B.5's never-cut list, so there is no budget under which its absence
 * becomes acceptable.
 */
export async function runGatedHearing(
  db: Db,
  caseId: string,
  options: JudgmentRunOptions = {},
): Promise<JudgmentStepResult<GatedHearing>> {
  if (options.skipGate !== true) assertJudgmentAllowed(db, caseId);

  const dossier = options.dossier ?? assembleJudgmentDossier(db, caseId);
  const plan = planCaseSpend(db, caseId, { level: dossier.outputLevel });
  const llmOptions: JudgmentRunOptions = { llm: options.llm, skipGate: true };

  // --- the pair ------------------------------------------------------------
  let advocates: readonly AdvocateBriefRecord[] = [];
  if (dossier.outputLevel === "L1" && plan.advocatePairAvailable) {
    const pair = await runAdvocatePair(db, caseId, llmOptions);
    if (pair.kind !== "ok") return pair;
    advocates = pair.data;
  }

  // --- pass one ------------------------------------------------------------
  const first = await runJudgmentSkeleton(db, caseId, {
    ...llmOptions,
    dossier,
    briefs: advocates,
  });
  if (first.kind !== "ok") return first;

  // --- the swap pass, and the one re-hearing it may buy ---------------------
  //
  // The gate decides whether this generation earned its allocation, so a level
  // that licenses no allocation has nothing for it to decide: below L1
  // `findings.responsibility` is empty by the level's own constraint, already
  // checked, and a swap arm there would pay a full hearing to compare two empty
  // lists. That is not the never-cut rule being bent — the swap pass is never
  // cut where there is an allocation riding on it, and doc 05 §B.5's ceiling is
  // easier to hold when the money is spent at the level that spends it on
  // something.
  if (!levelConstraints(dossier.outputLevel).allowsResponsibilitySplit) {
    return {
      kind: "ok",
      meta: first.meta,
      attempts: first.attempts,
      data: {
        factLayer: first.data,
        heardFactLayer: first.data,
        dossier,
        gate: unlicensedGate(dossier.outputLevel),
        plan,
        advocates,
        limits: hearingLimits(unlicensedGate(dossier.outputLevel), plan),
      },
    };
  }

  const passes: SwapPass[] = [];
  let surviving = first;
  let swapUnavailable: string | null = null;

  const firstSwap = await runSwapPass(db, caseId, dossier, advocates, 1, first.data, llmOptions);
  if (firstSwap.kind === "unavailable") swapUnavailable = firstSwap.reason;
  else passes.push(firstSwap.pass);

  let rehearingCut = false;
  if (swapUnavailable === null && passes[0].delta.exceeded) {
    if (plan.rehearingAvailable) {
      const second = await runJudgmentSkeleton(db, caseId, {
        ...llmOptions,
        dossier,
        briefs: advocates,
        skeletonStage: judgmentSkeletonRehearingStage,
      });
      if (second.kind !== "ok") return second;
      surviving = second;

      const secondSwap = await runSwapPass(
        db,
        caseId,
        dossier,
        advocates,
        2,
        second.data,
        { ...llmOptions, skeletonStage: judgmentSkeletonRehearingStage },
      );
      if (secondSwap.kind === "unavailable") swapUnavailable = secondSwap.reason;
      else passes.push(secondSwap.pass);
    } else {
      rehearingCut = true;
    }
  }

  const gate =
    swapUnavailable === null
      ? resolveSwapGate({ passes, rehearingCut })
      : untestedGate(surviving.data, swapUnavailable, rehearingCut);

  const factLayer = gate.allocationWithheld
    ? withholdAllocation(surviving.data)
    : surviving.data;

  return {
    kind: "ok",
    meta: surviving.meta,
    attempts: surviving.attempts,
    data: {
      factLayer,
      heardFactLayer: surviving.data,
      dossier,
      gate,
      plan,
      advocates,
      limits: hearingLimits(gate, plan),
    },
  };
}

/**
 * The everything-else limits body: the swap disclosure, the disagreement
 * display, and one sentence per cut the ceiling made.
 *
 * Composed here rather than asked for, which is what makes the disclosures
 * unconditional — a cut that happened is a cut that is stated, whatever the
 * model chose to write about.
 */
export function hearingLimits(
  gate: SwapGateOutcome,
  plan: CaseSpendPlan,
): string {
  return [swapLimitsText(gate), ...plan.disclosures]
    .filter((piece) => piece !== "")
    .join("\n\n");
}

/**
 * The gate's answer at a level that licenses no allocation.
 *
 * `disclosure` is empty on purpose. A document that allocated nothing because
 * its level allocates nothing already says so in its own limits section, and
 * adding "the allocation we never made was not tested" would be the product
 * talking about its machinery instead of about the case.
 */
function unlicensedGate(level: OutputLevel): SwapGateOutcome {
  return {
    disposition: "not_applicable",
    allocationWithheld: false,
    reason:
      `This case is locked at ${level}, which allocates no responsibility at ` +
      `all, so there was no allocation for the swap gate to test.`,
    passes: [],
    rehearingRun: false,
    rehearingCut: false,
    disclosure: "",
    disagreements: [],
  };
}

/** The gate's answer when the swap pass could not be run or did not return. */
function untestedGate(
  factLayer: FactLayer,
  reason: string,
  rehearingCut: boolean,
): SwapGateOutcome {
  const rows = allocationRows(factLayer);
  if (rows.length === 0) {
    return {
      disposition: "not_applicable",
      allocationWithheld: false,
      reason: `${reason} This hearing allocated no responsibility, so nothing was riding on the test.`,
      passes: [],
      rehearingRun: false,
      rehearingCut,
      disclosure:
        `This hearing allocated no responsibility. The check that would have ` +
        `tested an allocation — hearing the same record again with the parties' ` +
        `positions exchanged — could not be run for this case: ${reason}`,
      disagreements: [],
    };
  }

  return {
    disposition: "allocation_withheld",
    allocationWithheld: true,
    reason: `${reason} An allocation that could not be tested is not published as one that passed.`,
    passes: [],
    rehearingRun: false,
    rehearingCut,
    disclosure:
      `**No allocation of responsibility is stated in this document.** Every ` +
      `allocation this product publishes has first been tested by hearing the ` +
      `same record again with the parties' positions in the register ` +
      `exchanged, so that a conclusion attached to a name rather than to the ` +
      `record shows up as a difference between the two hearings. That test ` +
      `could not be run here: ${reason} An untested allocation and a tested ` +
      `one are not the same finding, and this document does not present the ` +
      `first as the second.`,
    disagreements: [],
  };
}

type SwapPassResult =
  | { readonly kind: "pass"; readonly pass: SwapPass }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * One swap arm: the same inputs with the register and the address-term
 * dictionary exchanged, heard independently, and diffed against the arm it is
 * being compared with.
 *
 * `filed` is passed in **only to be diffed against the result** — it is never
 * part of what the swapped hearing is sent. The swapped prompt is assembled from
 * `swapJudgmentDossier(dossier, dict)` and the same advocate briefs, re-seated
 * by the swapped register's own client marker.
 */
async function runSwapPass(
  db: Db,
  caseId: string,
  dossier: JudgmentDossier,
  advocates: readonly AdvocateBriefRecord[],
  pass: 1 | 2,
  filed: FactLayer,
  options: JudgmentRunOptions,
): Promise<SwapPassResult> {
  let swappedDossier: JudgmentDossier;
  let parties: readonly string[];
  try {
    const dict = buildSwapDictionary(assembleCaseFile(db, caseId));
    swappedDossier = swapJudgmentDossier(dossier, dict);
    parties = [dict.pair.a, dict.pair.b];
  } catch (error) {
    return {
      kind: "unavailable",
      reason:
        error instanceof Error
          ? `the exchange could not be applied to this case (${error.message})`
          : `the exchange could not be applied to this case`,
    };
  }

  const swapped = await runJudgmentSkeleton(db, caseId, {
    ...options,
    dossier: swappedDossier,
    briefs: advocates,
  });

  if (swapped.kind !== "ok") {
    return {
      kind: "unavailable",
      reason:
        `the second hearing did not produce a comparable result ` +
        `(${swapped.kind === "rejected" ? swapped.rejection.code : swapped.kind})`,
    };
  }

  const filedClient = dossier.asymmetry.clientPseudonym ?? "";
  const swappedClient = swappedDossier.asymmetry.clientPseudonym ?? "";

  const differences = diffSkeletons(filed, swapped.data, {
    filedClient,
    swappedClient,
    parties,
  });

  return {
    kind: "pass",
    pass: {
      pass,
      delta: measureSwapDelta(differences),
      filedAllocations: allocationRows(filed),
      swappedAllocations: allocationRows(swapped.data),
      filedClient,
      swappedClient,
    },
  };
}
