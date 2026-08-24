import { describe, expect, it } from "vitest";

import {
  OrderKeyError,
  compareOrderKeys,
  firstOrderKey,
  isOrderKey,
  orderKeyAfter,
  orderKeyBefore,
  orderKeyBetween,
  orderKeyForIndex,
  orderKeysBetween,
} from "../src/server/domain/order-key";

/** The keys `tests/fixtures/seed-corpus.ts` writes for E1..E11. */
const SEEDED_KEYS = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA"];

/** Ascending? (byte order, which is what SQLite's BINARY collation uses too) */
function isAscending(keys: readonly string[]): boolean {
  return keys.every((k, i) => i === 0 || compareOrderKeys(keys[i - 1], k) < 0);
}

describe("order keys — insertion points", () => {
  it("starts an empty list at a0", () => {
    expect(firstOrderKey()).toBe("a0");
    expect(orderKeyBetween(null, null)).toBe("a0");
  });

  it("inserts at the head, between two cards, and at the tail", () => {
    const list = ["a1", "a2", "a3"];

    const head = orderKeyBefore(list[0]);
    const middle = orderKeyBetween(list[0], list[1]);
    const tail = orderKeyAfter(list[list.length - 1]);

    expect(compareOrderKeys(head, list[0])).toBe(-1);
    expect(compareOrderKeys(list[0], middle)).toBe(-1);
    expect(compareOrderKeys(middle, list[1])).toBe(-1);
    expect(compareOrderKeys(list[2], tail)).toBe(-1);

    expect(isAscending([head, list[0], middle, list[1], list[2], tail])).toBe(true);
  });

  it("touches no other key when inserting (no integer reindex)", () => {
    const before = [...SEEDED_KEYS];
    const inserted = orderKeyBetween(before[3], before[4]);

    // The only change to the list is the one new key.
    expect(before).toEqual(SEEDED_KEYS);
    const after = [...before.slice(0, 4), inserted, ...before.slice(4)];
    expect(after.filter((k) => SEEDED_KEYS.includes(k))).toEqual(SEEDED_KEYS);
    expect(isAscending(after)).toBe(true);
  });

  it("keeps lexicographic order under repeated splits of the same gap", () => {
    let low = "a0";
    const high = "a1";
    const keys: string[] = [low];

    for (let i = 0; i < 50; i++) {
      const next = orderKeyBetween(low, high);
      expect(compareOrderKeys(low, next)).toBe(-1);
      expect(compareOrderKeys(next, high)).toBe(-1);
      keys.push(next);
      low = next;
    }
    keys.push(high);

    expect(isAscending(keys)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps prepending below every existing key", () => {
    let head = "a0";
    const keys = [head];
    for (let i = 0; i < 20; i++) {
      head = orderKeyBefore(head);
      keys.unshift(head);
    }
    expect(isAscending(keys)).toBe(true);
  });

  it("keeps appending above every existing key", () => {
    let tail = "a0";
    const keys = [tail];
    for (let i = 0; i < 100; i++) {
      tail = orderKeyAfter(tail);
      keys.push(tail);
    }
    expect(isAscending(keys)).toBe(true);
  });

  it("accepts the keys already in the database (base-62 digits, a-z heads)", () => {
    expect(isAscending(SEEDED_KEYS)).toBe(true);
    for (const key of SEEDED_KEYS) expect(isOrderKey(key)).toBe(true);
    expect(orderKeyAfter("aA")).toBe("aB");
    expect(orderKeyBetween("a9", "aA")).toBe("a9V");
  });

  it("sorts the same way SQLite does (plain byte comparison)", () => {
    const keys = ["Zz", "a0", "a0V", "a1", "a9", "aA", "b00"];
    expect([...keys].sort()).toEqual(keys);
    expect(isAscending(keys)).toBe(true);
  });
});

describe("order keys — bulk insertion", () => {
  it("generates n keys in order between two neighbours", () => {
    const keys = orderKeysBetween("a1", "a2", 5);
    expect(keys).toHaveLength(5);
    expect(isAscending(["a1", ...keys, "a2"])).toBe(true);
  });

  it("returns nothing for a count of zero and rejects negatives", () => {
    expect(orderKeysBetween(null, null, 0)).toEqual([]);
    expect(() => orderKeysBetween(null, null, -1)).toThrow(OrderKeyError);
  });
});

describe("order keys — validation", () => {
  it("rejects reversed or equal bounds instead of producing a bad key", () => {
    expect(() => orderKeyBetween("a2", "a1")).toThrow(OrderKeyError);
    expect(() => orderKeyBetween("a1", "a1")).toThrow(OrderKeyError);
    expect(() => orderKeysBetween("a2", "a1", 3)).toThrow(OrderKeyError);
  });

  it("recognizes malformed keys", () => {
    expect(isOrderKey("a0")).toBe(true);
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("a")).toBe(false); // head with no digits
    expect(isOrderKey("a0-")).toBe(false); // '-' is not in the alphabet
    expect(isOrderKey("你好")).toBe(false);
    expect(isOrderKey(null)).toBe(false);
    expect(isOrderKey(42)).toBe(false);
  });

  it("treats an empty-string bound as no bound", () => {
    expect(orderKeyBetween("", "")).toBe("a0");
    expect(orderKeyBetween("", "a1")).toBe(orderKeyBefore("a1"));
  });
});

describe("orderKeyForIndex", () => {
  const keys = ["a1", "a2", "a3"];

  it("maps index 0 to a head insert and length to a tail append", () => {
    expect(compareOrderKeys(orderKeyForIndex(keys, 0), "a1")).toBe(-1);
    expect(compareOrderKeys("a3", orderKeyForIndex(keys, keys.length))).toBe(-1);
  });

  it("maps an interior index to the gap before that position", () => {
    const key = orderKeyForIndex(keys, 2);
    expect(compareOrderKeys("a2", key)).toBe(-1);
    expect(compareOrderKeys(key, "a3")).toBe(-1);
  });

  it("clamps out-of-range indexes onto the list edges", () => {
    expect(compareOrderKeys(orderKeyForIndex(keys, -5), "a1")).toBe(-1);
    expect(compareOrderKeys("a3", orderKeyForIndex(keys, 99))).toBe(-1);
  });

  it("returns the first key for an empty list", () => {
    expect(orderKeyForIndex([], 0)).toBe("a0");
  });
});
