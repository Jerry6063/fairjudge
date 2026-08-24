/**
 * `.env.local` loading for standalone scripts (`tsx scripts/*.ts`).
 *
 * Next.js loads `.env.local` on its own, so app code never needs this. Scripts
 * run under a bare `node`/`tsx` process do: since M2 the database key
 * (`FAIRJUDGE_DB_KEY`) lives there, and without it every on-disk connection
 * fails.
 *
 * Secrets stay in the git-ignored `.env.local` — this module only reads it.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file (`src/server/env.ts`). */
export const PROJECT_ROOT = resolve(HERE, "..", "..");

/** Absolute path of the local secrets file. */
export const ENV_LOCAL_PATH = resolve(PROJECT_ROOT, ".env.local");

/**
 * Load `.env.local` into `process.env`. No-op when the file is absent.
 * Variables already exported in the shell win, matching `--env-file` semantics.
 */
export function loadEnvLocal(): void {
  if (!existsSync(ENV_LOCAL_PATH)) return;
  process.loadEnvFile(ENV_LOCAL_PATH);
}
