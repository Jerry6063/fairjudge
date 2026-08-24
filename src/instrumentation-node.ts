/**
 * The node-runtime half of the start-up catch-up (SPEC M4 ④).
 *
 * Split out of `instrumentation.ts` on purpose. Next.js compiles the
 * instrumentation entry for **every** runtime it might run in, including the
 * edge one, and webpack builds the module graph before it knows that
 * `NEXT_RUNTIME` is `"nodejs"` at run time. An `await import("./server/db")`
 * sitting in the entry file therefore drags `better-sqlite3` — and its native
 * `bindings` shim, which does `require("fs")` — into the edge bundle, where
 * `fs` does not resolve. That is not a warning: it fails the compilation and
 * every route 500s.
 *
 * Putting the work behind a dynamic import that is only reachable inside
 * `if (process.env.NEXT_RUNTIME === "nodejs")` is the documented shape, and it
 * works because webpack's DefinePlugin substitutes that value as a literal and
 * drops the unreachable branch — so the edge bundle never sees this file.
 *
 * Everything here keeps the two properties the entry file promises: it never
 * blocks or breaks startup, and it never fails silently.
 */

export async function catchUpFollowups(): Promise<void> {
  const { getDb } = await import("./server/db");
  const { catchUpSchedule, listOverdueFollowups, runDueFollowups } = await import(
    "./server/followups"
  );

  let db;
  try {
    db = getDb();
  } catch (error) {
    console.error(`[followups] catch-up skipped — no database: ${describe(error)}`);
    return;
  }

  // Scheduling is local and instant, so it happens inline: after this returns,
  // every frozen judgment has its two rows and the UI can already show a
  // missed check-in as overdue, whether or not the generation below succeeds.
  try {
    const scheduled = catchUpSchedule(db);
    if (scheduled.length > 0) {
      console.log(`[followups] catch-up scheduled ${scheduled.length} check-in row(s)`);
    }
    const overdue = listOverdueFollowups(db);
    if (overdue.length > 0) {
      console.warn(
        `[followups] ${overdue.length} check-in(s) overdue: ` +
          overdue.map((f) => `${f.caseId}/${f.kind}`).join(", "),
      );
    }
  } catch (error) {
    console.error(`[followups] catch-up scheduling failed: ${describe(error)}`);
  }

  // Generation talks to a provider and polls a batch, so it is detached: the
  // server starts serving now, and the check-ins land when they land.
  void runDueFollowups(db, { skipSchedule: true })
    .then((summary) => {
      if (summary.claimed === 0 && summary.resumed === 0) return;
      console.log(
        `[followups] catch-up run: ${summary.ready} ready, ${summary.failed} failed, ` +
          `${summary.claimed} claimed${summary.pending ? ", a batch is still processing" : ""}`,
      );
      for (const note of summary.notes) console.warn(`[followups] ${note}`);
    })
    .catch((error: unknown) => {
      console.error(`[followups] catch-up run failed: ${describe(error)}`);
    });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
