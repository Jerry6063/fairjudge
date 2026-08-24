/**
 * The door the invited party holds (doc 05 §A.4, §A.5) — `server/participation/door.ts`.
 *
 * `tests/respond-entry.test.ts` covers what the arrival screen says. This suite
 * covers what the machinery behind it does, and every case here is a rule that
 * doc 05 states as a decision rather than as a description:
 *
 *   1. **Three credentials open the route.** The invite, the identity, and — new
 *      — the share token on the document the client actually has a button for.
 *      Until this wave that third link landed the person it was addressed to on
 *      "this link did not open anything", which is the third instance in this
 *      product of a document promising a route that is not there.
 *   2. **A decline closes minting and opens a standing door.** Her refusal is
 *      recorded as her own act, the client can mint her nothing further, and the
 *      single-use invitation she is holding stops expiring.
 *   3. **A decline is reversible by its author.** Her words survive the reversal;
 *      a change of mind is a second act, not an erasure of the first.
 *   4. **Expiry writes nothing.** A token ageing out is credential hygiene. It
 *      is not a case event, it moves no participation state, and nothing about
 *      the merits may move on a timer.
 *   5. **Opening a page is not an act.** Resolving any credential, by any path,
 *      leaves the database byte-identical.
 *
 * Nothing here sends an invitation anywhere: `issueInviteToken` returns a string
 * to its caller and the machinery stops. The persona is a local fixture.
 *
 * Evidence content is Chinese and stays Chinese — records of what people said,
 * quoted verbatim inside English prose (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  InviteError,
  issueInviteToken,
  redeemInviteToken,
  verifyInviteToken,
} from "../src/server/access";
import { recordConsent } from "../src/server/access/consent";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  clarificationRounds,
  judgmentRenditions,
  judgments,
} from "../src/server/db/schema";
import { hashShareToken } from "../src/server/judgment/rendition";
import {
  readOwnClarification,
  answerOwnClarification,
} from "../src/server/participation/clarification";
import {
  readDoorStanding,
  reopenParticipation,
  resolveArrival,
  revokeStandingDoor,
} from "../src/server/participation/door";
import { buildCounterpartyEntry } from "../src/server/participation/entry";
import {
  DECLINE_CONSEQUENCES,
  declineParticipation,
  resolveRespondingParty,
  submitStatement,
} from "../src/server/participation/submission";
import { recordClarificationRound } from "../src/server/pipeline/clarification";

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** Her reason, in her own words. Verbatim, untranslated, never normalized. */
const HER_REASON = "我不想把这件事交给一个程序来评判。";
/** Her account, if she gives one. Two lines, so the split is exercised. */
const HER_STATEMENT = "我那天在医院。\n我没有收到那条消息。";

let db: Db;
let sqlite: Database.Database;
let caseId: string;
let clientId: string;
let respondentId: string;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);

  const [row] = db
    .insert(cases)
    .values({ stage: "participation", outputLevel: "L2" })
    .returning()
    .all();
  caseId = row.id;

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      { caseId, role: "respondent", pseudonym: "甲", isSubmitter: false },
    ])
    .returning()
    .all();
  clientId = parties.find((party) => party.isSubmitter)!.id;
  respondentId = parties.find((party) => !party.isSubmitter)!.id;
});

afterEach(() => {
  sqlite.close();
});

function row() {
  return db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.id, respondentId))
    .get()!;
}

/** Every row in the database, as one comparable value. */
function snapshot(): string {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map((table) => [
      table.name,
      sqlite.prepare(`SELECT * FROM "${table.name}"`).all(),
    ]),
  );
}

/**
 * A frozen judgment with a shareable rendition, and the share token for it.
 *
 * The rendition row is written directly rather than generated: what is under
 * test is whether the door accepts the credential, and the document's own
 * content, gating and expiry belong to `readSharedRendition`, which this module
 * calls rather than reimplements.
 */
function mintShareLink(token: string, expiresAt: Date | null = null): void {
  const [judgment] = db
    .insert(judgments)
    .values({
      caseId,
      version: 1,
      status: "final",
      model: "claude-fable-5",
      outputLevel: "L2",
      finalizedAt: new Date("2026-08-01T00:00:00Z"),
    })
    .returning()
    .all();

  db.insert(judgmentRenditions)
    .values({
      judgmentId: judgment.id,
      kind: "shareable",
      shareable: true,
      shareTokenHash: hashShareToken(token),
      shareExpiresAt: expiresAt,
    })
    .run();
}

/* -------------------------------------------------------------------------- */
/* 1. Which credentials open the route                                        */
/* -------------------------------------------------------------------------- */

describe("the credentials that open /respond", () => {
  it("opens for a live invitation", () => {
    const invite = issueInviteToken(db, respondentId);
    const outcome = resolveArrival(db, invite.token);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.arrival.via).toBe("invite");
    expect(outcome.arrival.participant.id).toBe(respondentId);
  });

  it("opens for the identity token she got in exchange for it", () => {
    const invite = issueInviteToken(db, respondentId);
    const redeemed = redeemInviteToken(db, invite.token);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    const outcome = resolveArrival(db, redeemed.identityToken);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.arrival.via).toBe("identity");
    expect(outcome.arrival.identity).not.toBeNull();
  });

  it("opens for the share token the client's own button mints", () => {
    // The defect this closes: `mintShareLinkAction` returns `/respond/<share
    // token>`, the document's last line points at it, and the route could not
    // resolve it — so the client's share panel shipped carrying a warning not
    // to hand the link over.
    mintShareLink("share-token-fixture");

    const outcome = resolveArrival(db, "share-token-fixture");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.arrival.via).toBe("share");
    // Resolved to the party the document was written to — the one participant
    // on this case who did not bring it.
    expect(outcome.arrival.participant.id).toBe(respondentId);
    expect(outcome.arrival.participant.pseudonym).toBe("甲");
  });

  it("gives the share token the whole entry screen, not a stub", () => {
    mintShareLink("share-token-fixture");
    const entry = buildCounterpartyEntry(db, "share-token-fixture");

    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.view.intro.yourPseudonym).toBe("甲");
    expect(entry.view.door.via).toBe("share");
  });

  it("lets her write with it too, so the exits on that screen work", () => {
    mintShareLink("share-token-fixture");
    const party = resolveRespondingParty(db, "share-token-fixture");

    expect(party?.participant.id).toBe(respondentId);
    expect(party?.via).toBe("share");
  });

  it("refuses an expired share token, a spent one, and an invented one", () => {
    mintShareLink("stale-share-token", new Date("2026-01-01T00:00:00Z"));

    expect(resolveArrival(db, "stale-share-token").ok).toBe(false);
    expect(resolveArrival(db, "never-minted").ok).toBe(false);
    expect(resolveArrival(db, "").ok).toBe(false);
  });

  it("does not hand a share token to a case with two non-submitters", () => {
    // The recipient is a lookup, not a guess: with more than one candidate the
    // export gate refuses to name one, and so does this. (`role` is unique per
    // case, so the second candidate is made by unsetting the submitter flag —
    // which is exactly the shape a case takes when nobody is marked as having
    // filed it.)
    db.update(caseParticipants)
      .set({ isSubmitter: false })
      .where(eq(caseParticipants.id, clientId))
      .run();
    mintShareLink("share-token-fixture");

    expect(resolveArrival(db, "share-token-fixture").ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Opening a page is not an act                                            */
/* -------------------------------------------------------------------------- */

describe("reading is not recorded", () => {
  it("writes nothing, on any credential, however many times", () => {
    const invite = issueInviteToken(db, respondentId);
    const redeemed = redeemInviteToken(db, invite.token);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    mintShareLink("share-token-fixture");

    const before = snapshot();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      resolveArrival(db, redeemed.identityToken);
      resolveArrival(db, "share-token-fixture");
      resolveArrival(db, "not-a-token");
      buildCounterpartyEntry(db, redeemed.identityToken);
      buildCounterpartyEntry(db, "share-token-fixture");
    }

    // Including `last_seen_at` on the identity, which the old path stamped.
    expect(snapshot()).toEqual(before);
  });

  it("has no function left that records an open", async () => {
    const invite = await import("../src/server/access/invite");
    expect("markInviteOpened" in invite).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. What a decline does                                                     */
/* -------------------------------------------------------------------------- */

describe("declining", () => {
  it("records refused as her own act, and keeps her words", () => {
    issueInviteToken(db, respondentId);
    const outcome = declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    expect(outcome.respondState).toBe("declined");
    expect(outcome.participationState).toBe("refused");
    expect(outcome.reason).toBe(HER_REASON);
    // Her own act supersedes his report of her.
    expect(row().participationState).toBe("refused");
    expect(row().declineReason).toBe(HER_REASON);
  });

  it("closes the client's minting for her, at the mint and not at a screen", () => {
    issueInviteToken(db, respondentId);
    declineParticipation(db, { caseId, participantId: respondentId });

    expect(() => issueInviteToken(db, respondentId)).toThrowError(InviteError);
    try {
      issueInviteToken(db, respondentId);
      expect.unreachable("a declined party may not be re-invited");
    } catch (cause) {
      expect((cause as InviteError).code).toBe("participant_declined");
    }

    expect(readDoorStanding(db, respondentId)?.mintingClosed).toBe(true);
  });

  it("turns the single-use invitation into her standing door", () => {
    const invite = issueInviteToken(db, respondentId);
    expect(row().inviteTokenExpiresAt).not.toBeNull();

    const outcome = declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    expect(outcome.standingDoor).toBe(true);
    expect(row().inviteTokenExpiresAt).toBeNull();
    expect(readDoorStanding(db, respondentId)?.standing).toBe(true);

    // And it is the SAME link. A decline that handed her a new secret would be
    // a decline she could only act on if she had saved it.
    const far = new Date("2099-01-01T00:00:00Z");
    expect(verifyInviteToken(db, invite.token, { now: far }).ok).toBe(true);
    expect(resolveArrival(db, invite.token, { now: far }).ok).toBe(true);
  });

  it("deletes nothing she had already submitted", () => {
    issueInviteToken(db, respondentId);
    submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_STATEMENT,
    });

    const outcome = declineParticipation(db, { caseId, participantId: respondentId });
    expect(outcome.kept.evidence).toBe(1);
    expect(outcome.kept.utterances).toBe(2);
  });

  it("states its consequences in the same words the write delivers", () => {
    // The list the confirmation screen renders is exported by the module that
    // performs the write, so the promise and the transaction cannot drift.
    expect(DECLINE_CONSEQUENCES).toHaveLength(4);
    const all = DECLINE_CONSEQUENCES.join(" ");
    expect(all).toContain("refused");
    expect(all).toContain("stands unchanged");
    expect(all).toContain("invited on a date, declined on a date");
    expect(all).toContain("You keep this door");
    // The no-inference sentence is explicit rather than left to be understood,
    // and nothing in the list reads her refusal as an admission of anything.
    expect(all).toContain("Nothing may be inferred from it");
    expect(all).toContain("Silence and refusal are not evidence of anything");
    expect(all).not.toMatch(/admits|admission|counts against|held against/i);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Reversing it                                                            */
/* -------------------------------------------------------------------------- */

describe("reversing a decline", () => {
  it("puts her back to undecided and keeps what she wrote", () => {
    issueInviteToken(db, respondentId);
    declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    const outcome = reopenParticipation(db, { caseId, participantId: respondentId });

    expect(outcome.reversed).toBe(true);
    expect(outcome.respondState).toBe("invited");
    expect(outcome.participationState).toBe("pending");
    // A change of mind is a second act, not an erasure of the first.
    expect(outcome.declineReason).toBe(HER_REASON);
    expect(row().declineReason).toBe(HER_REASON);
  });

  it("lets her consent afterwards, through the ordinary path", () => {
    issueInviteToken(db, respondentId);
    declineParticipation(db, { caseId, participantId: respondentId });
    reopenParticipation(db, { caseId, participantId: respondentId });

    const submitted = submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_STATEMENT,
    });

    expect(submitted.participationState).toBe("written_response");
    expect(submitted.consent.kind).toBe("granted");
    expect(submitted.consent.scope).toBe("case_record");
    expect(row().respondState).toBe("invited");
  });

  it("reopens minting for nobody but her — the client still cannot re-invite", () => {
    issueInviteToken(db, respondentId);
    declineParticipation(db, { caseId, participantId: respondentId });
    reopenParticipation(db, { caseId, participantId: respondentId });

    // She reversed it, so the row no longer says `declined` and a fresh mint is
    // allowed again. That is the correct answer: the block existed to stop him
    // asking again over her refusal, and there is no refusal standing.
    expect(() => issueInviteToken(db, respondentId)).not.toThrow();
  });

  it("does nothing to a party who never declined", () => {
    issueInviteToken(db, respondentId);
    const outcome = reopenParticipation(db, { caseId, participantId: respondentId });

    expect(outcome.reversed).toBe(false);
    expect(row().respondState).toBe("invited");
  });

  it("lets her close her own door, and only her", () => {
    const invite = issueInviteToken(db, respondentId);
    declineParticipation(db, { caseId, participantId: respondentId });

    const revocation = revokeStandingDoor(db, respondentId);
    expect(revocation.revoked).toBe(true);
    expect(resolveArrival(db, invite.token).ok).toBe(false);
    expect(row().inviteTokenHash).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Expiry is credential hygiene                                            */
/* -------------------------------------------------------------------------- */

describe("an invitation that ages out", () => {
  it("writes nothing anywhere — no case event, no state move", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const invite = issueInviteToken(db, respondentId, { ttlMs: 1_000, now });
    const before = snapshot();

    const later = new Date(now.getTime() + 60 * 60 * 1000);
    expect(verifyInviteToken(db, invite.token, { now: later }).ok).toBe(false);
    expect(resolveArrival(db, invite.token, { now: later }).ok).toBe(false);
    expect(buildCounterpartyEntry(db, invite.token, { now: later }).ok).toBe(false);

    expect(snapshot()).toEqual(before);
    expect(row().respondState).toBe("invited");
    expect(row().participationState).toBe("pending");
  });

  it("surfaces nothing adverse, and lets the client mint again", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    issueInviteToken(db, respondentId, { ttlMs: 1_000, now });
    const later = new Date(now.getTime() + 60 * 60 * 1000);

    const standing = readDoorStanding(db, respondentId, { now: later });
    expect(standing?.expired).toBe(true);
    // Expiry is not a refusal and not a state: her participation is untouched
    // and there is nothing about it for a document to report.
    expect(standing?.participationState).toBe("pending");
    expect(standing?.mintingClosed).toBe(false);

    // Re-minting after an expiry is the client's own recorded act, and one live
    // token at a time: the previous link stops working.
    const first = issueInviteToken(db, respondentId, { ttlMs: 1_000, now });
    const second = issueInviteToken(db, respondentId, { now: later });
    expect(verifyInviteToken(db, first.token, { now: later }).ok).toBe(false);
    expect(verifyInviteToken(db, second.token, { now: later }).ok).toBe(true);
    expect(readDoorStanding(db, respondentId, { now: later })?.lastMintedAt).toEqual(
      later,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Her clarification round                                                 */
/* -------------------------------------------------------------------------- */

describe("the clarification round on her side", () => {
  it("never shows her a round opened before her material was in the record", () => {
    // The client's own rounds run in stage ④, long before an invitation exists.
    const round = recordClarificationRound(db, {
      caseId,
      questions: [{ question: "他那天几点回的消息？" }],
    });
    // Backdated, because the fixture opens it milliseconds before her grant and
    // the rule is about which side of that grant the round falls on.
    db.update(clarificationRounds)
      .set({ createdAt: new Date("2026-07-01T00:00:00Z") })
      .where(eq(clarificationRounds.id, round.round.id))
      .run();

    issueInviteToken(db, respondentId);
    submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_STATEMENT,
    });

    const own = readOwnClarification(db, caseId, respondentId);
    expect(own.round).toBeNull();
    expect(own.otherRoundOpen).toBe(true);
  });

  it("shows her a round opened after it, inside the shared budget", () => {
    issueInviteToken(db, respondentId);
    submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_STATEMENT,
      now: new Date("2026-08-01T00:00:00Z"),
    });

    recordClarificationRound(db, {
      caseId,
      questions: [{ question: "你那天在医院待了多久？" }],
    });

    const own = readOwnClarification(db, caseId, respondentId);
    expect(own.round?.questions).toHaveLength(1);
    expect(own.budget.maxRounds).toBe(3);
    expect(own.budget.maxQuestionsPerRound).toBe(3);
    expect(own.roundsUsed).toBe(1);

    const after = answerOwnClarification(db, {
      caseId,
      participantId: respondentId,
      questionId: own.round!.questions[0].id,
      answer: "从早上十点到下午三点。",
    });
    // Answering the last open question closes the round.
    expect(after.round).toBeNull();
    expect(
      db
        .select()
        .from(clarificationRounds)
        .where(eq(clarificationRounds.caseId, caseId))
        .get()?.closedAt,
    ).not.toBeNull();
  });

  it("shows her nothing while she has granted nothing", () => {
    issueInviteToken(db, respondentId);
    recordClarificationRound(db, { caseId, questions: [{ question: "？" }] });

    expect(readOwnClarification(db, caseId, respondentId).round).toBeNull();
  });

  it("shows her nothing once she has revoked the grant", () => {
    issueInviteToken(db, respondentId);
    submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_STATEMENT,
      now: new Date("2026-08-01T00:00:00Z"),
    });
    recordClarificationRound(db, { caseId, questions: [{ question: "？" }] });
    expect(readOwnClarification(db, caseId, respondentId).round).not.toBeNull();

    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "revoked",
      scope: "case_record",
      occurredAt: new Date("2026-08-02T00:00:00Z"),
    });

    expect(readOwnClarification(db, caseId, respondentId).round).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Nobody is chased                                                        */
/* -------------------------------------------------------------------------- */

describe("the absence of a nudge", () => {
  it("has no mechanism that contacts, reminds or chases the invited party", async () => {
    // Doc 05 §A.4: Matterhorn's remand loop has a court's authority to summon;
    // this product has none, and an automated cadence aimed at somebody who owes
    // it nothing is the Utah fluency advantage rebuilt in miniature. Asserted as
    // a property of the modules rather than as a promise in a comment.
    const invite = await import("../src/server/access/invite");
    const door = await import("../src/server/participation/door");
    const submission = await import("../src/server/participation/submission");

    const names = [
      ...Object.keys(invite),
      ...Object.keys(door),
      ...Object.keys(submission),
    ];
    expect(
      names.filter((name) =>
        /remind|nudge|chase|notify|resend|deadline|escalat/i.test(name),
      ),
    ).toEqual([]);
  });

  it("keeps the client out of her decision entirely", () => {
    issueInviteToken(db, respondentId);
    declineParticipation(db, { caseId, participantId: respondentId });

    // Nothing the client can reach reverses her answer: `reopenParticipation`
    // is bound to the participant the token resolved to, and the only route
    // that calls it is behind her own credential.
    const clientSide = reopenParticipation(db, {
      caseId,
      participantId: clientId,
    });
    expect(clientSide.reversed).toBe(false);
    expect(row().respondState).toBe("declined");
  });
});
