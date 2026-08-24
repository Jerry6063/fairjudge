"use client";

// The clarification round, on screen.
//
// The budget is the visible thing here: the header says "round 2 of at most 3"
// because a person answering questions deserves to know how much of this is
// left, and because the number on screen is read from the same board the server
// counter is read from. The panel never decides anything — the "ask another
// round" button being enabled is a convenience, and the server refuses a fourth
// round whether or not this component thinks it is available.

import { useState, useTransition } from "react";

import type {
  ClarificationBoard,
  ClarificationQuestionView,
  ClarificationRoundView,
} from "../../../../server/pipeline";
import {
  answerClarificationQuestionAction,
  askClarificationRoundAction,
  markClarificationSaturatedAction,
} from "./actions";

export function ClarificationPanel({
  caseId,
  board,
}: {
  caseId: string;
  board: ClarificationBoard;
}) {
  const [rounds, setRounds] = useState<readonly ClarificationRoundView[]>(
    board.rounds,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, startAsking] = useTransition();

  const { maxRounds, maxQuestionsPerRound } = board.budget;
  const openRound = rounds.find((round) => round.open) ?? null;
  const closedRounds = rounds.filter((round) => !round.open);
  const roundsUsed = rounds.length;
  const canAskAnother = openRound === null && roundsUsed < maxRounds;
  const newestClosed = closedRounds[closedRounds.length - 1] ?? null;

  function replace(updated: ClarificationRoundView) {
    setRounds((current) =>
      current.map((round) => (round.id === updated.id ? updated : round)),
    );
  }

  function ask() {
    setError(null);
    setNotice(null);
    startAsking(async () => {
      const result = await askClarificationRoundAction(caseId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRounds((current) => [...current, result.data.round]);
      if (result.data.dropped > 0) {
        setNotice(
          `The stage offered ${result.data.asked + result.data.dropped} ` +
            `questions. The budget is ${maxQuestionsPerRound} a round, so the ` +
            `first ${result.data.asked} were kept and the rest were dropped.`,
        );
      } else if (result.data.asked === 0) {
        setNotice(
          "Nothing was left worth asking, so this round closed with no " +
            "questions. That is a real answer, and it spent a round.",
        );
      }
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium text-neutral-900">
            Clarification
          </h2>
          <p className="text-xs text-neutral-500">
            {openRound === null
              ? `${roundsUsed} of at most ${maxRounds} rounds used`
              : `Round ${openRound.roundNumber} of at most ${maxRounds}`}
          </p>
        </div>
        <p className="text-sm leading-relaxed text-neutral-600">
          At most {maxRounds} rounds of at most {maxQuestionsPerRound} questions.
          The limit is counted on the server, so it holds however the questions
          were produced. Answer in your own words — what you saw, heard, said or
          decided.
        </p>
      </header>

      {rounds.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          No round has been asked yet. The questions are written from the
          confirmed record of this case — nothing unconfirmed is visible to
          them.
        </p>
      )}

      {rounds.map((round) => (
        <Round
          key={round.id}
          caseId={caseId}
          round={round}
          maxRounds={maxRounds}
          isNewestClosed={newestClosed?.id === round.id}
          onUpdated={replace}
        />
      ))}

      {notice !== null && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
        {canAskAnother ? (
          <button
            type="button"
            disabled={asking}
            onClick={ask}
            className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {asking
              ? "Reading the record…"
              : roundsUsed === 0
                ? "Ask the first round"
                : `Ask round ${roundsUsed + 1}`}
          </button>
        ) : (
          <p className="text-xs text-neutral-500">
            {openRound !== null
              ? "Answer the questions above before asking for another round — " +
                "the next round is written from your answers."
              : `All ${maxRounds} rounds have been used. What is not known by ` +
                `now stays not known, and the analysis has to say so.`}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function Round({
  caseId,
  round,
  maxRounds,
  isNewestClosed,
  onUpdated,
}: {
  caseId: string;
  round: ClarificationRoundView;
  maxRounds: number;
  isNewestClosed: boolean;
  onUpdated: (round: ClarificationRoundView) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function markSaturated() {
    setError(null);
    startTransition(async () => {
      const result = await markClarificationSaturatedAction(
        caseId,
        round.id,
        !round.saturated,
      );
      if (result.ok) onUpdated(result.data);
      else setError(result.message);
    });
  }

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border p-4 ${
        round.open ? "border-amber-200 bg-white" : "border-neutral-200 bg-neutral-50"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-neutral-900">
          Round {round.roundNumber} of at most {maxRounds}
        </h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${
            round.open
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {round.open
            ? `${round.answered} of ${round.questions.length} answered`
            : "Closed"}
        </span>
      </header>

      {round.questions.length === 0 && (
        <p className="text-sm text-neutral-600">
          This round had nothing left worth asking.
        </p>
      )}

      {round.questions.map((question, at) => (
        <Question
          key={question.id}
          caseId={caseId}
          roundId={round.id}
          index={at + 1}
          question={question}
          locked={!round.open}
          onUpdated={onUpdated}
        />
      ))}

      {round.canProceed && (
        <p className="text-xs text-neutral-500">
          The stage reported that the record can carry the analysis after this
          round. Advisory — how many rounds run is the server&apos;s decision.
        </p>
      )}

      {isNewestClosed && (
        <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3">
          <label className="flex items-start gap-2 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={round.saturated}
              disabled={pending}
              onChange={markSaturated}
              className="mt-0.5"
            />
            <span>
              This round added nothing new — stop asking and move on. (You can
              say this at any point; it does not need the remaining rounds to be
              used up.)
            </span>
          </label>
          {error !== null && (
            <p role="alert" className="text-xs text-rose-700">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function Question({
  caseId,
  roundId,
  index,
  question,
  locked,
  onUpdated,
}: {
  caseId: string;
  roundId: string;
  index: number;
  question: ClarificationQuestionView;
  locked: boolean;
  onUpdated: (round: ClarificationRoundView) => void;
}) {
  const [draft, setDraft] = useState(question.answer ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await answerClarificationQuestionAction(
        caseId,
        roundId,
        question.id,
        draft,
      );
      if (result.ok) onUpdated(result.data);
      else setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3">
      <p className="text-sm leading-relaxed font-medium text-neutral-900">
        {index}. {question.question}
      </p>

      {question.targetsClaim !== null && (
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-neutral-600">
          <span className="mr-1 font-medium text-neutral-500">About:</span>
          {question.targetsClaim}
        </p>
      )}
      {question.whyNeeded !== null && (
        <p className="text-xs leading-relaxed text-neutral-600">
          <span className="mr-1 font-medium text-neutral-500">
            Why it is needed:
          </span>
          {question.whyNeeded}
        </p>
      )}

      {locked ? (
        <p className="rounded-lg bg-neutral-50 p-2 text-sm leading-relaxed whitespace-pre-wrap text-neutral-800">
          {question.answer ?? "(unanswered)"}
        </p>
      ) : (
        <>
          <textarea
            aria-label={`Answer to question ${index}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            disabled={pending}
            placeholder="In your own words."
            className="w-full resize-y rounded-lg border border-neutral-300 p-2 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || draft.trim() === ""}
              onClick={save}
              className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {pending ? "Saving…" : question.answer === null ? "Answer" : "Update"}
            </button>
            {question.answer !== null && (
              <span className="text-xs text-emerald-700">Answered</span>
            )}
          </div>
        </>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default ClarificationPanel;
