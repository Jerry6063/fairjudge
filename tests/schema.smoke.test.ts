import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "../src/server/db";
import { caseParticipants, cases } from "../src/server/db/schema";
import type Database from "better-sqlite3";

describe("schema smoke test (in-memory)", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates all 27 tables from generated migrations", () => {
    const rows = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all() as { name: string }[];
    // 20 through migration 0005, plus `judgment_polish_runs` (0006) and
    // `judgment_swap_tests` (0007) from M3 wave B, and `judgment_exports`
    // (0010) from M4 ⑥. M4 ④ added columns to `followups` (0009), not a table.
    // M5 ①③④ (0011) adds `participant_identities`, `consent_events` and
    // `deletion_requests`; the visibility columns went onto existing tables.
    // M5 ④ (0012) adds `deletion_audit`, the append-only log of every deletion
    // and every request.
    expect(rows.length).toBe(27);
  });

  it("inserts a case + participant and reads them back", () => {
    const [insertedCase] = db
      .insert(cases)
      .values({ title: "Test case", stage: "intake" })
      .returning()
      .all();

    expect(insertedCase.id).toBeTruthy();
    expect(insertedCase.stage).toBe("intake");
    expect(insertedCase.status).toBe("open");
    expect(insertedCase.outputLevel).toBeNull();
    expect(insertedCase.createdAt).toBeInstanceOf(Date);

    const [participant] = db
      .insert(caseParticipants)
      .values({
        caseId: insertedCase.id,
        role: "respondent",
        displayName: "知夏",
        pseudonym: "甲",
        participationState: "pending",
        isSubmitter: false,
      })
      .returning()
      .all();

    expect(participant.caseId).toBe(insertedCase.id);
    expect(participant.pseudonym).toBe("甲");
    expect(participant.isSubmitter).toBe(false);

    const readBack = db
      .select()
      .from(caseParticipants)
      .where(eq(caseParticipants.caseId, insertedCase.id))
      .all();

    expect(readBack).toHaveLength(1);
    expect(readBack[0].displayName).toBe("知夏");
    expect(readBack[0].role).toBe("respondent");
  });

  it("enforces the (case_id, role) uniqueness constraint", () => {
    const [c] = db.insert(cases).values({ title: "Dup" }).returning().all();
    db.insert(caseParticipants)
      .values({ caseId: c.id, role: "initiator", pseudonym: "乙" })
      .run();

    expect(() =>
      db
        .insert(caseParticipants)
        .values({ caseId: c.id, role: "initiator", pseudonym: "乙2" })
        .run(),
    ).toThrow();
  });
});
