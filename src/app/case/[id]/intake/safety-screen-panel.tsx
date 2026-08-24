"use client";

// The intake safety questionnaire.
//
// The form is dumb by design: it collects answers and hands them to the server.
// It never decides anything, does not pre-judge an answer, and does not hide a
// question because an earlier one was `no` — a screen that branches is a screen
// that can be walked around.
//
// The one piece of behaviour it does own is the referral hand-off: when the
// server comes back `refer`, this renders a plain anchor to the referral page
// rather than a `next/link`, so the crisis path never depends on client-side
// navigation (HARD RULE #9).

import { useState, useTransition } from "react";

import type {
  SafetyChoice,
  SafetyQuestion,
} from "../../../../server/safety/questionnaire";
import { runIntakeSafetyScreenAction, type SafetyScreenSummary } from "./actions";

const CHOICE_LABEL: Readonly<Record<string, string>> = {
  yes: "Yes",
  no: "No",
  unsure: "I don't know",
};

export function SafetyScreenPanel({
  caseId,
  questions,
  choices,
}: {
  caseId: string;
  /** The screen as the server defines it — never rebuilt on the client. */
  questions: readonly SafetyQuestion[];
  choices: readonly SafetyChoice[];
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<SafetyScreenSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Every choice question answered. The free-text one is optional — a blank
  // "anything else" is a normal answer, and requiring prose would teach people
  // to type a full stop to get past it.
  const unanswered = questions.filter(
    (question) =>
      question.kind === "choice" &&
      (answers[question.id] ?? "").trim() === "",
  );

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await runIntakeSafetyScreenAction({ caseId, answers });
      if (result.ok) {
        setSummary(result.data);
      } else {
        setSummary(null);
        setError(result.message);
      }
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-neutral-900">
          Safety screening
        </h2>
        <p className="text-xs leading-relaxed text-neutral-600">
          These five questions run before anything is weighed. A deterministic
          rule set reads the answers and the confirmed material first; a model
          reads the same material afterwards, and only if the rules found
          nothing. Either layer firing sends this case to resources instead of a
          judgment.
        </p>
      </div>

      <ol className="flex flex-col gap-4">
        {questions.map((question, at) => (
          <li key={question.id} className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm text-neutral-900">
                <span className="mr-2 text-neutral-400">{at + 1}.</span>
                {question.text}
              </p>
              <p className="pl-6 text-xs text-neutral-500">{question.why}</p>
            </div>

            {question.kind === "choice" ? (
              <div className="flex flex-wrap gap-2 pl-6">
                {choices.map((choice) => {
                  const selected = answers[question.id] === choice;
                  return (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: choice,
                        }))
                      }
                      className={
                        selected
                          ? "rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white"
                          : "rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
                      }
                    >
                      {CHOICE_LABEL[choice] ?? choice}
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                aria-label={question.text}
                rows={3}
                value={answers[question.id] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                className="ml-6 rounded-lg border border-neutral-300 p-2 text-sm text-neutral-900"
              />
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
        <button
          type="button"
          disabled={pending || unanswered.length > 0}
          onClick={submit}
          className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {pending ? "Screening…" : "Run the safety screen"}
        </button>
        {unanswered.length > 0 && (
          <p className="text-xs text-neutral-500">
            {unanswered.length} question(s) still unanswered. &ldquo;I don&rsquo;t
            know&rdquo; is a real answer here and is treated as one.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
      </div>

      {summary !== null && (
        <div
          className={
            summary.decision === "refer"
              ? "flex flex-col gap-2 rounded-lg border border-rose-300 bg-rose-50 p-4"
              : "flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4"
          }
        >
          <p
            className={
              summary.decision === "refer"
                ? "text-sm font-medium text-rose-900"
                : "text-sm font-medium text-emerald-900"
            }
          >
            {summary.decision === "refer"
              ? "This case is referred, not judged."
              : "The screen found nothing that stops this case."}
          </p>
          <p className="text-xs leading-relaxed text-neutral-700">
            {summary.rationale}
          </p>
          <p className="text-xs text-neutral-500">
            Recorded outcome {summary.outcome} · risk level {summary.riskLevel} ·{" "}
            {summary.categories.length === 0
              ? "no category flagged"
              : `flagged: ${summary.categories.join(", ")}`}{" "}
            · {summary.screensWritten} screen row(s) written · model layer:{" "}
            {summary.modelLayer}
          </p>
          {summary.decision === "refer" && (
            <a
              href={`/case/${caseId}/referral`}
              className="w-fit rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-800"
            >
              Open the resources page
            </a>
          )}
        </div>
      )}
    </section>
  );
}

export default SafetyScreenPanel;
