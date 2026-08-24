// /case/[id] — the case shell.
//
// One frame around the whole pipeline: the nine-stage stepper on the left, the
// stage's own workspace on the right. Every stage route segment under
// `/case/[id]/…` renders into that slot, so an agent building a stage adds one
// folder and gets the stepper, the header and the blocker panel for free.
//
// The shell reads the database directly (server component) and asks
// `server/pipeline` what the case's situation is. It renders that answer and
// never computes its own: if the stepper and the state machine could disagree,
// the UI would be inventing preconditions, which is exactly what the machine
// exists to prevent.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { getDb } from "../../../server/db";
import {
  StageMachineError,
  collectCaseFacts,
  describePipeline,
  type CaseFacts,
} from "../../../server/pipeline";
import { cases } from "../../../server/db/schema";
import { eq } from "drizzle-orm";
import { StageStepper } from "./stage-stepper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Badge copy for the derived output level (HARD RULE #2 — code decides it). */
const LEVEL_LABEL: Readonly<Record<string, string>> = {
  L1: "L1 · full judgment",
  L2: "L2 · one-sided perspective analysis",
  L3: "L3 · narrative analysis only",
  refused: "Refused",
};

export default async function CaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let facts: CaseFacts;
  let title: string | null;
  try {
    const db = getDb();
    facts = collectCaseFacts(db, id);
    title =
      db.select({ title: cases.title }).from(cases).where(eq(cases.id, id)).get()
        ?.title ?? null;
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    return (
      <Shell>
        <div
          role="alert"
          className="fj-lead-rule flex flex-col gap-2 border-l-refusal-rule"
        >
          <p className="text-app font-medium text-refusal-ink">
            Cannot open the local database. Check FAIRJUDGE_DB_KEY in .env.local,
            or run npm run seed:import to create it.
          </p>
          <p className="fj-ledger text-app-sm break-all text-refusal-ink">
            {cause instanceof Error ? cause.message : String(cause)}
          </p>
        </div>
      </Shell>
    );
  }

  const stages = describePipeline(facts);

  return (
    <Shell>
      <header className="flex flex-col gap-2">
        <Link href="/" className="fj-key fj-link w-fit">
          ← Home
        </Link>
        <h1 className="text-app-title text-ink-1">{title ?? "Case"}</h1>
        <div className="fj-key flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Output level:{" "}
            {facts.outputLevel === null
              ? "not locked yet"
              : (LEVEL_LABEL[facts.outputLevel] ?? facts.outputLevel)}
          </span>
          {facts.downgradeSignal && (
            <span className="text-grade-ink">Downgrade signal recorded</span>
          )}
          {facts.safety.refused && (
            // A plain anchor, not `next/link`: the referral page is the one
            // route in this product that has to work with no client-side
            // JavaScript and nothing prefetched (HARD RULE #9).
            <a
              href={`/case/${id}/referral`}
              className="fj-link text-refusal-ink"
            >
              Safety refusal — open the referral page
            </a>
          )}
        </div>
      </header>

      <div className="grid gap-12 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <nav aria-label="Case stages" className="flex flex-col gap-2">
          <h2 className="fj-eyebrow">The nine stages</h2>
          <StageStepper caseId={id} stages={stages} />
        </nav>

        <div className="flex min-w-0 flex-col gap-4">{children}</div>
      </div>

      <footer className="fj-rule-top mt-auto pt-5">
        <p className="fj-key max-w-[var(--measure-apparatus)]">
          A stage advances on facts in the database — confirmed lines, settled
          participation, acknowledged adverse facts — never on anything a model
          says. The stepper shows what each stage needs; the server refuses the
          move until it is there.
        </p>
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  // Paper, pinned explicitly so the page stays light under a dark UA color
  // scheme. `.fj-page` is the token layer's ground: paper behind, apparatus
  // sans in front (globals.css). The shell is apparatus in full — it names the
  // case and the stages and never speaks for the judgment — so nothing in this
  // frame is ever set in the document voice.
  return (
    <main className="fj-page min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 sm:p-10">
        {children}
      </div>
    </main>
  );
}
