// /case/[id] — the case landing panel inside the shell.
//
// Three questions, in the order a person actually asks them: where is this
// case, what is it waiting for, and what happens next. Everything on this page
// is read out of `server/pipeline` and `server/cases`; nothing is decided here.
//
// ## Why the wait comes first
//
// While the other party has not put anything of her own into the record, this
// page is the asymmetric-wait surface (doc 05 §A.2) and everything else on it is
// secondary. A person in that state opens this page to ask three questions —
// what is happening, what is not being shown to me, and what would change the
// case's level — and a stage stepper answers none of them. So `WaitPanel`
// renders above the pipeline machinery, and disappears the moment she owns
// confirmed material in the record: from then on the case is not waiting on
// anybody and the page has other things to say.

import Link from "next/link";
import { notFound } from "next/navigation";

import { buildWaitView, type WaitView } from "../../../server/cases/wait-view";
import { getDb } from "../../../server/db";
import {
  STAGE_META,
  StageMachineError,
  canAdvance,
  collectCaseFacts,
  nextStage,
  requirementsFor,
  type CaseFacts,
} from "../../../server/pipeline";
import { AdvanceControl } from "./advance-control";
import { FollowupPanel } from "./followup-panel";
import { WaitPanel } from "./wait-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let facts: CaseFacts;
  let wait: WaitView | null;
  try {
    const db = getDb();
    facts = collectCaseFacts(db, id);
    wait = buildWaitView(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  const current = STAGE_META[facts.stage];
  const currentRequirements = requirementsFor(facts, facts.stage);
  const target = nextStage(facts.stage);
  const decision = target === null ? null : canAdvance(facts, target);
  const unmet =
    decision === null ? [] : decision.requirements.filter((r) => !r.satisfied);

  return (
    <>
      {/* The wait surface, while there is a wait to describe: a second party
          exists and nothing of hers is confirmed in the record yet. */}
      {wait !== null && wait.stillOneSided && <WaitPanel view={wait} />}

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-col gap-1">
          <p className="text-xs tracking-wide text-neutral-500 uppercase">
            Stage {current.index} of 9
          </p>
          <h2 className="text-lg font-medium text-neutral-900">
            {current.title}
          </h2>
          <p className="text-sm leading-relaxed text-neutral-600">
            {current.purpose}
          </p>
        </div>

        <Link
          href={`/case/${id}/${facts.stage}`}
          className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100"
        >
          Open the {current.title.toLowerCase()} workspace
        </Link>

        {currentRequirements.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-neutral-100 pt-3">
            <p className="text-xs font-medium text-neutral-500">
              What this stage needed to start
            </p>
            <ul className="flex flex-col gap-1">
              {currentRequirements.map((requirement) => (
                <li key={requirement.id} className="text-xs text-neutral-600">
                  <span
                    aria-hidden
                    className={
                      requirement.satisfied
                        ? "mr-1 text-emerald-600"
                        : "mr-1 text-amber-600"
                    }
                  >
                    {requirement.satisfied ? "✓" : "•"}
                  </span>
                  {requirement.need}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">What is next</h2>

        {target === null || decision === null ? (
          <p className="text-sm text-neutral-600">
            This case is at the end of the pipeline.
          </p>
        ) : decision.allowed ? (
          <>
            <p className="text-sm text-neutral-600">
              Everything {STAGE_META[target].title.toLowerCase()} needs is in
              place.
            </p>
            <AdvanceControl
              caseId={id}
              target={target}
              targetTitle={STAGE_META[target].title}
              blocked={false}
            />
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-600">{decision.reason}</p>
            {unmet.length > 0 && (
              <ul className="flex flex-col gap-2">
                {unmet.map((requirement) => (
                  <li
                    key={requirement.id}
                    className="rounded-lg border border-amber-200 bg-amber-50 p-3"
                  >
                    <p className="text-xs font-medium text-amber-900">
                      {requirement.need}
                    </p>
                    <p className="text-xs text-amber-800">
                      {requirement.blocker}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {decision.code === "preconditions_unmet" && (
              <AdvanceControl
                caseId={id}
                target={target}
                targetTitle={STAGE_META[target].title}
                blocked
              />
            )}
          </>
        )}
      </section>

      {/* Renders nothing until a judgment has been frozen and its check-ins
          scheduled; from then on it is where an overdue follow-up shows up. */}
      <FollowupPanel caseId={id} />
    </>
  );
}
