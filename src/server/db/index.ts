/**
 * SQLCipher connection factory + Drizzle wiring.
 *
 * Driver is `better-sqlite3-multiple-ciphers` — a drop-in fork of better-sqlite3
 * that bundles SQLite3 Multiple Ciphers, so the same API also speaks SQLCipher.
 * It is installed under the `better-sqlite3` name via an npm alias (see
 * package.json): `drizzle-orm/better-sqlite3` imports that bare specifier
 * unconditionally, so aliasing keeps ONE native build in the process and
 * guarantees no import path in the tree can reach a cipher-less SQLite.
 *
 * Default DB path is `data/fairjudge.db`, overridable via env (`DATABASE_URL`
 * or `FAIRJUDGE_DB_PATH`). Tests pass `:memory:` for an isolated in-memory DB.
 *
 * Encryption (M2):
 *   - On-disk databases are ALWAYS encrypted. The key comes from
 *     `FAIRJUDGE_DB_KEY` (32 random bytes as 64 hex chars, `openssl rand -hex
 *     32`), kept in the git-ignored `.env.local`; a missing/malformed key is a
 *     hard error, never a silent fallback to plaintext.
 *   - Cipher config is SQLCipher-compatible (`cipher=sqlcipher`, `legacy=4`), so
 *     the file can also be opened by real SQLCipher tooling with the same key.
 *   - The key is passed in SQLCipher's raw-key form `x'<hex>'`, which uses the
 *     32 bytes directly and skips the 256k-iteration KDF (~0.1ms per open vs
 *     ~80ms for a passphrase). Scripts and tests open connections constantly.
 *   - `:memory:` databases are never keyed: SQLite3 Multiple Ciphers rejects
 *     `PRAGMA key` on in-memory/temporary databases ("Setting key not supported
 *     for in-memory or temporary databases"), and there is no file at rest to
 *     protect. Test fixtures that need a real encrypted file use a temp path.
 *
 * The key value itself must never reach logs, error messages, or return values.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Resolves to better-sqlite3-multiple-ciphers through the package.json alias.
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema } from "./schema";

/**
 * Application database handle. The `$client` intersection is what `drizzle()`
 * actually returns; naming it here keeps the raw connection reachable for the
 * few things Drizzle cannot express (PRAGMAs — see `runMigrations`).
 */
export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/** Default on-disk database location (relative to the project root). */
export const DEFAULT_DB_PATH = "data/fairjudge.db";

/** Env var holding the SQLCipher key (64 hex chars). Lives in `.env.local`. */
export const DB_KEY_ENV_VAR = "FAIRJUDGE_DB_KEY";

/** Where drizzle-kit writes generated migrations. */
const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");

/** A valid key is exactly 32 bytes of hex — the `openssl rand -hex 32` output. */
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Options for opening a connection. `key` overrides the env var (tests). */
export interface OpenDbOptions {
  /** Explicit SQLCipher key (64 hex chars). Defaults to `FAIRJUDGE_DB_KEY`. */
  key?: string;
}

/** In-memory sentinels that must not be treated as filesystem paths. */
function isMemory(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

/** Resolve the DB path: explicit arg > env > default. */
export function resolveDbPath(explicitPath?: string): string {
  return (
    explicitPath ??
    process.env.DATABASE_URL ??
    process.env.FAIRJUDGE_DB_PATH ??
    DEFAULT_DB_PATH
  );
}

/** Remediation text appended to key errors. Never contains the key itself. */
function keySetupHint(): string {
  return [
    `Generate one and append it to .env.local (git-ignored, never committed):`,
    `  printf '\\nFAIRJUDGE_DB_KEY=%s\\n' "$(openssl rand -hex 32)" >> .env.local`,
    `Next.js loads .env.local automatically; scripts call loadEnvLocal() from`,
    `src/server/env.ts. Already-encrypted database + lost key = unreadable data.`,
  ].join("\n");
}

/**
 * Resolve the SQLCipher key: explicit arg > `FAIRJUDGE_DB_KEY`.
 * Throws with setup instructions when missing or malformed. The thrown message
 * never echoes the key.
 */
export function resolveDbKey(explicitKey?: string): string {
  const key = explicitKey ?? process.env[DB_KEY_ENV_VAR];

  if (!key) {
    throw new Error(
      `${DB_KEY_ENV_VAR} is not set — refusing to open the fairjudge database ` +
        `unencrypted.\n${keySetupHint()}`,
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `${DB_KEY_ENV_VAR} is malformed: expected 64 hex characters (32 bytes), ` +
        `got ${key.length} characters.\n${keySetupHint()}`,
    );
  }
  return key;
}

/**
 * Apply the SQLCipher configuration to a fresh connection.
 * Must run before any statement touches the database file.
 */
function applyCipherKey(sqlite: Database.Database, key: string): void {
  // `cipher`/`legacy` select SQLCipher v4 compatibility; both precede `key`.
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma("legacy=4");
  // Raw-key form: the hex is the AES key, no KDF. Key is validated as hex by
  // resolveDbKey(), so it cannot break out of the pragma literal.
  sqlite.pragma(`key="x'${key}'"`);
}

/**
 * Force SQLite to read the database header so a wrong key fails here, at open
 * time, with a useful message instead of at some random later query.
 */
function assertReadable(sqlite: Database.Database, path: string): void {
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_schema").get();
  } catch (cause) {
    sqlite.close();
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot decrypt the database at ${path} (${reason}). Either ` +
        `${DB_KEY_ENV_VAR} is not the key this file was encrypted with, or the ` +
        `file is not a SQLCipher database. A plaintext database from before M2 ` +
        `must be migrated first: npm run db:encrypt`,
      { cause },
    );
  }
}

/**
 * Open a raw connection with sane pragmas, keyed for on-disk databases.
 * Ensures the parent directory exists. In-memory paths open unkeyed.
 */
export function openSqlite(
  explicitPath?: string,
  options: OpenDbOptions = {},
): Database.Database {
  const path = resolveDbPath(explicitPath);
  const memory = isMemory(path);

  // Resolve the key BEFORE opening: `new Database(path)` creates the file, and a
  // missing key must not leave an empty stray database behind.
  const key = memory ? undefined : resolveDbKey(options.key);

  if (!memory) {
    const dir = dirname(resolve(path));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(path);

  if (key !== undefined) {
    applyCipherKey(sqlite, key);
    assertReadable(sqlite, path);
  }

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

/**
 * Create a Drizzle client bound to the schema. Pass `:memory:` in tests.
 * Returns both the drizzle instance and the underlying connection so callers
 * (and tests) can run migrations or close the handle.
 */
export function createDb(
  explicitPath?: string,
  options: OpenDbOptions = {},
): {
  db: Db;
  sqlite: Database.Database;
} {
  const sqlite = openSqlite(explicitPath, options);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Apply generated drizzle migrations (creates the schema on a fresh DB).
 *
 * Foreign-key enforcement is suspended for the duration, which is SQLite's own
 * prescribed recipe for a table rebuild (the twelve-step procedure in "Making
 * Other Kinds Of Table Schema Changes"). SQLite has no ALTER COLUMN, so
 * drizzle-kit implements any column-constraint change as
 * CREATE __new_x / INSERT SELECT / DROP x / RENAME — and with enforcement on,
 * `DROP TABLE evidence` runs an implicit DELETE that cascades into
 * `event_evidence` and nulls `utterances.evidence_id`. The `PRAGMA
 * foreign_keys=OFF` drizzle-kit writes into the migration cannot prevent that:
 * the pragma is a silent no-op inside a transaction, and the migrator wraps
 * every migration in BEGIN/COMMIT. Toggling it here, outside that transaction,
 * is the only place it takes effect.
 *
 * `foreign_key_check` afterwards is the safety net that the deferred
 * constraints still hold; a violation fails loudly instead of leaving dangling
 * references behind.
 */
export function runMigrations(db: Db): void {
  const sqlite = db.$client;
  const wasEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1;

  if (wasEnabled) sqlite.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    const violations = sqlite.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Migration left ${violations.length} foreign-key violation(s); ` +
          `the database was NOT restored automatically. Restore from a backup ` +
          `and fix the migration before retrying.`,
      );
    }
  } finally {
    if (wasEnabled) sqlite.pragma("foreign_keys = ON");
  }
}

/** Lazily-initialized process-wide singleton for application use. */
let singleton: { db: Db; sqlite: Database.Database } | undefined;

/** Shared application database client (on-disk, from env/default path). */
export function getDb(): Db {
  if (!singleton) singleton = createDb();
  return singleton.db;
}
