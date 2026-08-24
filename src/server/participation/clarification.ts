/**
 * The clarification round, from the invited party's side (doc 05 §A.1 state 5).
 *
 * Her intake is the client's intake with the same discipline applied to it:
 * write it, stand behind it line by line, then answer whatever the record still
 * cannot settle — the **same** ≤3 rounds × ≤3 questions FSM, not a second one
 * (HARD RULE #4). This module adds no counter and no cap of its own. It calls
 * `pipeline/clarification.ts` for every read and every write, so a fourth round
 * is refused by the function that has always refused it.
 *
 * ## What this module is actually for: the author-only rule
 *
 * Clarification answers are author-only, permanently (doc 05 §A.3). The other
 * party never reads them; the facts they establish enter as claims with
 * `evidence_refs`, and the claim is what travels. That is a rule about who may
 * read a round, and `clarification_rounds` has no column saying whose round it
 * is: it is keyed `(case_id, round_number)` and nothing else. So a screen that
 * handed her `readClarification(db, caseId)` would hand her the client's answers
 * about his own case, which is the one thing this product may not do with them.
 *
 * **No migration was available in this wave**, so the rule is enforced by a
 * narrower predicate instead of by a column, and the narrowing is deliberately
 * on the safe side of the question:
 *
 *   a round is hers only if it is still **open** and was **created at or after
 *   the moment her material entered the case record**.
 *
 * Both halves matter. "Created after her grant" is what makes it a round about a
 * record that has her in it — the client's own rounds run in stage ④, long
 * before an invitation exists. "Still open" is the belt: a closed round has
 * answers on it, and this module will not show her a round that already holds
 * somebody's replies. When the predicate is unsure, it resolves to *no round*,
 * which renders as "there is nothing waiting for you" — a true sentence, and a
 * strictly better failure than showing one person another person's answers.
 *
 * The real fix is a `participant_id` column on `clarification_rounds` plus a
 * unique index on `(case_id, participant_id, round_number)`; it is recorded as
 * owed rather than smuggled in as an optional JSON key.
 */

import { and, eq, gte } from "drizzle-orm";

import { consentFoldFor } from "../access/consent";
import type { Db } from "../db";
import { clarificationRounds } from "../db/schema";
import type { Reader } from "../pipeline/stage-machine";
import {
  CLARIFICATION_BUDGET,
  ClarificationError,
  answerClarificationQuestion,
  declineClarificationQuestion,
  readClarification,
  type ClarificationRoundView,
} from "../pipeline/clarification";

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

export interface OwnClarification {
  readonly caseId: string;
  readonly participantId: string;
  readonly budget: typeof CLARIFICATION_BUDGET;
  /** Rounds this case has spent, of `budget.maxRounds`. Shared, not hers alone. */
  readonly roundsUsed: number;
  readonly roundsRemaining: number;
  /** The round waiting on her, or null. Never another party's round. */
  readonly round: ClarificationRoundView | null;
  /**
   * True when a round is open on this case but is not hers to answer.
   *
   * Surfaced rather than folded into `round: null`, because the two are
   * different facts and the screen says different things about them: "nothing
   * is waiting for you" versus "something is in flight that is not yours".
   */
  readonly otherRoundOpen: boolean;
}

/**
 * When her material entered the case record — the boundary this module reads by.
 *
 * Her first `granted / case_record` event, which `submitStatement` writes in the
 * same transaction as her statement. Null while she has granted nothing, and a
 * null boundary means no round can be hers, which is the correct answer: a
 * person who has not put anything into the record has nothing to be asked about.
 */
function grantedAt(db: Reader, caseId: string, participantId: string): Date | null {
  const fold = consentFoldFor(db, caseId, participantId, "case_record");
  return fold.standing === "granted" ? (fold.decidedBy?.occurredAt ?? null) : null;
}

/**
 * The round waiting on her, if there is one.
 *
 * Two conditions, both narrow (see the header). The query does the second in
 * SQL so the predicate is one expression rather than a filter a later edit can
 * quietly widen.
 */
export function readOwnClarification(
  db: Db,
  caseId: string,
  participantId: string,
): OwnClarification {
  const board = readClarification(db, caseId);
  const since = grantedAt(db, caseId, participantId);

  const hers =
    since === null || board.openRound === null
      ? null
      : (db
          .select({ id: clarificationRounds.id })
          .from(clarificationRounds)
          .where(
            and(
              eq(clarificationRounds.id, board.openRound.id),
              gte(clarificationRounds.createdAt, since),
            ),
          )
          .get() !== undefined
          ? board.openRound
          : null);

  return {
    caseId,
    participantId,
    budget: board.budget,
    roundsUsed: board.roundsUsed,
    roundsRemaining: board.roundsRemaining,
    round: hers,
    otherRoundOpen: board.openRound !== null && hers === null,
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Answer one question in the round that is hers.
 *
 * The round is re-derived from the database here rather than taken from the
 * request: a round id in a form post is a claim about whose round it is, and
 * this is the module whose whole job is not to believe that claim. The answer
 * itself goes to `answerClarificationQuestion` verbatim — her own words about
 * her own case, so evidence, so never tidied up.
 */
export function answerOwnClarification(
  db: Db,
  input: {
    readonly caseId: string;
    readonly participantId: string;
    readonly questionId: string;
    readonly answer: string;
  },
): OwnClarification {
  const round = requireOwnRound(db, input.caseId, input.participantId);

  answerClarificationQuestion(db, {
    caseId: input.caseId,
    roundId: round.id,
    questionId: input.questionId,
    answer: input.answer,
  });

  return readOwnClarification(db, input.caseId, input.participantId);
}

/**
 * Record that she is not answering one of them.
 *
 * A settled state rather than a blank, for the reason the FSM already gives: a
 * person asked what she said during the worst week of her relationship is
 * allowed to say she is not answering, the round still closes, and nothing
 * downstream may read the note as if it were her reply.
 */
export function declineOwnClarification(
  db: Db,
  input: {
    readonly caseId: string;
    readonly participantId: string;
    readonly questionId: string;
    readonly note?: string | null;
  },
): OwnClarification {
  const round = requireOwnRound(db, input.caseId, input.participantId);

  declineClarificationQuestion(db, {
    caseId: input.caseId,
    roundId: round.id,
    questionId: input.questionId,
    note: input.note ?? null,
  });

  return readOwnClarification(db, input.caseId, input.participantId);
}

function requireOwnRound(
  db: Db,
  caseId: string,
  participantId: string,
): ClarificationRoundView {
  const own = readOwnClarification(db, caseId, participantId);
  if (own.round === null) {
    throw new ClarificationError(
      "round_not_found",
      "There is no question waiting for you on this case. If one was open a " +
        "moment ago, it has been settled — nothing you typed is lost, and " +
        "nothing has been recorded against you.",
    );
  }
  return own.round;
}
