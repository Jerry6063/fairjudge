"use server";

// Creating the invitation — the one act on the client's side of the wait.
//
// `issueInviteToken` has existed since M5 ① and, until this file, nothing in the
// product called it. Every test minted one; no person could. So the two-person
// loop that docs 01, 04 and 05 are all written around could not be started from
// the product at all, and the wait surface described a state the product had no
// way to enter.
//
// ## What this action does not do
//
// **It does not deliver anything.** There is no mail here, no webhook, no
// outbound anything, and the omission is the design (`access/invite.ts` states
// it at the module level): sending a real invitation to a real person is an act
// with consequences in somebody's relationship, and it belongs to the client.
// This returns the token to the screen that asked for it and stops.
//
// **It does not decide whether minting is allowed.** `issueInviteToken` does,
// against the row, inside the write — a decline closes minting (doc 05 §A.4) and
// a redeemed invitation closes it for a different reason, and both refusals come
// back with the sentence the rule itself carries rather than one written here.
//
// **It does not take a participant id from the request.** The counterparty is
// resolved server-side from the case, by the same `readParticipation` the stage
// machine and the wait surface use. A request that could name its own recipient
// would be a request that could mint a link into a case for somebody else's row.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../lib/action-result";
import { InviteError, issueInviteToken } from "../../../server/access";
import { getDb } from "../../../server/db";
import { readParticipation } from "../../../server/pipeline";

const inviteSchema = z.object({ caseId: z.string().min(1) });

export interface InviteActionData {
  /** The link, shown once. Only the hash of the token in it is stored. */
  readonly link: string;
  readonly expiresAtIso: string;
  readonly issuedAtIso: string;
  /** Hers, for copy that names who this is for. Never her real name. */
  readonly recipientPseudonym: string;
}

/**
 * Mint one invitation for this case's counterparty and hand it back.
 *
 * The refusals are worth telling apart, so they keep their codes: there is
 * nobody to invite, the party is already here, or she declined and minting is
 * closed. The last of those is not an error state to be worked around — it is
 * the doctrine working, and the screen renders its sentence as a fact.
 */
export async function createInvitationAction(
  input: unknown,
): Promise<ActionResult<InviteActionData>> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message: "That was not a valid request. Refresh the page.",
    };
  }

  const db = getDb();
  const board = readParticipation(db, parsed.data.caseId);
  const her = board.counterparty;
  if (her === null) {
    return {
      ok: false,
      code: "no_counterparty",
      message:
        "This case has no second party on it, so there is nobody to invite.",
    };
  }

  try {
    const invite = issueInviteToken(db, her.id);
    revalidatePath(`/case/${parsed.data.caseId}`);
    return {
      ok: true,
      data: {
        link: `/respond/${invite.token}`,
        expiresAtIso: invite.expiresAt.toISOString(),
        issuedAtIso: invite.issuedAt.toISOString(),
        recipientPseudonym: her.pseudonym,
      },
    };
  } catch (cause) {
    if (cause instanceof InviteError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}
