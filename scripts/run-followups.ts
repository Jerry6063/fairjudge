/**
 * `npm run followups:run` — fire every follow-up that is due.
 *
 * This is what the launchd timer executes (see `scripts/launchd/`), and what a
 * person runs when they want to know whether anything is being quietly dropped.
 * It is safe to run at any time and as often as you like: claiming is a
 * conditional UPDATE, so a run that overlaps the application-start catch-up
 * claims nothing and does nothing.
 *
 *     npm run followups:run              # schedule what is missing, fire what is due
 *     npm run followups:run -- --dry-run # report only: schedule nothing, send nothing
 *     npm run followups:run -- --list    # what exists and where each one stands
 *
 * The exit code is the point of the thing: 0 when everything due was handled,
 * 1 when a check-in is overdue with no questions to answer. A scheduled task
 * that cannot fail cannot be monitored.
 *
 * Writes to the real on-disk database. Override with `FAIRJUDGE_DB_PATH`.
 */

import { createDb, runMigrations, type Db } from "../src/server/db";
import { loadEnvLocal } from "../src/server/env";
import {
  FOLLOWUP_LABELS,
  catchUpSchedule,
  listOverdueFollowups,
  runDueFollowups,
  type FollowupView,
} from "../src/server/followups";

interface Options {
  readonly dryRun: boolean;
  readonly listOnly: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  return {
    dryRun: argv.includes("--dry-run") || argv.includes("-n"),
    listOnly: argv.includes("--list") || argv.includes("-l"),
  };
}

function stamp(): string {
  return new Date().toISOString();
}

function describeOne(view: FollowupView): string {
  const late = view.overdueByDays > 0 ? ` (${view.overdueByDays}d late)` : "";
  const generation =
    view.generationStatus === "ready" ? "" : ` [${view.generationStatus}]`;
  const error = view.lastError === null ? "" : ` — ${view.lastError}`;
  return (
    `  ${view.caseId}  ${FOLLOWUP_LABELS[view.kind]}  ` +
    `due ${view.scheduledAt.toISOString().slice(0, 10)}  ` +
    `${view.dueState}${late}${generation}${error}`
  );
}

function report(db: Db): FollowupView[] {
  const overdue = listOverdueFollowups(db);
  if (overdue.length === 0) {
    console.log(`${stamp()} [followups] nothing overdue`);
  } else {
    console.log(`${stamp()} [followups] ${overdue.length} overdue:`);
    for (const view of overdue) console.log(describeOne(view));
  }
  return overdue;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const options = parseArgs(process.argv.slice(2));

  const { db, sqlite } = createDb();
  try {
    runMigrations(db);

    if (options.listOnly) {
      const overdue = report(db);
      process.exitCode = overdue.some((view) => view.needsAttention) ? 1 : 0;
      return;
    }

    if (options.dryRun) {
      console.log(`${stamp()} [followups] dry run — nothing will be scheduled or sent`);
      const overdue = report(db);
      process.exitCode = overdue.some((view) => view.needsAttention) ? 1 : 0;
      return;
    }

    const scheduled = catchUpSchedule(db);
    if (scheduled.length > 0) {
      console.log(`${stamp()} [followups] scheduled ${scheduled.length} row(s)`);
    }

    const summary = await runDueFollowups(db, { skipSchedule: true });
    console.log(
      `${stamp()} [followups] claimed ${summary.claimed}, submitted ` +
        `${summary.submitted}, ready ${summary.ready}, failed ${summary.failed}` +
        (summary.resumed > 0 ? `, resumed ${summary.resumed}` : "") +
        (summary.pending ? " — a batch is still processing" : ""),
    );
    for (const batchId of summary.batchIds) {
      console.log(`${stamp()} [followups] batch ${batchId}`);
    }
    for (const note of summary.notes) {
      console.warn(`${stamp()} [followups] ${note}`);
    }

    // The final word is the state of the world, not the state of this run: a
    // check-in that is overdue with nothing to answer is a failure even if this
    // particular invocation did everything it was asked to.
    const stillStuck = report(db).filter((view) => view.needsAttention);
    process.exitCode = stillStuck.length > 0 ? 1 : 0;
  } finally {
    sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `${stamp()} [followups] run failed: ` +
      (error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  process.exitCode = 1;
});
