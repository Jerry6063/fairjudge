/**
 * Scheduling the 7 / 30-day check-ins at judgment freeze time (SPEC M4 ④).
 *
 * Two rows per case, anchored to the moment the judgment was frozen. That is
 * the whole of it — but three decisions inside it are load-bearing:
 *
 * **The anchor is `finalized_at`, not "now".** A judgment frozen last Tuesday
 * gets a check-in seven days after last Tuesday, even if the scheduler only
 * catches up today. The window belongs to the judgment; if the process was
 * down, the follow-up is late, and the product's job is to say so — not to
 * quietly restart the clock so the dashboard looks clean.
 *
 * **Scheduling is idempotent in storage.** `followups_case_kind_unique` plus
 * `onConflictDoNothing` means the freeze path and the catch-up sweep can both
 * run, in either order, and still produce exactly two rows. No caller has to
 * know whether someone else already did this.
 *
 * **A re-hearing does not restart or duplicate the clock.** An appeal that
 * produces version 2 lands on the same two rows: the check-in asks whether
 * behaviour changed after the case was heard, and the case was heard once. Two
 * overlapping 7-day check-ins would be noise, and a restarted clock would be a
 * way to never be overdue. `judgment_id` records which judgment scheduled the
 * row, so the provenance is still on the record.
 *
 * The improvement contract is deliberately NOT a precondition. It may not exist
 * yet when the judgment freezes — it is generated afterwards, and (M4 ②) by
 * different code. Keying off the judgment means the check-in is scheduled
 * either way; `linkImprovementContract` attaches the contract later, and the
 * generation step reads whatever is attached at the moment it runs.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../db";
import { followups, improvementContracts, judgments } from "../db/schema";
import type { FollowupKind } from "../db/schema";
import { toFollowupRecord, type FollowupRecord } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far after the freeze each check-in falls. */
export const FOLLOWUP_OFFSETS_MS: Readonly<Record<FollowupKind, number>> = {
  day7: 7 * DAY_MS,
  day30: 30 * DAY_MS,
};

export interface ScheduleOptions {
  /** Injected clock, used only when the judgment has no `finalized_at`. */
  readonly now?: number;
}

/**
 * Schedule both check-ins for a frozen judgment. Safe to call repeatedly.
 *
 * Returns every follow-up row the case has afterwards, whether this call
 * created it or found it — a caller that wants to know "is this case covered"
 * gets the answer without a second query, and a caller that does not can
 * ignore it.
 *
 * A draft is refused: the anchor is the freeze, and an unfrozen judgment has
 * not got one. Refused loudly, because a silently unscheduled follow-up is the
 * exact failure this module exists to prevent.
 */
export function scheduleFollowupsForJudgment(
  db: Db,
  judgmentId: string,
  options: ScheduleOptions = {},
): FollowupRecord[] {
  const judgment = db
    .select({
      id: judgments.id,
      caseId: judgments.caseId,
      status: judgments.status,
      finalizedAt: judgments.finalizedAt,
    })
    .from(judgments)
    .where(eq(judgments.id, judgmentId))
    .get();

  if (judgment === undefined) {
    throw new Error(`Cannot schedule follow-ups: no judgment with id ${judgmentId}.`);
  }
  if (judgment.status === "draft") {
    throw new Error(
      `Cannot schedule follow-ups for judgment ${judgmentId}: it is still a ` +
        `draft. The 7 / 30-day windows are measured from the freeze, and a ` +
        `draft has not been frozen.`,
    );
  }

  const anchor = (judgment.finalizedAt ?? new Date(options.now ?? Date.now())).getTime();
  const contractId = latestContractIdFor(db, judgment.caseId, judgmentId);

  db.transaction((tx) => {
    for (const kind of Object.keys(FOLLOWUP_OFFSETS_MS) as FollowupKind[]) {
      tx.insert(followups)
        .values({
          caseId: judgment.caseId,
          kind,
          scheduledAt: new Date(anchor + FOLLOWUP_OFFSETS_MS[kind]),
          judgmentId: judgment.id,
          improvementContractId: contractId,
          status: "scheduled",
          generationStatus: "pending",
        })
        // Already scheduled — by an earlier freeze, a catch-up sweep, or the
        // other half of this same pair. Nothing to correct.
        .onConflictDoNothing({
          target: [followups.caseId, followups.kind],
        })
        .run();
    }
  });

  return db
    .select()
    .from(followups)
    .where(eq(followups.caseId, judgment.caseId))
    .orderBy(asc(followups.scheduledAt))
    .all()
    .map(toFollowupRecord);
}

/**
 * Schedule anything a freeze should have scheduled and did not.
 *
 * The self-healing half of the pair. `scheduleFollowupsForJudgment` runs on the
 * freeze path; this runs at application start and finds every final judgment
 * whose case has no check-ins — because the freeze happened before this feature
 * existed, because the process died mid-transaction, or because a judgment was
 * imported rather than generated. A feature whose only entry point is one call
 * site is a feature that is one missed call site away from silence.
 *
 * The anchor is the case's **first** final judgment, so a case re-heard on
 * appeal keeps the original window.
 */
export function catchUpSchedule(db: Db, options: ScheduleOptions = {}): FollowupRecord[] {
  const withFollowups = new Set(
    db
      .select({ caseId: followups.caseId })
      .from(followups)
      .all()
      .map((row) => row.caseId),
  );

  const anchors = new Map<string, string>();
  for (const row of db
    .select({ id: judgments.id, caseId: judgments.caseId })
    .from(judgments)
    .where(eq(judgments.status, "final"))
    .orderBy(asc(judgments.version))
    .all()) {
    if (withFollowups.has(row.caseId)) continue;
    if (!anchors.has(row.caseId)) anchors.set(row.caseId, row.id);
  }

  const created: FollowupRecord[] = [];
  for (const judgmentId of anchors.values()) {
    created.push(...scheduleFollowupsForJudgment(db, judgmentId, options));
  }
  return created;
}

/**
 * Attach the improvement contract to check-ins that were scheduled before it
 * existed — the other side of the documented seam.
 *
 * Only rows whose questions have not been generated yet are touched: once a
 * check-in is `ready`, its questions were written against a snapshot of the
 * commitments, and repointing it at a different contract would make the stored
 * questions lie about what they are asking after.
 */
export function linkImprovementContract(
  db: Db,
  caseId: string,
  improvementContractId: string,
): number {
  return db
    .update(followups)
    .set({ improvementContractId })
    .where(
      and(
        eq(followups.caseId, caseId),
        isNull(followups.improvementContractId),
        inArray(followups.generationStatus, ["pending", "failed"]),
      ),
    )
    .returning({ id: followups.id })
    .all().length;
}

/**
 * The contract to attach at scheduling time, if there is one yet.
 *
 * Prefers a contract written against this judgment; falls back to any contract
 * on the case. Returns null when the contract table is empty for this case,
 * which is the normal state at freeze time and is not a problem.
 */
function latestContractIdFor(
  db: Db,
  caseId: string,
  judgmentId: string,
): string | null {
  const forJudgment = db
    .select({ id: improvementContracts.id })
    .from(improvementContracts)
    .where(eq(improvementContracts.judgmentId, judgmentId))
    .get();
  if (forJudgment !== undefined) return forJudgment.id;

  const forCase = db
    .select({ id: improvementContracts.id })
    .from(improvementContracts)
    .where(eq(improvementContracts.caseId, caseId))
    .get();
  return forCase?.id ?? null;
}
