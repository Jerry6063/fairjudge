/**
 * `npm run judgment:plan` — derive the two documents that are supposed to change
 * the week after the judgment (SPEC M4 ②③).
 *
 * The improvement contract (one to three commitments, each tied to claims from
 * the frozen fact layer) and the repair-conversation script (an opening line,
 * and what to do when it goes wrong). Both are generated from the frozen fact
 * layer, both are checked server-side before anything is stored, and neither
 * writes a byte to the judgment row.
 *
 *     npm run judgment:plan                    # the standing judgment of every case
 *     npm run judgment:plan -- <judgment-id>   # one judgment
 *     npm run judgment:plan -- --show          # print what is stored, generate nothing
 *     npm run judgment:plan -- --contract      # only the contract
 *     npm run judgment:plan -- --script        # only the repair script
 *
 * Regenerating is safe by construction and refused where it should be: a
 * contract that has left `draft` is being lived by, and a repair script a human
 * has confirmed or edited is the sentence they decided to say. Both refuse to be
 * written over.
 *
 * Writes to the real on-disk database. Override with `FAIRJUDGE_DB_PATH`.
 */

import { asc } from "drizzle-orm";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import {
  generateImprovementContract,
  generateRepairScript,
  readCurrentJudgment,
  readImprovementContract,
  readJudgment,
  readRepairScript,
  renderImprovementContract,
  resolveClaimProvenance,
  type ImprovementContractOutcome,
  type JudgmentRecord,
  type RepairScriptOutcome,
  type StoredContractItem,
} from "../src/server/judgment";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  readonly judgmentId: string | null;
  readonly show: boolean;
  readonly contract: boolean;
  readonly script: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let judgmentId: string | null = null;
  let show = false;
  let contract = false;
  let script = false;

  for (const arg of argv) {
    if (arg === "--show" || arg === "-s") show = true;
    else if (arg === "--contract" || arg === "-c") contract = true;
    else if (arg === "--script" || arg === "-r") script = true;
    else if (!arg.startsWith("-")) judgmentId = arg;
  }

  // Neither flag means both documents; naming one means only that one.
  const both = !contract && !script;
  return { judgmentId, show, contract: contract || both, script: script || both };
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

function document(title: string, text: string): void {
  console.log(`\n----- BEGIN ${title} -----\n`);
  console.log(text);
  console.log(`\n----- END ${title} -----\n`);
}

/**
 * The claims an item rests on, spelled out.
 *
 * The contract's own text cites ids; a reader of this script has no way to look
 * them up, and "rests on c3" is provenance nobody can check.
 */
function provenanceLines(
  record: JudgmentRecord,
  items: readonly StoredContractItem[],
): string {
  return items
    .map((item) => {
      const claims = resolveClaimProvenance(record.factLayer, item.claim_ids)
        .map(
          (claim) =>
            `      ${claim.claimId} [${claim.tier ?? "MISSING FROM FACT LAYER"}] ` +
            `${claim.statement ?? ""}`,
        )
        .join("\n");
      return `  ${item.item_id} (${item.kind}, binds ${item.bound_party}):\n${claims}`;
    })
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* Reporting an outcome                                                       */
/* -------------------------------------------------------------------------- */

/** Everything that is not "generated" ends the run non-zero and says why. */
function reportFailure(
  what: string,
  outcome: ImprovementContractOutcome | RepairScriptOutcome,
): void {
  process.exitCode = 1;
  if (outcome.kind === "rejected") {
    console.error(
      `  ${what} refused after ${outcome.attempts} attempt(s) ` +
        `[${outcome.rejection.code}]:\n${outcome.rejection.message}`,
    );
  } else if (outcome.kind === "refused") {
    console.error(
      `  the model refused the ${what}` +
        `${outcome.category === undefined ? "" : ` (${outcome.category})`}.`,
    );
  } else if (outcome.kind === "error" || outcome.kind === "blocked") {
    console.error(`  ${what} ${outcome.kind}: ${outcome.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function runContract(db: Db, record: JudgmentRecord): Promise<void> {
  const outcome = await generateImprovementContract(db, record.id);
  if (outcome.kind !== "generated") {
    reportFailure("improvement contract", outcome);
    return;
  }

  console.log(
    `  contract: ${outcome.record.commitments.length} commitment(s), ` +
      `${outcome.record.invitations.length} invitation(s) — ` +
      `${outcome.meta.model}, ${outcome.attempts} attempt(s), ` +
      `$${outcome.meta.costUsd.toFixed(4)}, ${outcome.meta.latencyMs}ms` +
      `${outcome.meta.fallbackUsed ? ", SERVED BY FALLBACK" : ""}`,
  );
  document("IMPROVEMENT CONTRACT", outcome.record.text);
  console.log("  what each item rests on:");
  console.log(provenanceLines(record, outcome.record.content.items));
}

async function runScript(db: Db, record: JudgmentRecord): Promise<void> {
  const outcome = await generateRepairScript(db, record.id);
  if (outcome.kind !== "generated") {
    reportFailure("repair script", outcome);
    return;
  }

  console.log(
    `  repair script: ${outcome.meta.model}, ${outcome.attempts} attempt(s), ` +
      `$${outcome.meta.costUsd.toFixed(4)}, ${outcome.meta.latencyMs}ms` +
      `${outcome.meta.fallbackUsed ? ", SERVED BY FALLBACK" : ""}`,
  );
  document("REPAIR SCRIPT", outcome.record.text);
  console.log("  built from:");
  console.log(
    resolveClaimProvenance(record.factLayer, outcome.record.content.claim_ids)
      .map(
        (claim) =>
          `      ${claim.claimId} [${claim.tier ?? "MISSING FROM FACT LAYER"}] ` +
          `${claim.statement ?? ""}`,
      )
      .join("\n"),
  );
}

function show(db: Db, record: JudgmentRecord, options: Options): void {
  if (options.contract) {
    const stored = readImprovementContract(db, record.id);
    if (stored === null) {
      console.error("  no improvement contract has been generated yet.");
      process.exitCode = 1;
    } else {
      console.log(
        `  contract: status ${stored.status}, ${stored.confirmStatus}, ` +
          `${stored.commitments.length} commitment(s), ` +
          `${stored.invitations.length} invitation(s)`,
      );
      document("IMPROVEMENT CONTRACT", stored.text);
      // Re-rendered from the stored structure rather than read off the row, so
      // a stale `ai_draft` column would be visible here instead of silently
      // standing in for the contract.
      const rerendered = renderImprovementContract(stored.content);
      if (rerendered !== stored.text) {
        console.log("  (the text above is a human edit of the generated one)");
      }
      console.log("  what each item rests on:");
      console.log(provenanceLines(record, stored.content.items));
    }
  }

  if (options.script) {
    const stored = readRepairScript(db, record.id);
    if (stored === null) {
      console.error("  no repair script has been generated yet.");
      process.exitCode = 1;
    } else {
      console.log(`  repair script: ${stored.confirmStatus}`);
      document("REPAIR SCRIPT", stored.text);
    }
  }
}

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
        show(db, record, options);
        continue;
      }

      if (options.contract) await runContract(db, record);
      if (options.script) await runScript(db, record);
    }
  } finally {
    sqlite.close();
  }
}

await main();
