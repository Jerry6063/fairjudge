/**
 * Consent as events, with teeth (SPEC M5 ③).
 *
 * A boolean would pass most of these. What it could not do is survive the answer
 * changing, and that is the whole subject:
 *
 *   1. **The log is append-only and the fold is the state.** grant → revoke →
 *      grant leaves three rows, not one, and the current answer is the last of
 *      them. The database enforces it — the UPDATE is attacked directly, not
 *      through a function that politely declines to write one.
 *   2. **Revocation bites at both doors, immediately.** An export that worked a
 *      moment ago is refused; a share token is not minted; a link already handed
 *      out stops opening. Nothing is written to the export audit by a refusal,
 *      because what that table records is egress and a refused copy never left.
 *   3. **Re-granting works and is another event.** The door reopens, the link
 *      works again, and the history still contains the withdrawal.
 *   4. **The copy that already left is reported as un-recallable.** This is the
 *      one the product could be tempted to lie about. A revocation cannot reach
 *      a file on somebody else's machine, so the record says so in those words,
 *      names the copies, and stamps each `recallable: false`.
 *   5. **"Nobody asked" is not "she said no."** With an empty log the export path
 *      behaves exactly as it did in M4.
 *
 * The counterparty here is a fixture persona. Nobody is invited anywhere by this
 * suite, no document leaves the machine, and the only "export" is a row in a
 * local table. Evidence is Chinese and stays Chinese, quoted verbatim (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NamedRenditionRevokedError,
  consentFoldFor,
  consentStandingFor,
  foldConsent,
  grantNamedRendition,
  listConsentEvents,
  namedRenditionConsent,
  readCaseConsentState,
  recordConsent,
  revokeNamedRendition,
} from "../src/server/access";
import { createDb, runMigrations, type Db } from "../src/server/db";
import { caseParticipants, cases, consentEvents } from "../src/server/db/schema";
import {
  ExportBlockedError,
  RenditionError,
  createDraft,
  exportRendition,
  finalize,
  listExports,
  mintShareToken,
  persistShareableNarrative,
  readSharedRendition,
  type FactLayer,
  type SurfaceLayer,
} from "../src/server/judgment";
import { MODEL_FABLE } from "../src/server/llm/config";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** 22 characters of 甲's own message — the recipient's words, so the gate lets them through. */
const LONG_QUOTE = "我周三之前必须知道，不然我没法安排接下来的事";

interface Seeded {
  readonly caseId: string;
  readonly judgmentId: string;
  /** The client, who filed the case. */
  readonly clientId: string;
  /** The fixture counterparty — the person a shareable rendition names and is written to. */
  readonly herId: string;
}

function factLayer(): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: `甲 put a date on the answer she wanted: “${LONG_QUOTE}”.`,
        evidence_refs: ["u-1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 2, by_client: 0, by_counterparty: 2 },
        parties_without_citable_utterance: ["乙"],
        statement:
          "Two confirmed lines, both 甲's. 乙 has not spoken inside the record.",
      },
      unresolved: [],
      responsibility: [],
    },
  };
}

function clientNarrative(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text: "You, 乙, submitted this case. Two lines are on file, both 甲's.",
        claim_ids: [],
      },
      {
        section_id: "s2",
        kind: "finding",
        audience: "self_only",
        heading: "What this asks of you",
        text: "You read a deadline as an ultimatum and stopped answering.",
        claim_ids: ["c1"],
      },
    ],
  };
}

/** The copy written to her: she is "you", 乙 is a third party. */
function counterpartyNarrative(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "t1",
        kind: "finding",
        audience: "both",
        heading: "What the record holds",
        text: `This was written from two messages of yours. In one you wrote “${LONG_QUOTE}”.`,
        claim_ids: ["c1"],
      },
      {
        section_id: "t2",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text:
          "You were never asked for your account, so nothing here settles what " +
          "either of you meant by any of it.",
        claim_ids: [],
      },
    ],
  };
}

/** A case with two parties and one frozen, shareable judgment. */
function seed(): Seeded {
  const [row] = db
    .insert(cases)
    .values({
      stage: "post_judgment",
      title: "fixture",
      outputLevel: "L2",
      outputLevelLockedAt: new Date(),
    })
    .returning()
    .all();

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        // Real names live here and nowhere else; they never leave the machine.
        displayName: "Adrian",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        displayName: "知夏",
        isSubmitter: false,
        participationState: "unreachable",
      },
    ])
    .returning()
    .all();

  const draft = createDraft(db, row.id, {
    model: MODEL_FABLE,
    effort: "xhigh",
    factLayer: factLayer(),
    surfaceLayer: clientNarrative(),
  });
  finalize(db, draft.id);
  persistShareableNarrative(db, draft.id, counterpartyNarrative(), {
    model: MODEL_FABLE,
    effort: "high",
    promptVersion: "shareable_narrative.v1",
  });

  return {
    caseId: row.id,
    judgmentId: draft.id,
    clientId: parties.find((party) => party.isSubmitter)?.id ?? "",
    herId: parties.find((party) => !party.isSubmitter)?.id ?? "",
  };
}

function refusal(run: () => unknown): ExportBlockedError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExportBlockedError) return error;
    throw error;
  }
  throw new Error("expected the export to be refused, and it was not");
}

/* -------------------------------------------------------------------------- */
/* 1. The log, and the fold over it                                           */
/* -------------------------------------------------------------------------- */

describe("consent is an append-only log, not a flag", () => {
  it("folds grant → revoke → grant to the last word and keeps all three", () => {
    const { caseId, herId } = seed();

    grantNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "可以发给他。",
      occurredAt: new Date("2026-08-10T10:00:00.000Z"),
    });
    expect(consentStandingFor(db, caseId, herId, "named_rendition")).toBe(
      "granted",
    );

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "我改主意了，别发。",
      occurredAt: new Date("2026-08-11T10:00:00.000Z"),
    });
    expect(consentStandingFor(db, caseId, herId, "named_rendition")).toBe(
      "revoked",
    );

    const again = grantNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "行吧，可以发。",
      occurredAt: new Date("2026-08-12T10:00:00.000Z"),
    });
    const fold = consentFoldFor(db, caseId, herId, "named_rendition");
    expect(fold.standing).toBe("granted");
    expect(fold.decidedBy?.id).toBe(again.event.id);

    // The history is the point: revoking superseded a grant, it did not erase
    // one, and the withdrawal is still readable after she changed her mind back.
    const log = listConsentEvents(db, caseId);
    expect(log.map((event) => event.kind)).toEqual([
      "granted",
      "revoked",
      "granted",
    ]);
    // Her own words, verbatim, in the order she said them.
    expect(log.map((event) => event.note)).toEqual([
      "可以发给他。",
      "我改主意了，别发。",
      "行吧，可以发。",
    ]);
    expect(new Set(log.map((event) => event.actorPseudonym))).toEqual(
      new Set(["甲"]),
    );
  });

  it("reads `unrecorded` when nobody has been asked, which is not `revoked`", () => {
    const { caseId, herId } = seed();

    expect(consentStandingFor(db, caseId, herId, "named_rendition")).toBe(
      "unrecorded",
    );
    expect(foldConsent([])).toEqual({ standing: "unrecorded", decidedBy: null });
    expect(namedRenditionConsent(db, caseId).revoked).toBe(false);
  });

  it("refuses an UPDATE at the database, not merely in the module", () => {
    const { caseId, herId } = seed();
    const { event } = revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
    });

    // Attacked below the ORM: append-only has to be a property of the table, or
    // it is a habit of whoever wrote the last caller.
    expect(() =>
      sqlite
        .prepare("UPDATE consent_events SET kind = 'granted' WHERE id = ?")
        .run(event.id),
    ).toThrow(/append-only/);

    expect(
      db.select().from(consentEvents).where(eq(consentEvents.id, event.id)).get()
        ?.kind,
    ).toBe("revoked");
  });

  it("lets a blanket revocation supersede a grant made about one recipient", () => {
    const { caseId, clientId, herId } = seed();

    grantNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      subjectParticipantId: clientId,
      occurredAt: new Date("2026-08-10T10:00:00.000Z"),
    });
    expect(
      consentStandingFor(db, caseId, herId, "named_rendition", clientId),
    ).toBe("granted");

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      occurredAt: new Date("2026-08-11T10:00:00.000Z"),
    });

    // "To nobody" answers "to him" too. The reverse does not hold — see below.
    expect(
      consentStandingFor(db, caseId, herId, "named_rendition", clientId),
    ).toBe("revoked");
    expect(consentStandingFor(db, caseId, herId, "named_rendition")).toBe(
      "revoked",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Revocation blocks export                                                */
/* -------------------------------------------------------------------------- */

describe("revocation blocks export", () => {
  it("refuses a copy that would have gone out a moment earlier", () => {
    const { caseId, judgmentId, herId } = seed();

    // It works first, so the refusal afterwards is the revocation and not the
    // fixture being unexportable all along.
    const before = exportRendition(db, { judgmentId, channel: "file" });
    expect(before.recipientPseudonym).toBe("甲");

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "我不同意把写着我的东西发出去。",
      occurredAt: new Date("2026-08-12T09:00:00.000Z"),
    });

    const blocked = refusal(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    );
    expect(blocked.code).toBe("consent_revoked");
    expect(blocked.violations[0].code).toBe("consent_revoked");
    // The refusal carries her, her words and the date — not just "blocked".
    expect(blocked.message).toContain("甲");
    expect(blocked.message).toContain("我不同意把写着我的东西发出去。");
    expect(blocked.message).toContain("2026-08-12");

    // A refused export is not an export: the audit still holds exactly the one
    // copy that really left.
    expect(listExports(db, judgmentId)).toHaveLength(1);
    expect(listExports(db, judgmentId)[0].id).toBe(before.exportId);
  });

  it("exports normally while nobody has been asked (the M4 policy, unchanged)", () => {
    const { judgmentId } = seed();
    expect(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    ).not.toThrow();
  });

  it("reopens the door when she grants again", () => {
    const { caseId, judgmentId, herId } = seed();

    revokeNamedRendition(db, { caseId, actorParticipantId: herId });
    expect(refusal(() => exportRendition(db, { judgmentId, channel: "file" })).code).toBe(
      "consent_revoked",
    );

    grantNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "现在可以了。",
    });
    const doc = exportRendition(db, { judgmentId, channel: "file" });
    expect(doc.recipientPseudonym).toBe("甲");
    expect(listExports(db, judgmentId)).toHaveLength(1);
  });

  it("leaves a copy to her alone when the withdrawal named a different recipient", () => {
    const { caseId, judgmentId, clientId, herId } = seed();

    // "Not to him." A narrower sentence than "to nobody", and the log holds both.
    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      subjectParticipantId: clientId,
    });

    // The default recipient is her — the copy the shareable rendition is written
    // to — and her withdrawal was not about that copy.
    expect(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    ).not.toThrow();

    const blocked = refusal(() =>
      exportRendition(db, {
        judgmentId,
        channel: "file",
        recipient: { participantId: clientId },
      }),
    );
    expect(blocked.code).toBe("consent_revoked");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Revocation blocks share tokens                                          */
/* -------------------------------------------------------------------------- */

describe("revocation blocks share tokens", () => {
  it("mints no new link, and says who withdrew", () => {
    const { caseId, judgmentId, herId } = seed();

    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      note: "先别给别人看。",
    });

    let caught: unknown;
    try {
      mintShareToken(db, judgmentId, "shareable");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NamedRenditionRevokedError);
    const error = caught as NamedRenditionRevokedError;
    expect(error.code).toBe("named_rendition_revoked");
    expect(error.consent.revoked).toBe(true);
    expect(error.consent.revokedBy.map((party) => party.pseudonym)).toEqual(["甲"]);
    expect(error.message).toContain("先别给别人看。");
  });

  it("closes a link that was already handed out, and reopens it on a re-grant", () => {
    const { caseId, judgmentId, herId } = seed();

    const minted = mintShareToken(db, judgmentId, "shareable");
    expect(readSharedRendition(db, minted.token).text).toContain(LONG_QUOTE);

    revokeNamedRendition(db, { caseId, actorParticipantId: herId });

    // The one place a withdrawal can still reach an already-shared copy: the
    // document is served by this machine, so the promise is keepable here.
    expect(() => readSharedRendition(db, minted.token)).toThrowError(
      NamedRenditionRevokedError,
    );

    grantNamedRendition(db, { caseId, actorParticipantId: herId });
    // Suspended, not burnt — the same link, no re-minting.
    expect(readSharedRendition(db, minted.token).text).toContain(LONG_QUOTE);
  });

  it("still refuses a self-reflection token on the kind alone", () => {
    const { judgmentId } = seed();
    // The pre-M5 rule is untouched by the consent one: no case is even consulted.
    expect(() => mintShareToken(db, judgmentId, "self_reflection")).toThrowError(
      /no share token is ever minted/,
    );
    expect(() => mintShareToken(db, judgmentId, "self_reflection")).not.toThrowError(
      RenditionError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The copy that already left                                              */
/* -------------------------------------------------------------------------- */

describe("what was exported before the revocation", () => {
  it("is reported as un-recallable rather than quietly implied to be gone", () => {
    const { caseId, judgmentId, herId } = seed();

    const sent = exportRendition(db, {
      judgmentId,
      channel: "file",
      now: new Date("2026-08-11T12:00:00.000Z"),
    });

    const { state } = revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      occurredAt: new Date("2026-08-12T09:00:00.000Z"),
    });

    expect(state.revoked).toBe(true);
    expect(state.alreadyExported).toHaveLength(1);
    const copy = state.alreadyExported[0];
    expect(copy.exportId).toBe(sent.exportId);
    expect(copy.beforeRevocation).toBe(true);
    // The field exists so no screen can round "we cannot reach it" down to
    // silence. It is a literal `false`; nothing can ever set it true.
    expect(copy.recallable).toBe(false);
    expect(copy.recipientPseudonym).toBe("甲");
    expect(copy.contentSha256).toBe(sent.contentSha256);

    // And the sentence says it. This is the assertion that would fail if the
    // product ever started implying a revocation reaches a file already handed over.
    const view = readCaseConsentState(db, caseId);
    expect(view.summary).toContain("cannot be recalled");
    expect(view.summary).toContain("Revoking stops the next copy, not the last one.");
    expect(view.unrecallableCopies.map((item) => item.exportId)).toEqual([
      sent.exportId,
    ]);
    expect(view.unrecallableCopies.every((item) => item.recallable === false)).toBe(
      true,
    );

    // The blocked export repeats it at the moment somebody tries again.
    const blocked = refusal(() =>
      exportRendition(db, { judgmentId, channel: "file" }),
    );
    expect(blocked.message).toContain("cannot be recalled");
    expect(blocked.message).toContain(sent.exportId.slice(0, 8));
  });

  it("says plainly when nothing had left yet", () => {
    const { caseId, herId } = seed();

    const { state } = revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
    });
    expect(state.alreadyExported).toHaveLength(0);

    const view = readCaseConsentState(db, caseId);
    expect(view.summary).toContain("no copy of this case is out there");
    expect(view.unrecallableCopies).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The case view's read                                                    */
/* -------------------------------------------------------------------------- */

describe("the case view can see that a case is revoked", () => {
  it("reports both doors shut, the standings, and the whole history", () => {
    const { caseId, clientId, herId } = seed();

    recordConsent(db, {
      caseId,
      actorParticipantId: clientId,
      kind: "granted",
      scope: "case_record",
      occurredAt: new Date("2026-08-09T10:00:00.000Z"),
    });
    grantNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      occurredAt: new Date("2026-08-10T10:00:00.000Z"),
    });
    revokeNamedRendition(db, {
      caseId,
      actorParticipantId: herId,
      occurredAt: new Date("2026-08-11T10:00:00.000Z"),
    });

    const view = readCaseConsentState(db, caseId);
    expect(view.exportBlocked).toBe(true);
    expect(view.shareTokensBlocked).toBe(true);
    expect(view.events).toHaveLength(3);
    expect(view.namedRendition.revokedAt?.toISOString()).toBe(
      "2026-08-11T10:00:00.000Z",
    );

    const her = view.parties.find((party) => party.participantId === herId);
    expect(her?.standings.named_rendition).toBe("revoked");
    expect(her?.standings.case_record).toBe("unrecorded");
    const client = view.parties.find((party) => party.participantId === clientId);
    expect(client?.standings.case_record).toBe("granted");
    expect(client?.standings.named_rendition).toBe("unrecorded");
    expect(client?.isSubmitter).toBe(true);
  });

  it("says nobody has been asked when the log is empty", () => {
    const { caseId } = seed();
    const view = readCaseConsentState(db, caseId);

    expect(view.exportBlocked).toBe(false);
    expect(view.events).toHaveLength(0);
    expect(view.summary).toContain("Nobody has been asked");
    // The three-valued reading, stated where a screen will read it: not asked is
    // not refused, and the case view must not render it as one.
    expect(view.summary).toContain("not the same as anybody saying no");
  });
});
