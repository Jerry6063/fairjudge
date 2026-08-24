/**
 * The swap test as a publication gate (doc 05 §B.2; doc 02 §1.2 amendment,
 * 2026-08-17).
 *
 * `swap-test.ts` measures what moved between two hearings of the same record and
 * refuses, on principle, to turn that into a score. This module is the one thing
 * built on top of it that has to make a decision, and it makes exactly one:
 *
 *   1. The skeleton is generated (A-first seating).
 *   2. The swap pass regenerates the allocation from the same inputs with the
 *      identities and the address-term dictionary exchanged, **without seeing
 *      pass one's output**. Independence is the measurement's precondition; a
 *      pass two that is handed pass one's skeleton is measuring agreement with a
 *      document rather than agreement about a record.
 *   3. Delta ≤ threshold → publish, with the swap result disclosed in limits.
 *   4. Delta > threshold → one re-hearing at effort `max`, swap-tested again.
 *   5. Still > threshold → publish with the allocation **withheld**: the
 *      document ships at its level, states that the allocation was withheld
 *      because the finding did not survive exchanging the parties' positions,
 *      and shows the two readings as the disagreement display.
 *
 * **The level is never touched.** L1 still licenses an allocation; this
 * generation failed to earn one. Nothing in this module reads or writes
 * `cases.output_level`, and the withheld state is a property of one version of
 * one document — a regeneration starts from the same licensed level.
 *
 * ## What "delta" is, given that this product refuses to invent a score
 *
 * The delta is a **count**: how many parties' responsibility allocations came
 * back different when the register was exchanged. It is not a calibrated
 * quantity and there is nothing to calibrate — `RESPONSIBILITY_ALLOCATIONS` is
 * four words, not a scale, so "how far apart" two allocations are is not a
 * question with an answer. The threshold is therefore 0: an allocation that
 * moved when the names moved did not survive the exchange. That is a discrete
 * fact about two hearings of one record, which is the only kind of fact this
 * comparison can produce, and it is the reason the gate can exist without the
 * calibration data the swap-test module correctly says it does not have.
 *
 * Everything else the swap test measures — claims present in one arm only,
 * characterizations that moved, tiers that shifted — stays reported and
 * ungated. Those are real signals and none of them is a reason to withhold an
 * allocation that itself held steady.
 */

import type { FactLayer, ResponsibilityAllocation } from "./contract";
import { renderDisagreement, type Disagreement } from "./rendition";
import type { AllocationComparison, SwapDifferences } from "./swap-test";

/* -------------------------------------------------------------------------- */
/* The measurement                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How many allocations may move under the exchange and still publish.
 *
 * Zero, and see the header for why that is a threshold rather than a refusal to
 * pick one: the allocation vocabulary is an enum of four words, so an allocation
 * either survived exchanging the parties' positions or it did not.
 */
export const SWAP_ALLOCATION_DELTA_THRESHOLD = 0;

export interface SwapDelta {
  /** Parties whose allocation differs between the arms. */
  readonly moved: readonly AllocationComparison[];
  /** `moved.length`. The measured quantity, such as it is. */
  readonly delta: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

/** Measure the allocation delta between two arms of one swap test. */
export function measureSwapDelta(differences: SwapDifferences): SwapDelta {
  const moved = differences.allocations.filter((item) => item.changed);
  return {
    moved,
    delta: moved.length,
    threshold: SWAP_ALLOCATION_DELTA_THRESHOLD,
    exceeded: moved.length > SWAP_ALLOCATION_DELTA_THRESHOLD,
  };
}

/** Does this delta buy the case a re-hearing at effort `max`? */
export function needsRehearing(delta: SwapDelta): boolean {
  return delta.exceeded;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/** One hearing and its swap arm, measured. */
export interface SwapPass {
  /** 1 = the first hearing, 2 = the re-hearing at effort `max`. */
  readonly pass: 1 | 2;
  readonly delta: SwapDelta;
  /** The allocation each arm produced, for the disagreement display. */
  readonly filedAllocations: readonly AllocationRow[];
  readonly swappedAllocations: readonly AllocationRow[];
  /** Pseudonym each arm's own register marked as the party who brought the case. */
  readonly filedClient: string;
  readonly swappedClient: string;
}

export interface AllocationRow {
  readonly party: string;
  readonly allocation: ResponsibilityAllocation;
}

export type SwapGateDisposition =
  /** No allocation was at stake, so there was nothing for the gate to decide. */
  | "not_applicable"
  /** The allocation survived the exchange and ships as written. */
  | "published_intact"
  /** It did not, twice (or once with the re-hearing cut). Withheld. */
  | "allocation_withheld";

export interface SwapGateOutcome {
  readonly disposition: SwapGateDisposition;
  /**
   * The one field publication and `checkLevelConstraints` act on. True means
   * `findings.responsibility` must be empty in what ships — not because the
   * level forbids an allocation, but because this generation did not earn one.
   */
  readonly allocationWithheld: boolean;
  /** One sentence, for the validator's fault report and the audit view. */
  readonly reason: string;
  readonly passes: readonly SwapPass[];
  /** True when a re-hearing at effort `max` was actually run. */
  readonly rehearingRun: boolean;
  /** True when the re-hearing was skipped to stay under the cost ceiling. */
  readonly rehearingCut: boolean;
  /** What the document says about the swap, in its limits section. */
  readonly disclosure: string;
  /** The spread, for the render layer. Empty when nothing diverged. */
  readonly disagreements: readonly Disagreement[];
}

/** Allocations as one readable line, so two arms can be set side by side. */
function describeAllocations(rows: readonly AllocationRow[]): string {
  if (rows.length === 0) return "no allocation";
  return rows
    .slice()
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0))
    .map((row) => `${row.party}: ${row.allocation}`)
    .join("; ");
}

/** Read the allocation rows off a fact layer, for a `SwapPass`. */
export function allocationRows(factLayer: FactLayer): readonly AllocationRow[] {
  return factLayer.findings.responsibility.map((item) => ({
    party: item.party,
    allocation: item.allocation,
  }));
}

/**
 * How one seating is named in the display.
 *
 * By what the register said, not by "arm 1" and "arm 2": a reader looking at two
 * different answers needs to know what differed between the two questions, and
 * what differed is which party the file called the one who brought the case.
 */
function seatName(client: string): string {
  return `Heard with ${client} seated as the party who brought the case`;
}

/** The disagreement display for a swap pass whose allocation did not hold. */
export function swapDisagreements(pass: SwapPass): readonly Disagreement[] {
  return [
    {
      subject: "How responsibility was allocated",
      readings: [
        {
          seat: seatName(pass.filedClient),
          reading: describeAllocations(pass.filedAllocations),
        },
        {
          seat: seatName(pass.swappedClient),
          reading: describeAllocations(pass.swappedAllocations),
        },
      ],
      note:
        `The confirmed lines behind these readings are identical — the record ` +
        `did not change between the two hearings, only which party the file ` +
        `named as the one who brought the case. An allocation that moves with ` +
        `that is an allocation this document cannot stand behind, so none is ` +
        `stated.`,
    },
  ];
}

/**
 * Resolve the gate from the passes that were run.
 *
 * Pure. The callers do the running; this decides what the run means, so the
 * decision is testable without a model and cannot differ between the path that
 * generates a judgment and the path that validates one.
 */
export function resolveSwapGate(input: {
  readonly passes: readonly SwapPass[];
  /** True when the re-hearing was skipped for the cost ceiling (doc 05 §B.5). */
  readonly rehearingCut?: boolean;
}): SwapGateOutcome {
  const passes = input.passes;
  const rehearingCut = input.rehearingCut === true;
  const rehearingRun = passes.some((pass) => pass.pass === 2);
  const last = passes.length === 0 ? null : passes[passes.length - 1];

  if (last === null) {
    return {
      disposition: "not_applicable",
      allocationWithheld: false,
      reason:
        "No swap pass was recorded for this generation, so the gate decided " +
        "nothing.",
      passes,
      rehearingRun,
      rehearingCut,
      disclosure: "",
      disagreements: [],
    };
  }

  const noAllocationAtStake =
    last.filedAllocations.length === 0 && last.swappedAllocations.length === 0;

  if (noAllocationAtStake) {
    return {
      disposition: "not_applicable",
      allocationWithheld: false,
      reason:
        "Neither hearing allocated responsibility, so there was no allocation " +
        "for the exchange to move.",
      passes,
      rehearingRun,
      rehearingCut,
      disclosure: NO_ALLOCATION_DISCLOSURE,
      disagreements: [],
    };
  }

  if (!last.delta.exceeded) {
    return {
      disposition: "published_intact",
      allocationWithheld: false,
      reason:
        `The allocation survived exchanging the parties' positions ` +
        `(${last.delta.delta} of the allocations moved; the gate allows ` +
        `${last.delta.threshold}).`,
      passes,
      rehearingRun,
      rehearingCut,
      disclosure: intactDisclosure(rehearingRun),
      disagreements: [],
    };
  }

  return {
    disposition: "allocation_withheld",
    allocationWithheld: true,
    reason:
      `The allocation did not survive exchanging the parties' positions: ` +
      `${last.delta.moved
        .map((item) => `${item.party} ${item.filed ?? "none"} → ${item.swapped ?? "none"}`)
        .join("; ")}. ` +
      (rehearingCut
        ? `The re-hearing that would normally follow was not run — see the ` +
          `cost disclosure — so the document ships with the allocation withheld.`
        : rehearingRun
          ? `The case was re-heard at the highest effort available and the ` +
            `second hearing did not survive it either.`
          : `No re-hearing was available for this generation.`),
    passes,
    rehearingRun,
    rehearingCut,
    disclosure: withheldDisclosure(rehearingRun, rehearingCut),
    disagreements: swapDisagreements(last),
  };
}

/* -------------------------------------------------------------------------- */
/* What the document says                                                     */
/* -------------------------------------------------------------------------- */

/** Heading of the section publication writes from this outcome. */
export const SWAP_LIMITS_HEADING = "How this document was tested, and what it withholds";

const NO_ALLOCATION_DISCLOSURE =
  "This document was heard twice: once as filed, and once with the parties' " +
  "positions in the register exchanged, so that a conclusion attached to a " +
  "name rather than to the record would show up as a difference between the " +
  "two. Neither hearing allocated responsibility, so there was nothing for the " +
  "exchange to move. That is one comparison on one case and is not a " +
  "certificate of even-handedness.";

function intactDisclosure(rehearingRun: boolean): string {
  return (
    `This document was heard twice: once as filed, and once with the parties' ` +
    `positions in the register exchanged and their address terms exchanged ` +
    `with them. The confirmed lines were byte-identical in both hearings, so ` +
    `the only thing that moved was which party the file named as the one who ` +
    `brought the case. The allocation came back the same either way` +
    (rehearingRun
      ? `, after a second hearing at the highest effort available — the first ` +
        `pair disagreed and the re-hearing settled it.`
      : `.`) +
    ` That is one comparison on one case, calibrated against nothing, and it ` +
    `is reported here as what it is rather than as a passing grade.`
  );
}

function withheldDisclosure(rehearingRun: boolean, rehearingCut: boolean): string {
  return (
    `**No allocation of responsibility is stated in this document, and that is ` +
    `a deliberate omission rather than an oversight.** The case was heard ` +
    `twice: once as filed, and once with the parties' positions in the ` +
    `register exchanged and their address terms exchanged with them. The ` +
    `confirmed lines were byte-identical in both hearings. The allocation was ` +
    `not: it changed when the names changed.` +
    (rehearingRun
      ? ` The case was then re-heard at the highest effort available and tested ` +
        `the same way again, and the allocation moved again.`
      : rehearingCut
        ? ` The re-hearing that would normally follow was not run, because this ` +
          `case had reached its spending ceiling; withholding an allocation ` +
          `that has already failed the test once is both cheaper and more ` +
          `honest than paying for a retry of what may be a coin flip.`
        : ``) +
    ` A finding that depends on which party filed is not a finding about what ` +
    `happened, so it is not stated. Everything else in this document — what ` +
    `each party said, what the record could and could not establish — stands ` +
    `as written and was checked the same way it would have been. The two ` +
    `readings are shown below rather than merged.`
  );
}

/**
 * The full limits body publication writes: the disclosure, then the spread.
 *
 * Composed here so the withheld state has one text and cannot drift between the
 * document and the audit view. `renderDisagreement` returns an empty string when
 * nothing diverged, so an intact publication gets the disclosure alone.
 */
export function swapLimitsText(outcome: SwapGateOutcome): string {
  const display = renderDisagreement(outcome.disagreements);
  if (outcome.disclosure === "") return display;
  if (display === "") return outcome.disclosure;
  return `${outcome.disclosure}\n\n${display}`;
}

/* -------------------------------------------------------------------------- */
/* The withholding itself                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Strip the allocation from a fact layer, deterministically.
 *
 * Done in code, before the narrative call, so the narrative is written from a
 * fact layer that has no allocation in it and cannot narrate one. That ordering
 * is the whole difference between withholding an allocation and asking a model
 * not to mention it.
 *
 * `findings.responsibility` is the only field touched. The claims the allocation
 * rested on stay exactly where they are: they were checked against the record
 * and they are still true of it — what failed the test was the allocation drawn
 * from them, and deleting the underlying claims would hide the reasoning as well
 * as the conclusion.
 */
export function withholdAllocation(factLayer: FactLayer): FactLayer {
  if (factLayer.findings.responsibility.length === 0) return factLayer;
  return {
    ...factLayer,
    findings: { ...factLayer.findings, responsibility: [] },
  };
}
