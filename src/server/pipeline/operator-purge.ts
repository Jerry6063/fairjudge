/**
 * Removing operator-authored material from a real case record.
 *
 * Walking this pipeline end to end requires answers, and during M3 wave A the
 * integration agent had to write three of them itself — each prefixed
 * `[INTEGRATION WALK —` — and had to move the counterparty's
 * `participation_state` off `pending` so the case could enter issue framing.
 * Those are operator decisions sitting in a record about two real people.
 *
 * The failure they create is specific, and it is not "the data is untidy". It is
 * that **the record can no longer say who spoke**. A judgment reads clarification
 * answers as the client's own account and a participation state as a fact about
 * the counterparty; neither is true of these rows, and nothing in their shape
 * says so. Left in place, the operator's guesses would be cited back to the
 * client as their own words.
 *
 * So the purge does not delete anything. Deleting the round would lose the fact
 * that these questions were asked, and would re-open a loop the case has already
 * spent budget on. Instead every contaminated answer is rewritten into the state
 * the product already has for "the client did not answer this" — `declined` —
 * which is a legitimate thing for a real user to say, keeps the round closed and
 * settled, and makes the gap visible to everything downstream (the case file
 * emits `answer_status: "declined"`, and `ClarificationQuestionView.answer` is
 * null, so no reader can quote a sentence the client never wrote).
 *
 * The participation state is re-derived from the record rather than reset to a
 * guess of our own — see `deriveCounterpartyParticipation`.
 *
 * Two things are deliberately NOT touched, and the report says so:
 *   - `saturated` on the round. It was set during the walk, but after the purge
 *     it is simply true: a round of three declined questions did add nothing new.
 *     Clearing it would re-open the clarification loop and re-block the stage.
 *   - a locked `output_level` of `refused`. A safety refusal is not derived from
 *     participation or answers, so nothing here can invalidate it. Any other
 *     locked level IS derived from what this function just changed, so it is
 *     unlocked and must be derived again.
 *
 * Everything is synchronous, takes an explicit `Db`, and reports every row it
 * touched — the script is a printer, this is the decision.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  cases,
  clarificationRounds,
  type ClarificationAnswer,
} from "../db/schema";
import { applyParticipationReset, type Writer } from "./participation";

/* -------------------------------------------------------------------------- */
/* What counts as contamination                                               */
/* -------------------------------------------------------------------------- */

/**
 * The marker the wave-A integration agent prefixed onto every answer it wrote.
 *
 * A literal string rather than a heuristic, because the question "did the client
 * write this?" must have a yes/no answer that a person can verify by looking. An
 * inference over tone or length would eventually delete something real.
 */
export const OPERATOR_ANSWER_MARKER = "[INTEGRATION WALK —";

/** Was this answer written by an operator rather than by the client? */
export function isOperatorAuthored(answer: string): boolean {
  return answer.trimStart().startsWith(OPERATOR_ANSWER_MARKER);
}

/** The note written onto every answer this purge withdraws. */
export const PURGE_DECLINE_NOTE =
  "Withdrawn by `npm run purge:operator`: the text on file here was written " +
  "by an operator walking the wave-A pipeline, not by the client. This " +
  "question was never put to the client, and nothing answers it.";

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

/** One row-level change, in the terms a person auditing the run needs. */
export interface PurgeChange {
  readonly table: string;
  readonly rowId: string;
  /** Column, plus the JSON path inside it when the column holds a document. */
  readonly field: string;
  /** What was there. Verbatim — this is the thing being removed from the record. */
  readonly before: string;
  readonly after: string;
  readonly reason: string;
}

/** Something the purge looked at and deliberately left alone. */
export interface PurgeKept {
  readonly what: string;
  readonly why: string;
}

export interface PurgeReport {
  readonly caseId: string;
  /** Clarification answers scanned across every round of the case. */
  readonly answersScanned: number;
  readonly changes: readonly PurgeChange[];
  readonly kept: readonly PurgeKept[];
  /** True when the record already had nothing to purge (the run is idempotent). */
  readonly clean: boolean;
}

/* -------------------------------------------------------------------------- */
/* The purge                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Withdraw every operator-authored answer on one case, re-derive the
 * counterparty's participation state, and unlock an output level that was
 * derived from either.
 *
 * Idempotent: a second run finds nothing to withdraw, derives the same
 * participation state, and reports zero changes.
 */
export function purgeOperatorAnswers(db: Db, caseId: string): PurgeReport {
  return db.transaction((tx) => applyOperatorPurge(tx, caseId));
}

/**
 * The purge itself, without a transaction of its own.
 *
 * Exported for the script's `--dry-run`, which runs this inside a transaction it
 * then throws away — so what a dry run prints comes from the same code that a
 * real run executes, rather than from a second implementation that predicts it.
 */
export function applyOperatorPurge(db: Writer, caseId: string): PurgeReport {
  const changes: PurgeChange[] = [];
  const kept: PurgeKept[] = [];
  let answersScanned = 0;

  const caseRow = db.select().from(cases).where(eq(cases.id, caseId)).get();
  if (caseRow === undefined) {
    throw new Error(`No case with id ${caseId}.`);
  }

  /* ---- clarification answers ------------------------------------------- */

  const rounds = db
    .select()
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .all();

  for (const round of rounds) {
    const stored: readonly ClarificationAnswer[] = round.answers ?? [];
    answersScanned += stored.length;

    const declinedAt = Date.now();
    let touched = false;

    const rewritten: ClarificationAnswer[] = stored.map((entry) => {
      if (entry.state === "declined" || !isOperatorAuthored(entry.answer)) {
        return entry;
      }
      touched = true;
      changes.push({
        table: "clarification_rounds",
        rowId: round.id,
        field: `answers[${entry.questionId}].answer`,
        before: entry.answer,
        after: "(declined — no answer on file)",
        reason:
          "Prefixed with the integration-walk marker, so it was written by " +
          "an operator and not by the client. Recorded as unanswered rather " +
          "than deleted: the question was really asked, and the judgment has " +
          "to be able to see that it never got an answer.",
      });
      return {
        questionId: entry.questionId,
        answer: "",
        answeredAt: null,
        state: "declined",
        declinedAt,
        declineNote: PURGE_DECLINE_NOTE,
      };
    });

    if (touched) {
      db.update(clarificationRounds)
        .set({ answers: rewritten })
        .where(eq(clarificationRounds.id, round.id))
        .run();

      if (round.saturated) {
        kept.push({
          what: `clarification_rounds.${round.id}.saturated = true`,
          why:
            "Left as it is. A round whose questions all went unanswered did " +
            "add nothing new, so the flag is now simply true — and clearing " +
            "it would re-open the clarification loop and push the case back " +
            "behind a gate it has already spent its budget on.",
        });
      }
    }
  }

  /* ---- participation ---------------------------------------------------- */

  const reset = applyParticipationReset(db, caseId);
  if (reset.changed) {
    changes.push({
      table: "case_participants",
      rowId: reset.participantId,
      field: "participation_state",
      before: reset.from,
      after: reset.to,
      reason: reset.reason,
    });
  } else {
    kept.push({
      what: `case_participants.${reset.participantId}.participation_state = ${reset.to}`,
      why: `Already what the record supports. ${reset.reason}`,
    });
  }

  /* ---- anything derived from the two above ------------------------------ */

  if (caseRow.outputLevel === "refused") {
    kept.push({
      what: "cases.output_level = refused",
      why:
        "A safety refusal, which is not derived from participation or from " +
        "any answer. Nothing purged here can bear on it.",
    });
  } else if (caseRow.outputLevel !== null && changes.length > 0) {
    db.update(cases)
      .set({ outputLevel: null, outputLevelLockedAt: null })
      .where(eq(cases.id, caseId))
      .run();
    changes.push({
      table: "cases",
      rowId: caseId,
      field: "output_level",
      before: caseRow.outputLevel,
      after: "(unlocked)",
      reason:
        "The level was derived from the participation state and the record " +
        "this run has just changed. A lock that outlives its inputs is not a " +
        "lock, it is a stale answer — it has to be derived again.",
    });
  }

  return {
    caseId,
    answersScanned,
    changes,
    kept,
    clean: changes.length === 0,
  };
}
