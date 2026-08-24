"use server";

// Server actions for `/respond/[token]/decline` — refusing, and taking it back.
//
// Three acts, all of them hers: record the refusal, reverse it, and close her
// own door. Every one re-resolves the token against the database and derives the
// participant from it; none of them takes a participant id, a case id or an
// owner from the request. The token is the only thing the caller supplies that
// decides anything, and it is checked against a stored hash on every call.
//
// There is deliberately no action here for the other direction. Nothing the
// client can post reverses her decline, closes her door or re-opens minting —
// the rules those depend on are enforced in `server/participation/door.ts` and
// `server/access/invite.ts`, where a screen cannot route around them.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb, type Db } from "../../../../server/db";
import {
  reopenParticipation,
  revokeStandingDoor,
} from "../../../../server/participation/door";
import {
  SubmissionError,
  declineParticipation,
  resolveRespondingParty,
  type RespondingParty,
} from "../../../../server/participation/submission";
import { readDeclineState, type DeclineState } from "./state";

const badToken: ActionResult<never> = {
  ok: false,
  code: "bad_token",
  message:
    "This link is not one this machine issued, or it has expired. Nothing you " +
    "have already recorded is affected, and a fresh link opens the same place.",
};

const badRequest: ActionResult<never> = {
  ok: false,
  code: "bad_request",
  message: "That request did not arrive intact. Reload the page and try again.",
};

/** Resolve the token, run the work, normalize the failures. */
function withParty<T>(
  token: string,
  work: (db: Db, party: RespondingParty) => T,
): ActionResult<T> {
  const db = getDb();
  const party = resolveRespondingParty(db, token);
  if (party === null) return badToken;

  try {
    const data = work(db, party);
    revalidatePath(`/respond/${token}/decline`);
    return { ok: true, data };
  } catch (cause) {
    if (cause instanceof SubmissionError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}

const reasonSchema = z.object({
  reason: z.string().max(2_000).nullable().optional(),
});

/**
 * Record that she will not take part.
 *
 * The whole of what this does was on the screen before she pressed it
 * (`DECLINE_CONSEQUENCES`), and `declineParticipation` performs all of it in one
 * transaction: her participation becomes `refused` by her own act, her link
 * stops expiring, and the client's minting for her closes.
 */
export async function recordDeclineAction(
  token: string,
  input: unknown,
): Promise<ActionResult<DeclineState>> {
  const parsed = reasonSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) => {
    declineParticipation(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      reason: parsed.data.reason ?? null,
    });
    return readDeclineState(db, token, party);
  });
}

/**
 * Take the decline back.
 *
 * Reversible by her alone (doc 05 §A.4). Her earlier words stay on file — a
 * reversal is a second act, not a retraction of the first — and the screen says
 * so before she presses this too.
 */
export async function reopenAction(
  token: string,
): Promise<ActionResult<DeclineState>> {
  return withParty(token, (db, party) => {
    reopenParticipation(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
    });
    return readDeclineState(db, token, party);
  });
}

/**
 * Close her own door.
 *
 * The one irreversible act on this route, and the screen labels it as such: the
 * hash is cleared and no plaintext exists anywhere to restore it from, so the
 * link stops resolving for good. Offered anyway, because "I want this to stop
 * being a way into anything about me" is a thing a person is entitled to mean,
 * and a door that only the sender can close is not hers.
 */
export async function closeDoorAction(
  token: string,
): Promise<ActionResult<{ readonly revoked: boolean }>> {
  // `revoked` is what the UPDATE actually claimed, not what the caller hoped:
  // a party who has redeemed her invitation has no invite row to clear, and
  // telling her the link is closed would be the product reporting an act it did
  // not perform. The screen renders the two cases differently.
  return withParty(token, (db, party) => ({
    revoked: revokeStandingDoor(db, party.participant.id).revoked,
  }));
}
