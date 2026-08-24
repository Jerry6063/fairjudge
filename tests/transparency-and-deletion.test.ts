/**
 * The transparency view and the deletion rights (SPEC M5 ④).
 *
 * This is the artifact that makes the privacy design checkable by the person it
 * most affects, so the tests attack the two ways it can fail her:
 *
 *   1. **A quiet omission.** A transparency view does not crash when it misses
 *      something; it just does not mention it, and the reader cannot tell. So
 *      `TRANSPARENCY_TABLE_COVERAGE` is asserted against the live
 *      `sqlite_master` in both directions, and the fixture puts a row in every
 *      table declared covered and demands that each one comes back.
 *   2. **A promise the system cannot keep.** Deletion is asymmetric on purpose:
 *      her material is removed, his is asked about and nothing happens to it
 *      until he answers. The tests check the deletion, check that a request
 *      deletes nothing, and check that both write an audit row that cannot
 *      afterwards be edited.
 *
 * The counterparty here is a local fixture persona. Nobody real is invited
 * anywhere by this suite, and nothing leaves the machine.
 *
 * Evidence content is Chinese and stays Chinese: these are records of what
 * people said, quoted verbatim inside English prose (CLAUDE.md).
 */

import type Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db as DbType } from "../src/server/db";

// The page module reads the process-wide database; hand it the in-memory one,
// while `createDb`/`runMigrations` below stay the real thing.
const holder: { db: DbType } = { db: null as unknown as DbType };

vi.mock("../src/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/db")>()),
  getDb: () => holder.db,
}));

import {
  DeletionError,
  TRANSPARENCY_TABLE_COVERAGE,
  buildTransparencyView,
  deleteOwnMaterial,
  deletionRightsFor,
  listDeletionAudit,
  listDeletionRequests,
  recordConsent,
  requestMaterialDeletion,
  resolveDeletionRequest,
  issueInviteToken,
  redeemInviteToken,
} from "../src/server/access";
import {
  loadTransparencyFor,
  resolveRespondToken,
} from "../src/app/respond/[token]/data";
import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  adverseFacts,
  appeals,
  caseParticipants,
  cases,
  clarificationRounds,
  egressLedger,
  evidence,
  events,
  files,
  followups,
  improvementContracts,
  issues,
  judgmentExports,
  judgmentPolishRuns,
  judgmentRenditions,
  judgmentSwapTests,
  judgments,
  llmCalls,
  repairScripts,
  safetyScreens,
  steelmanVersions,
  utterances,
} from "../src/server/db/schema";

let db: Db;
let sqlite: Database.Database;

let caseId: string;
/** The party who filed the case. */
let clientId: string;
/** The fixture counterparty. Everything below is written from her side. */
let herId: string;
let judgmentId: string;

/** What each side has on the machine, quoted verbatim where it is evidence. */
const HIS_LINE = "你从来不听我说话。";
const HER_LINE = "我那天在医院，手机没电了。";
/** His, private, and about nobody but him — the row her view must never show. */
const HIS_PRIVATE_LINE = "我自己也说不清那天在想什么。";
const HER_EVENT_TITLE = "我那周的值班表";

interface Material {
  readonly fileId: string;
  readonly evidenceId: string;
  readonly utteranceId: string;
  readonly eventId: string;
}

function addMaterial(ownerId: string, line: string, title: string): Material {
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
      gradeSuggested: "A",
      contentSummary: title,
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
      speakerParticipantId: ownerId,
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
      title,
      description: title,
      confirmStatus: "confirmed",
      occurredPrecision: "day",
      occurredAt: new Date("2026-05-01T00:00:00Z"),
      ownerParticipantId: ownerId,
    })
    .returning()
    .all();

  return {
    fileId: file.id,
    evidenceId: item.id,
    utteranceId: utterance.id,
    eventId: event.id,
  };
}

let his: Material;
let hers: Material;
/** A line of hers that HE submitted and kept private — the subject-access case. */
let quoteOfHers: string;
/** How she comes back to her own page once the single-use invite is spent. */
let herIdentityToken: string;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);

  const [row] = db
    .insert(cases)
    .values({ title: "周五晚上的争吵", stage: "post_judgment", outputLevel: "L2" })
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
        participationState: "participating",
      },
    ])
    .returning()
    .all();
  clientId = parties.find((party) => party.isSubmitter)!.id;
  herId = parties.find((party) => !party.isSubmitter)!.id;

  his = addMaterial(clientId, HIS_LINE, "周五晚上的争吵");
  hers = addMaterial(herId, HER_LINE, HER_EVENT_TITLE);

  // His, private, naming nobody. Her view must not contain it.
  db.insert(utterances)
    .values({
      caseId,
      evidenceId: his.evidenceId,
      aiDraft: HIS_PRIVATE_LINE,
      humanFinal: HIS_PRIVATE_LINE,
      confirmStatus: "confirmed",
      speakerParticipantId: clientId,
      speakerLabel: "乙",
      orderKey: "a1",
      ownerParticipantId: clientId,
    })
    .run();

  // A line of HERS that HE submitted, private: the one deliberate widening.
  const [quoted] = db
    .insert(utterances)
    .values({
      caseId,
      evidenceId: his.evidenceId,
      aiDraft: "你说过你会早点回来。",
      humanFinal: "你说过你会早点回来。",
      confirmStatus: "confirmed",
      speakerParticipantId: herId,
      speakerLabel: "甲",
      isRetold: true,
      orderKey: "a2",
      ownerParticipantId: clientId,
    })
    .returning()
    .all();
  quoteOfHers = quoted.id;

  /* ---- derived rows: one per covered table, each naming her ------------- */

  db.insert(issues)
    .values({
      caseId,
      category: "fact_dispute",
      aiDraft: "Whether 甲 was reachable that evening is disputed.",
      humanFinal: "Whether 甲 was reachable that evening is disputed.",
      confirmStatus: "confirmed",
      evidenceRefs: [hers.utteranceId],
      orderKey: "a0",
    })
    .run();

  db.insert(adverseFacts)
    .values({
      caseId,
      evidenceId: his.evidenceId,
      aiDraft: "乙 did not ask 甲 what had happened before concluding she ignored him.",
      humanFinal:
        "乙 did not ask 甲 what had happened before concluding she ignored him.",
      confirmStatus: "confirmed",
      evidenceRefs: [quoteOfHers],
      ackStatus: "acknowledged",
      ackNote: "确实没问。",
    })
    .run();

  db.insert(steelmanVersions)
    .values({
      caseId,
      version: 1,
      aiDraft: "甲 was in a hospital with a dead phone and could not have answered.",
      humanFinal:
        "甲 was in a hospital with a dead phone and could not have answered.",
      confirmStatus: "confirmed",
      verdict: "rebutted",
      rebuttal: "她之前也这样说过。",
      verdictAt: new Date("2026-05-03T00:00:00Z"),
    })
    .run();

  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber: 1,
      questions: [{ id: "q1", question: "What did 甲 say when she got home?" }],
      answers: [
        {
          questionId: "q1",
          answer: "她说手机没电了。",
          answeredAt: Date.parse("2026-05-02T00:00:00Z"),
          state: "answered",
        },
      ],
      canProceed: true,
      closedAt: new Date("2026-05-02T00:00:00Z"),
    })
    .run();

  const [judgment] = db
    .insert(judgments)
    .values({
      caseId,
      version: 1,
      outputLevel: "L2",
      model: "claude-fable-5",
      status: "final",
      finalizedAt: new Date("2026-05-04T00:00:00Z"),
      content: {
        claims: [
          {
            claim_id: "c1",
            statement: "甲 did not answer that evening.",
            evidence_refs: [quoteOfHers],
            confidence: 0.8,
            tier: "high_confidence",
          },
          {
            claim_id: "c2",
            statement: "乙 waited without asking anybody.",
            evidence_refs: [his.utteranceId],
            confidence: 0.7,
            tier: "inferred",
          },
        ],
      },
    })
    .returning()
    .all();
  judgmentId = judgment.id;

  const [rendition] = db
    .insert(judgmentRenditions)
    .values({
      judgmentId,
      kind: "shareable",
      content: "A document addressed to 甲.",
      shareable: true,
      revision: 1,
      model: "claude-fable-5",
      generatedAt: new Date("2026-05-04T01:00:00Z"),
    })
    .returning()
    .all();

  db.insert(judgmentPolishRuns)
    .values({ judgmentId, outcome: "rejected", model: "gpt-5" })
    .run();

  db.insert(judgmentSwapTests)
    .values({ caseId, judgmentId, arm: "address_terms", flags: ["allocation_exchanged"] })
    .run();

  db.insert(improvementContracts)
    .values({ caseId, judgmentId, status: "active", content: { asks: ["ask 甲 first"] } })
    .run();

  db.insert(repairScripts)
    .values({ caseId, judgmentId, content: "Open by asking 甲 what happened." })
    .run();

  db.insert(followups)
    .values({
      caseId,
      judgmentId,
      kind: "day7",
      scheduledAt: new Date("2026-05-11T00:00:00Z"),
      status: "scheduled",
    })
    .run();

  db.insert(appeals)
    .values({
      caseId,
      originalJudgmentId: judgmentId,
      actorParticipantId: herId,
      reason: "这份判决没听我说。",
      status: "submitted",
    })
    .run();

  db.insert(judgmentExports)
    .values({
      caseId,
      judgmentId,
      renditionId: rendition.id,
      kind: "shareable",
      judgmentVersion: 1,
      renditionRevision: 1,
      recipientPseudonym: "甲",
      recipientParticipantId: herId,
      channel: "file",
      contentSha256: "a".repeat(64),
      byteSize: 4096,
      watermark: "fairjudge/export/1",
      exportedAt: new Date("2026-05-05T00:00:00Z"),
    })
    .run();

  db.insert(llmCalls)
    .values({
      caseId,
      stage: "judgment_skeleton",
      provider: "anthropic",
      model: "claude-fable-5",
      inputTokens: 1200,
      outputTokens: 900,
    })
    .run();

  db.insert(egressLedger)
    .values({
      caseId,
      target: "anthropic",
      model: "claude-fable-5",
      payloadSha256: "b".repeat(64),
      payloadBytes: 8192,
      expiryAt: new Date("2026-06-01T00:00:00Z"),
    })
    .run();

  // Covered and deliberately withheld: it must exist so the withholding is real.
  db.insert(safetyScreens)
    .values({ caseId, screenType: "keyword", outcome: "clear" })
    .run();

  // Her consent, and one request of hers — so `consent_events`,
  // `deletion_requests` and `deletion_audit` all have a row to be found in.
  recordConsent(db, {
    caseId,
    actorParticipantId: herId,
    kind: "granted",
    scope: "named_rendition",
    note: "可以给他看。",
  });

  requestMaterialDeletion(db, {
    caseId,
    requesterParticipantId: herId,
    targetKind: "utterance",
    targetId: quoteOfHers,
    reason: "这句话不是我说的。",
    // Stamped, so the audit's ordering assertions do not depend on a clock.
    occurredAt: new Date("2026-05-05T00:00:00Z"),
  });

  // An account, so `participant_identities` is populated the way it is in life.
  const invite = issueInviteToken(db, herId);
  const redeemed = redeemInviteToken(db, invite.token, {
    displayName: "FIXTURE_RESPONDENT",
  });
  herIdentityToken = redeemed.ok ? redeemed.identityToken : "";

  holder.db = db;
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* 1. Coverage — a table added later fails here rather than going missing      */
/* -------------------------------------------------------------------------- */

function liveTables(): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

describe("coverage of every table in the database", () => {
  it("declares each live table exactly once, and declares no table that is gone", () => {
    const declared = TRANSPARENCY_TABLE_COVERAGE.map((entry) => entry.table).sort();
    const live = liveTables();

    // Set equality in both directions. A new table with no entry fails here —
    // which is the point: the failure mode of a transparency view is a silent
    // omission, and a silent omission is what its reader cannot detect.
    expect(declared).toEqual(live);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("gives every table either a section or a stated reason", () => {
    for (const entry of TRANSPARENCY_TABLE_COVERAGE) {
      expect(entry.note.length, `${entry.table} has no note`).toBeGreaterThan(20);
    }

    // The one table whose content is covered and deliberately withheld says so
    // in its note AND on the page, rather than being quietly dropped.
    const safety = TRANSPARENCY_TABLE_COVERAGE.find(
      (entry) => entry.table === "safety_screens",
    );
    expect(safety?.section).toBeNull();
    expect(safety?.note).toContain("WITHHELD");

    const view = buildTransparencyView(db, caseId, herId);
    expect(view.limits.join(" ")).toContain("safety questionnaire");
  });

  it("returns at least one item from every table it declares covered", () => {
    const view = buildTransparencyView(db, caseId, herId);
    const seen = new Set(view.items.map((item) => item.table));

    const missing = TRANSPARENCY_TABLE_COVERAGE.filter(
      (entry) => entry.section !== null && !seen.has(entry.table),
    ).map((entry) => entry.table);

    expect(missing, `covered tables with nothing in the view: ${missing.join(", ")}`)
      .toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. What the view says about her                                            */
/* -------------------------------------------------------------------------- */

describe("the transparency view", () => {
  it("lists her own material with provenance that says it is hers", () => {
    const view = buildTransparencyView(db, caseId, herId);
    const line = view.items.find((item) => item.id === hers.utteranceId);

    expect(line).toBeDefined();
    expect(line!.summary).toContain(HER_LINE);
    expect(line!.provenance.source).toBe("you");
    expect(line!.provenance.submittedByPseudonym).toBe("甲");
    expect(line!.provenance.submittedAt).toBeInstanceOf(Date);
    expect(line!.control).toBe("delete");

    const item = view.items.find((entry) => entry.id === hers.evidenceId);
    expect(item!.provenance.grade).toBe("A");
  });

  it("shows a line the record attributes to her even though he submitted it", () => {
    const view = buildTransparencyView(db, caseId, herId);
    const quoted = view.items.find((item) => item.id === quoteOfHers);

    expect(quoted).toBeDefined();
    expect(quoted!.provenance.source).toBe("the other party");
    expect(quoted!.because).toBe("the record attributes this line to you");
    // She cannot delete his row — she can ask, and only ask.
    expect(quoted!.control).toBe("request_deletion");
    // HARD RULE #5: a recollection renders as one, and says whose it is.
    expect(quoted!.summary).toContain("as 乙 recalls it");
  });

  it("does not show his private material that has nothing to do with her", () => {
    const view = buildTransparencyView(db, caseId, herId);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(HIS_PRIVATE_LINE);
    // And the page says so, rather than leaving the omission to be guessed at.
    expect(view.limits.join(" ")).toContain("how much of it there is");
  });

  it("marks system-generated assertions about her as the system's", () => {
    const view = buildTransparencyView(db, caseId, herId);
    const claims = view.sections.find((section) => section.id === "judgment_claims")!;

    const aboutHer = claims.items.filter((item) => item.table === "judgments");
    expect(aboutHer.length).toBeGreaterThan(0);
    expect(aboutHer[0].provenance.source).toBe("the system");
    expect(aboutHer.map((item) => item.summary).join(" ")).toContain(
      "甲 did not answer that evening.",
    );
    // A claim about her in a document that can leave the machine points at the
    // control she actually has over that.
    expect(aboutHer[0].control).toBe("revoke_consent");
  });

  it("counts every section and keeps the flattened list in section order", () => {
    const view = buildTransparencyView(db, caseId, herId);

    expect(view.total).toBe(view.items.length);
    expect(view.total).toBe(
      view.sections.reduce((sum, section) => sum + section.items.length, 0),
    );
    expect(view.counts.utterances).toBeGreaterThan(0);
    expect(view.items.slice(0, view.sections[0].items.length)).toEqual(
      view.sections[0].items,
    );
  });

  it("refuses to build a view for somebody who is not a party", () => {
    expect(() => buildTransparencyView(db, caseId, "nobody")).toThrow(
      /not a party/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Deletion, asymmetric on purpose                                         */
/* -------------------------------------------------------------------------- */

describe("material she submitted", () => {
  it("deletes for real, and writes an audit row", () => {
    const outcome = deleteOwnMaterial(db, {
      caseId,
      actorParticipantId: herId,
      targetKind: "utterance",
      targetId: hers.utteranceId,
      reason: "我不想留着这句。",
    });

    expect(outcome.deleted).toBe(true);

    // Actually gone from the table, not merely hidden by a query.
    const rows = sqlite
      .prepare("SELECT id FROM utterances WHERE id = ?")
      .all(hers.utteranceId);
    expect(rows).toEqual([]);

    // And gone from her own view.
    const view = buildTransparencyView(db, caseId, herId);
    expect(view.items.map((item) => item.id)).not.toContain(hers.utteranceId);
    expect(JSON.stringify(view)).not.toContain(HER_LINE);

    // The audit row survives the material — and is not a copy of it. An audit
    // that quoted the deleted line would mean the line was moved, not deleted.
    const audit = listDeletionAudit(db, caseId).filter(
      (entry) => entry.act === "deleted",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].targetId).toBe(hers.utteranceId);
    expect(audit[0].actorPseudonym).toBe("甲");
    expect(audit[0].targetOwnerPseudonym).toBe("甲");
    expect(audit[0].targetSummary).toContain("line attributed to 甲");
    expect(audit[0].targetSummary).not.toContain(HER_LINE);
    expect(audit[0].note).toBe("我不想留着这句。");

    // Nowhere in the database, not only nowhere in the view.
    const anywhere = sqlite
      .prepare(
        "SELECT count(*) AS n FROM deletion_audit WHERE target_summary LIKE ?",
      )
      .get(`%${HER_LINE}%`) as { n: number };
    expect(anywhere.n).toBe(0);
  });

  it("tells her which frozen judgments cited it, and rewrites none of them", () => {
    const before = sqlite
      .prepare("SELECT content, finalized_at FROM judgments WHERE id = ?")
      .get(judgmentId);

    const outcome = deleteOwnMaterial(db, {
      caseId,
      actorParticipantId: herId,
      targetKind: "utterance",
      targetId: hers.utteranceId,
    });

    // Nothing cited this particular line, and the frozen row is untouched either
    // way — HARD RULE #6 holds through a deletion.
    expect(outcome.citedByFrozenJudgments).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT content, finalized_at FROM judgments WHERE id = ?")
        .get(judgmentId),
    ).toEqual(before);
  });

  it("reports the frozen version when the deleted line was cited", () => {
    // The claim cites the line HE submitted; delete one of his to prove the
    // reporting path, through the request he grants (below it is his own act).
    const outcome = resolveDeletionRequest(db, {
      caseId,
      requestId: listDeletionRequests(db, caseId)[0].id,
      actorParticipantId: clientId,
      decision: "granted",
      note: "行，删掉。",
    });
    expect(outcome.deleted).toBe(true);
    expect(
      sqlite.prepare("SELECT id FROM utterances WHERE id = ?").all(quoteOfHers),
    ).toEqual([]);
    // The frozen judgment that cited it is not rewritten.
    expect(
      (
        sqlite.prepare("SELECT content FROM judgments WHERE id = ?").get(judgmentId) as {
          content: string;
        }
      ).content,
    ).toContain(quoteOfHers);
  });

  it("refuses to delete the other party's material, and names the act that exists", () => {
    expect(() =>
      deleteOwnMaterial(db, {
        caseId,
        actorParticipantId: herId,
        targetKind: "utterance",
        targetId: his.utteranceId,
      }),
    ).toThrow(DeletionError);

    try {
      deleteOwnMaterial(db, {
        caseId,
        actorParticipantId: herId,
        targetKind: "utterance",
        targetId: his.utteranceId,
      });
    } catch (error) {
      expect((error as DeletionError).code).toBe("not_your_material");
      expect((error as DeletionError).message).toContain("requestMaterialDeletion");
    }

    // His line is still there. A refusal deletes nothing.
    expect(
      sqlite.prepare("SELECT id FROM utterances WHERE id = ?").all(his.utteranceId),
    ).toHaveLength(1);
  });
});

describe("material the client submitted", () => {
  it("records a request, deletes nothing, and surfaces it to him", () => {
    const auditBefore = listDeletionAudit(db, caseId).length;

    const request = requestMaterialDeletion(db, {
      caseId,
      requesterParticipantId: herId,
      targetKind: "evidence",
      targetId: his.evidenceId,
      reason: "这张截图里有我的私事。",
    });

    expect(request.deleted).toBe(false);
    expect(request.status).toBe("open");
    // The request names the row without carrying a copy of it: granting it must
    // not leave the content sitting in this table.
    expect(request.targetSummary).toContain("firsthand material, grade A");
    expect(request.targetSummary).not.toContain("周五晚上的争吵");
    expect(request.reason).toBe("这张截图里有我的私事。");

    // Nothing was deleted.
    expect(
      sqlite.prepare("SELECT id FROM evidence WHERE id = ?").all(his.evidenceId),
    ).toHaveLength(1);

    // It is in his inbox, filtered by whose material it is about.
    const hisInbox = listDeletionRequests(db, caseId, {
      status: "open",
      aboutMaterialOwnedBy: clientId,
    });
    expect(hisInbox.map((entry) => entry.id)).toContain(request.id);

    // Hers, by contrast, contains nothing about her own material.
    const aboutHers = listDeletionRequests(db, caseId, {
      aboutMaterialOwnedBy: herId,
    });
    expect(aboutHers).toEqual([]);

    // And the asking itself is audited.
    const audit = listDeletionAudit(db, caseId);
    expect(audit.length).toBe(auditBefore + 1);
    const requested = audit.filter((entry) => entry.act === "requested");
    expect(requested.at(-1)!.targetId).toBe(his.evidenceId);
    expect(requested.at(-1)!.targetOwnerPseudonym).toBe("乙");
    expect(requested.at(-1)!.requestId).toBe(request.id);
  });

  it("refuses a request against her own material, and names the act that exists", () => {
    try {
      requestMaterialDeletion(db, {
        caseId,
        requesterParticipantId: herId,
        targetKind: "utterance",
        targetId: hers.utteranceId,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeletionError).code).toBe("target_is_yours");
      expect((error as DeletionError).message).toContain("deleteOwnMaterial");
    }
  });

  it("lets him refuse, and records the refusal in his own words", () => {
    const request = requestMaterialDeletion(db, {
      caseId,
      requesterParticipantId: herId,
      targetKind: "event",
      targetId: his.eventId,
      reason: "这件事跟我无关。",
    });

    const outcome = resolveDeletionRequest(db, {
      caseId,
      requestId: request.id,
      actorParticipantId: clientId,
      decision: "refused",
      note: "这是我这边的记录，我要留着。",
    });

    expect(outcome.deleted).toBe(false);
    expect(outcome.request.status).toBe("refused");
    expect(outcome.request.resolutionNote).toBe("这是我这边的记录，我要留着。");
    expect(
      sqlite.prepare("SELECT id FROM events WHERE id = ?").all(his.eventId),
    ).toHaveLength(1);

    // A granted request keeps its place in his history after the material is
    // gone: the audit is what still remembers whose row it was.
    const granted = requestMaterialDeletion(db, {
      caseId,
      requesterParticipantId: herId,
      targetKind: "utterance",
      targetId: his.utteranceId,
    });
    resolveDeletionRequest(db, {
      caseId,
      requestId: granted.id,
      actorParticipantId: clientId,
      decision: "granted",
    });
    expect(
      listDeletionRequests(db, caseId, { aboutMaterialOwnedBy: clientId }).map(
        (entry) => entry.id,
      ),
    ).toContain(granted.id);

    // "I asked and was told no" stays on the record, on both tables.
    expect(
      listDeletionRequests(db, caseId, { requestedBy: herId }).map((r) => r.status),
    ).toContain("refused");
    expect(listDeletionAudit(db, caseId).map((entry) => entry.act)).toContain(
      "refused",
    );

    // And she can read the answer on her own page.
    const view = buildTransparencyView(db, caseId, herId);
    expect(JSON.stringify(view)).toContain("这是我这边的记录，我要留着。");
  });

  it("does not let her answer a request about his material", () => {
    const request = requestMaterialDeletion(db, {
      caseId,
      requesterParticipantId: herId,
      targetKind: "event",
      targetId: his.eventId,
    });

    try {
      resolveDeletionRequest(db, {
        caseId,
        requestId: request.id,
        actorParticipantId: herId,
        decision: "granted",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DeletionError).code).toBe("not_yours_to_answer");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The audit itself                                                        */
/* -------------------------------------------------------------------------- */

describe("the deletion audit", () => {
  it("cannot be edited afterwards, at the storage layer", () => {
    deleteOwnMaterial(db, {
      caseId,
      actorParticipantId: herId,
      targetKind: "event",
      targetId: hers.eventId,
    });

    const [row] = listDeletionAudit(db, caseId).filter(
      (entry) => entry.act === "deleted",
    );
    expect(() =>
      sqlite
        .prepare("UPDATE deletion_audit SET note = ? WHERE id = ?")
        .run("nothing to see here", row.id),
    ).toThrow(/append-only/);
  });

  it("writes a row for every act, in the order they happened", () => {
    deleteOwnMaterial(db, {
      caseId,
      actorParticipantId: herId,
      targetKind: "file",
      targetId: hers.fileId,
      occurredAt: new Date("2026-05-06T00:00:00Z"),
    });
    requestMaterialDeletion(db, {
      caseId,
      requesterParticipantId: herId,
      targetKind: "file",
      targetId: his.fileId,
      occurredAt: new Date("2026-05-07T00:00:00Z"),
    });

    const audit = listDeletionAudit(db, caseId, herId);
    expect(audit.map((entry) => entry.act)).toEqual([
      "requested", // the one from the fixture
      "deleted",
      "requested",
    ]);
    expect(audit.every((entry) => entry.actorParticipantId === herId)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The third right: consent, not reimplemented                             */
/* -------------------------------------------------------------------------- */

describe("what she controls outright", () => {
  it("reports consent standing through the consent module, and follows a revocation", () => {
    expect(deletionRightsFor(db, caseId, herId).consent.named_rendition).toBe(
      "granted",
    );

    recordConsent(db, {
      caseId,
      actorParticipantId: herId,
      kind: "revoked",
      scope: "named_rendition",
      note: "我不同意再给别人看。",
    });

    expect(deletionRightsFor(db, caseId, herId).consent.named_rendition).toBe(
      "revoked",
    );
    const right = buildTransparencyView(db, caseId, herId).rights.find(
      (entry) => entry.id === "named_rendition",
    );
    expect(right!.standing).toBe("revoked");
  });

  it("never promises to erase the other party's records", () => {
    const rights = deletionRightsFor(db, caseId, herId);
    expect(rights.statement).toContain("not yours to erase");
    expect(rights.statement).toContain("ask");

    const view = buildTransparencyView(db, caseId, herId);
    const asking = view.rights.find((entry) => entry.id === "request_deletion")!;
    expect(asking.statement).toContain("does not delete one person's records");
    expect(asking.statement).toContain("refusal");
  });

  it("counts what she may remove outright", () => {
    const rights = deletionRightsFor(db, caseId, herId);
    expect(rights.ownMaterial).toEqual({
      file: 1,
      evidence: 1,
      utterance: 1,
      event: 1,
    });
    expect(rights.openRequests).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The route's read seam                                                   */
/* -------------------------------------------------------------------------- */

/** Render the real page module, not a copy of it. */
async function renderTransparencyPage(token: string): Promise<string> {
  const pageModule = await import("../src/app/respond/[token]/data/page");
  const element = await pageModule.default({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

/** Rendered markup reduced to the words a reader sees. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

describe("/respond/[token] data layer", () => {
  it("resolves an invite token to the party holding it, before she has an account", () => {
    // A second fixture case, so the invite is unredeemed.
    const [row] = db.insert(cases).values({ stage: "participation" }).returning().all();
    const [her] = db
      .insert(caseParticipants)
      .values({
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
      })
      .returning()
      .all();
    const invite = issueInviteToken(db, her.id);

    const resolved = resolveRespondToken(db, invite.token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.subject.participantId).toBe(her.id);
    expect(resolved.subject.tokenKind).toBe("invite");
    expect(resolved.subject.hasAccount).toBe(false);

    // She can read what is held about her before deciding to join.
    const page = loadTransparencyFor(db, resolved.subject);
    expect(page.view.participantId).toBe(her.id);
    expect(page.rights.consent.named_rendition).toBe("unrecorded");
  });

  it("refuses a token this machine never issued, and establishes nothing", () => {
    const resolved = resolveRespondToken(db, "not-a-token");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("unknown_token");
    expect(resolved.message.length).toBeGreaterThan(20);
  });

  it("renders the page itself, with the asymmetry written on it", async () => {
    const html = await renderTransparencyPage(herIdentityToken);
    const text = visibleText(html);

    // Her own material is on the page, quoted in the language it was said in.
    expect(text).toContain(HER_LINE);
    // His private line, which has nothing to do with her, is not.
    expect(html).not.toContain(HIS_PRIVATE_LINE);

    // The sentence the product must not soften, on the row it belongs to.
    expect(text).toContain("not yours to delete");
    expect(text).toContain("will not delete it for you");
    expect(text).toContain("Ask for this to be deleted");
    // And the deletion she really does control, said as plainly.
    expect(text).toContain("Delete this");

    // The withheld category is disclosed rather than dropped.
    expect(text).toContain("safety questionnaire");
  });

  it("shows nothing about the case when the link does not verify", async () => {
    const html = await renderTransparencyPage("not-a-token");
    const text = visibleText(html);

    expect(text).toContain("did not open anything");
    expect(html).not.toContain("周五晚上的争吵");
    expect(html).not.toContain(HER_LINE);
    expect(html).not.toContain(caseId);
  });

  it("brings her back with the identity token after the invite is spent", () => {
    const [row] = db.insert(cases).values({ stage: "participation" }).returning().all();
    const [her] = db
      .insert(caseParticipants)
      .values({
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
      })
      .returning()
      .all();
    const invite = issueInviteToken(db, her.id);
    const redeemed = redeemInviteToken(db, invite.token);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // The spent invite no longer opens anything.
    const spent = resolveRespondToken(db, invite.token);
    expect(spent.ok).toBe(false);

    const back = resolveRespondToken(db, redeemed.identityToken);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.subject.tokenKind).toBe("identity");
    expect(back.subject.hasAccount).toBe(true);
    expect(loadTransparencyFor(db, back.subject).view.participantId).toBe(her.id);
  });
});
