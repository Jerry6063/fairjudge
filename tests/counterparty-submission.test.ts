/**
 * The counterparty's submission flow (SPEC M5 ②, the write half).
 *
 * Nobody real is invited anywhere by this suite. The counterparty is a local
 * fixture persona, the tokens are minted and read in-process, and no delivery
 * of any kind exists to be tested — that is the design, not a gap in it.
 *
 * Four promises are made to her the moment she is allowed to write into a case
 * about her own relationship, and each is attacked here at the layer that has to
 * keep it, never through a screen:
 *
 *   1. **What she submits is hers and private.** The client cannot read it
 *      through the query layer until she grants that specifically — asserted
 *      against the exported read functions with a participant audience, because
 *      a page that declines to render a row is a convention and a WHERE clause
 *      is not.
 *   2. **Unconfirmed is not citable, for her identically** (HARD RULE #1). What
 *      she typed is invisible to every citing path until she stands behind it,
 *      and then visible — both directions, or the assertion means nothing.
 *   3. **Submitting is an act with a record.** A `granted / case_record` consent
 *      event lands in the same transaction as the material.
 *   4. **Declining deletes nothing.** It is a recorded answer the case shows,
 *      her words are kept verbatim, and every row she had submitted is still
 *      there afterwards — including through the operator repair path, which
 *      used to walk a recorded decline back to `pending`.
 *
 * Her words are evidence: Chinese, quoted verbatim inside English prose, never
 * translated (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CASE_RECORD,
  asParticipant,
  issueInviteToken,
  listConsentEvents,
  listConsentEventsByActor,
  recordConsent,
  redeemInviteToken,
  resolveMaterialGrant,
  type MaterialAudience,
} from "../src/server/access";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  consentEvents,
  evidence,
  utterances,
} from "../src/server/db/schema";
import { listEvidence } from "../src/server/evidence";
import {
  listCitableUtterances,
  listEvidenceUtterances,
  loadWorkbench,
} from "../src/server/evidence/workbench";
import {
  SubmissionError,
  confirmOwnLine,
  declineParticipation,
  hasConfirmedMaterialFrom,
  readSubmissionState,
  resolveRespondingParty,
  reviseOwnLine,
  submitStatement,
  withdrawOwnLine,
} from "../src/server/participation/submission";
import {
  applyParticipationReset,
  buildCitableBrief,
  readParticipationEvidence,
} from "../src/server/pipeline";

let db: Db;
let sqlite: Database.Database;

let caseId: string;
/** The party who filed the case. */
let clientId: string;
/** The fixture counterparty. Nobody real. */
let respondentId: string;
/** One line of the client's, already confirmed, to attack across the boundary. */
let hisEvidenceId: string;
let hisUtteranceId: string;

/** Her account, exactly as she would type it. Two lines, one blank between. */
const HER_STATEMENT = "我那天在医院，手机没电了。\n\n他说的那句话我没听见，是后来别人转述给我的。";
const HER_FIRST_LINE = "我那天在医院，手机没电了。";
const HER_SECOND_LINE = "他说的那句话我没听见，是后来别人转述给我的。";
const HIS_LINE = "你从来不听我说话。";
const HER_REASON = "我不想把这件事交给一个软件来评理。";

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);

  const [row] = db
    .insert(cases)
    .values({ stage: "participation" })
    .returning()
    .all();
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

  // The client's own material, owned by him and left private — which for the
  // submitter is still inside the case record, because filing a case is what
  // putting your material into it means.
  const [item] = db
    .insert(evidence)
    .values({
      caseId,
      sourceType: "firsthand",
      gradeFinal: "A",
      contentSummary: HIS_LINE,
      ownerParticipantId: clientId,
    })
    .returning()
    .all();
  hisEvidenceId = item.id;

  const [line] = db
    .insert(utterances)
    .values({
      caseId,
      evidenceId: item.id,
      aiDraft: HIS_LINE,
      humanFinal: HIS_LINE,
      confirmStatus: "confirmed",
      speakerLabel: "乙",
      speakerParticipantId: clientId,
      orderKey: "a0",
      ownerParticipantId: clientId,
    })
    .returning()
    .all();
  hisUtteranceId = line.id;
});

afterEach(() => {
  sqlite.close();
});

/** Submit her statement and hand back the ids it produced. */
function submitHers() {
  return submitStatement(db, {
    caseId,
    participantId: respondentId,
    text: HER_STATEMENT,
  });
}

/**
 * Citable text for one audience, sorted.
 *
 * Sorted because these assertions are about membership: two parties' lines can
 * carry the same `order_key` (each is ordered inside its own evidence), so the
 * sequence between them is not a property worth asserting — what is at stake is
 * whether a line is in the set at all.
 */
function citableTexts(audience: MaterialAudience = CASE_RECORD): string[] {
  return listCitableUtterances(db, caseId, audience)
    .map((line) => line.text)
    .sort();
}

function sorted(...texts: string[]): string[] {
  return [...texts].sort();
}

/** Every line of hers, straight off the table, bypassing every read model. */
function herRawLines() {
  return db
    .select()
    .from(utterances)
    .where(eq(utterances.ownerParticipantId, respondentId))
    .all();
}

/* -------------------------------------------------------------------------- */
/* What lands, and who owns it                                                */
/* -------------------------------------------------------------------------- */

describe("what she submits", () => {
  it("lands owned by her, private, and unconfirmed", () => {
    const submitted = submitHers();

    const [item] = db
      .select()
      .from(evidence)
      .where(eq(evidence.id, submitted.evidenceId))
      .all();
    expect(item.ownerParticipantId).toBe(respondentId);
    expect(item.visibility).toBe("private");
    // Her account is a recollection (B), not a first-hand record. The grade is
    // signed off at write time to the rule's own answer, because this is the
    // one artifact whose provenance the system observed itself — and because
    // `grade_final` is what the citation audit reads, so a NULL here would make
    // everything she submits uncitable (SPEC M5 ⑥).
    expect(item.sourceType).toBe("recollection");
    expect(item.gradeSuggested).toBe("B");
    expect(item.gradeFinal).toBe("B");
    expect(item.gradeConfirmedAt).not.toBeNull();

    const lines = herRawLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.ownerParticipantId).toBe(respondentId);
      expect(line.visibility).toBe("private");
      expect(line.confirmStatus).toBe("pending");
      expect(line.speakerParticipantId).toBe(respondentId);
      // The pseudonym is the label, because the label is what egresses.
      expect(line.speakerLabel).toBe("甲");
      expect(line.isRetold).toBe(false);
      // No machine wrote this; there is no draft to attribute to one.
      expect(line.aiDraft).toBeNull();
    }

    // Verbatim, in her language, split only where she put a line break.
    expect(lines.map((line) => line.humanFinal)).toEqual([
      HER_FIRST_LINE,
      HER_SECOND_LINE,
    ]);
  });

  it("refuses an empty statement and one that is too long", () => {
    expect(() =>
      submitStatement(db, { caseId, participantId: respondentId, text: "  \n\n " }),
    ).toThrow(SubmissionError);

    expect(() =>
      submitStatement(db, {
        caseId,
        participantId: respondentId,
        text: "字".repeat(20_001),
      }),
    ).toThrow(/longer than one submission can carry/);

    expect(herRawLines()).toHaveLength(0);
  });

  it("is not the client's path — he cannot submit through it", () => {
    expect(() =>
      submitStatement(db, { caseId, participantId: clientId, text: HIS_LINE }),
    ).toThrow(SubmissionError);
  });
});

/* -------------------------------------------------------------------------- */
/* Invisible to him until she says otherwise                                  */
/* -------------------------------------------------------------------------- */

describe("visibility of her material", () => {
  it("is invisible to the client at the query layer until he is granted it", () => {
    const submitted = submitHers();
    // Confirmed, so the only thing that could still be hiding it is visibility.
    for (const line of herRawLines()) {
      confirmOwnLine(db, {
        caseId,
        participantId: respondentId,
        evidenceId: submitted.evidenceId,
        utteranceId: line.id,
      });
    }

    const asHim = asParticipant(clientId);

    expect(listCitableUtterances(db, caseId, asHim).map((u) => u.text)).toEqual([
      HIS_LINE,
    ]);
    expect(buildCitableBrief(db, caseId, asHim).utterances.map((u) => u.text)).toEqual(
      [HIS_LINE],
    );
    expect(listEvidence(db, caseId, asHim).map((item) => item.id)).toEqual([
      hisEvidenceId,
    ]);
    expect(loadWorkbench(db, submitted.evidenceId, asHim)).toBeNull();
    expect(listEvidenceUtterances(db, submitted.evidenceId, asHim)).toEqual([]);

    // Her own audience reads her own material, always.
    const asHer = asParticipant(respondentId);
    expect(listCitableUtterances(db, caseId, asHer).map((u) => u.text)).toEqual([
      HER_FIRST_LINE,
      HER_SECOND_LINE,
    ]);

    // The explicit grant, naming him. Only now does the boundary open.
    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "granted",
      scope: "counterparty_read",
      subjectParticipantId: clientId,
    });

    expect(citableTexts(asHim)).toEqual(
      sorted(HIS_LINE, HER_FIRST_LINE, HER_SECOND_LINE),
    );
    expect(loadWorkbench(db, submitted.evidenceId, asHim)).not.toBeNull();
  });

  it("reaches the case record on the consent event alone, without becoming his to read", () => {
    const submitted = submitHers();
    confirmOwnLine(db, {
      caseId,
      participantId: respondentId,
      evidenceId: submitted.evidenceId,
      utteranceId: herRawLines()[0].id,
    });

    // The case as a document may read it: that is what she consented to.
    expect(resolveMaterialGrant(db, caseId, CASE_RECORD).ownerIds).toContain(
      respondentId,
    );
    expect(citableTexts()).toEqual(sorted(HIS_LINE, HER_FIRST_LINE));

    // The other party still may not, and the rows never left `private`.
    expect(citableTexts(asParticipant(clientId))).toEqual([HIS_LINE]);
    expect(herRawLines().map((line) => line.visibility)).toEqual([
      "private",
      "private",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* HARD RULE #1, applied to her                                               */
/* -------------------------------------------------------------------------- */

describe("her unconfirmed material", () => {
  it("is not citable until she stands behind it", () => {
    const submitted = submitHers();

    // Submitted, consented to, in the case record — and still uncitable.
    expect(citableTexts()).toEqual([HIS_LINE]);
    expect(
      buildCitableBrief(db, caseId, CASE_RECORD).utterances.map((u) => u.text),
    ).toEqual([HIS_LINE]);
    expect(hasConfirmedMaterialFrom(db, caseId, respondentId)).toBe(false);

    const [first, second] = herRawLines();
    confirmOwnLine(db, {
      caseId,
      participantId: respondentId,
      evidenceId: submitted.evidenceId,
      utteranceId: first.id,
    });

    // One line confirmed, one still pending: exactly one of hers is citable.
    expect(citableTexts()).toEqual(sorted(HIS_LINE, HER_FIRST_LINE));
    expect(hasConfirmedMaterialFrom(db, caseId, respondentId)).toBe(true);

    // Rewriting is hers too, and it is the rewritten text that becomes citable.
    reviseOwnLine(db, {
      caseId,
      participantId: respondentId,
      evidenceId: submitted.evidenceId,
      utteranceId: second.id,
      text: "他说的那句话我没听见。",
    });
    expect(citableTexts()).toEqual(
      sorted(HIS_LINE, HER_FIRST_LINE, "他说的那句话我没听见。"),
    );

    // Taking a line out drops it from the citable pool without deleting it.
    withdrawOwnLine(db, {
      caseId,
      participantId: respondentId,
      evidenceId: submitted.evidenceId,
      utteranceId: second.id,
    });
    expect(citableTexts()).toEqual(sorted(HIS_LINE, HER_FIRST_LINE));
    expect(herRawLines()).toHaveLength(2);
  });

  it("cannot be confirmed by reaching for somebody else's row", () => {
    const submitted = submitHers();

    // His line, posted through her path with her participant id.
    expect(() =>
      confirmOwnLine(db, {
        caseId,
        participantId: respondentId,
        evidenceId: hisEvidenceId,
        utteranceId: hisUtteranceId,
      }),
    ).toThrow(SubmissionError);

    // Her evidence id with his utterance id — the mismatch is caught too.
    expect(() =>
      withdrawOwnLine(db, {
        caseId,
        participantId: respondentId,
        evidenceId: submitted.evidenceId,
        utteranceId: hisUtteranceId,
      }),
    ).toThrow(/not yours/);

    const [his] = db
      .select()
      .from(utterances)
      .where(eq(utterances.id, hisUtteranceId))
      .all();
    expect(his.confirmStatus).toBe("confirmed");
  });
});

/* -------------------------------------------------------------------------- */
/* Consent                                                                    */
/* -------------------------------------------------------------------------- */

describe("submitting", () => {
  it("writes a consent event granting the case the right to use it", () => {
    expect(listConsentEvents(db, caseId)).toEqual([]);

    const submitted = submitHers();

    const hers = listConsentEventsByActor(db, caseId, respondentId);
    expect(hers).toHaveLength(1);
    expect(hers[0]).toMatchObject({
      caseId,
      actorParticipantId: respondentId,
      actorPseudonym: "甲",
      kind: "granted",
      scope: "case_record",
      subjectParticipantId: null,
    });
    expect(hers[0].id).toBe(submitted.consent.id);

    // The event and the material are one act: the append-only table has it.
    expect(db.select().from(consentEvents).all()).toHaveLength(1);
  });

  it("keeps her own words on the event when she gives them", () => {
    const submitted = submitStatement(db, {
      caseId,
      participantId: respondentId,
      text: HER_FIRST_LINE,
      note: "只给这个案子用，不要给他看。",
    });
    expect(submitted.consent.note).toBe("只给这个案子用，不要给他看。");
  });

  it("supersedes what the case said about her with what she just did", () => {
    expect(
      db
        .select()
        .from(caseParticipants)
        .where(eq(caseParticipants.id, respondentId))
        .get()!.participationState,
    ).toBe("pending");

    const submitted = submitHers();

    expect(submitted.participationState).toBe("written_response");
    expect(readSubmissionState(db, caseId, respondentId).participationState).toBe(
      "written_response",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Declining                                                                  */
/* -------------------------------------------------------------------------- */

describe("declining", () => {
  it("records the outcome, in her words, and deletes nothing", () => {
    submitHers();
    const before = herRawLines();

    const outcome = declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    expect(outcome).toMatchObject({
      participantId: respondentId,
      respondState: "declined",
      participationState: "refused",
      reason: HER_REASON,
    });

    // Visible on the case, on the column the client's own screen reads.
    const row = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.id, respondentId))
      .get()!;
    expect(row.participationState).toBe("refused");
    expect(row.respondState).toBe("declined");
    expect(row.declineReason).toBe(HER_REASON);
    expect(row.respondStateAt).not.toBeNull();

    // Nothing was deleted — not the rows, not the text, not the consent event.
    expect(outcome.kept).toEqual({
      files: 0,
      evidence: 1,
      utterances: 2,
      events: 0,
    });
    expect(herRawLines()).toEqual(before);
    expect(listConsentEventsByActor(db, caseId, respondentId)).toHaveLength(1);
  });

  it("is a complete answer without a reason, and a second one does not erase the first", () => {
    declineParticipation(db, { caseId, participantId: respondentId });
    expect(
      db
        .select()
        .from(caseParticipants)
        .where(eq(caseParticipants.id, respondentId))
        .get()!.declineReason,
    ).toBeNull();

    declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });
    // A later decline with nothing typed keeps the words she did give.
    const outcome = declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: "   ",
    });
    expect(outcome.reason).toBe(HER_REASON);
  });

  it("survives the operator repair path that used to walk it back", () => {
    declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    expect(readParticipationEvidence(db, caseId)).toEqual({
      invited: false,
      responded: false,
      declined: true,
    });

    const reset = applyParticipationReset(db, caseId);
    expect(reset.changed).toBe(false);
    expect(reset.to).toBe("refused");
    expect(
      db
        .select()
        .from(caseParticipants)
        .where(eq(caseParticipants.id, respondentId))
        .get()!.participationState,
    ).toBe("refused");
  });

  it("does not trap her — writing something afterwards is her changing her mind", () => {
    declineParticipation(db, {
      caseId,
      participantId: respondentId,
      reason: HER_REASON,
    });

    const submitted = submitHers();

    expect(submitted.participationState).toBe("written_response");
    // Her earlier words are still on the row: nothing she wrote is erased.
    expect(
      db
        .select()
        .from(caseParticipants)
        .where(eq(caseParticipants.id, respondentId))
        .get()!.declineReason,
    ).toBe(HER_REASON);
  });
});

/* -------------------------------------------------------------------------- */
/* The credential                                                             */
/* -------------------------------------------------------------------------- */

describe("who the token resolves to", () => {
  it("accepts the invite before redemption and the identity afterwards", () => {
    const invite = issueInviteToken(db, respondentId);

    const onInvite = resolveRespondingParty(db, invite.token, { touch: false });
    expect(onInvite).not.toBeNull();
    expect(onInvite!.participant.id).toBe(respondentId);
    expect(onInvite!.via).toBe("invite");
    expect(onInvite!.identity).toBeNull();

    const redeemed = redeemInviteToken(db, invite.token);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // The spent invite stops opening the write path; the identity opens it.
    expect(resolveRespondingParty(db, invite.token)).toBeNull();
    const returning = resolveRespondingParty(db, redeemed.identityToken);
    expect(returning?.participant.id).toBe(respondentId);
    expect(returning?.via).toBe("identity");
    expect(returning?.identity?.id).toBe(redeemed.identity.id);
  });

  it("resolves nothing for a token nobody issued", () => {
    expect(resolveRespondingParty(db, "")).toBeNull();
    expect(resolveRespondingParty(db, "not-a-token")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The screen's read model                                                    */
/* -------------------------------------------------------------------------- */

describe("her submission screen", () => {
  it("shows her own material and says where her permissions stand", () => {
    const submitted = submitHers();
    confirmOwnLine(db, {
      caseId,
      participantId: respondentId,
      evidenceId: submitted.evidenceId,
      utteranceId: herRawLines()[0].id,
    });

    const state = readSubmissionState(db, caseId, respondentId);

    expect(state.pseudonym).toBe("甲");
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0].lines.map((line) => line.text)).toEqual([
      HER_FIRST_LINE,
      HER_SECOND_LINE,
    ]);
    expect(state.totalLines).toBe(2);
    expect(state.confirmedLines).toBe(1);
    expect(state.caseRecordConsent).toBe("granted");
    // Nothing she has done so far lets him read any of it.
    expect(state.clientMayRead).toBe(false);
    expect(state.hasAccount).toBe(false);

    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "granted",
      scope: "counterparty_read",
      subjectParticipantId: clientId,
    });
    expect(readSubmissionState(db, caseId, respondentId).clientMayRead).toBe(true);
  });

  it("shows nothing of the client's", () => {
    submitHers();
    const state = readSubmissionState(db, caseId, respondentId);
    const texts = state.submissions.flatMap((item) =>
      item.lines.map((line) => line.text),
    );
    expect(texts).not.toContain(HIS_LINE);
  });
});
