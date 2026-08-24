// The read model for `/respond/[token]/decline`.
//
// Split out of the page so the server actions can return the same shape they
// render from: a panel that patched its own state after a write would be showing
// her its guess at what the database now says, on the one screen in this product
// where the gap between "what you were told would happen" and "what happened" is
// the whole subject.

import { eq } from "drizzle-orm";

import type { Db } from "../../../../server/db";
import {
  caseParticipants,
  type ParticipationState,
  type RespondState,
} from "../../../../server/db/schema";
import { readDoorStanding } from "../../../../server/participation/door";
import type { RespondingParty } from "../../../../server/participation/submission";

export interface DeclineState {
  readonly token: string;
  readonly caseId: string;
  readonly participantId: string;
  readonly pseudonym: string;
  readonly respondState: RespondState;
  readonly participationState: ParticipationState;
  /** Her words when she declined. Verbatim; kept through a reversal. */
  readonly declineReason: string | null;
  /** Null once the link has no deadline: her standing door. */
  readonly expiresAt: string | null;
  readonly standing: boolean;
  readonly mintingClosed: boolean;
  readonly hasAccount: boolean;
}

/** Everything the decline screen renders, from the database, after any write. */
export function readDeclineState(
  db: Db,
  token: string,
  party: RespondingParty,
): DeclineState {
  const standing = readDoorStanding(db, party.participant.id);

  return {
    token,
    caseId: party.participant.caseId,
    participantId: party.participant.id,
    pseudonym: party.participant.pseudonym,
    respondState: standing?.respondState ?? party.participant.respondState,
    participationState: standing?.participationState ?? "pending",
    declineReason: readDeclineReason(db, party.participant.id),
    expiresAt: standing?.expiresAt?.toISOString() ?? null,
    standing: standing?.standing ?? false,
    mintingClosed: standing?.mintingClosed ?? false,
    hasAccount: standing?.hasAccount ?? false,
  };
}

/** Her reason, read straight off the row. Never normalized, never translated. */
function readDeclineReason(db: Db, participantId: string): string | null {
  const row = db
    .select({ reason: caseParticipants.declineReason })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, participantId))
    .get();
  return row?.reason ?? null;
}
