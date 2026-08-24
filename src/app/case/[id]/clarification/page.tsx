// /case/[id]/clarification — stage ⑤, clarification and steelmanning.
//
// A static segment at the same position as `[stage]`, so Next.js prefers it and
// this workspace replaces the empty slot with no shared file to edit. The shell
// (stepper, header, blockers) comes from the layout above.
//
// Everything decided here is decided in `server/pipeline`: the budget, whether
// a round may be opened, whether the other side can be argued, and what the
// case still needs before it may move on. The page reads those answers and
// renders them. In particular the two exit requirements below are the stage
// machine's own objects — the same ones `canAdvance` refuses on — so the screen
// cannot promise a move the server would reject.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { CASE_STAGES } from "../../../../server/db/schema";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  readClarification,
  readSteelman,
  requirementsFor,
  type CaseFacts,
} from "../../../../server/pipeline";
import { ClarificationPanel } from "./clarification-panel";
import { SteelmanPanel } from "./steelman-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ClarificationStagePage({
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

  const meta = STAGE_META.clarification;
  const board = readClarification(db, id);
  const steelman = readSteelman(db, id);
  // What entering the NEXT stage needs. While a case is standing in this one,
  // the useful question is what it takes to leave.
  const exitRequirements = requirementsFor(facts, "participation");
  const reached =
    CASE_STAGES.indexOf(facts.stage) >= CASE_STAGES.indexOf("clarification");

  return (
    <>
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Stage {meta.index}
        </p>
        <h2 className="text-lg font-medium text-neutral-900">{meta.title}</h2>
        <p className="text-sm leading-relaxed text-neutral-600">{meta.purpose}</p>
        {!reached && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            The case has not reached this stage yet. Nothing here is blocked by
            that — every operation below checks its own preconditions — but the
            timeline it reads from is still being built.
          </p>
        )}
      </section>

      <ClarificationPanel caseId={id} board={board} />

      <SteelmanPanel caseId={id} board={steelman} />

      {steelman.downgradeSignal && (
        <section className="flex flex-col gap-1 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            A downgrade signal is recorded on this case
          </p>
          <p className="text-xs leading-relaxed text-amber-900">
            {steelman.downgradeReason ??
              "Something in this stage weakened what the record can support."}
          </p>
          <p className="text-xs text-amber-800">
            This does not stop the case. It is a fact about the record: the
            output level is derived from state like this one in code, and the
            judgment has to disclose it.
          </p>
        </section>
      )}

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
