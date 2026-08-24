/**
 * SQLCipher tests (M2). Every case runs against a throwaway file database under
 * the OS temp dir — the real `data/fairjudge.db` is never opened here.
 *
 * In-memory databases cannot be keyed at all (SQLite3 Multiple Ciphers rejects
 * `PRAGMA key` on `:memory:`), so a real file is the only way to prove the
 * encryption path. That also matches how the app runs.
 */

import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolves to better-sqlite3-multiple-ciphers through the package.json alias.
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrateToEncrypted } from "../scripts/migrate-encrypt";
import {
  createDb,
  resolveDbKey,
  runMigrations,
  DB_KEY_ENV_VAR,
  type Db,
} from "../src/server/db";
import { cases, evidence, events, utterances } from "../src/server/db/schema";
import { CORPUS_CASE_TITLE, seedCorpus } from "./fixtures/seed-corpus";

/** Two distinct 32-byte keys in `openssl rand -hex 32` shape. */
const KEY = "1f".repeat(32);
const WRONG_KEY = "e4".repeat(32);

const SQLITE_MAGIC = "SQLite format 3\0";

let dir: string;
let dbPath: string;
/** Whatever the real environment had, restored after the suite. */
let savedEnvKey: string | undefined;

/** Read the first bytes of a file without slurping the whole database. */
function fileHeader(path: string, length: number): string {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString("latin1");
}

/** Build the fixture database: migrated schema + the fictional test corpus. */
function seedFixture(): void {
  const { db, sqlite } = createDb(dbPath, { key: KEY });
  try {
    runMigrations(db);
    seedCorpus(db);
  } finally {
    sqlite.close();
  }
}

beforeAll(() => {
  savedEnvKey = process.env[DB_KEY_ENV_VAR];
  dir = mkdtempSync(join(tmpdir(), "fairjudge-cipher-"));
  dbPath = join(dir, "fixture.db");
  seedFixture();
});

afterEach(() => {
  // Each test owns the env var; never leak a key into the next one.
  if (savedEnvKey === undefined) delete process.env[DB_KEY_ENV_VAR];
  else process.env[DB_KEY_ENV_VAR] = savedEnvKey;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLCipher-backed database", () => {
  it("writes an encrypted file — no plaintext SQLite header", () => {
    expect(existsSync(dbPath)).toBe(true);
    expect(fileHeader(dbPath, SQLITE_MAGIC.length)).not.toBe(SQLITE_MAGIC);
  });

  it("reads the seeded corpus back with the correct key", () => {
    const { db, sqlite } = createDb(dbPath, { key: KEY });
    try {
      expect(db.select().from(evidence).all()).toHaveLength(14);
      expect(db.select().from(events).all()).toHaveLength(11);
      expect(db.select().from(utterances).all()).toHaveLength(7);

      const [c] = db.select().from(cases).all();
      expect(c.title).toBe(CORPUS_CASE_TITLE);
    } finally {
      sqlite.close();
    }
  });

  it("takes the key from FAIRJUDGE_DB_KEY when none is passed", () => {
    process.env[DB_KEY_ENV_VAR] = KEY;
    const { db, sqlite } = createDb(dbPath);
    try {
      expect(db.select().from(evidence).all()).toHaveLength(14);
    } finally {
      sqlite.close();
    }
  });

  it("fails to open with the wrong key", () => {
    expect(() => createDb(dbPath, { key: WRONG_KEY })).toThrow(/Cannot decrypt/);
  });

  it("fails to open with no key at all, and says how to fix it", () => {
    delete process.env[DB_KEY_ENV_VAR];

    let message = "";
    try {
      createDb(dbPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(DB_KEY_ENV_VAR);
    expect(message).toContain("openssl rand -hex 32");
    expect(message).toContain(".env.local");
  });

  it("rejects a malformed key instead of deriving one from it", () => {
    expect(() => resolveDbKey("not-a-hex-key")).toThrow(/64 hex characters/);
    expect(() => resolveDbKey("ab".repeat(31))).toThrow(/64 hex characters/);

    // The error must never echo the rejected key — these messages reach logs.
    let message = "";
    try {
      resolveDbKey("deadbeef");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("deadbeef");
  });

  it("leaves a file written with one key unreadable by another", () => {
    const otherPath = join(dir, "other.db");
    const { db, sqlite } = createDb(otherPath, { key: WRONG_KEY });
    runMigrations(db);
    sqlite.close();

    expect(() => createDb(otherPath, { key: KEY })).toThrow(/Cannot decrypt/);
    const reopened = createDb(otherPath, { key: WRONG_KEY });
    expect(reopened.db.select().from(cases).all()).toHaveLength(0);
    reopened.sqlite.close();
  });

  it("does not leave a stray empty database behind when the key is missing", () => {
    delete process.env[DB_KEY_ENV_VAR];
    const strayPath = join(dir, "stray.db");

    expect(() => createDb(strayPath)).toThrow();
    expect(existsSync(strayPath)).toBe(false);
  });

  it("still opens :memory: without any key (test fixtures depend on it)", () => {
    delete process.env[DB_KEY_ENV_VAR];

    const { db, sqlite } = createDb(":memory:");
    try {
      runMigrations(db);
      expect(db.select().from(cases).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("db:encrypt migration", () => {
  it("converts a plaintext database, keeps every row, and backs it up", () => {
    process.env[DB_KEY_ENV_VAR] = KEY;

    // A pre-M2 database: plaintext, WAL, a couple of tables with rows.
    const plainPath = join(dir, "legacy.db");
    const plain = new Database(plainPath);
    plain.pragma("journal_mode = WAL");
    plain.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    plain.exec("CREATE TABLE tags (id INTEGER PRIMARY KEY)");
    plain.exec("INSERT INTO notes (body) VALUES ('甲'), ('乙'), ('丙')");
    plain.close();
    expect(fileHeader(plainPath, SQLITE_MAGIC.length)).toBe(SQLITE_MAGIC);

    const result = migrateToEncrypted(plainPath);

    expect(result.counts).toEqual({ notes: 3, tags: 0 });
    expect(fileHeader(plainPath, SQLITE_MAGIC.length)).not.toBe(SQLITE_MAGIC);

    // The backup is the untouched plaintext original, left for manual deletion.
    expect(existsSync(result.backupPath)).toBe(true);
    expect(fileHeader(result.backupPath, SQLITE_MAGIC.length)).toBe(SQLITE_MAGIC);

    // Rows survive, readable only with the key.
    const migrated = new Database(plainPath);
    migrated.pragma("cipher='sqlcipher'");
    migrated.pragma("legacy=4");
    migrated.pragma(`key="x'${KEY}'"`);
    expect(migrated.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 3 });
    migrated.close();

    expect(() => createDb(plainPath, { key: WRONG_KEY })).toThrow(/Cannot decrypt/);

    // Second run is a no-op that refuses rather than double-encrypting.
    expect(() => migrateToEncrypted(plainPath)).toThrow(/already encrypted/);
  });
});
