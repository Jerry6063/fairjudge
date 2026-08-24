/**
 * Invite tokens and the identity one redeems into (SPEC M5 ①, doc 02 §1.3:
 * "invite token — hashed in the DB, single-use, upgradable to a full account").
 *
 * **This module mints tokens. It does not deliver them.** There is no mail, no
 * push, no outbound anything here, and the omission is the design: sending a
 * real invitation to a real person is an act with consequences in somebody's
 * relationship, and it belongs to the client, not to this system. `issueInviteToken`
 * returns the token to its caller and that is where the machinery stops.
 *
 * ## Verify and redeem are different acts
 *
 * `verifyInviteToken` is a read. It answers "is this link still good, and whose
 * is it", and it may be called any number of times — opening the invitation
 * screen, reloading it, coming back an hour later. A verify that spent the token
 * would mean a page refresh locked her out of her own invitation.
 *
 * `redeemInviteToken` is the single-use act: it turns the invitation into an
 * identity. Single-use is enforced by a conditional UPDATE
 * (`WHERE invite_token_redeemed_at IS NULL`) whose `RETURNING` comes back empty
 * for the second caller, plus a unique index on `participant_identities.participant_id`.
 * Neither is a check a caller has to remember; both are properties of the write.
 *
 * ## Three refusals, told apart on purpose
 *
 *   unknown_token    — no live token hashes to this. A guess, a typo, or a token
 *                      that was replaced by re-issuing.
 *   expired          — it was real and it is past its expiry.
 *   already_redeemed — it was real and it has been spent. This is what a replay
 *                      gets, and it must not read as "unknown": the person
 *                      holding it did nothing wrong and already has an account.
 *
 * ## What is stored
 *
 * Only hashes. The plaintext invite token and the plaintext identity token are
 * returned to the caller exactly once and never written, so a copy of this
 * database is not a working invitation into anybody's case. Lookup is by SHA-256
 * of a 256-bit random value, so there is no meaningful timing surface in the
 * equality comparison and no secret to leak by guessing.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db";
import {
  caseParticipants,
  participantIdentities,
  type ParticipantRole,
  type RespondState,
} from "../db/schema";
import type { Reader } from "../pipeline/stage-machine";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long an invitation stays good: 14 days.
 *
 * Long enough that "I saw it and needed to think" is not punished, short enough
 * that a link forwarded to a phone that is later sold is not a way into a case
 * about somebody's relationship a year on.
 */
export const INVITE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Bytes of entropy in a minted token, invite and identity alike. */
const TOKEN_BYTES = 32;

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

/** SHA-256 hex of a token. The only form of either token that is ever stored. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Same function, named for the other token, so call sites read honestly. */
export const hashIdentityToken = hashInviteToken;

function mintSecret(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type InviteErrorCode =
  | "participant_not_found"
  /** The person who filed the case is already here; there is nobody to invite. */
  | "cannot_invite_submitter"
  /** They already redeemed an invitation, so a second one would be a second account. */
  | "already_redeemed"
  /** She declined in the product. Minting for her is closed (doc 05 §A.4). */
  | "participant_declined";

/**
 * Why minting is closed for a party, in the words the client is shown.
 *
 * Kept here rather than at the call site because the rule is enforced here: a
 * message that lived on a screen could be shown by one screen and not by the
 * one that mints.
 */
export const MINTING_CLOSED_BY_DECLINE =
  "This party declined in the product, in her own words. No further invitation " +
  "is minted for her: the answer she gave is the record's answer, and a second " +
  "link would be the same question asked again by a system she has already " +
  "answered. Her existing link stays open for as long as she wants it.";

/** The other reason minting stops: she is already here. */
export const MINTING_CLOSED_BY_ACCOUNT =
  "This party already redeemed an invitation and holds an account. A second " +
  "invitation would be a second account for one person.";

export class InviteError extends Error {
  readonly code: InviteErrorCode;

  constructor(code: InviteErrorCode, message: string) {
    super(message);
    this.name = "InviteError";
    this.code = code;
  }
}

/** Why a presented token was refused. Never collapsed into one answer. */
export type InviteRefusalReason =
  | "unknown_token"
  | "expired"
  | "already_redeemed";

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

/** The party an invitation belongs to, as a caller needs to see them. */
export interface InvitedParticipant {
  readonly id: string;
  readonly caseId: string;
  readonly role: ParticipantRole;
  /** The egress token (甲 / 乙). The real name never leaves this machine. */
  readonly pseudonym: string;
  readonly respondState: RespondState;
  readonly invitedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly redeemedAt: Date | null;
}

/** What `issueInviteToken` hands back. The plaintext appears here and nowhere else. */
export interface IssuedInvite {
  /** Give this to the client to pass on. It is not stored anywhere. */
  readonly token: string;
  readonly participantId: string;
  readonly caseId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface IdentityRecord {
  readonly id: string;
  readonly participantId: string;
  readonly displayName: string | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

export type InviteCheck =
  | { readonly ok: true; readonly participant: InvitedParticipant }
  | {
      readonly ok: false;
      readonly reason: InviteRefusalReason;
      /** One sentence, safe to show the person holding the link. */
      readonly message: string;
    };

export type RedeemOutcome =
  | {
      readonly ok: true;
      readonly participant: InvitedParticipant;
      readonly identity: IdentityRecord;
      /**
       * How she gets back in later, once the single-use invite is spent.
       * Returned once; only its hash is stored. Not a password — a bearer
       * capability, revocable by deleting the identity row.
       */
      readonly identityToken: string;
    }
  | {
      readonly ok: false;
      readonly reason: InviteRefusalReason;
      readonly message: string;
    };

type ParticipantRow = typeof caseParticipants.$inferSelect;
type IdentityRow = typeof participantIdentities.$inferSelect;

function toInvited(row: ParticipantRow): InvitedParticipant {
  return {
    id: row.id,
    caseId: row.caseId,
    role: row.role,
    pseudonym: row.pseudonym,
    respondState: row.respondState,
    invitedAt: row.inviteTokenIssuedAt,
    expiresAt: row.inviteTokenExpiresAt,
    redeemedAt: row.inviteTokenRedeemedAt,
  };
}

function toIdentity(row: IdentityRow): IdentityRecord {
  return {
    id: row.id,
    participantId: row.participantId,
    displayName: row.displayName,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

const REFUSAL_MESSAGE: Readonly<Record<InviteRefusalReason, string>> = {
  unknown_token:
    "This invitation link is not one this machine issued, or it was replaced by " +
    "a newer one. Ask for a fresh link.",
  expired:
    "This invitation has expired. Nothing was lost — ask for a fresh link and " +
    "it will bring you to the same place.",
  already_redeemed:
    "This invitation has already been used. It only works once; if you set up " +
    "your side already, open it with the link you were given afterwards.",
};

function refuse(reason: InviteRefusalReason): InviteCheck & RedeemOutcome {
  return { ok: false, reason, message: REFUSAL_MESSAGE[reason] };
}

/* -------------------------------------------------------------------------- */
/* Issuing                                                                    */
/* -------------------------------------------------------------------------- */

export interface IssueInviteOptions {
  /** Lifetime of the token. Defaults to `INVITE_TOKEN_TTL_MS`. */
  readonly ttlMs?: number;
  /** Injected clock, so tests are deterministic. */
  readonly now?: Date;
}

/**
 * Mint an invitation for one participant, and return it to the caller.
 *
 * Re-issuing before redemption is allowed and **replaces** the live token: the
 * previous link stops working, because one participant has one live invitation.
 * Re-issuing after redemption is refused — the account already exists, and a
 * second invitation could only create a second one.
 *
 * **A recorded decline closes minting for that participant** (doc 05 §A.4). This
 * used to be allowed, with the reasoning that "minting another link is the
 * client's business"; it is not, once she has answered. A re-invite stream after
 * a refusal is invite-spam with case-management UI, and the person on the
 * receiving end of it owes this system nothing. Her own link stays open — the
 * decline converts it into a standing door (`openStandingDoor`) — so closing
 * minting takes nothing away from her; it takes away the ability to ask again.
 *
 * Re-minting after an expiry is still allowed and is the client's own recorded
 * act: the row carries `invite_token_issued_at` for the live credential. Expiry
 * itself writes nothing anywhere (doc 05 §A.4, credential hygiene).
 *
 * `respond_state` moves to `invited` only from `not_started`, so a row that has
 * moved on is never walked backwards by a mint.
 */
export function issueInviteToken(
  db: Db,
  participantId: string,
  options: IssueInviteOptions = {},
): IssuedInvite {
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? INVITE_TOKEN_TTL_MS;

  const row = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, participantId))
    .get();

  if (row === undefined) {
    throw new InviteError(
      "participant_not_found",
      `No participant with id ${participantId}.`,
    );
  }
  if (row.isSubmitter) {
    throw new InviteError(
      "cannot_invite_submitter",
      `Participant ${participantId} filed this case. There is no invitation to ` +
        `issue to the person who is already here.`,
    );
  }
  if (row.inviteTokenRedeemedAt !== null) {
    throw new InviteError("already_redeemed", MINTING_CLOSED_BY_ACCOUNT);
  }
  if (row.respondState === "declined") {
    throw new InviteError("participant_declined", MINTING_CLOSED_BY_DECLINE);
  }

  const token = mintSecret();
  const expiresAt = new Date(now.getTime() + ttl);

  db.update(caseParticipants)
    .set({
      inviteTokenHash: hashInviteToken(token),
      inviteTokenIssuedAt: now,
      inviteTokenExpiresAt: expiresAt,
      inviteTokenRedeemedAt: null,
      ...(row.respondState === "not_started"
        ? { respondState: "invited" as const, respondStateAt: now }
        : {}),
    })
    .where(eq(caseParticipants.id, participantId))
    .run();

  return {
    token,
    participantId: row.id,
    caseId: row.caseId,
    issuedAt: now,
    expiresAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying                                                                  */
/* -------------------------------------------------------------------------- */

export interface TokenCheckOptions {
  readonly now?: Date;
}

function findByTokenHash(db: Reader, token: string): ParticipantRow | undefined {
  return db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.inviteTokenHash, hashInviteToken(token)))
    .get();
}

/**
 * Is this link still good, and whose is it?
 *
 * A pure read: it may be called on every page load. The order of the checks is
 * the order of what the holder needs told — a spent token says so rather than
 * pretending never to have existed.
 */
export function verifyInviteToken(
  db: Reader,
  token: string,
  options: TokenCheckOptions = {},
): InviteCheck {
  if (typeof token !== "string" || token.trim() === "") {
    return refuse("unknown_token");
  }

  const row = findByTokenHash(db, token);
  if (row === undefined) return refuse("unknown_token");
  if (row.inviteTokenRedeemedAt !== null) return refuse("already_redeemed");

  const now = options.now ?? new Date();
  if (
    row.inviteTokenExpiresAt !== null &&
    row.inviteTokenExpiresAt.getTime() <= now.getTime()
  ) {
    return refuse("expired");
  }

  return { ok: true, participant: toInvited(row) };
}

/**
 * There is deliberately no `markInviteOpened` here any more.
 *
 * It existed, it worked, and `/respond/[token]` called it on render to move
 * `respond_state` invited → opened. Doc 05 §A.5 question 3 requires the entry
 * screen to tell the reader, in as many words, that opening the page is not
 * reported to anyone and that reading is not recorded as an act — and a screen
 * may only say that if it is true of the code behind it. The function was
 * deleted rather than left uncalled: an invariant that ships with a working
 * implementation of its opposite beside it is an invariant somebody re-enables
 * while tidying up.
 *
 * `RESPOND_STATES` still contains `opened`, because the enum lives in a migrated
 * schema and nothing about the state is wrong — it is simply now unreachable,
 * and no row will move into it. Every other transition is written by an act she
 * chose: redeeming (`joined`), declining (`declined`), reversing a decline
 * (back to `invited`).
 *
 * What the client can still learn is what he could always learn: that she was
 * asked. Not that she looked.
 */

/* -------------------------------------------------------------------------- */
/* Redeeming                                                                  */
/* -------------------------------------------------------------------------- */

export interface RedeemInviteOptions extends TokenCheckOptions {
  /**
   * The name she gives for herself, if she gives one. Local only — the
   * pseudonym is what egresses (HARD RULE #3).
   */
  readonly displayName?: string | null;
}

/**
 * Spend the invitation and create the identity.
 *
 * The whole act is one transaction, and the write that matters is conditional:
 * `WHERE invite_token_redeemed_at IS NULL`. A replay finds nothing to claim and
 * is told `already_redeemed` — the guarantee is in the UPDATE, not in the check
 * above it, because a check above it is a race and a UPDATE is not.
 *
 * What this deliberately does NOT do is settle her participation. Taking up an
 * account is not agreeing to take part: from here she may join in, or decline,
 * or read the transparency view and do neither, and each of those is a different
 * recorded answer that only her later act can write.
 */
export function redeemInviteToken(
  db: Db,
  token: string,
  options: RedeemInviteOptions = {},
): RedeemOutcome {
  const check = verifyInviteToken(db, token, options);
  if (!check.ok) return refuse(check.reason);

  const now = options.now ?? new Date();
  const identityToken = mintSecret();

  return db.transaction((tx) => {
    const [claimed] = tx
      .update(caseParticipants)
      .set({
        inviteTokenRedeemedAt: now,
        respondState: "joined",
        respondStateAt: now,
      })
      .where(
        and(
          eq(caseParticipants.id, check.participant.id),
          eq(caseParticipants.inviteTokenHash, hashInviteToken(token)),
          isNull(caseParticipants.inviteTokenRedeemedAt),
        ),
      )
      .returning()
      .all();

    if (claimed === undefined) return refuse("already_redeemed");

    const [identity] = tx
      .insert(participantIdentities)
      .values({
        participantId: claimed.id,
        displayName: options.displayName ?? null,
        identityTokenHash: hashIdentityToken(identityToken),
        lastSeenAt: now,
      })
      .returning()
      .all();

    return {
      ok: true as const,
      participant: toInvited(claimed),
      identity: toIdentity(identity),
      identityToken,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The identity, afterwards                                                   */
/* -------------------------------------------------------------------------- */

/** The identity a participant took up, if they took one up. */
export function readIdentity(
  db: Reader,
  participantId: string,
): IdentityRecord | null {
  const row = db
    .select()
    .from(participantIdentities)
    .where(eq(participantIdentities.participantId, participantId))
    .get();
  return row === undefined ? null : toIdentity(row);
}

/** Whether this party has an account — the fact `responded` rests on. */
export function hasIdentity(db: Reader, participantId: string): boolean {
  return readIdentity(db, participantId) !== null;
}

export interface ResolveIdentityOptions extends TokenCheckOptions {
  /** Write `last_seen_at`. Default true; a read-only audit passes false. */
  readonly touch?: boolean;
}

/**
 * Resolve a returning identity token to its participant.
 *
 * The counterpart of redemption: the invite is single-use, so this is how she
 * comes back to her own transparency view without the client minting her a
 * second invitation.
 */
export function resolveIdentityToken(
  db: Db,
  identityToken: string,
  options: ResolveIdentityOptions = {},
): { readonly identity: IdentityRecord; readonly participant: InvitedParticipant } | null {
  if (typeof identityToken !== "string" || identityToken.trim() === "") {
    return null;
  }

  const row = db
    .select()
    .from(participantIdentities)
    .where(
      eq(
        participantIdentities.identityTokenHash,
        hashIdentityToken(identityToken),
      ),
    )
    .get();
  if (row === undefined) return null;

  const participant = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, row.participantId))
    .get();
  /* c8 ignore next -- the FK cascades, so an identity without its party cannot exist. */
  if (participant === undefined) return null;

  if (options.touch !== false) {
    const now = options.now ?? new Date();
    db.update(participantIdentities)
      .set({ lastSeenAt: now })
      .where(eq(participantIdentities.id, row.id))
      .run();
  }

  return { identity: toIdentity(row), participant: toInvited(participant) };
}
