/**
 * The judgment, assembled for a person to read — the read model behind
 * `/case/[id]/judgment`.
 *
 * This module exists because the product's core output had never been on a
 * screen. Every milestone's acceptance was written as "runs / tests green /
 * verified on the real case", so the judgment was complete, frozen, validated
 * and exportable, and the only way anyone had ever read one was by running a
 * script. This is the read model that closes that gap.
 *
 * ## It reads, and only reads
 *
 * Every function here is a `SELECT`. Nothing in this file writes, and nothing it
 * calls writes: `readCurrentJudgment`, `renderSelfReflection`, `readPolishRuns`,
 * `readOutputLevel` and `buildCitableBrief` are all pure reads, and
 * `readOutputLevel` says so in its own header. That is not a stylistic
 * preference — HARD RULE #6 says a final judgment is frozen, and a reading
 * screen that could touch the row it renders would be the most embarrassing
 * possible place to break it. `tests/judgment-read-view.test.ts` asserts the raw
 * judgment row is byte-identical before and after a render.
 *
 * ## Nothing here is a second opinion
 *
 * Each block is sourced from the layer that already owns it, and this module's
 * job is to fetch and join, never to decide:
 *
 *   - **what the level means** → `levelConstraints` (the same table the prompt
 *     is built from) and `readOutputLevel().decision.rationale` (the code's own
 *     words for why this level and not the neighbouring one). The screen does
 *     not paraphrase either.
 *   - **what the judgment stands on** → `findings.record_basis`, verbatim, as
 *     the generation wrote it and the contract validated it.
 *   - **which sections the self-reflection copy carries, in what order** →
 *     `renderSelfReflection`, so the screen cannot show a different document
 *     from the one the rendition layer defines.
 *   - **what a citation resolves to** → `buildCitableBrief`, i.e. the HARD
 *     RULE #1 query. A citation that no longer resolves comes back `stale`
 *     rather than silently absent.
 *
 * ## `audience` is reported, not obeyed
 *
 * `surface_layer.sections[].audience` is carried through as `storedAudience`
 * and nothing on the reading path branches on it. The stored marking is not, by
 * itself, a statement about who reads a section: what it withholds depends on
 * the level (`projectSection`, doc 05 §A.3 — at L1 a `self_only` finding goes
 * to both parties and only the client's own reflection annexes stay private).
 * A screen that rendered `self_only` as an authoritative "private, never
 * shared" badge would therefore still be asserting a guarantee the field alone
 * does not carry. So the field is surfaced as what it is — a stored marking,
 * shown so it can be inspected — with `sharedWithCounterparty` beside it for
 * the answer the projection actually gives at this judgment's level, and the
 * self-reflection rendition carries every section either way, which is the one
 * thing about the split that was never in doubt.
 *
 * ## Chinese evidence
 *
 * Quoted utterance text is returned exactly as stored: verbatim, untranslated,
 * unnormalized (CLAUDE.md). `isRetold` rides along so the render layer can apply
 * HARD RULE #5 — the framing is the UI's job, not this module's and not the
 * model's.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../db";
import {
  evidence as evidenceTable,
  judgmentRenditions,
  utterances as utterancesTable,
  type EvidenceGrade,
  type JudgmentStatus,
  type LlmEffort,
  type OutputLevel,
  type PolishOutcome,
} from "../db/schema";
import type { OutputLevelFinding } from "../domain/output-level";
import {
  OutputLevelError,
  buildCitableBrief,
  readOutputLevel,
  type BriefUtterance,
} from "../pipeline";
import {
  projectSection,
  readCurrentJudgment,
  readJudgmentChain,
  type Claim,
  type Findings,
  type JudgmentSection,
  type SectionAudience,
  type SectionVisibilityReason,
} from "./contract";
import { levelConstraints, type LevelConstraints } from "./levels";
import { readPolishRuns } from "./polish-history";
import { describeRelease, type ReleaseView } from "./publication";
import { renderSelfReflection } from "./rendition";

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One cited line, resolved back to the words somebody actually said.
 *
 * The point of the whole fact layer is that a reader can go from a sentence in
 * the narrative to the line underneath it, so `text` is the stored utterance
 * text and nothing else — no excerpt, no ellipsis, no translation.
 */
export interface CitationView {
  readonly utteranceId: string;
  /** Pseudonym of the speaker, as the citable brief resolves it. */
  readonly speaker: string;
  /** HARD RULE #5 — the render layer frames a recollection as a recollection. */
  readonly isRetold: boolean;
  /** Verbatim evidence, exactly as stored. Null when the line is no longer citable. */
  readonly text: string | null;
  /**
   * The line's citation no longer resolves under HARD RULE #1 — the utterance
   * was un-confirmed, removed, or put outside this audience's record after the
   * judgment was frozen. Reported rather than hidden: a frozen judgment resting
   * on a line that has since left the record is exactly the kind of thing a
   * reader is entitled to see.
   */
  readonly stale: boolean;
  /** Grade of the material the line came from (A-D), null until a human signs one off. */
  readonly evidenceGrade: EvidenceGrade | null;
}

/* -------------------------------------------------------------------------- */
/* The fact layer                                                             */
/* -------------------------------------------------------------------------- */

export interface ClaimView {
  readonly claimId: string;
  readonly statement: string;
  readonly tier: Claim["tier"];
  readonly confidence: number;
  readonly citations: readonly CitationView[];
  /**
   * True for `unknown`-tier claims, which the contract requires to cite nothing.
   * An uncited unknown claim is a deliberate statement — "the record cannot
   * settle this" — and rendering it as missing data would invert its meaning.
   */
  readonly uncitedByContract: boolean;
  /** Narrative sections resting on this claim, in document order. */
  readonly citedBySectionIds: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The narrative                                                              */
/* -------------------------------------------------------------------------- */

export interface SectionView {
  readonly sectionId: string;
  readonly kind: JudgmentSection["kind"];
  readonly heading: string;
  readonly text: string;
  /**
   * The `audience` value stored on the section. Reported, never acted on — see
   * the module header.
   */
  readonly storedAudience: SectionAudience;
  /**
   * Whether this section reaches the other party, at THIS judgment's level.
   *
   * Not a re-derivation: it is `projectSection`'s answer for
   * `reader: "counterparty"`, from the one function every rendition and export
   * projects through. Reported because the stored marking cannot answer it on
   * its own — at L1 a `self_only` finding is shared and a `self_only` annex is
   * not — and a reader of his own copy is entitled to know which of the
   * paragraphs in front of him she is also reading.
   */
  readonly sharedWithCounterparty: boolean;
  /** Why, in the projection's own vocabulary. */
  readonly sharingReason: SectionVisibilityReason;
  readonly claimIds: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Level                                                                      */
/* -------------------------------------------------------------------------- */

export interface LevelView {
  /** The level this judgment was ISSUED at — read off the frozen row. */
  readonly level: OutputLevel;
  /** What that level licenses, from the table the prompt is built from. */
  readonly constraints: LevelConstraints;
  /**
   * Why this level and not the neighbouring one, in the derivation's own words.
   * Null when the case's level can no longer be derived (a case that has gone).
   */
  readonly rationale: string | null;
  /** What the record looks like, as the derivation states it. Never re-worded. */
  readonly findings: readonly OutputLevelFinding[];
  readonly lockedAt: Date | null;
  /** What the record would derive right now, if that differs from the lock. */
  readonly derivesNow: OutputLevel | null;
  /**
   * The locked level is no longer what the record derives. Not an error: the
   * judgment was written inside the level it names, and a record that has moved
   * since is an argument for a new version, not for editing this one.
   */
  readonly stale: boolean;
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

export interface ProvenanceView {
  readonly judgmentId: string;
  readonly version: number;
  readonly status: JudgmentStatus;
  readonly model: string;
  readonly effort: LlmEffort | null;
  readonly promptVersion: string | null;
  /** HARD RULE #7: the request was routed to the fallback model instead. */
  readonly fallbackUsed: boolean;
  readonly frozenAt: Date | null;
  readonly supersedesJudgmentId: string | null;
  /** How many versions exist on this case — 1 means nothing has been re-heard. */
  readonly versionsInChain: number;
}

/* -------------------------------------------------------------------------- */
/* Polish (archive)                                                           */
/* -------------------------------------------------------------------------- */

export interface PolishSectionView {
  readonly sectionId: string;
  readonly heading: string;
  /** Fable's own wording, before the removed polish layer touched it. */
  readonly originalHeading: string;
  readonly originalText: string;
  readonly changed: boolean;
}

/**
 * The archived (original, polished, diff) triple, when one exists.
 *
 * The layer that produced these is gone (doc 02 §1.1a), so `ran: false` is now
 * the ordinary answer and means there is no second wording of this judgment and
 * no feature that could have produced one. The screen shows nothing in that
 * case: a disabled control advertising a removed capability is worse than no
 * control. What the block still exists for is the handful of judgments that DO
 * carry a run — those triples are audit records of six real GPT round trips,
 * and a reader of one of those judgments is entitled to see both wordings and
 * which one was frozen.
 */
export interface PolishView {
  /**
   * An archived polish run exists for this judgment. False for every judgment
   * produced after the layer was removed, which is now most of them.
   */
  readonly ran: boolean;
  readonly outcome: PolishOutcome | null;
  /**
   * Whether the text frozen on this judgment is the polished draft.
   *
   * Only `applied` ever wrote the polished layer back, so on every other
   * outcome the document on screen already IS Fable's original and there is
   * nothing to toggle to — but the run still happened, and the screen still
   * says so.
   */
  readonly polishedTextIsWhatIsShown: boolean;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly latencyMs: number | null;
  readonly ranAt: Date | null;
  /** Why the run ended where it did, as recorded. Credential-scrubbed — see `scrubReason`. */
  readonly reason: string | null;
  /** Per-section before/after, in document order. Empty when nothing was diffed. */
  readonly sections: readonly PolishSectionView[];
}

/* -------------------------------------------------------------------------- */
/* The whole view                                                             */
/* -------------------------------------------------------------------------- */

export interface JudgmentReadView {
  readonly caseId: string;
  readonly judgmentId: string;
  readonly level: LevelView;
  /** The judgment's own account of what it could read. Verbatim from the fact layer. */
  readonly findings: Findings;
  /** The self-reflection rendition's sections, in the order that rendition defines. */
  readonly sections: readonly SectionView[];
  /** Section ids the self-reflection copy withholds. Always empty — it withholds nothing. */
  readonly omittedSectionIds: readonly string[];
  /** Sections marked `self_only`: the criticism written for the client. */
  readonly criticismSectionIds: readonly string[];
  readonly claims: readonly ClaimView[];
  readonly provenance: ProvenanceView;
  readonly polish: PolishView;
  /**
   * A counterparty-addressed narrative has been generated for this judgment.
   * Reported so the screen can point at it without re-deriving one.
   */
  readonly hasShareableNarrative: boolean;
  /**
   * Whether this version is readable by both parties yet, and since when (doc
   * 05 §A.1 state 6).
   *
   * Carried on the client's own read view on purpose. A two-party version is
   * supposed to reach both people at the same instant, and the person most
   * entitled to know whether that actually happened is the one holding the copy
   * that would otherwise have arrived first.
   */
  readonly release: ReleaseView;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Strip anything shaped like an API key out of a recorded failure reason.
 *
 * Vendor error bodies were stored verbatim in `judgment_polish_runs.failures`,
 * and OpenAI's 401 body quotes the key it rejected with only the middle masked —
 * the prefix and last four characters survive. Those rows are still on disk and
 * still rendered, so this still runs: the stored row is the audit record and is
 * left exactly as it is, and the copy on its way to a screen is scrubbed,
 * because a credential fragment has no business being rendered. The substance
 * of the message ("model listing returned HTTP 401: Incorrect API key
 * provided") survives the scrub intact.
 */
export function scrubReason(reason: string | null): string | null {
  if (reason === null) return null;
  return reason.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_*-]{8,}/g, "[redacted key]");
}

/** Evidence grade per utterance id, for the lines a judgment cites. */
function gradesForUtterances(
  db: Db,
  utteranceIds: readonly string[],
): Map<string, EvidenceGrade | null> {
  const grades = new Map<string, EvidenceGrade | null>();
  if (utteranceIds.length === 0) return grades;

  const rows = db
    .select({
      utteranceId: utterancesTable.id,
      grade: evidenceTable.gradeFinal,
    })
    .from(utterancesTable)
    .leftJoin(evidenceTable, eq(utterancesTable.evidenceId, evidenceTable.id))
    .where(inArray(utterancesTable.id, [...new Set(utteranceIds)]))
    .all();

  for (const row of rows) grades.set(row.utteranceId, row.grade ?? null);
  return grades;
}

function resolveCitations(
  refs: readonly string[],
  citable: ReadonlyMap<string, BriefUtterance>,
  grades: ReadonlyMap<string, EvidenceGrade | null>,
): CitationView[] {
  return refs.map((ref) => {
    const line = citable.get(ref);
    return {
      utteranceId: ref,
      speaker: line?.speaker ?? "unknown",
      isRetold: line?.isRetold ?? false,
      text: line?.text ?? null,
      stale: line === undefined,
      evidenceGrade: grades.get(ref) ?? null,
    };
  });
}

function buildPolishView(db: Db, judgmentId: string): PolishView {
  const [run] = readPolishRuns(db, judgmentId);
  if (run === undefined) {
    return {
      ran: false,
      outcome: null,
      polishedTextIsWhatIsShown: false,
      model: null,
      promptVersion: null,
      latencyMs: null,
      ranAt: null,
      reason: null,
      sections: [],
    };
  }

  return {
    ran: true,
    outcome: run.outcome,
    polishedTextIsWhatIsShown: run.outcome === "applied",
    model: run.model,
    promptVersion: run.promptVersion,
    latencyMs: run.latencyMs,
    ranAt: run.createdAt,
    reason: scrubReason(run.reason),
    // The stored diff is the (original, polished) pairing itself, so the toggle
    // reads it rather than re-diffing the two layers — the screen shows the
    // comparison that was recorded, not one it computed later.
    sections: run.diff.map((entry) => ({
      sectionId: entry.section_id,
      heading: entry.heading.polished,
      originalHeading: entry.heading.original,
      originalText: entry.text.original,
      changed: entry.changed,
    })),
  };
}

function buildLevelView(
  db: Db,
  caseId: string,
  issuedAt: OutputLevel,
): LevelView {
  const constraints = levelConstraints(issuedAt);
  try {
    const view = readOutputLevel(db, caseId);
    return {
      level: issuedAt,
      constraints,
      rationale: view.decision.rationale,
      findings: view.decision.findings,
      lockedAt: view.lockedAt,
      derivesNow: view.decision.level,
      stale: view.decision.level !== issuedAt,
    };
  } catch (cause) {
    // A case that cannot be read is the layout's problem, not this block's: the
    // judgment itself still renders, minus the derivation commentary.
    if (cause instanceof OutputLevelError) {
      return {
        level: issuedAt,
        constraints,
        rationale: null,
        findings: [],
        lockedAt: null,
        derivesNow: null,
        stale: false,
      };
    }
    throw cause;
  }
}

/* -------------------------------------------------------------------------- */
/* The entry point                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything `/case/[id]/judgment` renders, in one read.
 *
 * Returns `null` when the case has no judgment that stands — a draft is work in
 * progress and is never "the judgment" (`readCurrentJudgment`), and a screen
 * that showed one would be publishing an unvalidated verdict to somebody who
 * came to read a verdict.
 *
 * Throws only if the judgment that stands has no narrative, which `finalize`
 * makes impossible: a judgment is published whole or not at all, so a final row
 * with a null surface layer is corruption and must be loud rather than
 * half-rendered.
 */
export function buildJudgmentReadView(
  db: Db,
  caseId: string,
): JudgmentReadView | null {
  const judgment = readCurrentJudgment(db, caseId);
  if (judgment === null) return null;

  const surfaceLayer = judgment.surfaceLayer;
  if (surfaceLayer === null) {
    throw new Error(
      `Judgment ${judgment.id} is final but carries no narrative. A judgment ` +
        `is frozen whole (contract.finalize refuses otherwise), so this row is ` +
        `corrupt and is not being rendered as if it were half a judgment.`,
    );
  }

  // The rendition layer decides which sections the client's own copy carries and
  // in what order; this only re-attaches the structure so the page can set it as
  // a document instead of one concatenated string.
  const rendition = renderSelfReflection(surfaceLayer);
  const sectionById = new Map(
    surfaceLayer.sections.map((section) => [section.section_id, section]),
  );
  const sections: SectionView[] = rendition.sectionIds.flatMap((sectionId) => {
    const section = sectionById.get(sectionId);
    /* c8 ignore next -- the rendition's ids come from this same layer. */
    if (section === undefined) return [];
    // The same function the renditions and the export path project through,
    // asked the counterparty's half of the question. This module still decides
    // nothing: it reports what that function answers, at this judgment's level.
    const toCounterparty = projectSection({
      level: judgment.outputLevel,
      audience: section.audience,
      kind: section.kind,
      reader: "counterparty",
    });
    return [
      {
        sectionId: section.section_id,
        kind: section.kind,
        heading: section.heading,
        text: section.text,
        storedAudience: section.audience,
        sharedWithCounterparty: toCounterparty.visible,
        sharingReason: toCounterparty.reason,
        claimIds: section.claim_ids,
      },
    ];
  });

  // HARD RULE #1's own query: the set of lines that may be cited is the set this
  // resolves against, so a citation the rule would no longer accept comes back
  // stale rather than resolving out of some wider read.
  const citable = new Map<string, BriefUtterance>(
    buildCitableBrief(db, caseId).utterances.map((line) => [line.id, line]),
  );
  const citedIds = judgment.factLayer.claims.flatMap((claim) => claim.evidence_refs);
  const grades = gradesForUtterances(db, citedIds);

  const sectionsByClaim = new Map<string, string[]>();
  for (const section of sections) {
    for (const claimId of section.claimIds) {
      const list = sectionsByClaim.get(claimId);
      if (list === undefined) sectionsByClaim.set(claimId, [section.sectionId]);
      else list.push(section.sectionId);
    }
  }

  const claims: ClaimView[] = judgment.factLayer.claims.map((claim) => ({
    claimId: claim.claim_id,
    statement: claim.statement,
    tier: claim.tier,
    confidence: claim.confidence,
    citations: resolveCitations(claim.evidence_refs, citable, grades),
    uncitedByContract: claim.tier === "unknown",
    citedBySectionIds: sectionsByClaim.get(claim.claim_id) ?? [],
  }));

  const chain = readJudgmentChain(db, caseId);

  return {
    caseId,
    judgmentId: judgment.id,
    level: buildLevelView(db, caseId, judgment.outputLevel),
    findings: judgment.factLayer.findings,
    sections,
    omittedSectionIds: rendition.omittedSectionIds,
    criticismSectionIds: rendition.criticismSectionIds,
    claims,
    provenance: {
      judgmentId: judgment.id,
      version: judgment.version,
      status: judgment.status,
      model: judgment.model,
      effort: judgment.effort,
      promptVersion: judgment.promptVersion,
      fallbackUsed: judgment.fallbackUsed,
      frozenAt: judgment.finalizedAt,
      supersedesJudgmentId: judgment.supersedesJudgmentId,
      versionsInChain: chain.length,
    },
    polish: buildPolishView(db, judgment.id),
    hasShareableNarrative: hasShareableNarrative(db, judgment.id),
    /* c8 ignore next -- null only for a judgment that was just read by id. */
    release: describeRelease(db, judgment.id) ?? {
      judgmentId: judgment.id,
      level: judgment.outputLevel,
      state: "single_party",
      twoParty: false,
      clientCopyExists: false,
      counterpartyCopyExists: false,
      releasedAt: null,
      missing: [],
    },
  };
}

/**
 * Whether the counterparty-addressed narrative exists.
 *
 * Asked as "is there a surface layer on the shareable row", which is the same
 * question `renderJudgmentRendition` asks before it will render one — so the
 * screen and the share path cannot disagree about whether a shareable copy
 * exists.
 */
function hasShareableNarrative(db: Db, judgmentId: string): boolean {
  const row = db
    .select({ surfaceLayer: judgmentRenditions.surfaceLayer })
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgmentId),
        eq(judgmentRenditions.kind, "shareable"),
      ),
    )
    .get();
  return row !== undefined && row.surfaceLayer !== null;
}
