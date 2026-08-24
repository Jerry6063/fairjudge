/**
 * The asymmetric-wait surface (doc 05 §A.2).
 *
 * What is worth asserting here is not that a panel renders. It is that the three
 * refusals §A.2 makes are properties of the read model rather than habits of a
 * component — a screen cannot show a number the view does not carry, and a screen
 * CAN show one it does. So the tests below are mostly about absence:
 *
 *   - nothing in `WaitView` counts her lines, her words or her progress;
 *   - `respond_state = 'opened'` never becomes an act;
 *   - the invitation's expiry is carried on the invitation and nowhere near the
 *     level or the judgment, and it moves neither.
 *
 * Plus the two things the surface must be able to say (05 §C amendment 3): what
 * has happened, and what would change the case's level.
 *
 * The copy is asserted where it makes a claim about a person — a decline has to
 * read like every other fact — and where doc 04 amendment 2 bans a word.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page reads the process-wide database; hand it the one under test.
// `importActual` is how the real `createDb` stays reachable from a mocked module.
const holder: { db: Db } = { db: null as unknown as Db };

vi.mock("../src/server/db", () => ({
  getDb: () => holder.db,
}));

// The invitation action revalidates the case page. There is no request scope
// here, and the write it guards is what this suite is about.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInvitationAction } from "../src/app/case/[id]/invite-actions";
import {
  ACT_COPY,
  ANSWER_COPY,
  DECLINE_CONSEQUENCE,
  INVITE_LINK_FACTS,
  REFUSALS,
  THE_GAP,
  UNBLOCKING_CONDITION,
} from "../src/app/case/[id]/wait-labels";
import { MINTING_CLOSED_BY_DECLINE } from "../src/server/access/invite";
import { recordConsent } from "../src/server/access/consent";
import { buildWaitView, type WaitView } from "../src/server/cases/wait-view";
import type { Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  clarificationRounds,
  judgments,
  utterances,
} from "../src/server/db/schema";

let db: Db;
let sqlite: Database.Database;

const DAY = 24 * 60 * 60 * 1000;

interface SeedOptions {
  readonly invitedAt?: Date | null;
  readonly clientPendingLines?: number;
  readonly clientConfirmedLines?: number;
  /** Hers, with their confirmation state. Owned by her, `private`, as `/respond` writes them. */
  readonly herLines?: readonly { readonly confirmed: boolean }[];
}

interface Seeded {
  readonly caseId: string;
  readonly clientId: string;
  readonly herId: string;
}

function seed(options: SeedOptions = {}): Seeded {
  const [row] = db
    .insert(cases)
    .values({ stage: "participation", title: "fixture" })
    .returning()
    .all();

  const parties = db
    .insert(caseParticipants)
    .values([
      {
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
      },
    ])
    .returning()
    .all();

  const client = parties.find((party) => party.isSubmitter)!;
  const her = parties.find((party) => !party.isSubmitter)!;

  if (options.invitedAt !== undefined && options.invitedAt !== null) {
    db.update(caseParticipants)
      .set({
        inviteTokenHash: "hash",
        inviteTokenIssuedAt: options.invitedAt,
        inviteTokenExpiresAt: new Date(options.invitedAt.getTime() + 14 * DAY),
        respondState: "invited",
        respondStateAt: options.invitedAt,
      })
      .where(eq(caseParticipants.id, her.id))
      .run();
  }

  let order = 0;
  const line = (values: Record<string, unknown>) => {
    db.insert(utterances)
      .values({
        caseId: row.id,
        orderKey: `a${order++}`,
        ...values,
      } as typeof utterances.$inferInsert)
      .run();
  };

  for (let i = 0; i < (options.clientPendingLines ?? 0); i += 1) {
    line({
      speakerLabel: "乙",
      aiDraft: "his line",
      confirmStatus: "pending",
      ownerParticipantId: client.id,
    });
  }
  for (let i = 0; i < (options.clientConfirmedLines ?? 0); i += 1) {
    line({
      speakerLabel: "乙",
      aiDraft: "his line",
      humanFinal: "his line",
      confirmStatus: "confirmed",
      ownerParticipantId: client.id,
    });
  }
  for (const hers of options.herLines ?? []) {
    line({
      speakerParticipantId: her.id,
      speakerLabel: "甲",
      humanFinal: "her line",
      confirmStatus: hers.confirmed ? "confirmed" : "pending",
      ownerParticipantId: her.id,
      visibility: "private",
    });
  }

  return { caseId: row.id, clientId: client.id, herId: her.id };
}

/** The frozen judgment the wait is a wait around. Text is never needed here. */
function freezeJudgment(caseId: string, frozenAt: Date): void {
  db.insert(judgments)
    .values({
      caseId,
      version: 1,
      outputLevel: "L2",
      model: "claude-fable-5",
      status: "final",
      finalizedAt: frozenAt,
    })
    .run();
}

/** Every number the view carries, at any depth. Dates are not numbers here. */
function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === "number") found.push(value);
  else if (value instanceof Date) {
    /* a stored instant, not a measurement */
  } else if (Array.isArray(value)) {
    for (const item of value) numbersIn(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) numbersIn(item, found);
  }
  return found;
}

function actOf(view: WaitView, code: string) {
  const found = view.acts.find((item) => item.code === code);
  if (found === undefined) throw new Error(`no act ${code}`);
  return found;
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../src/server/db")>(
    "../src/server/db",
  );
  ({ db, sqlite } = actual.createDb(":memory:"));
  actual.runMigrations(db);
  holder.db = db;
});

afterEach(() => {
  sqlite.close();
});

/** Import and render the real case page, exactly as the route does. */
async function renderCasePage(caseId: string): Promise<string> {
  const pageModule = await import("../src/app/case/[id]/page");
  const element = await pageModule.default({
    params: Promise.resolve({ id: caseId }),
  });
  return renderToStaticMarkup(element);
}

/** Tags out, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */

describe("the wait view", () => {
  it("has nothing to describe when the case has only one party", () => {
    const [row] = db.insert(cases).values({ stage: "intake" }).returning().all();
    db.insert(caseParticipants)
      .values({
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
      })
      .run();

    expect(buildWaitView(db, row.id)).toBeNull();
  });

  it("reports the invitation as one completed act with its own timestamp", () => {
    const invitedAt = new Date("2026-08-20T09:00:00Z");
    const { caseId } = seed({ invitedAt });
    const view = buildWaitView(db, caseId)!;

    const invitation = actOf(view, "invitation_created");
    expect(invitation.recorded).toBe(true);
    expect(invitation.at?.toISOString()).toBe(invitedAt.toISOString());
    expect(invitation.credentialExpiresAt?.getTime()).toBe(
      invitedAt.getTime() + 14 * DAY,
    );

    // And nothing after it.
    for (const code of [
      "answered",
      "statement_submitted",
      "confirmation_complete",
      "rehearing_available",
    ]) {
      expect(actOf(view, code).recorded).toBe(false);
      expect(actOf(view, code).at).toBeNull();
    }
  });

  it("does not turn opening the page into an act", () => {
    const { caseId, herId } = seed({ invitedAt: new Date("2026-08-20T09:00:00Z") });
    db.update(caseParticipants)
      .set({ respondState: "opened", respondStateAt: new Date() })
      .where(eq(caseParticipants.id, herId))
      .run();

    const view = buildWaitView(db, caseId)!;
    expect(actOf(view, "answered").recorded).toBe(false);
    expect(actOf(view, "answered").answer).toBeNull();
    // The whole view, serialized, says nothing about her having opened it.
    expect(JSON.stringify(view)).not.toContain("opened");
  });

  it("carries no count, no length and no progress of hers", () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      clientPendingLines: 2,
      herLines: [
        { confirmed: false },
        { confirmed: false },
        { confirmed: false },
        { confirmed: false },
        { confirmed: false },
        { confirmed: false },
        { confirmed: false },
      ],
    });

    const view = buildWaitView(db, caseId)!;
    // Seven lines of hers are on the machine. No number anywhere in the view is
    // seven, or any other fact about how much she has written: the only counts
    // it carries are the client's own outstanding work.
    expect(numbersIn(view)).not.toContain(7);
    expect(view.ownWork.unconfirmedLines).toBe(2);
    expect(actOf(view, "statement_submitted").recorded).toBe(true);
    expect(actOf(view, "confirmation_complete").recorded).toBe(false);
  });

  it("records her confirmation as complete only when nothing of hers is pending", () => {
    const { caseId, herId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      herLines: [{ confirmed: true }, { confirmed: false }],
    });
    expect(actOf(buildWaitView(db, caseId)!, "confirmation_complete").recorded).toBe(
      false,
    );

    db.update(utterances)
      .set({ confirmStatus: "confirmed" })
      .where(eq(utterances.ownerParticipantId, herId))
      .run();

    const after = buildWaitView(db, caseId)!;
    const complete = actOf(after, "confirmation_complete");
    expect(complete.recorded).toBe(true);
    expect(complete.at).not.toBeNull();
  });

  it("reads a granted consent as her answer, off the append-only log", () => {
    const { caseId, herId } = seed({ invitedAt: new Date("2026-08-20T09:00:00Z") });
    const occurredAt = new Date("2026-08-22T18:30:00Z");
    recordConsent(db, {
      caseId,
      actorParticipantId: herId,
      kind: "granted",
      scope: "case_record",
      occurredAt,
    });

    const answered = actOf(buildWaitView(db, caseId)!, "answered");
    expect(answered.recorded).toBe(true);
    expect(answered.answer).toBe("consented");
    expect(answered.at?.toISOString()).toBe(occurredAt.toISOString());
  });

  it("stops reading a revoked grant as a standing answer", () => {
    const { caseId, herId } = seed({ invitedAt: new Date("2026-08-20T09:00:00Z") });
    recordConsent(db, {
      caseId,
      actorParticipantId: herId,
      kind: "granted",
      scope: "case_record",
      occurredAt: new Date("2026-08-22T18:30:00Z"),
    });
    recordConsent(db, {
      caseId,
      actorParticipantId: herId,
      kind: "revoked",
      scope: "case_record",
      occurredAt: new Date("2026-08-23T09:00:00Z"),
    });

    expect(actOf(buildWaitView(db, caseId)!, "answered").recorded).toBe(false);
  });

  it("records a decline as her act, with its date and nothing else", () => {
    const declinedAt = new Date("2026-08-24T11:05:00Z");
    const { caseId, herId } = seed({ invitedAt: new Date("2026-08-20T09:00:00Z") });
    db.update(caseParticipants)
      .set({
        respondState: "declined",
        respondStateAt: declinedAt,
        participationState: "refused",
        declineReason: "我不想参与这个。",
      })
      .where(eq(caseParticipants.id, herId))
      .run();

    const view = buildWaitView(db, caseId)!;
    const answered = actOf(view, "answered");
    expect(answered.recorded).toBe(true);
    expect(answered.answer).toBe("declined");
    expect(answered.at?.toISOString()).toBe(declinedAt.toISOString());

    // Her words are hers. The view carries the fact, never the reason.
    expect(JSON.stringify(view)).not.toContain("我不想参与这个。");
    // And a refusal does not move the level.
    expect(view.level.derivesNow).not.toBe("L1");
  });

  it("offers a re-hearing only once the record derives a different level", () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      clientConfirmedLines: 1,
    });
    freezeJudgment(caseId, new Date("2026-08-21T12:00:00Z"));
    db.update(cases)
      .set({ outputLevel: "L2", outputLevelLockedAt: new Date() })
      .where(eq(cases.id, caseId))
      .run();

    expect(actOf(buildWaitView(db, caseId)!, "rehearing_available").recorded).toBe(
      false,
    );

    // She joins and confirms material of her own: the record now derives L1.
    const { herId } = { herId: db.select().from(caseParticipants).all().find((p) => !p.isSubmitter)!.id };
    db.update(caseParticipants)
      .set({ participationState: "written_response" })
      .where(eq(caseParticipants.id, herId))
      .run();
    db.insert(utterances)
      .values({
        caseId,
        orderKey: "z0",
        speakerParticipantId: herId,
        speakerLabel: "甲",
        humanFinal: "her line",
        confirmStatus: "confirmed",
        ownerParticipantId: herId,
        visibility: "private",
      })
      .run();
    recordConsent(db, {
      caseId,
      actorParticipantId: herId,
      kind: "granted",
      scope: "case_record",
    });

    const after = buildWaitView(db, caseId)!;
    expect(after.level.stale).toBe(true);
    expect(after.level.derivesNow).toBe("L1");
    expect(actOf(after, "rehearing_available").recorded).toBe(true);
    // And the frozen judgment is untouched by any of it.
    expect(after.judgment?.level).toBe("L2");
    expect(after.stillOneSided).toBe(false);
  });

  it("names the rule that bound, so the key can be the answer to it", () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      clientConfirmedLines: 1,
    });
    const view = buildWaitView(db, caseId)!;

    expect(view.level.derivesNow).toBe("L2");
    expect(view.level.reason).toBe("counterparty_absent");
    expect(view.level.rationale.length).toBeGreaterThan(0);
    expect(view.level.findings.length).toBeGreaterThan(0);
    expect(UNBLOCKING_CONDITION[view.level.reason]).toContain("she answers");
  });

  it("counts the client's own outstanding work and never hers", () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      clientPendingLines: 3,
      clientConfirmedLines: 1,
      herLines: [{ confirmed: false }, { confirmed: false }],
    });
    db.insert(clarificationRounds)
      .values({
        caseId,
        roundNumber: 1,
        questions: [
          { id: "q1", question: "one?" },
          { id: "q2", question: "two?" },
          { id: "q3", question: "three?" },
        ],
        answers: [
          { questionId: "q1", answer: "yes", answeredAt: Date.now() },
          { questionId: "q2", state: "declined", declinedAt: Date.now() },
        ],
      } as typeof clarificationRounds.$inferInsert)
      .run();

    const view = buildWaitView(db, caseId)!;
    expect(view.ownWork.unconfirmedLines).toBe(3);
    expect(view.ownWork.openClarificationQuestions).toBe(1);
    expect(view.ownWork.clarificationRoundOpen).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("the wait surface on screen", () => {
  it("answers the three questions §C amendment 3 accepts on", async () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      clientConfirmedLines: 1,
      clientPendingLines: 4,
    });
    freezeJudgment(caseId, new Date("2026-08-21T12:00:00Z"));
    db.update(cases)
      .set({ outputLevel: "L2", outputLevelLockedAt: new Date() })
      .where(eq(cases.id, caseId))
      .run();

    const text = visibleText(await renderCasePage(caseId));

    // ① What is happening: the standing record, and the acts under it.
    expect(text).toContain("Version 1 stands, at L2");
    expect(text).toContain("An invitation was created");
    expect(text).toContain("2026-08-20 09:00 UTC");
    expect(text).toContain("She has not answered");
    expect(text).toContain(THE_GAP);

    // ② What is not being shown, and why.
    expect(text).toContain("What this screen will not show you, and why");
    for (const refusal of REFUSALS) {
      expect(text).toContain(refusal.withheld);
    }

    // ③ What would change the level.
    expect(text).toContain("What would change it");
    expect(text).toContain(UNBLOCKING_CONDITION.counterparty_absent);

    // And the work that does not wait on her, with somewhere to go and do it.
    expect(text).toContain("4 lines of yours still unconfirmed");
    expect(await renderCasePage(caseId)).toContain('href="/evidence"');
  });

  it("renders a decline in the same register as every other fact", async () => {
    const { caseId, herId } = seed({ invitedAt: new Date("2026-08-20T09:00:00Z") });
    db.update(caseParticipants)
      .set({
        respondState: "declined",
        respondStateAt: new Date("2026-08-24T11:05:00Z"),
        participationState: "refused",
        declineReason: "我不想参与这个。",
      })
      .where(eq(caseParticipants.id, herId))
      .run();

    const text = visibleText(await renderCasePage(caseId));

    expect(text).toContain("She answered");
    expect(text).toContain(ANSWER_COPY.declined);
    expect(text).toContain("2026-08-24 11:05 UTC");
    expect(text).toContain("changes nothing about the merits");
    // Her words stay hers.
    expect(text).not.toContain("我不想参与这个。");

    // And nothing on the wait surface itself treats her answer as an alarm: no
    // adverse palette and no alert role anywhere in the four panels. Rendered
    // on its own, because the pipeline panels below it colour their own
    // blockers amber and that is a different screen's decision.
    const { WaitPanel } = await import("../src/app/case/[id]/wait-panel");
    const panel = renderToStaticMarkup(
      createElement(WaitPanel, { view: buildWaitView(db, caseId)! }),
    );
    expect(panel).not.toMatch(/rose-|red-|amber-|orange-|role="alert"/);
  });

  it("shows nothing of the wait once she owns confirmed material", async () => {
    const { caseId } = seed({
      invitedAt: new Date("2026-08-20T09:00:00Z"),
      herLines: [{ confirmed: true }],
    });
    const text = visibleText(await renderCasePage(caseId));

    expect(text).not.toContain("What this screen will not show you");
    expect(text).not.toContain("An invitation was created");
  });
});

/* -------------------------------------------------------------------------- */

describe("creating the invitation", () => {
  it("mints a link, and the act shows up in the record of acts", async () => {
    const { caseId } = seed();
    expect(actOf(buildWaitView(db, caseId)!, "invitation_created").recorded).toBe(
      false,
    );

    const result = await createInvitationAction({ caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.link).toMatch(/^\/respond\/[A-Za-z0-9_-]{20,}$/);

    const invitation = actOf(buildWaitView(db, caseId)!, "invitation_created");
    expect(invitation.recorded).toBe(true);
    expect(invitation.at).not.toBeNull();
    expect(invitation.credentialExpiresAt).not.toBeNull();

    // Shown once: the plaintext is nowhere in the record.
    const token = result.data.link.slice("/respond/".length);
    expect(JSON.stringify(db.select().from(caseParticipants).all())).not.toContain(
      token,
    );
  });

  it("takes no participant id from the request", async () => {
    const { caseId } = seed();
    // The action's whole input is a case id; the recipient is resolved here.
    const result = await createInvitationAction({ caseId });
    expect(result.ok && result.data.recipientPseudonym).toBe("甲");
  });

  it("offers the control while nothing is live, and not while one is", async () => {
    const { caseId } = seed();
    expect(buildWaitView(db, caseId)!.door.mayMint).toBe(true);
    expect(visibleText(await renderCasePage(caseId))).toContain(
      "Create an invitation",
    );

    await createInvitationAction({ caseId });

    const live = buildWaitView(db, caseId)!;
    expect(live.door.mayMint).toBe(false);
    expect(live.door.liveCredential).toBe(true);
    const text = visibleText(await renderCasePage(caseId));
    expect(text).toContain("A live invitation exists");
    expect(text).not.toContain("Create an invitation");
    expect(text).toContain("cannot be shown again");
  });

  it("offers a replacement once the link has lapsed, and says nothing moved", async () => {
    const { caseId, herId } = seed();
    await createInvitationAction({ caseId });
    db.update(caseParticipants)
      .set({ inviteTokenExpiresAt: new Date(Date.now() - DAY) })
      .where(eq(caseParticipants.id, herId))
      .run();

    const view = buildWaitView(db, caseId)!;
    expect(view.door.expired).toBe(true);
    expect(view.door.mayMint).toBe(true);

    const text = visibleText(await renderCasePage(caseId));
    expect(text).toContain("The invitation link has lapsed");
    expect(text).toContain("Nothing about the case moved when it lapsed");
    expect(text).toContain("Create an invitation");
    // The level did not move with it.
    expect(view.level.derivesNow).not.toBe("L1");
  });

  it("closes minting on a decline, in the words the rule enforces", async () => {
    const { caseId, herId } = seed();
    await createInvitationAction({ caseId });
    db.update(caseParticipants)
      .set({
        respondState: "declined",
        respondStateAt: new Date("2026-08-24T11:05:00Z"),
        participationState: "refused",
      })
      .where(eq(caseParticipants.id, herId))
      .run();

    const view = buildWaitView(db, caseId)!;
    expect(view.door.mayMint).toBe(false);
    expect(view.door.mintingClosedReason).toBe(MINTING_CLOSED_BY_DECLINE);

    const text = visibleText(await renderCasePage(caseId));
    expect(text).toContain("No further invitation will be created");
    expect(text).toContain("No further invitation");
    expect(text).not.toContain("Create an invitation");

    // And the server refuses even if the button is reached some other way.
    const refused = await createInvitationAction({ caseId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("participant_declined");
    expect(refused.message).toBe(MINTING_CLOSED_BY_DECLINE);
  });

  it("renders the anti-badgering rules as content, not as a tooltip", async () => {
    const { caseId } = seed();
    const text = visibleText(await renderCasePage(caseId));
    for (const fact of INVITE_LINK_FACTS) {
      expect(text).toContain(fact);
    }
    expect(text).toContain("Nothing here contacts her");
  });

  it("has nobody to invite when the case has one party", async () => {
    const [row] = db.insert(cases).values({ stage: "intake" }).returning().all();
    db.insert(caseParticipants)
      .values({
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
      })
      .run();

    const result = await createInvitationAction({ caseId: row.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_counterparty");
  });
});

/* -------------------------------------------------------------------------- */

describe("the wait surface's copy", () => {
  it("has a sentence for every act, in both states", () => {
    for (const copy of Object.values(ACT_COPY)) {
      expect(copy.recorded.length).toBeGreaterThan(0);
      expect(copy.absent.length).toBeGreaterThan(0);
      expect(copy.noteRecorded.length).toBeGreaterThan(0);
      expect(copy.noteAbsent.length).toBeGreaterThan(0);
      // The two notes are different sentences: one note for both states is how
      // a timeline explains an act next to a line saying it has not happened.
      expect(copy.noteRecorded).not.toBe(copy.noteAbsent);
    }
  });

  it("has an unblocking condition for every rule the derivation can bind on", () => {
    for (const reason of [
      "safety_refusal",
      "no_citable_record",
      "steelman_unavailable",
      "counterparty_absent",
      "one_sided_material",
      "bilateral",
    ] as const) {
      expect(UNBLOCKING_CONDITION[reason]).toBeTruthy();
    }
  });

  it("states the three refusals with a reason for each", () => {
    expect(REFUSALS.map((r) => r.id)).toEqual([
      "no_progress",
      "no_open_tracking",
      "no_deadline",
    ]);
    for (const refusal of REFUSALS) {
      expect(refusal.reason.length).toBeGreaterThan(80);
    }
    const all = REFUSALS.map((r) => `${r.withheld} ${r.reason}`).join(" ");
    expect(all).toContain("volume must never read as strength");
    expect(all).toContain("cannot read the thing before");
    expect(all).toContain("It never does");
  });

  it("says nothing adverse about a decline", () => {
    const declineCopy = `${ANSWER_COPY.declined} ${DECLINE_CONSEQUENCE}`;
    for (const word of [
      "unfortunately",
      "refused to",
      "failed",
      "sadly",
      "still",
      "overdue",
      "ignored",
    ]) {
      expect(declineCopy.toLowerCase()).not.toContain(word);
    }
    expect(DECLINE_CONSEQUENCE).toContain("changes nothing about the merits");
  });

  it("never calls the product or its output neutral (doc 05 amendment 2)", () => {
    const everything = [
      THE_GAP,
      DECLINE_CONSEQUENCE,
      ...Object.values(ANSWER_COPY),
      ...Object.values(UNBLOCKING_CONDITION),
      ...Object.values(ACT_COPY).flatMap((c) => [
        c.recorded,
        c.absent,
        c.noteRecorded,
        c.noteAbsent,
      ]),
      ...REFUSALS.flatMap((r) => [r.withheld, r.reason]),
    ]
      .join(" ")
      .toLowerCase();

    for (const banned of ["unbiased", "neutral", "objective", "impartial"]) {
      expect(everything).not.toContain(banned);
    }
    // "fair" only ever as part of the product's own name.
    expect(everything.replace(/fairjudge/g, "")).not.toContain("fair");
  });

  it("never describes an unrecorded act as a delay", () => {
    const absences = Object.values(ACT_COPY)
      .map((c) => `${c.absent} ${c.noteAbsent}`)
      .join(" ")
      .toLowerCase();
    for (const word of ["yet to", "overdue", "late", "waiting for her", "still not"]) {
      expect(absences).not.toContain(word);
    }
  });
});
