/**
 * The door the invited party holds, and what her own acts do to it (doc 05 §A.4).
 *
 * `server/access/invite.ts` owns the credential — how a token is minted, hashed,
 * verified and spent. This module owns the **doctrine around it**: which
 * credentials open `/respond`, what a decline does to A's ability to mint again,
 * how a spent invitation becomes a standing personal door, and how she reverses
 * a decision she is entitled to reverse.
 *
 * Four rules live here, each of them a decision rather than a description.
 *
 * ## 1. Three credentials open this route, not two
 *
 * Until now `/respond/[token]` resolved an invite token or an identity token.
 * The product also mints a **share token** for the shareable document
 * (`mintShareToken`), and the document it mints ends by pointing at
 * `/respond/<that token>` — a route that could not resolve it. So the one link
 * the client actually has a button for landed the person it was addressed to on
 * "this link did not open anything": the third instance of a document promising
 * a route that is not there, and the one that hits the reader who never asked to
 * be here.
 *
 * A share token resolves here to the participant the document was written to —
 * the case's one non-submitting party, which is the same lookup
 * `resolveShareRecipient` and the export gate already make. It is not a weaker
 * credential than an invitation: both are bearer capabilities the client hands
 * over by choice, both are stored only as a hash, and the share token expires on
 * its own schedule as well. What it is *not* is a licence to read the document —
 * that is `readSharedRendition`'s decision, asked separately, on the route that
 * renders text.
 *
 * ## 2. Opening a page is not an act
 *
 * Nothing in this module writes on a read, and `resolveArrival` passes
 * `touch: false` so that resolving an identity does not stamp `last_seen_at`
 * either. A reader who suspects the sender is told she opened the link cannot
 * read freely, and free reading is the precondition for the decision the page
 * asks her to make (doc 05 §A.5 question 3). The function that used to move
 * `respond_state` invited → opened on render was deleted rather than left
 * uncalled: an invariant with a working implementation of its opposite sitting
 * next to it is an invariant waiting to be re-enabled by someone tidying up.
 *
 * ## 3. A decline closes minting and opens a standing door
 *
 * Refusing is not a state the product then tries to talk her out of. Her decline
 * closes the client's ability to mint her another invitation (enforced in
 * `issueInviteToken`, which asks this module), and it converts the link she is
 * holding from a single-use invitation into her own standing door: the expiry is
 * cleared, the hash stays, so the link keeps working with no deadline on it and
 * reaches the transparency view and the reversal of her own decision. It is
 * revocable by her and by nobody else.
 *
 * The alternative — burning the link on a decline — makes the refusal
 * irreversible by its author, which is a trap in the other direction. The
 * consent machinery already prefers suspension to burning (SPEC 2026-08-12) and
 * this is the same preference applied to the door itself.
 *
 * ## 4. Expiry is credential hygiene, and writes nothing
 *
 * A token that ages out writes no case event, moves no participation state, and
 * surfaces nothing adverse anywhere. The case does not notice, because nothing
 * about the merits may move on a timer (doc 05 §A.4). The only thing that
 * happens is that a live secret sitting in a chat thread stops working.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db";
import {
  caseParticipants,
  judgmentRenditions,
  judgments,
  type ParticipationState,
  type RespondState,
} from "../db/schema";
import { hashShareToken } from "../judgment/rendition";
import type { Reader } from "../pipeline/stage-machine";
import {
  MINTING_CLOSED_BY_ACCOUNT,
  MINTING_CLOSED_BY_DECLINE,
  hashInviteToken,
  readIdentity,
  resolveIdentityToken,
  verifyInviteToken,
  type IdentityRecord,
  type InviteRefusalReason,
  type InvitedParticipant,
} from "../access/invite";

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/** How the person holding the link proved which party she is. */
export type ArrivalCredential = "identity" | "invite" | "share";

export interface Arrival {
  readonly participant: InvitedParticipant;
  /** Her account, once she has taken one up. Null while she is still on a link. */
  readonly identity: IdentityRecord | null;
  readonly via: ArrivalCredential;
}

export type ArrivalOutcome =
  | { readonly ok: true; readonly arrival: Arrival }
  | {
      readonly ok: false;
      readonly reason: InviteRefusalReason;
      /** One sentence, safe to show somebody holding a link that did not work. */
      readonly message: string;
    };

export interface ArrivalOptions {
  /** Injected clock, so an expiry test does not have to wait fourteen days. */
  readonly now?: Date;
}

/**
 * Resolve a share token to the participant the document was addressed to.
 *
 * The lookup is by hash, on a rendition that is stored `shareable`, of `kind`
 * shareable, and not past its own expiry — the same three conditions
 * `readSharedRendition` checks before it will serve text. What this does NOT do
 * is ask the consent question: a party who revoked `named_rendition` has stopped
 * the *document* from being served, and locking her out of the page that
 * explains what she revoked and lets her reverse it would be the product
 * punishing her for using it.
 *
 * The recipient is the case's one non-submitting participant. When the case has
 * none, or more than one, this returns null rather than guessing — the same
 * refusal shape the export gate takes when it cannot name a recipient.
 */
function resolveShareToken(
  db: Reader,
  token: string,
  now: Date,
): InvitedParticipant | null {
  const row = db
    .select({
      caseId: judgments.caseId,
      shareable: judgmentRenditions.shareable,
      kind: judgmentRenditions.kind,
      expiresAt: judgmentRenditions.shareExpiresAt,
    })
    .from(judgmentRenditions)
    .innerJoin(judgments, eq(judgments.id, judgmentRenditions.judgmentId))
    .where(eq(judgmentRenditions.shareTokenHash, hashShareToken(token)))
    .get();

  if (row === undefined || !row.shareable || row.kind !== "shareable") {
    return null;
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const candidates = db
    .select()
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.caseId, row.caseId),
        eq(caseParticipants.isSubmitter, false),
      ),
    )
    .all();

  if (candidates.length !== 1) return null;

  const party = candidates[0];
  return {
    id: party.id,
    caseId: party.caseId,
    role: party.role,
    pseudonym: party.pseudonym,
    respondState: party.respondState,
    invitedAt: party.inviteTokenIssuedAt,
    expiresAt: party.inviteTokenExpiresAt,
    redeemedAt: party.inviteTokenRedeemedAt,
  };
}

/**
 * Resolve whatever is in `[token]` to the party holding it — reading only.
 *
 * The order is the order of specificity: an identity token names one account, an
 * invitation names one participant, a share token names the recipient of one
 * document. Every branch is a read; none of them writes, including the identity
 * branch, which passes `touch: false` on purpose (see the header, rule 2).
 *
 * A refusal is `verifyInviteToken`'s, wording and reason alike. Unknown, expired
 * and already-redeemed happened to different people and this module has nothing
 * to add to any of them.
 */
export function resolveArrival(
  db: Db,
  token: string,
  options: ArrivalOptions = {},
): ArrivalOutcome {
  if (typeof token !== "string" || token.trim() === "") {
    return refusalFrom(db, token, options);
  }

  const returning = resolveIdentityToken(db, token, { ...options, touch: false });
  if (returning !== null) {
    return {
      ok: true,
      arrival: {
        participant: returning.participant,
        identity: returning.identity,
        via: "identity",
      },
    };
  }

  const invited = verifyInviteToken(db, token, options);
  if (invited.ok) {
    return {
      ok: true,
      arrival: {
        participant: invited.participant,
        identity: readIdentity(db, invited.participant.id),
        via: "invite",
      },
    };
  }

  const shared = resolveShareToken(db, token, options.now ?? new Date());
  if (shared !== null) {
    return {
      ok: true,
      arrival: {
        participant: shared,
        identity: readIdentity(db, shared.id),
        via: "share",
      },
    };
  }

  return { ok: false, reason: invited.reason, message: invited.message };
}

/** The invite-token refusal for a token that never had a chance to resolve. */
function refusalFrom(
  db: Db,
  token: string,
  options: ArrivalOptions,
): ArrivalOutcome {
  const check = verifyInviteToken(db, token, options);
  /* c8 ignore next -- an empty token cannot verify; the branch exists for types. */
  if (check.ok) {
    return {
      ok: true,
      arrival: {
        participant: check.participant,
        identity: readIdentity(db, check.participant.id),
        via: "invite",
      },
    };
  }
  return { ok: false, reason: check.reason, message: check.message };
}

/* -------------------------------------------------------------------------- */
/* What the door is currently doing                                           */
/* -------------------------------------------------------------------------- */

/**
 * The state of one party's door, as a set of facts rather than a status word.
 *
 * Every field here is derived from columns that already exist. There is
 * deliberately no count of how many times the client has minted: the schema
 * keeps only the live token's `issued_at`, so a re-mint history would be an
 * invention. `lastMintedAt` is what the record actually knows, and doc 05 §A.4's
 * "re-minting is A's recorded act" is honoured to exactly that depth — see the
 * note in this milestone's report.
 */
export interface DoorStanding {
  readonly participantId: string;
  readonly respondState: RespondState;
  readonly participationState: ParticipationState;
  /** When the live credential was minted. Null once it has been revoked. */
  readonly lastMintedAt: Date | null;
  /** Null means no deadline: a standing door, or no credential at all. */
  readonly expiresAt: Date | null;
  /** True when a credential exists and has aged out. Adverse to nobody. */
  readonly expired: boolean;
  /** True when the link has no deadline and still resolves — her standing door. */
  readonly standing: boolean;
  /** True once she has taken up an account; the identity token outlives the invite. */
  readonly hasAccount: boolean;
  /** True when the client may not mint her another invitation. */
  readonly mintingClosed: boolean;
  /** Why minting is closed, in one sentence, or null when it is open. */
  readonly mintingClosedReason: string | null;
}

export function readDoorStanding(
  db: Reader,
  participantId: string,
  options: ArrivalOptions = {},
): DoorStanding | null {
  const row = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, participantId))
    .get();
  if (row === undefined) return null;

  const now = options.now ?? new Date();
  const live = row.inviteTokenHash !== null && row.inviteTokenRedeemedAt === null;
  const expired =
    live &&
    row.inviteTokenExpiresAt !== null &&
    row.inviteTokenExpiresAt.getTime() <= now.getTime();
  const hasAccount = readIdentity(db, participantId) !== null;

  const closedReason =
    row.respondState === "declined"
      ? MINTING_CLOSED_BY_DECLINE
      : row.inviteTokenRedeemedAt !== null
        ? MINTING_CLOSED_BY_ACCOUNT
        : null;

  return {
    participantId,
    respondState: row.respondState,
    participationState: row.participationState,
    lastMintedAt: row.inviteTokenHash === null ? null : row.inviteTokenIssuedAt,
    expiresAt: row.inviteTokenExpiresAt,
    expired,
    standing: live && row.inviteTokenExpiresAt === null,
    hasAccount,
    mintingClosed: closedReason !== null,
    mintingClosedReason: closedReason,
  };
}

/**
 * May the client mint this party an invitation?
 *
 * Asked by `issueInviteToken` before it writes. A decline is the only new
 * answer: no re-invite stream after a refusal, because a stream of invitations
 * is harassment with case-management UI (doc 05 §A.4).
 */
export function mintingRefusal(db: Reader, participantId: string): string | null {
  const row = db
    .select({ respondState: caseParticipants.respondState })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, participantId))
    .get();
  if (row === undefined) return null;
  return row.respondState === "declined" ? MINTING_CLOSED_BY_DECLINE : null;
}

/* -------------------------------------------------------------------------- */
/* Converting the invitation into her standing door                           */
/* -------------------------------------------------------------------------- */

/**
 * Clear the deadline on her unspent invitation, leaving the link working.
 *
 * Called inside the decline transaction. It is a no-op for a party who redeemed
 * her invitation already — she holds an identity token, which never expires and
 * is the standing door in that case — and for a party who has no live link,
 * because there is nothing to convert.
 *
 * Nothing here mints, so the link she is holding when she declines is the link
 * she keeps. That matters: a decline that handed her a *new* secret would be a
 * decline she could only act on if she read the screen carefully enough to save
 * it.
 */
export function openStandingDoor(db: Db, participantId: string): void {
  db.update(caseParticipants)
    .set({ inviteTokenExpiresAt: null })
    .where(
      and(
        eq(caseParticipants.id, participantId),
        isNull(caseParticipants.inviteTokenRedeemedAt),
      ),
    )
    .run();
}

export interface DoorRevocation {
  readonly participantId: string;
  readonly revoked: boolean;
  readonly revokedAt: Date;
}

/**
 * Her own act: close the door behind her.
 *
 * The hash is cleared, so the link she was holding stops resolving and nothing
 * can re-derive it — there is no plaintext anywhere to restore from. This is the
 * one asymmetry worth stating: her door is revocable by her and by nobody else,
 * and the client cannot mint a replacement afterwards if she declined, so
 * revoking is final in a way the rest of this module deliberately is not. The
 * screen that offers it says so before she presses it.
 */
export function revokeStandingDoor(
  db: Db,
  participantId: string,
  options: ArrivalOptions = {},
): DoorRevocation {
  const now = options.now ?? new Date();
  const rows = db
    .update(caseParticipants)
    .set({
      inviteTokenHash: null,
      inviteTokenExpiresAt: null,
      inviteTokenIssuedAt: null,
    })
    .where(
      and(
        eq(caseParticipants.id, participantId),
        isNull(caseParticipants.inviteTokenRedeemedAt),
      ),
    )
    .returning()
    .all();

  return { participantId, revoked: rows.length > 0, revokedAt: now };
}

/* -------------------------------------------------------------------------- */
/* Reversing a decline                                                        */
/* -------------------------------------------------------------------------- */

export interface ReopenOutcome {
  readonly participantId: string;
  readonly respondState: RespondState;
  readonly participationState: ParticipationState;
  /** Her words when she declined. Kept — reversing a decision is not erasing it. */
  readonly declineReason: string | null;
  readonly reopenedAt: Date;
  /** False when she had not declined; the call is then a no-op. */
  readonly reversed: boolean;
}

/**
 * Take back a decline (doc 05 §A.4: "reversible by her alone").
 *
 * `respond_state` goes back to `invited` — she is holding a live door and has
 * not decided — and `participation_state` back to `pending`, which is the column
 * meaning "nothing has been established about whether this party takes part".
 * The alternative, leaving `refused` standing until she submits something, would
 * mean a person who changed her mind still appears in every document as having
 * refused until she finishes typing.
 *
 * **What is not undone: her words.** `decline_reason` stays exactly where she
 * put it. A reversal is a second act, not a retraction of the first, and a
 * product that deleted the first one on her behalf would be deciding that her
 * earlier reason is now embarrassing. The transparency view shows both, and
 * `purge:operator` leaves both alone.
 *
 * Only her own credential reaches this: the route resolves her token first and
 * derives the participant from it, so there is no argument here a client could
 * supply to reverse a decline that is not his to reverse.
 */
export function reopenParticipation(
  db: Db,
  input: {
    readonly caseId: string;
    readonly participantId: string;
    readonly now?: Date;
  },
): ReopenOutcome {
  const now = input.now ?? new Date();

  const rows = db
    .update(caseParticipants)
    .set({
      respondState: "invited",
      respondStateAt: now,
      participationState: "pending",
    })
    .where(
      and(
        eq(caseParticipants.id, input.participantId),
        eq(caseParticipants.caseId, input.caseId),
        eq(caseParticipants.respondState, "declined"),
      ),
    )
    .returning()
    .all();

  if (rows.length > 0) {
    const row = rows[0];
    return {
      participantId: row.id,
      respondState: row.respondState,
      participationState: row.participationState,
      declineReason: row.declineReason,
      reopenedAt: now,
      reversed: true,
    };
  }

  const current = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, input.participantId))
    .get();

  return {
    participantId: input.participantId,
    respondState: current?.respondState ?? "not_started",
    participationState: current?.participationState ?? "pending",
    declineReason: current?.declineReason ?? null,
    reopenedAt: now,
    reversed: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Re-exports, so each of these has one definition on this path too           */
/* -------------------------------------------------------------------------- */

export { hashInviteToken, MINTING_CLOSED_BY_ACCOUNT, MINTING_CLOSED_BY_DECLINE };
