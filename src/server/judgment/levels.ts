/**
 * What each output level licenses a judgment to do — HARD RULE #2, on the
 * generation side.
 *
 * `domain/output-level.ts` decides WHICH level a case gets. This decides what
 * that level MEANS for the judgment written under it, and it does so in two
 * places that must not be able to disagree:
 *
 *   1. `levelConstraints` produces the constraint block the prompt carries, so
 *      the model is told the rules before it writes;
 *   2. `checkLevelConstraints` re-checks the returned fact layer against the
 *      same table, so a generation that broke them is rejected server-side.
 *
 * The second is the one that matters. A constraint that exists only in prompt
 * text is a request, and CLAUDE.md is explicit that a hard rule appearing in a
 * prompt and nowhere else is a bug. The prompt block and the validator are
 * generated from one `LEVEL_RULES` table precisely so that changing what L2
 * forbids changes both halves at once.
 *
 * ## Why L2 may not allocate responsibility at all
 *
 * L2 is "one side was heard". Allocating responsibility is a statement about
 * two parties, and one of them has not spoken — on the seeded real case, in the
 * strongest possible sense: none of the client's own utterances are confirmed,
 * so under HARD RULE #1 the client has never spoken inside the record either
 * (SPEC M3 decision record, 2026-08-09).
 *
 * The tempting middle ground is to let L2 emit `not_established`, on the theory
 * that saying "responsibility could not be allocated" is not an allocation. It
 * is. It is a finding in the responsibility table, rendered under the
 * responsibility heading, addressed to a named party — and a reader who skims
 * takes "not established" as a verdict on that party rather than as a statement
 * about the record. The honest encoding of "this hearing did not allocate
 * responsibility" is an empty allocation list plus a `limits` section saying so
 * in prose, which is exactly what the contract's section kinds exist for. So
 * `findings.responsibility` must be empty at L2, and a non-empty one rejects
 * the generation whatever it contains.
 *
 * ## What L1 changes, and what it does not (SPEC M5 ⑥)
 *
 * L1 is the level where a two-way responsibility finding becomes available,
 * because both parties have put material of their own into the record and the
 * hearing can therefore read both of them. That is one permission, granted by
 * one field (`allowsResponsibilitySplit`), and the check below reads that field
 * rather than the level's name — which is what makes "L1 may, L2 may not" a
 * table entry instead of a branch somebody has to remember to update.
 *
 * Everything else holds unchanged at L1, and two of the standing bans are worth
 * naming because a full judgment is exactly where they get tested:
 *
 *   - **No numeric split.** Allocation is qualitative (`primary` / `shared` /
 *     `contributing` / `not_established`) and there is no percentage field. The
 *     ban used to live only in the prompt's `forbids` list, which made it a
 *     request; `checkLevelConstraints` now scans the fact layer's own prose for
 *     one, at every level, with verbatim quotes stripped first. What a party
 *     SAID about percentages is evidence and is left alone (CLAUDE.md); what the
 *     judgment says in its own voice is not.
 *   - **No characterization of anybody.** L2 forbids it of the absent party; L1
 *     forbids it of both. Being able to read two people is not a licence to say
 *     what either of them IS. That one stays a prompt constraint plus the golden
 *     harness's epithet scan, because the distinction it chases is not lexical —
 *     see `eval/golden.ts` on why a pattern list that fails a build on "wanted to
 *     corner him" will eventually fail it on "asked for an answer that day".
 */

import type { OutputLevel } from "../db/schema";
import type { FactLayer } from "./contract";
import { PERCENTAGE_PATTERNS, stripVerbatimQuotes } from "./rendition";

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

export interface LevelConstraints {
  readonly level: OutputLevel;
  /** How the level is named to a reader, not the bare code. */
  readonly label: string;
  /** What a judgment at this level must do. Serialized into the prompt. */
  readonly requires: readonly string[];
  /** What it may not do. Serialized into the prompt. */
  readonly forbids: readonly string[];
  /** Whether `findings.responsibility` may be non-empty. Checked in code. */
  readonly allowsResponsibilitySplit: boolean;
}

/**
 * One entry per level, including `refused` — which never reaches generation
 * (HARD RULE #9 routes it to the deterministic crisis path, and
 * `lockedLevelFor` in the contract refuses to open a judgment for it), but is
 * present so this table is total over the enum and cannot be indexed into a
 * hole.
 */
const LEVEL_RULES: Readonly<Record<OutputLevel, LevelConstraints>> = {
  L1: {
    level: "L1",
    label:
      "Full judgment — both parties have put material of their own into the " +
      "record",
    requires: [
      "State what each party did, grounded in confirmed lines they spoke.",
      "Allocate responsibility qualitatively between the parties, using only " +
        "the allocations the contract defines (primary / shared / " +
        "contributing / not_established), and name for each one the claim_ids " +
        "it rests on. A two-way finding is what this level is for: say what " +
        "each of them carries, not only what one of them did.",
      "Disclose what the record still cannot settle, including anything only " +
        "one of the two sides put material about.",
    ],
    forbids: [
      "Any numeric split of responsibility — percentages, ratios, scores. " +
        "There is no field for one and none may appear in prose. The server " +
        "scans this fact layer for one and rejects the whole generation.",
      "Any statement about either party's character, motives, intentions or " +
        "inner life. Hearing both sides tells you what they each said and " +
        "did; it does not tell you who they are, and a full judgment is not a " +
        "licence to say.",
      "Any claim that is not grounded in a confirmed line you were given. " +
        'Being able to allocate responsibility raises the cost of a "probably" ' +
        'sold as a finding: use tier "inferred" for a reading and tier ' +
        '"unknown", citing nothing, for what the record cannot settle.',
    ],
    allowsResponsibilitySplit: true,
  },
  L2: {
    level: "L2",
    label: "One-sided analysis — only one party's material is in the record",
    requires: [
      "Say plainly, in the judgment's own words and using the counted numbers " +
        "you were given, whose words this analysis could read and whose it " +
        "could not.",
      "Confine every finding to what the confirmed lines support, and mark as " +
        'tier "unknown" — citing nothing — anything the record cannot settle.',
      "Say what a reader should NOT take from this analysis, given that it " +
        "heard one side.",
    ],
    forbids: [
      "Allocating responsibility, in any form. findings.responsibility must " +
        "be an empty list. That includes an allocation of " +
        '"not_established": a hearing that did not allocate responsibility ' +
        "says so in a limits section, not as a row addressed to a party.",
      "Any statement about the absent party's motives, character, intentions " +
        "or inner life. What they said and did is available to you; who they " +
        "are is not.",
      "Any numeric split of responsibility — percentages, ratios, scores.",
    ],
    allowsResponsibilitySplit: false,
  },
  L3: {
    level: "L3",
    label:
      "Narrative analysis — nothing in the record can ground a factual claim",
    requires: [
      "Analyse only how the situation is being narrated: what the account " +
        "asserts, what it assumes, where it is thin.",
      "State that no finding of fact was available and why.",
    ],
    forbids: [
      "Any finding about what actually happened between the parties.",
      "Allocating responsibility, in any form. findings.responsibility must " +
        "be an empty list.",
      "Any numeric split of responsibility — percentages, ratios, scores.",
    ],
    allowsResponsibilitySplit: false,
  },
  refused: {
    level: "refused",
    label: "Refused — a safety screen stopped this case",
    requires: [],
    forbids: [
      "Everything. A refused case produces crisis resources deterministically " +
        "and no model is asked anything about it (HARD RULE #9).",
    ],
    allowsResponsibilitySplit: false,
  },
};

/** The constraints for one level. Total over the enum. */
export function levelConstraints(level: OutputLevel): LevelConstraints {
  return LEVEL_RULES[level];
}

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

export type LevelViolationCode =
  /** The level allocates no responsibility at all, and this one did. */
  | "responsibility_not_permitted"
  /** A share of responsibility written as a number. Banned at every level. */
  | "numeric_responsibility_split"
  /**
   * The swap gate withheld this generation's allocation and the artifact still
   * carries one (doc 05 §B.2 step 4). Not a statement about the level — see
   * `AllocationWithholding`.
   */
  | "allocation_withheld_by_swap_gate";

export interface LevelViolation {
  readonly code: LevelViolationCode;
  /** Where it sits, e.g. `fact_layer.findings.responsibility`. */
  readonly path: string;
  /** One sentence, readable by a user and by the model on the retry. */
  readonly detail: string;
}

/**
 * Every prose field of a fact layer, with the path it sits at.
 *
 * The fact layer's own voice, and nothing else: `evidence_refs` are ids, tiers
 * and allocations are enums, and the quoted evidence inside a statement is
 * stripped before anything scans it.
 */
function prosePieces(
  factLayer: FactLayer,
): readonly { readonly path: string; readonly text: string }[] {
  return [
    ...factLayer.claims.map((claim, at) => ({
      path: `fact_layer.claims[${at}] (${claim.claim_id}).statement`,
      text: claim.statement,
    })),
    {
      path: "fact_layer.findings.record_basis.statement",
      text: factLayer.findings.record_basis.statement,
    },
    ...factLayer.findings.unresolved.map((item, at) => ({
      path: `fact_layer.findings.unresolved[${at}].question`,
      text: item.question,
    })),
  ];
}

/**
 * `70/30` and `23:30` are the same shape and not the same sentence.
 *
 * The ratio pattern is the one member of the imported list that matches
 * something a judgment writes innocently — a clock time, a date, a message
 * count — so a bare match is not enough to reject a whole hearing over. Tested
 * on the matched text rather than on the pattern's label, so renaming a label
 * upstream cannot quietly turn the guard off.
 */
const RATIO_SHAPE = /^\d{1,3}\s*[:/]\s*\d{1,3}$/;

/** Words that make a number next to them a number about responsibility. */
const ALLOCATION_CONTEXT =
  /\b(responsib|blame|fault|at fault|share|shares|split|allocat|accountab)/i;

/**
 * A share of responsibility written as a number, anywhere in the fact layer's
 * own prose.
 *
 * The patterns are `rendition.ts`'s, imported rather than restated: the rule
 * that decides whether a finished document may be shared and the rule that
 * decides whether a skeleton may be written have to be the same rule, or a
 * generation passes here and the document it produces is unshareable. Verbatim
 * quotes are stripped first — a party who wrote "这事你占七成责任" said it, and
 * suppressing evidence to pass our own check would be rewriting evidence.
 *
 * One local narrowing, and it is a narrowing on purpose: a ratio-shaped match
 * only counts inside a sentence that is talking about responsibility. The cost
 * of a false positive differs between the two callers — there it blocks a share
 * and someone reads why; here it kills a hearing twice and hands the user an
 * error — and "甲 replied at 23:30" is a sentence a fact layer writes.
 */
export function findNumericResponsibilitySplits(
  factLayer: FactLayer,
): readonly LevelViolation[] {
  const violations: LevelViolation[] = [];

  for (const piece of prosePieces(factLayer)) {
    const prose = stripVerbatimQuotes(piece.text);
    for (const { label, pattern } of PERCENTAGE_PATTERNS) {
      const match = pattern.exec(prose);
      if (match === null) continue;
      if (RATIO_SHAPE.test(match[0]) && !ALLOCATION_CONTEXT.test(prose)) continue;
      violations.push({
        code: "numeric_responsibility_split",
        path: piece.path,
        detail:
          `This puts a number on responsibility (${label}: "${match[0]}"). ` +
          `Responsibility is allocated qualitatively here and there is no ` +
          `numeric field to hold one — a percentage is a precision no record ` +
          `of a relationship supports, and it is banned at every level, this ` +
          `one included. Say what each party carries in words, or say that the ` +
          `record cannot settle it.`,
      });
      break;
    }
  }

  return violations;
}

/**
 * One generation's swap-gate verdict, as this validator needs to read it.
 *
 * Structural on purpose: `swap-gate.ts` produces a `SwapGateOutcome` that
 * satisfies this shape, and this module imports nothing from it. The dependency
 * would otherwise close a ring (levels → swap-gate → swap-test → dossier →
 * levels), and the validator is the layer that must not acquire dependencies —
 * everything that decides whether an artifact is valid should be reachable
 * without loading anything that decides how one is produced.
 */
export interface AllocationWithholding {
  /** True when this generation's allocation must not ship. */
  readonly allocationWithheld: boolean;
  /** Why, in one sentence, for the fault report. */
  readonly reason: string;
}

/**
 * Check a returned fact layer against the level it was generated under, and
 * against what this generation earned.
 *
 * Pure, synchronous, no database — the level is passed in because it was read
 * off the case (`cases.output_level`) by the caller, never chosen here and
 * never inferred from the content.
 *
 * Three families: what this level licenses (keyed on the table, so L1
 * permitting an allocation and L2 refusing one is one field rather than two
 * branches), the standing bans that hold at every level, and — since doc 05
 * §B.2 — the swap gate.
 *
 * ## Why the swap gate is here and not somewhere gentler
 *
 * The gate withholds an allocation that did not survive exchanging the parties'
 * positions. That withholding is applied deterministically before the narrative
 * is written (`withholdAllocation`), so under normal operation this check never
 * fires: it exists so that an artifact which somehow carries an allocation the
 * gate withheld is *invalid*, in the same place and by the same mechanism as one
 * that puts a percentage on responsibility. A gate whose only enforcement is the
 * code path that is supposed to call it is not a gate.
 *
 * **This says nothing about the level** (HARD RULE #2). `swap` is a property of
 * one generation, not of the case: L1 still licenses an allocation, the case is
 * still locked at L1, and a regeneration is heard at L1 with the whole licence
 * intact. What failed is this attempt.
 */
export function checkLevelConstraints(
  level: OutputLevel,
  factLayer: FactLayer,
  swap?: AllocationWithholding,
): readonly LevelViolation[] {
  const rules = levelConstraints(level);
  const violations: LevelViolation[] = [...findNumericResponsibilitySplits(factLayer)];

  const allocations = factLayer.findings.responsibility;

  if (swap?.allocationWithheld === true && allocations.length > 0) {
    violations.push({
      code: "allocation_withheld_by_swap_gate",
      path: "fact_layer.findings.responsibility",
      detail:
        `The swap gate withheld this generation's allocation and the fact ` +
        `layer still carries ${allocations.length} of them ` +
        `(${allocations.map((a) => `${a.party}: ${a.allocation}`).join("; ")}). ` +
        `${swap.reason} The document ships at its level with the allocation ` +
        `withheld and the two readings shown instead; the level itself is ` +
        `untouched, and a later generation may still earn an allocation.`,
    });
  }

  if (!rules.allowsResponsibilitySplit && allocations.length > 0) {
    violations.push({
      code: "responsibility_not_permitted",
      path: "fact_layer.findings.responsibility",
      detail:
        `This case is locked at ${level} (${rules.label}), and a judgment at ` +
        `that level allocates no responsibility at all. The generation ` +
        `returned ${allocations.length} allocation(s) ` +
        `(${allocations.map((a) => `${a.party}: ${a.allocation}`).join("; ")}). ` +
        `An allocation of "not_established" counts: a hearing that did not ` +
        `allocate responsibility says so in a limits section, not as a row ` +
        `addressed to a party.`,
    });
  }

  return violations;
}

/** The fault report, in one string. */
export function describeLevelViolations(
  violations: readonly LevelViolation[],
): string {
  if (violations.length === 0) return "";
  return (
    `The generation broke the constraints of its own output level:\n` +
    violations.map((v) => `  - [${v.code}] ${v.path}: ${v.detail}`).join("\n")
  );
}
