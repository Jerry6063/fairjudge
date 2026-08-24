/**
 * Output-level derivation — HARD RULE #2.
 *
 * The output level (L1 / L2 / L3 / refused) is derived by CODE from
 * participation state + evidence profile + safety red flags, then locked onto
 * the case. The model never chooses its own level; it only works inside the
 * level this function fixes. This is a pure function with unit tests — no I/O,
 * no LLM, no prompt involvement (a level decision that lives in a prompt is a
 * bug).
 *
 * Level definitions (01-pipeline-design.md §"Output grading"):
 *   L1 full judgment       — both sides engaged (or single side + sufficient
 *                            first-hand evidence + steelman passed); bilateral
 *                            responsibility.
 *   L2 one-sided analysis  — single side only but with first-hand evidence;
 *                            prominently labelled "only one side heard"; no
 *                            characterization of the absent party.
 *   L3 narrative analysis  — material dominated by C/D (AI-processed / public
 *                            sentiment); refuses factual characterization,
 *                            analyzes only how the submitter narrates the
 *                            situation.
 *   refused        — hard refusal (not a downgrade): safety red flags such as
 *                    domestic violence / coercive control / stalking / self-harm.
 *
 * ## Why the citable record is an input, and not just the grades
 *
 * The grade on a piece of material describes the ARTIFACT: a screenshot of a
 * ChatGPT session is C whatever is inside it. The unit a claim actually rests on
 * is the confirmed utterance (HARD RULE #1: an `evidence_ref` is an utterance id
 * and nothing else). Those two can disagree, and on the real seeded case they
 * do — every item in the three issue lists cites a verbatim line that a human
 * confirmed, while every artifact those lines were read out of is graded C or D.
 *
 * Deriving the level from grades alone would call that case L3 ("nothing can be
 * grounded, analyze only the narration") while the pipeline behind it had
 * already built its whole issue list out of grounded citations. One of the two
 * would be lying. So grounding is the union: first-hand material, OR a confirmed
 * line attributed to a party. What the grades still do is tell the judgment what
 * kind of record it is standing on, which is why they survive into the findings.
 *
 * ## Why the derivation explains itself
 *
 * `explainOutputLevel` returns the level together with the facts that produced
 * it. That is not decoration for a UI: the L2 label alone says "only one side
 * was heard", which on this case is a euphemism. The real fact is sharper — the
 * client's own five utterances are all unconfirmed, so under HARD RULE #1 the
 * client has never spoken inside the record, and every citable line belongs to
 * the other party. A judgment has to say that in its own words, and it can only
 * do so if the derivation hands it the fact rather than a grade letter.
 *
 * ## The L1 upgrade, and why the participation column alone no longer buys it
 * (SPEC M5 ⑥)
 *
 * L1 licenses the one thing no other level does: a responsibility finding
 * addressed to two people. Until M5 the promotion could be bought with
 * `participation.state`, which is the CLIENT'S REPORT about the other party —
 * "he says she is taking part". M5 gave her a channel of her own (an identity,
 * material she owns, a visibility state she controls), and the whole point of
 * building it is that "he says she participated" and "she put something into
 * this record" are different facts with different standing. So the promotion is
 * now keyed on the second one, from both sides:
 *
 *     L1 requires `hasClientConfirmed && hasCounterpartyConfirmed`.
 *
 * Both flags mean the same thing about different people — that party OWNS at
 * least one piece of confirmed, citable material inside the case record. Note
 * what that is not: it is not "her words appear in the record". On the seeded
 * real case every confirmed line was SPOKEN by the counterparty and submitted,
 * owned and confirmed by the client, out of screenshots he took. Reading that as
 * her participation would promote the most one-sided case in the corpus to a
 * two-way responsibility finding, which is the exact failure the level exists to
 * prevent. Ownership is the fact that cannot be produced by one party alone.
 *
 * A case where the client reports her as `participating` but nothing of hers is
 * in the record is therefore L2 now, under its own reason (`one_sided_material`)
 * rather than under `counterparty_absent` — she may well be taking part; what is
 * missing is anything of hers to judge on.
 */

import type { OutputLevel, ParticipationState } from "../db/schema";

export type { OutputLevel, ParticipationState };

/** Counterparty participation snapshot, plus what wave A learned about it. */
export interface ParticipationInput {
  /** The counterparty (respondent) participation state. */
  readonly state: ParticipationState;
  /**
   * The wave-A downgrade signal (`cases.downgrade_signal`): no steelman of the
   * counterparty could be produced, or the client could not recognize them in
   * any version of it (01-pipeline-design.md ⑤).
   *
   * It lives on the participation input rather than the evidence one because it
   * is a fact about how well the other side is represented, not about what the
   * material shows. Its effect is a ceiling: a case that cannot state the other
   * party's own case at its strongest cannot issue a bilateral judgment, however
   * engaged the participation column claims they are.
   */
  readonly downgradeSignal: boolean;
}

/** Confirmed-evidence profile for the case. */
export interface EvidenceProfileInput {
  /** Count of confirmed evidence items per grade (A/B first-hand, C/D derived). */
  readonly counts: { readonly A: number; readonly B: number; readonly C: number; readonly D: number };
  /**
   * Whether the party who brought the case owns at least one piece of confirmed,
   * citable material inside the case record.
   *
   * The mirror of `hasCounterpartyConfirmed`, and it is a real question rather
   * than a formality: a case can be filed and never have anything confirmed in
   * it, and a record nobody has signed off on grounds nothing whoever brought it.
   */
  readonly hasClientConfirmed: boolean;
  /**
   * Whether the counterparty owns at least one piece of confirmed, citable
   * material inside the case record — material SHE put there, not material about
   * her that somebody else submitted.
   *
   * Together with `hasClientConfirmed` this is what opens L1 (see the header).
   * Ownership, not authorship: a line she spoke, screenshotted and confirmed by
   * the client, is his material about her and leaves this false.
   */
  readonly hasCounterpartyConfirmed: boolean;
  /**
   * The citable record: confirmed utterances (`confirm_status` in
   * confirmed/edited), split by who spoke them.
   *
   * `total` can exceed `byClient + byCounterparty` — a confirmed line nobody has
   * attributed, or a clock reading, is citable but grounds nothing about either
   * party, which is exactly why the split is stored rather than the total alone.
   */
  readonly citableUtterances: {
    readonly total: number;
    /** Confirmed lines spoken by the party who brought the case. */
    readonly byClient: number;
    /** Confirmed lines spoken by the other party. */
    readonly byCounterparty: number;
  };
}

/**
 * Safety red flags that force a hard refusal. These are NOT downgrades: a hit
 * routes the user to the deterministic (non-LLM) crisis-referral path.
 */
export interface SafetyFlags {
  /** Domestic violence / coercive control / stalking red flag. */
  domesticViolence?: boolean;
  /** Self-harm or harm-to-others risk. */
  selfHarmRisk?: boolean;
  /** Any other explicit must-refuse category already determined upstream. */
  mustRefuse?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The explained decision                                                     */
/* -------------------------------------------------------------------------- */

/** Which rule bound. Stable ids — the UI and the tests key off these. */
export type OutputLevelReason =
  /** Safety outranks everything. Not a downgrade. */
  | "safety_refusal"
  /** Nothing can be grounded: no first-hand material and no citable speech. */
  | "no_citable_record"
  /** The other side's case could not be stated at its strongest. */
  | "steelman_unavailable"
  /** Only one voice is in the record. */
  | "counterparty_absent"
  /**
   * The other side is here, but only one party has put material of their own
   * into the record — so there is still only one party's material to judge on
   * (SPEC M5 ⑥).
   */
  | "one_sided_material"
  /** Both sides are represented and something first-hand backs it. */
  | "bilateral";

/**
 * One fact about the record that the level rests on.
 *
 * These exist to be repeated. The judgment's fact layer carries them into its
 * case-level findings, and the disclosure block says them in prose — because
 * "L2" is a label, and a label is exactly the thing a reader skips.
 */
export interface OutputLevelFinding {
  /** Stable id for tests and for keying the list. */
  readonly code: string;
  /** The fact in one or two sentences, in English, ready to be shown. */
  readonly statement: string;
}

export interface OutputLevelDecision {
  readonly level: OutputLevel;
  readonly reason: OutputLevelReason;
  /** Why this level and not the neighbouring one, in the code's own words. */
  readonly rationale: string;
  /** What the record actually looks like. Never empty. */
  readonly findings: readonly OutputLevelFinding[];
  /** The inputs, echoed back, so a locked level can be audited later. */
  readonly inputs: {
    readonly participation: ParticipationInput;
    readonly evidence: EvidenceProfileInput;
    readonly safety: SafetyFlags;
  };
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** Any hard-refusal flag set. */
function mustRefuse(safety: SafetyFlags): boolean {
  return (
    safety.domesticViolence === true ||
    safety.selfHarmRisk === true ||
    safety.mustRefuse === true
  );
}

/**
 * Is there anything a factual claim can stand on?
 *
 * First-hand material, or a confirmed line attributed to one of the parties. An
 * unattributed confirmed line does not count: it is citable, but a claim about
 * what someone said cannot rest on a line with no speaker.
 */
function hasGrounding(evidence: EvidenceProfileInput): boolean {
  const { A, B } = evidence.counts;
  const { byClient, byCounterparty } = evidence.citableUtterances;
  return A > 0 || B > 0 || byClient + byCounterparty > 0;
}

/** Is the other side actually present in the record? */
function counterpartyEngaged(
  participation: ParticipationInput,
  evidence: EvidenceProfileInput,
): boolean {
  return (
    participation.state === "participating" ||
    participation.state === "written_response" ||
    evidence.hasCounterpartyConfirmed
  );
}

/**
 * Has each party put something of their own into the confirmed record?
 *
 * The condition L1 rests on (SPEC M5 ⑥). Deliberately symmetric and deliberately
 * about ownership rather than about who spoke: see the module header for why the
 * seeded real case satisfies the client half and not the counterparty half,
 * despite every citable line in it being hers.
 */
function bothSidesHaveMaterial(evidence: EvidenceProfileInput): boolean {
  return evidence.hasClientConfirmed && evidence.hasCounterpartyConfirmed;
}

/**
 * Derive the case output level.
 *
 * Precedence (most binding first):
 *  1. Safety red flags         → `refused` (overrides everything).
 *  2. Nothing citable/first-hand → `L3` (narrative-only; nothing grounds a fact).
 *  3. No steelman of the other side → `L2` (cannot issue a bilateral judgment).
 *  4. Counterparty not engaged → `L2` (single-side cap, but has grounding).
 *  5. Only one party's own material → `L2` (SPEC M5 ⑥; she is here, but there
 *     is nothing of hers to judge on — or nothing of his).
 *  6. Otherwise                → `L1` (bilateral, grounded, both sides' own
 *     material in the record).
 *
 * Note the cap semantics: "counterparty absent → at most L2" is a ceiling, so a
 * case with nothing citable still resolves to L3 (lower binds), which is why the
 * grounding check runs before the participation check.
 *
 * @param participation Counterparty participation snapshot + downgrade signal.
 * @param evidence Confirmed-evidence profile: grades, counterparty confirmation,
 *   and the citable record split by speaker.
 * @param safety Optional safety red flags; a hit forces `refused`.
 * @returns The derived output level to lock onto the case.
 */
export function deriveOutputLevel(
  participation: ParticipationInput,
  evidence: EvidenceProfileInput,
  safety: SafetyFlags = {},
): OutputLevel {
  // 1. Hard refusal — never a downgrade, always wins.
  if (mustRefuse(safety)) return "refused";

  // 2. Nothing to stand on → narrative-only.
  if (!hasGrounding(evidence)) return "L3";

  // 3. The other side's case could not be put at its strongest.
  if (participation.downgradeSignal) return "L2";

  // 4. Single-voice material → capped at L2 (grounded, but one voice).
  if (!counterpartyEngaged(participation, evidence)) return "L2";

  // 5. Only one party has material of their own in the record → still L2.
  if (!bothSidesHaveMaterial(evidence)) return "L2";

  // 6. Bilateral engagement + grounded material from both → full judgment.
  return "L1";
}

/**
 * The same derivation, with the reasoning it used.
 *
 * `deriveOutputLevel` is the answer; this is the answer plus its working. They
 * cannot disagree, because the level here comes from that function rather than
 * from a second copy of the rules.
 */
export function explainOutputLevel(
  participation: ParticipationInput,
  evidence: EvidenceProfileInput,
  safety: SafetyFlags = {},
): OutputLevelDecision {
  const level = deriveOutputLevel(participation, evidence, safety);
  const reason = reasonFor(participation, evidence, safety);
  const inputs = { participation, evidence, safety };

  return {
    level,
    reason,
    rationale: RATIONALE[reason],
    findings: findingsFor(participation, evidence, safety),
    inputs,
  };
}

/** Which rule bound — the same ladder `deriveOutputLevel` walks. */
function reasonFor(
  participation: ParticipationInput,
  evidence: EvidenceProfileInput,
  safety: SafetyFlags,
): OutputLevelReason {
  if (mustRefuse(safety)) return "safety_refusal";
  if (!hasGrounding(evidence)) return "no_citable_record";
  if (participation.downgradeSignal) return "steelman_unavailable";
  if (!counterpartyEngaged(participation, evidence)) return "counterparty_absent";
  if (!bothSidesHaveMaterial(evidence)) return "one_sided_material";
  return "bilateral";
}

const RATIONALE: Readonly<Record<OutputLevelReason, string>> = {
  safety_refusal:
    "A safety red flag fired. This is a refusal, not a downgraded judgment: " +
    "the case leaves the pipeline for the crisis-referral path, and no model " +
    "is asked anything about it.",
  no_citable_record:
    "Nothing in this case can ground a factual claim — no first-hand material " +
    "and no confirmed line attributed to either party. What is left is how the " +
    "situation is being narrated, so the analysis is limited to the narration " +
    "and refuses to characterize what happened.",
  steelman_unavailable:
    "The other party's own case could not be stated at its strongest, or the " +
    "client could not recognize them in any version of it. A judgment that " +
    "allocates responsibility between two people requires being able to put " +
    "both cases; this one is capped at a one-sided analysis for that reason " +
    "alone, whatever the participation column says.",
  counterparty_absent:
    "Only one side is in this record. There is enough to ground factual " +
    "claims, so the analysis proceeds — but it is one-sided by construction, " +
    "must be labelled as such, and may not characterize the absent party's " +
    "motives or character.",
  one_sided_material:
    "The other party is here, but only one of the two has put material of " +
    "their own into this record. A finding that allocates responsibility " +
    "between two people has to be able to read both of them; what is on file " +
    "is one party's material, however it describes the other. The analysis " +
    "proceeds one-sided until each side owns something confirmed in it.",
  bilateral:
    "Both parties have confirmed material of their own in this record and the " +
    "claims can be grounded, so a full judgment is available.",
};

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The facts about the record that the judgment has to state in its own words.
 *
 * Emitted in a fixed order, so two runs over one case produce the same list —
 * these end up serialized into a judgment's fact layer, and the byte-stability
 * discipline in CLAUDE.md applies to anything that reaches a prompt.
 */
function findingsFor(
  participation: ParticipationInput,
  evidence: EvidenceProfileInput,
  safety: SafetyFlags,
): OutputLevelFinding[] {
  const findings: OutputLevelFinding[] = [];
  const { A, B, C, D } = evidence.counts;
  const { total, byClient, byCounterparty } = evidence.citableUtterances;

  if (mustRefuse(safety)) {
    findings.push({
      code: "safety_refusal",
      statement:
        "A safety screen refused this case. Nothing below is a judgment, and " +
        "no analysis of the relationship was produced.",
    });
    return findings;
  }

  if (byClient === 0 && byCounterparty > 0) {
    findings.push({
      code: "client_never_spoke_in_the_record",
      statement:
        `Not one line the client themselves spoke is confirmed in this case. ` +
        `All ${byCounterparty} citable line(s) were spoken by the other party, ` +
        `quoted from material the client submitted. Under the citation rule, ` +
        `every claim this analysis can make therefore rests on the other ` +
        `party's words about the client, and never on the client's own account ` +
        `of what they said.`,
    });
  } else if (byCounterparty === 0 && byClient > 0) {
    findings.push({
      code: "counterparty_never_spoke_in_the_record",
      statement:
        `No line spoken by the other party is confirmed in this case. All ` +
        `${byClient} citable line(s) are the client's own, so nothing here can ` +
        `establish what the other party actually said.`,
    });
  } else if (total === 0) {
    findings.push({
      code: "no_confirmed_speech",
      statement:
        "No utterance in this case has been confirmed, so nothing anyone said " +
        "can be quoted or relied on.",
    });
  }

  // Who OWNS what is confirmed here — a different question from who spoke, and
  // the one L1 turns on (SPEC M5 ⑥). Silent when neither party owns anything
  // confirmed: the findings above have already said the record is empty.
  if (evidence.hasClientConfirmed && !evidence.hasCounterpartyConfirmed) {
    findings.push({
      code: "counterparty_submitted_nothing",
      statement:
        "Every confirmed item in this case was submitted and signed off by the " +
        "client. The other party has put nothing of their own into the record — " +
        "including the lines attributed to them, which are here as material the " +
        "client collected and confirmed. This analysis can read what they are " +
        "quoted as saying; it cannot read anything they chose to show it.",
    });
  } else if (!evidence.hasClientConfirmed && evidence.hasCounterpartyConfirmed) {
    findings.push({
      code: "client_submitted_nothing",
      statement:
        "Nothing confirmed in this case was submitted by the party who brought " +
        "it. What is on file is the other party's material, so this analysis " +
        "cannot rest on the client's own account of anything.",
    });
  } else if (evidence.hasClientConfirmed && evidence.hasCounterpartyConfirmed) {
    findings.push({
      code: "both_parties_submitted_material",
      statement:
        "Both parties have put confirmed material of their own into this " +
        "record. That is what allows this hearing to say anything about the two " +
        "of them rather than about one of them and a description of the other.",
    });
  }

  if (A + B === 0 && C + D > 0) {
    findings.push({
      code: "no_first_hand_material",
      statement:
        `None of the ${C + D} graded item(s) in this case is first-hand: ` +
        `${C} are AI-processed (grade C) and ${D} are public sentiment ` +
        `(grade D). Whatever is grounded here is grounded on confirmed lines ` +
        `read out of those artifacts, not on an original record of the events.`,
    });
  }

  if (participation.state === "pending") {
    findings.push({
      code: "counterparty_never_asked",
      statement:
        "Nothing on file records what happened when the other party was " +
        "asked — the case does not claim they were asked at all. Their absence " +
        "from this analysis is unexplained, not chosen.",
    });
  } else if (!counterpartyEngaged(participation, evidence)) {
    findings.push({
      code: "counterparty_not_engaged",
      statement:
        `The other party's participation is recorded as "${participation.state}", ` +
        `so nothing they might say has entered this record.`,
    });
  }

  if (participation.downgradeSignal) {
    findings.push({
      code: "steelman_unavailable",
      statement:
        "The strongest version of the other party's case could not be written, " +
        "or the client did not recognize them in it. The analysis has not been " +
        "tested against their side.",
    });
  }

  return findings;
}
