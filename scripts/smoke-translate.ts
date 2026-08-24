/**
 * Real-API smoke test for the M1 translator (`npm run smoke:translate`).
 *
 * Unit tests mock the SDK, so nothing in `npm test` proves the request body we
 * build is one the provider actually accepts. This script closes that gap: it
 * runs the same `runStage` path the API route uses, against the real endpoint,
 * once per translator stage.
 *
 *   translate_default → claude-opus-4-8  (the default path)
 *   translate_deep    → claude-fable-5   (the "deep reading" upgrade)
 *
 * For each run it asserts the domain result is `ok`, re-validates the payload
 * against the stage's zod schema, checks every confidence is inside 0-1, and
 * verifies the audit trail: exactly one new `llm_calls` row and one new
 * `egress_ledger` row, with a positive `cost_usd`. Two billed calls total,
 * a few cents at most.
 *
 * Writes to the real on-disk database (audit rows are the point) — override the
 * location with `FAIRJUDGE_DB_PATH` if that is not wanted.
 */

import { strict as assert } from "node:assert";

import { count } from "drizzle-orm";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { egressLedger, llmCalls } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import { runStage, translationSchema } from "../src/server/llm";
import type { StageName } from "../src/server/llm";

/** The test sentence: agreeable on the surface, plainly not agreement. */
const SAMPLE = "行行行，你说得都对，就当我没提过。";

/* -------------------------------------------------------------------------- */
/* Audit-table helpers                                                        */
/* -------------------------------------------------------------------------- */

interface LedgerCounts {
  llmCalls: number;
  egressLedger: number;
}

function readCounts(db: Db): LedgerCounts {
  const [calls] = db.select({ value: count() }).from(llmCalls).all();
  const [egress] = db.select({ value: count() }).from(egressLedger).all();
  return { llmCalls: calls.value, egressLedger: egress.value };
}

/** Total `cost_usd` across every `llm_calls` row, for a before/after delta. */
function readTotalCostUsd(db: Db): number {
  return db
    .select({ costUsd: llmCalls.costUsd })
    .from(llmCalls)
    .all()
    .reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
}

/* -------------------------------------------------------------------------- */
/* One stage run                                                              */
/* -------------------------------------------------------------------------- */

interface RunSummary {
  label: string;
  stage: StageName;
  model: string;
  fallbackUsed: boolean;
  costUsd: number;
  latencyMs: number;
  ledgerCostUsd: number;
  readings: { key: string; confidence: number; reading: string }[];
  cues: string[];
}

async function runOne(
  db: Db,
  stage: StageName,
  label: string,
): Promise<RunSummary> {
  const before = readCounts(db);
  const costBefore = readTotalCostUsd(db);

  const result = await runStage(stage, { prompt: SAMPLE }, { db });

  assert.equal(
    result.kind,
    "ok",
    `[${label}] expected kind "ok", got ${JSON.stringify(result)}`,
  );
  // Narrowed by the assertion above; TypeScript needs the explicit guard.
  if (result.kind !== "ok") throw new Error("unreachable");

  // Re-validate independently of the gateway: the schema is the contract the
  // UI renders against, so the smoke test must prove it holds end to end.
  const data = translationSchema.parse(result.data);

  const readings = [
    { key: "benign", ...data.benign },
    { key: "neutral", ...data.neutral },
    { key: "negative", ...data.negative },
  ];
  for (const { key, confidence, reading } of readings) {
    assert.ok(
      Number.isFinite(confidence) && confidence >= 0 && confidence <= 1,
      `[${label}] ${key}.confidence out of range: ${confidence}`,
    );
    assert.ok(reading.length > 0, `[${label}] ${key}.reading is empty`);
  }

  const after = readCounts(db);
  const llmDelta = after.llmCalls - before.llmCalls;
  const egressDelta = after.egressLedger - before.egressLedger;
  assert.equal(llmDelta, 1, `[${label}] expected 1 new llm_calls row`);
  assert.equal(egressDelta, 1, `[${label}] expected 1 new egress_ledger row`);

  const ledgerCostUsd = readTotalCostUsd(db) - costBefore;
  assert.ok(
    ledgerCostUsd > 0,
    `[${label}] expected cost_usd > 0, got ${ledgerCostUsd}`,
  );
  assert.ok(
    result.meta.costUsd > 0,
    `[${label}] expected meta.costUsd > 0, got ${result.meta.costUsd}`,
  );

  return {
    label,
    stage,
    model: result.meta.model,
    fallbackUsed: result.meta.fallbackUsed,
    costUsd: result.meta.costUsd,
    latencyMs: result.meta.latencyMs,
    ledgerCostUsd,
    readings,
    cues: data.cues,
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function report(summary: RunSummary): void {
  console.log(`\n--- ${summary.label} (${summary.stage}) ---`);
  console.log(
    JSON.stringify({
      model: summary.model,
      fallbackUsed: summary.fallbackUsed,
      costUsd: summary.costUsd,
      latencyMs: summary.latencyMs,
    }),
  );
  console.log(`ledger cost_usd: ${usd(summary.ledgerCostUsd)}`);
  for (const { key, confidence, reading } of summary.readings) {
    console.log(`  ${key.padEnd(8)} ${confidence.toFixed(2)}  ${reading}`);
  }
  console.log(`  cues: ${summary.cues.join(" / ")}`);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  loadEnvLocal();
  assert.ok(
    process.env.ANTHROPIC_API_KEY,
    "ANTHROPIC_API_KEY is not set (expected in .env.local)",
  );

  const { db, sqlite } = createDb();
  runMigrations(db);

  try {
    console.log(`sample: ${SAMPLE}`);
    const summaries = [
      await runOne(db, "translate_default", "default"),
      await runOne(db, "translate_deep", "deep"),
    ];

    for (const summary of summaries) report(summary);

    const total = summaries.reduce((sum, s) => sum + s.costUsd, 0);
    console.log(`\ntotal cost: ${usd(total)} over ${summaries.length} calls`);
    console.log("smoke:translate PASS");
  } finally {
    sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error("smoke:translate FAIL");
  console.error(error);
  process.exitCode = 1;
});
