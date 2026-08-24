/**
 * Evidence grading — the deterministic half.
 *
 * A–D is decided by CODE, from what the material *is*, never by asking a model
 * "how good is this evidence". The one thing a model contributes is a narrow
 * observation about the picture's content (`evidence_anomaly_check`: is this
 * actually an AI chat session? is it mass-media content?), and even that only
 * ever feeds this table as a boolean. The mapping below is the whole rule.
 *
 *   A first-hand original record  firsthand         chat screenshot, original recording
 *   B retold / from memory        recollection      "he said he would…"
 *   C AI-processed artifact       ai_processed      ChatGPT session shots, AI summaries
 *   D mass-market emotional       public_sentiment  Xiaohongshu posts, comment sections
 *
 * Demotions only. A screenshot registers as A because that is what an unaltered
 * chat capture is, but three things pull it down, and whichever pulls hardest
 * wins:
 *
 *   - it was derived from other evidence (an AI summary of a screenshot is a
 *     C-grade artifact even though its source is A)
 *   - the anomaly check recognised an AI conversation in the image (C)
 *   - the anomaly check recognised mass-media / public-sentiment content (D)
 *
 * Nothing here can promote: no signal turns a D into an A. That asymmetry is
 * deliberate — a wrong promotion silently launders weak material into the fact
 * layer, a wrong demotion only costs the reviewer a correction.
 *
 * The result is a *suggestion* (`evidence.grade_suggested`). `grade_final` stays
 * NULL until a human confirms it.
 */

import type { EvidenceGrade, EvidenceSourceType } from "../db/schema";

export type { EvidenceGrade, EvidenceSourceType };

/* -------------------------------------------------------------------------- */
/* Registration vocabulary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the person uploading says they are handing in, mapped onto the schema's
 * A–D source vocabulary.
 *
 * The intake form speaks in concrete objects ("a screenshot", "something I
 * remember him saying"); `evidence.source_type` speaks in evidentiary classes.
 * Keeping the translation in one table means the UI never has to know that a
 * screenshot is "firsthand", and the grade rule never has to know that a
 * firsthand item arrived as a screenshot.
 */
export const REGISTRATION_SOURCE_TYPES = {
  /** A raw chat / app screenshot — the default upload. */
  screenshot: "firsthand",
  /** Something the submitter remembers being said. */
  retelling: "recollection",
  /** A screenshot of an AI conversation, declared as such up front. */
  ai_session: "ai_processed",
  /** Xiaohongshu / Weibo style public content. */
  mass_content: "public_sentiment",
} as const satisfies Record<string, EvidenceSourceType>;

/** Registration kinds the upload API accepts. */
export type RegistrationKind = keyof typeof REGISTRATION_SOURCE_TYPES;

/** Registration kind the upload endpoint assumes when none is given. */
export const DEFAULT_REGISTRATION_KIND: RegistrationKind = "screenshot";

export const REGISTRATION_KINDS = Object.keys(
  REGISTRATION_SOURCE_TYPES,
) as RegistrationKind[];

export function isRegistrationKind(value: unknown): value is RegistrationKind {
  return (
    typeof value === "string" &&
    Object.hasOwn(REGISTRATION_SOURCE_TYPES, value)
  );
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

/** Base grade per source type. The only place this mapping exists. */
export const GRADE_BY_SOURCE_TYPE = {
  firsthand: "A",
  recollection: "B",
  ai_processed: "C",
  public_sentiment: "D",
} as const satisfies Record<EvidenceSourceType, EvidenceGrade>;

/** Evidentiary weight, high to low. Used to pick the strongest demotion. */
const GRADE_ORDER: readonly EvidenceGrade[] = ["A", "B", "C", "D"];

function rank(grade: EvidenceGrade): number {
  return GRADE_ORDER.indexOf(grade);
}

/** Why a grade came out the way it did. Stable codes — the UI localizes them. */
export const GRADE_REASONS = [
  /** Base rule: source_type alone. */
  "source_type",
  /** Demoted to C: this item was produced from other evidence. */
  "derived_from",
  /** Demoted to C: the anomaly check saw an AI conversation in the image. */
  "ai_artifact_detected",
  /** Demoted to D: the anomaly check saw mass-media / public content. */
  "mass_content_detected",
] as const;
export type GradeReason = (typeof GRADE_REASONS)[number];

/** The narrow observation `evidence_anomaly_check` returns about an image. */
export interface EvidenceAnomaly {
  is_ai_artifact: boolean;
  is_mass_content: boolean;
  rationale: string;
}

export interface GradeInput {
  /** Registered evidentiary class of the material. */
  sourceType: EvidenceSourceType;
  /** Set when this item was produced from other evidence in the case. */
  derivedFromEvidenceId?: string | null;
  /** Anomaly-check result; null when it was skipped, refused or failed. */
  anomaly?: EvidenceAnomaly | null;
}

export interface GradeDecision {
  /** Suggested grade — write to `grade_suggested`, never to `grade_final`. */
  grade: EvidenceGrade;
  /**
   * Source type after the demotions. A screenshot that turns out to be an AI
   * session is not a firsthand record, so the correction is recorded on the
   * row rather than only in the grade.
   */
  sourceType: EvidenceSourceType;
  /** Every rule that fired, base first. */
  reasons: GradeReason[];
  /** English audit sentence for `grade_rationale` (UI copy is built from `reasons`). */
  rationale: string;
}

/** Every reason except the base rule, i.e. the ones that can pull a grade down. */
export type DemotionReason = Exclude<GradeReason, "source_type">;

/** One possible demotion: the grade it forces and the class it implies. */
interface Demotion {
  reason: DemotionReason;
  grade: EvidenceGrade;
  sourceType: EvidenceSourceType;
}

const RATIONALE: Record<DemotionReason, string> = {
  derived_from:
    "derived from existing evidence, so it is a processed artifact rather than an original record",
  ai_artifact_detected:
    "anomaly check recognised an AI conversation in the image, so it inherits one party's narrative frame",
  mass_content_detected:
    "anomaly check recognised mass-media / public-sentiment content, which says nothing about a party",
};

/**
 * Derive the suggested grade for one piece of evidence.
 *
 * Pure: same input, same output, no I/O, no model call. The anomaly result is
 * an input here, not something this function goes and fetches.
 */
export function deriveEvidenceGrade(input: GradeInput): GradeDecision {
  const base = GRADE_BY_SOURCE_TYPE[input.sourceType];

  const demotions: Demotion[] = [];
  if (input.derivedFromEvidenceId) {
    demotions.push({
      reason: "derived_from",
      grade: "C",
      sourceType: "ai_processed",
    });
  }
  if (input.anomaly?.is_ai_artifact) {
    demotions.push({
      reason: "ai_artifact_detected",
      grade: "C",
      sourceType: "ai_processed",
    });
  }
  if (input.anomaly?.is_mass_content) {
    demotions.push({
      reason: "mass_content_detected",
      grade: "D",
      sourceType: "public_sentiment",
    });
  }

  // Strongest demotion wins; a demotion that lands above the base is ignored,
  // so flagging a D item as an AI artifact leaves it at D.
  let grade = base;
  let sourceType = input.sourceType;
  const reasons: GradeReason[] = ["source_type"];
  const binding: DemotionReason[] = [];

  for (const demotion of demotions) {
    reasons.push(demotion.reason);
    // Only demotions that land *below* the base actually move the grade; the
    // rest are recorded as observations and left out of the rationale.
    if (rank(demotion.grade) > rank(base)) binding.push(demotion.reason);
    if (rank(demotion.grade) > rank(grade)) {
      grade = demotion.grade;
      sourceType = demotion.sourceType;
    }
  }

  const rationale =
    binding.length === 0
      ? `source_type=${input.sourceType} => grade ${base}.`
      : `source_type=${input.sourceType} would be grade ${base}; demoted to ${grade}: ` +
        `${binding.map((reason) => RATIONALE[reason]).join("; ")}.`;

  return { grade, sourceType, reasons, rationale };
}

/**
 * Convenience wrapper for the intake path, which starts from what the uploader
 * declared rather than from an evidentiary class.
 */
export function deriveGradeForRegistration(
  kind: RegistrationKind,
  extra: Omit<GradeInput, "sourceType"> = {},
): GradeDecision {
  return deriveEvidenceGrade({
    sourceType: REGISTRATION_SOURCE_TYPES[kind],
    ...extra,
  });
}
