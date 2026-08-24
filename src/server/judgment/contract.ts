/**
 * The judgment data contract — what a judgment IS, before anything generates one.
 *
 * A judgment in this product is two layers, and the split is the whole design
 * (SPEC M3 wave B ⑦):
 *
 *   - the **fact layer** is the skeleton: numbered claims, each grounded in
 *     confirmed utterances, each carrying how sure the hearing is and on what
 *     footing; plus the case-level findings that are not about any single claim.
 *   - the **surface layer** is the prose the user reads: sections, each bound to
 *     the claim ids it rests on.
 *
 * The one-way rule between them is why the contract exists at all: **the
 * narrative may not out-run the skeleton.** A section that rests on a claim id
 * the fact layer does not contain is not a warning, a lint or a style note — it
 * is a judgment asserting something no evidence was ever checked for, wearing
 * the same typography as the parts that were. `validateJudgmentContract`
 * rejects it, and every write path in this file runs that validator before it
 * touches SQLite.
 *
 * ## The tiers, and why `unknown` cites nothing
 *
 * `high_confidence` / `inferred` / `unknown` is not a politeness scale. It is
 * the difference between "the record shows this", "the record supports reading
 * it this way" and "the record cannot say". So:
 *
 *   - high_confidence and inferred claims MUST cite at least one utterance;
 *   - an `unknown` claim MUST cite nothing. A claim that cites the record and
 *     then declares itself unknown is two contradictory statements in one
 *     object, and the honest shape of "we do not know" is a claim with no
 *     citation and a confidence at the floor.
 *
 * That last rule is not academic. It is what lets this case's judgment state
 * its own hole in the record instead of papering over it.
 *
 * ## What the real case forced into this shape
 *
 * Two facts about the seeded case (SPEC M3 decision record, 2026-08-09) are
 * designed FOR here, not around:
 *
 *   1. **The client has never spoken inside the record.** All five of the
 *      client's own utterances are still `confirm_status = pending`, so under
 *      HARD RULE #1 they are invisible to every fetch the pipeline makes. Every
 *      issue item and every adverse fact cites one of the same two confirmed
 *      utterances — both of them the counterparty's. A judgment that says only
 *      "L2, one-sided" has not told the user what actually happened to their
 *      case. So `findings.record_basis` carries the counts (total / by_client /
 *      by_counterparty), names the client, and the schema refuses a
 *      `by_client: 0` that does not also list the client among the parties with
 *      no citable line. The asymmetry has to be stated in numbers, by the data,
 *      before any sentence is written about it.
 *   2. **The clarification answers were authored by a test operator** and the
 *      purge (`pipeline/operator-purge.ts`) resets them to an explicit "not
 *      answered by the client" state. That is a real state, not an error, and
 *      `findings.unresolved` carries `clarification_unanswered` as a
 *      first-class reason so the judgment can say which questions were put and
 *      never came back.
 *
 * ## Freezing (HARD RULE #6)
 *
 * A `final` judgment is immutable, and this file means it literally: no column
 * of a final row is ever written again, not even its status. Every mutating
 * statement here carries `WHERE status = 'draft'` as its own guard, so the
 * check that authorizes a write is the statement that performs it and a race
 * cannot slip past a stale read (the same discipline as `lockOutputLevel`).
 *
 * Regeneration therefore does not "supersede" the old row by editing it. It
 * inserts `version + 1` carrying `supersedes_judgment_id` back to its
 * predecessor — the pointer that migration 0005 exists for, because "v2 exists"
 * and "v2 replaced v1" are different statements and only the second one can
 * carry the disclosure the rule asks for. Which judgment stands is a question
 * the version chain answers; it is never a flag flipped on a frozen row.
 *
 * Renditions follow from that. They are **derived, never authored**, and since
 * M4 ① the two variants are derived differently. `self_reflection` is a
 * projection of the surface layer being frozen, minted inside the same
 * transaction. `shareable` is a second narrative addressed to the counterparty,
 * generated from the same frozen fact layer by the `shareable_narrative` stage
 * and validated against it — so it still cannot contain a sentence the fact
 * layer never backed, and it no longer contains a sentence written to somebody
 * else. `finalize` mints its row empty; nothing is shareable until that
 * narrative exists.
 *
 * The `audience: "self_only"` field is still applied in exactly one place
 * (`projectSection`, called only by `renderRendition`), which is what SPEC ⑪
 * means by "enforced in the query layer, not the UI". What M4 changed is that
 * the filter is no longer what makes a document shareable: a filter removes
 * paragraphs, and the defect it left behind was in the paragraphs it kept. What
 * doc 05 §A.3 changed is that the filter is **level-aware**: at L1 both parties
 * are participants, both responsibility findings belong to both readers, and
 * only the client's own reflection annexes stay private.
 *
 * ## What is deliberately NOT here
 *
 * Generation, the swap test, the renditions and the UI are other modules. This one
 * holds shape, coherence and lifetime, and nothing in it calls a model.
 * Evidence-reference validity (does that utterance exist, is it confirmed) also
 * stays where it already lives — `pipeline/evidence-refs.ts`, HARD RULE #1 —
 * because that check needs the database and a case id, and duplicating it here
 * would create a second answer to a question that must only have one.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  assertNamedRenditionAllowed,
  type NamedRenditionContext,
} from "../access/consent";
import type { Db } from "../db";
import {
  cases,
  judgmentRenditions,
  judgments,
  RENDITION_KINDS,
  type JudgmentStatus,
  type LlmEffort,
  type OutputLevel,
  type RenditionKind,
} from "../db/schema";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** How a claim stands to the record. See the header: this is not a politeness scale. */
export const CLAIM_TIERS = ["high_confidence", "inferred", "unknown"] as const;
export type ClaimTier = (typeof CLAIM_TIERS)[number];

/**
 * What a narrative section is doing.
 *
 * `finding` says something about the case and therefore must rest on claims.
 * `disclosure` (the one-sidedness statement, which model produced this, whether
 * the fallback served it) and `limits` (what this judgment cannot decide) are
 * about the judgment itself, so they rest on nothing — and forcing them to
 * invent a citation would be worse than letting them stand uncited.
 */
export const SECTION_KINDS = ["finding", "disclosure", "limits"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/**
 * Who may read a section. `self_only` is material written for the client alone.
 *
 * What `self_only` *withholds* is level-aware — see `projectSection`. At L2 it
 * keeps criticism of the client out of a document going to someone who was
 * never asked; at L1 both parties are participants and a finding about either
 * of them belongs to both, so only the client's own reflection annexes stay
 * private. The marking is a fixed property of the section; the projection is
 * where the level is applied, and it is the only place that decides.
 */
export const SECTION_AUDIENCES = ["both", "self_only"] as const;
export type SectionAudience = (typeof SECTION_AUDIENCES)[number];

/**
 * Responsibility, qualitatively. There is no numeric field here and there will
 * not be one: a percentage is a precision the record cannot support, and the
 * golden-cases harness asserts none appears in the prose either.
 */
export const RESPONSIBILITY_ALLOCATIONS = [
  "primary",
  "shared",
  "contributing",
  "not_established",
] as const;
export type ResponsibilityAllocation =
  (typeof RESPONSIBILITY_ALLOCATIONS)[number];

/** Why a question the case raised is still open at the end of the hearing. */
export const UNRESOLVED_REASONS = [
  /** Asked during clarification and never answered by the client. */
  "clarification_unanswered",
  /** The confirmed record simply does not contain the answer. */
  "record_silent",
  /** Outside what this product judges (medical, legal, third parties). */
  "outside_scope",
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/** A `high_confidence` claim may not be tentative. */
export const HIGH_CONFIDENCE_FLOOR = 0.7;

/** An `unknown` claim may not be confident. */
export const UNKNOWN_CONFIDENCE_CEILING = 0.2;

/**
 * Claim and section ids: short, whitespace-free, stable.
 *
 * They are matched exactly (`c1` and `C1` are different ids) because the
 * narrative binds to them and a case-folding match would let two claims
 * collapse into one silently. Keeping them token-shaped also keeps them usable
 * as placeholder anchors when `placeholders.ts` locks quotes and numbers.
 */
export const CONTRACT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

const idSchema = z
  .string()
  .regex(
    CONTRACT_ID_PATTERN,
    "an id starts with a letter and contains only letters, digits, '_' or '-' (max 32 chars)",
  );

/* -------------------------------------------------------------------------- */
/* Fact layer                                                                 */
/* -------------------------------------------------------------------------- */

export const claimSchema = z
  .object({
    claim_id: idSchema.describe(
      "Short stable id for this claim, e.g. c1. The narrative cites these; an " +
        "id it uses that is not defined here rejects the whole judgment.",
    ),
    statement: z
      .string()
      .min(1)
      .describe(
        "One sentence, in English, naming the parties by their pseudonyms. A " +
          "Chinese fragment may be quoted inside it, verbatim and untranslated.",
      ),
    evidence_refs: z
      .array(z.string().min(1))
      .max(8)
      .describe(
        "Utterance ids from the EVIDENCE block. Required (at least one) for " +
          "high_confidence and inferred claims; MUST be empty for unknown ones.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        `How sure the hearing is, 0-1. At least ${HIGH_CONFIDENCE_FLOOR} for a ` +
          `high_confidence claim, at most ${UNKNOWN_CONFIDENCE_CEILING} for an ` +
          `unknown one.`,
      ),
    tier: z
      .enum(CLAIM_TIERS)
      .describe(
        "high_confidence: the confirmed record shows this. inferred: the " +
          "record supports reading it this way. unknown: the record cannot " +
          "say — cite nothing and say so.",
      ),
  })
  .check((ctx) => {
    const claim = ctx.value;
    const cited = claim.evidence_refs.length;

    if (claim.tier === "unknown") {
      if (cited > 0) {
        ctx.issues.push({
          code: "custom",
          input: claim.evidence_refs,
          path: ["evidence_refs"],
          message:
            `Claim ${claim.claim_id} is tier "unknown" but cites ${cited} ` +
            `utterance(s). A claim the record cannot settle must cite nothing: ` +
            `if the record shows it, the claim is not unknown.`,
        });
      }
      if (claim.confidence > UNKNOWN_CONFIDENCE_CEILING) {
        ctx.issues.push({
          code: "custom",
          input: claim.confidence,
          path: ["confidence"],
          message:
            `Claim ${claim.claim_id} is tier "unknown" with confidence ` +
            `${claim.confidence}; an unknown claim may not exceed ` +
            `${UNKNOWN_CONFIDENCE_CEILING}.`,
        });
      }
      return;
    }

    if (cited === 0) {
      ctx.issues.push({
        code: "custom",
        input: claim.evidence_refs,
        path: ["evidence_refs"],
        message:
          `Claim ${claim.claim_id} is tier "${claim.tier}" and cites nothing. ` +
          `Only an "unknown" claim may stand uncited (HARD RULE #1).`,
      });
    }
    if (
      claim.tier === "high_confidence" &&
      claim.confidence < HIGH_CONFIDENCE_FLOOR
    ) {
      ctx.issues.push({
        code: "custom",
        input: claim.confidence,
        path: ["confidence"],
        message:
          `Claim ${claim.claim_id} is tier "high_confidence" with confidence ` +
          `${claim.confidence}; that tier starts at ${HIGH_CONFIDENCE_FLOOR}. ` +
          `Use "inferred" if it is not that solid.`,
      });
    }
  });

export type Claim = z.infer<typeof claimSchema>;

/**
 * What the judgment is standing on, counted rather than characterized.
 *
 * This is the finding the seeded real case made necessary: naming the level
 * ("L2, one-sided") describes the verdict's frame, while these numbers describe
 * the actual hole — two citable lines, both the counterparty's, none of the
 * client's own words confirmed.
 */
export const recordBasisSchema = z
  .object({
    client_pseudonym: z
      .string()
      .min(1)
      .describe("Pseudonym of the party who submitted this case."),
    citable_utterances: z
      .object({
        total: z.number().int().min(0),
        by_client: z.number().int().min(0),
        by_counterparty: z.number().int().min(0),
      })
      .describe(
        "Confirmed, citable utterances only — the same set HARD RULE #1 lets " +
          "anything be cited from. Unconfirmed lines are not counted here " +
          "because they do not exist for the hearing.",
      ),
    parties_without_citable_utterance: z
      .array(z.string().min(1))
      .max(8)
      .describe(
        "Pseudonyms of parties who have not spoken inside the confirmed " +
          "record at all. If by_client is 0, the client belongs in this list.",
      ),
    statement: z
      .string()
      .min(1)
      .describe(
        "One paragraph stating the asymmetry concretely — which party's words " +
          "the judgment could read and which it could not, and what that costs " +
          "the conclusions. No euphemism, no generic disclaimer.",
      ),
  })
  .check((ctx) => {
    const basis = ctx.value;
    const { total, by_client, by_counterparty } = basis.citable_utterances;

    if (by_client + by_counterparty > total) {
      ctx.issues.push({
        code: "custom",
        input: basis.citable_utterances,
        path: ["citable_utterances"],
        message:
          `by_client (${by_client}) + by_counterparty (${by_counterparty}) ` +
          `exceeds total (${total}).`,
      });
    }
    if (
      by_client === 0 &&
      !basis.parties_without_citable_utterance.includes(basis.client_pseudonym)
    ) {
      ctx.issues.push({
        code: "custom",
        input: basis.parties_without_citable_utterance,
        path: ["parties_without_citable_utterance"],
        message:
          `No citable utterance by the client (${basis.client_pseudonym}), so ` +
          `the client must be listed among the parties who have not spoken ` +
          `inside the record. A judgment written without one party's own words ` +
          `has to say so where it can be read, not only in prose.`,
      });
    }
  });

export type RecordBasis = z.infer<typeof recordBasisSchema>;

export const unresolvedQuestionSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe("What stayed open, phrased as the question it is."),
  reason: z.enum(UNRESOLVED_REASONS),
  claim_ids: z
    .array(idSchema)
    .max(8)
    .describe(
      "Claims that bear on the open question — typically the unknown-tier " +
        "claim that states the gap.",
    ),
});

export type UnresolvedQuestion = z.infer<typeof unresolvedQuestionSchema>;

export const responsibilitySchema = z.object({
  party: z.string().min(1).describe("Pseudonym."),
  allocation: z
    .enum(RESPONSIBILITY_ALLOCATIONS)
    .describe(
      "Qualitative only. There is no percentage field and a percentage may " +
        "not be written into any statement.",
    ),
  claim_ids: z
    .array(idSchema)
    .min(1)
    .max(12)
    .describe(
      "The claims this allocation rests on. `not_established` rests on the " +
        "claim that says why it could not be established.",
    ),
});

export type ResponsibilityFinding = z.infer<typeof responsibilitySchema>;

export const findingsSchema = z.object({
  record_basis: recordBasisSchema,
  unresolved: z.array(unresolvedQuestionSchema).max(12),
  /**
   * May be empty: an L3 (narrative-only) or refused output allocates nothing,
   * and an empty list is the honest encoding of that.
   */
  responsibility: z.array(responsibilitySchema).max(6),
});

export type Findings = z.infer<typeof findingsSchema>;

export const factLayerSchema = z.object({
  claims: z.array(claimSchema).min(1).max(40),
  findings: findingsSchema,
});

export type FactLayer = z.infer<typeof factLayerSchema>;

/* -------------------------------------------------------------------------- */
/* Surface layer                                                              */
/* -------------------------------------------------------------------------- */

export const judgmentSectionSchema = z
  .object({
    section_id: idSchema,
    kind: z.enum(SECTION_KINDS),
    audience: z
      .enum(SECTION_AUDIENCES)
      .describe(
        "both: appears in every rendition. self_only: criticism directed at " +
          "the client — self-reflection rendition only, never shared.",
      ),
    heading: z.string().min(1),
    text: z
      .string()
      .min(1)
      .describe(
        "The prose. Quoted evidence stays in its original language, verbatim.",
      ),
    claim_ids: z
      .array(idSchema)
      .max(12)
      .describe(
        "The claims this section rests on. Required for kind=finding. Every " +
          "id must be defined in the fact layer.",
      ),
  })
  .check((ctx) => {
    const section = ctx.value;
    if (section.kind === "finding" && section.claim_ids.length === 0) {
      ctx.issues.push({
        code: "custom",
        input: section.claim_ids,
        path: ["claim_ids"],
        message:
          `Section ${section.section_id} is a finding that rests on no claim. ` +
          `A finding with nothing under it is the failure this contract exists ` +
          `to catch; use kind "disclosure" or "limits" for text about the ` +
          `judgment itself.`,
      });
    }
  });

export type JudgmentSection = z.infer<typeof judgmentSectionSchema>;

export const surfaceLayerSchema = z.object({
  sections: z.array(judgmentSectionSchema).min(1).max(24),
});

export type SurfaceLayer = z.infer<typeof surfaceLayerSchema>;

/* -------------------------------------------------------------------------- */
/* Renditions                                                                 */
/* -------------------------------------------------------------------------- */

export const renditionKindSchema = z.enum(RENDITION_KINDS);

/* -------------------------------------------------------------------------- */
/* The audience projection (doc 05 §A.3; closes SPEC 2026-08-14)              */
/* -------------------------------------------------------------------------- */

/**
 * Who is holding the copy. Not a permission and not an identity — the two
 * people a judgment in this product can be read by.
 */
export const SECTION_READERS = ["client", "counterparty"] as const;
export type SectionReader = (typeof SECTION_READERS)[number];

/**
 * Why a section is in or out of one reader's copy. Reported rather than
 * inferred, so a caller (and a test) can assert the rule that fired and not
 * merely the outcome.
 */
export const SECTION_VISIBILITY_REASONS = [
  /** `audience: "both"` — written for everyone who reads this judgment. */
  "addressed_to_both",
  /** The reader is the client, whose own copy carries every section. */
  "own_copy",
  /**
   * L1 only: a finding marked `self_only`, shown to the counterparty because at
   * L1 both parties are participants and a finding about either belongs to both.
   */
  "l1_shared_finding",
  /** Not a finding, marked for the client: his own reflection annex. Private at every level. */
  "self_reflection_annex",
  /** Below L1: criticism of a party the other party never had to answer to. */
  "criticism_of_client",
] as const;
export type SectionVisibilityReason = (typeof SECTION_VISIBILITY_REASONS)[number];

export interface SectionProjectionInput {
  /** The level the JUDGMENT was issued at, never the case's current level. */
  readonly level: OutputLevel;
  readonly audience: SectionAudience;
  /**
   * Needed, and this is the whole hinge of the L1 rule: doc 05 §A.3 gives both
   * readers the same *findings*, and leaves the per-party self-reflection
   * annexes private. `finding` is already defined as "says something about the
   * case and therefore must rest on claims" (see `SECTION_KINDS`), so it is the
   * line the framework draws, expressed in vocabulary the contract already has.
   */
  readonly kind: SectionKind;
  readonly reader: SectionReader;
}

export interface SectionProjection {
  readonly visible: boolean;
  readonly reason: SectionVisibilityReason;
}

/**
 * Does one section of one judgment reach one reader?
 *
 * Pure, total, and the only place the question is answered. Every rendition,
 * export and read view projects through this function, so the two parties'
 * copies cannot be assembled under two different rules.
 *
 * ## The defect this closes (SPEC 2026-08-14, ratified by doc 05 §A.3)
 *
 * `audience` used to be obeyed identically at every level: `self_only` was
 * withheld from the shareable copy, full stop. At L2 that is right — the
 * counterparty was never asked anything, and criticism of the client is not
 * hers to receive. At L1 the same rule inverts into its opposite. The first
 * real L1 hearing marked "Responsibility: 乙's share" `self_only` and
 * "Responsibility: 甲's share" `both`, so the counterparty — who had spoken,
 * confirmed her lines and filed the appeal — would have received the half
 * against her and not the half against him, while the `limits` section she did
 * receive asserted an allocation she could not see. Each reader got ammunition;
 * neither got their own accounting.
 *
 * So the level is a parameter. At L1 both parties are participants in one
 * hearing and there is no "shareable version" of it: the findings are the same
 * document for both. What stays private is what was never a finding about the
 * case — the client's own reflection annex ("For 乙's version alone: what the
 * declined questions cost", in the real L1 document), which is `self_only` and
 * is not `kind: "finding"`.
 *
 * ## Why `self_only` is read as "the client's", never "the document's owner's"
 *
 * The contract defines `self_only` as material written for the client, and the
 * counterparty's copy is a separately generated narrative in which every
 * section must be `both` (`checkShareableNarrative`). A `self_only` section
 * arriving in her narrative is therefore a mislabelling, not her annex — so
 * projecting it as "private to whoever owns this document" would hand her
 * criticism of him under the name of privacy. Below L1 it stays out; at L1 it
 * is a finding both of them are owed anyway.
 */
export function projectSection(
  input: SectionProjectionInput,
): SectionProjection {
  const { level, audience, kind, reader } = input;

  if (audience === "both") {
    return { visible: true, reason: "addressed_to_both" };
  }
  // `self_only` from here down.
  if (reader === "client") {
    return { visible: true, reason: "own_copy" };
  }
  if (kind !== "finding") {
    return { visible: false, reason: "self_reflection_annex" };
  }
  return level === "L1"
    ? { visible: true, reason: "l1_shared_finding" }
    : { visible: false, reason: "criticism_of_client" };
}

/** Which reader holds a rendition of this kind. */
export function readerForRendition(kind: RenditionKind): SectionReader {
  return kind === "self_reflection" ? "client" : "counterparty";
}

/**
 * The `self_only` sections that stay private at every level: the client's own
 * reflection annexes, i.e. `self_only` material that is not a finding.
 */
export function isSelfReflectionAnnex(section: JudgmentSection): boolean {
  return section.audience === "self_only" && section.kind !== "finding";
}

/** One audience's view of the same surface layer. Derived, never authored. */
export interface Rendition {
  readonly kind: RenditionKind;
  /** True only for `shareable`. A self-reflection rendition never leaves. */
  readonly shareable: boolean;
  readonly text: string;
  /** Sections included, in order. */
  readonly sectionIds: readonly string[];
  /** Sections withheld from this audience. */
  readonly omittedSectionIds: readonly string[];
  /** Why each section landed where it did, in document order. */
  readonly projection: readonly {
    readonly sectionId: string;
    readonly visible: boolean;
    readonly reason: SectionVisibilityReason;
  }[];
}

/**
 * Render one variant of a surface layer.
 *
 * The audience filter lives here and nowhere else — it calls `projectSection`
 * per section and does nothing of its own — so the two variants cannot drift
 * into different facts and a UI cannot re-derive the shareable one with a
 * different rule.
 *
 * `level` is the level the JUDGMENT was issued at. It is optional, and omitting
 * it asks the pre-L1 question: the projection falls back to `L2`, which is the
 * restrictive answer and exactly what every caller was asking before doc 05
 * §A.3, so no call site changed meaning by not being updated. Every db-backed
 * path supplies it from the frozen row (`renderJudgmentRendition`, `finalize`),
 * which is why no caller of those has to know the rule exists.
 *
 * Deterministic and free of timestamps — two calls on the same input produce
 * byte-identical text, which is what makes a version-to-version diff (HARD RULE
 * #6) mean something.
 */
export function renderRendition(
  surfaceLayer: SurfaceLayer,
  kind: RenditionKind,
  level: OutputLevel = "L2",
): Rendition {
  const reader = readerForRendition(kind);
  const included: JudgmentSection[] = [];
  const omitted: string[] = [];
  const projection: {
    sectionId: string;
    visible: boolean;
    reason: SectionVisibilityReason;
  }[] = [];

  for (const section of surfaceLayer.sections) {
    const decision = projectSection({
      level,
      audience: section.audience,
      kind: section.kind,
      reader,
    });
    projection.push({
      sectionId: section.section_id,
      visible: decision.visible,
      reason: decision.reason,
    });
    if (decision.visible) included.push(section);
    else omitted.push(section.section_id);
  }

  return {
    kind,
    shareable: kind === "shareable",
    text: included
      .map((section) => `## ${section.heading}\n\n${section.text}`)
      .join("\n\n"),
    sectionIds: included.map((section) => section.section_id),
    omittedSectionIds: omitted,
    projection,
  };
}

/**
 * Guard for the share-token minting path (SPEC ⑪, implemented in M4; consent
 * added in M5 ③).
 *
 * Exported so the rule has one home: whatever mints a token calls this first,
 * and a self-reflection rendition is refused in the server, not hidden in the UI.
 *
 * Two questions, not one, and they fail differently on purpose:
 *
 *   1. **The kind.** A property of the document — answerable with nothing but
 *      the argument, so it is answered first and needs no database.
 *   2. **The consent**, when the caller passes a case. A property of a person's
 *      current decision, which is why it needs the log: a party who has
 *      withdrawn consent for documents naming them closes this door for as long
 *      as the withdrawal stands, and reopens it by granting again. The rule
 *      itself lives in `access/consent`; this calls it rather than restating it,
 *      and the export gate calls the same one.
 *
 * `consent` is optional because the caller often knows the kind before it knows
 * the case (`mintShareToken` reads the judgment to find out which case it is on).
 * Omitting it asks the kind question alone — which is what every pre-M5 caller
 * was asking, so no existing call site changed meaning.
 */
export function assertShareTokenAllowed(
  kind: RenditionKind,
  consent?: NamedRenditionContext,
): void {
  if (kind !== "shareable") {
    throw new JudgmentStoreError(
      "not_shareable",
      `A "${kind}" rendition carries the criticism written for the client ` +
        `alone; no share token is ever minted for it.`,
    );
  }
  // Throws NamedRenditionRevokedError, which carries who withdrew, when, and
  // which copies had already left — the caller re-throws it in its own vocabulary
  // (the export gate) or lets it through with that payload intact (minting).
  if (consent !== undefined) assertNamedRenditionAllowed(consent);
}

/* -------------------------------------------------------------------------- */
/* Contract violations                                                        */
/* -------------------------------------------------------------------------- */

export const CONTRACT_VIOLATION_CODES = [
  /** The value does not even have the shape (zod rejected it). */
  "schema_invalid",
  /** Two claims share one id, so a citation of it is ambiguous. */
  "duplicate_claim_id",
  /** Two sections share one id. */
  "duplicate_section_id",
  /** Something cites a claim_id the fact layer does not define. THE rule. */
  "unknown_claim_id",
  /** A `finding` section resting on no claim at all. */
  "uncited_finding_section",
] as const;
export type ContractViolationCode = (typeof CONTRACT_VIOLATION_CODES)[number];

export interface ContractViolation {
  readonly code: ContractViolationCode;
  /** Where it sits, e.g. `surface_layer.sections[2].claim_ids[0]`. */
  readonly path: string;
  /** One sentence, readable by a user and by a model on the retry. */
  readonly detail: string;
}

export interface ContractCheck {
  readonly ok: boolean;
  readonly violations: readonly ContractViolation[];
  /**
   * Claims no narrative section rests on. NOT a violation — a skeleton may
   * hold a claim the prose decided not to lean on, and a claim used only by
   * `findings` (a responsibility allocation, an open question) is still doing
   * work — but worth surfacing, because a fact layer whose claims are mostly
   * unnarrated usually means the prose was written from somewhere else.
   *
   * Empty while there is no narrative: nothing can be unused by prose that
   * does not exist yet.
   */
  readonly unusedClaimIds: readonly string[];
}

/** Every failure this module raises about shape or coherence. */
export class JudgmentContractError extends Error {
  readonly violations: readonly ContractViolation[];

  constructor(violations: readonly ContractViolation[], context?: string) {
    super(describeViolations(violations, context));
    this.name = "JudgmentContractError";
    this.violations = violations;
  }
}

/** The fault report, in one string — shown to the user, handed to the model. */
export function describeViolations(
  violations: readonly ContractViolation[],
  context?: string,
): string {
  const head =
    context === undefined
      ? "The judgment does not satisfy its data contract:"
      : `${context} does not satisfy its data contract:`;
  const body = violations
    .map((violation) => `  - [${violation.code}] ${violation.path}: ${violation.detail}`)
    .join("\n");
  return `${head}\n${body}`;
}

function fromZodError(error: z.ZodError, context: string): JudgmentContractError {
  const violations = error.issues.map((issue) => ({
    code: "schema_invalid" as const,
    path:
      issue.path.length === 0
        ? context
        : `${context}.${issue.path.map(String).join(".")}`,
    detail: issue.message,
  }));
  return new JudgmentContractError(violations, context);
}

/**
 * Parse raw fact-layer JSON (model output, or a stored column).
 * Throws `JudgmentContractError` so callers have one error type to catch.
 */
export function parseFactLayer(
  value: unknown,
  context = "fact_layer",
): FactLayer {
  const parsed = factLayerSchema.safeParse(value);
  if (!parsed.success) throw fromZodError(parsed.error, context);
  return parsed.data;
}

/** Parse raw surface-layer JSON. See `parseFactLayer`. */
export function parseSurfaceLayer(
  value: unknown,
  context = "surface_layer",
): SurfaceLayer {
  const parsed = surfaceLayerSchema.safeParse(value);
  if (!parsed.success) throw fromZodError(parsed.error, context);
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* The validator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Check the two layers against each other.
 *
 * The zod schemas own the shape of a single object; this owns everything that
 * is a relation between objects — id uniqueness, and every reference to a
 * claim_id from anywhere (a narrative section, an unresolved question, a
 * responsibility allocation) resolving to a claim that actually exists.
 *
 * Pure, synchronous, no database: it answers "is this judgment internally
 * coherent", never "is that citation real" (HARD RULE #1 answers that, against
 * SQLite, in `pipeline/evidence-refs.ts`).
 *
 * `surfaceLayer` may be null — that is the legitimate state between step one
 * and step two of generation, when the skeleton exists and the narrative does
 * not yet.
 */
export function validateJudgmentContract(
  factLayer: FactLayer,
  surfaceLayer: SurfaceLayer | null,
): ContractCheck {
  const violations: ContractViolation[] = [];
  const known = new Set<string>();

  factLayer.claims.forEach((claim, index) => {
    if (known.has(claim.claim_id)) {
      violations.push({
        code: "duplicate_claim_id",
        path: `fact_layer.claims[${index}].claim_id`,
        detail:
          `Claim id "${claim.claim_id}" is defined more than once, so a ` +
          `narrative citing it does not name one claim.`,
      });
      return;
    }
    known.add(claim.claim_id);
  });

  /** Claim ids a narrative section rests on — findings references do not count. */
  const narrated = new Set<string>();
  const checkRefs = (
    ids: readonly string[],
    path: (index: number) => string,
    what: string,
  ): void => {
    ids.forEach((id, index) => {
      if (known.has(id)) return;
      violations.push({
        code: "unknown_claim_id",
        path: path(index),
        detail:
          `${what} cites claim_id "${id}", which the fact layer does not ` +
          `define. A judgment may not rest on a claim that was never made, ` +
          `and never checked against the evidence.`,
      });
    });
  };

  factLayer.findings.unresolved.forEach((item, index) => {
    checkRefs(
      item.claim_ids,
      (refIndex) => `fact_layer.findings.unresolved[${index}].claim_ids[${refIndex}]`,
      `Unresolved question "${item.question}"`,
    );
  });

  factLayer.findings.responsibility.forEach((item, index) => {
    checkRefs(
      item.claim_ids,
      (refIndex) =>
        `fact_layer.findings.responsibility[${index}].claim_ids[${refIndex}]`,
      `Responsibility finding for ${item.party}`,
    );
  });

  if (surfaceLayer !== null) {
    const seenSections = new Set<string>();

    surfaceLayer.sections.forEach((section, index) => {
      if (seenSections.has(section.section_id)) {
        violations.push({
          code: "duplicate_section_id",
          path: `surface_layer.sections[${index}].section_id`,
          detail: `Section id "${section.section_id}" is used more than once.`,
        });
      }
      seenSections.add(section.section_id);

      // Also enforced by the schema on the way in from a model; repeated here
      // because the validator has to be a complete answer for data that
      // arrived some other way.
      if (section.kind === "finding" && section.claim_ids.length === 0) {
        violations.push({
          code: "uncited_finding_section",
          path: `surface_layer.sections[${index}].claim_ids`,
          detail:
            `Section "${section.section_id}" is a finding resting on no claim.`,
        });
      }

      for (const id of section.claim_ids) narrated.add(id);
      checkRefs(
        section.claim_ids,
        (refIndex) => `surface_layer.sections[${index}].claim_ids[${refIndex}]`,
        `Section "${section.section_id}"`,
      );
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    unusedClaimIds:
      surfaceLayer === null
        ? []
        : factLayer.claims
            .map((claim) => claim.claim_id)
            .filter((id) => !narrated.has(id)),
  };
}

/** `validateJudgmentContract`, as a precondition. Throws on any violation. */
export function assertJudgmentContract(
  factLayer: FactLayer,
  surfaceLayer: SurfaceLayer | null,
): ContractCheck {
  const check = validateJudgmentContract(factLayer, surfaceLayer);
  if (!check.ok) throw new JudgmentContractError(check.violations);
  return check;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export type JudgmentStoreErrorCode =
  | "case_not_found"
  | "judgment_not_found"
  /** HARD RULE #2: a judgment is issued at the level locked onto the case. */
  | "output_level_not_locked"
  /** The case was refused; the crisis path renders, no judgment is written. */
  | "output_level_refused"
  /** This case already has a judgment — regeneration goes through createNextVersion. */
  | "chain_exists"
  /** HARD RULE #6: the row is final and nothing may write to it again. */
  | "frozen"
  /** A successor already exists; the chain does not fork. */
  | "already_superseded"
  /** Finalizing without the narrative half. */
  | "surface_layer_missing"
  /** A share token was asked for on a rendition that may never be shared. */
  | "not_shareable";

export class JudgmentStoreError extends Error {
  readonly code: JudgmentStoreErrorCode;

  constructor(code: JudgmentStoreErrorCode, message: string) {
    super(message);
    this.name = "JudgmentStoreError";
    this.code = code;
  }
}

export interface JudgmentRecord {
  readonly id: string;
  readonly caseId: string;
  readonly version: number;
  readonly outputLevel: OutputLevel;
  readonly status: JudgmentStatus;
  readonly model: string;
  readonly effort: LlmEffort | null;
  readonly promptVersion: string | null;
  readonly fallbackUsed: boolean;
  readonly factLayer: FactLayer;
  /** Null between the skeleton and the narrative — the two-step gap. */
  readonly surfaceLayer: SurfaceLayer | null;
  readonly supersedesJudgmentId: string | null;
  readonly finalizedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RenditionRecord {
  readonly id: string;
  readonly judgmentId: string;
  readonly kind: RenditionKind;
  readonly shareable: boolean;
  readonly content: string;
  readonly createdAt: Date;
}

/** What a generation hands over. The layers are re-parsed here regardless. */
export interface JudgmentDraftInput {
  readonly model: string;
  readonly effort?: LlmEffort;
  readonly promptVersion?: string;
  /** Sticky-routing disclosure (HARD RULE #7) carried onto the judgment. */
  readonly fallbackUsed?: boolean;
  readonly factLayer: FactLayer;
  /** Optional: the narrative usually arrives in a second call. */
  readonly surfaceLayer?: SurfaceLayer | null;
}

type JudgmentRow = typeof judgments.$inferSelect;

function toRecord(row: JudgmentRow): JudgmentRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    version: row.version,
    outputLevel: row.outputLevel,
    status: row.status,
    model: row.model,
    effort: row.effort,
    promptVersion: row.promptVersion,
    fallbackUsed: row.fallbackUsed,
    // Strict on read: every write validated, so a row that no longer parses is
    // corruption or an undeclared schema change, and both must be loud.
    factLayer: parseFactLayer(row.content, `judgments[${row.id}].content`),
    surfaceLayer:
      row.surfaceLayer === null
        ? null
        : parseSurfaceLayer(row.surfaceLayer, `judgments[${row.id}].surface_layer`),
    supersedesJudgmentId: row.supersedesJudgmentId,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireRow(db: Db, judgmentId: string): JudgmentRow {
  const row = db.select().from(judgments).where(eq(judgments.id, judgmentId)).get();
  if (row === undefined) {
    throw new JudgmentStoreError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  return row;
}

function frozen(row: JudgmentRow): JudgmentStoreError {
  return new JudgmentStoreError(
    "frozen",
    `Judgment ${row.id} (version ${row.version}) is ${row.status} and is ` +
      `frozen: a judgment that has been issued is never rewritten. Regenerate ` +
      `it as version ${row.version + 1} with createNextVersion, which records ` +
      `what it replaced and discloses the diff (HARD RULE #6).`,
  );
}

/**
 * The output level this judgment must be issued at — read off the case, never
 * passed in (HARD RULE #2). An unlocked case cannot have a judgment, and a
 * refused one must not.
 */
function lockedLevelFor(db: Db, caseId: string): OutputLevel {
  const row = db
    .select({ level: cases.outputLevel })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();

  if (row === undefined) {
    throw new JudgmentStoreError("case_not_found", `No case with id ${caseId}.`);
  }
  if (row.level === null) {
    throw new JudgmentStoreError(
      "output_level_not_locked",
      `Case ${caseId} has no locked output level. The level is derived in code ` +
        `and locked onto the case before anything is written (lockOutputLevel); ` +
        `a judgment issued without one has no frame to have been written inside.`,
    );
  }
  if (row.level === "refused") {
    throw new JudgmentStoreError(
      "output_level_refused",
      `Case ${caseId} is locked at "refused". Refusal renders crisis resources ` +
        `deterministically (HARD RULE #9); no judgment is written for it.`,
    );
  }
  return row.level;
}

/** Validate both layers together, whatever combination the caller supplied. */
function validateInput(input: JudgmentDraftInput): {
  factLayer: FactLayer;
  surfaceLayer: SurfaceLayer | null;
} {
  const factLayer = parseFactLayer(input.factLayer);
  const surfaceLayer =
    input.surfaceLayer === undefined || input.surfaceLayer === null
      ? null
      : parseSurfaceLayer(input.surfaceLayer);
  assertJudgmentContract(factLayer, surfaceLayer);
  return { factLayer, surfaceLayer };
}

/**
 * Open version 1 of a case's judgment, as a draft.
 *
 * Refuses a case that already has one: a second chain would make "which
 * judgment stands" unanswerable, and regeneration has its own door
 * (`createNextVersion`).
 */
export function createDraft(
  db: Db,
  caseId: string,
  input: JudgmentDraftInput,
): JudgmentRecord {
  const outputLevel = lockedLevelFor(db, caseId);
  const { factLayer, surfaceLayer } = validateInput(input);

  const existing = db
    .select({ id: judgments.id, version: judgments.version })
    .from(judgments)
    .where(eq(judgments.caseId, caseId))
    .orderBy(desc(judgments.version))
    .get();
  if (existing !== undefined) {
    throw new JudgmentStoreError(
      "chain_exists",
      `Case ${caseId} already has a judgment (version ${existing.version}). ` +
        `Regenerating goes through createNextVersion so the new one records ` +
        `what it replaced.`,
    );
  }

  const [row] = db
    .insert(judgments)
    .values({
      caseId,
      version: 1,
      outputLevel,
      status: "draft",
      model: input.model,
      effort: input.effort ?? null,
      promptVersion: input.promptVersion ?? null,
      fallbackUsed: input.fallbackUsed ?? false,
      content: factLayer,
      surfaceLayer,
    })
    .returning()
    .all();

  return toRecord(row);
}

export interface JudgmentDraftPatch {
  readonly factLayer?: FactLayer;
  readonly surfaceLayer?: SurfaceLayer | null;
  readonly model?: string;
  readonly effort?: LlmEffort | null;
  readonly promptVersion?: string | null;
  readonly fallbackUsed?: boolean;
}

/**
 * Write to a draft — normally attaching the narrative to a skeleton.
 *
 * The `WHERE status = 'draft'` on the statement is the freeze, not the read
 * above it: if the row went final between the two, nothing is written and the
 * caller is told.
 */
export function updateDraft(
  db: Db,
  judgmentId: string,
  patch: JudgmentDraftPatch,
): JudgmentRecord {
  const row = requireRow(db, judgmentId);
  if (row.status !== "draft") throw frozen(row);

  const factLayer =
    patch.factLayer === undefined
      ? parseFactLayer(row.content, `judgments[${row.id}].content`)
      : parseFactLayer(patch.factLayer);

  const nextSurface =
    patch.surfaceLayer === undefined ? row.surfaceLayer : patch.surfaceLayer;
  const surfaceLayer =
    nextSurface === null
      ? null
      : parseSurfaceLayer(nextSurface, `judgments[${row.id}].surface_layer`);

  assertJudgmentContract(factLayer, surfaceLayer);

  const written = db
    .update(judgments)
    .set({
      content: factLayer,
      surfaceLayer,
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      ...(patch.promptVersion === undefined
        ? {}
        : { promptVersion: patch.promptVersion }),
      ...(patch.fallbackUsed === undefined
        ? {}
        : { fallbackUsed: patch.fallbackUsed }),
    })
    .where(and(eq(judgments.id, judgmentId), eq(judgments.status, "draft")))
    .returning()
    .all();

  if (written.length === 0) throw frozen(requireRow(db, judgmentId));
  return toRecord(written[0]);
}

/**
 * The counterparty's finished copy, handed to `finalize` so both parties'
 * documents come into existence in one transaction (doc 05 §A.1 state 6).
 *
 * Already rendered and already gate-checked by the caller: this module holds
 * shape and lifetime and calls no model, and `checkShareableNarrative` /
 * `renderShareable` live in the modules that own those rules. What `finalize`
 * adds is the only thing it can add — that these bytes and the freeze land
 * together or not at all.
 */
export interface CounterpartyCopy {
  /** The counterparty-addressed narrative, validated against the same fact layer. */
  readonly surfaceLayer: SurfaceLayer;
  /** The framed, checked document text. Stored as a record; reads re-derive it. */
  readonly text: string;
  readonly model: string;
  readonly effort?: LlmEffort | null;
  readonly promptVersion?: string | null;
  readonly fallbackUsed?: boolean;
}

/**
 * Freeze a draft (HARD RULE #6) and mint its renditions in the same transaction.
 *
 * Both halves must be present and coherent first: SPEC ⑧ publishes a judgment
 * "in one piece", and half a judgment is not a judgment. After this returns,
 * the row and its two renditions are read-only for the rest of their life.
 *
 * ## Simultaneous release (doc 05 §A.1 state 6, §C amendment 7)
 *
 * `copy` is how a two-party version publishes to both parties at the same
 * instant. Without it the shareable row is minted empty and the counterparty's
 * document arrives whenever the `shareable_narrative` stage is next run — which
 * is sequential unlock, and for a conflict product sequential unlock is itself
 * the grievance ("nobody got to read first and prepare a rebuttal", survey
 * §2.2). With it, the UPDATE that flips `status` to `final` and the UPDATE that
 * writes her copy are the same transaction: there is no instant at which the
 * judgment is readable by him and not by her. `finalizedAt` is written to both
 * rows' `generated_at`, so the shared instant is a recorded fact and not an
 * inference from row order.
 *
 * `renderRendition` is called with the judgment's own locked level, so the
 * client's copy is projected under the same rule as hers (`projectSection`).
 */
export function finalize(
  db: Db,
  judgmentId: string,
  copy?: CounterpartyCopy,
): JudgmentRecord {
  const row = requireRow(db, judgmentId);
  if (row.status !== "draft") throw frozen(row);

  const factLayer = parseFactLayer(row.content, `judgments[${row.id}].content`);
  if (row.surfaceLayer === null) {
    throw new JudgmentStoreError(
      "surface_layer_missing",
      `Judgment ${judgmentId} has a fact layer but no narrative. A judgment is ` +
        `published whole or not at all.`,
    );
  }
  const surfaceLayer = parseSurfaceLayer(
    row.surfaceLayer,
    `judgments[${row.id}].surface_layer`,
  );
  assertJudgmentContract(factLayer, surfaceLayer);

  const finalizedAt = new Date();

  return db.transaction((tx) => {
    const written = tx
      .update(judgments)
      .set({ status: "final", finalizedAt })
      .where(and(eq(judgments.id, judgmentId), eq(judgments.status, "draft")))
      .returning()
      .all();

    if (written.length === 0) {
      // Someone finalized between the read and the write. Re-read outside this
      // transaction's assumptions and report the truth.
      throw frozen(requireRow(db, judgmentId));
    }

    // The client's own copy is a projection of the narrative being frozen, so
    // it exists the moment the judgment does.
    const own = renderRendition(surfaceLayer, "self_reflection", row.outputLevel);
    tx.insert(judgmentRenditions)
      .values({
        judgmentId,
        kind: "self_reflection",
        content: own.text,
        shareable: false,
        generatedAt: finalizedAt,
      })
      .onConflictDoUpdate({
        target: [judgmentRenditions.judgmentId, judgmentRenditions.kind],
        set: { content: own.text, shareable: false, generatedAt: finalizedAt },
      })
      .run();

    // The counterparty's copy is a second narrative, written to her from this
    // fact layer by the `shareable_narrative` stage (M4 ①) — never the client's
    // narrative with sections removed, which produced a document addressed to
    // the wrong person and is the one defect the first real judgment exposed.
    //
    // When the caller hands it over, it is written here, in this transaction,
    // and the version is readable by both parties from the same instant. When
    // it does not, the row is minted empty and the share path refuses to open
    // it — `onConflictDoNothing`, because a narrative already on this row is a
    // derived artifact with its own lifecycle and freezing does not get to
    // clear it.
    if (copy === undefined) {
      tx.insert(judgmentRenditions)
        .values({ judgmentId, kind: "shareable", content: null, shareable: true })
        .onConflictDoNothing({
          target: [judgmentRenditions.judgmentId, judgmentRenditions.kind],
        })
        .run();
    } else {
      const counterparty = {
        content: copy.text,
        surfaceLayer: copy.surfaceLayer as unknown as Record<string, unknown>,
        shareable: true,
        model: copy.model,
        effort: copy.effort ?? null,
        promptVersion: copy.promptVersion ?? null,
        fallbackUsed: copy.fallbackUsed ?? false,
        revision: 1,
        generatedAt: finalizedAt,
      };
      tx.insert(judgmentRenditions)
        .values({ judgmentId, kind: "shareable", ...counterparty })
        .onConflictDoUpdate({
          target: [judgmentRenditions.judgmentId, judgmentRenditions.kind],
          set: counterparty,
        })
        .run();
    }

    return toRecord(written[0]);
  });
}

export interface NextVersionInput extends JudgmentDraftInput {
  /** The judgment being re-heard. It is read, never written. */
  readonly predecessorId: string;
}

/**
 * Regenerate: insert `version + 1` pointing back at what it replaces.
 *
 * The predecessor is not touched — not its content, not its status. That is
 * what "frozen" means, and it is why the pointer exists (migration 0005): the
 * chain records that v2 replaced v1 on the row that knows it, so the row the
 * user already read stays byte-identical forever.
 *
 * The chain does not fork. A predecessor that already has a successor is
 * refused, so `version` remains a total order over a case's judgments and
 * "which one stands" is never ambiguous.
 */
export function createNextVersion(
  db: Db,
  input: NextVersionInput,
): JudgmentRecord {
  const predecessor = requireRow(db, input.predecessorId);
  const outputLevel = lockedLevelFor(db, predecessor.caseId);
  const { factLayer, surfaceLayer } = validateInput(input);

  return db.transaction((tx) => {
    const successor = tx
      .select({ id: judgments.id, version: judgments.version })
      .from(judgments)
      .where(eq(judgments.supersedesJudgmentId, predecessor.id))
      .get();
    if (successor !== undefined) {
      throw new JudgmentStoreError(
        "already_superseded",
        `Judgment ${predecessor.id} was already re-heard as version ` +
          `${successor.version} (${successor.id}). Re-hear that one instead; ` +
          `the version chain is a line, not a tree.`,
      );
    }

    const [row] = tx
      .insert(judgments)
      .values({
        caseId: predecessor.caseId,
        version: predecessor.version + 1,
        outputLevel,
        status: "draft",
        model: input.model,
        effort: input.effort ?? null,
        promptVersion: input.promptVersion ?? null,
        fallbackUsed: input.fallbackUsed ?? false,
        content: factLayer,
        surfaceLayer,
        supersedesJudgmentId: predecessor.id,
      })
      .returning()
      .all();

    return toRecord(row);
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function readJudgment(db: Db, judgmentId: string): JudgmentRecord | null {
  const row = db.select().from(judgments).where(eq(judgments.id, judgmentId)).get();
  return row === undefined ? null : toRecord(row);
}

/** Every version of a case's judgment, oldest first. */
export function readJudgmentChain(db: Db, caseId: string): JudgmentRecord[] {
  return db
    .select()
    .from(judgments)
    .where(eq(judgments.caseId, caseId))
    .orderBy(asc(judgments.version))
    .all()
    .map(toRecord);
}

/**
 * The judgment that stands: the highest final version, or null while none has
 * been issued. Drafts are work in progress and are never "the judgment".
 */
export function readCurrentJudgment(
  db: Db,
  caseId: string,
): JudgmentRecord | null {
  const row = db
    .select()
    .from(judgments)
    .where(and(eq(judgments.caseId, caseId), eq(judgments.status, "final")))
    .orderBy(desc(judgments.version))
    .get();
  return row === undefined ? null : toRecord(row);
}

/** Renditions of one judgment (empty until it is finalized). */
export function listRenditions(db: Db, judgmentId: string): RenditionRecord[] {
  return db
    .select()
    .from(judgmentRenditions)
    .where(eq(judgmentRenditions.judgmentId, judgmentId))
    .orderBy(asc(judgmentRenditions.kind))
    .all()
    .map((row) => ({
      id: row.id,
      judgmentId: row.judgmentId,
      kind: row.kind,
      shareable: row.shareable,
      content: row.content ?? "",
      createdAt: row.createdAt,
    }));
}

/** One rendition, by audience. */
export function readRendition(
  db: Db,
  judgmentId: string,
  kind: RenditionKind,
): RenditionRecord | null {
  return (
    listRenditions(db, judgmentId).find((row) => row.kind === kind) ?? null
  );
}
