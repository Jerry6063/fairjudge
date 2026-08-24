/**
 * The adverse-fact gate on judgment — SPEC M3 wave A ⑥.
 *
 * This is the anti-"help me win" gate. Before any judgment runs, the facts that
 * count against the client have to have been put in front of them, and each one
 * acknowledged or contested. Both halves matter, and the first is the one that
 * is easy to lose:
 *
 *   - `surfaced`: at least one adverse fact exists. Without it the second test
 *     passes vacuously — zero rows means zero pending — so a case where the
 *     adverse-fact pass never ran would sail through a gate that only counted
 *     pending items.
 *   - `settled`: nothing is still `pending`. "Contested" satisfies it as fully
 *     as "acknowledged": the gate asks the client to face the material, not to
 *     agree with it.
 *
 * The predicates live in this tiny module, with no imports, because two callers
 * need the same answer and must not each write their own: the stage machine
 * (which refuses the transition into `judgment`) and the judgment runner (which
 * refuses to generate even if a case row somehow sits at that stage already).
 * One definition, two enforcement points.
 */

/** The only facts the gate reads. Any adverse-fact row source can supply them. */
export interface AdverseFactCounts {
  readonly total: number;
  /** Rows whose `ack_status` is still `pending`. */
  readonly pending: number;
}

/** Why the gate is shut. */
export type JudgmentGateCode = "not_surfaced" | "acknowledgement_pending";

export type JudgmentGateVerdict =
  | { readonly open: true }
  | {
      readonly open: false;
      readonly code: JudgmentGateCode;
      readonly reason: string;
    };

/** Has the client been shown any adverse fact at all? */
export function adverseFactsSurfaced(counts: AdverseFactCounts): boolean {
  return counts.total > 0;
}

/** Is every surfaced adverse fact acknowledged or contested? */
export function adverseFactsSettled(counts: AdverseFactCounts): boolean {
  return counts.pending === 0;
}

/** May judgment run? Pure over the counts, and it says why not. */
export function checkJudgmentGate(
  counts: AdverseFactCounts,
): JudgmentGateVerdict {
  if (!adverseFactsSurfaced(counts)) {
    return {
      open: false,
      code: "not_surfaced",
      reason:
        "No adverse fact has been put in front of you yet. Judgment does not " +
        "run on a case that has never been confronted with its own weak points.",
    };
  }
  if (!adverseFactsSettled(counts)) {
    return {
      open: false,
      code: "acknowledgement_pending",
      reason:
        `${counts.pending} of ${counts.total} adverse facts are still ` +
        "pending. Each one has to be acknowledged or contested before " +
        "judgment runs — this gate cannot be skipped.",
    };
  }
  return { open: true };
}
