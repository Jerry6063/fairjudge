// Timeline — pipeline stage ④.
//
// Server component: reads both lists straight from SQLite (synchronous
// better-sqlite3, no cache layer) and hands them to the drag surface. Rendering
// must stay dynamic — the database is opened with a key from the environment, so
// it can neither be read at build time nor cached across requests.

import Link from "next/link";

import { getDb } from "../../server/db";
import { loadTimeline, type TimelineSnapshot } from "../../server/domain/timeline";
import { TimelineBoard } from "./timeline-board";

export const dynamic = "force-dynamic";

export default function TimelinePage() {
  let snapshot: TimelineSnapshot | null = null;
  let failure: string | null = null;

  try {
    snapshot = loadTimeline(getDb());
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    // The cards are a light surface; pin the page background to match so the
    // headings stay readable under a dark UA color scheme.
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 sm:p-10">
        <header className="flex flex-col gap-2">
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
            ← Home
          </Link>
          <h1 className="text-2xl font-semibold text-neutral-900">Timeline</h1>
          <p className="text-sm text-neutral-600">
            Put the events in the order you remember them. Anything with a date
            anchor lands on the mainline; anything whose date you are unsure of
            waits on the right until you decide where it goes. Your drag is the
            final word on order, and it is saved immediately.
          </p>
          {snapshot?.caseTitle != null && snapshot.caseTitle !== "" && (
            <p className="text-xs text-neutral-500">Case: {snapshot.caseTitle}</p>
          )}
        </header>

        {failure !== null && (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-lg border border-rose-200 bg-rose-50 p-4"
          >
            <p className="text-sm font-medium text-rose-900">
              Cannot read the database.
            </p>
            <p className="text-xs text-rose-700">
              Check FAIRJUDGE_DB_KEY in .env.local, and run npm run seed:import
              once if you have not.
            </p>
            <p className="font-mono text-xs break-all text-rose-700">{failure}</p>
          </div>
        )}

        {failure === null && snapshot !== null && snapshot.caseId === null && (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6">
            <p className="text-sm text-neutral-700">
              No case in the database yet. Run{" "}
              <code className="font-mono">npm run seed:import</code> to import the
              seed data, or start a case from the evidence page.
            </p>
          </div>
        )}

        {failure === null && snapshot !== null && snapshot.caseId !== null && (
          <TimelineBoard mainline={snapshot.mainline} pending={snapshot.pending} />
        )}

        <footer className="mt-auto border-t border-neutral-200 pt-4">
          <p className="text-xs text-neutral-500">
            The timeline records order and date precision only. It infers no
            causation, and an event whose date is undecided is never treated as
            though it were dated.
          </p>
        </footer>
      </div>
    </main>
  );
}
