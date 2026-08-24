/**
 * Invite tokens and the identity they redeem into (SPEC M5 ①).
 *
 * Everything here runs against a local fixture persona. This suite never sends
 * anything anywhere — `issueInviteToken` returns a string to its caller and the
 * machinery stops, which is the design, not a limitation of the test.
 *
 * What is worth asserting is not that a token round-trips. It is the three
 * properties the product's promise rests on, each attacked directly:
 *
 *   1. the plaintext is never in the database — a stolen copy of the file is not
 *      a working invitation into somebody's relationship;
 *   2. redemption is single-use, and the second attempt is told so in a way that
 *      does not read as "you made that link up";
 *   3. expiry is real, and refused with its own reason.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INVITE_TOKEN_TTL_MS,
  InviteError,
  hasIdentity,
  hashInviteToken,
  issueInviteToken,
  readIdentity,
  redeemInviteToken,
  resolveIdentityToken,
  verifyInviteToken,
} from "../src/server/access";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  participantIdentities,
} from "../src/server/db/schema";
import { readParticipationEvidence } from "../src/server/pipeline";

let db: Db;
let sqlite: Database.Database;
let caseId: string;
let clientId: string;
let respondentId: string;

/** A case with the client who filed it and a fixture counterparty. */
function seedCase(): void {
  const [row] = db.insert(cases).values({ stage: "participation" }).returning().all();
  caseId = row.id;

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId,
        role: "initiator",
        displayName: "FIXTURE_CLIENT",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId,
        role: "respondent",
        displayName: "FIXTURE_RESPONDENT",
        pseudonym: "甲",
        isSubmitter: false,
      },
    ])
    .returning()
    .all();

  clientId = parties.find((party) => party.isSubmitter)!.id;
  respondentId = parties.find((party) => !party.isSubmitter)!.id;
}

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
  seedCase();
});

afterEach(() => {
  sqlite.close();
});

function participantRow() {
  return db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, respondentId))
    .get()!;
}

describe("what is stored", () => {
  it("keeps the hash and never the token", () => {
    const invite = issueInviteToken(db, respondentId);
    const row = participantRow();

    expect(row.inviteTokenHash).toBe(hashInviteToken(invite.token));
    expect(row.inviteTokenHash).not.toBe(invite.token);

    // Not "the column does not hold it" — the token must not be anywhere in the
    // file, including a column nobody thought about.
    const dump = JSON.stringify(
      sqlite.prepare("SELECT * FROM case_participants").all(),
    );
    expect(dump).not.toContain(invite.token);
  });

  it("records when it was issued and when it dies", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const invite = issueInviteToken(db, respondentId, { now });

    expect(invite.expiresAt.getTime()).toBe(now.getTime() + INVITE_TOKEN_TTL_MS);
    expect(participantRow().inviteTokenIssuedAt).toEqual(now);
    expect(participantRow().inviteTokenRedeemedAt).toBeNull();
  });

  it("marks the party as invited without touching the client's participation report", () => {
    issueInviteToken(db, respondentId);

    expect(participantRow().respondState).toBe("invited");
    // `participation_state` is the client's account of what happened when she
    // was asked. Minting a link is not her answer.
    expect(participantRow().participationState).toBe("pending");
  });
});

describe("who may be invited", () => {
  it("refuses the person who filed the case", () => {
    expect(() => issueInviteToken(db, clientId)).toThrowError(InviteError);
    try {
      issueInviteToken(db, clientId);
    } catch (error) {
      expect((error as InviteError).code).toBe("cannot_invite_submitter");
    }
  });

  it("refuses an unknown participant", () => {
    expect(() => issueInviteToken(db, "no-such-participant")).toThrowError(
      /No participant with id/,
    );
  });

  it("refuses a second invitation once one has been redeemed", () => {
    const invite = issueInviteToken(db, respondentId);
    expect(redeemInviteToken(db, invite.token).ok).toBe(true);

    try {
      issueInviteToken(db, respondentId);
      expect.unreachable("a redeemed party must not be re-invited");
    } catch (error) {
      expect((error as InviteError).code).toBe("already_redeemed");
    }
  });
});

describe("verifying", () => {
  it("accepts a live token and names whose it is", () => {
    const invite = issueInviteToken(db, respondentId);
    const check = verifyInviteToken(db, invite.token);

    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.participant.id).toBe(respondentId);
      expect(check.participant.pseudonym).toBe("甲");
      // The real name is not in the view a token resolves to.
      expect(JSON.stringify(check.participant)).not.toContain("FIXTURE_RESPONDENT");
    }
  });

  it("may be called any number of times — a reload is not a replay", () => {
    const invite = issueInviteToken(db, respondentId);

    expect(verifyInviteToken(db, invite.token).ok).toBe(true);
    expect(verifyInviteToken(db, invite.token).ok).toBe(true);
    expect(verifyInviteToken(db, invite.token).ok).toBe(true);
    expect(participantRow().inviteTokenRedeemedAt).toBeNull();
  });

  it("refuses a token nobody issued", () => {
    issueInviteToken(db, respondentId);
    const check = verifyInviteToken(db, "not-a-token-anyone-minted");

    expect(check).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("refuses an empty token without reaching the database", () => {
    expect(verifyInviteToken(db, "   ")).toMatchObject({
      ok: false,
      reason: "unknown_token",
    });
  });

  it("refuses an expired token with its own reason", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const invite = issueInviteToken(db, respondentId, { ttlMs: 1000, now });

    expect(
      verifyInviteToken(db, invite.token, { now: new Date(now.getTime() + 999) }).ok,
    ).toBe(true);
    expect(
      verifyInviteToken(db, invite.token, { now: new Date(now.getTime() + 1000) }),
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("stops honouring the previous token when a new one is issued", () => {
    const first = issueInviteToken(db, respondentId);
    const second = issueInviteToken(db, respondentId);

    expect(verifyInviteToken(db, first.token)).toMatchObject({
      ok: false,
      reason: "unknown_token",
    });
    expect(verifyInviteToken(db, second.token).ok).toBe(true);
  });
});

describe("redeeming", () => {
  it("creates exactly one identity and spends the token", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const invite = issueInviteToken(db, respondentId, { now });
    const outcome = redeemInviteToken(db, invite.token, {
      displayName: "FIXTURE_RESPONDENT",
      now,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.participant.redeemedAt).toEqual(now);
    expect(outcome.participant.respondState).toBe("joined");
    expect(readIdentity(db, respondentId)?.id).toBe(outcome.identity.id);
    expect(
      db.select().from(participantIdentities).all(),
    ).toHaveLength(1);
  });

  it("refuses a replay, and does not pretend the token never existed", () => {
    const invite = issueInviteToken(db, respondentId);
    expect(redeemInviteToken(db, invite.token).ok).toBe(true);

    const replay = redeemInviteToken(db, invite.token);
    expect(replay).toMatchObject({ ok: false, reason: "already_redeemed" });
    // The distinction is the point: the person holding this link did nothing
    // wrong and already has an account.
    if (!replay.ok) expect(replay.reason).not.toBe("unknown_token");

    expect(db.select().from(participantIdentities).all()).toHaveLength(1);
  });

  it("refuses an expired token", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const invite = issueInviteToken(db, respondentId, { ttlMs: 1000, now });

    const outcome = redeemInviteToken(db, invite.token, {
      now: new Date(now.getTime() + 5000),
    });

    expect(outcome).toMatchObject({ ok: false, reason: "expired" });
    expect(hasIdentity(db, respondentId)).toBe(false);
    expect(participantRow().inviteTokenRedeemedAt).toBeNull();
  });

  it("does not settle her participation — an account is not an answer", () => {
    const invite = issueInviteToken(db, respondentId);
    redeemInviteToken(db, invite.token);

    // She may still decline from here; only her own later act writes that.
    expect(participantRow().participationState).toBe("pending");
  });

  it("makes `responded` true for the participation derivation", () => {
    expect(readParticipationEvidence(db, caseId).responded).toBe(false);

    const invite = issueInviteToken(db, respondentId);
    redeemInviteToken(db, invite.token);

    expect(readParticipationEvidence(db, caseId)).toEqual({
      invited: true,
      responded: true,
      // Taking up an account is not declining, and the two facts are read
      // separately — see `server/participation/submission.ts` for the write.
      declined: false,
    });
  });

  it("stores only the hash of the identity token", () => {
    const invite = issueInviteToken(db, respondentId);
    const outcome = redeemInviteToken(db, invite.token);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const dump = JSON.stringify(
      sqlite.prepare("SELECT * FROM participant_identities").all(),
    );
    expect(dump).not.toContain(outcome.identityToken);
    expect(dump).toContain(hashInviteToken(outcome.identityToken));
  });
});

describe("coming back afterwards", () => {
  it("resolves the identity token to its participant", () => {
    const invite = issueInviteToken(db, respondentId);
    const outcome = redeemInviteToken(db, invite.token);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const resolved = resolveIdentityToken(db, outcome.identityToken);
    expect(resolved?.participant.id).toBe(respondentId);
    expect(resolved?.identity.id).toBe(outcome.identity.id);
  });

  it("resolves nothing for a token that is not one", () => {
    const invite = issueInviteToken(db, respondentId);
    redeemInviteToken(db, invite.token);

    expect(resolveIdentityToken(db, "made-up")).toBeNull();
    expect(resolveIdentityToken(db, "")).toBeNull();
    // The spent invite token is not an identity token.
    expect(resolveIdentityToken(db, invite.token)).toBeNull();
  });
});

describe("opening the invitation", () => {
  // There is no `markInviteOpened` any more, and this block is what is left of
  // the three cases that exercised it. Doc 05 §A.5 question 3 makes the entry
  // screen state that opening the page is not reported to anyone and that
  // reading is not recorded as an act — so the function that recorded it was
  // deleted rather than left uncalled, and the property under test is now the
  // absence of a transition rather than the correctness of one.
  it("moves nothing when a link is merely verified, however often", () => {
    const invite = issueInviteToken(db, respondentId);
    const at = participantRow().respondStateAt;

    verifyInviteToken(db, invite.token);
    verifyInviteToken(db, invite.token);
    verifyInviteToken(db, invite.token);

    expect(participantRow().respondState).toBe("invited");
    expect(participantRow().respondStateAt).toEqual(at);
  });

  it("refuses a new link once she has declined", () => {
    const reason = "我不想参与这件事。";
    db.update(caseParticipants)
      .set({ respondState: "declined", declineReason: reason })
      .where(eq(caseParticipants.id, respondentId))
      .run();

    // Doc 05 §A.4: no re-invite stream after a refusal. Asking again is not
    // the client's business once she has answered.
    expect(() => issueInviteToken(db, respondentId)).toThrowError(InviteError);
    try {
      issueInviteToken(db, respondentId);
      expect.unreachable("minting must be closed after a decline");
    } catch (cause) {
      expect((cause as InviteError).code).toBe("participant_declined");
    }

    expect(participantRow().respondState).toBe("declined");
    expect(participantRow().declineReason).toBe(reason);
  });
});
