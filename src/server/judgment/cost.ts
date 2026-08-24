/**
 * The per-case cost ceiling and its degradation order (doc 05 §B.5, approved
 * 2026-08-17).
 *
 * The whole architecture — every version, the advocate pair, the swap pass, the
 * post-judgment documents — has to fit **$10 per case**. When a case would
 * exceed it, the cuts happen in a fixed order and each one is disclosed in the
 * document's limits section:
 *
 *   1. **The swap-failure re-hearing.** Go directly to withholding the
 *      allocation. Cheaper and more honest than paying ~$2.5 to retry what may
 *      be a coin flip.
 *   2. **The advocate pair**, which collapses back to the single combined
 *      steelman call — the shape every hearing below L1 already uses.
 *   3. **The post-judgment documents**, which defer to opus Batches.
 *
 * And the list that has no order because nothing on it is ever cut, at any
 * spend: **the swap pass itself, the deterministic validators, the
 * pseudonymization gateway, the crisis path.** Those are what the product is;
 * a cheaper run without them is a different product that costs less.
 *
 * ## Why the plan is computed before the spending, not during it
 *
 * `planCaseSpend` is called at the decision points, reads what this case has
 * actually cost from `llm_calls`, and adds the estimated cost of what is still
 * to come. The estimates are the measured figures from doc 02 §1.5, and they are
 * estimates: the point is not to predict the bill to the cent but to decide,
 * before spending anything, which of three named things this case can still
 * afford. A budget consulted after the call is an accounting record.
 *
 * The order is also why the plan is computed as a whole rather than one
 * question at a time. The advocate pair runs early and the re-hearing runs late,
 * so "can this case afford the pair?" is only answerable if the answer already
 * assumes the re-hearing has been given up — which is exactly what the order
 * says. Asking the questions in chronological order would cut the pair to
 * protect a re-hearing that may never be needed.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import { llmCalls, type OutputLevel } from "../db/schema";

/* -------------------------------------------------------------------------- */
/* The ceiling                                                                */
/* -------------------------------------------------------------------------- */

/** What one case may cost, all versions and derived documents included. */
export const CASE_COST_CEILING_USD = 10;

/**
 * What the remaining steps are expected to cost, in USD.
 *
 * Measured, from doc 02 §1.5 (the 2026-08-16 ledger re-check) and doc 05 §B:
 * skeleton + narrative measured $0.91 for the pair; an appeal at effort `max`
 * measured $2.57; the advocate pair is +2 fable calls at effort `high`, ≈ +$0.5.
 * They are deliberately round: a false precision here would suggest the ceiling
 * is a forecast rather than a rule.
 */
export const ESTIMATED_STEP_COST_USD = {
  /** One blind advocate brief, fable at effort `high`. */
  advocateBrief: 0.25,
  /** The single combined steelman the pair collapses into. */
  steelman: 0.25,
  /** One fact-layer pass, fable at effort `xhigh`. */
  skeleton: 0.45,
  /** The swap arm. A second skeleton, and never cut. */
  swapPass: 0.45,
  /** The narrative written from the frozen skeleton. */
  narrative: 0.46,
  /** The re-hearing at effort `max` a failed swap buys. */
  rehearing: 2.5,
  /** The improvement contract and the repair script, generated inline. */
  postJudgmentDocuments: 0.6,
} as const;

/** Batches trade latency for half the price. */
export const BATCH_DISCOUNT = 0.5;

/* -------------------------------------------------------------------------- */
/* What this case has already cost                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything this case has spent, read from the audit table.
 *
 * `cost_usd` is nullable — a model with no price-list entry, or a request that
 * left and never came back, records `null` rather than 0 — and a null is counted
 * as 0 here. That under-counts, and the alternative (refusing to plan on an
 * incomplete ledger) would degrade every case whose ledger has one unpriced row.
 * The unpriced rows are reported alongside the total so a caller can see the
 * figure is a floor.
 */
export interface CaseSpend {
  readonly caseId: string;
  readonly spentUsd: number;
  /** Calls recorded against this case. */
  readonly calls: number;
  /** Calls whose cost is unknown, making `spentUsd` a floor rather than a total. */
  readonly unpricedCalls: number;
}

export function readCaseSpend(db: Db, caseId: string): CaseSpend {
  const rows = db
    .select({ costUsd: llmCalls.costUsd })
    .from(llmCalls)
    .where(eq(llmCalls.caseId, caseId))
    .all();

  let spentUsd = 0;
  let unpricedCalls = 0;
  for (const row of rows) {
    if (row.costUsd === null) unpricedCalls += 1;
    else spentUsd += row.costUsd;
  }

  return {
    caseId,
    spentUsd: round2(spentUsd),
    calls: rows.length,
    unpricedCalls,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

/** The three cuts, in the order doc 05 §B.5 fixes them. */
export const DEGRADATIONS = [
  "rehearing_cut",
  "advocate_pair_collapsed",
  "post_judgment_batched",
] as const;
export type Degradation = (typeof DEGRADATIONS)[number];

export interface CaseSpendPlan {
  readonly ceilingUsd: number;
  readonly spend: CaseSpend;
  /** Estimated cost of the hearing still to come, under this plan. */
  readonly projectedUsd: number;
  /** Cuts that are active, in the order they were made. */
  readonly cuts: readonly Degradation[];
  /** A swap failure may buy one re-hearing at effort `max`. */
  readonly rehearingAvailable: boolean;
  /** The advocate pair may run; false collapses it to the single steelman call. */
  readonly advocatePairAvailable: boolean;
  /** The post-judgment documents run inline; false defers them to Batches. */
  readonly postJudgmentInline: boolean;
  /**
   * True when the case is over the ceiling even with every cut applied. Nothing
   * further is cut — the remaining calls are the ones that are never cut — and
   * the overrun is disclosed instead of being silently absorbed.
   */
  readonly overCeiling: boolean;
  /** One sentence per active cut, for the document's limits section. */
  readonly disclosures: readonly string[];
}

export interface PlanCaseSpendOptions {
  /** The locked level. Below L1 there is no advocate pair to cut. */
  readonly level: OutputLevel;
  /** Override the ceiling. Tests only; the product has one ceiling. */
  readonly ceilingUsd?: number;
  /** Override the spend reader's answer. Tests, and callers that already read it. */
  readonly spend?: CaseSpend;
}

const CUT_DISCLOSURES: Readonly<Record<Degradation, string>> = {
  rehearing_cut:
    "This case reached its spending ceiling, so the re-hearing that a failed " +
    "swap test would normally buy was not run. Where the swap test found the " +
    "allocation moving with the parties' names, the allocation is withheld " +
    "directly rather than re-heard: withholding a finding that has already " +
    "failed the test once is cheaper than paying to retry it, and more honest " +
    "than presenting the retry's answer as if the first one had not happened.",
  advocate_pair_collapsed:
    "This case reached its spending ceiling, so the pair of independent " +
    "advocates — one brief per party, written without sight of each other — " +
    "was not run. The single combined account of the other party's case was " +
    "written instead, which is the shape every hearing below this level uses. " +
    "One writer producing both sides is one reading of the record rather than " +
    "two independent ones, and the disagreement between two seats that this " +
    "document would otherwise be able to show is therefore not available here.",
  post_judgment_batched:
    "This case reached its spending ceiling, so the documents derived from " +
    "this judgment — the commitments and the repair script — are produced in a " +
    "deferred batch rather than immediately. They are the same documents, " +
    "checked the same way; what changed is that they arrive later.",
};

/**
 * Decide what this case can still afford.
 *
 * The cuts are applied in the fixed order until the projection fits, and the
 * projection always contains the things that are never cut — the swap pass most
 * of all, which is why it appears in every branch below rather than in an
 * optional block.
 */
export function planCaseSpend(
  db: Db,
  caseId: string,
  options: PlanCaseSpendOptions,
): CaseSpendPlan {
  const ceilingUsd = options.ceilingUsd ?? CASE_COST_CEILING_USD;
  const spend = options.spend ?? readCaseSpend(db, caseId);
  const pairApplies = options.level === "L1";

  const cost = ESTIMATED_STEP_COST_USD;
  // Never cut, at any spend. The swap pass is in here, not in an option.
  const core = cost.skeleton + cost.swapPass + cost.narrative;
  const pairCost = pairApplies ? cost.advocateBrief * 2 : 0;
  const collapsedCost = pairApplies ? cost.steelman : 0;

  const candidates: readonly {
    readonly cuts: readonly Degradation[];
    readonly projected: number;
  }[] = [
    {
      cuts: [],
      projected:
        core + pairCost + cost.rehearing + cost.postJudgmentDocuments,
    },
    {
      cuts: ["rehearing_cut"],
      projected: core + pairCost + cost.postJudgmentDocuments,
    },
    {
      cuts: ["rehearing_cut", "advocate_pair_collapsed"],
      projected: core + collapsedCost + cost.postJudgmentDocuments,
    },
    {
      cuts: ["rehearing_cut", "advocate_pair_collapsed", "post_judgment_batched"],
      projected:
        core + collapsedCost + cost.postJudgmentDocuments * BATCH_DISCOUNT,
    },
  ];

  const chosen =
    candidates.find(
      (candidate) => spend.spentUsd + candidate.projected <= ceilingUsd,
    ) ?? candidates[candidates.length - 1];

  const overCeiling = spend.spentUsd + chosen.projected > ceilingUsd;
  const cuts = chosen.cuts.filter(
    // A level with no advocate pair has no pair to collapse, and saying it did
    // would put a cut in the document that never happened.
    (cut) => cut !== "advocate_pair_collapsed" || pairApplies,
  );

  return {
    ceilingUsd,
    spend,
    projectedUsd: round2(chosen.projected),
    cuts,
    rehearingAvailable: !cuts.includes("rehearing_cut"),
    advocatePairAvailable: pairApplies && !cuts.includes("advocate_pair_collapsed"),
    postJudgmentInline: !cuts.includes("post_judgment_batched"),
    overCeiling,
    disclosures: [
      ...cuts.map((cut) => CUT_DISCLOSURES[cut]),
      ...(overCeiling
        ? [
            `This case has spent more than its ceiling of ` +
              `$${ceilingUsd.toFixed(2)} allows. Everything that could be cut ` +
              `has been; what remains — the swap test, the server-side ` +
              `validators, the pseudonymization gateway and the crisis path — ` +
              `is not cut at any price, because a hearing without them is not ` +
              `a cheaper hearing but a different one.`,
          ]
        : []),
    ],
  };
}

/**
 * Whether the post-judgment documents should be deferred to a batch.
 *
 * Exported separately because the post-judgment path (M4 ②/③) runs long after
 * the hearing and holds none of the hearing's state: it asks this question on
 * its own, with the same reader and the same ceiling.
 */
export function shouldBatchPostJudgment(
  db: Db,
  caseId: string,
  level: OutputLevel,
): boolean {
  return !planCaseSpend(db, caseId, { level }).postJudgmentInline;
}
