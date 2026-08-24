/**
 * The appeal channel — SPEC M4 ⑤.
 *
 * A judgment is frozen (HARD RULE #6). The product's answer to "you got this
 * wrong" is therefore not an edit and not a note appended underneath: it is a
 * **re-hearing**, which produces version `n + 1` through the existing chain,
 * records what it replaced, and discloses the difference. That last part is not
 * a feature next to the appeal — it is the condition on which re-hearing is
 * allowed at all.
 *
 * ## Two acts, deliberately separate
 *
 * `fileAppeal` records that a version was appealed and why, in the appellant's
 * own words. `hearAppeal` runs the hearing. They are separate because they fail
 * differently and because only the first one is scarce:
 *
 *   - **One appeal per judgment version, per actor** (01-pipeline-design.md; the
 *     anti-judgment-shopping rule, as SPEC M5 ⑤ narrows it). A second filing by
 *     the same actor against the same version is refused here, in the service
 *     layer, with a sentence a person can read — and backed by a unique index, so
 *     the refusal is a property of the database rather than of whichever caller
 *     remembered to check. It is not in a prompt, because a model that is asked
 *     to decline a second appeal is a model that can be talked out of declining
 *     it.
 *
 * ## Whose appeal it is (SPEC M5 ⑤)
 *
 * Until M5 an appeal had no actor, because only one person could reach the
 * product. M4's shareable copy already told the other party she could ask for a
 * re-hearing, which was a promise the code could not keep in two separate ways:
 * she had no way in at all, and the one-per-version rule would have let his
 * filing consume hers.
 *
 * So the rule is per actor. That is not a loosening of the anti-shopping rule —
 * it is what the rule was always for. "One appeal per version" exists so that one
 * person cannot re-roll the dice until they like the answer; applied across two
 * people it says instead that whoever complains first spends the other's only
 * chance to, which is first-come-first-served rather than justice.
 *
 * Standing is being a party to the case. A judgment about a relationship is
 * about both of the people in it — she is named in it, reasoned about in it, and
 * handed a copy of it — so the question "may she appeal this?" is answered by the
 * participant row, not by scanning the document for her pseudonym. (A judgment
 * that happened not to mention her by name would be exactly the one she has most
 * reason to appeal.)
 *   - **A hearing can be re-run.** A transport failure, a refusal, a rejected
 *     generation — none of those produced a version, so none of them consumed the
 *     appeal. The row stays, and `hearAppeal` may be called again. The scarce
 *     thing is the appeal; a network blip is not an answer.
 *
 * So there is no path in this module that writes `rejected` to an appeal. This
 * product does not refuse an appeal on its merits: "your grounds are not good
 * enough to look again" is itself a judgment, made by the machine that is being
 * complained about, and the honest form of disagreeing with an appellant is to
 * hear the case again and say plainly that the record still does not support
 * what they wanted.
 *
 * ## What the re-hearing is given
 *
 * The dossier is **reassembled**, not reused: anything confirmed since the first
 * hearing is simply in it, which is what "plus any newly confirmed material"
 * means in practice — there is no separate intake here, because evidence enters
 * this product exactly one way. The frozen fact layer under appeal is shown so
 * the hearing can see what is being complained about, and the grounds are passed
 * verbatim.
 *
 * None of that loosens a single check. The returned fact layer goes through
 * `checkFactLayer` — citations audited against SQLite for existence and confirmed
 * status (HARD RULE #1), the locked level re-checked (HARD RULE #2), the record
 * basis verified against counts computed from the database, the contract's own
 * coherence — exactly as the first hearing did. The grounds carry no utterance
 * id, so nothing in them can be cited, and that is a structural fact rather than
 * an instruction: an appeal is a reason to look again, never a fact.
 *
 * ## The disclosure
 *
 * `summarizeAppealDiff` reduces the full version comparison to what an appellant
 * is actually asking about — which claims are new, which are gone, which changed
 * tier — alongside the model that served each version and whether the server-side
 * fallback answered instead of the model that was asked for (HARD RULE #7). A
 * version produced by the fallback is a different hearing, and someone deciding
 * whether they believe it is entitled to know that.
 */

import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  appeals,
  caseParticipants,
  judgments,
  type AppealStatus,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta } from "../llm";
import { appealRehearingStage } from "../llm/stages";
import {
  JudgmentBlockedError,
  assertJudgmentAllowed,
} from "../pipeline/adverse-facts";
import { stableStringify, type JsonValue } from "../pipeline/case-file";
import { relockOutputLevel } from "../pipeline/output-level";
import {
  JudgmentContractError,
  JudgmentStoreError,
  createNextVersion,
  finalize,
  readJudgment,
  updateDraft,
  type ClaimTier,
  type FactLayer,
  type JudgmentRecord,
  type SurfaceLayer,
} from "./contract";
import {
  assembleJudgmentDossier,
  serializeJudgmentDossier,
  type JudgmentDossier,
} from "./dossier";
import {
  checkFactLayer,
  checkSurfaceLayer,
  renderLevelTask,
  runChecked,
  runJudgmentNarrative,
  type JudgmentRejection,
} from "./generation";
import {
  compareJudgmentRecords,
  type ClaimSnapshot,
  type VersionComparison,
  type VersionSide,
} from "./versions";

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type AppealErrorCode =
  | "judgment_not_found"
  /** A draft has not been issued, so there is nothing to disagree with yet. */
  | "not_final"
  /** THE rule: this actor has already appealed this version once. */
  | "already_appealed"
  /** A newer version stands; the appeal belongs against that one. */
  | "not_current"
  /** An appeal with no grounds is a request to roll the dice again. */
  | "grounds_missing"
  /** The would-be appellant is not a party to the case being appealed. */
  | "actor_not_on_case"
  | "appeal_not_found";

export class AppealError extends Error {
  readonly code: AppealErrorCode;

  constructor(code: AppealErrorCode, message: string) {
    super(message);
    this.name = "AppealError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

export interface AppealRecord {
  readonly id: string;
  readonly caseId: string;
  /** The frozen version being appealed. Read, never written. */
  readonly originalJudgmentId: string;
  /** The version the re-hearing produced; null until it has. */
  readonly newJudgmentId: string | null;
  /**
   * Who filed it. Null only on rows written before appeals had an actor, which
   * migration 0011 backfills to the case's submitter.
   */
  readonly actorParticipantId: string | null;
  /** The grounds, verbatim, in whatever language the appellant wrote them in. */
  readonly grounds: string;
  readonly status: AppealStatus;
  /** What the record looked like at filing time, and at the re-hearing. */
  readonly record: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type AppealRow = typeof appeals.$inferSelect;

function toRecord(row: AppealRow): AppealRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    originalJudgmentId: row.originalJudgmentId,
    newJudgmentId: row.newJudgmentId,
    actorParticipantId: row.actorParticipantId,
    grounds: row.reason ?? "",
    status: row.status,
    record: row.newEvidence ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Filing                                                                     */
/* -------------------------------------------------------------------------- */

export interface FileAppealInput {
  /**
   * Why the appellant says the judgment is wrong, in their own words.
   *
   * Verbatim: it is the appellant's statement, so it is stored exactly as
   * written, never normalized and never translated (CLAUDE.md). It is also not
   * evidence — see the module header.
   */
  readonly grounds: string;
  /**
   * Who is filing: a `case_participants` id on the case this judgment belongs
   * to (SPEC M5 ⑤).
   *
   * Required, and required as an id rather than a role, because the scarcity
   * rule is per actor and a rule that counts appeals cannot be given "somebody".
   * A caller that does not know who is asking is a caller that must not be able
   * to spend either party's one appeal.
   */
  readonly actorParticipantId: string;
}

/** One appeal, by id. */
export function readAppeal(db: Db, appealId: string): AppealRecord | null {
  const row = db.select().from(appeals).where(eq(appeals.id, appealId)).get();
  return row === undefined ? null : toRecord(row);
}

/**
 * Every appeal filed against one judgment version, oldest first.
 *
 * A list rather than a row since M5 ⑤: two parties may each appeal the same
 * version, and a reader of a version is entitled to see that both did.
 *
 * The id breaks a tie on the timestamp. Two filings inside one millisecond is
 * not hypothetical here — a test does it, and so would both parties clicking
 * during one conversation — and an ORDER BY that ties falls back to whatever
 * order the storage feels like, which for a random text primary key is a
 * different answer on different runs.
 */
export function listAppealsForJudgment(
  db: Db,
  judgmentId: string,
): AppealRecord[] {
  return db
    .select()
    .from(appeals)
    .where(eq(appeals.originalJudgmentId, judgmentId))
    .orderBy(asc(appeals.createdAt), asc(appeals.id))
    .all()
    .map(toRecord);
}

/**
 * The first appeal against one judgment version, if it has been appealed.
 *
 * Kept for callers that only need to know whether a version was appealed at
 * all. It is NOT the guard for the one-per-version rule — that question is per
 * actor, and `readAppealByActor` is the one that answers it.
 */
export function readAppealForJudgment(
  db: Db,
  judgmentId: string,
): AppealRecord | null {
  return listAppealsForJudgment(db, judgmentId)[0] ?? null;
}

/** One actor's appeal against one version — the scarce thing, by owner. */
export function readAppealByActor(
  db: Db,
  judgmentId: string,
  actorParticipantId: string,
): AppealRecord | null {
  const row = db
    .select()
    .from(appeals)
    .where(
      and(
        eq(appeals.originalJudgmentId, judgmentId),
        eq(appeals.actorParticipantId, actorParticipantId),
      ),
    )
    .get();
  return row === undefined ? null : toRecord(row);
}

/** Every appeal on a case, oldest first. */
export function listAppeals(db: Db, caseId: string): AppealRecord[] {
  return db
    .select()
    .from(appeals)
    .where(eq(appeals.caseId, caseId))
    .orderBy(asc(appeals.createdAt))
    .all()
    .map(toRecord);
}

/** The appellant, as everything downstream of the filing needs to see them. */
export interface AppealParty {
  readonly id: string;
  /** Egress token (甲 / 乙). The real name never leaves the process (HARD RULE #3). */
  readonly pseudonym: string;
  /** True for the party who brought the case. */
  readonly isSubmitter: boolean;
}

/**
 * One party of one case, or null.
 *
 * Scoped to the case in the WHERE clause rather than checked afterwards: a
 * participant id from another case must read as "not a party here", not as a
 * row that was found and then judged.
 */
export function readAppealParty(
  db: Db,
  caseId: string,
  participantId: string,
): AppealParty | null {
  return (
    db
      .select({
        id: caseParticipants.id,
        pseudonym: caseParticipants.pseudonym,
        isSubmitter: caseParticipants.isSubmitter,
      })
      .from(caseParticipants)
      .where(
        and(
          eq(caseParticipants.id, participantId),
          eq(caseParticipants.caseId, caseId),
        ),
      )
      .get() ?? null
  );
}

/** The same read, as a precondition: nobody outside the case may file. */
function requireParty(
  db: Db,
  caseId: string,
  participantId: string,
): AppealParty {
  const row = readAppealParty(db, caseId, participantId);

  if (row === null) {
    throw new AppealError(
      "actor_not_on_case",
      `Participant ${participantId} is not a party to case ${caseId}, so they ` +
        `have nothing to appeal. An appeal is filed by one of the two people ` +
        `this judgment is about.`,
    );
  }
  return row;
}

/**
 * File an appeal against a frozen judgment, on behalf of one party.
 *
 * Five refusals, and the fourth is the rule this function exists for:
 *
 *   1. the judgment must exist;
 *   2. it must be `final` — a draft has not been issued, so there is nothing to
 *      disagree with;
 *   3. the appellant must be a party to the case — standing, not authorship: she
 *      did not write this judgment and it is still about her;
 *   4. that party must not already have appealed this version
 *      (`already_appealed`), which the unique index enforces underneath;
 *   5. it must be the version that stands — appealing a superseded version is
 *      appealing a document that has already been replaced, and the chain is a
 *      line rather than a tree.
 *
 * Nothing is generated here. Filing is the act of saying "this is wrong and here
 * is why"; the hearing is `hearAppeal`, and it may be run more than once against
 * one filing if the machinery fails on the way.
 */
export function fileAppeal(
  db: Db,
  judgmentId: string,
  input: FileAppealInput,
): AppealRecord {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new AppealError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  if (judgment.status === "draft") {
    throw new AppealError(
      "not_final",
      `Judgment ${judgmentId} is still a draft. Nothing has been issued, so ` +
        `there is nothing to appeal against yet.`,
    );
  }

  // Standing before content: who is asking is the question the rest of this
  // function is scoped by, and a stranger's grounds are not a better or worse
  // appeal, they are not an appeal.
  const actor = requireParty(db, judgment.caseId, input.actorParticipantId);

  const grounds = input.grounds.trim();
  if (grounds.length === 0) {
    throw new AppealError(
      "grounds_missing",
      `An appeal states what the judgment got wrong. Without grounds this is a ` +
        `request to run the hearing again and see if the answer changes, which ` +
        `is the thing one appeal per version exists to prevent.`,
    );
  }

  const existing = readAppealByActor(db, judgmentId, actor.id);
  if (existing !== null) {
    throw new AppealError(
      "already_appealed",
      `${actor.pseudonym} has already appealed judgment ${judgmentId} ` +
        `(version ${judgment.version}) — appeal ${existing.id}, status ` +
        `${existing.status}. One appeal per version per party: a hearing you ` +
        `may re-run until you like the answer is not a hearing.` +
        (existing.newJudgmentId === null
          ? ` That appeal has not produced a version yet — hear it again ` +
            `rather than filing a second one.`
          : ` It produced version ${existing.newJudgmentId}; appeal that one if ` +
            `it is still wrong.`),
    );
  }

  const successor = db
    .select({ id: judgments.id, version: judgments.version })
    .from(judgments)
    .where(eq(judgments.supersedesJudgmentId, judgmentId))
    .get();
  if (successor !== undefined) {
    throw new AppealError(
      "not_current",
      `Judgment ${judgmentId} (version ${judgment.version}) was already ` +
        `replaced by version ${successor.version} (${successor.id}). An appeal ` +
        `is heard against the judgment that stands.`,
    );
  }

  const [row] = db
    .insert(appeals)
    .values({
      caseId: judgment.caseId,
      originalJudgmentId: judgmentId,
      actorParticipantId: actor.id,
      reason: grounds,
      status: "submitted",
      newEvidence: {
        // What the record held when the appeal was filed. Compared against the
        // same count at the re-hearing, this is how "newly confirmed material"
        // becomes a number instead of an impression.
        citable_at_original:
          judgment.factLayer.findings.record_basis.citable_utterances.total,
      },
    })
    .returning()
    .all();

  return toRecord(row);
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/** The task turn appended after the dossier, the old skeleton and the grounds. */
const REHEARING_TASK =
  "Hear this case again and produce the fact layer for the new version: the " +
  "claims it will rest on, and the case-level findings. Ground every claim " +
  'that is not tier "unknown" in at least one utterance id from the EVIDENCE ' +
  "block above, restate the record-basis counts exactly as given, and stay " +
  "inside the output-level constraints — the server re-checks all three and " +
  "rejects the whole re-hearing on any of them. Nothing in the grounds of " +
  "appeal is citable: it carries no utterance id and confirms nothing.";

/** How the grounds block is labelled, given who wrote it. */
function groundsHeading(
  appellant: { readonly pseudonym: string; readonly isSubmitter: boolean } | null,
): string {
  if (appellant === null) {
    // A legacy row, filed before appeals carried an actor. Saying "the client"
    // would be a guess dressed as a fact, in the one place a hearing decides how
    // much weight to give a paragraph.
    return "## Grounds of appeal (the appellant's own words, verbatim)";
  }
  return appellant.isSubmitter
    ? `## Grounds of appeal (${appellant.pseudonym}, who brought this case — ` +
        `their own words, verbatim)`
    : `## Grounds of appeal (${appellant.pseudonym}, the party this case is ` +
        `about, who did not bring it — their own words, verbatim)`;
}

/**
 * The prompt for a re-hearing: the record now, the judgment under appeal, and
 * what the appellant says is wrong with it.
 *
 * Byte-stable in the same way the other judgment prompts are — the dossier is
 * assembled without timestamps and `stableStringify` sorts every key — so the
 * only part that differs between two re-hearings of one case is the part that
 * actually differs.
 *
 * The grounds go in last and are wrapped in a heading that says what they are
 * **and whose they are** (SPEC M5 ⑤). A block of prose dropped into a hearing
 * without that label is an instruction the model has no way to weigh — and since
 * M5 the appellant may be either party, so a heading that says "the client" when
 * the counterparty filed would misattribute the one paragraph in the prompt that
 * is somebody's position rather than the record.
 */
export function renderAppealPrompt(
  dossier: JudgmentDossier,
  input: {
    readonly grounds: string;
    readonly previousVersion: number;
    readonly previousFactLayer: FactLayer;
    /** Who filed it, by pseudonym (HARD RULE #3). Null for a pre-M5 row. */
    readonly appellant: {
      readonly pseudonym: string;
      readonly isSubmitter: boolean;
    } | null;
  },
): string {
  return (
    `${serializeJudgmentDossier(dossier)}\n\n` +
    `## The judgment under appeal (version ${input.previousVersion} — frozen)\n` +
    `This is what was issued and what the appellant is disagreeing with. It is ` +
    `not evidence, it is not a draft to edit, and a claim in it is not ` +
    `established by having been written down. Produce a complete fact layer of ` +
    `your own.\n` +
    // Plain JSON by construction — it round-trips through a JSON column — so the
    // cast asserts nothing the schema does not already guarantee.
    `${stableStringify(input.previousFactLayer as unknown as JsonValue)}\n\n` +
    `${groundsHeading(input.appellant)}\n` +
    `An assertion by an interested party. It confirms nothing and cannot be ` +
    `cited. It tells you where to look again.\n` +
    `${input.grounds}\n\n` +
    `${REHEARING_TASK}\n\n` +
    // The same block the first hearing was given, from the same table, because
    // a re-hearing is a hearing: the level may have moved between the two (a
    // case that reached L1 after the other party joined is the case M5 ⑥ is
    // about), and what the level licenses has to arrive as an instruction
    // rather than be inferred from a document written under the old one.
    `${renderLevelTask(dossier.outputLevel)}`
  );
}

/* -------------------------------------------------------------------------- */
/* The hearing                                                                */
/* -------------------------------------------------------------------------- */

/** What the record held then, and what it holds now. */
export interface AppealMaterial {
  /** Citable utterances the appealed version stated it was standing on. */
  readonly citableAtOriginal: number;
  /** Citable utterances now, counted from the database at the re-hearing. */
  readonly citableNow: number;
  /**
   * How much the record grew between the two. Zero is a real and common
   * answer — an appeal is allowed to be about the reading rather than the
   * evidence — and a negative delta (a line un-confirmed since) is reported as
   * the negative number it is rather than clamped to zero.
   */
  readonly newlyCitable: number;
}

/** The diff an appellant is actually asking about. */
export interface RetierChange {
  readonly claimId: string;
  readonly statement: string;
  readonly before: ClaimTier;
  readonly after: ClaimTier;
}

export interface AppealDiff {
  readonly before: VersionSide;
  readonly after: VersionSide;
  readonly claimsAdded: readonly ClaimSnapshot[];
  readonly claimsRemoved: readonly ClaimSnapshot[];
  /** Claims that survived but changed tier — the appeal's usual currency. */
  readonly claimsRetiered: readonly RetierChange[];
  /** Claims that changed in some other way (confidence, citations, wording). */
  readonly claimsOtherwiseChanged: readonly {
    readonly claimId: string;
    readonly changed: readonly string[];
  }[];
  /** Whose responsibility allocation moved, if the level allows any. */
  readonly allocationChanges: VersionComparison["allocationChanges"];
  /** True when the re-hearing reached exactly the same skeleton and prose. */
  readonly identical: boolean;
  /** The paragraph HARD RULE #6 asks for, from the version comparison. */
  readonly disclosure: string;
}

/**
 * Reduce a full version comparison to the appeal-shaped view.
 *
 * Nothing is computed here that `compareJudgmentVersions` does not already
 * compute — this picks out claims added, claims removed and claims retiered, and
 * carries both versions' serving model and `fallbackUsed` through untouched, so
 * a caller rendering an appeal result does not have to know which fields of the
 * comparison matter.
 */
export function summarizeAppealDiff(
  comparison: VersionComparison,
): AppealDiff {
  const retiered: RetierChange[] = [];
  const otherwise: { claimId: string; changed: readonly string[] }[] = [];

  for (const change of comparison.claimsChanged) {
    if (change.changed.includes("tier")) {
      retiered.push({
        claimId: change.claimId,
        statement: change.after.statement,
        before: change.before.tier,
        after: change.after.tier,
      });
    }
    const rest = change.changed.filter((what) => what !== "tier");
    if (rest.length > 0) otherwise.push({ claimId: change.claimId, changed: rest });
  }

  return {
    before: comparison.before,
    after: comparison.after,
    claimsAdded: comparison.claimsAdded,
    claimsRemoved: comparison.claimsRemoved,
    claimsRetiered: retiered,
    claimsOtherwiseChanged: otherwise,
    allocationChanges: comparison.allocationChanges,
    identical: comparison.identical,
    disclosure: comparison.disclosure,
  };
}

export interface AppealHearingOptions {
  readonly llm?: RunStageOptions;
  /** Skip the adverse-fact gate. Tests only; never in a server path. */
  readonly skipGate?: boolean;
}

export type AppealOutcome =
  | {
      readonly kind: "reheard";
      readonly appeal: AppealRecord;
      /** Version n + 1, frozen. The predecessor is untouched. */
      readonly judgment: JudgmentRecord;
      readonly comparison: VersionComparison;
      readonly diff: AppealDiff;
      readonly material: AppealMaterial;
      readonly attempts: {
        readonly rehearing: number;
        readonly narrative: number;
      };
    }
  /** A server-side check refused the generation twice. Nothing was frozen. */
  | {
      readonly kind: "rejected";
      readonly step: "rehearing" | "narrative";
      readonly rejection: JudgmentRejection;
      /** The version-n+1 draft that was written and never published, if any. */
      readonly draftId: string | null;
    }
  | { readonly kind: "refused"; readonly category?: string }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string }
  /** A precondition failed: no such appeal, already heard, gate closed. */
  | { readonly kind: "blocked"; readonly message: string };

/** Move an appeal's status without touching anything else on the row. */
function setStatus(
  db: Db,
  appealId: string,
  status: AppealStatus,
): AppealRecord | null {
  const [row] = db
    .update(appeals)
    .set({ status })
    .where(eq(appeals.id, appealId))
    .returning()
    .all();
  return row === undefined ? null : toRecord(row);
}

/**
 * Hear a filed appeal: re-run the case at effort `max` and issue version n + 1.
 *
 * Never throws for an expected outcome, for the same reason `generateJudgment`
 * does not — a closed gate, a refusal, a rejected generation and a transport
 * failure are all things a caller has to branch on.
 *
 * The predecessor is never written to. `createNextVersion` inserts the successor
 * pointing back at it, and the whole disclosure duty (HARD RULE #6) is satisfied
 * by the comparison returned here rather than by anything stored on the frozen
 * row.
 */
export async function hearAppeal(
  db: Db,
  appealId: string,
  options: AppealHearingOptions = {},
): Promise<AppealOutcome> {
  const appeal = readAppeal(db, appealId);
  if (appeal === null) {
    return { kind: "blocked", message: `No appeal with id ${appealId}.` };
  }
  if (appeal.newJudgmentId !== null) {
    return {
      kind: "blocked",
      message:
        `Appeal ${appealId} was already heard and produced judgment ` +
        `${appeal.newJudgmentId}. A hearing is not run twice against one ` +
        `filing; appeal the version it produced if that one is wrong too.`,
    };
  }

  const previous = readJudgment(db, appeal.originalJudgmentId);
  if (previous === null) {
    return {
      kind: "blocked",
      message: `Appeal ${appealId} points at judgment ${appeal.originalJudgmentId}, which no longer exists.`,
    };
  }
  if (previous.status === "draft") {
    return {
      kind: "blocked",
      message:
        `Judgment ${previous.id} is a draft. An appeal is heard against a ` +
        `judgment that was issued.`,
    };
  }

  const caseId = previous.caseId;

  if (options.skipGate !== true) {
    try {
      assertJudgmentAllowed(db, caseId);
    } catch (error) {
      if (!(error instanceof JudgmentBlockedError)) throw error;
      return { kind: "blocked", message: error.message };
    }
  }

  // The frame the SUCCESSOR is written inside, re-derived now (SPEC M5 ⑥).
  //
  // A re-hearing is the only act that may move a locked level, and it is exactly
  // the act the lock exists to force: nothing about v1 changes — it keeps the
  // level it was issued at on its own row and stays byte-identical — while v2 is
  // written inside whatever the record supports today. Without this the L1
  // upgrade could be derived and never reached: both parties put material in,
  // `deriveOutputLevel` returns L1, and every re-hearing would still be
  // assembled at the level locked before she arrived. The move is disclosed by
  // the version comparison, which reads both levels off the two rows.
  relockOutputLevel(db, caseId);

  let dossier: JudgmentDossier;
  try {
    dossier = assembleJudgmentDossier(db, caseId);
  } catch (error) {
    return {
      kind: "blocked",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (dossier.asymmetry.citableUtterances.total === 0) {
    return {
      kind: "blocked",
      message:
        `Nothing in case ${caseId} is confirmed any more, so there is nothing ` +
        `a re-hearing could be grounded in. The appealed version stands.`,
    };
  }

  const material: AppealMaterial = {
    citableAtOriginal:
      previous.factLayer.findings.record_basis.citable_utterances.total,
    citableNow: dossier.asymmetry.citableUtterances.total,
    newlyCitable:
      dossier.asymmetry.citableUtterances.total -
      previous.factLayer.findings.record_basis.citable_utterances.total,
  };

  // Visible from outside the process: if the machine dies mid-hearing, the row
  // says a hearing was in flight rather than silently reading as never started.
  setStatus(db, appealId, "under_review");
  const settle = (outcome: AppealOutcome): AppealOutcome => {
    setStatus(db, appealId, "submitted");
    return outcome;
  };

  const basePrompt = renderAppealPrompt(dossier, {
    grounds: appeal.grounds,
    previousVersion: previous.version,
    previousFactLayer: previous.factLayer,
    appellant:
      appeal.actorParticipantId === null
        ? null
        : readAppealParty(db, caseId, appeal.actorParticipantId),
  });
  const dict = buildCaseDict(db, caseId);

  const rehearing = await runChecked<FactLayer>(
    basePrompt,
    (prompt) =>
      runStage(
        appealRehearingStage,
        { prompt, dict, caseId },
        { db, ...options.llm },
      ),
    (data) => checkFactLayer(db, caseId, dossier.outputLevel, dossier, data),
  );

  if (rehearing.kind === "refused") {
    return settle(
      rehearing.category === undefined
        ? { kind: "refused" }
        : { kind: "refused", category: rehearing.category },
    );
  }
  if (rehearing.kind === "error") {
    return settle({
      kind: "error",
      retryable: rehearing.retryable,
      message: rehearing.message,
    });
  }
  /* c8 ignore next 3 -- `no_material` is only produced by the skeleton runner. */
  if (rehearing.kind === "no_material") {
    return settle({ kind: "blocked", message: rehearing.message });
  }
  if (rehearing.kind === "rejected") {
    return settle({
      kind: "rejected",
      step: "rehearing",
      rejection: rehearing.rejection,
      draftId: null,
    });
  }

  const factLayer = rehearing.data;
  const meta: StageMeta = rehearing.meta;

  // Version n + 1, as a draft, pointing back at what it replaces. The frozen
  // predecessor is read for this and never written.
  //
  // A draft successor may already exist: a previous hearing of this same appeal
  // that got its skeleton written and then lost the narrative call. The chain
  // does not fork (`createNextVersion` refuses a predecessor that already has a
  // successor), so continuing that draft is the only way a re-hearing stays
  // re-runnable — otherwise a dropped connection at exactly the wrong moment
  // would leave the appeal permanently unhearable, which is the thing this
  // module is built not to do.
  const openSuccessor = db
    .select({ id: judgments.id, status: judgments.status, version: judgments.version })
    .from(judgments)
    .where(eq(judgments.supersedesJudgmentId, previous.id))
    .get();

  if (openSuccessor !== undefined && openSuccessor.status !== "draft") {
    return settle({
      kind: "blocked",
      message:
        `Judgment ${previous.id} has already been replaced by version ` +
        `${openSuccessor.version} (${openSuccessor.id}), which this appeal did ` +
        `not record. Nothing more is re-heard against a version that no longer ` +
        `stands; appeal ${openSuccessor.id} if it is wrong.`,
    });
  }

  let draft: JudgmentRecord;
  try {
    draft =
      openSuccessor === undefined
        ? createNextVersion(db, {
            predecessorId: previous.id,
            model: meta.model,
            effort: appealRehearingStage.effort,
            promptVersion: appealRehearingStage.promptVersion,
            fallbackUsed: meta.fallbackUsed,
            factLayer,
          })
        : updateDraft(db, openSuccessor.id, {
            factLayer,
            // The narrative belongs to the skeleton it was written from; a new
            // skeleton starts without one rather than inheriting the old one.
            surfaceLayer: null,
            model: meta.model,
            effort: appealRehearingStage.effort,
            promptVersion: appealRehearingStage.promptVersion,
            fallbackUsed: meta.fallbackUsed,
          });
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      return settle({ kind: "error", retryable: false, message: error.message });
    }
    throw error;
  }

  // The prose, from the new skeleton alone — the same stage the first hearing's
  // narrative came from, because writing up a decided set of facts is the same
  // job whether or not the facts were decided twice.
  const narrative = await runJudgmentNarrative(
    db,
    caseId,
    dossier.outputLevel,
    factLayer,
    { llm: options.llm },
  );

  if (narrative.kind === "refused") {
    return settle(
      narrative.category === undefined
        ? { kind: "refused" }
        : { kind: "refused", category: narrative.category },
    );
  }
  if (narrative.kind === "error") {
    return settle({
      kind: "error",
      retryable: narrative.retryable,
      message: narrative.message,
    });
  }
  /* c8 ignore next 3 -- unreachable from the narrative step. */
  if (narrative.kind === "no_material") {
    return settle({ kind: "blocked", message: narrative.message });
  }
  if (narrative.kind === "rejected") {
    return settle({
      kind: "rejected",
      step: "narrative",
      rejection: narrative.rejection,
      draftId: draft.id,
    });
  }

  const surfaceLayer: SurfaceLayer = narrative.data;

  try {
    draft = updateDraft(db, draft.id, {
      surfaceLayer,
      fallbackUsed: meta.fallbackUsed || narrative.meta.fallbackUsed,
    });
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      return settle({ kind: "error", retryable: false, message: error.message });
    }
    throw error;
  }

  // Re-check against the record as it stands now, not as it stood when the
  // hearing started: two model calls happened in between, and the citation that
  // authorizes publication has to be the one that holds at publication.
  const fresh = assembleJudgmentDossier(db, caseId);
  const factFault = checkFactLayer(
    db,
    caseId,
    fresh.outputLevel,
    fresh,
    draft.factLayer,
  );
  if (factFault !== null) {
    return settle({
      kind: "rejected",
      step: "rehearing",
      rejection: factFault,
      draftId: draft.id,
    });
  }
  /* c8 ignore next 9 -- `updateDraft` already asserted the same contract. */
  const surfaceFault = checkSurfaceLayer(
    draft.factLayer,
    draft.surfaceLayer ?? surfaceLayer,
  );
  if (surfaceFault !== null) {
    return settle({
      kind: "rejected",
      step: "narrative",
      rejection: surfaceFault,
      draftId: draft.id,
    });
  }

  let published: JudgmentRecord;
  try {
    published = finalize(db, draft.id);
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      return settle({ kind: "error", retryable: false, message: error.message });
    }
    throw error;
  }

  const [resolved] = db
    .update(appeals)
    .set({
      status: "resolved",
      newJudgmentId: published.id,
      newEvidence: {
        citable_at_original: material.citableAtOriginal,
        citable_at_rehearing: material.citableNow,
        newly_citable: material.newlyCitable,
      },
    })
    .where(and(eq(appeals.id, appealId), eq(appeals.status, "under_review")))
    .returning()
    .all();

  const comparison = compareJudgmentRecords(previous, published);

  return {
    kind: "reheard",
    appeal: resolved === undefined ? appeal : toRecord(resolved),
    judgment: published,
    comparison,
    diff: summarizeAppealDiff(comparison),
    material,
    attempts: {
      rehearing: rehearing.attempts,
      narrative: narrative.attempts,
    },
  };
}

/**
 * File an appeal and hear it — the whole act, for a caller with grounds in hand.
 *
 * The filing guard runs first, so a second appeal by the same party against the
 * same version is refused before a single token is spent. That ordering is the
 * anti-shopping rule doing its actual job: the expensive thing about judgment
 * shopping is not the second document, it is that asking again was available at
 * all.
 */
export async function appealJudgment(
  db: Db,
  judgmentId: string,
  input: FileAppealInput,
  options: AppealHearingOptions = {},
): Promise<AppealOutcome & { readonly appealId: string }> {
  const appeal = fileAppeal(db, judgmentId, input);
  const outcome = await hearAppeal(db, appeal.id, options);
  return { ...outcome, appealId: appeal.id };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/** The appeal result as plain text, for a report or a terminal. */
export function describeAppealDiff(diff: AppealDiff): string {
  const lines: string[] = [
    `Appeal: v${diff.before.version} → v${diff.after.version}`,
    "",
    diff.disclosure,
    "",
    `v${diff.before.version}: ${diff.before.model}` +
      `${diff.before.effort === null ? "" : ` @ ${diff.before.effort}`}` +
      `, fallback_used=${diff.before.fallbackUsed}`,
    `v${diff.after.version}: ${diff.after.model}` +
      `${diff.after.effort === null ? "" : ` @ ${diff.after.effort}`}` +
      `, fallback_used=${diff.after.fallbackUsed}`,
  ];

  if (diff.identical) {
    lines.push("", "The re-hearing reached the same skeleton and the same prose.");
    return lines.join("\n");
  }

  for (const claim of diff.claimsAdded) {
    lines.push("", `+ claim ${claim.claimId} (${claim.tier}) ${claim.statement}`);
  }
  for (const claim of diff.claimsRemoved) {
    lines.push("", `- claim ${claim.claimId} (${claim.tier}) ${claim.statement}`);
  }
  for (const claim of diff.claimsRetiered) {
    lines.push(
      "",
      `~ claim ${claim.claimId}: ${claim.before} → ${claim.after}`,
      `  ${claim.statement}`,
    );
  }
  for (const claim of diff.claimsOtherwiseChanged) {
    lines.push("", `~ claim ${claim.claimId}: ${claim.changed.join(", ")}`);
  }
  for (const change of diff.allocationChanges) {
    lines.push(
      "",
      `~ responsibility ${change.party}: ${change.before ?? "none"} → ${change.after ?? "none"}`,
    );
  }

  return lines.join("\n");
}
