import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases, events } from "../src/server/db/schema";
import { compareOrderKeys, isOrderKey } from "../src/server/domain/order-key";
import {
  TimelineError,
  loadTimeline,
  moveEvent,
} from "../src/server/domain/timeline";
import type { OccurredPrecision } from "../src/lib/timeline-contract";
import { seedCorpus } from "./fixtures/seed-corpus";

/* The server action under test talks to the process-wide database and to
 * Next's cache; both are replaced so the action's own layer (input validation,
 * error copy, persistence) can be exercised in-process. */
let actionDb: Db;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../src/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/db")>();
  return { ...actual, getDb: () => actionDb };
});

const { moveEventAction } = await import("../src/app/timeline/actions");

interface EventFixture {
  label: string;
  orderKey: string;
  precision?: OccurredPrecision;
  inTimeline?: boolean;
  occurredAt?: Date;
}

/** Insert one case plus the given events; returns the case id. */
function seedCase(db: Db, fixtures: EventFixture[]): string {
  const [row] = db.insert(cases).values({ title: "timeline test" }).returning().all();
  for (const f of fixtures) {
    db.insert(events)
      .values({
        caseId: row.id,
        label: f.label,
        title: `Event ${f.label}`,
        description: `Summary of ${f.label}`,
        orderKey: f.orderKey,
        occurredPrecision: f.precision ?? "unknown",
        occurredAt: f.occurredAt ?? null,
        inTimeline: f.inTimeline ?? false,
      })
      .run();
  }
  return row.id;
}

/** Every event of the case, keyed by label. */
function byLabel(db: Db): Map<string, typeof events.$inferSelect> {
  const map = new Map<string, typeof events.$inferSelect>();
  for (const row of db.select().from(events).all()) map.set(row.label ?? row.id, row);
  return map;
}

function idOf(db: Db, label: string): string {
  const row = byLabel(db).get(label);
  if (row === undefined) throw new Error(`no event labelled ${label}`);
  return row.id;
}

describe("timeline snapshot", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    actionDb = db;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("puts dated events on the mainline and undated ones in the holding area", () => {
    seedCase(db, [
      { label: "A", orderKey: "a1", precision: "day", occurredAt: new Date(Date.UTC(2026, 6, 13)) },
      { label: "B", orderKey: "a2" },
      { label: "C", orderKey: "a3", precision: "month", occurredAt: new Date(Date.UTC(2026, 3, 1)) },
      { label: "D", orderKey: "a4", inTimeline: true },
    ]);

    const snapshot = loadTimeline(db);

    expect(snapshot.mainline.map((c) => c.label)).toEqual(["A", "C", "D"]);
    expect(snapshot.pending.map((c) => c.label)).toEqual(["B"]);
    expect(snapshot.mainline.map((c) => c.dateLabel)).toEqual([
      "2026-07-13",
      "2026-04",
      "Date undecided",
    ]);
    // A dated event may not be dragged out; an undated one that was dragged in may.
    expect(snapshot.mainline.map((c) => c.anchored)).toEqual([true, true, false]);
    expect(snapshot.pending[0].precision).toBe("unknown");
  });

  it("sorts each list by order_key, not by insertion order", () => {
    seedCase(db, [
      { label: "late", orderKey: "a9" },
      { label: "early", orderKey: "a1" },
      { label: "middle", orderKey: "a5" },
    ]);

    expect(loadTimeline(db).pending.map((c) => c.label)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("reports an empty board when there is no case at all", () => {
    const snapshot = loadTimeline(db);
    expect(snapshot).toEqual({
      caseId: null,
      caseTitle: null,
      mainline: [],
      pending: [],
    });
  });
});

describe("moveEvent — order_key persistence", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    actionDb = db;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("promotes a holding-area event between two mainline neighbours", () => {
    seedCase(db, [
      { label: "M1", orderKey: "a1", precision: "day", occurredAt: new Date(0) },
      { label: "M2", orderKey: "a2", precision: "day", occurredAt: new Date(0) },
      { label: "P1", orderKey: "a7" },
    ]);
    const before = byLabel(db);

    const outcome = moveEvent(db, {
      eventId: idOf(db, "P1"),
      target: "mainline",
      beforeId: idOf(db, "M1"),
      afterId: idOf(db, "M2"),
    });

    expect(outcome.inMainline).toBe(true);
    expect(isOrderKey(outcome.orderKey)).toBe(true);
    expect(compareOrderKeys("a1", outcome.orderKey)).toBe(-1);
    expect(compareOrderKeys(outcome.orderKey, "a2")).toBe(-1);

    const after = byLabel(db);
    expect(after.get("P1")?.inTimeline).toBe(true);
    expect(after.get("P1")?.orderKey).toBe(outcome.orderKey);
    // The neighbours are untouched — one move rewrites exactly one row.
    expect(after.get("M1")?.orderKey).toBe(before.get("M1")?.orderKey);
    expect(after.get("M2")?.orderKey).toBe(before.get("M2")?.orderKey);

    expect(loadTimeline(db).mainline.map((c) => c.label)).toEqual(["M1", "P1", "M2"]);
    expect(loadTimeline(db).pending).toHaveLength(0);
  });

  it("reorders inside the mainline without renumbering the rest", () => {
    seedCase(db, [
      { label: "E1", orderKey: "a1", inTimeline: true },
      { label: "E2", orderKey: "a2", inTimeline: true },
      { label: "E3", orderKey: "a3", inTimeline: true },
    ]);
    const before = byLabel(db);

    // Drag E3 to the very top.
    moveEvent(db, {
      eventId: idOf(db, "E3"),
      target: "mainline",
      beforeId: null,
      afterId: idOf(db, "E1"),
    });

    expect(loadTimeline(db).mainline.map((c) => c.label)).toEqual(["E3", "E1", "E2"]);
    const after = byLabel(db);
    expect(after.get("E1")?.orderKey).toBe(before.get("E1")?.orderKey);
    expect(after.get("E2")?.orderKey).toBe(before.get("E2")?.orderKey);
    expect(compareOrderKeys(after.get("E3")!.orderKey, "a1")).toBe(-1);
  });

  it("appends to the tail when there is no following neighbour", () => {
    seedCase(db, [
      { label: "E1", orderKey: "a1", inTimeline: true },
      { label: "E2", orderKey: "a2", inTimeline: true },
    ]);

    moveEvent(db, {
      eventId: idOf(db, "E1"),
      target: "mainline",
      beforeId: idOf(db, "E2"),
      afterId: null,
    });

    expect(loadTimeline(db).mainline.map((c) => c.label)).toEqual(["E2", "E1"]);
  });

  it("survives repeated moves into the same gap (fractional, never reindexed)", () => {
    seedCase(db, [
      { label: "top", orderKey: "a1", inTimeline: true },
      { label: "bottom", orderKey: "a2", inTimeline: true },
      { label: "x", orderKey: "a5" },
      { label: "y", orderKey: "a6" },
      { label: "z", orderKey: "a7" },
    ]);

    for (const label of ["x", "y", "z"]) {
      moveEvent(db, {
        eventId: idOf(db, label),
        target: "mainline",
        beforeId: idOf(db, "top"),
        afterId: loadTimeline(db).mainline[1].id,
      });
    }

    const mainline = loadTimeline(db).mainline;
    expect(mainline.map((c) => c.label)).toEqual(["top", "z", "y", "x", "bottom"]);
    // Still strictly ascending and all distinct — no collisions in the gap.
    const keys = mainline.map((c) => c.orderKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    // The two original mainline rows never moved.
    expect(keys[0]).toBe("a1");
    expect(keys[keys.length - 1]).toBe("a2");
  });

  it("sends an undated event back to the holding area", () => {
    seedCase(db, [
      { label: "P1", orderKey: "a1", inTimeline: true },
      { label: "P2", orderKey: "a2" },
    ]);

    const outcome = moveEvent(db, {
      eventId: idOf(db, "P1"),
      target: "pending",
      beforeId: idOf(db, "P2"),
      afterId: null,
    });

    expect(outcome.inMainline).toBe(false);
    expect(byLabel(db).get("P1")?.inTimeline).toBe(false);
    expect(loadTimeline(db).mainline).toHaveLength(0);
    expect(loadTimeline(db).pending.map((c) => c.label)).toEqual(["P2", "P1"]);
  });

  it("refuses to drag a dated event out of the mainline", () => {
    seedCase(db, [
      { label: "dated", orderKey: "a1", precision: "day", occurredAt: new Date(0) },
      { label: "free", orderKey: "a2" },
    ]);

    expect(() =>
      moveEvent(db, {
        eventId: idOf(db, "dated"),
        target: "pending",
        beforeId: null,
        afterId: idOf(db, "free"),
      }),
    ).toThrow(TimelineError);

    try {
      moveEvent(db, {
        eventId: idOf(db, "dated"),
        target: "pending",
        beforeId: null,
        afterId: null,
      });
    } catch (error) {
      expect((error as TimelineError).code).toBe("anchored_event");
    }
    expect(byLabel(db).get("dated")?.orderKey).toBe("a1");
  });

  it("rejects a stale neighbour instead of guessing a position", () => {
    seedCase(db, [
      { label: "A", orderKey: "a1", inTimeline: true },
      { label: "B", orderKey: "a2" },
    ]);

    // "B" is not on the mainline, so it cannot be a mainline neighbour.
    try {
      moveEvent(db, {
        eventId: idOf(db, "A"),
        target: "mainline",
        beforeId: idOf(db, "B"),
        afterId: null,
      });
      throw new Error("expected a stale-order failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TimelineError);
      expect((error as TimelineError).code).toBe("stale_order");
    }
    expect(byLabel(db).get("A")?.orderKey).toBe("a1");
  });

  it("reports an unknown event id", () => {
    seedCase(db, [{ label: "A", orderKey: "a1" }]);
    try {
      moveEvent(db, {
        eventId: "does-not-exist",
        target: "mainline",
        beforeId: null,
        afterId: null,
      });
      throw new Error("expected an event_not_found failure");
    } catch (error) {
      expect((error as TimelineError).code).toBe("event_not_found");
    }
  });
});

describe("moveEventAction (server action layer)", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    actionDb = db;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("writes the new order_key and returns the persisted placement", async () => {
    seedCase(db, [
      { label: "M1", orderKey: "a1", inTimeline: true },
      { label: "M2", orderKey: "a2", inTimeline: true },
      { label: "P1", orderKey: "a9" },
    ]);

    const result = await moveEventAction({
      eventId: idOf(db, "P1"),
      target: "mainline",
      beforeId: idOf(db, "M1"),
      afterId: idOf(db, "M2"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.inMainline).toBe(true);

    const stored = byLabel(db).get("P1");
    expect(stored?.orderKey).toBe(result.event.orderKey);
    expect(stored?.inTimeline).toBe(true);
    expect(loadTimeline(db).mainline.map((c) => c.label)).toEqual(["M1", "P1", "M2"]);
  });

  it("rejects a malformed request without touching the database", async () => {
    seedCase(db, [{ label: "A", orderKey: "a1" }]);

    const result = await moveEventAction({ eventId: "", target: "nowhere" });

    expect(result).toEqual({
      ok: false,
      error: "That drag was not a valid request. Refresh the page and try again.",
    });
    expect(byLabel(db).get("A")?.orderKey).toBe("a1");
  });

  it("turns domain failures into user-facing copy", async () => {
    seedCase(db, [
      { label: "dated", orderKey: "a1", precision: "range" },
      { label: "free", orderKey: "a2" },
    ]);

    const anchored = await moveEventAction({
      eventId: idOf(db, "dated"),
      target: "pending",
      beforeId: null,
      afterId: idOf(db, "free"),
    });
    expect(anchored).toEqual({
      ok: false,
      error:
        "This event has a date anchor, so it cannot go back to the undated column.",
    });

    const missing = await moveEventAction({
      eventId: "nope",
      target: "mainline",
      beforeId: null,
      afterId: null,
    });
    expect(missing).toEqual({
      ok: false,
      error: "This event is no longer in the database. Refresh the page.",
    });
  });
});

describe("timeline over the E1–E11 fixture corpus", () => {
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    actionDb = db;
    seedCorpus(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("starts with only the two dated events on the mainline", () => {
    const { mainline, pending } = loadTimeline(db);

    expect(mainline.map((c) => c.label)).toEqual(["E5", "E9"]);
    expect(mainline.map((c) => c.dateLabel)).toEqual([
      "2026-07-13 ~ 2026-07-17",
      "2026-04-01 ~ 2026-06-30",
    ]);
    expect(pending).toHaveLength(9);
    expect(pending.every((c) => c.precision === "unknown")).toBe(true);
    expect(pending.map((c) => c.label)).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "E6",
      "E7",
      "E8",
      "E10",
      "E11",
    ]);
    // Titles and summaries reach the card, so the page has something to render.
    expect(pending[0].title.length).toBeGreaterThan(0);
    expect(pending[0].summary).not.toBeNull();
  });

  it("drags E9 above E5 and keeps it there", () => {
    const { mainline } = loadTimeline(db);
    const [e5, e9] = mainline;

    moveEvent(db, {
      eventId: e9.id,
      target: "mainline",
      beforeId: null,
      afterId: e5.id,
    });

    const after = loadTimeline(db);
    expect(after.mainline.map((c) => c.label)).toEqual(["E9", "E5"]);
    // Re-reading from the database (not from memory) shows the same order.
    const stored = db.select().from(events).where(eq(events.id, e9.id)).get();
    expect(stored?.orderKey).toBe(after.mainline[0].orderKey);
    expect(compareOrderKeys(stored!.orderKey, e5.orderKey)).toBe(-1);
  });

  it("drags an undated event out of the holding area onto the mainline", async () => {
    const before = loadTimeline(db);
    const e1 = before.pending[0];

    const result = await moveEventAction({
      eventId: e1.id,
      target: "mainline",
      beforeId: before.mainline[0].id,
      afterId: before.mainline[1].id,
    });
    expect(result.ok).toBe(true);

    const after = loadTimeline(db);
    expect(after.mainline.map((c) => c.label)).toEqual(["E5", "E1", "E9"]);
    expect(after.pending).toHaveLength(8);
    expect(after.pending.some((c) => c.label === "E1")).toBe(false);
    // Still undated: promotion is about ordering, not about inventing a date.
    expect(after.mainline[1].precision).toBe("unknown");
    expect(after.mainline[1].dateLabel).toBe("Date undecided");
  });
});
