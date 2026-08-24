/**
 * The state machine, on the external-session channel — `judgmentStageBlocker`.
 *
 * The acceptance walkthrough drove `stage:prepare --stage judgment_skeleton` and
 * then `stage:ingest` against a case still sitting at `intake`, and both
 * succeeded. Nothing in the pipeline between filing and judgment — the safety
 * screen, grading, the clarification rounds, the steelman, the adverse-fact
 * confrontation — is enforced by the judgment stages themselves; all of it is
 * enforced by `canAdvance` refusing a transition. So a generation path that
 * never asks what stage the case is at skips every one of them at once, and it
 * does not look like a bug while it is happening: the bundle is well formed, the
 * dossier is real, the citations hold.
 *
 * These tests are about the door, not the CLI. `prepareStage`/`ingestStage` are
 * called directly here, because a check that lived in the command surface would
 * be a check the next caller of this module does not have.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  adverseFacts,
  caseParticipants,
  cases,
  egressLedger,
} from "../src/server/db/schema";
import { prepareStage, ingestStage } from "../src/server/llm/external";
import { judgmentSkeletonStage } from "../src/server/llm/stages";
import type { CaseStage } from "../src/server/db/schema";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/**
 * One case at whatever stage the test needs, with both parties registered.
 *
 * `adverse` seeds the confrontation the judgment stage requires, so a case that
 * has genuinely arrived can be told apart from one that has only had its stage
 * column set.
 */
function seedCase(
  stage: CaseStage,
  options: { readonly adverse?: boolean; readonly level?: boolean } = {},
): string {
  const [row] = db
    .insert(cases)
    .values({
      stage,
      title: "fixture",
      ...(options.level === false
        ? {}
        : { outputLevel: "L2" as const, outputLevelLockedAt: new Date() }),
    })
    .returning()
    .all();

  db.insert(caseParticipants)
    .values([
      { caseId: row.id, role: "initiator" as const, pseudonym: "乙", isSubmitter: true },
      { caseId: row.id, role: "respondent" as const, pseudonym: "甲", isSubmitter: false },
    ])
    .run();

  if (options.adverse === true) {
    db.insert(adverseFacts)
      .values({
        caseId: row.id,
        aiDraft: "You let the exchange run past what 甲 had asked for.",
        ackStatus: "acknowledged" as const,
        ackNote: "确实拖了",
      })
      .run();
  }

  return row.id;
}

/** A prompt with nothing in it that any other gate would object to. */
function input(caseId: string) {
  return { prompt: "Produce the fact layer for this case.", caseId };
}

describe("judgment stages on the external channel", () => {
  it("refuses to prepare a judgment stage for a case still at intake", () => {
    const caseId = seedCase("intake", { level: false });

    const outcome = prepareStage(judgmentSkeletonStage, input(caseId), { db });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    // Named: which stage the case is at, and which preconditions are unmet — in
    // the machine's own words, not a second vocabulary for the same facts.
    expect(outcome.message).toContain("judgment_skeleton produces a judgment");
    expect(outcome.message).toContain("intake");
    expect(outcome.message).toContain("adverse_facts_surfaced");
    expect(outcome.message).toContain("output_level_locked");
    expect(outcome.message).toContain(
      "No adverse fact has been put in front of you yet",
    );
  });

  it("emits nothing when it refuses — no ledger row, so no bundle was handed out", () => {
    const caseId = seedCase("intake", { level: false });

    prepareStage(judgmentSkeletonStage, input(caseId), { db });

    // The whole point of writing the egress row before the send is that a
    // prepared bundle is an exposure. A refusal is not one.
    expect(db.select().from(egressLedger).all()).toHaveLength(0);
  });

  it("refuses to ingest a judgment stage for a case that has not reached it", () => {
    const caseId = seedCase("pre_judgment", { adverse: true });

    const outcome = ingestStage(judgmentSkeletonStage, input(caseId), "{}", { db });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("pre_judgment");
    // Ingest is the call that writes, so it is checked on its own rather than
    // trusting that whoever prepared the bundle was allowed to.
    expect(outcome.message).toContain("judgment_skeleton produces a judgment");
  });

  it("refuses a case the safety screen put on the referral path, in the machine's words", () => {
    const caseId = seedCase("pre_judgment", { adverse: true });
    db.update(cases).set({ outputLevel: "refused" }).run();

    const outcome = prepareStage(judgmentSkeletonStage, input(caseId), { db });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("stays on the referral path");
  });

  it("lets a case that has actually arrived through", () => {
    const caseId = seedCase("judgment", { adverse: true });

    const outcome = prepareStage(judgmentSkeletonStage, input(caseId), { db });

    expect(outcome.kind).toBe("ok");
  });

  it("re-reads the requirements at the moment of use, not the stage column", () => {
    // A case can reach `judgment` and then have a new adverse fact surfaced
    // behind it. "The case is at the judgment stage" is a stale answer to "may a
    // judgment run right now" — the same reasoning `assertJudgmentAllowed` gives
    // for existing at all.
    const caseId = seedCase("judgment", { adverse: true });
    db.insert(adverseFacts)
      .values({
        caseId,
        aiDraft: "You did not answer the message you were asked about.",
        ackStatus: "pending" as const,
      })
      .run();

    const outcome = prepareStage(judgmentSkeletonStage, input(caseId), { db });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("adverse_facts_acknowledged");
  });

  it("leaves stages that are not judgment stages alone", () => {
    const caseId = seedCase("intake", { level: false });

    // Translation is not a judgment and has never been gated on the pipeline.
    const outcome = prepareStage(
      "translate_default",
      { prompt: "他说他会早点回来", caseId },
      { db },
    );

    expect(outcome.kind).toBe("ok");
  });
});
