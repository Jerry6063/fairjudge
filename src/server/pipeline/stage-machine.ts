/**
 * The case stage machine — pipeline stages ① … ⑨ and the rules for moving
 * between them.
 *
 * The one idea this module exists to protect: **a stage advances on facts, never
 * on a prompt.** Every precondition below is a row count or a column value read
 * out of SQLite — "at least one utterance is confirmed", "no adverse fact is
 * still pending", "the output level is locked". Nothing here asks a model
 * whether the case is ready, and no model answer can move a case forward. That
 * is the same rule as CLAUDE.md #2 (`deriveOutputLevel` in code, not in a
 * prompt), applied to the pipeline itself.
 *
 * Shape of the machine:
 *   - The sequence is linear. You may enter exactly the next stage — never skip
 *     one, never go back. A stage that "did not happen" therefore cannot be
 *     silently jumped over; it has to be satisfied.
 *   - A safety refusal freezes the whole thing. Once a screen has come back
 *     `refuse` (or the locked output level is `refused`), the case is on the
 *     deterministic referral path (HARD RULE #9) and no transition is legal.
 *   - `canAdvance` is pure over a facts snapshot and returns *why*, so the UI
 *     can render blockers instead of a dead button. `advanceStage` re-reads the
 *     facts inside a transaction and re-checks them, so a stale page cannot talk
 *     the server into a transition the data does not support.
 *
 * Everything takes an explicit `Db`, so the unit tests drive the same code path
 * the server action does.
 */

import { and, count, eq, inArray, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db } from "../db";
import {
  CASE_STAGES,
  adverseFacts as adverseFactsTable,
  caseParticipants,
  cases,
  clarificationRounds,
  evidence as evidenceTable,
  events as eventsTable,
  issues as issuesTable,
  judgments as judgmentsTable,
  safetyScreens,
  steelmanVersions,
  utterances as utterancesTable,
  type CaseStage,
  type OutputLevel,
  type ParticipationState,
  type SteelmanVerdict,
} from "../db/schema";
// The adverse-fact gate is defined once and enforced twice — here, on the
// transition into `judgment`, and again in the judgment runner itself. See
// `judgment-gate.ts`.
import { adverseFactsSettled, adverseFactsSurfaced } from "./judgment-gate";

/* -------------------------------------------------------------------------- */
/* The nine stages                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The nine pipeline stages, in order (01-pipeline-design.md). `cases.stage` can
 * also hold the two terminal phases that follow them — see `STAGE_SEQUENCE`.
 */
export const PIPELINE_STAGES = [
  "intake",
  "evidence_intake",
  "transcription",
  "timeline",
  "clarification",
  "participation",
  "issue_framing",
  "pre_judgment",
  "judgment",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Every stage a case can be in, in transition order: the nine, then the two
 * terminal phases. This is `CASE_STAGES` — the schema's vocabulary is already
 * ordered, and re-deriving it here would let the two drift apart.
 */
export const STAGE_SEQUENCE = CASE_STAGES;

/** Clarification budget — HARD RULE #4 (≤3 rounds × ≤3 questions). */
export const MAX_CLARIFICATION_ROUNDS = 3;

/** Confirmation states that count as "a human has signed this line off". */
const SETTLED_CONFIRM = ["confirmed", "edited"] as const;

/** Static per-stage copy for the stepper: what the stage is, in one line. */
export interface StageMeta {
  /** 1-based position; the nine pipeline stages are 1..9. */
  readonly index: number;
  /** Short title. */
  readonly title: string;
  /** What happens in this stage, in one sentence. */
  readonly purpose: string;
}

export const STAGE_META: Readonly<Record<CaseStage, StageMeta>> = {
  intake: {
    index: 1,
    title: "Intake and safety screening",
    purpose:
      "State what is being judged, and run the safety screen that decides " +
      "whether this belongs in a judgment pipeline at all.",
  },
  evidence_intake: {
    index: 2,
    title: "Material registration and grading",
    purpose:
      "Register every screenshot and record, and settle each item's A-D grade.",
  },
  transcription: {
    index: 3,
    title: "Transcription and speaker confirmation",
    purpose:
      "Turn recognized text into utterances, and confirm who said what. " +
      "Nothing unconfirmed can be cited later.",
  },
  timeline: {
    index: 4,
    title: "Timeline reconstruction",
    purpose:
      "Put the events in order. Undated events wait until you decide where " +
      "they go.",
  },
  clarification: {
    index: 5,
    title: "Clarification and steelmanning",
    purpose:
      "Up to three rounds of at most three questions, then the strongest " +
      "version of the other person's side — which you accept or rebut.",
  },
  participation: {
    index: 6,
    title: "Counterparty participation",
    purpose:
      "Settle whether the other party takes part, responds in writing, " +
      "refuses, cannot be reached, or does not know about this.",
  },
  issue_framing: {
    index: 7,
    title: "Issue fixing (three lists)",
    purpose:
      "Separate undisputed facts, disputes of fact, and disputes of standard " +
      "— each item tied to confirmed evidence.",
  },
  pre_judgment: {
    index: 8,
    title: "Pre-judgment confrontation",
    purpose:
      "The facts that count against you are put in front of you first. You " +
      "acknowledge or contest each one before any judgment runs.",
  },
  judgment: {
    index: 9,
    title: "Judgment",
    purpose:
      "The graded output, at the level the evidence and participation support.",
  },
  post_judgment: {
    index: 10,
    title: "After the judgment",
    purpose: "Dual renditions, the improvement contract, follow-ups, appeals.",
  },
  closed: {
    index: 11,
    title: "Closed",
    purpose: "The case is finished.",
  },
};

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The snapshot every precondition is judged against.
 *
 * Deliberately flat counts rather than rows: a precondition should be readable
 * as one comparison, and a fact you cannot express as a number or a state is
 * usually a judgement in disguise.
 */
export interface CaseFacts {
  readonly caseId: string;
  readonly stage: CaseStage;
  readonly outputLevel: OutputLevel | null;
  readonly downgradeSignal: boolean;
  readonly safety: {
    /** Screens recorded so far (any type). */
    readonly screens: number;
    /** A screen came back `refuse` — the case is on the referral path. */
    readonly refused: boolean;
    /** A screen came back `flagged` (not a refusal, but recorded). */
    readonly flagged: boolean;
  };
  readonly evidence: {
    readonly total: number;
    /** Items whose grade a human has signed off (`grade_final` set). */
    readonly graded: number;
  };
  readonly utterances: {
    readonly total: number;
    /** `confirm_status` in (confirmed, edited) — citable material. */
    readonly confirmed: number;
  };
  readonly events: {
    readonly total: number;
    /** Dated, or dragged onto the mainline. */
    readonly mainline: number;
  };
  readonly clarification: {
    readonly rounds: number;
    /** Rounds whose questions are all answered (`closed_at` set). */
    readonly closedRounds: number;
    /** Any round reported saturation (no new information). */
    readonly saturated: boolean;
    /** The stage's own `can_proceed` on any closed round (advisory). */
    readonly canProceed: boolean;
  };
  readonly steelman: {
    readonly versions: number;
    /** Verdict on the newest version, or null when there is none. */
    readonly verdict: SteelmanVerdict | null;
  };
  /** The party who did not submit the case. Null when there is no such row. */
  readonly counterpartyParticipation: ParticipationState | null;
  readonly issues: {
    readonly total: number;
    /** Items still `pending` in the confirmation triple. */
    readonly pending: number;
  };
  readonly adverseFacts: {
    readonly total: number;
    /** Items whose `ack_status` is still `pending`. */
    readonly pending: number;
  };
  readonly judgments: {
    readonly total: number;
    readonly final: number;
  };
}

export type StageMachineErrorCode =
  | "case_not_found"
  | "unknown_stage"
  | "not_forward"
  | "stage_skipped"
  | "safety_refused"
  | "preconditions_unmet";

export class StageMachineError extends Error {
  readonly code: StageMachineErrorCode;
  /** The requirements that were not met (empty for the structural refusals). */
  readonly unmet: readonly Requirement[];

  constructor(
    code: StageMachineErrorCode,
    message: string,
    unmet: readonly Requirement[] = [],
  ) {
    super(message);
    this.name = "StageMachineError";
    this.code = code;
    this.unmet = unmet;
  }
}

/**
 * The read surface the fact collector needs. A `Db` satisfies it, and so does a
 * transaction handle — which is what lets `advanceStage` re-check the facts
 * inside the same transaction that performs the write.
 */
export type Reader = Pick<Db, "select">;

/** Read every fact the machine judges on, for one case. */
export function collectCaseFacts(db: Reader, caseId: string): CaseFacts {
  const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
  if (row === undefined) {
    throw new StageMachineError("case_not_found", `No case with id ${caseId}.`);
  }

  const screens = db
    .select({ outcome: safetyScreens.outcome })
    .from(safetyScreens)
    .where(eq(safetyScreens.caseId, caseId))
    .all();

  const evidenceRows = db
    .select({ gradeFinal: evidenceTable.gradeFinal })
    .from(evidenceTable)
    .where(eq(evidenceTable.caseId, caseId))
    .all();

  const eventRows = db
    .select({
      precision: eventsTable.occurredPrecision,
      inTimeline: eventsTable.inTimeline,
    })
    .from(eventsTable)
    .where(eq(eventsTable.caseId, caseId))
    .all();

  const rounds = db
    .select({
      closedAt: clarificationRounds.closedAt,
      saturated: clarificationRounds.saturated,
      canProceed: clarificationRounds.canProceed,
    })
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .all();

  const steelmen = db
    .select({
      version: steelmanVersions.version,
      verdict: steelmanVersions.verdict,
    })
    .from(steelmanVersions)
    .where(eq(steelmanVersions.caseId, caseId))
    .all();
  const newestSteelman = [...steelmen].sort((a, b) => b.version - a.version)[0];

  const participants = db
    .select({
      role: caseParticipants.role,
      isSubmitter: caseParticipants.isSubmitter,
      participationState: caseParticipants.participationState,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();
  // The counterparty is whoever did not submit the case; the respondent role is
  // the fallback for a case where nobody is marked as the submitter yet.
  const counterparty =
    participants.find((p) => !p.isSubmitter) ??
    participants.find((p) => p.role === "respondent");

  const judgmentRows = db
    .select({ status: judgmentsTable.status })
    .from(judgmentsTable)
    .where(eq(judgmentsTable.caseId, caseId))
    .all();

  return {
    caseId,
    stage: row.stage,
    outputLevel: row.outputLevel,
    downgradeSignal: row.downgradeSignal,
    safety: {
      screens: screens.length,
      refused: screens.some((s) => s.outcome === "refuse"),
      flagged: screens.some((s) => s.outcome === "flagged"),
    },
    evidence: {
      total: evidenceRows.length,
      graded: evidenceRows.filter((e) => e.gradeFinal !== null).length,
    },
    utterances: {
      total: countRows(db, utterancesTable, eq(utterancesTable.caseId, caseId)),
      confirmed: countRows(
        db,
        utterancesTable,
        and(
          eq(utterancesTable.caseId, caseId),
          inArray(utterancesTable.confirmStatus, [...SETTLED_CONFIRM]),
        ),
      ),
    },
    events: {
      total: eventRows.length,
      mainline: eventRows.filter(
        (e) => e.precision !== "unknown" || e.inTimeline,
      ).length,
    },
    clarification: {
      rounds: rounds.length,
      closedRounds: rounds.filter((r) => r.closedAt !== null).length,
      saturated: rounds.some((r) => r.saturated),
      canProceed: rounds.some((r) => r.closedAt !== null && r.canProceed),
    },
    steelman: {
      versions: steelmen.length,
      verdict: newestSteelman?.verdict ?? null,
    },
    counterpartyParticipation: counterparty?.participationState ?? null,
    issues: {
      total: countRows(db, issuesTable, eq(issuesTable.caseId, caseId)),
      pending: countRows(
        db,
        issuesTable,
        and(
          eq(issuesTable.caseId, caseId),
          eq(issuesTable.confirmStatus, "pending"),
        ),
      ),
    },
    adverseFacts: {
      total: countRows(
        db,
        adverseFactsTable,
        eq(adverseFactsTable.caseId, caseId),
      ),
      pending: countRows(
        db,
        adverseFactsTable,
        and(
          eq(adverseFactsTable.caseId, caseId),
          eq(adverseFactsTable.ackStatus, "pending"),
        ),
      ),
    },
    judgments: {
      total: judgmentRows.length,
      final: judgmentRows.filter((j) => j.status === "final").length,
    },
  };
}

/** `SELECT count(*)` helper — the same three lines six times otherwise. */
function countRows(db: Reader, table: SQLiteTable, where: SQL | undefined): number {
  const [row] = db.select({ n: count() }).from(table).where(where).all();
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Preconditions                                                              */
/* -------------------------------------------------------------------------- */

/** One data fact a stage needs before a case may enter it. */
export interface Requirement {
  /** Stable id, for tests and for keying the list in the UI. */
  readonly id: string;
  /** What the stage needs, in the user's words. */
  readonly need: string;
  /** Rendered when unmet: what is missing and where to go and fix it. */
  readonly blocker: string;
  readonly satisfied: boolean;
}

type RequirementSpec = {
  readonly id: string;
  readonly need: string;
  readonly blocker: string;
  readonly test: (facts: CaseFacts) => boolean;
};

/**
 * What each stage requires before a case may ENTER it.
 *
 * Read this table as the whole rulebook — if a rule is not here, the machine
 * does not enforce it. `intake` is the entry point and needs nothing; `closed`
 * only needs the post-judgment work to be over, which the linear sequence
 * already guarantees.
 */
const ENTRY_REQUIREMENTS: Readonly<Record<CaseStage, readonly RequirementSpec[]>> =
  {
    intake: [],

    evidence_intake: [
      {
        id: "safety_screen_recorded",
        need: "A safety screen has been run and recorded.",
        blocker:
          "No safety screen has been recorded for this case. Intake runs the " +
          "screen before any material is registered.",
        test: (f) => f.safety.screens > 0,
      },
    ],

    transcription: [
      {
        id: "evidence_registered",
        need: "At least one piece of material is registered.",
        blocker: "No evidence has been registered yet.",
        test: (f) => f.evidence.total > 0,
      },
    ],

    timeline: [
      {
        id: "transcription_confirmed",
        need: "At least one utterance is confirmed or rewritten.",
        blocker:
          "Nothing has been confirmed in the transcription workbench yet. " +
          "Unconfirmed lines cannot be cited by anything downstream.",
        test: (f) => f.utterances.confirmed > 0,
      },
    ],

    clarification: [
      {
        id: "timeline_placed",
        need: "At least one event sits on the timeline.",
        blocker:
          "No event is on the timeline yet — either give one a date or drag " +
          "it in from the undated column.",
        test: (f) => f.events.mainline > 0,
      },
    ],

    participation: [
      {
        id: "clarification_settled",
        need:
          "The clarification loop is finished: a round reported saturation, " +
          "or all three rounds have been used.",
        blocker:
          "The clarification loop is still open. Answer the current round; " +
          "it ends when a round adds nothing new, or after three rounds.",
        test: (f) =>
          f.clarification.closedRounds >= MAX_CLARIFICATION_ROUNDS ||
          (f.clarification.closedRounds > 0 &&
            (f.clarification.saturated || f.clarification.canProceed)),
      },
      {
        id: "steelman_answered",
        need:
          "The other side's strongest version has been put to you, and you " +
          "accepted it, rebutted it, or said it cannot be written.",
        blocker:
          "The steelman of the other party is still unanswered. Saying it " +
          "cannot be written is a valid answer — it is recorded as a " +
          "downgrade signal rather than treated as agreement.",
        test: (f) =>
          f.steelman.versions > 0 &&
          f.steelman.verdict !== null &&
          f.steelman.verdict !== "pending",
      },
    ],

    issue_framing: [
      {
        // The task's explicit example: issues cannot be reached before a
        // transcription confirmation exists. Every issue item carries
        // evidence_refs, and those refs are only citable if confirmed
        // (HARD RULE #1) — so an unconfirmed transcript can ground nothing.
        id: "transcription_confirmed",
        need: "At least one utterance is confirmed or rewritten.",
        blocker:
          "Issues have to rest on confirmed material, and nothing in this " +
          "case has been confirmed yet.",
        test: (f) => f.utterances.confirmed > 0,
      },
      {
        id: "participation_settled",
        need: "The other party's participation state is settled.",
        blocker:
          "The other party is still marked as pending. Record what actually " +
          "happened — taking part, a written response, a refusal, " +
          "unreachable, or unaware.",
        test: (f) =>
          f.counterpartyParticipation !== null &&
          f.counterpartyParticipation !== "pending",
      },
    ],

    pre_judgment: [
      {
        id: "issues_listed",
        need: "The three issue lists have at least one item.",
        blocker: "No issues have been fixed yet.",
        test: (f) => f.issues.total > 0,
      },
      {
        id: "issues_settled",
        need: "Every issue has been confirmed, rewritten, or dropped.",
        blocker: "Some issues are still waiting for your review.",
        test: (f) => f.issues.total > 0 && f.issues.pending === 0,
      },
    ],

    judgment: [
      {
        // Without this, the gate below would pass vacuously on a case where
        // the adverse-fact pass never ran: zero rows means zero pending.
        id: "adverse_facts_surfaced",
        need: "The facts that count against you have been surfaced.",
        blocker:
          "No adverse fact has been put in front of you yet. Judgment does " +
          "not run on a case that has never been confronted with its own " +
          "weak points.",
        test: (f) => adverseFactsSurfaced(f.adverseFacts),
      },
      {
        id: "adverse_facts_acknowledged",
        need: "Every adverse fact is acknowledged or contested.",
        blocker:
          "An adverse fact is still pending. Each one has to be acknowledged " +
          "or contested before judgment runs — this gate cannot be skipped.",
        test: (f) => adverseFactsSettled(f.adverseFacts),
      },
      {
        id: "output_level_locked",
        need: "The output level is derived and locked onto the case.",
        blocker:
          "No output level is locked. It is derived in code from " +
          "participation, the evidence profile and safety " +
          "(deriveOutputLevel), never chosen by the model.",
        test: (f) => f.outputLevel !== null,
      },
    ],

    post_judgment: [
      {
        id: "judgment_final",
        need: "A judgment has been finalized.",
        blocker: "No judgment on this case is final yet.",
        test: (f) => f.judgments.final > 0,
      },
    ],

    closed: [],
  };

/** Evaluate what entering `stage` requires, against a facts snapshot. */
export function requirementsFor(
  facts: CaseFacts,
  stage: CaseStage,
): Requirement[] {
  return ENTRY_REQUIREMENTS[stage].map((spec) => ({
    id: spec.id,
    need: spec.need,
    blocker: spec.blocker,
    satisfied: spec.test(facts),
  }));
}

/** The stage that follows `stage`, or null at the end of the sequence. */
export function nextStage(stage: CaseStage): CaseStage | null {
  const at = STAGE_SEQUENCE.indexOf(stage);
  /* c8 ignore next -- unreachable: `stage` is typed to the vocabulary. */
  if (at === -1) return null;
  return STAGE_SEQUENCE[at + 1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

export type AdvanceDecision =
  | {
      readonly allowed: true;
      readonly from: CaseStage;
      readonly to: CaseStage;
      readonly requirements: readonly Requirement[];
    }
  | {
      readonly allowed: false;
      readonly code: Exclude<StageMachineErrorCode, "case_not_found">;
      readonly reason: string;
      readonly from: CaseStage;
      readonly to: CaseStage;
      readonly requirements: readonly Requirement[];
      readonly unmet: readonly Requirement[];
    };

/**
 * May this case enter `stage`?
 *
 * Pure: same snapshot in, same answer out, no I/O. Refusals carry their reason
 * and the unmet requirements so the caller can render them; the UI never has to
 * guess why a button is dead.
 */
export function canAdvance(
  caseFacts: CaseFacts,
  stage: CaseStage,
): AdvanceDecision {
  const from = caseFacts.stage;
  const requirements = STAGE_SEQUENCE.includes(stage)
    ? requirementsFor(caseFacts, stage)
    : [];

  const refuse = (
    code: Exclude<StageMachineErrorCode, "case_not_found">,
    reason: string,
    unmet: readonly Requirement[] = [],
  ): AdvanceDecision => ({
    allowed: false,
    code,
    reason,
    from,
    to: stage,
    requirements,
    unmet,
  });

  if (!STAGE_SEQUENCE.includes(stage)) {
    return refuse("unknown_stage", `${String(stage)} is not a case stage.`);
  }

  // HARD RULE #9's counterpart: a refused case is on the referral path, and the
  // pipeline is closed to it entirely — including "harmless" forward steps.
  if (caseFacts.safety.refused || caseFacts.outputLevel === "refused") {
    return refuse(
      "safety_refused",
      "The safety screen refused this case. It stays on the referral path and " +
        "no stage transition is available.",
    );
  }

  const fromAt = STAGE_SEQUENCE.indexOf(from);
  const toAt = STAGE_SEQUENCE.indexOf(stage);

  if (toAt <= fromAt) {
    return refuse(
      "not_forward",
      toAt === fromAt
        ? `The case is already at ${STAGE_META[stage].title.toLowerCase()}.`
        : `A case never moves backwards: ${from} → ${stage} is not a legal ` +
            `transition.`,
    );
  }
  if (toAt > fromAt + 1) {
    const skipped = STAGE_SEQUENCE.slice(fromAt + 1, toAt).join(", ");
    return refuse(
      "stage_skipped",
      `Stages are entered one at a time: ${from} → ${stage} would skip ` +
        `${skipped}.`,
    );
  }

  const unmet = requirements.filter((r) => !r.satisfied);
  if (unmet.length > 0) {
    return refuse(
      "preconditions_unmet",
      `${STAGE_META[stage].title} is not reachable yet: ${unmet.length} ` +
        `precondition(s) unmet.`,
      unmet,
    );
  }

  return { allowed: true, from, to: stage, requirements };
}

export interface AdvanceOutcome {
  readonly caseId: string;
  readonly from: CaseStage;
  readonly to: CaseStage;
  readonly enteredAt: Date;
}

/**
 * Move a case into `stage`, or refuse.
 *
 * The facts are re-read and re-checked inside the write transaction, so the
 * decision that authorizes the write is made against the database as it is at
 * write time — not against whatever the caller last rendered.
 *
 * Throws `StageMachineError` on an illegal transition; the server action turns
 * that into copy. A throw here is the expected path for a refusal, not a bug.
 */
export function advanceStage(
  db: Db,
  caseId: string,
  stage: CaseStage,
): AdvanceOutcome {
  return db.transaction((tx) => {
    const facts = collectCaseFacts(tx, caseId);
    const decision = canAdvance(facts, stage);

    if (!decision.allowed) {
      throw new StageMachineError(decision.code, decision.reason, decision.unmet);
    }

    const enteredAt = new Date();
    tx.update(cases)
      .set({ stage, stageEnteredAt: enteredAt })
      .where(eq(cases.id, caseId))
      .run();

    return { caseId, from: decision.from, to: decision.to, enteredAt };
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

/** One row of the stepper. */
export interface StageStatus {
  readonly stage: CaseStage;
  readonly meta: StageMeta;
  readonly state: "done" | "current" | "upcoming";
  /** What entering this stage requires, evaluated against the current facts. */
  readonly requirements: readonly Requirement[];
  /** True for the one stage the case may move into next. */
  readonly isNext: boolean;
}

/**
 * The whole stepper in one call: every stage, its state, and what it needs.
 * Pure over the snapshot, so the page renders exactly what the machine would
 * decide.
 */
export function describePipeline(facts: CaseFacts): StageStatus[] {
  const currentAt = STAGE_SEQUENCE.indexOf(facts.stage);
  const upcoming = nextStage(facts.stage);

  return STAGE_SEQUENCE.map((stage, at) => ({
    stage,
    meta: STAGE_META[stage],
    state: at < currentAt ? "done" : at === currentAt ? "current" : "upcoming",
    requirements: requirementsFor(facts, stage),
    isNext: stage === upcoming,
  }));
}

/** Unmet requirements standing between the case and its next stage. */
export function blockersForNextStage(facts: CaseFacts): Requirement[] {
  const target = nextStage(facts.stage);
  if (target === null) return [];
  return requirementsFor(facts, target).filter((r) => !r.satisfied);
}
