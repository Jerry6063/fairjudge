/**
 * The safety screening gate (SPEC M3 wave A ②).
 *
 * Two layers, in a fixed order, and the order is the design:
 *
 *   1. `domain/safety-rules.ts` — deterministic, local, instant, offline.
 *   2. `llm/stages/safety-screen.ts` — one opus-4-8 pass for what patterns miss.
 *
 * **Either layer firing refers the case.** Neither can clear what the other
 * flagged; there is no averaging, no tie-break, and no threshold between them.
 * A gate tuned for recall that then reconciles its two layers has quietly become
 * a gate tuned for precision.
 *
 * **The local layer runs first, and when it refers, the model is never called.**
 * That is HARD RULE #9 implemented rather than promised: the sentence "crisis
 * resources render with zero latency and no LLM in the loop" is true here
 * because on the path where a red flag has fired there is no model call to be
 * slow, to fail, or to be waited on. `tests/safety-gate.test.ts` proves it the
 * only way worth proving it — the whole Anthropic SDK is mocked to throw, and
 * the red-flag case still refuses.
 *
 * What the gate writes, per run:
 *   - one `safety_screens` row per layer that actually ran;
 *   - on a referral, `cases.output_level = 'refused'`, derived through
 *     `deriveOutputLevel` (HARD RULE #2), which is what closes the stage machine
 *     — `canAdvance` refuses every transition on a refused case.
 *
 * What it deliberately does NOT write: the quotes. `evidence_quotes` comes back
 * from the model and is returned to the caller in memory, but never persisted
 * into the screen row. The text already lives in `utterances`; a second copy of
 * the most sensitive sentences in the product, in a table whose whole purpose is
 * to be read later by someone auditing a refusal, is a cost with no matching
 * benefit.
 *
 * Entry points: `runIntakeSafetyGate` at stage ①, `runPreJudgmentSafetyGate`
 * before judgment, and the synchronous `assertSafetyClearedForJudgment` that any
 * judgment path calls first.
 */

import type { Db } from "../db";
import type { SafetyAnswer, SafetyOutcome, SafetyScreenType } from "../db/schema";
import {
  SAFETY_FLAG_CATEGORIES,
  screenForSafety,
  type LocalSafetyScreen,
  type SafetyFlagCategory,
  type SafetyRiskLevel,
  type SafetySource,
} from "../domain/safety-rules";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions } from "../llm";
import { safetyScreenStage, type SafetyScreenOutput } from "../llm/stages/safety-screen";
import {
  buildCitableBrief,
  renderBrief,
  type CitableBrief,
} from "../pipeline/evidence-refs";
import { answerSources, answersToSignals } from "./questionnaire";
import {
  caseIsReferred,
  listSafetyScreens,
  lockCaseAsRefused,
  recordSafetyScreen,
  type SafetyScreenRow,
} from "./screen-record";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * When the gate is running.
 *
 * `intake` is stage ①, before any material has been graded. `pre_judgment` is
 * the re-run: by then the transcript has been confirmed, the clarification
 * rounds have been answered and a steelman has been argued with, so the gate is
 * reading a case that barely resembles the one it screened at intake. Screening
 * once at the door would be screening the wrong document.
 */
export type SafetyPhase = "intake" | "pre_judgment";

/**
 * `safety_screens.screen_type` for one layer in one phase.
 *
 * The column's vocabulary (`keyword` / `llm` / `pre_judgment`) mixes two axes —
 * two layers and one phase — so it cannot express all four combinations. The
 * mapping chosen: at intake the value names the LAYER, on the re-run it names
 * the PHASE. Nothing is lost, because every row's `rationale` opens by naming
 * its own layer.
 */
function screenTypeFor(
  phase: SafetyPhase,
  layer: "local" | "model",
): SafetyScreenType {
  if (phase === "pre_judgment") return "pre_judgment";
  return layer === "local" ? "keyword" : "llm";
}

/** What became of the model layer on this run. */
export type ModelLayerState =
  /** The local layer already referred; no call was made (HARD RULE #9). */
  | { readonly kind: "skipped_local_referral" }
  /** Nothing is confirmed yet, so there was nothing for it to read. */
  | { readonly kind: "skipped_no_material" }
  /** The caller asked for the local layer only. */
  | { readonly kind: "skipped_by_caller" }
  | { readonly kind: "ran"; readonly data: SafetyScreenOutput }
  /** The model declined to answer. Treated as a referral — see below. */
  | { readonly kind: "refused"; readonly category?: string }
  /** Transport failure. The screen is incomplete, not clear. */
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * What `runModelLayer` can return.
 *
 * `skipped_local_referral` is excluded because that state is decided by the
 * caller before the model layer is reached at all — the gate returns on it and
 * never enters `runModelLayer`. Saying so in the type is not tidiness: it is
 * what lets the gate's chain of early returns narrow down to `ran` without a
 * default branch that would silently swallow a state added later.
 */
type ModelLayerRun = Exclude<
  ModelLayerState,
  { readonly kind: "skipped_local_referral" }
>;

export interface SafetyGateResult {
  readonly caseId: string;
  readonly phase: SafetyPhase;
  /** The only field a caller has to branch on. */
  readonly decision: "pass" | "refer";
  /** What went into `safety_screens.outcome` for this run, combined. */
  readonly outcome: SafetyOutcome;
  /** The higher of the two layers' levels. */
  readonly riskLevel: SafetyRiskLevel;
  /** Union of both layers' categories, in `SAFETY_FLAG_CATEGORIES` order. */
  readonly categories: readonly SafetyFlagCategory[];
  readonly local: LocalSafetyScreen;
  readonly model: ModelLayerState;
  /**
   * Verbatim fragments the model layer cited, in their original language.
   * In memory only — see the module note on why these are not persisted.
   */
  readonly evidenceQuotes: readonly string[];
  /** The rows this run wrote, in write order. */
  readonly screens: readonly SafetyScreenRow[];
  /** English prose covering both layers, for the referral page. */
  readonly rationale: string;
}

export interface SafetyGateInput {
  readonly caseId: string;
  readonly phase: SafetyPhase;
  /** Intake questionnaire answers. Absent on the pre-judgment re-run. */
  readonly answers?: readonly SafetyAnswer[];
  /**
   * Run the deterministic layer only. For an offline run or a re-screen after
   * the answers changed — never as an optimisation, since the model layer is
   * the half that catches what a phrase list cannot.
   */
  readonly localOnly?: boolean;
  /** Infrastructure overrides forwarded to `runStage` (tests inject both). */
  readonly llm?: RunStageOptions;
}

/* -------------------------------------------------------------------------- */
/* Risk arithmetic                                                            */
/* -------------------------------------------------------------------------- */

const RISK_ORDER: Readonly<Record<SafetyRiskLevel, number>> = {
  none: 0,
  elevated: 1,
  high: 2,
};

/** The higher of two levels. Two layers never cancel out. */
function higherRisk(a: SafetyRiskLevel, b: SafetyRiskLevel): SafetyRiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Union in the canonical order, so two runs of one case list flags alike. */
function unionCategories(
  a: readonly SafetyFlagCategory[],
  b: readonly SafetyFlagCategory[],
): SafetyFlagCategory[] {
  const present = new Set([...a, ...b]);
  return SAFETY_FLAG_CATEGORIES.filter((category) => present.has(category));
}

/**
 * Does the model's answer flag anything?
 *
 * Three independent reasons, ORed — and `outcome` is only one of them. A model
 * that lists `red_flags: ["physical_violence"]` and then answers
 * `outcome: "pass"` has still told us what it saw, and the referral is decided
 * here rather than by the field it filled in last. Hard rules live in code.
 */
export function modelLayerFlags(data: SafetyScreenOutput): boolean {
  return (
    data.red_flags.length > 0 ||
    data.risk_level !== "none" ||
    data.outcome === "refer"
  );
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/** The task turn appended after the evidence block. */
const SAFETY_SCREEN_TASK =
  "Screen this case's confirmed material for the six safety categories. A " +
  "deterministic phrase list has already run over the same text and found " +
  "nothing decisive, so read for what a phrase list cannot see: the shape of " +
  "the account, the escalation across it, and what is being described without " +
  "being named.";

/**
 * Run both layers over one case and record what they found.
 *
 * Never throws on a model problem: a refusal and a transport failure are
 * outcomes, and the deterministic half of the screen has already run either way.
 */
export async function runSafetyGate(
  db: Db,
  input: SafetyGateInput,
): Promise<SafetyGateResult> {
  const { caseId, phase } = input;
  const answers = input.answers ?? [];
  const screens: SafetyScreenRow[] = [];

  /* ---- layer one: deterministic, local, always ------------------------- */

  const brief = buildCitableBrief(db, caseId);
  const sources: SafetySource[] = [
    ...brief.utterances.map((utterance) => ({
      id: utterance.id,
      kind: "utterance" as const,
      text: utterance.text,
    })),
    ...answerSources(answers),
  ];

  const local = screenForSafety(sources, answersToSignals(answers));
  const localRationale = `Local rules (deterministic, no model). ${local.rationale}`;

  screens.push(
    recordSafetyScreen(db, {
      caseId,
      screenType: screenTypeFor(phase, "local"),
      outcome: local.decision === "refer" ? "refuse" : "clear",
      answers,
      redFlags: local.categories,
      rationale: localRationale,
    }),
  );

  // HARD RULE #9. The referral is already decided, so there is nothing a model
  // could add except latency on the one path where latency is a human cost.
  if (local.decision === "refer") {
    lockCaseAsRefused(db, caseId);
    return {
      caseId,
      phase,
      decision: "refer",
      outcome: "refuse",
      riskLevel: local.riskLevel,
      categories: local.categories,
      local,
      model: { kind: "skipped_local_referral" },
      evidenceQuotes: [],
      screens,
      rationale:
        `${localRationale} The model layer was not called: the referral was ` +
        `already decided, and the crisis path does not wait on a model.`,
    };
  }

  /* ---- layer two: the model, for what patterns cannot see --------------- */

  const model = await runModelLayer(db, input, brief);

  // Three ways the model layer produces no opinion. They differ only in the
  // sentence written on the row: all three are recorded as `flagged` rather
  // than `clear`, because "clear" would claim a whole screen came back empty
  // when half of it never ran. `flagged` is the schema's word for
  // recorded-but-not-refused, and it is what tells the judgment to disclose an
  // incomplete screen instead of resting on it.
  if (model.kind !== "ran" && model.kind !== "refused") {
    const why = whyTheModelDidNotRun(model);
    screens.push(
      recordSafetyScreen(db, {
        caseId,
        screenType: screenTypeFor(phase, "model"),
        outcome: "flagged",
        answers: null,
        redFlags: [],
        rationale: `Model layer did not run. ${why}`,
      }),
    );
    return pass(caseId, phase, local, model, screens, `${localRationale} ${why}`);
  }

  if (model.kind === "refused") {
    // The gateway reports a refusal when the model declined to answer at all.
    // On this stage that is itself information: what it was handed was material
    // it would not classify. Failing closed costs a page of resources; failing
    // open costs the thing the screen exists for.
    const why =
      `The model declined to answer the safety screen` +
      `${model.category === undefined ? "" : ` (${model.category})`}. A refusal ` +
      `on this stage is read as a referral rather than as a pass: the screen ` +
      `did not come back empty, it did not come back.`;
    const rationale = `${localRationale} ${why}`;
    screens.push(
      recordSafetyScreen(db, {
        caseId,
        screenType: screenTypeFor(phase, "model"),
        outcome: "refuse",
        answers: null,
        redFlags: [],
        rationale: `Model layer refused. ${why}`,
      }),
    );
    lockCaseAsRefused(db, caseId);
    return {
      caseId,
      phase,
      decision: "refer",
      outcome: "refuse",
      riskLevel: higherRisk(local.riskLevel, "elevated"),
      categories: local.categories,
      local,
      model,
      evidenceQuotes: [],
      screens,
      rationale,
    };
  }

  /* ---- the model answered ---------------------------------------------- */

  const flagged = modelLayerFlags(model.data);
  const modelRationale = flagged
    ? `Model layer (${safetyScreenStage.model}) reported risk_level ` +
      `${model.data.risk_level} with ${model.data.red_flags.length} category ` +
      `flag(s) and answered "${model.data.outcome}". The gate refers on any ` +
      `flag, any non-none risk level, or a refer answer — whichever came first.`
    : `Model layer (${safetyScreenStage.model}) found nothing: no category, ` +
      `risk_level none.`;

  screens.push(
    recordSafetyScreen(db, {
      caseId,
      screenType: screenTypeFor(phase, "model"),
      outcome: flagged ? "refuse" : "clear",
      answers: null,
      redFlags: model.data.red_flags,
      rationale: modelRationale,
    }),
  );

  const categories = unionCategories(local.categories, model.data.red_flags);
  const riskLevel = higherRisk(local.riskLevel, model.data.risk_level);
  const rationale = `${localRationale} ${modelRationale}`;

  if (!flagged) {
    return {
      caseId,
      phase,
      decision: "pass",
      outcome: "clear",
      riskLevel,
      categories,
      local,
      model,
      evidenceQuotes: model.data.evidence_quotes,
      screens,
      rationale,
    };
  }

  lockCaseAsRefused(db, caseId);
  return {
    caseId,
    phase,
    decision: "refer",
    outcome: "refuse",
    // A model that flags a category but reports `none` still moved the case off
    // "nothing here"; `elevated` is the floor for a referral.
    riskLevel: higherRisk(riskLevel, "elevated"),
    categories,
    local,
    model,
    evidenceQuotes: model.data.evidence_quotes,
    screens,
    rationale,
  };
}

/** The sentence written on the row when the model layer produced no opinion. */
function whyTheModelDidNotRun(
  model: Exclude<ModelLayerRun, { readonly kind: "ran" | "refused" }>,
): string {
  switch (model.kind) {
    case "skipped_no_material":
      return (
        "There is no confirmed material for it to read yet, so this screen " +
        "covers the questionnaire answers only and will re-run before judgment."
      );
    case "skipped_by_caller":
      return (
        "The caller asked for the deterministic layer only, so this screen is " +
        "incomplete by construction."
      );
    case "unavailable":
      return (
        `The model layer could not run (${model.message}). Half a screen is ` +
        `not a clean screen: this run is recorded as incomplete rather than ` +
        `clear, and the gate re-runs before judgment.`
      );
  }
}

/**
 * The one place the model is called. Returns a value for every failure, so the
 * gate never has to catch.
 *
 * It is handed the brief the local layer already scanned rather than reading it
 * again: the two layers must see exactly the same bytes, or "the model caught
 * what the patterns missed" stops being a statement about the two layers and
 * becomes a statement about two different queries.
 */
async function runModelLayer(
  db: Db,
  input: SafetyGateInput,
  brief: CitableBrief,
): Promise<ModelLayerRun> {
  if (input.localOnly === true) return { kind: "skipped_by_caller" };
  if (brief.utterances.length === 0) return { kind: "skipped_no_material" };

  const prompt = `${renderBrief(brief)}\n\n${SAFETY_SCREEN_TASK}`;

  // HARD RULE #3 — the dictionary goes with the payload; the gateway blocks
  // egress on an unregistered person name.
  const result = await runStage(
    safetyScreenStage,
    { prompt, dict: buildCaseDict(db, input.caseId), caseId: input.caseId },
    { db, ...input.llm },
  );

  if (result.kind === "ok") return { kind: "ran", data: result.data };
  if (result.kind === "refused") {
    return result.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: result.category };
  }
  return { kind: "unavailable", message: result.message };
}

/** The passing result, assembled once instead of at three call sites. */
function pass(
  caseId: string,
  phase: SafetyPhase,
  local: LocalSafetyScreen,
  model: ModelLayerState,
  screens: readonly SafetyScreenRow[],
  rationale: string,
): SafetyGateResult {
  return {
    caseId,
    phase,
    decision: "pass",
    outcome: model.kind === "ran" ? "clear" : "flagged",
    riskLevel: local.riskLevel,
    categories: local.categories,
    local,
    model,
    evidenceQuotes: [],
    screens,
    rationale,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/** Stage ①. The questionnaire answers are the half of the screen that asks. */
export function runIntakeSafetyGate(
  db: Db,
  caseId: string,
  answers: readonly SafetyAnswer[],
  options: { readonly localOnly?: boolean; readonly llm?: RunStageOptions } = {},
): Promise<SafetyGateResult> {
  return runSafetyGate(db, { caseId, phase: "intake", answers, ...options });
}

/**
 * The re-run before judgment.
 *
 * The intake screen read a questionnaire and whatever had been confirmed at the
 * door — which, at intake, is usually nothing. By the time judgment is on the
 * table the case has a confirmed transcript, a timeline and three rounds of
 * answers behind it. Screening only at intake would mean screening a document
 * that no longer exists.
 *
 * The intake answers are carried into the re-run so a `yes` given at the door
 * keeps counting; they are re-scanned, not re-asked.
 */
export async function runPreJudgmentSafetyGate(
  db: Db,
  caseId: string,
  options: { readonly localOnly?: boolean; readonly llm?: RunStageOptions } = {},
): Promise<SafetyGateResult> {
  return runSafetyGate(db, {
    caseId,
    phase: "pre_judgment",
    answers: intakeAnswers(db, caseId),
    ...options,
  });
}

/**
 * The most recent questionnaire answers recorded on this case.
 *
 * Rows come back newest-first, and only the local layer's row carries answers —
 * so this is "the newest row that has any", not "the newest row". Reading
 * `rows[0]` would find the model layer's row and conclude the user was never
 * asked anything.
 */
function intakeAnswers(db: Db, caseId: string): readonly SafetyAnswer[] {
  const withAnswers = listSafetyScreens(db, caseId).find(
    (row) => row.answers.length > 0,
  );
  return withAnswers?.answers ?? [];
}

/* -------------------------------------------------------------------------- */
/* Refusal enforcement                                                        */
/* -------------------------------------------------------------------------- */

export class SafetyReferralError extends Error {
  readonly code = "safety_referral" as const;
  readonly caseId: string;

  constructor(caseId: string, message: string) {
    super(message);
    this.name = "SafetyReferralError";
    this.caseId = caseId;
  }
}

/**
 * The call every judgment entry point makes first.
 *
 * Synchronous and cheap on purpose — it is one indexed `SELECT` and no model,
 * so there is no reason for any path to skip it. The stage machine already
 * refuses transitions on a refused case; this is the second enforcement point,
 * read at the moment of use, for the same reason `assertJudgmentAllowed` exists:
 * "the case reached the judgment stage" is a stale answer to "may judgment run
 * right now".
 */
export function assertSafetyClearedForJudgment(db: Db, caseId: string): void {
  if (caseIsReferred(db, caseId)) {
    throw new SafetyReferralError(
      caseId,
      "This case was referred by the safety screen. No judgment runs on it — " +
        "it stays on the crisis-referral path.",
    );
  }
}

/**
 * The full pre-judgment check: assert, re-screen, assert again.
 *
 * This is the call the judgment runner makes (wave B). It is one function rather
 * than a documented sequence because the order matters and is easy to get wrong:
 * the cheap synchronous assertion comes FIRST, so an already-referred case is
 * turned away without a model call — re-screening a case that is already on the
 * crisis path would spend money and latency to re-derive a decision that has
 * been recorded since intake.
 *
 * Returns the re-run's result on the passing path, so the caller can disclose an
 * incomplete screen (`outcome: "flagged"`) in the judgment rather than silently
 * treating it as clean.
 */
export async function screenBeforeJudgment(
  db: Db,
  caseId: string,
  options: { readonly localOnly?: boolean; readonly llm?: RunStageOptions } = {},
): Promise<SafetyGateResult> {
  assertSafetyClearedForJudgment(db, caseId);

  const result = await runPreJudgmentSafetyGate(db, caseId, options);
  if (result.decision === "refer") {
    throw new SafetyReferralError(
      caseId,
      "The safety re-screen run before judgment referred this case. The " +
        "material confirmed since intake changed what the screen was reading, " +
        "and no judgment runs on it now.",
    );
  }
  return result;
}
