/**
 * What the client may know while the other party has not answered (doc 05 §A.2).
 *
 * The state this serves is the asymmetric wait: A has filed, a judgment stands
 * at a one-sided level, an invitation exists (or does not yet), and B has done
 * nothing the record can see. Doc 05 calls the product in that state **a
 * standing record with a named unblocking condition** — Matterhorn's remand
 * loop, not a countdown — and this module is the read half of it.
 *
 * ## What this file may not return, and why the omissions are here
 *
 * The refusals in §A.2 are enforced by what this function selects, not by what
 * the screen remembers to leave out. A screen cannot render a number this
 * object does not carry.
 *
 *   - **No progress and no counts of hers.** Not "she is on line 7 of 40", not
 *     a line count, not a byte count. `statementSubmitted` and
 *     `confirmationComplete` are booleans with timestamps, which is the whole
 *     of what a discrete completed act is. Counts are volume signals and volume
 *     must never read as strength; live progress on a rebuttal is surveillance
 *     of the other party's drafting.
 *   - **`respond_state = 'opened'` is read and deliberately discarded.** The
 *     entry route wrote it until the open-tracking write was removed; a row that
 *     still carries it maps to the same answer here as `invited` — nothing to
 *     report. Opening a page is not an act (§A.5), and a reader who suspects the
 *     sender is notified on open cannot read freely, which is the precondition
 *     for her answer meaning anything.
 *   - **No deadline on the merits.** `invite_token_expires_at` is a credential's
 *     lifetime and is returned as exactly that, on the invitation act, never as
 *     a countdown attached to the level or the judgment. A timer next to a
 *     judgment implies the timer decides something; it never does (§A.4).
 *   - **No decline reason.** Her words in `decline_reason` are hers. A decline
 *     is returned as a participation fact with a date — the same register as
 *     any other act — because that is all a later document may say about it
 *     (§A.4), and quoting her into the client's waiting screen would make it
 *     colour.
 *
 * ## Why the copy is not here
 *
 * Every field below is a stored fact, a derived boolean, or the level
 * derivation's own words. The sentences a person reads are in
 * `src/app/case/[id]/wait-labels.ts`, the same split the judgment reading view
 * makes: the level's rationale is rendered verbatim because HARD RULE #2 puts
 * that reasoning in code, and re-wording it on a screen would put a second
 * version of the derivation in the world.
 *
 * Synchronous, takes an explicit `Db`, writes nothing.
 */

import { and, count, eq, isNull, or } from "drizzle-orm";

import { consentFoldFor } from "../access/consent";
import type { Db } from "../db";
import {
  caseParticipants,
  judgments as judgmentsTable,
  utterances as utterancesTable,
  type OutputLevel,
  type ParticipationState,
} from "../db/schema";
import { CITABLE_STATUSES } from "../evidence/workbench";
import { readDoorStanding } from "../participation/door";
import { readClarification } from "../pipeline/clarification";
import { readOutputLevel } from "../pipeline/output-level";
import { readParticipation } from "../pipeline/participation";
import type { OutputLevelFinding, OutputLevelReason } from "../domain/output-level";

/* -------------------------------------------------------------------------- */
/* The parties                                                                */
/* -------------------------------------------------------------------------- */

export interface WaitingParty {
  readonly participantId: string;
  /** The egress token (甲 / 乙). */
  readonly pseudonym: string;
  /** Local-only real name, for the client's own screen. Never egresses. */
  readonly displayName: string | null;
  /** The client's report of what happened when she was asked. */
  readonly participationState: ParticipationState;
  /*
   * `respond_state` is deliberately NOT on this object.
   *
   * It is read inside `buildWaitView` — a `declined` row is how her own refusal
   * is told apart from a report about her — and it is narrowed into the
   * `answered` act before anything leaves. Exposing the column would carry
   * `opened` into the view, where a later component could render it in one line
   * and undo §A.2's second refusal without anybody noticing. A test asserts the
   * serialized view does not contain it.
   */
}

/* -------------------------------------------------------------------------- */
/* The acts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The five slots of §A.2's sequence: created → (nothing) → consented/declined →
 * statement submitted → confirmation complete → re-hearing available.
 *
 * The gap after `invitation_created` has no code because it is not an act. It
 * is rendered as the absence it is, with the reason next to it.
 */
export type WaitActCode =
  | "invitation_created"
  | "answered"
  | "statement_submitted"
  | "confirmation_complete"
  | "rehearing_available";

/** Which answer she gave, when she has given one. */
export type WaitAnswer = "consented" | "declined";

export interface WaitAct {
  readonly code: WaitActCode;
  /** The act is on the record. False means "not yet", never "she is late". */
  readonly recorded: boolean;
  /**
   * When it happened, as stored. Null on an unrecorded act, and null on a
   * recorded one whose moment the schema does not hold — reported as absent
   * rather than filled in with a plausible neighbour.
   */
  readonly at: Date | null;
  /** Only on `answered`: which of the two answers the record holds. */
  readonly answer: WaitAnswer | null;
  /**
   * Only on `invitation_created`: when the live credential dies. A token's
   * lifetime, and nothing else — the case notices nothing when it lapses
   * (§A.4), and the client may mint another.
   */
  readonly credentialExpiresAt: Date | null;
}

/* -------------------------------------------------------------------------- */
/* The level, and the key to it                                               */
/* -------------------------------------------------------------------------- */

export interface WaitLevel {
  /** The level locked on the case, or null while nothing is locked. */
  readonly locked: OutputLevel | null;
  readonly lockedAt: Date | null;
  /** What the record derives right now. */
  readonly derivesNow: OutputLevel;
  /** Which rule bound — the key to what would change it. */
  readonly reason: OutputLevelReason;
  /** The derivation's own words. Rendered verbatim (HARD RULE #2). */
  readonly rationale: string;
  /** What the record looks like, as the derivation states it. Never re-worded. */
  readonly findings: readonly OutputLevelFinding[];
  /** The locked level is no longer what the record derives. */
  readonly stale: boolean;
}

/** The frozen judgment this wait is a wait around. Text is never carried. */
export interface FrozenJudgmentNote {
  readonly judgmentId: string;
  readonly version: number;
  readonly level: OutputLevel;
  readonly frozenAt: Date | null;
}

/* -------------------------------------------------------------------------- */
/* What A can still do                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Work that improves the record regardless of her.
 *
 * Both numbers are about the client's own material and the client's own open
 * questions. Neither can be a fact about her: the utterance count excludes
 * every row she owns, and clarification is author-only by construction (§A.3).
 */
export interface WaitOwnWork {
  /** Lines of the client's own material still sitting `pending`. */
  readonly unconfirmedLines: number;
  /** Questions put to the client that have no answer and no decline. */
  readonly openClarificationQuestions: number;
  /** A clarification round is open — where those questions are answered. */
  readonly clarificationRoundOpen: boolean;
}

/* -------------------------------------------------------------------------- */
/* The door                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The state of her link, as the client's side of it needs to see it.
 *
 * A narrowing of `readDoorStanding` (doc 05 §A.4 lives in
 * `server/participation/door.ts`; this reads it and decides nothing). Two things
 * are dropped on the way through: her `respond_state`, for the reason the
 * module header gives, and anything that would let the screen count. What is
 * added is `mayMint`, which is the one question the control on the page asks.
 */
export interface DoorView {
  /** True when the client may create an invitation right now. */
  readonly mayMint: boolean;
  /**
   * Why not, in the words the rule itself uses. Null when minting is open.
   *
   * Rendered verbatim: the sentence is written where the refusal is enforced
   * (`access/invite.ts`), so a screen cannot show one reason while the mint path
   * applies another.
   */
  readonly mintingClosedReason: string | null;
  /** A credential exists, has not been spent, and has not aged out. */
  readonly liveCredential: boolean;
  /** When the live credential was minted. Null when there is none. */
  readonly mintedAt: Date | null;
  /** Its deadline. Null on a standing door — a link with no deadline. */
  readonly expiresAt: Date | null;
  /** A credential exists and has aged out. Adverse to nobody (§A.4). */
  readonly expired: boolean;
  /** The link has no deadline and still resolves — her own standing door. */
  readonly standing: boolean;
}

/* -------------------------------------------------------------------------- */
/* The whole view                                                             */
/* -------------------------------------------------------------------------- */

export interface WaitView {
  readonly caseId: string;
  readonly counterparty: WaitingParty;
  /** The state of her link, and whether another may be created. */
  readonly door: DoorView;
  readonly level: WaitLevel;
  /** Null until a judgment has been frozen on this case. */
  readonly judgment: FrozenJudgmentNote | null;
  /** In the order of §A.2's sequence. */
  readonly acts: readonly WaitAct[];
  readonly ownWork: WaitOwnWork;
  /**
   * The record is still one-sided: she has not put confirmed material of her
   * own into it. The condition this whole surface exists for — once it is
   * false, the wait is over and the page has other things to say.
   */
  readonly stillOneSided: boolean;
}

/* -------------------------------------------------------------------------- */
/* Building it                                                                */
/* -------------------------------------------------------------------------- */

function act(
  code: WaitActCode,
  at: Date | null,
  extra: {
    readonly recorded?: boolean;
    readonly answer?: WaitAnswer | null;
    readonly credentialExpiresAt?: Date | null;
  } = {},
): WaitAct {
  return {
    code,
    recorded: extra.recorded ?? at !== null,
    at,
    answer: extra.answer ?? null,
    credentialExpiresAt: extra.credentialExpiresAt ?? null,
  };
}

/**
 * Everything the client's case page may show about the wait, or null when there
 * is no wait to describe.
 *
 * Null means the case has no second party at all — there is nobody this surface
 * could be about, and a page that rendered "nothing has happened" for a
 * counterparty who does not exist would be inventing an absence.
 */
export function buildWaitView(db: Db, caseId: string): WaitView | null {
  const board = readParticipation(db, caseId);
  const her = board.counterparty;
  if (her === null) return null;

  const row = db
    .select({
      respondState: caseParticipants.respondState,
      respondStateAt: caseParticipants.respondStateAt,
      inviteIssuedAt: caseParticipants.inviteTokenIssuedAt,
      inviteExpiresAt: caseParticipants.inviteTokenExpiresAt,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, her.id))
    .get();

  const level = readOutputLevel(db, caseId);
  const judgment = readFrozenJudgment(db, caseId);

  /* --- act 1: the invitation ------------------------------------------- */
  const invited = act("invitation_created", row?.inviteIssuedAt ?? null, {
    credentialExpiresAt: row?.inviteExpiresAt ?? null,
  });

  /* --- act 2: her answer ------------------------------------------------
   * Two acts share one slot because they are one question answered two ways.
   * A decline is read off `respond_state`, which only her own acts write; a
   * consent is read off the append-only consent log, folded, so a later
   * revocation is not silently rendered as a standing grant. `opened` and
   * `invited` both fall through to "no answer yet" — see the module header. */
  const declined = row?.respondState === "declined";
  const consent = consentFoldFor(db, caseId, her.id, "case_record");
  const answered = declined
    ? act("answered", row?.respondStateAt ?? null, {
        recorded: true,
        answer: "declined",
      })
    : consent.standing === "granted"
      ? act("answered", consent.decidedBy?.occurredAt ?? null, {
          recorded: true,
          answer: "consented",
        })
      : act("answered", null, { recorded: false });

  /* --- acts 3 and 4: her material, as two booleans --------------------- */
  const material = readHerMaterialShape(db, caseId, her.id);
  const submitted = act("statement_submitted", material.firstAt, {
    recorded: material.exists,
  });
  const confirmationComplete = act(
    "confirmation_complete",
    material.complete ? material.lastWriteAt : null,
    { recorded: material.complete },
  );

  /* --- act 5: the re-hearing -------------------------------------------
   * Available when a frozen judgment stands and the record no longer derives
   * the level it was written inside. It is offered, never auto-fired (§A.1),
   * and it has no timestamp: "the record moved" is not an event this schema
   * records the moment of. */
  const rehearing = act("rehearing_available", null, {
    recorded: judgment !== null && level.stale,
  });

  return {
    caseId,
    counterparty: {
      participantId: her.id,
      pseudonym: her.pseudonym,
      displayName: her.displayName,
      participationState: her.participationState,
    },
    door: readDoor(db, her.id),
    level: {
      locked: level.locked,
      lockedAt: level.lockedAt,
      derivesNow: level.decision.level,
      reason: level.decision.reason,
      rationale: level.decision.rationale,
      findings: level.decision.findings,
      stale: level.stale,
    },
    judgment,
    acts: [invited, answered, submitted, confirmationComplete, rehearing],
    ownWork: readOwnWork(db, caseId, board.submitter?.id ?? null),
    stillOneSided: !material.confirmedAny,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Her door, narrowed to what the client's screen may act on.
 *
 * `mayMint` is deliberately stricter than `issueInviteToken` will accept. The
 * mint path allows replacing a live token, and for a UI that is the wrong
 * default: one live invitation at a time is doc 05 §A.4's rule, and a button
 * that silently invalidates the link the client may already have sent is a
 * button that breaks somebody's link without saying so. So the control is
 * offered when there is no credential, or when the one there has aged out —
 * which is exactly when re-minting takes nothing away from anyone.
 */
function readDoor(db: Db, participantId: string): DoorView {
  const standing = readDoorStanding(db, participantId);
  /* c8 ignore next 11 -- the participant was just read out of the same case. */
  if (standing === null) {
    return {
      mayMint: false,
      mintingClosedReason: null,
      liveCredential: false,
      mintedAt: null,
      expiresAt: null,
      expired: false,
      standing: false,
    };
  }

  const live =
    standing.lastMintedAt !== null && !standing.expired && !standing.hasAccount;

  return {
    mayMint: !standing.mintingClosed && !live,
    mintingClosedReason: standing.mintingClosedReason,
    liveCredential: live,
    mintedAt: standing.lastMintedAt,
    expiresAt: standing.expiresAt,
    expired: standing.expired,
    standing: standing.standing,
  };
}

/**
 * The highest frozen version on the case, as a fact and never as a text.
 *
 * `content` and `surface_layer` are not selected, for the reason
 * `participation/entry.ts` gives about the mirror-image screen: a component
 * cannot render a column this function never read.
 */
function readFrozenJudgment(db: Db, caseId: string): FrozenJudgmentNote | null {
  const rows = db
    .select({
      id: judgmentsTable.id,
      version: judgmentsTable.version,
      outputLevel: judgmentsTable.outputLevel,
      status: judgmentsTable.status,
      finalizedAt: judgmentsTable.finalizedAt,
    })
    .from(judgmentsTable)
    .where(eq(judgmentsTable.caseId, caseId))
    .all()
    .filter((r) => r.status === "final")
    .sort((a, b) => a.version - b.version);

  const latest = rows[rows.length - 1];
  if (latest === undefined) return null;
  return {
    judgmentId: latest.id,
    version: latest.version,
    level: latest.outputLevel,
    frozenAt: latest.finalizedAt,
  };
}

interface HerMaterialShape {
  /** She has put something into this case. */
  readonly exists: boolean;
  /** At least one line of hers is confirmed — the record is no longer one-sided. */
  readonly confirmedAny: boolean;
  /** Something of hers exists and none of it is still `pending`. */
  readonly complete: boolean;
  /** When the first line of hers landed. */
  readonly firstAt: Date | null;
  /**
   * The last write to any line of hers.
   *
   * Used as the moment confirmation completed, because the act that completes
   * it is a write to the last pending row. It moves again if she revises
   * something later, which is honest: it is the record's last word from her,
   * not a claim that nothing has happened since.
   */
  readonly lastWriteAt: Date | null;
}

/**
 * Her material as a shape: three booleans and two dates, and no count.
 *
 * The select carries `confirm_status` and two timestamps. It does not carry
 * `content`, `ai_draft` or `human_final`, and the rows are collapsed before
 * anything leaves this function — the number of lines she has written is
 * exactly what §A.2 refuses to report, and the safest place to refuse it is
 * where it would otherwise be computed. `CITABLE_STATUSES` is used rather than
 * a second list of status literals, so HARD RULE #1's definition of citable has
 * one home.
 */
function readHerMaterialShape(
  db: Db,
  caseId: string,
  participantId: string,
): HerMaterialShape {
  const rows = db
    .select({
      confirmStatus: utterancesTable.confirmStatus,
      createdAt: utterancesTable.createdAt,
      updatedAt: utterancesTable.updatedAt,
    })
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        eq(utterancesTable.ownerParticipantId, participantId),
      ),
    )
    .all();

  const citable: readonly string[] = CITABLE_STATUSES;
  let confirmedAny = false;
  let pending = false;
  let firstAt: Date | null = null;
  let lastWriteAt: Date | null = null;

  for (const row of rows) {
    if (citable.includes(row.confirmStatus)) confirmedAny = true;
    if (row.confirmStatus === "pending") pending = true;
    if (firstAt === null || row.createdAt < firstAt) firstAt = row.createdAt;
    if (lastWriteAt === null || row.updatedAt > lastWriteAt) {
      lastWriteAt = row.updatedAt;
    }
  }

  return {
    exists: rows.length > 0,
    confirmedAny,
    complete: rows.length > 0 && !pending,
    firstAt,
    lastWriteAt,
  };
}

/**
 * The two things the client can do that do not depend on her.
 *
 * The utterance count is scoped to material the client owns (plus the pre-M5
 * unowned rows, which migration 0011 attributes to the submitter): it is a
 * count of his own outstanding work, and it must not become a count of hers by
 * a later widening of this query.
 */
function readOwnWork(
  db: Db,
  caseId: string,
  submitterId: string | null,
): WaitOwnWork {
  const [pending] = db
    .select({ n: count() })
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        eq(utterancesTable.confirmStatus, "pending"),
        submitterId === null
          ? isNull(utterancesTable.ownerParticipantId)
          : or(
              isNull(utterancesTable.ownerParticipantId),
              eq(utterancesTable.ownerParticipantId, submitterId),
            ),
      ),
    )
    .all();

  const board = readClarification(db, caseId);
  const open = board.openRound;
  const openQuestions =
    open === null
      ? 0
      : open.questions.filter((q) => q.answer === null && !q.declined).length;

  return {
    unconfirmedLines: pending?.n ?? 0,
    openClarificationQuestions: openQuestions,
    clarificationRoundOpen: open !== null,
  };
}
