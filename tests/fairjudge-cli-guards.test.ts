/**
 * The `fairjudge` CLI's guards.
 *
 * This is the file that would have prevented 2026-08-12. An agent following a
 * task book that said "run it on the real case" wrote fabricated *confirmed*
 * utterances into the live record of a real person's relationship, recorded
 * consent events for someone who has never consented, and relocked the case on
 * that basis (CLAUDE.md, Verification rule). A command-line tool over the same
 * pipeline is precisely the shape of thing that gets pointed at the wrong
 * database, so the refusals below are the feature and everything else in the CLI
 * is downstream of them.
 *
 * Four ways in, all closed: no database named at all; a database named by a
 * variable the connection factory does not read first; the live file by path;
 * and the live file by link, which is the one a name check alone would miss.
 *
 * Nothing here opens a database. `resolveSandboxTarget` is pure apart from two
 * filesystem metadata lookups, and the live-file cases stat a path — they never
 * connect to it, never key it and never read a row.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DB_PATH } from "../src/server/db";
import { PROJECT_ROOT } from "../src/server/env";
import { main, resolveSandboxTarget } from "../scripts/fairjudge-cli";

const LIVE_DB = resolve(PROJECT_ROOT, DEFAULT_DB_PATH);

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fairjudge-cli-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveSandboxTarget", () => {
  it("refuses when FAIRJUDGE_DB_PATH is unset", () => {
    expect(() => resolveSandboxTarget({})).toThrow(/FAIRJUDGE_DB_PATH is not set/);
  });

  it("refuses when FAIRJUDGE_DB_PATH is blank", () => {
    expect(() => resolveSandboxTarget({ FAIRJUDGE_DB_PATH: "   " })).toThrow(
      /FAIRJUDGE_DB_PATH is not set/,
    );
  });

  it("refuses when DATABASE_URL is set, because it outranks the variable checked", () => {
    // A guard that validates one variable while `resolveDbPath` reads another is
    // not a guard — it is a guard-shaped thing with the real path going round it.
    expect(() =>
      resolveSandboxTarget({
        FAIRJUDGE_DB_PATH: join(scratch(), "work.db"),
        DATABASE_URL: "file:somewhere-else.db",
      }),
    ).toThrow(/DATABASE_URL is set/);
  });

  it("refuses the live database by path", () => {
    expect(() =>
      resolveSandboxTarget({ FAIRJUDGE_DB_PATH: DEFAULT_DB_PATH }),
    ).toThrow(/refusing to run against the live database/);
  });

  it("refuses the live database named by an absolute path", () => {
    expect(() => resolveSandboxTarget({ FAIRJUDGE_DB_PATH: LIVE_DB })).toThrow(
      /refusing to run against the live database/,
    );
  });

  it("refuses the live database reached through a symlink", () => {
    // The case a name check cannot see. Statting a link is not opening the file
    // it points at, and nothing in this test connects to anything.
    if (!existsSync(LIVE_DB)) return;
    const link = join(scratch(), "innocent-looking.db");
    symlinkSync(LIVE_DB, link);
    expect(() => resolveSandboxTarget({ FAIRJUDGE_DB_PATH: link })).toThrow(
      /refusing to run against the live database/,
    );
  });

  it("accepts a working file, resolved to an absolute path", () => {
    const target = join(scratch(), "work.db");
    expect(resolveSandboxTarget({ FAIRJUDGE_DB_PATH: target })).toBe(
      resolve(target),
    );
  });
});

describe("main", () => {
  it("refuses before touching the database when a guard fires", async () => {
    const saved = process.env.FAIRJUDGE_DB_PATH;
    delete process.env.FAIRJUDGE_DB_PATH;
    try {
      // The guard runs before `loadEnvLocal`, before `createDb` and before
      // `runMigrations`, so a misconfigured invocation cannot create a stray
      // database on its way to failing.
      await expect(main(["case:status"])).rejects.toThrow(
        /FAIRJUDGE_DB_PATH is not set/,
      );
    } finally {
      if (saved === undefined) delete process.env.FAIRJUDGE_DB_PATH;
      else process.env.FAIRJUDGE_DB_PATH = saved;
    }
  });

  it("reports an unknown command without opening anything", async () => {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["case:destroy"])).toBe(1);
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join("")).toContain('unknown command "case:destroy"');
  });
});
