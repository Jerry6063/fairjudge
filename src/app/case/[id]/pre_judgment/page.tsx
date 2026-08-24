// /case/[id]/pre_judgment — the adverse-fact confrontation (SPEC M3 wave A ⑥).
//
// A static segment beside `[stage]`, so this workspace replaces the shell's
// placeholder for stage 8. The gate it renders is read from the same function
// the stage machine and the judgment runner read — the page reports the answer,
// it never computes one.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  listAdverseFacts,
  requirementsFor,
  type AdverseFactBoard,
  type CaseFacts,
} from "../../../../server/pipeline";
import { AdverseFactsPanel } from "./adverse-facts-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PreJudgmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let facts: CaseFacts;
  let board: AdverseFactBoard;
  try {
    const db = getDb();
    facts = collectCaseFacts(db, id);
    board = listAdverseFacts(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  const meta = STAGE_META.pre_judgment;
  const unmet = requirementsFor(facts, "pre_judgment").filter(
    (requirement) => !requirement.satisfied,
  );

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Stage {meta.index}
        </p>
        <h2 className="text-lg font-medium text-neutral-900">{meta.title}</h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          The facts in your own material that count against you, put in front of
          you before anything is judged.
        </p>
      </div>

      {unmet.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            This stage is not fully supported yet.
          </p>
          <ul className="flex flex-col gap-1">
            {unmet.map((requirement) => (
              <li key={requirement.id} className="text-xs text-amber-800">
                {requirement.blocker}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AdverseFactsPanel caseId={id} initial={board} />

      <Link
        href={`/case/${id}`}
        className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        Back to the case overview
      </Link>
    </section>
  );
}
