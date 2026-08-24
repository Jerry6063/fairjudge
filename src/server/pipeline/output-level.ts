/**
 * Locking the output level onto a case — the pass path (HARD RULE #2).
 *
 * `deriveOutputLevel` has always been the rule; until now the only thing that
 * called it was `lockCaseAsRefused`, so a level could be locked when the safety
 * screen refused a case and at no other time. A case that PASSED therefore
 * reached `pre_judgment`, satisfied every adverse-fact precondition, and then
 * stopped: `output_level_locked` was unmeetable, and the pipeline dead-ended one
 * step short of the thing it exists for.
 *
 * This module is that missing step, and it is deliberately thin. The decision
 * stays in `domain/output-level.ts`, pure and unit-tested; everything here is
 * I/O — read the facts the rule judges on, hand them over, write the answer
 * down. Nothing in this file decides a level, and nothing here may.
 *
 * Two properties worth stating outright:
 *
 *   - **The facts are read, never asserted.** The participation state comes from
 *     the participants table, the grade counts from `evidence.grade_final` (the
 *     human column — a machine suggestion is not a grade), and the citable record
 *     from the same `buildCitableBrief` query the prompts are written from, so
 *     "what the model was shown" and "what the level was derived from" cannot
 *     drift apart.
 *   - **A lock is a lock.** Re-locking to the same level is a no-op; re-locking
 *     to a different one throws. A level that silently follows the record around
 *     is not locked, and the whole point of locking it is that the judgment which
 *     cites it was issued under a level that cannot be edited afterwards.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  CASE_RECORD,
  resolveMaterialGrant,
  scopedToCase,
} from "../access/visibility";
import type { Db } from "../db";
import {
  cases,
  evidence as evidenceTable,
  utterances as utterancesTable,
  type OutputLevel,
} from "../db/schema";
import {
  explainOutputLevel,
  type EvidenceProfileInput,
  type OutputLevelDecision,
  type ParticipationInput,
  type SafetyFlags,
} from "../domain/output-level";
// The leaf, not the barrel: `safety/gate.ts` pulls in the whole LLM client, and
// nothing on the derivation path needs a model. See the import rule at the top
// of `safety/screen-record.ts`.
import { caseIsReferred } from "../safety/screen-record";
import { CITABLE_CONFIRM_STATUSES, buildCitableBrief } from "./evidence-refs";
import { readParticipation } from "./participation";

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type OutputLevelErrorCode = "case_not_found" | "already_locked";

export class OutputLevelError extends Error {
  readonly code: OutputLevelErrorCode;

  constructor(code: OutputLevelErrorCode, message: string) {
    super(message);
    this.name = "OutputLevelError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

export interface OutputLevelView {
  readonly caseId: string;
  /** What the record supports right now, with its reasoning. */
  readonly decision: OutputLevelDecision;
  /** The level written on the case, or null while it is unlocked. */
  readonly locked: OutputLevel | null;
  readonly lockedAt: Date | null;
  /**
   * The locked level is no longer what the record derives.
   *
   * Not an error and not self-healing: a judgment was (or will be) issued under
   * the locked level, and the honest response to a record that has moved since
   * is a new version that says so — not a column that quietly updates itself.
   */
  readonly stale: boolean;
}

/**
 * Read every fact the rule judges on, for one case.
 *
 * Exported because it is the cheapest way to see what a level would be derived
 * from without writing anything — the screen calls it, and so does the test.
 */
export function collectOutputLevelInputs(
  db: Db,
  caseId: string,
): {
  readonly participation: ParticipationInput;
  readonly evidence: EvidenceProfileInput;
  readonly safety: SafetyFlags;
} {
  const caseRow = db
    .select({
      id: cases.id,
      downgradeSignal: cases.downgradeSignal,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();
  if (caseRow === undefined) {
    throw new OutputLevelError("case_not_found", `No case with id ${caseId}.`);
  }

  const board = readParticipation(db, caseId);

  // `grade_final` only: the deterministic suggestion in `grade_suggested` is
  // advisory, and a level derived from unreviewed suggestions would be a level
  // derived from the machine's own guess about the machine's own material.
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of db
    .select({ grade: evidenceTable.gradeFinal })
    .from(evidenceTable)
    .where(eq(evidenceTable.caseId, caseId))
    .all()) {
    if (row.grade !== null) counts[row.grade] += 1;
  }

  // The same query every citing prompt is built from (HARD RULE #1), so the set
  // of lines the level counts is exactly the set a model may cite.
  const brief = buildCitableBrief(db, caseId);
  const clientPseudonym = brief.client?.pseudonym ?? null;
  const counterpartyPseudonym =
    brief.participants.find((party) => !party.isSubmitter)?.pseudonym ?? null;

  const byClient =
    clientPseudonym === null
      ? 0
      : brief.utterances.filter((u) => u.speaker === clientPseudonym).length;
  const byCounterparty =
    counterpartyPseudonym === null
      ? 0
      : brief.utterances.filter((u) => u.speaker === counterpartyPseudonym).length;

  const owners = confirmedMaterialOwners(db, caseId);

  return {
    participation: {
      state: board.counterparty?.participationState ?? "pending",
      downgradeSignal: caseRow.downgradeSignal,
    },
    evidence: {
      counts,
      // Ownership, read off the record (SPEC M5 ⑥). Until M5 these two were one
      // hard-coded `false` with an honest comment: nobody but the client could
      // put anything into a case, so "the counterparty confirmed something of
      // her own" had no way of being true, and reading the SPEAKER split instead
      // would have promoted the most one-sided case in the corpus to a full
      // judgment — on that case every confirmed line is hers, and every one of
      // them arrived as a screenshot the client submitted and signed off.
      //
      // M5 stamped an owner on the write path, so the honest question is now
      // answerable and is asked here rather than assumed either way.
      //
      // The two halves read the owner column differently, on purpose. Material
      // with no owner counts for the CLIENT and never for the counterparty: an
      // unstamped row is material that was in this case before anybody else
      // could put anything into it, which is exactly what migration 0011 says
      // when it backfills the column to the submitter. It is not evidence that
      // SHE submitted something, because the only path she has stamps her id —
      // so a forgotten `owner` on some write path can cost a case the level it
      // could have had, and can never hand her participation she did not do.
      hasClientConfirmed:
        board.submitter !== null &&
        (owners.byParticipant.has(board.submitter.id) || owners.unowned),
      hasCounterpartyConfirmed:
        board.counterparty !== null &&
        owners.byParticipant.has(board.counterparty.id),
      citableUtterances: {
        total: brief.utterances.length,
        byClient,
        byCounterparty,
      },
    },
    safety: { mustRefuse: caseIsReferred(db, caseId) },
  };
}

/**
 * Which parties own confirmed, citable material that is in the case record.
 *
 * Read through the same two filters everything else on this path reads through,
 * for the same reason `buildCitableBrief` is used above rather than a second
 * query: the material the level is derived from must be exactly the material a
 * judgment may cite.
 *
 *   - `CITABLE_CONFIRM_STATUSES` — HARD RULE #1. A line nobody signed off is not
 *     material, so owning one is not participating.
 *   - `scopedToCase(…, CASE_RECORD grant)` — SPEC M5 ①. Her material sitting
 *     `private` on the machine is not in the case; it counts from the moment she
 *     shares it into the record, and stops counting if she withdraws it. That is
 *     the whole point of consent being an event rather than a bit: revoking it
 *     moves the level back, and the judgment issued under the old level says so
 *     by staying locked (`stale`) instead of quietly following her around.
 *
 * Rows with no owner are reported separately rather than attributed here — see
 * the call site for which of the two questions they answer and why they only
 * answer one of them.
 */
function confirmedMaterialOwners(
  db: Db,
  caseId: string,
): { readonly byParticipant: ReadonlySet<string>; readonly unowned: boolean } {
  const grant = resolveMaterialGrant(db, caseId, CASE_RECORD);
  const rows = db
    .select({ owner: utterancesTable.ownerParticipantId })
    .from(utterancesTable)
    .where(
      and(
        scopedToCase(utterancesTable, grant),
        inArray(utterancesTable.confirmStatus, [...CITABLE_CONFIRM_STATUSES]),
      ),
    )
    .all();

  const byParticipant = new Set<string>();
  let unowned = false;
  for (const row of rows) {
    if (row.owner === null) unowned = true;
    else byParticipant.add(row.owner);
  }
  return { byParticipant, unowned };
}

/**
 * What level this case supports right now, and whether one is already locked.
 *
 * Pure read — call it from a page without side effects.
 */
export function readOutputLevel(db: Db, caseId: string): OutputLevelView {
  const row = db
    .select({
      outputLevel: cases.outputLevel,
      lockedAt: cases.outputLevelLockedAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();
  if (row === undefined) {
    throw new OutputLevelError("case_not_found", `No case with id ${caseId}.`);
  }

  const inputs = collectOutputLevelInputs(db, caseId);
  const decision = explainOutputLevel(
    inputs.participation,
    inputs.evidence,
    inputs.safety,
  );

  return {
    caseId,
    decision,
    locked: row.outputLevel,
    lockedAt: row.lockedAt,
    stale: row.outputLevel !== null && row.outputLevel !== decision.level,
  };
}

/* -------------------------------------------------------------------------- */
/* The write                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Derive the level from the record and lock it onto the case.
 *
 * Idempotent when the answer has not moved: re-locking the same level touches
 * nothing and returns the existing lock time. A different level throws
 * `already_locked` rather than overwriting, because the level is the frame a
 * judgment was written inside, and changing it under a finished judgment would
 * silently re-license claims that were never allowed.
 *
 * The write is its own guard — `WHERE output_level IS NULL` — so the decision
 * that authorizes it is enforced by the statement that performs it, not by a
 * read that happened first. Nothing can lock a case twice, whatever raced.
 *
 * This does not check the stage. Locking is a statement about the record, not a
 * step in the sequence; the stage machine is the thing that refuses to ENTER
 * `judgment` without a lock, and the judgment runner re-screens for safety
 * (`screenBeforeJudgment`) at the moment it runs.
 */
export function lockOutputLevel(db: Db, caseId: string): OutputLevelView {
  const current = readOutputLevel(db, caseId);
  const derived = current.decision.level;

  if (current.locked === derived) return current;
  if (current.locked !== null) throw alreadyLocked(current.locked, derived);

  const lockedAt = new Date();
  const written = db
    .update(cases)
    .set({ outputLevel: derived, outputLevelLockedAt: lockedAt })
    .where(and(eq(cases.id, caseId), isNull(cases.outputLevel)))
    .returning({ level: cases.outputLevel })
    .all();

  if (written.length === 0) {
    // Locked between the read and the write. Re-read rather than assume: if the
    // other writer derived the same level, this call is simply a no-op.
    const now = readOutputLevel(db, caseId);
    if (now.locked !== derived) {
      throw alreadyLocked(now.locked, derived);
    }
    return now;
  }

  return { ...current, locked: derived, lockedAt, stale: false };
}

/**
 * Move the lock to what the record derives now — the write a RE-HEARING makes,
 * and the only legitimate way a locked level changes (SPEC M5 ⑥).
 *
 * `lockOutputLevel` refuses this on purpose, and that refusal is right for every
 * other caller: a judgment was written inside the locked frame, and quietly
 * re-licensing it afterwards would let claims that were never allowed become
 * allowed retroactively. A re-hearing is the one act that does not have that
 * problem, because it does not edit anything — it issues `version + 1`
 * (HARD RULE #6), and the level a judgment was issued at is on the judgment's
 * own row. So v1 keeps `output_level = 'L2'` forever and stays byte-identical;
 * what moves is the case column, which is the frame the NEXT judgment is
 * written inside.
 *
 * That is why this function does not belong to a UI and is not called on a page:
 * its only caller is `hearAppeal`, immediately before it assembles the dossier
 * for the successor. Calling it anywhere else would move the frame under a
 * judgment that stands, and the honest reading of that state is the `stale` flag
 * `readOutputLevel` already returns.
 *
 * A case with nothing locked yet is simply locked (this is `lockOutputLevel`),
 * and a lock that already matches the record is left alone with its original
 * timestamp: "the level has not moved" and "the level moved to the same value"
 * are not the same fact, and only one of them is true.
 */
export function relockOutputLevel(db: Db, caseId: string): OutputLevelView {
  const current = readOutputLevel(db, caseId);
  if (current.locked === null) return lockOutputLevel(db, caseId);
  if (!current.stale) return current;

  const derived = current.decision.level;
  const lockedAt = new Date();
  // Guarded by the value it is replacing, so a concurrent writer cannot be
  // overwritten blind — the same discipline as the `IS NULL` guard above.
  const written = db
    .update(cases)
    .set({ outputLevel: derived, outputLevelLockedAt: lockedAt })
    .where(and(eq(cases.id, caseId), eq(cases.outputLevel, current.locked)))
    .returning({ level: cases.outputLevel })
    .all();

  if (written.length === 0) return readOutputLevel(db, caseId);
  return { ...current, locked: derived, lockedAt, stale: false };
}

function alreadyLocked(
  locked: OutputLevel | null,
  derived: OutputLevel,
): OutputLevelError {
  return new OutputLevelError(
    "already_locked",
    `This case is locked at ${locked} and the record now derives ${derived}. A ` +
      `locked level is not rewritten: the judgment issued under it was written ` +
      `inside that frame. Regenerate the judgment as a new version instead, ` +
      `which discloses what changed.`,
  );
}
