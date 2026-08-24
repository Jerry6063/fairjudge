/**
 * Application-start catch-up for the 7 / 30-day follow-ups (SPEC M4 ④).
 *
 * Next.js calls `register()` once per server process, before the first request.
 * That makes it the one hook that fires on the event Phase 0 actually has:
 * somebody opening the laptop and starting the app.
 *
 * Why this exists **as well as** the launchd timer: a timer on a machine that
 * sleeps is a timer that misses. launchd will run a missed calendar job after
 * wake, but it will not run one for a machine that was off, and it will not run
 * at all if the plist was never installed. So the rule is that anything overdue
 * runs at start, and the two firing paths are safe on top of each other —
 * `claimDueFollowups` claims with a conditional UPDATE, so whichever gets there
 * first does the work and the other finds nothing.
 *
 * This file is a guard and nothing else. The work lives in
 * `instrumentation-node.ts` and is reachable only from inside the runtime test,
 * because Next.js compiles this entry for the edge runtime too and webpack
 * resolves imports statically — an import of the database layer written out here
 * puts `better-sqlite3` (and `require("fs")`) into a bundle that has no `fs`,
 * which fails the compilation and 500s every route. See that file for the whole
 * story.
 *
 * Two properties the catch-up must have and does:
 *
 *   * **It never blocks or breaks startup.** The work is detached and every
 *     failure is caught. A follow-up run that cannot reach Anthropic must not
 *     stop the app from rendering a case file.
 *   * **It never fails silently.** Everything it did, and everything it could
 *     not do, is printed — and the rows it could not finish carry their own
 *     reason and render as overdue in the UI regardless of what any log says.
 */

export async function register(): Promise<void> {
  // The edge runtime has no database and no filesystem; only the node server
  // process runs this. Written as a positive test with the import nested inside
  // it so the edge build drops the branch entirely rather than resolving it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // An explicit off switch for anyone who wants the timer to be the only path.
    if (process.env.FAIRJUDGE_FOLLOWUP_CATCHUP === "0") return;
    const { catchUpFollowups } = await import("./instrumentation-node");
    await catchUpFollowups();
  }
}
