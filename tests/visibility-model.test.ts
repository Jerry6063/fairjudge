/**
 * The visibility model, attacked at the query layer (SPEC M5 ①).
 *
 * This is the two-person guarantee. Once a second person can log in, the
 * sentence the product is making is: **what she submitted is hers, and he
 * cannot read it unless she puts it into the case.** That sentence is only true
 * if it is true of the SELECT. A screen that declines to render a row is a
 * convention — the next screen, the next server action, the next export path
 * does not know about it — so every assertion below calls an exported read
 * function directly, with a participant audience, and asserts the row never
 * comes back. Nothing here goes through a component.
 *
 * The attack surface is deliberately the whole exported read layer, not a
 * representative sample: `listEvidence`, `findEvidenceImage` (the blob route's
 * gate), `loadWorkbench`, `listEvidenceUtterances`, `listCitableUtterances`,
 * `assembleCaseFile`, `buildCitableBrief`, `checkEvidenceRefs`,
 * `computeRecordAsymmetry`, `loadTimeline`. A visibility model that holds in
 * nine functions out of ten holds nowhere.
 *
 * Three further properties get their own attacks:
 *
 *   - **Counts leak too.** "She has nine lines here you cannot see" is a fact
 *     about her private material. The per-evidence counters and the asymmetry
 *     numbers are asserted, not just the text.
 *   - **The case record is an audience like any other.** A non-submitter's
 *     private material is outside it until she grants `case_record` — which is
 *     what stops a judgment being made out of material nobody consented to,
 *     in the query layer, where a prompt cannot widen it (HARD RULE #1's
 *     placement, applied to consent).
 *   - **A stranger reads nothing at all**, including rows marked `case`.
 *
 * Evidence content is Chinese and stays Chinese: these are records of what
 * people said, quoted verbatim inside English prose (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CASE_RECORD,
  asParticipant,
  recordConsent,
  resolveMaterialGrant,
  shareMaterialIntoCase,
  withdrawMaterialFromCase,
} from "../src/server/access";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  events,
  files,
  utterances,
} from "../src/server/db/schema";
import { loadTimeline } from "../src/server/domain/timeline";
import { findEvidenceImage, listEvidence } from "../src/server/evidence";
import {
  listCitableUtterances,
  listEvidenceUtterances,
  loadWorkbench,
} from "../src/server/evidence/workbench";
import { computeRecordAsymmetry } from "../src/server/judgment";
import { assembleCaseFile, buildCitableBrief, checkEvidenceRefs } from "../src/server/pipeline";

let db: Db;
let sqlite: Database.Database;

let caseId: string;
/** The party who filed the case. */
let clientId: string;
/** The fixture counterparty. Nobody real is invited anywhere by this suite. */
let respondentId: string;

/** What each side put on the machine, so the assertions can name it. */
const HIS_LINE = "你从来不听我说话。";
const HER_LINE = "我那天在医院，手机没电了。";
const HIS_EVENT_TITLE = "周五晚上的争吵";
const HER_EVENT_TITLE = "我那周的值班表";

interface Material {
  readonly evidenceId: string;
  readonly utteranceId: string;
  readonly eventId: string;
  readonly fileId: string;
}

/**
 * One party's material, on all four owned tables, left at the default
 * `private` — which is the state the column ships in and the state everything
 * below attacks.
 */
function addMaterial(ownerId: string, line: string, eventTitle: string): Material {
  const [file] = db
    .insert(files)
    .values({
      caseId,
      kind: "screenshot",
      sha256: `sha-${ownerId}-${line.length}`,
      storagePath: `blobs/${ownerId}.png`,
      mimeType: "image/png",
      ownerParticipantId: ownerId,
    })
    .returning()
    .all();

  const [item] = db
    .insert(evidence)
    .values({
      caseId,
      fileId: file.id,
      sourceType: "firsthand",
      gradeFinal: "A",
      contentSummary: eventTitle,
      ownerParticipantId: ownerId,
    })
    .returning()
    .all();

  const [utterance] = db
    .insert(utterances)
    .values({
      caseId,
      evidenceId: item.id,
      aiDraft: line,
      humanFinal: line,
      confirmStatus: "confirmed",
      speakerLabel: ownerId === clientId ? "乙" : "甲",
      orderKey: "a0",
      ownerParticipantId: ownerId,
    })
    .returning()
    .all();

  const [event] = db
    .insert(events)
    .values({
      caseId,
      title: eventTitle,
      description: eventTitle,
      confirmStatus: "confirmed",
      occurredPrecision: "day",
      occurredAt: new Date("2026-05-01T00:00:00Z"),
      ownerParticipantId: ownerId,
    })
    .returning()
    .all();

  return {
    evidenceId: item.id,
    utteranceId: utterance.id,
    eventId: event.id,
    fileId: file.id,
  };
}

let his: Material;
let hers: Material;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);

  const [row] = db.insert(cases).values({ stage: "issue_framing" }).returning().all();
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
        participationState: "participating",
      },
    ])
    .returning()
    .all();
  clientId = parties.find((party) => party.isSubmitter)!.id;
  respondentId = parties.find((party) => !party.isSubmitter)!.id;

  his = addMaterial(clientId, HIS_LINE, HIS_EVENT_TITLE);
  hers = addMaterial(respondentId, HER_LINE, HER_EVENT_TITLE);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* The attack                                                                 */
/* -------------------------------------------------------------------------- */

describe("one party attacking the other's private material", () => {
  it("cannot read her lines through any exported read function", () => {
    const asHim = asParticipant(clientId);

    // Text, through every path that returns utterance text.
    expect(listCitableUtterances(db, caseId, asHim).map((u) => u.text)).toEqual([
      HIS_LINE,
    ]);
    expect(
      buildCitableBrief(db, caseId, asHim).utterances.map((u) => u.text),
    ).toEqual([HIS_LINE]);
    expect(assembleCaseFile(db, caseId, asHim).utterances.map((u) => u.text)).toEqual(
      [HIS_LINE],
    );
    expect(listEvidenceUtterances(db, hers.evidenceId, asHim)).toEqual([]);

    // The whole assembled record, serialized — the bytes a prompt would be
    // built from. Her line must not be anywhere in it, including a field
    // nobody thought about.
    expect(JSON.stringify(assembleCaseFile(db, caseId, asHim))).not.toContain(
      HER_LINE,
    );
  });

  it("cannot reach her evidence, her workbench or her screenshot", () => {
    const asHim = asParticipant(clientId);

    expect(listEvidence(db, caseId, asHim).map((item) => item.id)).toEqual([
      his.evidenceId,
    ]);
    // "It is not there" and "it is not yours" look the same from outside.
    expect(loadWorkbench(db, hers.evidenceId, asHim)).toBeNull();
    expect(loadWorkbench(db, his.evidenceId, asHim)).not.toBeNull();
    // The blob route's gate. An evidence id is guessable in a way a path is not.
    expect(findEvidenceImage(db, hers.evidenceId, asHim)).toBeNull();
    expect(findEvidenceImage(db, his.evidenceId, asHim)).not.toBeNull();
  });

  it("cannot read her events off the timeline", () => {
    const asHim = asParticipant(clientId);
    const board = loadTimeline(db, caseId, asHim);
    const titles = [...board.mainline, ...board.pending].map((card) => card.title);

    expect(titles).toEqual([HIS_EVENT_TITLE]);
    expect(assembleCaseFile(db, caseId, asHim).timeline.map((e) => e.title)).toEqual(
      [HIS_EVENT_TITLE],
    );
  });

  it("cannot count what it cannot read", () => {
    const asHim = asParticipant(clientId);

    // A count returns no text, and still says "she has lines here you cannot
    // see", which is a fact about her private material.
    const listed = listEvidence(db, caseId, asHim);
    expect(listed).toHaveLength(1);
    expect(listed[0].utteranceTotal).toBe(1);

    const asymmetry = computeRecordAsymmetry(db, caseId, asHim);
    expect(asymmetry.citableUtterances.total).toBe(1);
    expect(asymmetry.uncitableUtterances.total).toBe(0);
  });

  it("cannot cite her line even holding its id", () => {
    // The interesting attacker is not a curious user, it is a generation that
    // emits an id nobody showed it. The reference must be refused with its own
    // fault, not silently dropped.
    const check = checkEvidenceRefs(
      db,
      caseId,
      [hers.utteranceId],
      asParticipant(clientId),
    );

    expect(check.ok).toBe(false);
    expect(check.valid).toEqual([]);
    expect(check.rejected[0].fault).toBe("not_in_record");
  });

  it("holds in the other direction too — she cannot read his", () => {
    const asHer = asParticipant(respondentId);

    expect(listCitableUtterances(db, caseId, asHer).map((u) => u.text)).toEqual([
      HER_LINE,
    ]);
    expect(listEvidence(db, caseId, asHer).map((item) => item.id)).toEqual([
      hers.evidenceId,
    ]);
    expect(loadWorkbench(db, his.evidenceId, asHer)).toBeNull();
    expect(findEvidenceImage(db, his.evidenceId, asHer)).toBeNull();
    expect(
      loadTimeline(db, caseId, asHer).mainline.map((card) => card.title),
    ).toEqual([HER_EVENT_TITLE]);
    expect(JSON.stringify(assembleCaseFile(db, caseId, asHer))).not.toContain(
      HIS_LINE,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The default, and rows from before there was a second person                */
/* -------------------------------------------------------------------------- */

describe("what the column defaults to", () => {
  it("ships private, so a new row is nobody else's by default", () => {
    const rows = db.select().from(utterances).all();
    expect(rows.map((row) => row.visibility)).toEqual(["private", "private"]);
  });

  it("treats an unowned row as the case's, not as everyone's", () => {
    // NULL owner is the pre-M5 record: material from when one person brought
    // the case and there was nothing to protect. The case record reads it and
    // so does the submitter — a non-submitter does not, because a forgotten
    // owner on a write path must not become a silent grant.
    const [orphan] = db
      .insert(utterances)
      .values({
        caseId,
        aiDraft: "从前只有一个人在说话。",
        humanFinal: "从前只有一个人在说话。",
        confirmStatus: "confirmed",
        orderKey: "a1",
      })
      .returning()
      .all();

    const idsFor = (audience: Parameters<typeof listCitableUtterances>[2]) =>
      listCitableUtterances(db, caseId, audience).map((u) => u.id);

    expect(idsFor(CASE_RECORD)).toContain(orphan.id);
    expect(idsFor(asParticipant(clientId))).toContain(orphan.id);
    expect(idsFor(asParticipant(respondentId))).not.toContain(orphan.id);
  });
});

/* -------------------------------------------------------------------------- */
/* The case record is an audience too                                         */
/* -------------------------------------------------------------------------- */

describe("what a judgment may be made from", () => {
  it("leaves a non-submitter's private material out of the case record", () => {
    // The client's private material IS in the case record — filing a case is
    // what putting your material into it means. Hers is not: her material
    // arriving on this machine is not her agreeing to be judged on it.
    const brief = buildCitableBrief(db, caseId, CASE_RECORD);
    expect(brief.utterances.map((u) => u.text)).toEqual([HIS_LINE]);
    expect(assembleCaseFile(db, caseId).material.map((m) => m.id)).toEqual([
      his.evidenceId,
    ]);
  });

  it("admits her material once she grants case_record, and not before", () => {
    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "granted",
      scope: "case_record",
      note: "我同意把我这边的记录放进来。",
    });

    const texts = buildCitableBrief(db, caseId).utterances.map((u) => u.text);
    expect(texts).toContain(HER_LINE);
    expect(texts).toContain(HIS_LINE);
  });

  it("drops it again the moment she revokes", () => {
    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "granted",
      scope: "case_record",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });
    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "revoked",
      scope: "case_record",
      occurredAt: new Date("2026-08-12T10:00:00Z"),
      note: "我改主意了。",
    });

    expect(buildCitableBrief(db, caseId).utterances.map((u) => u.text)).toEqual([
      HIS_LINE,
    ]);
    // Revocation is not deletion: the row is still hers and still on file.
    expect(
      listCitableUtterances(db, caseId, asParticipant(respondentId)).map(
        (u) => u.text,
      ),
    ).toEqual([HER_LINE]);
  });
});

/* -------------------------------------------------------------------------- */
/* Granting, and taking it back                                               */
/* -------------------------------------------------------------------------- */

describe("putting material into the case", () => {
  it("moves her rows to `case` and records who decided that", () => {
    const result = shareMaterialIntoCase(db, {
      caseId,
      ownerParticipantId: respondentId,
      note: "这些是我这边的记录。",
    });

    expect(result.moved).toEqual({ files: 1, evidence: 1, utterances: 1, events: 1 });
    expect(result.consent.kind).toBe("granted");
    expect(result.consent.scope).toBe("case_record");
    expect(result.consent.actorPseudonym).toBe("甲");
    // Verbatim, never normalized.
    expect(result.consent.note).toBe("这些是我这边的记录。");

    // Now readable by the case record and by the other party — sharing into a
    // case is sharing with the case's parties.
    expect(
      buildCitableBrief(db, caseId).utterances.map((u) => u.text),
    ).toContain(HER_LINE);
    expect(
      listCitableUtterances(db, caseId, asParticipant(clientId)).map((u) => u.text),
    ).toContain(HER_LINE);
    // And it touches nothing of his.
    expect(
      db.select().from(utterances).all().filter((row) => row.ownerParticipantId === clientId)
        .map((row) => row.visibility),
    ).toEqual(["private"]);
  });

  it("takes it back out on withdrawal, without deleting anything", () => {
    shareMaterialIntoCase(db, { caseId, ownerParticipantId: respondentId });
    const result = withdrawMaterialFromCase(db, {
      caseId,
      ownerParticipantId: respondentId,
      note: "我先撤回。",
    });

    expect(result.moved).toEqual({ files: 1, evidence: 1, utterances: 1, events: 1 });
    expect(result.consent.kind).toBe("revoked");

    expect(
      listCitableUtterances(db, caseId, asParticipant(clientId)).map((u) => u.text),
    ).toEqual([HIS_LINE]);
    // Not deleted: still hers, still on file, still readable by her.
    expect(db.select().from(utterances).all()).toHaveLength(2);
    expect(
      listCitableUtterances(db, caseId, asParticipant(respondentId)).map((u) => u.text),
    ).toEqual([HER_LINE]);
  });

  it("refuses to move material for somebody who is not a party", () => {
    expect(() =>
      shareMaterialIntoCase(db, {
        caseId,
        ownerParticipantId: "not-a-party",
      }),
    ).toThrowError(/not a party/);
  });

  it("lets one party read another's private material only through counterparty_read", () => {
    // The narrower grant: he may read it, and it still does not enter the case
    // record a judgment is made from.
    recordConsent(db, {
      caseId,
      actorParticipantId: respondentId,
      kind: "granted",
      scope: "counterparty_read",
      subjectParticipantId: clientId,
    });

    expect(
      listCitableUtterances(db, caseId, asParticipant(clientId)).map((u) => u.text),
    ).toContain(HER_LINE);
    expect(buildCitableBrief(db, caseId).utterances.map((u) => u.text)).toEqual([
      HIS_LINE,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Strangers                                                                  */
/* -------------------------------------------------------------------------- */

describe("somebody who is not a party to this case", () => {
  it("reads nothing at all, shared rows included", () => {
    shareMaterialIntoCase(db, { caseId, ownerParticipantId: respondentId });

    const [otherCase] = db.insert(cases).values({ stage: "intake" }).returning().all();
    const [outsider] = db
      .insert(caseParticipants)
      .values({
        caseId: otherCase.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
      })
      .returning()
      .all();

    const asOutsider = asParticipant(outsider.id);
    const grant = resolveMaterialGrant(db, caseId, asOutsider);
    expect(grant.stranger).toBe(true);

    expect(listCitableUtterances(db, caseId, asOutsider)).toEqual([]);
    expect(listEvidence(db, caseId, asOutsider)).toEqual([]);
    expect(assembleCaseFile(db, caseId, asOutsider).utterances).toEqual([]);
    expect(loadTimeline(db, caseId, asOutsider).mainline).toEqual([]);
    expect(loadWorkbench(db, hers.evidenceId, asOutsider)).toBeNull();
    expect(findEvidenceImage(db, hers.evidenceId, asOutsider)).toBeNull();
  });
});
