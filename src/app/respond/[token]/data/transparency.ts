/**
 * Data layer for the counterparty's transparency view (SPEC M5 ②④).
 *
 * `/respond/[token]` is the one place in this product a person arrives holding
 * nothing but a link, so everything on this path has to work from the token
 * alone. This module is the read half of that: token in, a view of everything
 * held about her out, and never a write — the acts (opening, joining,
 * declining, deleting) belong to the screen and its server actions, not to a
 * loader that a refresh can run twice.
 *
 * ## Two tokens, one entrance
 *
 * The invite token is single-use and is spent by redeeming it; the identity
 * token is what brings her back afterwards. Both must land here, because the
 * transparency view is exactly what she needs *before* deciding whether to join
 * — she should be able to see what this machine holds about her without first
 * having to become a user of it — and also afterwards, whenever she wants to
 * check again. `resolveRespondToken` tries the identity token first: it is the
 * long-lived one, so a returning reader is the common case.
 *
 * ## Nothing is loaded before the token is
 *
 * A refused token returns a refusal and nothing else. There is no partial page,
 * no "here is the case title but not the rest": if the link is not good, this
 * module has established nothing about who is asking, and a page that renders a
 * case title to an unknown holder has already leaked the thing that matters.
 */

import {
  buildTransparencyView,
  deletionRightsFor,
  listDeletionRequests,
  resolveIdentityToken,
  verifyInviteToken,
  type DeletionRequestRecord,
  type DeletionRights,
  type TransparencyView,
} from "../../../../server/access";
import { getDb, type Db } from "../../../../server/db";

/* -------------------------------------------------------------------------- */
/* Who is holding the link                                                    */
/* -------------------------------------------------------------------------- */

/** Which token opened the door. The page says so, because they differ. */
export type RespondTokenKind = "invite" | "identity";

export interface RespondSubject {
  readonly participantId: string;
  readonly caseId: string;
  /** Her egress token (甲 / 乙). Her real name never leaves this machine. */
  readonly pseudonym: string;
  readonly tokenKind: RespondTokenKind;
  /** True once she has an account; false while she is only holding an invitation. */
  readonly hasAccount: boolean;
}

export type RespondTokenRefusal =
  | "unknown_token"
  | "expired"
  | "already_redeemed"
  | "database_unavailable";

export type RespondTokenResolution =
  | { readonly ok: true; readonly subject: RespondSubject }
  | {
      readonly ok: false;
      readonly reason: RespondTokenRefusal;
      /** One sentence, safe to show whoever is holding the link. */
      readonly message: string;
    };

const DATABASE_MESSAGE =
  "This machine cannot open its own database right now, so nothing can be " +
  "shown. Nothing has been lost and nothing has been sent anywhere.";

/**
 * Resolve either token to the party holding it.
 *
 * `touch: false` on the identity path is deliberate: recording that she was
 * last seen is a fact about a visit, and a loader that writes it would record a
 * visit every time a page re-renders. The screen's own action records the
 * visit; this is a read.
 */
export function resolveRespondToken(
  db: Db,
  token: string,
): RespondTokenResolution {
  const returning = resolveIdentityToken(db, token, { touch: false });
  if (returning !== null) {
    return {
      ok: true,
      subject: {
        participantId: returning.participant.id,
        caseId: returning.participant.caseId,
        pseudonym: returning.participant.pseudonym,
        tokenKind: "identity",
        hasAccount: true,
      },
    };
  }

  const invited = verifyInviteToken(db, token);
  if (invited.ok) {
    return {
      ok: true,
      subject: {
        participantId: invited.participant.id,
        caseId: invited.participant.caseId,
        pseudonym: invited.participant.pseudonym,
        tokenKind: "invite",
        hasAccount: false,
      },
    };
  }

  return { ok: false, reason: invited.reason, message: invited.message };
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransparencyPageData {
  readonly subject: RespondSubject;
  /** Everything this machine holds that concerns her, with provenance. */
  readonly view: TransparencyView;
  /** What she may do about it — deletion counts plus where consent stands. */
  readonly rights: DeletionRights;
  /** Deletion she has asked for, and the answers she has been given. */
  readonly requests: readonly DeletionRequestRecord[];
}

export type TransparencyPageResult =
  | { readonly ok: true; readonly data: TransparencyPageData }
  | {
      readonly ok: false;
      readonly reason: RespondTokenRefusal;
      readonly message: string;
    };

/**
 * Load the transparency page for whoever holds this token.
 *
 * Pure read. It opens the database itself so a server component can call it
 * without threading a handle through, and it catches the one failure a page
 * cannot do anything about — an unopenable database — into a refusal rather
 * than a stack trace on somebody's screen.
 */
export function loadTransparencyPage(token: string): TransparencyPageResult {
  let db: Db;
  try {
    db = getDb();
  } catch {
    return {
      ok: false,
      reason: "database_unavailable",
      message: DATABASE_MESSAGE,
    };
  }

  const resolved = resolveRespondToken(db, token);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, message: resolved.message };
  }

  return { ok: true, data: loadTransparencyFor(db, resolved.subject) };
}

/**
 * The same page, for a subject already resolved.
 *
 * Split out so the entry screen — which has resolved the token already, and
 * may have written her arrival — can render the view without a second token
 * round trip, and so tests can drive it against a fixture participant.
 */
export function loadTransparencyFor(
  db: Db,
  subject: RespondSubject,
): TransparencyPageData {
  return {
    subject,
    view: buildTransparencyView(db, subject.caseId, subject.participantId),
    rights: deletionRightsFor(db, subject.caseId, subject.participantId),
    requests: listDeletionRequests(db, subject.caseId, {
      requestedBy: subject.participantId,
    }),
  };
}
