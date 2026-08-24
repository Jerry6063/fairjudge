// The grading rule, as a table.
//
// `deriveEvidenceGrade` is the only thing in the product that decides A-D, and
// HARD RULE #2's reasoning applies here as much as it does to output levels: a
// grade the code cannot justify is a grade a prompt could quietly change. So
// the whole rule is pinned as data below — every source type, every demotion,
// every combination of the two anomaly booleans — and any change to the mapping
// has to be argued for by editing a table row.
//
// No I/O and no model: the anomaly result is an *input* here. The wiring that
// fetches it lives in `tests/evidence-upload.test.ts`.

import { describe, expect, it } from "vitest";

import { EVIDENCE_GRADES, EVIDENCE_SOURCE_TYPES } from "../src/server/db/schema";
import {
  DEFAULT_REGISTRATION_KIND,
  GRADE_BY_SOURCE_TYPE,
  REGISTRATION_KINDS,
  REGISTRATION_SOURCE_TYPES,
  deriveEvidenceGrade,
  deriveGradeForRegistration,
  isRegistrationKind,
  type EvidenceAnomaly,
  type EvidenceGrade,
  type GradeReason,
  type RegistrationKind,
} from "../src/server/domain/grading";

/** Anomaly result with both flags off — the common case. */
const CLEAN: EvidenceAnomaly = {
  is_ai_artifact: false,
  is_mass_content: false,
  rationale: "Two people trading short turns back and forth; no interface elements.",
};

function anomaly(
  flags: Partial<Pick<EvidenceAnomaly, "is_ai_artifact" | "is_mass_content">>,
): EvidenceAnomaly {
  return { ...CLEAN, ...flags, rationale: "Fixed rationale for tests." };
}

describe("evidence grading rule", () => {
  /* ------------------------------------------------------------------ */
  /* Registration vocabulary                                             */
  /* ------------------------------------------------------------------ */

  describe("registration vocabulary", () => {
    it("maps every upload kind onto a real source type", () => {
      for (const kind of REGISTRATION_KINDS) {
        expect(EVIDENCE_SOURCE_TYPES).toContain(REGISTRATION_SOURCE_TYPES[kind]);
      }
    });

    it("defaults an unlabelled upload to a plain screenshot", () => {
      expect(DEFAULT_REGISTRATION_KIND).toBe("screenshot");
      expect(REGISTRATION_SOURCE_TYPES[DEFAULT_REGISTRATION_KIND]).toBe("firsthand");
    });

    it("accepts exactly the registered kinds", () => {
      for (const kind of REGISTRATION_KINDS) expect(isRegistrationKind(kind)).toBe(true);
      for (const bogus of ["", "SCREENSHOT", "firsthand", "toString", null, 7, {}]) {
        expect(isRegistrationKind(bogus)).toBe(false);
      }
    });

    it("grades every source type the schema allows", () => {
      for (const sourceType of EVIDENCE_SOURCE_TYPES) {
        expect(EVIDENCE_GRADES).toContain(GRADE_BY_SOURCE_TYPE[sourceType]);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* The table                                                           */
  /* ------------------------------------------------------------------ */

  interface Row {
    what: string;
    kind: RegistrationKind;
    derivedFrom?: string | null;
    anomaly?: EvidenceAnomaly | null;
    grade: EvidenceGrade;
    /** Source type after the rule, which a demotion may correct. */
    sourceType: string;
    /** Every reason recorded, base first. */
    reasons: GradeReason[];
  }

  const TABLE: Row[] = [
    // --- base rule: what the uploader declared, nothing else known ---
    {
      what: "a chat screenshot",
      kind: "screenshot",
      grade: "A",
      sourceType: "firsthand",
      reasons: ["source_type"],
    },
    {
      what: "something the submitter remembers being said",
      kind: "retelling",
      grade: "B",
      sourceType: "recollection",
      reasons: ["source_type"],
    },
    {
      what: "an AI session declared as one up front",
      kind: "ai_session",
      grade: "C",
      sourceType: "ai_processed",
      reasons: ["source_type"],
    },
    {
      what: "a Xiaohongshu post",
      kind: "mass_content",
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type"],
    },

    // --- a clean anomaly check changes nothing ---
    {
      what: "a screenshot the check found nothing wrong with",
      kind: "screenshot",
      anomaly: CLEAN,
      grade: "A",
      sourceType: "firsthand",
      reasons: ["source_type"],
    },
    {
      what: "a screenshot uploaded with the check switched off",
      kind: "screenshot",
      anomaly: null,
      grade: "A",
      sourceType: "firsthand",
      reasons: ["source_type"],
    },

    // --- demotions ---
    {
      what: "a screenshot produced from evidence already in the case",
      kind: "screenshot",
      derivedFrom: "ev_source",
      grade: "C",
      sourceType: "ai_processed",
      reasons: ["source_type", "derived_from"],
    },
    {
      what: "a screenshot the check recognised as an AI conversation",
      kind: "screenshot",
      anomaly: anomaly({ is_ai_artifact: true }),
      grade: "C",
      sourceType: "ai_processed",
      reasons: ["source_type", "ai_artifact_detected"],
    },
    {
      what: "a screenshot the check recognised as public content",
      kind: "screenshot",
      anomaly: anomaly({ is_mass_content: true }),
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type", "mass_content_detected"],
    },
    {
      what: "a retelling the check recognised as an AI conversation",
      kind: "retelling",
      anomaly: anomaly({ is_ai_artifact: true }),
      grade: "C",
      sourceType: "ai_processed",
      reasons: ["source_type", "ai_artifact_detected"],
    },

    // --- strongest demotion wins ---
    {
      what: "a screenshot flagged as both AI and public content",
      kind: "screenshot",
      anomaly: anomaly({ is_ai_artifact: true, is_mass_content: true }),
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type", "ai_artifact_detected", "mass_content_detected"],
    },
    {
      what: "a derived screenshot also flagged as public content",
      kind: "screenshot",
      derivedFrom: "ev_source",
      anomaly: anomaly({ is_mass_content: true }),
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type", "derived_from", "mass_content_detected"],
    },

    // --- nothing promotes ---
    {
      what: "a declared AI session that is also derived",
      kind: "ai_session",
      derivedFrom: "ev_source",
      grade: "C",
      sourceType: "ai_processed",
      reasons: ["source_type", "derived_from"],
    },
    {
      what: "a Xiaohongshu post flagged as an AI conversation (C would be a promotion)",
      kind: "mass_content",
      anomaly: anomaly({ is_ai_artifact: true }),
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type", "ai_artifact_detected"],
    },
    {
      what: "a Xiaohongshu post that is also derived",
      kind: "mass_content",
      derivedFrom: "ev_source",
      grade: "D",
      sourceType: "public_sentiment",
      reasons: ["source_type", "derived_from"],
    },
  ];

  for (const row of TABLE) {
    it(`grades ${row.what} as ${row.grade}`, () => {
      const decision = deriveGradeForRegistration(row.kind, {
        derivedFromEvidenceId: row.derivedFrom ?? null,
        anomaly: row.anomaly ?? null,
      });

      expect(decision.grade).toBe(row.grade);
      expect(decision.sourceType).toBe(row.sourceType);
      expect(decision.reasons).toEqual(row.reasons);
      expect(decision.rationale.length).toBeGreaterThan(0);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Properties the table implies                                        */
  /* ------------------------------------------------------------------ */

  describe("invariants", () => {
    it("never promotes: no signal can raise a grade above its source type", () => {
      const signals = [
        { derivedFromEvidenceId: null, anomaly: null },
        { derivedFromEvidenceId: null, anomaly: CLEAN },
        { derivedFromEvidenceId: "ev_1", anomaly: null },
        { derivedFromEvidenceId: null, anomaly: anomaly({ is_ai_artifact: true }) },
        { derivedFromEvidenceId: null, anomaly: anomaly({ is_mass_content: true }) },
        {
          derivedFromEvidenceId: "ev_1",
          anomaly: anomaly({ is_ai_artifact: true, is_mass_content: true }),
        },
      ];

      for (const sourceType of EVIDENCE_SOURCE_TYPES) {
        const base = EVIDENCE_GRADES.indexOf(GRADE_BY_SOURCE_TYPE[sourceType]);
        for (const signal of signals) {
          const { grade } = deriveEvidenceGrade({ sourceType, ...signal });
          // Later letters are weaker evidence, so the index may only grow.
          expect(EVIDENCE_GRADES.indexOf(grade)).toBeGreaterThanOrEqual(base);
        }
      }
    });

    it("is pure: the same input grades the same way every time", () => {
      const input = {
        sourceType: "firsthand" as const,
        derivedFromEvidenceId: null,
        anomaly: anomaly({ is_ai_artifact: true }),
      };
      expect(deriveEvidenceGrade(input)).toEqual(deriveEvidenceGrade(input));
    });

    it("names the binding demotion in the rationale, and only that one", () => {
      const bothFlags = deriveGradeForRegistration("screenshot", {
        anomaly: anomaly({ is_ai_artifact: true, is_mass_content: true }),
      });
      expect(bothFlags.rationale).toContain("mass-media");
      expect(bothFlags.rationale).toContain("demoted to D");

      // Flagging a D item as an AI artifact records the observation without
      // pretending it moved the grade.
      const noOpFlag = deriveGradeForRegistration("mass_content", {
        anomaly: anomaly({ is_ai_artifact: true }),
      });
      expect(noOpFlag.reasons).toContain("ai_artifact_detected");
      expect(noOpFlag.rationale).not.toContain("demoted");
    });
  });
});
