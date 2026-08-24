/**
 * The case stage machine (M3).
 *
 * What is under test is the refusal, not the happy path: a pipeline whose gates
 * can be walked around is not a pipeline. So most of this file drives illegal
 * transitions — backwards, sideways, two at a time, and forwards while the data
 * a stage rests on is missing — and asserts that the server says no AND that the
 * case row did not move.
 *
 * Every precondition here is a fact in SQLite. None of them is a model answer,
 * and there is no way to pass one in: `canAdvance` takes a snapshot the server
 * collected itself.
 */

import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  CASE_STAGES,
  adverseFacts,
  caseParticipants,
  cases,
  clarificationRounds,
  evidence,
  events,
  issues,
  judgments,
  safetyScreens,
  steelmanVersions,
  utterances,
  type AckStatus,
  type CaseStage,
  type ConfirmStatus,
  type OutputLevel,
  type ParticipationState,
  type SafetyOutcome,
  type SteelmanVerdict,
} from "../src/server/db/schema";
import {
  MAX_CLARIFICATION_ROUNDS,
  PIPELINE_STAGES,
  STAGE_SEQUENCE,
  StageMachineError,
  advanceStage,
  blockersForNextStage,
  canAdvance,
  collectCaseFacts,
  describePipeline,
  nextStage,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

function seedCase(stage: CaseStage): string {
  const [row] = db.insert(cases).values({ stage }).returning().all();
  db.insert(caseParticipants)
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
        participationState: "pending",
      },
    ])
    .run();
  return row.id;
}

function addSafetyScreen(caseId: string, outcome: SafetyOutcome = "clear") {
  db.insert(safetyScreens)
    .values({ caseId, screenType: "keyword", outcome })
    .run();
}

function addEvidence(caseId: string) {
  db.insert(evidence)
    .values({ caseId, sourceType: "firsthand", gradeFinal: "A" })
    .run();
}

function addUtterance(caseId: string, confirmStatus: ConfirmStatus) {
  // Content stays in the language it was said in — this is evidence, not copy.
  db.insert(utterances)
    .values({ caseId, aiDraft: "你自己看着办吧", confirmStatus })
    .run();
}

function addMainlineEvent(caseId: string) {
  db.insert(events).values({ caseId, title: "E1", inTimeline: true }).run();
}

function addClarificationRound(
  caseId: string,
  roundNumber: number,
  options: { closed?: boolean; saturated?: boolean; canProceed?: boolean } = {},
) {
  const { closed = true, saturated = false, canProceed = false } = options;
  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber,
      questions: [{ id: "q1", question: "What happened next?" }],
      answers: [{ questionId: "q1", answer: "他没有回消息", answeredAt: 1 }],
      saturated,
      canProceed,
      closedAt: closed ? new Date() : null,
    })
    .run();
}

function addSteelman(caseId: string, verdict: SteelmanVerdict, version = 1) {
  db.insert(steelmanVersions).values({ caseId, version, verdict }).run();
}

/** The counterparty is the respondent; the initiator is the submitter. */
function setParticipation(caseId: string, state: ParticipationState) {
  db.update(caseParticipants)
    .set({ participationState: state })
    .where(
      and(
        eq(caseParticipants.caseId, caseId),
        eq(caseParticipants.role, "respondent"),
      ),
    )
    .run();
}

function addIssue(caseId: string, confirmStatus: ConfirmStatus) {
  db.insert(issues)
    .values({ caseId, category: "fact_dispute", confirmStatus })
    .run();
}

function addAdverseFact(caseId: string, ackStatus: AckStatus) {
  db.insert(adverseFacts).values({ caseId, ackStatus }).run();
}

function lockOutputLevel(caseId: string, level: OutputLevel) {
  db.update(cases)
    .set({ outputLevel: level, outputLevelLockedAt: new Date() })
    .where(eq(cases.id, caseId))
    .run();
}

function addFinalJudgment(caseId: string) {
  db.insert(judgments)
    .values({
      caseId,
      outputLevel: "L2",
      model: "claude-fable-5",
      status: "final",
      finalizedAt: new Date(),
    })
    .run();
}

function stageOf(caseId: string): CaseStage {
  return db.select().from(cases).where(eq(cases.id, caseId)).get()!.stage;
}

function facts(caseId: string) {
  return collectCaseFacts(db, caseId);
}

/** Walk a case up to `target`, satisfying each stage's preconditions on the way. */
function satisfyThrough(caseId: string, target: CaseStage): void {
  const stops: Partial<Record<CaseStage, () => void>> = {
    evidence_intake: () => addSafetyScreen(caseId),
    transcription: () => addEvidence(caseId),
    timeline: () => addUtterance(caseId, "confirmed"),
    clarification: () => addMainlineEvent(caseId),
    participation: () => {
      addClarificationRound(caseId, 1, { saturated: true });
      addSteelman(caseId, "accepted");
    },
    issue_framing: () => setParticipation(caseId, "refused"),
    pre_judgment: () => addIssue(caseId, "confirmed"),
    judgment: () => {
      addAdverseFact(caseId, "acknowledged");
      lockOutputLevel(caseId, "L2");
    },
    post_judgment: () => addFinalJudgment(caseId),
  };

  const stopAt = STAGE_SEQUENCE.indexOf(target);
  for (let at = 1; at <= stopAt; at += 1) {
    const stage = STAGE_SEQUENCE[at];
    stops[stage]?.();
    advanceStage(db, caseId, stage);
  }
}

/* -------------------------------------------------------------------------- */

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* The sequence itself                                                        */
/* -------------------------------------------------------------------------- */

describe("the nine stages", () => {
  it("are the first nine of the schema's stage vocabulary, in order", () => {
    expect(PIPELINE_STAGES).toHaveLength(9);
    expect([...PIPELINE_STAGES]).toEqual([...CASE_STAGES].slice(0, 9));
    expect([...STAGE_SEQUENCE]).toEqual([...CASE_STAGES]);
  });

  it("chains: every stage's successor is the next one, and judgment is not the end", () => {
    expect(nextStage("intake")).toBe("evidence_intake");
    expect(nextStage("judgment")).toBe("post_judgment");
    expect(nextStage("closed")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Illegal transitions                                                        */
/* -------------------------------------------------------------------------- */

describe("illegal transitions", () => {
  it("refuses to move backwards", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "transcription");

    const decision = canAdvance(facts(caseId), "evidence_intake");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("not_forward");

    expect(() => advanceStage(db, caseId, "evidence_intake")).toThrow(
      StageMachineError,
    );
    expect(stageOf(caseId)).toBe("transcription");
  });

  it("refuses to re-enter the stage the case is already in", () => {
    const caseId = seedCase("intake");

    const decision = canAdvance(facts(caseId), "intake");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("not_forward");
    expect(decision.reason).toContain("already at");
  });

  it("refuses to skip a stage even when the far stage's own preconditions hold", () => {
    const caseId = seedCase("intake");
    addSafetyScreen(caseId);
    addEvidence(caseId);
    addUtterance(caseId, "confirmed");

    // `transcription` needs registered evidence, and there is some — but the
    // case is at `intake`, and evidence_intake sits in between.
    const decision = canAdvance(facts(caseId), "transcription");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("stage_skipped");
    expect(decision.reason).toContain("evidence_intake");

    expect(() => advanceStage(db, caseId, "transcription")).toThrow(
      /skip/,
    );
    expect(stageOf(caseId)).toBe("intake");
  });

  it("refuses a stage name that is not in the vocabulary", () => {
    const caseId = seedCase("intake");
    const decision = canAdvance(facts(caseId), "judgement_day" as CaseStage);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("unknown_stage");
  });

  it("freezes the whole pipeline once a safety screen has refused the case", () => {
    const caseId = seedCase("intake");
    addSafetyScreen(caseId, "refuse");

    const decision = canAdvance(facts(caseId), "evidence_intake");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("safety_refused");

    expect(() => advanceStage(db, caseId, "evidence_intake")).toThrow(
      /referral path/,
    );
    expect(stageOf(caseId)).toBe("intake");
  });

  it("freezes it just as hard when the locked output level is `refused`", () => {
    const caseId = seedCase("intake");
    addSafetyScreen(caseId);
    lockOutputLevel(caseId, "refused");

    const decision = canAdvance(facts(caseId), "evidence_intake");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("safety_refused");
  });
});

/* -------------------------------------------------------------------------- */
/* Preconditions are data facts                                               */
/* -------------------------------------------------------------------------- */

describe("preconditions", () => {
  it("will not enter evidence_intake before a safety screen is on file", () => {
    const caseId = seedCase("intake");

    const decision = canAdvance(facts(caseId), "evidence_intake");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("preconditions_unmet");
    expect(decision.unmet.map((r) => r.id)).toEqual(["safety_screen_recorded"]);

    addSafetyScreen(caseId);
    expect(canAdvance(facts(caseId), "evidence_intake").allowed).toBe(true);
  });

  it("will not reach issues before a transcription confirmation exists", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "participation");

    // Unconfirmed lines are invisible to anything citable (HARD RULE #1), so an
    // issue list could not rest on them.
    db.delete(utterances).run();
    addUtterance(caseId, "pending");
    setParticipation(caseId, "refused");

    const decision = canAdvance(facts(caseId), "issue_framing");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("preconditions_unmet");
    expect(decision.unmet.map((r) => r.id)).toContain("transcription_confirmed");

    expect(() => advanceStage(db, caseId, "issue_framing")).toThrow(
      StageMachineError,
    );
    expect(stageOf(caseId)).toBe("participation");

    addUtterance(caseId, "edited");
    expect(canAdvance(facts(caseId), "issue_framing").allowed).toBe(true);
  });

  it("will not reach issues while the other party's participation is pending", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "participation");
    setParticipation(caseId, "pending");

    const decision = canAdvance(facts(caseId), "issue_framing");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.unmet.map((r) => r.id)).toContain("participation_settled");

    // Any settled state does — "refused" and "unreachable" are answers too.
    setParticipation(caseId, "unreachable");
    expect(canAdvance(facts(caseId), "issue_framing").allowed).toBe(true);
  });

  it("will not leave clarification until the loop is closed and the steelman answered", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "clarification");

    const bare = canAdvance(facts(caseId), "participation");
    expect(bare.allowed).toBe(false);
    if (bare.allowed) return;
    expect(bare.unmet.map((r) => r.id)).toEqual([
      "clarification_settled",
      "steelman_answered",
    ]);

    // An open round is not a finished loop.
    addClarificationRound(caseId, 1, { closed: false });
    expect(canAdvance(facts(caseId), "participation").allowed).toBe(false);

    // Spending the whole budget closes it even without saturation.
    db.delete(clarificationRounds).run();
    for (let round = 1; round <= MAX_CLARIFICATION_ROUNDS; round += 1) {
      addClarificationRound(caseId, round);
    }
    const steelmanStill = canAdvance(facts(caseId), "participation");
    expect(steelmanStill.allowed).toBe(false);
    if (steelmanStill.allowed) return;
    expect(steelmanStill.unmet.map((r) => r.id)).toEqual(["steelman_answered"]);

    // A steelman nobody has answered yet is not an answer.
    addSteelman(caseId, "pending");
    expect(canAdvance(facts(caseId), "participation").allowed).toBe(false);

    // "It cannot be written" IS an answer — it becomes a downgrade signal.
    db.delete(steelmanVersions).run();
    addSteelman(caseId, "unable");
    expect(canAdvance(facts(caseId), "participation").allowed).toBe(true);
  });

  it("refuses judgment while any adverse fact is still pending", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "pre_judgment");
    lockOutputLevel(caseId, "L2");
    addAdverseFact(caseId, "acknowledged");
    addAdverseFact(caseId, "pending");

    const decision = canAdvance(facts(caseId), "judgment");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("preconditions_unmet");
    expect(decision.unmet.map((r) => r.id)).toEqual([
      "adverse_facts_acknowledged",
    ]);

    expect(() => advanceStage(db, caseId, "judgment")).toThrow(StageMachineError);
    expect(stageOf(caseId)).toBe("pre_judgment");

    // Contesting one is dealing with it; only `pending` blocks.
    db.update(adverseFacts)
      .set({ ackStatus: "disputed", ackedAt: new Date() })
      .where(eq(adverseFacts.ackStatus, "pending"))
      .run();
    expect(canAdvance(facts(caseId), "judgment").allowed).toBe(true);
  });

  it("refuses judgment on a case that was never confronted with an adverse fact", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "pre_judgment");
    lockOutputLevel(caseId, "L2");

    // Zero rows means zero pending: without this gate the anti-"help me win"
    // check would pass vacuously on a case whose adverse-fact pass never ran.
    const decision = canAdvance(facts(caseId), "judgment");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.unmet.map((r) => r.id)).toContain("adverse_facts_surfaced");
  });

  it("refuses judgment until the output level is locked onto the case", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "pre_judgment");
    addAdverseFact(caseId, "acknowledged");

    const decision = canAdvance(facts(caseId), "judgment");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.unmet.map((r) => r.id)).toEqual(["output_level_locked"]);

    lockOutputLevel(caseId, "L2");
    expect(canAdvance(facts(caseId), "judgment").allowed).toBe(true);
  });

  it("refuses pre_judgment while an issue is still waiting for review", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "issue_framing");
    addIssue(caseId, "pending");

    const decision = canAdvance(facts(caseId), "pre_judgment");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.unmet.map((r) => r.id)).toEqual(["issues_settled"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The write                                                                  */
/* -------------------------------------------------------------------------- */

describe("advanceStage", () => {
  it("moves the case and stamps when it entered the stage", () => {
    const caseId = seedCase("intake");
    addSafetyScreen(caseId);

    const before = Date.now();
    const outcome = advanceStage(db, caseId, "evidence_intake");

    expect(outcome).toMatchObject({ from: "intake", to: "evidence_intake" });
    const row = db.select().from(cases).where(eq(cases.id, caseId)).get()!;
    expect(row.stage).toBe("evidence_intake");
    expect(row.stageEnteredAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before);
  });

  it("re-checks against the database, so a stale caller cannot force a move", () => {
    const caseId = seedCase("intake");
    addSafetyScreen(caseId);

    // A snapshot taken when the move was legal.
    const snapshot = facts(caseId);
    expect(canAdvance(snapshot, "evidence_intake").allowed).toBe(true);

    // The world moves on: the case is already past that stage.
    advanceStage(db, caseId, "evidence_intake");

    // Replaying the authorized move is refused on the current facts.
    expect(() => advanceStage(db, caseId, "evidence_intake")).toThrow(
      StageMachineError,
    );
    expect(stageOf(caseId)).toBe("evidence_intake");
  });

  it("reports a missing case rather than inventing one", () => {
    expect(() => advanceStage(db, "no-such-case", "evidence_intake")).toThrow(
      StageMachineError,
    );
    try {
      collectCaseFacts(db, "no-such-case");
    } catch (cause) {
      expect((cause as StageMachineError).code).toBe("case_not_found");
    }
  });

  it("walks the whole pipeline when every fact is in place", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "judgment");
    expect(stageOf(caseId)).toBe("judgment");
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

describe("describePipeline", () => {
  it("marks done / current / upcoming and flags the one reachable next stage", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "transcription");

    const rows = describePipeline(facts(caseId));
    const byStage = new Map(rows.map((row) => [row.stage, row]));

    expect(byStage.get("intake")?.state).toBe("done");
    expect(byStage.get("transcription")?.state).toBe("current");
    expect(byStage.get("timeline")?.state).toBe("upcoming");
    expect(rows.filter((row) => row.isNext).map((row) => row.stage)).toEqual([
      "timeline",
    ]);
  });

  it("lists exactly the blockers standing between the case and its next stage", () => {
    const caseId = seedCase("intake");
    satisfyThrough(caseId, "evidence_intake");

    // transcription needs registered evidence, and none has been added.
    expect(blockersForNextStage(facts(caseId)).map((r) => r.id)).toEqual([
      "evidence_registered",
    ]);

    addEvidence(caseId);
    expect(blockersForNextStage(facts(caseId))).toEqual([]);
  });
});
