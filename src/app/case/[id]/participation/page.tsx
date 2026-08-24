// /case/[id]/participation — stage ⑥, counterparty participation.
//
// A static segment at the same position as `[stage]`, so Next.js prefers it and
// this workspace replaces the empty slot. The shell comes from the layout above.
//
// The whole stage is one recorded answer, and the reason it is a stage of its
// own is that the answer changes what the pipeline is allowed to produce: it is
// one of the three inputs to `deriveOutputLevel`, and issue fixing does not open
// until it exists.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { CASE_STAGES } from "../../../../server/db/schema";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  readParticipation,
  requirementsFor,
  type CaseFacts,
} from "../../../../server/pipeline";
import { ParticipationPanel } from "./participation-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ParticipationStagePage({
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

  const meta = STAGE_META.participation;
  const board = readParticipation(db, id);
  const exitRequirements = requirementsFor(facts, "issue_framing");
  const reached =
    CASE_STAGES.indexOf(facts.stage) >= CASE_STAGES.indexOf("participation");

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
            The case has not reached this stage yet. The answer can still be
            recorded — it is a fact about the process, not a result of the
            stages before it.
          </p>
        )}
      </section>

      <ParticipationPanel caseId={id} board={board} />

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
