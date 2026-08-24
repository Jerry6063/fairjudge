"use client";

// The counterparty's submission screen (SPEC M5 ②, the write half).
//
// Three things happen here and nothing else: she writes her side, she stands
// behind each line of it, or she says she will not take part. The screen shows
// none of the client's material and none of the judgment — this is the write
// path, and what the case holds about her is the transparency view's subject.
//
// The confirmation is the same ConfirmCard the client's evidence workbench uses,
// on purpose. Her lines are unconfirmed when they arrive and uncitable until she
// says otherwise, exactly as his are (HARD RULE #1); giving her a softer path to
// the same status would make the rule a property of which screen you came from.
//
// Her words are evidence: they render exactly as she typed them, in her own
// language, and nothing here rewrites or translates them.

import { useState, useTransition } from "react";

import ConfirmCard from "../../../../components/ConfirmCard";
import type { ActionResult } from "../../../../lib/action-result";
import type { WorkbenchUtterance } from "../../../../server/evidence/workbench";
import type { OwnClarification } from "../../../../server/participation/clarification";
import type {
  OwnSubmission,
  SubmissionState,
} from "../../../../server/participation/submission";
import {
  answerClarificationAction,
  confirmLineAction,
  declineAction,
  saveLineAction,
  skipClarificationAction,
  submitStatementAction,
  withdrawLineAction,
} from "./actions";

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

const CARD_LABELS = {
  confirm: "This is what I meant",
  edit: "Reword it",
  reject: "Take it out",
  rejectArmed: "Yes, take it out",
  draft: "As submitted",
  emptyDraft: "(this line is empty)",
  rejectedNote:
    "Taken out. Nothing in this case can quote it now, and it cannot be changed back. It is still on file — taken out is not deleted.",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Turn a refused action into a thrown error so ConfirmCard shows it inline. */
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "That did not go through. Please try again.";
}

function replaceLine(
  submissions: readonly OwnSubmission[],
  row: WorkbenchUtterance,
): OwnSubmission[] {
  return submissions.map((submission) => {
    if (submission.evidenceId !== row.evidenceId) return submission;
    const lines = submission.lines.map((line) =>
      line.id === row.id ? row : line,
    );
    return {
      ...submission,
      lines,
      confirmedLines: lines.filter(
        (line) =>
          line.confirmStatus === "confirmed" || line.confirmStatus === "edited",
      ).length,
      pendingLines: lines.filter((line) => line.confirmStatus === "pending")
        .length,
    };
  });
}

function countConfirmed(submissions: readonly OwnSubmission[]): number {
  return submissions.reduce((sum, item) => sum + item.confirmedLines, 0);
}

function countLines(submissions: readonly OwnSubmission[]): number {
  return submissions.reduce((sum, item) => sum + item.lines.length, 0);
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export function SubmitPanel({
  token,
  state,
  clarification,
  declineHref,
  declineFirst = false,
}: {
  token: string;
  state: SubmissionState;
  /** The round waiting on her, if the case has one. Never another party's. */
  clarification: OwnClarification;
  /** The decline screen, which states the consequences before the act. */
  declineHref: string;
  /**
   * She arrived through the entry screen's "decline" door
   * (`/respond/[token]/submit?answer=decline`). The section is opened and
   * focused; the button is still hers to press.
   */
  declineFirst?: boolean;
}) {
  const [current, setCurrent] = useState(state);
  const [round, setRound] = useState(clarification);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [pending, startTransition] = useTransition();

  const declined = current.respondState === "declined";
  // "Done" is a state about the record, not about effort: her account is in,
  // every line of it is settled, and the case record holds it.
  const settled =
    current.totalLines > 0 &&
    current.confirmedLines > 0 &&
    current.submissions.every((item) => item.pendingLines === 0) &&
    current.caseRecordConsent === "granted";

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await submitStatementAction(token, { text });
      if (result.ok) {
        setCurrent(result.data);
        setText("");
      } else {
        setError(result.message);
      }
    });
  }

  function decline() {
    setError(null);
    startTransition(async () => {
      const result = await declineAction(token, {
        reason: reason.trim() === "" ? null : reason,
      });
      if (result.ok) {
        setCurrent(result.data);
        setArmed(false);
      } else {
        setError(result.message);
      }
    });
  }

  /** Run one line action and let the row the server wrote replace the local one. */
  async function runLine(
    id: string,
    action: () => Promise<ActionResult<WorkbenchUtterance>>,
  ) {
    setRowErrors((previous) => ({ ...previous, [id]: null }));
    try {
      const row = unwrap(await action());
      setCurrent((previous) => {
        const submissions = replaceLine(previous.submissions, row);
        return {
          ...previous,
          submissions,
          totalLines: countLines(submissions),
          confirmedLines: countConfirmed(submissions),
        };
      });
    } catch (cause) {
      setRowErrors((previous) => ({ ...previous, [id]: messageOf(cause) }));
      throw cause;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* What this screen does with what she writes. Said before she writes it. */}
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          Your side, in your own words
        </h2>
        <p className="text-xs leading-relaxed text-neutral-600">
          You are {current.pseudonym} in this case — that is the only name any
          analysis ever uses. Write in whatever language you think in; what you
          write is stored exactly as you type it and is never translated or
          rewritten.
        </p>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-neutral-600">
          <li>
            What you submit is <strong>yours, and private by default</strong>.
            The other party is given no permission to read it — that is a
            separate choice of yours, recorded with a timestamp, and nothing on
            this page makes it for you.
          </li>
          <li>
            Submitting does one thing: it lets this case take your account into
            account. That permission is recorded as an event with a timestamp,
            and you can withdraw it later.
          </li>
          <li>
            Nothing you write can be quoted by any analysis until you confirm it,
            line by line, below — the same rule the other party&apos;s material is
            held to.
          </li>
        </ul>
      </section>

      {declined && (
        <section className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-medium text-amber-900">
            You have told this case you will not take part
          </h2>
          {current.declineReason !== null && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-amber-900">
              {current.declineReason}
            </p>
          )}
          <p className="text-xs leading-relaxed text-amber-800">
            That is recorded as your own answer, and nothing you had already
            submitted was deleted. If you change your mind, writing something
            below is enough — the record will then say you responded.
          </p>
        </section>
      )}

      {/* The write itself. */}
      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
        <label
          htmlFor="statement"
          className="text-sm font-medium text-neutral-900"
        >
          What happened, from where you stand
        </label>
        <p className="text-xs leading-relaxed text-neutral-600">
          One thought per line. Each line becomes something you can confirm,
          reword or take out on its own.
        </p>
        <textarea
          id="statement"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          disabled={pending}
          className="w-full resize-y rounded-lg border border-neutral-300 p-3 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending || text.trim() === ""}
            onClick={submit}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {pending ? "Saving…" : "Submit this"}
          </button>
          <span className="text-xs text-neutral-500">
            You can submit more than once.
          </span>
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
      </section>

      {/* Confirmation — the same discipline the other party's material goes through. */}
      <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-neutral-900">
            What you have submitted
          </h2>
          <p className="text-xs leading-relaxed text-neutral-600">
            {current.totalLines === 0
              ? "Nothing yet."
              : `${current.confirmedLines} of ${current.totalLines} line(s) confirmed. Only confirmed lines can be quoted by any analysis of this case — the same rule applies to everything the other party submitted.`}
          </p>
        </div>

        {current.submissions.map((submission) => (
          <div key={submission.evidenceId} className="flex flex-col gap-3">
            <p className="text-xs text-neutral-500">
              Submitted{" "}
              {new Date(submission.submittedAt).toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
            {submission.lines.map((line, index) => (
              <ConfirmCard
                key={line.id}
                heading={
                  <span className="text-xs text-neutral-500">
                    Line {index + 1}
                  </span>
                }
                aiDraft={line.aiDraft}
                humanFinal={line.humanFinal}
                status={line.confirmStatus}
                labels={CARD_LABELS}
                disabled={pending}
                error={rowErrors[line.id] ?? null}
                onConfirm={() =>
                  runLine(line.id, () =>
                    confirmLineAction(token, {
                      evidenceId: submission.evidenceId,
                      utteranceId: line.id,
                    }),
                  )
                }
                onSave={(next) =>
                  runLine(line.id, () =>
                    saveLineAction(token, {
                      evidenceId: submission.evidenceId,
                      utteranceId: line.id,
                      text: next,
                    }),
                  )
                }
                onReject={() =>
                  runLine(line.id, () =>
                    withdrawLineAction(token, {
                      evidenceId: submission.evidenceId,
                      utteranceId: line.id,
                    }),
                  )
                }
              />
            ))}
          </div>
        ))}
      </section>

      {/* The clarification round: the same ≤3×3 budget the other party's
          intake runs on, and never their round. */}
      <ClarificationSection
        token={token}
        round={round}
        onChange={setRound}
        pending={pending}
        startTransition={startTransition}
        onError={setError}
      />

      {/* Done — what is now true, and what happens next. */}
      {settled && !declined && <DoneSection round={round} />}

      {/* Declining — an answer, not an exit. */}
      <section
        id="decline"
        className={
          declineFirst
            ? "flex flex-col gap-3 rounded-xl border border-neutral-900 bg-white p-5"
            : "flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5"
        }
      >
        <h2 className="text-sm font-medium text-neutral-900">
          {declineFirst
            ? "Saying you will not take part"
            : "Or say you will not take part"}
        </h2>
        <p className="text-xs leading-relaxed text-neutral-600">
          This is a real answer and it is recorded as yours. The case will say
          you were asked and declined, rather than leaving your absence
          unexplained. It deletes nothing — anything you already submitted stays
          on file under the permissions you gave it.{" "}
          <a href={declineHref} className="underline underline-offset-2">
            The full list of what declining does
          </a>{" "}
          is on its own screen, stated before you decide.
        </p>
        <label htmlFor="decline-reason" className="text-xs text-neutral-600">
          A reason, if you want to give one. It is kept word for word, and giving
          none is a complete answer.
        </label>
        <textarea
          id="decline-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          disabled={pending}
          autoFocus={declineFirst}
          className="w-full resize-y rounded-lg border border-neutral-300 p-3 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
        />
        <div className="flex flex-wrap items-center gap-2">
          {armed ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={decline}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
              >
                {pending ? "Recording…" : "Record that I decline"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setArmed(false)}
                className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-neutral-800"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => setArmed(true)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
            >
              I do not want to take part
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The clarification round                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the record still cannot settle, asked of her, inside the same budget.
 *
 * The budget is printed rather than hidden, because a person answering questions
 * about her own relationship is entitled to know how many more there can be: ≤3
 * rounds of ≤3 questions for this case, counted in server code (HARD RULE #4).
 * Every question carries "I would rather not answer this" beside it — a settled
 * state, not a blank, and nothing downstream may read the note as if it were her
 * reply.
 */
function ClarificationSection({
  token,
  round,
  onChange,
  pending,
  startTransition,
  onError,
}: {
  token: string;
  round: OwnClarification;
  onChange: (next: OwnClarification) => void;
  pending: boolean;
  startTransition: (fn: () => void) => void;
  onError: (message: string | null) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  function run(action: () => Promise<ActionResult<OwnClarification>>) {
    onError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) onChange(result.data);
      else onError(result.message);
    });
  }

  const open = round.round;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-neutral-900">
          Questions about what you wrote
        </h2>
        <p className="text-xs leading-relaxed text-neutral-600">
          When something in the record cannot be settled from what is on file,
          this case may ask — at most {round.budget.maxQuestionsPerRound}{" "}
          questions at a time, and at most {round.budget.maxRounds} rounds in
          total for the whole case. {round.roundsUsed} of {round.budget.maxRounds}{" "}
          have been used. That ceiling is counted by the program, not decided by
          it, so there is no version of this that keeps asking.
        </p>
        <p className="text-xs leading-relaxed text-neutral-600">
          What you write here is yours permanently: the other party never reads
          your answers. What can reach them is a statement about the case that
          your answer supports, quoted with where it came from.
        </p>
      </div>

      {open === null ? (
        <p className="text-sm leading-relaxed text-neutral-700">
          {round.otherRoundOpen
            ? "There is nothing waiting for you. A round is open on this case, and it is not addressed to you — you are not being asked to answer somebody else's questions, and you are not shown them."
            : "There is nothing waiting for you. Nothing is overdue and nothing is being held up by you."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {open.questions.map((question, index) => {
            const settled = question.answer !== null || question.declined;
            return (
              <article
                key={question.id}
                className={`flex flex-col gap-2 rounded-lg border p-4 ${
                  settled ? "border-neutral-200 bg-neutral-50" : "border-amber-200 bg-white"
                }`}
              >
                <p className="text-xs text-neutral-500">
                  Question {index + 1} of {open.questions.length}
                </p>
                <p className="text-sm leading-relaxed text-neutral-900">
                  {question.question}
                </p>
                {question.whyNeeded !== null && (
                  <p className="text-xs leading-relaxed text-neutral-600">
                    Why it is being asked: {question.whyNeeded}
                  </p>
                )}

                {question.declined ? (
                  <p className="text-xs text-neutral-600">
                    You said you are not answering this one. The round still
                    closes and nothing is inferred from it.
                  </p>
                ) : question.answer !== null ? (
                  <blockquote className="border-l-2 border-neutral-300 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-neutral-900">
                    {question.answer}
                  </blockquote>
                ) : (
                  <>
                    <textarea
                      aria-label={`Answer to question ${index + 1}`}
                      value={drafts[question.id] ?? ""}
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [question.id]: event.target.value,
                        }))
                      }
                      rows={3}
                      disabled={pending}
                      className="w-full resize-y rounded-lg border border-neutral-300 p-2 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={pending || (drafts[question.id] ?? "").trim() === ""}
                        onClick={() =>
                          run(() =>
                            answerClarificationAction(token, {
                              questionId: question.id,
                              answer: drafts[question.id] ?? "",
                            }),
                          )
                        }
                        className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
                      >
                        {pending ? "Saving…" : "Answer this"}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            skipClarificationAction(token, {
                              questionId: question.id,
                              note: null,
                            }),
                          )
                        }
                        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
                      >
                        I would rather not answer this
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Done                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The end of her intake, said as facts about the record.
 *
 * The last sentence is the one doc 05 §A.1 makes a design rule: a re-hearing is
 * offered rather than auto-fired, and when one is filed the new version reaches
 * both parties at the same moment. Sequential unlock manufactures exactly the
 * grievance a judgment exists to retire — one person reading first and preparing
 * a rebuttal — so the simultaneity is promised here, on the screen of the person
 * who would otherwise be second.
 */
function DoneSection({ round }: { round: OwnClarification }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-300 bg-neutral-50 p-5">
      <h2 className="text-sm font-medium text-neutral-900">
        Your side is in the record
      </h2>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-neutral-800">
        <li>
          Everything you submitted is confirmed by you, which is what makes it
          quotable at all. Nothing unconfirmed can be cited by anything.
        </li>
        <li>
          It is still yours and still private. The other party has not been given
          permission to read it, and nothing here has given it on your behalf.
        </li>
        <li>
          {round.round === null
            ? "There is no question waiting for you."
            : "There are still questions waiting for you above."}
        </li>
      </ul>
      <p className="text-sm leading-relaxed text-neutral-800">
        Nothing is re-run automatically. If a re-hearing is filed — by either of
        you — the new version is released to both of you at the same time.
        Neither of you reads it first, and neither of you gets to prepare a reply
        to it before the other has seen it.
      </p>
      <p className="text-xs leading-relaxed text-neutral-600">
        You can add more at any time, change your mind about taking part, or
        delete what you submitted. None of those is a deadline and none of them
        expires.
      </p>
    </section>
  );
}

export default SubmitPanel;
