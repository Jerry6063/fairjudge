// /case/[id]/[stage] — the empty content slot, one per stage.
//
// This is the fallback segment. Next.js prefers a STATIC segment over a dynamic
// one at the same level, so an agent building a stage creates
// `src/app/case/[id]/<stage>/page.tsx` and it silently takes over this route —
// no shared file to edit, no link to register, and the stepper's links keep
// working the whole way through. Until then the slot renders what the stage is
// for and what it needs, which is genuinely all this page can honestly say.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { CASE_STAGES, type CaseStage } from "../../../../server/db/schema";
import {
  STAGE_META,
  StageMachineError,
  collectCaseFacts,
  requirementsFor,
  type CaseFacts,
} from "../../../../server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stages whose workspace already exists elsewhere in the app (M2). These are
 * links, not redirects: the case shell stays on screen around them.
 */
const EXISTING_WORKSPACE: Readonly<
  Partial<Record<CaseStage, { readonly href: string; readonly label: string }>>
> = {
  evidence_intake: { href: "/evidence", label: "Open material registration" },
  transcription: {
    href: "/evidence",
    label: "Open the transcription workbench",
  },
  timeline: { href: "/timeline", label: "Open the timeline" },
};

function isCaseStage(value: string): value is CaseStage {
  return (CASE_STAGES as readonly string[]).includes(value);
}

export default async function CaseStagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  if (!isCaseStage(stage)) notFound();

  let facts: CaseFacts;
  try {
    facts = collectCaseFacts(getDb(), id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  const meta = STAGE_META[stage];
  const requirements = requirementsFor(facts, stage);
  const unmet = requirements.filter((r) => !r.satisfied);
  const reached =
    CASE_STAGES.indexOf(facts.stage) >= CASE_STAGES.indexOf(stage);
  const workspace = EXISTING_WORKSPACE[stage];

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Stage {meta.index}
        </p>
        <h2 className="text-lg font-medium text-neutral-900">{meta.title}</h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          {meta.purpose}
        </p>
      </div>

      {workspace !== undefined ? (
        <Link
          href={workspace.href}
          className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          {workspace.label}
        </Link>
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          This stage has no workspace on screen yet. When it is built it appears
          right here, inside this shell.
        </p>
      )}

      {!reached && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          The case has not reached this stage yet, so nothing here is live. What
          it is waiting for is listed below.
        </p>
      )}

      {requirements.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
          <p className="text-xs font-medium text-neutral-500">
            {unmet.length === 0
              ? "What this stage needed — all met"
              : `What this stage still needs — ${unmet.length} outstanding`}
          </p>
          <ul className="flex flex-col gap-1">
            {requirements.map((requirement) => (
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
        </div>
      )}

      <Link
        href={`/case/${id}`}
        className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        Back to the case overview
      </Link>
    </section>
  );
}
