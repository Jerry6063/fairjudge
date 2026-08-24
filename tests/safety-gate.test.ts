/**
 * The safety screening gate (SPEC M3 wave A ②) — both layers and the wiring.
 *
 * The file is organised around the four claims the gate makes:
 *
 *   1. **The local layer runs first, and when it refers, no model is called.**
 *      Proved rather than asserted: the Anthropic SDK is mocked so that
 *      constructing a client or touching `messages.create` THROWS. A red-flag
 *      case still refuses. If a model call ever creeps onto the crisis path,
 *      this file goes red — which is what HARD RULE #9 needs from a test.
 *   2. **Either layer refers.** A case the patterns cleared and the model
 *      flagged refers; a case the model cleared and the patterns flagged
 *      refers. Neither layer can clear the other.
 *   3. **The model's own `outcome` field does not decide anything.** A response
 *      that lists red flags and then answers `pass` still refers, because the
 *      rule is in code (`modelLayerFlags`) and not in the JSON the model filled
 *      in.
 *   4. **A referral closes the pipeline.** `cases.output_level` is locked to
 *      `refused` through `deriveOutputLevel` (HARD RULE #2), and the stage
 *      machine then refuses every transition.
 *
 * Evidence strings are Chinese and stay Chinese (CLAUDE.md): they are what the
 * rules and the prompt actually meet.
 */

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, betaCreateMock, constructed } = vi.hoisted(() => ({
  createMock: vi.fn(),
  betaCreateMock: vi.fn(),
  constructed: { count: 0 },
}));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createMock };
    beta = { messages: { create: betaCreateMock } };
    constructor() {
      constructed.count += 1;
    }
  }
  return { default: MockAnthropic };
});

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  llmCalls,
  safetyScreens,
  utterances,
  type ConfirmStatus,
  type SafetyAnswer,
} from "../src/server/db/schema";
import { MODEL_OPUS } from "../src/server/llm/config";
import { safetyScreenStage } from "../src/server/llm/stages/safety-screen";
import { canAdvance, collectCaseFacts } from "../src/server/pipeline";
import {
  SafetyReferralError,
  assertSafetyClearedForJudgment,
  modelLayerFlags,
  runIntakeSafetyGate,
  runPreJudgmentSafetyGate,
  screenBeforeJudgment,
} from "../src/server/safety/gate";
import {
  buildReferralView,
  caseIsReferred,
  listSafetyScreens,
} from "../src/server/safety/screen-record";
import { buildSafetyAnswers } from "../src/server/safety/questionnaire";
import type { SafetyScreenOutput } from "../src/server/llm/stages/safety-screen";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Db;
let sqlite: Database.Database;

function seedCase(): string {
  const [row] = db.insert(cases).values({ stage: "intake" }).returning().all();
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

function addUtterance(
  caseId: string,
  text: string,
  confirmStatus: ConfirmStatus = "confirmed",
): string {
  const [row] = db
    .insert(utterances)
    .values({ caseId, aiDraft: text, confirmStatus })
    .returning()
    .all();
  return row.id;
}

/** A response body in the shape the gateway parses. Opus → `messages.create`. */
function modelSays(output: SafetyScreenOutput) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_OPUS,
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify(output) }],
    usage: {
      input_tokens: 800,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    _request_id: "req_test",
  };
}

const CLEAN: SafetyScreenOutput = {
  red_flags: [],
  risk_level: "none",
  evidence_quotes: [],
  outcome: "pass",
};

/** The SDK, armed to explode. Any model call at all fails the test. */
function forbidModelCalls(): void {
  const boom = () => {
    throw new Error("the model was called on a path that must not call it");
  };
  createMock.mockImplementation(boom);
  betaCreateMock.mockImplementation(boom);
}

const NO_ANSWERS: readonly SafetyAnswer[] = [];

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
  createMock.mockReset();
  betaCreateMock.mockReset();
  constructed.count = 0;
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* 1. The crisis path never touches a model                                   */
/* -------------------------------------------------------------------------- */

describe("a constructed red-flag case is refused with no model in the loop", () => {
  it("refuses on the local layer alone, with the SDK armed to throw", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他上次喝多了动手打我，我现在不敢回家");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(result.decision).toBe("refer");
    expect(result.outcome).toBe("refuse");
    expect(result.riskLevel).toBe("high");
    expect(result.categories).toEqual(
      expect.arrayContaining(["fear", "physical_violence"]),
    );

    // The proof. Not "the call was cheap" — there was no call, and no client
    // was even constructed.
    expect(result.model).toEqual({ kind: "skipped_local_referral" });
    expect(createMock).not.toHaveBeenCalled();
    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(constructed.count).toBe(0);
    expect(db.select().from(llmCalls).all()).toEqual([]);
  });

  it("refuses on a questionnaire answer alone, before any material exists", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    const answers = buildSafetyAnswers({
      fear_of_partner: "yes",
      physical_harm: "no",
      anything_else: "",
    });

    const result = await runIntakeSafetyGate(db, caseId, answers);

    expect(result.decision).toBe("refer");
    expect(result.categories).toEqual(["fear"]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses on an ambiguous phrase, and records that it was ambiguous", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "跟他在一起总是提心吊胆的");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    // Escalation, not a pass — and the model is still never asked, because the
    // referral is already decided.
    expect(result.decision).toBe("refer");
    expect(result.riskLevel).toBe("elevated");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("writes one screen row naming the layer, the flags and the reason", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他每天翻我的手机，还装了定位");

    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    const rows = db.select().from(safetyScreens).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].screenType).toBe("keyword");
    expect(rows[0].outcome).toBe("refuse");
    expect(rows[0].redFlags).toEqual(["monitoring"]);
    expect(rows[0].referralShown).toBe(true);
    expect(rows[0].rationale).toContain("Local rules");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Unconfirmed material is invisible (HARD RULE #1)                        */
/* -------------------------------------------------------------------------- */

describe("the gate only ever reads confirmed material", () => {
  it("does not refuse on a red flag sitting in an unconfirmed line", async () => {
    createMock.mockResolvedValue(modelSays(CLEAN));

    const caseId = seedCase();
    addUtterance(caseId, "他动手打我", "pending");
    addUtterance(caseId, "行行行，你说得都对", "confirmed");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    // The pending line is not rejected by the gate — it was never in the bytes
    // the gate was handed. `buildCitableBrief` is the query-layer half of
    // HARD RULE #1 and it is the same query both layers read.
    expect(result.decision).toBe("pass");
    expect(result.local.signals).toEqual([]);

    const prompt = String(createMock.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain("行行行");
    expect(prompt).not.toContain("动手打我");
  });

  it("refuses the moment that same line is confirmed", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    const id = addUtterance(caseId, "他动手打我", "pending");
    db.update(utterances)
      .set({ confirmStatus: "confirmed" })
      .where(eq(utterances.id, id))
      .run();

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);
    expect(result.decision).toBe("refer");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The model layer                                                         */
/* -------------------------------------------------------------------------- */

describe("the model layer, for what the patterns cannot see", () => {
  it("runs on the support model at high effort, over the confirmed brief", async () => {
    createMock.mockResolvedValue(modelSays(CLEAN));

    const caseId = seedCase();
    addUtterance(caseId, "他说他只是想知道我在哪");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(result.decision).toBe("pass");
    expect(result.outcome).toBe("clear");
    expect(betaCreateMock).not.toHaveBeenCalled();

    const body = createMock.mock.calls[0][0];
    expect(body.model).toBe(MODEL_OPUS);
    expect(body.output_config.effort).toBe("high");
    expect(safetyScreenStage.model).toBe(MODEL_OPUS);

    // One audit row per attempt, attributed to the stage (HARD RULE #7).
    const calls = db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].stage).toBe("safety_screen");
    expect(calls[0].caseId).toBe(caseId);
  });

  it("refers on a model flag the patterns missed", async () => {
    createMock.mockResolvedValue(
      modelSays({
        red_flags: ["coercive_control"],
        risk_level: "high",
        evidence_quotes: ["我得先问问他行不行"],
        outcome: "refer",
      }),
    );

    const caseId = seedCase();
    // Nothing here trips a pattern: no verb, no named act, no keyword.
    addUtterance(caseId, "我得先问问他行不行，不然回头又是一场");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(result.local.decision).toBe("pass");
    expect(result.decision).toBe("refer");
    expect(result.categories).toEqual(["coercive_control"]);
    expect(result.riskLevel).toBe("high");

    // The quotes come back in memory and are NOT copied into the audit row —
    // the text already lives in `utterances`.
    expect(result.evidenceQuotes).toEqual(["我得先问问他行不行"]);
    const rows = listSafetyScreens(db, caseId);
    expect(JSON.stringify(rows)).not.toContain("我得先问问他行不行");
  });

  it("refers when the model flags something and then answers pass anyway", async () => {
    // The rule is in code, not in the field the model filled in last.
    createMock.mockResolvedValue(
      modelSays({
        red_flags: ["physical_violence"],
        risk_level: "elevated",
        evidence_quotes: [],
        outcome: "pass",
      }),
    );

    const caseId = seedCase();
    addUtterance(caseId, "那天晚上的事我不太想讲");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);
    expect(result.decision).toBe("refer");
    expect(caseIsReferred(db, caseId)).toBe(true);
  });

  it("refers on a non-none risk level even with no category named", () => {
    expect(
      modelLayerFlags({
        red_flags: [],
        risk_level: "elevated",
        evidence_quotes: [],
        outcome: "pass",
      }),
    ).toBe(true);
    expect(modelLayerFlags(CLEAN)).toBe(false);
  });

  it("reads a model refusal as a referral, not as a pass", async () => {
    createMock.mockResolvedValue({
      ...modelSays(CLEAN),
      stop_reason: "refusal",
      stop_details: { category: "harmful_content" },
      content: [],
    });

    const caseId = seedCase();
    addUtterance(caseId, "那天的事我只跟你说过");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(result.model.kind).toBe("refused");
    expect(result.decision).toBe("refer");
    expect(result.rationale).toContain("it did not come back");
  });

  it("records an unreachable model as incomplete rather than clear", async () => {
    createMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    // Nothing was found, so it does not refer. But half a screen is not a
    // clean screen, and `flagged` is what says so on the row.
    expect(result.decision).toBe("pass");
    expect(result.outcome).toBe("flagged");
    expect(result.model.kind).toBe("unavailable");

    const rows = listSafetyScreens(db, caseId);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["clear", "flagged"]);
  });

  it("skips the model when nothing is confirmed yet, and says so", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(result.model).toEqual({ kind: "skipped_no_material" });
    expect(result.outcome).toBe("flagged");
    expect(result.decision).toBe("pass");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("honours localOnly without pretending the screen was complete", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对");

    const result = await runIntakeSafetyGate(db, caseId, NO_ANSWERS, {
      localOnly: true,
    });

    expect(result.model).toEqual({ kind: "skipped_by_caller" });
    expect(result.outcome).toBe("flagged");
    expect(createMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A referral closes the pipeline                                          */
/* -------------------------------------------------------------------------- */

describe("a referral closes the pipeline", () => {
  it("locks the output level to refused through deriveOutputLevel", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他掐我脖子");

    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
    expect(row?.outputLevel).toBe("refused");
    expect(row?.outputLevelLockedAt).toBeInstanceOf(Date);
  });

  it("makes every stage transition illegal, including the harmless-looking one", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他掐我脖子");
    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    const facts = collectCaseFacts(db, caseId);
    expect(facts.safety.refused).toBe(true);

    const decision = canAdvance(facts, "evidence_intake");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("safety_refused");
  });

  it("turns judgment away without spending a model call on it", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他掐我脖子");
    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    expect(() => assertSafetyClearedForJudgment(db, caseId)).toThrow(
      SafetyReferralError,
    );
    await expect(screenBeforeJudgment(db, caseId)).rejects.toThrow(
      SafetyReferralError,
    );
    // The cheap synchronous assertion comes first, so the re-screen never runs.
    expect(createMock).not.toHaveBeenCalled();
  });

  it("gives the referral page something to render", async () => {
    forbidModelCalls();

    const caseId = seedCase();
    addUtterance(caseId, "他不让我出门，也不许我跟朋友联系");
    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    const view = buildReferralView(db, caseId);
    expect(view.referred).toBe(true);
    expect(view.categories.map((c) => c.category)).toEqual(["coercive_control"]);
    expect(view.categories[0].label).toBeTruthy();
    expect(view.screenType).toBe("keyword");
    expect(view.rationale).toContain("Local rules");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The re-run before judgment                                              */
/* -------------------------------------------------------------------------- */

describe("the gate re-runs before judgment", () => {
  it("screens material confirmed after intake, and refuses on it", async () => {
    createMock.mockResolvedValue(modelSays(CLEAN));

    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对");

    const intake = await runIntakeSafetyGate(db, caseId, NO_ANSWERS);
    expect(intake.decision).toBe("pass");

    // The case grows a transcript. This is the document the intake screen never
    // saw, which is the whole reason the gate runs twice.
    addUtterance(caseId, "上个月他把我摁在墙上，我不敢跟别人讲");
    createMock.mockClear();
    forbidModelCalls();

    await expect(screenBeforeJudgment(db, caseId)).rejects.toThrow(
      SafetyReferralError,
    );

    const rows = listSafetyScreens(db, caseId);
    expect(rows.some((r) => r.screenType === "pre_judgment")).toBe(true);
    expect(caseIsReferred(db, caseId)).toBe(true);
  });

  it("carries the intake answers into the re-run rather than re-asking", async () => {
    createMock.mockResolvedValue(modelSays(CLEAN));

    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对");
    const answers = buildSafetyAnswers({
      fear_of_partner: "no",
      physical_harm: "no",
      anything_else: "没什么别的",
    });
    await runIntakeSafetyGate(db, caseId, answers);

    const rerun = await runPreJudgmentSafetyGate(db, caseId);
    const localRow = rerun.screens.find((r) => r.answers.length > 0);

    expect(localRow).toBeDefined();
    // Verbatim, in the language it was written in.
    expect(localRow?.answers).toEqual(answers);
    expect(rerun.phase).toBe("pre_judgment");
  });

  it("returns the re-run result on the passing path, so an incomplete screen can be disclosed", async () => {
    createMock.mockResolvedValue(modelSays(CLEAN));

    const caseId = seedCase();
    addUtterance(caseId, "行行行，你说得都对");
    await runIntakeSafetyGate(db, caseId, NO_ANSWERS);

    createMock.mockRejectedValue(new Error("timeout"));
    const result = await screenBeforeJudgment(db, caseId);

    expect(result.decision).toBe("pass");
    expect(result.outcome).toBe("flagged");
    expect(result.model.kind).toBe("unavailable");
  });
});
