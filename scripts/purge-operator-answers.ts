/**
 * `npm run purge:operator` — take the operator's fingerprints off a real case.
 *
 * Walking M3 wave A end to end required answers that only the client can give,
 * so the integration agent wrote three of them itself (each prefixed
 * `[INTEGRATION WALK —`) and moved the counterparty's participation state off
 * `pending`. Those rows now sit in a record about two real people, in the exact
 * shape the judgment reads as "the client said this".
 *
 * This script withdraws them. It deletes nothing: each contaminated answer
 * becomes `declined` — the state a real user gets when they refuse a question —
 * so the round stays closed and settled while the judgment can see that the
 * question went unanswered. The participation state is re-derived from what the
 * record actually shows.
 *
 * The decision lives in `src/server/pipeline/operator-purge.ts`; this file opens
 * the database and prints what changed, row by row.
 *
 *     npm run purge:operator                 # every case in the database
 *     npm run purge:operator -- <case-id>    # one case
 *     npm run purge:operator -- --dry-run    # report only, write nothing
 *
 * Writes to the real on-disk database (that is the point). Override the location
 * with `FAIRJUDGE_DB_PATH` if that is not wanted.
 */

import { asc } from "drizzle-orm";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import {
  OPERATOR_ANSWER_MARKER,
  applyOperatorPurge,
  purgeOperatorAnswers,
  type PurgeReport,
} from "../src/server/pipeline";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  readonly caseId: string | null;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let caseId: string | null = null;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else if (!arg.startsWith("-")) caseId = arg;
  }
  return { caseId, dryRun };
}

/* -------------------------------------------------------------------------- */
/* Printing                                                                   */
/* -------------------------------------------------------------------------- */

/** Keep a long verbatim answer readable in a terminal without losing its start. */
function clip(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function printReport(report: PurgeReport, title: string | null): void {
  console.log(`\ncase ${report.caseId}${title === null ? "" : ` — ${title}`}`);
  console.log(`  clarification answers scanned: ${report.answersScanned}`);

  if (report.changes.length === 0) {
    console.log("  no operator-authored material found — nothing to withdraw.");
  } else {
    console.log(`  ${report.changes.length} row change(s):`);
    for (const change of report.changes) {
      console.log(`\n  · ${change.table}.${change.field}`);
      console.log(`      row:    ${change.rowId}`);
      // Verbatim, deliberately: this line is the last place the withdrawn text
      // is visible, and an operator auditing the run has to see what was taken
      // out. Chinese evidence, where present, is never translated.
      console.log(`      before: ${clip(change.before)}`);
      console.log(`      after:  ${change.after}`);
      console.log(`      why:    ${clip(change.reason, 400)}`);
    }
  }

  if (report.kept.length > 0) {
    console.log(`\n  left alone on purpose:`);
    for (const kept of report.kept) {
      console.log(`  · ${kept.what}`);
      console.log(`      ${clip(kept.why, 400)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function targets(db: Db, caseId: string | null) {
  const rows = db
    .select({ id: cases.id, title: cases.title })
    .from(cases)
    .orderBy(asc(cases.createdAt), asc(cases.id))
    .all();
  return caseId === null ? rows : rows.filter((row) => row.id === caseId);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const { db, sqlite } = createDb();
  try {
    runMigrations(db);

    const rows = targets(db, options.caseId);
    if (rows.length === 0) {
      console.error(
        options.caseId === null
          ? "No cases in this database."
          : `No case with id ${options.caseId}.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `Withdrawing answers marked "${OPERATOR_ANSWER_MARKER}" across ` +
        `${rows.length} case(s)${options.dryRun ? " — DRY RUN, nothing is written" : ""}.`,
    );

    let changed = 0;
    for (const row of rows) {
      // A dry run reads exactly the same code path and then throws the
      // transaction away, so what it prints is what a real run would do — not a
      // second implementation that predicts it.
      let report: PurgeReport;
      if (options.dryRun) {
        try {
          db.transaction((tx) => {
            throw new DryRun(applyOperatorPurge(tx, row.id));
          });
          /* c8 ignore next -- the callback always throws. */
          throw new Error("unreachable: the dry-run transaction did not roll back");
        } catch (cause) {
          if (!(cause instanceof DryRun)) throw cause;
          report = cause.report;
        }
      } else {
        report = purgeOperatorAnswers(db, row.id);
      }

      printReport(report, row.title);
      if (!report.clean) changed += 1;
    }

    console.log(
      `\n${changed} of ${rows.length} case(s) carried operator-authored ` +
        `material${options.dryRun ? " (nothing was written)" : " and were cleaned"}.`,
    );
  } finally {
    sqlite.close();
  }
}

/** Rollback signal for `--dry-run`: carries the report out of the transaction. */
class DryRun extends Error {
  readonly report: PurgeReport;
  constructor(report: PurgeReport) {
    super("dry run");
    this.report = report;
  }
}

await main();
