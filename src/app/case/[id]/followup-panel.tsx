// The 7 / 30-day check-ins, on the case landing page (SPEC M4 ④).
//
// This panel exists because of the failure mode, not because of the feature. A
// follow-up that never fires produces no error, no notification and no empty
// state — it is simply a row nobody looked at. So the panel renders every
// check-in a case has, says out loud when one is overdue and by how long, and
// prints the reason on any whose generation failed. A check-in that did not
// happen is louder here than one that did.
//
// Nothing is decided in this file: `describeFollowup` in
// `server/followups/store.ts` derives the due state from the clock at read
// time, which is why there is no job that has to remember to mark things late.

import { getDb } from "../../../server/db";
import { FOLLOWUP_LABELS, listFollowups } from "../../../server/followups";
import type { FollowupQuestionSet, FollowupView } from "../../../server/followups";

const BADGE: Readonly<Record<FollowupView["dueState"], string>> = {
  upcoming: "border-neutral-200 bg-neutral-50 text-neutral-600",
  due: "border-sky-200 bg-sky-50 text-sky-900",
  overdue: "border-amber-300 bg-amber-50 text-amber-900",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  skipped: "border-neutral-200 bg-neutral-50 text-neutral-500",
};

const BADGE_TEXT: Readonly<Record<FollowupView["dueState"], string>> = {
  upcoming: "Scheduled",
  due: "Due now",
  overdue: "Overdue",
  completed: "Answered",
  skipped: "Skipped",
};

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Best-effort read of the stored question set; never throws in a render. */
function readQuestions(value: unknown): FollowupQuestionSet | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<FollowupQuestionSet>;
  return Array.isArray(candidate.questions) ? (candidate as FollowupQuestionSet) : null;
}

export function FollowupPanel({ caseId }: { caseId: string }) {
  const followups = listFollowups(getDb(), caseId);
  if (followups.length === 0) return null;

  const overdue = followups.filter((f) => f.dueState === "overdue");

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-neutral-900">Follow-up check-ins</h2>
        <p className="text-xs text-neutral-600">
          {overdue.length === 0
            ? "What was committed to, checked against what actually happened."
            : `${overdue.length} check-in${overdue.length === 1 ? " is" : "s are"} overdue.`}
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {followups.map((followup) => {
          const questions = readQuestions(followup.questions);
          return (
            <li
              key={followup.id}
              className={`flex flex-col gap-2 rounded-lg border p-3 ${BADGE[followup.dueState]}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs font-medium">
                  {FOLLOWUP_LABELS[followup.kind]}
                </span>
                <span className="text-xs uppercase">{BADGE_TEXT[followup.dueState]}</span>
                <span className="text-xs opacity-80">
                  due {formatDate(followup.scheduledAt)}
                  {followup.overdueByDays > 0 &&
                    ` — ${followup.overdueByDays} day${followup.overdueByDays === 1 ? "" : "s"} ago`}
                </span>
              </div>

              {followup.needsAttention && (
                <p className="text-xs">
                  {followup.generationStatus === "submitted"
                    ? "The questions were sent for generation and have not come back yet."
                    : followup.generationStatus === "failed"
                      ? "Generating the questions failed and will not be retried automatically."
                      : "The questions have not been generated yet — the next scheduler run picks this up."}
                </p>
              )}

              {followup.lastError !== null && (
                <p className="font-mono text-[11px] leading-relaxed break-words opacity-90">
                  {followup.lastError}
                </p>
              )}

              {questions !== null && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs">{questions.opening}</p>
                  <ol className="flex list-decimal flex-col gap-1 pl-4">
                    {questions.questions.map((question) => (
                      <li key={question.question_id} className="text-xs">
                        {question.question}
                        <span className="ml-1 opacity-70">
                          ({question.asks_about.replace(/_/g, " ")})
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
