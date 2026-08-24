/**
 * Counterparty participation (stage ⑥) — the fact `issue_framing` waits on.
 *
 * The stage machine refuses to enter issue fixing while the counterparty is
 * still `pending` (see `ENTRY_REQUIREMENTS.issue_framing`), and until this
 * module existed nothing in the product could move that column off its default.
 * The whole content of the stage is one recorded answer to one question: what
 * actually happened when the other person was (or was not) asked.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not let the answer go back to `pending`. `pending` is the absence
 *     of an answer, not one of the answers; a case that has been told "they
 *     refused" has learned something, and un-learning it by picking the default
 *     again would quietly re-open a gate the record has already passed.
 *   - It does not derive or lock the output level. Participation is one of the
 *     three inputs to `deriveOutputLevel` (HARD RULE #2) and the level is locked
 *     later, from all three at once; computing a level here from one of them
 *     would put a second, earlier answer to the same question in the codebase.
 *
 * Everything is synchronous and takes an explicit `Db`, so a test drives the
 * same code path the server action does.
 */

import { eq } from "drizzle-orm";

import {
  PARTICIPATION_ANSWERS,
  PARTICIPATION_META,
  type ParticipationAnswer,
  type ParticipationMeta,
} from "../../lib/participation-contract";
import { hasIdentity } from "../access/invite";
import type { Db } from "../db";
import {
  caseParticipants,
  type ParticipantRole,
  type ParticipationState,
} from "../db/schema";
import type { Reader } from "./stage-machine";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

// The five answers and their copy live in `lib/` because the screen is a client
// component and may not import this module: the server and the screen have to
// describe the same column with the same words, and two copies of that list is
// how they stop doing so.
export { PARTICIPATION_ANSWERS, PARTICIPATION_META };
export type { ParticipationAnswer, ParticipationMeta };

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

export interface ParticipantView {
  readonly id: string;
  /** Local-only real name. Never leaves the machine (HARD RULE #3). */
  readonly displayName: string | null;
  /** The token every egress uses instead of the name. */
  readonly pseudonym: string;
  readonly role: ParticipantRole;
  readonly isSubmitter: boolean;
  readonly participationState: ParticipationState;
  /**
   * Whether an invite token was ever minted for them — i.e. whether this party
   * was actually asked. The hash itself never leaves the server; only the fact
   * that one exists does, because that fact is what any claim about their
   * participation has to rest on.
   */
  readonly invited: boolean;
}

export interface ParticipationBoard {
  readonly caseId: string;
  readonly submitter: ParticipantView | null;
  /** Whoever did not submit the case. Null when the case has no such row. */
  readonly counterparty: ParticipantView | null;
  /** Mirrors `participation_settled` in the stage machine. */
  readonly settled: boolean;
}

function toView(
  row: typeof caseParticipants.$inferSelect,
): ParticipantView {
  return {
    id: row.id,
    displayName: row.displayName,
    pseudonym: row.pseudonym,
    role: row.role,
    isSubmitter: row.isSubmitter,
    participationState: row.participationState,
    invited: row.inviteTokenHash !== null,
  };
}

/**
 * Both parties, with the counterparty picked the same way the stage machine
 * picks it: whoever did not submit, falling back to the respondent role. The
 * two must agree, or the screen would be settling a different row than the one
 * the gate reads.
 */
export function readParticipation(
  db: Reader,
  caseId: string,
): ParticipationBoard {
  const rows = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .map(toView);

  const counterparty =
    rows.find((row) => !row.isSubmitter) ??
    rows.find((row) => row.role === "respondent") ??
    null;
  const submitter = rows.find((row) => row.isSubmitter) ?? null;

  return {
    caseId,
    submitter,
    counterparty,
    settled:
      counterparty !== null && counterparty.participationState !== "pending",
  };
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type ParticipationErrorCode = "no_counterparty";

export class ParticipationError extends Error {
  readonly code: ParticipationErrorCode;

  constructor(code: ParticipationErrorCode, message: string) {
    super(message);
    this.name = "ParticipationError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* What the record itself supports                                            */
/* -------------------------------------------------------------------------- */

/**
 * The facts on file about whether the other party was ever reached.
 *
 * Deliberately tiny. Each field is a stored value with one meaning, because the
 * question this answers — "does anything in this case support the participation
 * state written on it?" — must not be answerable by an opinion.
 */
export interface ParticipationEvidence {
  /** An invite token was minted for them: they were actually asked. */
  readonly invited: boolean;
  /** They logged in and took part, or sent something back through the product. */
  readonly responded: boolean;
  /**
   * They said no themselves, inside the product (`respond_state = 'declined'`).
   *
   * A separate fact from `responded` because it is the opposite claim, and a
   * separate fact from the client's report because it was made by the person the
   * report is about.
   */
  readonly declined: boolean;
}

export interface ParticipationDerivation {
  readonly state: ParticipationState;
  /** Why, in one line — written onto the audit trail of anything that resets. */
  readonly reason: string;
}

/**
 * Re-derive the counterparty's participation state from the record.
 *
 * This exists because a participation state is a claim about another human
 * being, and four of the five answers claim something the record can be checked
 * against: `participating` and `written_response` claim they took part,
 * `refused` claims they were asked and said no, `unreachable` claims someone
 * tried. `unaware` claims something stronger still — that they do not know this
 * case exists — which is a statement about another person's mind that only the
 * client is in a position to make.
 *
 * So: when nothing on file shows they were ever invited or ever answered, the
 * only state the record supports is `pending`. `pending` is not a verdict about
 * the counterparty; it is the honest absence of one. Anything else has to have
 * been put there by the person who actually knows, and that is exactly what
 * `npm run purge:operator` uses this for — an operator's guess sitting in a real
 * case record is indistinguishable from the client's answer once it is written.
 *
 * Pure over the facts, so the script and any future re-derivation agree.
 */
export function deriveCounterpartyParticipation(
  evidence: ParticipationEvidence,
): ParticipationDerivation {
  if (evidence.responded) {
    return {
      state: "participating",
      reason:
        "The counterparty answered through the product, so the record itself " +
        "shows they took part.",
    };
  }
  if (evidence.declined) {
    return {
      state: "refused",
      reason:
        "The counterparty declined through the product, in their own words. " +
        "That is their own act on their own row, not the client's report about " +
        "them, so it is the one non-pending state the record supports by itself.",
    };
  }
  if (evidence.invited) {
    return {
      state: "pending",
      reason:
        "An invitation was issued but nothing came back. The record shows " +
        "they were asked; what they did about it is still the client's to " +
        "report, so the state stays unanswered rather than being guessed at.",
    };
  }
  return {
    state: "pending",
    reason:
      "Nothing on file shows the counterparty was ever invited or ever " +
      "answered. Every other state would be a claim about a person who has " +
      "not been asked — including 'unaware', which asserts what they do or do " +
      "not know. Only the client can settle this.",
  };
}

/**
 * Read the two facts `deriveCounterpartyParticipation` judges on.
 *
 * Before M5 `responded` was hard-coded false, and honestly so: there was no
 * channel through which the counterparty could send anything back. M5 ① built
 * one, and the fact that the channel was used is the identity row — redeeming
 * an invite is the moment a party stops being a subject of the case and becomes
 * someone who is here. So `responded` reads that row, through the same
 * `hasIdentity` the access layer defines it with, rather than re-deriving "she
 * is here" from a second column that could disagree with it.
 *
 * **Declining is deliberately not `responded`.** It is an answer, and a
 * first-class one (SPEC M5 ②), but `deriveCounterpartyParticipation` maps
 * `responded` onto `participating`, and a decline is the opposite claim. It is
 * therefore read as its own fact, `declined`, straight off `respond_state` —
 * which only her own acts write (`server/participation/submission.ts`).
 *
 * That closes the seam this comment used to warn about: before `/respond`
 * existed, `applyParticipationReset` read a party who had declined as
 * un-responded and walked her recorded refusal back to `pending`. Her decline is
 * now a fact the derivation can see, so the repair tool leaves it where she put
 * it. What the reset still un-does is what it was written for: an answer about
 * her that nobody with standing entered.
 */
export function readParticipationEvidence(
  db: Reader,
  caseId: string,
): ParticipationEvidence {
  const board = readParticipation(db, caseId);
  const counterparty = board.counterparty;
  if (counterparty === null) {
    return { invited: false, responded: false, declined: false };
  }

  // Read straight from the row rather than through `ParticipantView`: this is
  // the one caller that needs `respond_state`, and widening the view every
  // screen renders would put her entry-flow state on pages that have no
  // business asserting anything about it.
  const row = db
    .select({ respondState: caseParticipants.respondState })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, counterparty.id))
    .get();

  return {
    invited: counterparty.invited,
    responded: hasIdentity(db, counterparty.id),
    declined: row?.respondState === "declined",
  };
}

/* -------------------------------------------------------------------------- */
/* The one mutation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Record what happened when the other party was asked.
 *
 * The counterparty row is re-read inside the write transaction, for the same
 * reason every other stage does it: the decision that authorizes the write is
 * made against the database as it is at write time, not against whatever the
 * page last rendered.
 */
export function setCounterpartyParticipation(
  db: Db,
  caseId: string,
  state: ParticipationAnswer,
): ParticipationBoard {
  db.transaction((tx) => {
    const board = readParticipation(tx, caseId);
    if (board.counterparty === null) {
      throw new ParticipationError(
        "no_counterparty",
        "This case has no second party on it, so there is no participation " +
          "state to settle.",
      );
    }
    tx.update(caseParticipants)
      .set({ participationState: state })
      .where(eq(caseParticipants.id, board.counterparty.id))
      .run();
  });

  return readParticipation(db, caseId);
}

/* -------------------------------------------------------------------------- */
/* The un-answer                                                              */
/* -------------------------------------------------------------------------- */

export interface ParticipationReset {
  readonly participantId: string;
  readonly from: ParticipationState;
  readonly to: ParticipationState;
  /** The derivation's own words for why the record supports `to`. */
  readonly reason: string;
  readonly changed: boolean;
}

/**
 * The write surface the reset needs: a `Db` satisfies it and so does a
 * transaction handle, which is what lets a larger repair (the operator purge)
 * run this inside its own single transaction rather than opening a second one.
 */
export type Writer = Reader & Pick<Db, "update">;

/**
 * Put the counterparty's participation state back to what the record supports.
 *
 * The deliberate counterpart to `setCounterpartyParticipation`, which refuses to
 * write `pending` because un-answering a question the client answered would
 * quietly re-open a gate the record has already passed. That reasoning holds
 * only while the answer on file came from the client. When it did not — an
 * operator walking the pipeline, a fixture left behind — the state is not an
 * answer at all, and leaving it in place is the worse failure: a judgment would
 * rest a claim about a real person's participation on a value that nobody with
 * standing ever entered.
 *
 * So this is a separate, uglier function on purpose. It states its reason,
 * returns exactly what it changed, and is called by `npm run purge:operator` and
 * by nothing in the product's normal flow.
 */
export function resetCounterpartyParticipation(
  db: Db,
  caseId: string,
): ParticipationReset {
  return db.transaction((tx) => applyParticipationReset(tx, caseId));
}

/**
 * The reset itself, without a transaction of its own.
 *
 * Exported for one caller: `operator-purge.ts`, which withdraws the operator's
 * answers and this state in a single transaction — a repair that half-applied
 * would leave a record whose participation claim no longer matches the answers
 * it was entered alongside.
 */
export function applyParticipationReset(
  db: Writer,
  caseId: string,
): ParticipationReset {
  const board = readParticipation(db, caseId);
  if (board.counterparty === null) {
    throw new ParticipationError(
      "no_counterparty",
      "This case has no second party on it, so there is no participation " +
        "state to reset.",
    );
  }

  const derived = deriveCounterpartyParticipation(
    readParticipationEvidence(db, caseId),
  );
  const from = board.counterparty.participationState;
  const changed = from !== derived.state;

  if (changed) {
    db.update(caseParticipants)
      .set({ participationState: derived.state })
      .where(eq(caseParticipants.id, board.counterparty.id))
      .run();
  }

  return {
    participantId: board.counterparty.id,
    from,
    to: derived.state,
    reason: derived.reason,
    changed,
  };
}
