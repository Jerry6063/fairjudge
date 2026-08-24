// /case/[id]/issue_framing — the three lists (SPEC M3 wave A ⑤).
//
// A static segment at the same level as `[stage]`, so Next.js prefers it and
// this workspace takes over the slot the shell was rendering a placeholder in.
// Everything on screen is read out of `server/pipeline`; the page decides
// nothing.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  listIssues,
  requirementsFor,
  type CaseFacts,
  type IssueBoard,
} from "../../../../server/pipeline";
import { IssueLists } from "./issue-lists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function IssueFramingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let facts: CaseFacts;
  let board: IssueBoard;
  try {
    const db = getDb();
    facts = collectCaseFacts(db, id);
    board = listIssues(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  const meta = STAGE_META.issue_framing;
  const unmet = requirementsFor(facts, "issue_framing").filter(
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
          Before anything is judged, the case is sorted into what is agreed, what
          is disputed as fact, and what is disputed as standard. Every item has
          to point at a confirmed line — an item that cannot be pointed at does
          not go on a list.
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

      <IssueLists caseId={id} initial={board} />

      <Link
        href={`/case/${id}`}
        className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        Back to the case overview
      </Link>
    </section>
  );
}
