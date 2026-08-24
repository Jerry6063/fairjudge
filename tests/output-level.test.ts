/**
 * Output-level derivation (HARD RULE #2) — the rule, with no I/O anywhere near
 * it.
 *
 * The case this file exists to pin down is the real one. Its material is 12
 * C-grade AI-processed screenshots and 2 D-grade public-sentiment posts — not
 * one first-hand item — and yet the correct level is L2, not L3. The reason is
 * the citable record: two utterances have been confirmed, both of them spoken by
 * the counterparty, and every issue item and adverse fact in that case cites one
 * of them. A derivation that looked only at grade letters would call the case
 * ungroundable while the pipeline above it was already grounding claims on
 * confirmed citations, and one of the two would be wrong.
 *
 * The same fixture pins the other half of it: the client's own five utterances
 * are all unconfirmed, so under the citation rule the client has never spoken
 * inside their own case. That is a fact the judgment has to state in its own
 * words, so the derivation has to hand it over as a finding rather than hide it
 * behind the L2 label.
 */

import { describe, expect, it } from "vitest";
import {
  deriveOutputLevel,
  explainOutputLevel,
  type EvidenceProfileInput,
  type ParticipationInput,
  type ParticipationState,
} from "../src/server/domain/output-level";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Participation with no downgrade signal unless one is asked for. */
function participation(
  state: ParticipationState,
  downgradeSignal = false,
): ParticipationInput {
  return { state, downgradeSignal };
}

/**
 * An evidence profile with everything at zero, overriding as needed.
 *
 * `hasClientConfirmed` defaults to true and `hasCounterpartyConfirmed` to false,
 * which is the shape of every case this product has ever held: the client
 * submits and confirms the material, and until M5 the other party had no way to
 * put anything into a case at all.
 */
function profile(
  overrides: Partial<{
    A: number;
    B: number;
    C: number;
    D: number;
    hasClientConfirmed: boolean;
    hasCounterpartyConfirmed: boolean;
    citable: { total: number; byClient: number; byCounterparty: number };
  }> = {},
): EvidenceProfileInput {
  const {
    hasClientConfirmed = true,
    hasCounterpartyConfirmed = false,
    citable,
    ...counts
  } = overrides;
  return {
    counts: { A: 0, B: 0, C: 0, D: 0, ...counts },
    hasClientConfirmed,
    hasCounterpartyConfirmed,
    citableUtterances: citable ?? { total: 0, byClient: 0, byCounterparty: 0 },
  };
}

/** Both parties own confirmed material — the M5 ⑥ precondition for L1. */
function bothConfirmed(
  overrides: Parameters<typeof profile>[0] = {},
): EvidenceProfileInput {
  return profile({
    ...overrides,
    hasClientConfirmed: true,
    hasCounterpartyConfirmed: true,
  });
}

/**
 * The seeded real case, as the database actually holds it after the operator
 * purge: 12 C + 2 D graded items, two confirmed utterances both spoken by 甲,
 * the client's own lines all still unconfirmed, the counterparty never asked,
 * and a steelman that was written and accepted (so no downgrade signal).
 */
const REAL_CASE = {
  participation: participation("pending"),
  evidence: profile({
    C: 12,
    D: 2,
    citable: { total: 2, byClient: 0, byCounterparty: 2 },
  }),
} as const;

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

describe("deriveOutputLevel", () => {
  it("caps single-side material with first-hand evidence at L2", () => {
    // Counterparty absent (refused), but the submitter has A-grade evidence.
    const level = deriveOutputLevel(participation("refused"), profile({ A: 3 }));
    expect(level).toBe("L2");
  });

  it("returns L3 when nothing is citable and no material is first-hand", () => {
    const level = deriveOutputLevel(
      participation("participating"),
      profile({ C: 5, D: 2 }),
    );
    expect(level).toBe("L3");
  });

  it("returns L1 when both sides engage and first-hand evidence exists", () => {
    const level = deriveOutputLevel(
      participation("participating"),
      bothConfirmed({ A: 2, B: 1 }),
    );
    expect(level).toBe("L1");
  });

  it("treats written_response as engagement, given material from both", () => {
    const level = deriveOutputLevel(
      participation("written_response"),
      bothConfirmed({ A: 1 }),
    );
    expect(level).toBe("L1");
  });

  it("promotes to L1 when the counterparty confirmed evidence despite a coarse state", () => {
    // `pending` is the client's report — or rather the absence of one. Her own
    // material outranks it: nothing else could have put it there.
    const level = deriveOutputLevel(
      participation("pending"),
      bothConfirmed({ A: 1 }),
    );
    expect(level).toBe("L1");
  });

  it("refuses on a domestic-violence red flag, overriding evidence/participation", () => {
    const level = deriveOutputLevel(
      participation("participating"),
      profile({ A: 5, B: 5 }),
      { domesticViolence: true },
    );
    expect(level).toBe("refused");
  });

  it("refuses on self-harm risk even for otherwise-L1 cases", () => {
    const level = deriveOutputLevel(
      participation("participating"),
      bothConfirmed({ A: 2 }),
      { selfHarmRisk: true },
    );
    expect(level).toBe("refused");
  });

  it("lets the grounding floor bind below the L2 participation cap", () => {
    // Counterparty absent (cap L2) AND nothing citable → L3 (lower binds).
    const level = deriveOutputLevel(
      participation("unreachable"),
      profile({ C: 4 }),
    );
    expect(level).toBe("L3");
  });

  it("returns L3 when there is no evidence at all", () => {
    expect(deriveOutputLevel(participation("unaware"), profile())).toBe("L3");
  });

  it("keeps unreachable/unaware/pending as single-side (L2) with first-hand evidence", () => {
    for (const state of ["unreachable", "unaware", "pending"] as const) {
      expect(deriveOutputLevel(participation(state), profile({ A: 1 }))).toBe(
        "L2",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* SPEC M5 ⑥ — the L1 upgrade path                                            */
/* -------------------------------------------------------------------------- */

describe("L1 needs material from both parties, not a report about one", () => {
  it("returns L1 with both confirmed and L2 with one, all else equal", () => {
    const engaged = participation("participating");

    expect(deriveOutputLevel(engaged, bothConfirmed({ A: 1 }))).toBe("L1");
    expect(
      deriveOutputLevel(
        engaged,
        profile({ A: 1, hasCounterpartyConfirmed: false }),
      ),
    ).toBe("L2");
    // And the mirror: her material, nothing of his. Still one-sided.
    expect(
      deriveOutputLevel(
        engaged,
        profile({ A: 1, hasClientConfirmed: false, hasCounterpartyConfirmed: true }),
      ),
    ).toBe("L2");
  });

  it("does not let the client's report of her participation buy L1 by itself", () => {
    // The participation column is what HE says happened when she was asked. It
    // settles the stage gate; it does not put a word of hers into the record.
    for (const state of ["participating", "written_response"] as const) {
      const decision = explainOutputLevel(participation(state), profile({ A: 2 }));
      expect(decision.level).toBe("L2");
      expect(decision.reason).toBe("one_sided_material");
      expect(decision.findings.map((f) => f.code)).toContain(
        "counterparty_submitted_nothing",
      );
    }
  });

  it("says, at L1, that both parties put something of their own in", () => {
    const decision = explainOutputLevel(
      participation("participating"),
      bothConfirmed({ A: 1, citable: { total: 4, byClient: 2, byCounterparty: 2 } }),
    );
    expect(decision.level).toBe("L1");
    expect(decision.reason).toBe("bilateral");
    expect(decision.findings.map((f) => f.code)).toContain(
      "both_parties_submitted_material",
    );
  });

  it("keeps the safety refusal and the steelman ceiling above the upgrade", () => {
    const bilateral = bothConfirmed({ A: 1 });
    expect(
      deriveOutputLevel(participation("participating", true), bilateral),
    ).toBe("L2");
    expect(
      deriveOutputLevel(participation("participating"), bilateral, {
        mustRefuse: true,
      }),
    ).toBe("refused");
  });

  it("does not upgrade a case that has nothing citable, whoever is here", () => {
    // Both sides present, but the only confirmed lines are attributed to
    // nobody: the grounding floor still binds below the upgrade.
    expect(
      deriveOutputLevel(
        participation("participating"),
        bothConfirmed({ C: 4, citable: { total: 2, byClient: 0, byCounterparty: 0 } }),
      ),
    ).toBe("L3");
  });
});

describe("the citable record grounds a case its grade letters cannot", () => {
  it("gives the real case L2, not L3, on two confirmed lines and no A/B material", () => {
    expect(deriveOutputLevel(REAL_CASE.participation, REAL_CASE.evidence)).toBe(
      "L2",
    );
  });

  it("would give the same case L3 if nothing had been confirmed", () => {
    const level = deriveOutputLevel(
      REAL_CASE.participation,
      profile({ C: 12, D: 2 }),
    );
    expect(level).toBe("L3");
  });

  it("does not ground a case on confirmed lines nobody has attributed", () => {
    // Two citable rows, neither attributed to a party (a clock reading, an
    // unrecognized line). Citable is not the same as evidence of what was said.
    const level = deriveOutputLevel(
      participation("pending"),
      profile({ C: 3, citable: { total: 2, byClient: 0, byCounterparty: 0 } }),
    );
    expect(level).toBe("L3");
  });
});

describe("the wave-A downgrade signal is a ceiling", () => {
  it("holds an otherwise bilateral case at L2 when no steelman could be written", () => {
    const bilateral = bothConfirmed({ A: 2 });
    expect(deriveOutputLevel(participation("participating"), bilateral)).toBe(
      "L1",
    );
    expect(
      deriveOutputLevel(participation("participating", true), bilateral),
    ).toBe("L2");
  });

  it("does not push a case below L2: a missing steelman removes no evidence", () => {
    const level = deriveOutputLevel(
      participation("refused", true),
      profile({ A: 1 }),
    );
    expect(level).toBe("L2");
  });

  it("never outranks a safety refusal", () => {
    const level = deriveOutputLevel(
      participation("participating", true),
      profile({ A: 1 }),
      { mustRefuse: true },
    );
    expect(level).toBe("refused");
  });
});

/* -------------------------------------------------------------------------- */
/* The reasoning                                                              */
/* -------------------------------------------------------------------------- */

describe("explainOutputLevel", () => {
  it("agrees with deriveOutputLevel on every combination it is given", () => {
    const states: ParticipationState[] = [
      "pending",
      "participating",
      "written_response",
      "refused",
      "unreachable",
      "unaware",
    ];
    for (const state of states) {
      for (const downgrade of [false, true]) {
        for (const evidence of [
          profile(),
          profile({ A: 1 }),
          profile({ C: 4 }),
          REAL_CASE.evidence,
          profile({ A: 1, hasClientConfirmed: false }),
          bothConfirmed({ A: 1 }),
        ]) {
          const input = participation(state, downgrade);
          expect(explainOutputLevel(input, evidence).level).toBe(
            deriveOutputLevel(input, evidence),
          );
        }
      }
    }
  });

  it("says, of the real case, that the client never spoke inside the record", () => {
    const decision = explainOutputLevel(
      REAL_CASE.participation,
      REAL_CASE.evidence,
    );

    expect(decision.level).toBe("L2");
    expect(decision.reason).toBe("counterparty_absent");

    const codes = decision.findings.map((finding) => finding.code);
    expect(codes).toContain("client_never_spoke_in_the_record");
    expect(codes).toContain("no_first_hand_material");
    expect(codes).toContain("counterparty_never_asked");

    const spoken = decision.findings.find(
      (finding) => finding.code === "client_never_spoke_in_the_record",
    );
    // The number is in the sentence, not just in a field somewhere: the
    // judgment quotes this text.
    expect(spoken?.statement).toMatch(/All 2 citable line\(s\)/);
  });

  it("names the rule that bound, one code per branch", () => {
    expect(
      explainOutputLevel(participation("participating"), profile({ A: 1 }), {
        mustRefuse: true,
      }).reason,
    ).toBe("safety_refusal");
    expect(
      explainOutputLevel(participation("participating"), profile({ C: 2 }))
        .reason,
    ).toBe("no_citable_record");
    expect(
      explainOutputLevel(participation("participating", true), bothConfirmed({ A: 1 }))
        .reason,
    ).toBe("steelman_unavailable");
    expect(
      explainOutputLevel(participation("refused"), profile({ A: 1 })).reason,
    ).toBe("counterparty_absent");
    expect(
      explainOutputLevel(participation("participating"), profile({ A: 1 })).reason,
    ).toBe("one_sided_material");
    expect(
      explainOutputLevel(participation("participating"), bothConfirmed({ A: 1 }))
        .reason,
    ).toBe("bilateral");
  });

  it("reports only the refusal on a refused case, and no analysis of the record", () => {
    const decision = explainOutputLevel(
      REAL_CASE.participation,
      REAL_CASE.evidence,
      { domesticViolence: true },
    );
    expect(decision.level).toBe("refused");
    expect(decision.findings.map((f) => f.code)).toEqual(["safety_refusal"]);
  });

  it("mirrors the finding when it is the counterparty who never spoke", () => {
    const decision = explainOutputLevel(
      participation("refused"),
      profile({ A: 2, citable: { total: 3, byClient: 3, byCounterparty: 0 } }),
    );
    expect(decision.findings.map((f) => f.code)).toContain(
      "counterparty_never_spoke_in_the_record",
    );
  });

  it("echoes its inputs, so a locked level can be audited afterwards", () => {
    const decision = explainOutputLevel(
      REAL_CASE.participation,
      REAL_CASE.evidence,
    );
    expect(decision.inputs.evidence.citableUtterances).toEqual({
      total: 2,
      byClient: 0,
      byCounterparty: 2,
    });
    expect(decision.inputs.participation.state).toBe("pending");
  });
});
