"use server";

// Server actions for `/respond/[token]/submit` — the counterparty's write path.
//
// Every action re-resolves the token against the database and derives WHOSE
// material it is about from that. No action takes a participant id, a case id or
// an owner from the request: the token is the only thing the caller supplies
// that decides anything, and it is checked against a stored hash on every call.
//
// Beyond that these are the usual two-line shells — hand the work to
// `server/participation/submission.ts`, which owns the ownership checks and the
// confirmation rules, and turn an expected refusal into data the UI can render.
// Anything else propagates: a bug belongs on the error boundary, not dressed up
// as a polite sentence.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb, type Db } from "../../../../server/db";
import {
  WorkbenchError,
  type WorkbenchUtterance,
} from "../../../../server/evidence/workbench";
import { ClarificationError } from "../../../../server/pipeline/clarification";
import {
  answerOwnClarification,
  declineOwnClarification,
  type OwnClarification,
} from "../../../../server/participation/clarification";
import {
  MAX_STATEMENT_CHARS,
  SubmissionError,
  confirmOwnLine,
  declineParticipation,
  readSubmissionState,
  resolveRespondingParty,
  reviseOwnLine,
  submitStatement,
  withdrawOwnLine,
  type RespondingParty,
  type SubmissionState,
} from "../../../../server/participation/submission";

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

const badToken: ActionResult<never> = {
  ok: false,
  code: "bad_token",
  message:
    "This link is not one this machine issued, or it has expired. Ask for a " +
    "fresh one — anything you have already submitted is untouched.",
};

/**
 * Resolve the token, run the work, normalize the failures.
 *
 * The token is re-checked here rather than trusted from the page that rendered
 * the form: a page is a snapshot, and by the time a form comes back the link may
 * have been re-issued or expired.
 */
function withParty<T>(
  token: string,
  work: (db: Db, party: RespondingParty) => T,
): ActionResult<T> {
  const db = getDb();
  const party = resolveRespondingParty(db, token);
  if (party === null) return badToken;

  try {
    const data = work(db, party);
    revalidatePath(`/respond/${token}/submit`);
    return { ok: true, data };
  } catch (cause) {
    if (
      cause instanceof SubmissionError ||
      cause instanceof WorkbenchError ||
      cause instanceof ClarificationError
    ) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}

const lineSchema = z.object({
  evidenceId: z.string().min(1),
  utteranceId: z.string().min(1),
});

const badRequest: ActionResult<never> = {
  ok: false,
  code: "bad_request",
  message: "That request did not arrive intact. Reload the page and try again.",
};

/* -------------------------------------------------------------------------- */
/* Her side of it                                                             */
/* -------------------------------------------------------------------------- */

const statementSchema = z.object({
  text: z.string().min(1).max(MAX_STATEMENT_CHARS),
  note: z.string().max(2_000).nullable().optional(),
});

/**
 * Submit her account, in her own words.
 *
 * Returns the whole screen state rather than just the new rows: submitting also
 * writes a consent event and moves the participation the case shows, and a
 * screen that updated only the list would be showing her a smaller act than the
 * one she performed.
 */
export async function submitStatementAction(
  token: string,
  input: unknown,
): Promise<ActionResult<SubmissionState>> {
  const parsed = statementSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message:
        parsed.error.issues.some((issue) => issue.code === "too_big")
          ? `That is longer than one submission can carry (${MAX_STATEMENT_CHARS} characters). Send it in parts — nothing is lost by doing so.`
          : "There is nothing to submit yet. Write what happened in your own words.",
    };
  }

  return withParty(token, (db, party) => {
    submitStatement(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      text: parsed.data.text,
      note: parsed.data.note ?? null,
    });
    return readSubmissionState(db, party.participant.caseId, party.participant.id);
  });
}

/** Stand behind one line as written. Only then may anything downstream quote it. */
export async function confirmLineAction(
  token: string,
  input: unknown,
): Promise<ActionResult<WorkbenchUtterance>> {
  const parsed = lineSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) =>
    confirmOwnLine(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      ...parsed.data,
    }),
  );
}

/** Rewrite one line. Still hers, still citable once she stands behind it. */
export async function saveLineAction(
  token: string,
  input: unknown,
): Promise<ActionResult<WorkbenchUtterance>> {
  const parsed = lineSchema.extend({ text: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) =>
    reviseOwnLine(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      ...parsed.data,
    }),
  );
}

/** Take one line back before anything cites it. The text stays for the audit trail. */
export async function withdrawLineAction(
  token: string,
  input: unknown,
): Promise<ActionResult<WorkbenchUtterance>> {
  const parsed = lineSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) =>
    withdrawOwnLine(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      ...parsed.data,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* The clarification round                                                    */
/* -------------------------------------------------------------------------- */

const clarificationSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(4_000),
});

/**
 * Answer one clarification question.
 *
 * The round is not taken from the request. `answerOwnClarification` re-derives
 * which round is hers from the database, because a round id in a form post is a
 * claim about whose answers those are, and clarification answers are author-only
 * (doc 05 §A.3). The ≤3×3 budget is the FSM's, unchanged and uncounted here
 * (HARD RULE #4).
 */
export async function answerClarificationAction(
  token: string,
  input: unknown,
): Promise<ActionResult<OwnClarification>> {
  const parsed = clarificationSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) =>
    answerOwnClarification(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      ...parsed.data,
    }),
  );
}

const skipSchema = z.object({
  questionId: z.string().min(1),
  note: z.string().max(2_000).nullable().optional(),
});

/** Record that she is not answering one of them. A settled state, not a blank. */
export async function skipClarificationAction(
  token: string,
  input: unknown,
): Promise<ActionResult<OwnClarification>> {
  const parsed = skipSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) =>
    declineOwnClarification(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      questionId: parsed.data.questionId,
      note: parsed.data.note ?? null,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Declining                                                                  */
/* -------------------------------------------------------------------------- */

const declineSchema = z.object({
  reason: z.string().max(2_000).nullable().optional(),
});

/**
 * Record that she will not take part.
 *
 * A recorded outcome, not an exit: it changes what the case says about her, it
 * keeps her reason verbatim, and it deletes nothing she has already submitted.
 *
 * The screen that states the consequences in advance is `/respond/[token]/decline`,
 * and it is where the entry screen's third door goes. This action stays because
 * declining must remain reachable from inside her own intake — a person who has
 * started writing and changed her mind should not have to navigate back to a
 * screen she has left in order to say so.
 */
export async function declineAction(
  token: string,
  input: unknown,
): Promise<ActionResult<SubmissionState>> {
  const parsed = declineSchema.safeParse(input);
  if (!parsed.success) return badRequest;

  return withParty(token, (db, party) => {
    declineParticipation(db, {
      caseId: party.participant.caseId,
      participantId: party.participant.id,
      reason: parsed.data.reason ?? null,
    });
    return readSubmissionState(db, party.participant.caseId, party.participant.id);
  });
}
