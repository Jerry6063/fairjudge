/**
 * Freezing at the service boundary, and the version-comparison view
 * (SPEC M3 wave B ⑫, HARD RULE #6).
 *
 * The store already refuses to write a final row — `contract.updateDraft` and
 * `contract.finalize` carry `WHERE status = 'draft'` on the statement itself, so
 * the check that authorizes the write *is* the write. This module is the door in
 * front of that: the single entry point an action, a route or a script calls,
 * so "can I edit this?" is answered once, in a place with a name, instead of by
 * whichever caller remembered to look at `status` first.
 *
 * Two functions carry the rule:
 *
 *   - `editJudgment` writes to a draft and throws `JudgmentStoreError("frozen")`
 *     on anything else. It does not "helpfully" fall back to regenerating: an
 *     edit and a re-hearing are different acts with different disclosure duties,
 *     and turning one into the other silently is how a frozen judgment quietly
 *     changes.
 *   - `regenerateJudgment` opens `version + 1` pointing at what it replaces. The
 *     predecessor is not touched, not even its status — the row the user already
 *     read stays byte-identical forever, which is the only version of "frozen"
 *     that survives contact with a database.
 *
 * ## Why a comparison view is part of the rule, not a feature next to it
 *
 * HARD RULE #6 does not say a judgment may be regenerated. It says a
 * regeneration **must disclose the diff and which model produced it**. So the
 * comparison is not a convenience for a curious user: it is the second half of
 * the permission to re-hear at all. `compareJudgmentVersions` produces it from
 * the two stored rows — what changed in the skeleton, what changed in the prose,
 * which model served each version, and whether the server-side fallback
 * (HARD RULE #7) quietly answered instead of the model that was asked for. A
 * version that came back from the fallback model is a different hearing, and the
 * user is entitled to know that before deciding which one they believe.
 *
 * The line diff is computed here (a small LCS) rather than pulled in: the input
 * is one judgment's prose, the output has to be stable enough to render the same
 * way twice, and a dependency for forty lines of dynamic programming is a
 * dependency for the sake of it.
 */

import type { Db } from "../db";
import type { JudgmentStatus, LlmEffort, OutputLevel } from "../db/schema";
import {
  createNextVersion,
  readJudgmentChain,
  updateDraft,
  type Claim,
  type FactLayer,
  type JudgmentDraftInput,
  type JudgmentDraftPatch,
  type JudgmentRecord,
  type JudgmentSection,
  type ResponsibilityAllocation,
  type SurfaceLayer,
} from "./contract";

/* -------------------------------------------------------------------------- */
/* The service boundary                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Edit a judgment.
 *
 * Delegates to `updateDraft`, which refuses anything that is not a draft. The
 * indirection is the point: this is the only function the app layer calls to
 * change a judgment, so the freeze cannot be routed around by a caller that
 * reaches for the store directly.
 */
export function editJudgment(
  db: Db,
  judgmentId: string,
  patch: JudgmentDraftPatch,
): JudgmentRecord {
  return updateDraft(db, judgmentId, patch);
}

export interface RegenerateInput extends JudgmentDraftInput {
  /**
   * Which version is being re-heard. Defaults to the newest one on the case —
   * the chain is a line, so "the newest" is unambiguous.
   */
  readonly predecessorId?: string;
}

/**
 * Re-hear a case: insert `version + 1`, pointing back at what it replaces.
 *
 * Returns the new draft. Nothing about the predecessor changes, so until this
 * one is finalized the judgment that stands is still the old one — which is
 * correct: a re-hearing in progress has not replaced anything yet.
 */
export function regenerateJudgment(
  db: Db,
  caseId: string,
  input: RegenerateInput,
): JudgmentRecord {
  const chain = readJudgmentChain(db, caseId);
  if (chain.length === 0) {
    throw new Error(
      `Case ${caseId} has no judgment to regenerate. Version 1 is opened with ` +
        `createDraft.`,
    );
  }

  const predecessor =
    input.predecessorId === undefined
      ? chain[chain.length - 1]
      : chain.find((record) => record.id === input.predecessorId);

  if (predecessor === undefined) {
    throw new Error(
      `Judgment ${input.predecessorId} is not part of case ${caseId}'s version ` +
        `chain.`,
    );
  }

  return createNextVersion(db, { ...input, predecessorId: predecessor.id });
}

/* -------------------------------------------------------------------------- */
/* Line diff                                                                  */
/* -------------------------------------------------------------------------- */

export type DiffOp = "same" | "added" | "removed";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
}

/**
 * Longest-common-subsequence line diff.
 *
 * Deterministic and total: the same pair of strings always produces the same
 * sequence of operations, which is what lets a version comparison be rendered,
 * stored, or compared to itself without drifting.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const rows = left.length;
  const columns = right.length;

  // lengths[i][j] = LCS length of left[i..] and right[j..].
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      out.push({ op: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ op: "removed", text: left[i] });
      i += 1;
    } else {
      out.push({ op: "added", text: right[j] });
      j += 1;
    }
  }
  while (i < rows) {
    out.push({ op: "removed", text: left[i] });
    i += 1;
  }
  while (j < columns) {
    out.push({ op: "added", text: right[j] });
    j += 1;
  }

  return out;
}

/** True when a diff contains an actual change. */
export function hasChanges(diff: readonly DiffLine[]): boolean {
  return diff.some((line) => line.op !== "same");
}

/* -------------------------------------------------------------------------- */
/* The comparison                                                             */
/* -------------------------------------------------------------------------- */

/** One version, as the comparison view shows it. */
export interface VersionSide {
  readonly judgmentId: string;
  readonly version: number;
  readonly status: JudgmentStatus;
  readonly outputLevel: OutputLevel;
  /** The model that served this version — the disclosure HARD RULE #6 asks for. */
  readonly model: string;
  readonly effort: LlmEffort | null;
  readonly promptVersion: string | null;
  /** True when server-side fallback answered instead (HARD RULE #7). */
  readonly fallbackUsed: boolean;
  readonly finalizedAt: Date | null;
  readonly supersedesJudgmentId: string | null;
}

export interface ClaimSnapshot {
  readonly claimId: string;
  readonly statement: string;
  readonly tier: Claim["tier"];
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
}

export interface ClaimChange {
  readonly claimId: string;
  readonly before: ClaimSnapshot;
  readonly after: ClaimSnapshot;
  /** What differs, in words: "tier", "confidence", "citations", "statement". */
  readonly changed: readonly string[];
  readonly statementDiff: readonly DiffLine[];
}

export interface SectionChange {
  readonly sectionId: string;
  readonly heading: string;
  readonly audienceChanged: boolean;
  readonly kindChanged: boolean;
  readonly diff: readonly DiffLine[];
}

export interface AllocationChange {
  readonly party: string;
  readonly before: ResponsibilityAllocation | null;
  readonly after: ResponsibilityAllocation | null;
}

export interface VersionComparison {
  readonly caseId: string;
  readonly before: VersionSide;
  readonly after: VersionSide;
  readonly claimsAdded: readonly ClaimSnapshot[];
  readonly claimsRemoved: readonly ClaimSnapshot[];
  readonly claimsChanged: readonly ClaimChange[];
  readonly sectionsAdded: readonly string[];
  readonly sectionsRemoved: readonly string[];
  readonly sectionsChanged: readonly SectionChange[];
  readonly allocationChanges: readonly AllocationChange[];
  /** Set when the two versions disagree about what the record contains. */
  readonly recordBasisChanged: boolean;
  /**
   * The two versions were issued at different output levels (SPEC M5 ⑥).
   *
   * The single most consequential difference there is, because the level is what
   * a judgment is ALLOWED to say — an L2 that could not allocate responsibility
   * and an L1 that may are not two drafts of one document. It is stated
   * separately from the claim and section diffs for that reason: a reader
   * comparing the two has to be told the rules changed, not left to infer it
   * from a responsibility list appearing out of nowhere.
   */
  readonly levelChanged: boolean;
  readonly modelChanged: boolean;
  readonly fallbackChanged: boolean;
  /** True when nothing this comparison looks at differs. */
  readonly identical: boolean;
  /** The paragraph the UI shows above the diff. */
  readonly disclosure: string;
}

function toSide(record: JudgmentRecord): VersionSide {
  return {
    judgmentId: record.id,
    version: record.version,
    status: record.status,
    outputLevel: record.outputLevel,
    model: record.model,
    effort: record.effort,
    promptVersion: record.promptVersion,
    fallbackUsed: record.fallbackUsed,
    finalizedAt: record.finalizedAt,
    supersedesJudgmentId: record.supersedesJudgmentId,
  };
}

function toSnapshot(claim: Claim): ClaimSnapshot {
  return {
    claimId: claim.claim_id,
    statement: claim.statement,
    tier: claim.tier,
    confidence: claim.confidence,
    evidenceRefs: claim.evidence_refs.slice().sort(compareStrings),
  };
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((ref, index) => ref === b[index]);
}

function compareFactLayers(
  before: FactLayer,
  after: FactLayer,
): {
  added: ClaimSnapshot[];
  removed: ClaimSnapshot[];
  changed: ClaimChange[];
  allocationChanges: AllocationChange[];
  recordBasisChanged: boolean;
} {
  const beforeClaims = new Map(before.claims.map((claim) => [claim.claim_id, claim]));
  const afterClaims = new Map(after.claims.map((claim) => [claim.claim_id, claim]));

  const added: ClaimSnapshot[] = [];
  const removed: ClaimSnapshot[] = [];
  const changed: ClaimChange[] = [];

  for (const [claimId, claim] of beforeClaims) {
    const next = afterClaims.get(claimId);
    if (next === undefined) {
      removed.push(toSnapshot(claim));
      continue;
    }
    const one = toSnapshot(claim);
    const two = toSnapshot(next);
    const differences: string[] = [];
    if (one.tier !== two.tier) differences.push("tier");
    if (one.confidence !== two.confidence) differences.push("confidence");
    if (!sameRefs(one.evidenceRefs, two.evidenceRefs)) differences.push("citations");
    if (one.statement !== two.statement) differences.push("statement");
    if (differences.length > 0) {
      changed.push({
        claimId,
        before: one,
        after: two,
        changed: differences,
        statementDiff: diffLines(one.statement, two.statement),
      });
    }
  }

  for (const [claimId, claim] of afterClaims) {
    if (!beforeClaims.has(claimId)) added.push(toSnapshot(claim));
  }

  const parties = [
    ...new Set([
      ...before.findings.responsibility.map((item) => item.party),
      ...after.findings.responsibility.map((item) => item.party),
    ]),
  ].sort(compareStrings);

  const allocationChanges: AllocationChange[] = [];
  for (const party of parties) {
    const one =
      before.findings.responsibility.find((item) => item.party === party)
        ?.allocation ?? null;
    const two =
      after.findings.responsibility.find((item) => item.party === party)
        ?.allocation ?? null;
    if (one !== two) allocationChanges.push({ party, before: one, after: two });
  }

  const recordBasisChanged =
    JSON.stringify(before.findings.record_basis.citable_utterances) !==
      JSON.stringify(after.findings.record_basis.citable_utterances) ||
    before.findings.record_basis.client_pseudonym !==
      after.findings.record_basis.client_pseudonym;

  return { added, removed, changed, allocationChanges, recordBasisChanged };
}

function compareSurfaceLayers(
  before: SurfaceLayer | null,
  after: SurfaceLayer | null,
): { added: string[]; removed: string[]; changed: SectionChange[] } {
  const beforeSections = new Map<string, JudgmentSection>(
    (before?.sections ?? []).map((section) => [section.section_id, section]),
  );
  const afterSections = new Map<string, JudgmentSection>(
    (after?.sections ?? []).map((section) => [section.section_id, section]),
  );

  const added: string[] = [];
  const removed: string[] = [];
  const changed: SectionChange[] = [];

  for (const [sectionId, section] of beforeSections) {
    const next = afterSections.get(sectionId);
    if (next === undefined) {
      removed.push(sectionId);
      continue;
    }
    const diff = diffLines(
      `${section.heading}\n${section.text}`,
      `${next.heading}\n${next.text}`,
    );
    const audienceChanged = section.audience !== next.audience;
    const kindChanged = section.kind !== next.kind;
    if (hasChanges(diff) || audienceChanged || kindChanged) {
      changed.push({
        sectionId,
        heading: next.heading,
        audienceChanged,
        kindChanged,
        diff,
      });
    }
  }

  for (const sectionId of afterSections.keys()) {
    if (!beforeSections.has(sectionId)) added.push(sectionId);
  }

  return { added, removed, changed };
}

/** Compare two judgment records. Order is (older, newer); nothing is mutated. */
export function compareJudgmentRecords(
  before: JudgmentRecord,
  after: JudgmentRecord,
): VersionComparison {
  const facts = compareFactLayers(before.factLayer, after.factLayer);
  const surface = compareSurfaceLayers(before.surfaceLayer, after.surfaceLayer);

  const modelChanged = before.model !== after.model;
  const fallbackChanged = before.fallbackUsed !== after.fallbackUsed;
  const levelChanged = before.outputLevel !== after.outputLevel;

  const identical =
    facts.added.length === 0 &&
    facts.removed.length === 0 &&
    facts.changed.length === 0 &&
    facts.allocationChanges.length === 0 &&
    !facts.recordBasisChanged &&
    surface.added.length === 0 &&
    surface.removed.length === 0 &&
    surface.changed.length === 0;

  const comparison: Omit<VersionComparison, "disclosure"> = {
    caseId: after.caseId,
    before: toSide(before),
    after: toSide(after),
    claimsAdded: facts.added,
    claimsRemoved: facts.removed,
    claimsChanged: facts.changed,
    sectionsAdded: surface.added,
    sectionsRemoved: surface.removed,
    sectionsChanged: surface.changed,
    allocationChanges: facts.allocationChanges,
    recordBasisChanged: facts.recordBasisChanged,
    levelChanged,
    modelChanged,
    fallbackChanged,
    identical,
  };

  return { ...comparison, disclosure: writeDisclosure(comparison) };
}

/**
 * Compare two versions of a case's judgment.
 *
 * Defaults to the two newest, which is what a user who just re-heard their case
 * is asking about. Returns null when the chain is too short to compare — one
 * version has nothing to disclose against.
 */
export function compareJudgmentVersions(
  db: Db,
  caseId: string,
  range: { readonly fromVersion?: number; readonly toVersion?: number } = {},
): VersionComparison | null {
  const chain = readJudgmentChain(db, caseId);
  if (chain.length < 2) return null;

  const after =
    range.toVersion === undefined
      ? chain[chain.length - 1]
      : chain.find((record) => record.version === range.toVersion);
  const before =
    range.fromVersion === undefined
      ? chain[chain.indexOf(after ?? chain[chain.length - 1]) - 1]
      : chain.find((record) => record.version === range.fromVersion);

  if (before === undefined || after === undefined || before.version >= after.version) {
    return null;
  }
  return compareJudgmentRecords(before, after);
}

/** Every version of a case's judgment, oldest first, as the view shows them. */
export function listVersionSides(db: Db, caseId: string): VersionSide[] {
  return readJudgmentChain(db, caseId).map(toSide);
}

/* -------------------------------------------------------------------------- */
/* Disclosure                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The paragraph HARD RULE #6 asks for: what changed, and who produced it.
 *
 * It names the fallback explicitly when one served, because "claude-fable-5 said
 * so" and "the fallback model said so after fable was unavailable" are different
 * provenances and only one of them is what the user was told they were getting.
 */
function writeDisclosure(
  comparison: Omit<VersionComparison, "disclosure">,
): string {
  const { before, after } = comparison;
  const parts: string[] = [
    `Version ${after.version} replaced version ${before.version}. Version ` +
      `${before.version} has not been altered — it is kept exactly as it was ` +
      `issued.`,
  ];

  parts.push(
    comparison.modelChanged
      ? `Version ${before.version} was produced by ${before.model}; version ` +
        `${after.version} by ${after.model}.`
      : `Both versions were produced by ${after.model}.`,
  );

  // Before the `identical` short-circuit, and before the list of what changed:
  // the level is the frame, not an item inside it. Two versions whose prose
  // matched word for word would still be different documents if one of them was
  // allowed to allocate responsibility and the other was not.
  if (comparison.levelChanged) {
    parts.push(
      `The output level moved: version ${before.version} was issued at ` +
        `${before.outputLevel} and version ${after.version} at ` +
        `${after.outputLevel}. The level is derived from the record and locked ` +
        `before a hearing runs, and it decides what a judgment may say at all — ` +
        `so this is a change in what was permitted, not only in what was ` +
        `written. Version ${before.version} keeps the level it was issued at.`,
    );
  }

  if (after.fallbackUsed || before.fallbackUsed) {
    const which = [
      before.fallbackUsed ? `version ${before.version}` : null,
      after.fallbackUsed ? `version ${after.version}` : null,
    ].filter((value): value is string => value !== null);
    parts.push(
      `The server-side fallback model served ${which.join(" and ")}: the ` +
        `request was routed away from the model that was asked for, and the ` +
        `text was written by a different one.`,
    );
  }

  if (comparison.identical) {
    parts.push(
      `Nothing in the skeleton or the narrative differs between the two ` +
        `versions.`,
    );
    return parts.join(" ");
  }

  const changes: string[] = [];
  if (comparison.claimsAdded.length > 0) {
    changes.push(`${comparison.claimsAdded.length} claim(s) added`);
  }
  if (comparison.claimsRemoved.length > 0) {
    changes.push(`${comparison.claimsRemoved.length} claim(s) removed`);
  }
  if (comparison.claimsChanged.length > 0) {
    changes.push(`${comparison.claimsChanged.length} claim(s) changed`);
  }
  if (comparison.allocationChanges.length > 0) {
    changes.push(
      `responsibility changed for ${comparison.allocationChanges
        .map((item) => `${item.party} (${item.before ?? "none"} → ${item.after ?? "none"})`)
        .join(", ")}`,
    );
  }
  if (comparison.recordBasisChanged) {
    changes.push(
      `the two versions state a different record basis — what the judgment ` +
        `says it is standing on moved`,
    );
  }
  const sectionCount =
    comparison.sectionsAdded.length +
    comparison.sectionsRemoved.length +
    comparison.sectionsChanged.length;
  if (sectionCount > 0) {
    changes.push(`${sectionCount} narrative section(s) differ`);
  }

  parts.push(`What changed: ${changes.join("; ")}.`);
  return parts.join(" ");
}

/** The comparison as plain text, for a report or a terminal. */
export function describeVersionComparison(comparison: VersionComparison): string {
  const lines: string[] = [
    `Judgment v${comparison.before.version} → v${comparison.after.version} ` +
      `(case ${comparison.caseId})`,
    "",
    comparison.disclosure,
    "",
    `v${comparison.before.version}: ${comparison.before.model}` +
      `${comparison.before.effort === null ? "" : ` @ ${comparison.before.effort}`}` +
      `, fallback_used=${comparison.before.fallbackUsed}, ` +
      `status=${comparison.before.status}`,
    `v${comparison.after.version}: ${comparison.after.model}` +
      `${comparison.after.effort === null ? "" : ` @ ${comparison.after.effort}`}` +
      `, fallback_used=${comparison.after.fallbackUsed}, ` +
      `status=${comparison.after.status}`,
  ];

  for (const change of comparison.claimsChanged) {
    lines.push(
      "",
      `claim ${change.claimId} — ${change.changed.join(", ")}`,
      `  - ${change.before.tier} ${change.before.confidence} [${change.before.evidenceRefs.join(", ")}]`,
      `  + ${change.after.tier} ${change.after.confidence} [${change.after.evidenceRefs.join(", ")}]`,
    );
  }

  for (const section of comparison.sectionsChanged) {
    lines.push("", `section ${section.sectionId} — ${section.heading}`);
    for (const line of section.diff) {
      if (line.op === "same") continue;
      lines.push(`  ${line.op === "added" ? "+" : "-"} ${line.text}`);
    }
  }

  return lines.join("\n");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
