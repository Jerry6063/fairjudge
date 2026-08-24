// /case/[id]/intake — stage ①, intake and safety screening.
//
// A static segment at the same position as `[stage]`, so Next.js prefers it and
// this workspace replaces the empty slot. The shell (stepper, header, blockers)
// comes from the layout above.
//
// This is the screen that decides whether the case belongs in a judgment
// pipeline at all. Nothing on the page decides it: the questionnaire is
// collected by the panel, the verdict is reached in `server/safety/gate.ts`, and
// what is shown here afterwards is read back out of `safety_screens`.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { CASE_STAGES } from "../../../../server/db/schema";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  requirementsFor,
  type CaseFacts,
} from "../../../../server/pipeline";
import {
  SAFETY_CHOICES,
  SAFETY_QUESTIONS,
} from "../../../../server/safety/questionnaire";
import { listSafetyScreens } from "../../../../server/safety/screen-record";
import { SafetyScreenPanel } from "./safety-screen-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTCOME_BADGE: Readonly<Record<string, string>> = {
  clear: "border-emerald-200 bg-emerald-50 text-emerald-800",
  flagged: "border-amber-200 bg-amber-50 text-amber-800",
  refuse: "border-rose-200 bg-rose-50 text-rose-800",
};

export default async function IntakeStagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const db = getDb();
  let facts: CaseFacts;
  try {
    facts = collectCaseFacts(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  const meta = STAGE_META.intake;
  const screens = listSafetyScreens(db, id);
  // What entering the NEXT stage needs — for intake that is the screen itself.
  const exitRequirements = requirementsFor(facts, "evidence_intake");
  const past = CASE_STAGES.indexOf(facts.stage) > CASE_STAGES.indexOf("intake");

  return (
    <>
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Stage {meta.index}
        </p>
        <h2 className="text-lg font-medium text-neutral-900">{meta.title}</h2>
        <p className="text-sm leading-relaxed text-neutral-600">{meta.purpose}</p>
        {past && screens.length === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            This case moved past intake without a screen on record. Run one now:
            every later stage is written as though the screen happened, and the
            judgment has to be able to say when it did.
          </p>
        )}
      </section>

      <SafetyScreenPanel
        caseId={id}
        questions={SAFETY_QUESTIONS}
        choices={SAFETY_CHOICES}
      />

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          Screens on record
        </h2>
        {screens.length === 0 ? (
          <p className="text-xs text-neutral-500">
            None yet. A screen is a row, not a state of mind — until one exists,
            nothing downstream may treat this case as cleared.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {screens.map((screen) => (
              <li
                key={screen.id}
                className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      OUTCOME_BADGE[screen.outcome] ??
                      "border-neutral-200 bg-neutral-50 text-neutral-700"
                    }`}
                  >
                    {screen.outcome}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {screen.screenType} ·{" "}
                    {screen.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                  </span>
                  {screen.redFlags.length > 0 && (
                    <span className="text-xs text-rose-700">
                      {screen.redFlags.join(", ")}
                    </span>
                  )}
                </div>
                {screen.rationale !== null && (
                  <p className="text-xs leading-relaxed text-neutral-600">
                    {screen.rationale}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          What this stage has to produce before the case moves on
        </h2>
        <ul className="flex flex-col gap-2">
          {exitRequirements.map((requirement) => (
            <li key={requirement.id} className="text-xs leading-relaxed">
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
              <span
                className={
                  requirement.satisfied ? "text-neutral-500" : "text-neutral-800"
                }
              >
                {requirement.need}
              </span>
              {!requirement.satisfied && (
                <span className="block pl-4 text-amber-800">
                  {requirement.blocker}
                </span>
              )}
            </li>
          ))}
        </ul>
        <Link
          href={`/case/${id}`}
          className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
        >
          Back to the case overview
        </Link>
      </section>
    </>
  );
}
