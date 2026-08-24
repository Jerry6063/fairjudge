/**
 * One-shot migration: plaintext SQLite → SQLCipher (`npm run db:encrypt`).
 *
 * M0/M1 wrote `data/fairjudge.db` in the clear (FileVault was the only layer at
 * rest). M2 keys every on-disk connection, so the existing file has to be
 * converted once. All M0/M1 rows must survive.
 *
 * How it works — SQLite3 Multiple Ciphers has no `sqlcipher_export()` SQL
 * function (that one is SQLCipher-proper), so the conversion is a file-level
 * export/import instead:
 *
 *   1. checkpoint the WAL so the .db file is self-contained
 *   2. record per-table row counts (the migration's ground truth)
 *   3. back up the plaintext file to data/backup-<ts>.db.plain
 *   4. copy it to a temp file and `PRAGMA rekey` that copy to SQLCipher
 *   5. reopen the temp file with the key, re-count every table, compare
 *   6. swap the temp file into place (stale -wal/-shm siblings removed)
 *
 * The original file is only replaced after step 5 passes, and the plaintext
 * backup is left on disk for the operator to delete by hand — deleting the last
 * readable copy automatically is not this script's call.
 *
 * The key (`FAIRJUDGE_DB_KEY`) is never printed, logged, or returned.
 */

import { closeSync, copyFileSync, existsSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolves to better-sqlite3-multiple-ciphers through the package.json alias.
import Database from "better-sqlite3";

import { resolveDbKey, resolveDbPath, DB_KEY_ENV_VAR } from "../src/server/db";
import { loadEnvLocal } from "../src/server/env";

/** Magic bytes at the head of every plaintext SQLite file. */
const SQLITE_MAGIC = "SQLite format 3\0";

/** Row counts keyed by table name. */
type TableCounts = Record<string, number>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `2026-08-08T16-42-11` — filesystem-safe, sortable. */
function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/** True when the file still starts with the plaintext SQLite header. */
function isPlaintextSqlite(path: string): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString("latin1") === SQLITE_MAGIC;
}

/** Count rows in every user table (drizzle's migration table included). */
function readTableCounts(sqlite: Database.Database): TableCounts {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];

  const counts: TableCounts = {};
  for (const { name } of tables) {
    const row = sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
      n: number;
    };
    counts[name] = row.n;
  }
  return counts;
}

/** Human-readable diff of two count maps; empty array = identical. */
function diffCounts(before: TableCounts, after: TableCounts): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const problems: string[] = [];
  for (const name of names) {
    const b = before[name];
    const a = after[name];
    if (b === undefined) problems.push(`  ${name}: table appeared after migration (${a})`);
    else if (a === undefined) problems.push(`  ${name}: table missing after migration (was ${b})`);
    else if (a !== b) problems.push(`  ${name}: ${b} → ${a}`);
  }
  return problems;
}

/** Remove a database file together with its -wal/-shm siblings. */
function removeDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Open an encrypted database read-only-ish, purely to verify + count. */
function openEncrypted(path: string, key: string): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma("legacy=4");
  sqlite.pragma(`key="x'${key}'"`);
  return sqlite;
}

/** True when `path` opens and reads with `key`. */
function opensWithKey(path: string, key: string): boolean {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = openEncrypted(path, key);
    sqlite.prepare("SELECT count(*) FROM sqlite_schema").get();
    return true;
  } catch {
    return false;
  } finally {
    sqlite?.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */

export interface MigrationResult {
  dbPath: string;
  backupPath: string;
  counts: TableCounts;
}

export function migrateToEncrypted(explicitPath?: string): MigrationResult {
  const dbPath = resolve(resolveDbPath(explicitPath));
  const key = resolveDbKey();

  if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath} — nothing to migrate. A fresh encrypted ` +
        `database is created on first use (npm run seed:import).`,
    );
  }

  if (!isPlaintextSqlite(dbPath)) {
    if (opensWithKey(dbPath, key)) {
      throw new Error(
        `${dbPath} is already encrypted and opens with the current ` +
          `${DB_KEY_ENV_VAR}. Nothing to do.`,
      );
    }
    throw new Error(
      `${dbPath} is neither a plaintext SQLite file nor readable with the ` +
        `current ${DB_KEY_ENV_VAR}. Refusing to touch it — restore a backup or ` +
        `fix the key before retrying.`,
    );
  }

  /* 1-2. Checkpoint + baseline counts, from the plaintext file. */
  const source = new Database(dbPath);
  let before: TableCounts;
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
    before = readTableCounts(source);
  } finally {
    source.close();
  }

  /* 3. Backup before anything is written. */
  const stamp = timestamp();
  const backupPath = join(dirname(dbPath), `backup-${stamp}.db.plain`);
  copyFileSync(dbPath, backupPath);

  /* 4. Encrypt a copy in place via PRAGMA rekey. */
  const tempPath = `${dbPath}.encrypting-${stamp}`;
  removeDbFiles(tempPath);
  copyFileSync(dbPath, tempPath);
  const target = new Database(tempPath);
  try {
    target.pragma("cipher='sqlcipher'");
    target.pragma("legacy=4");
    target.pragma(`rekey="x'${key}'"`);
  } finally {
    target.close();
  }

  /* 5. Verify: the key opens it, a missing key does not, counts match. */
  let after: TableCounts;
  const verify = openEncrypted(tempPath, key);
  try {
    after = readTableCounts(verify);
  } catch (cause) {
    removeDbFiles(tempPath);
    throw new Error(`Encrypted copy is unreadable with ${DB_KEY_ENV_VAR}`, { cause });
  } finally {
    verify.close();
  }

  if (opensWithKey(tempPath, "0".repeat(64))) {
    removeDbFiles(tempPath);
    throw new Error(`Encrypted copy opened with a bogus key — refusing to install it.`);
  }

  const problems = diffCounts(before, after);
  if (problems.length > 0) {
    removeDbFiles(tempPath);
    throw new Error(`Row counts changed during migration:\n${problems.join("\n")}`);
  }

  /* 6. Swap in. Stale plaintext -wal/-shm must not survive next to the new file. */
  removeDbFiles(dbPath);
  renameSync(tempPath, dbPath);

  return { dbPath, backupPath, counts: after };
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

function main(): void {
  loadEnvLocal();

  const result = migrateToEncrypted();

  const rows = Object.entries(result.counts).sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(...rows.map(([name]) => name.length));
  const lines = [
    `Encrypted ${result.dbPath} (SQLCipher, cipher=sqlcipher legacy=4).`,
    `Row counts verified identical before/after:`,
    ...rows.map(([name, n]) => `  ${name.padEnd(width)}  ${n}`),
    ``,
    `Plaintext backup kept at:`,
    `  ${result.backupPath}`,
    `Delete it yourself once the app reads the encrypted database:`,
    `  rm ${result.backupPath}`,
    ``,
    `The key stays in .env.local (git-ignored). Lose it and this data is gone.`,
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`db:encrypt failed — ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
