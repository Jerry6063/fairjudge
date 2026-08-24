/**
 * `npm run judgment:shareable` — derive the copy the other party may be handed.
 *
 * A frozen judgment has two audiences and, since M4 ①, two narratives. The
 * client's copy is written when the judgment is (and frozen with it). The
 * counterparty's copy is written afterwards, from the same frozen fact layer, by
 * the `shareable_narrative` stage — because filtering the client's copy leaves a
 * document that still says "You, 乙, submitted this case" to the person it is
 * being handed to, which is the one defect M3's real run exposed.
 *
 * This script is that second generation, on demand:
 *
 *     npm run judgment:shareable                    # the standing judgment of every case
 *     npm run judgment:shareable -- <judgment-id>   # one judgment
 *     npm run judgment:shareable -- --show          # print what is stored, generate nothing
 *
 * Regenerating is safe by construction. The judgment row is never written — the
 * rendition carries its own model, prompt version and revision counter, and
 * `persistShareableNarrative` re-validates the document against the frozen fact
 * layer before it stores anything (HARD RULE #6).
 *
 * Writes to the real on-disk database. Override with `FAIRJUDGE_DB_PATH`.
 */

import { asc } from "drizzle-orm";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import {
  RenditionError,
  generateShareableRendition,
  readCurrentJudgment,
  readJudgment,
  readRenditionView,
  type JudgmentRecord,
} from "../src/server/judgment";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  readonly judgmentId: string | null;
  readonly show: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let judgmentId: string | null = null;
  let show = false;
  for (const arg of argv) {
    if (arg === "--show" || arg === "-s") show = true;
    else if (!arg.startsWith("-")) judgmentId = arg;
  }
  return { judgmentId, show };
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

/** The judgments to work on: one by id, or the standing one of every case. */
function targets(db: Db, judgmentId: string | null): JudgmentRecord[] {
  if (judgmentId !== null) {
    const record = readJudgment(db, judgmentId);
    return record === null ? [] : [record];
  }

  return db
    .select({ id: cases.id })
    .from(cases)
    .orderBy(asc(cases.createdAt), asc(cases.id))
    .all()
    .flatMap((row) => {
      const record = readCurrentJudgment(db, row.id);
      return record === null ? [] : [record];
    });
}

function heading(record: JudgmentRecord): string {
  return (
    `judgment ${record.id} — case ${record.caseId}, v${record.version}, ` +
    `${record.outputLevel}, ${record.status}`
  );
}

/** Print the document exactly as a recipient would receive it. */
function printDocument(text: string): void {
  console.log("\n----- BEGIN SHAREABLE RENDITION -----\n");
  console.log(text);
  console.log("\n----- END SHAREABLE RENDITION -----\n");
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const { db, sqlite } = createDb();
  try {
    runMigrations(db);

    const records = targets(db, options.judgmentId);
    if (records.length === 0) {
      console.error(
        options.judgmentId === null
          ? "No case in this database has a final judgment."
          : `No judgment with id ${options.judgmentId}.`,
      );
      process.exitCode = 1;
      return;
    }

    for (const record of records) {
      console.log(`\n${heading(record)}`);

      if (options.show) {
        try {
          printDocument(readRenditionView(db, record.id, "shareable").text);
        } catch (error) {
          if (!(error instanceof RenditionError)) throw error;
          console.error(`  no shareable copy: [${error.code}] ${error.message}`);
          process.exitCode = 1;
        }
        continue;
      }

      const outcome = await generateShareableRendition(db, record.id);

      if (outcome.kind === "generated") {
        console.log(
          `  generated revision ${outcome.revision} — ${outcome.meta.model}, ` +
            `${outcome.attempts} attempt(s), ` +
            `$${outcome.meta.costUsd.toFixed(4)}, ${outcome.meta.latencyMs}ms` +
            `${outcome.meta.fallbackUsed ? ", SERVED BY FALLBACK" : ""}`,
        );
        printDocument(outcome.view.text);
        continue;
      }

      process.exitCode = 1;
      if (outcome.kind === "rejected") {
        console.error(
          `  refused after ${outcome.attempts} attempt(s) ` +
            `[${outcome.rejection.code}]:\n${outcome.rejection.message}`,
        );
      } else if (outcome.kind === "refused") {
        console.error(
          `  the model refused the request` +
            `${outcome.category === undefined ? "" : ` (${outcome.category})`}.`,
        );
      } else {
        console.error(`  ${outcome.kind}: ${outcome.message}`);
      }
    }
  } finally {
    sqlite.close();
  }
}

await main();
