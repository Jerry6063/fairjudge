/**
 * Fractional-index order keys.
 *
 * CLAUDE.md convention: user-visible ordering (events on the timeline,
 * utterances inside one piece of evidence) is carried by a text `order_key`,
 * never by integer positions. Inserting or moving ONE row writes exactly ONE
 * key — no neighbour is touched, so a drag is a single-row UPDATE and two
 * concurrent drags cannot fight over a shared counter.
 *
 * Alphabet choice (load-bearing, do not "simplify"):
 *   - digits    = BASE_62_DIGITS  (0-9 A-Z a-z) — the value alphabet.
 *   - intDigits = BASE_52_DIGITS  (A-Z a-z)     — the integer-part heads.
 * That pair produces the classic "a0", "a1", "a0V", "Zz" key shape, which is
 * what seeded records carry (`tests/fixtures/seed-corpus.ts` writes "a0".."aA"
 * for E1-E11, and so did the databases seeded before it). Omitting `digits`
 * would default the value alphabet to base 52,
 * where '0'-'9' are not digits at all and "aA" reads as a trailing zero — the
 * seeded keys would be rejected. Passing `digits` without `intDigits` would
 * make keys self-headed base 62, where "a0" is a malformed head. Pass both.
 *
 * Every key is plain ASCII, so JavaScript string comparison, SQLite's default
 * BINARY collation and `ORDER BY order_key` all agree on the same order.
 */

import {
  BASE_52_DIGITS,
  BASE_62_DIGITS,
  generateKeyBetween,
  generateNKeysBetween,
} from "fractional-indexing";

/** Value alphabet of an order key. */
export const ORDER_KEY_DIGITS = BASE_62_DIGITS;

/** Integer-part ("head") alphabet of an order key. */
export const ORDER_KEY_INT_DIGITS = BASE_52_DIGITS;

/** Raised when a caller passes keys that cannot bracket a new key. */
export class OrderKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrderKeyError";
  }
}

/** Bounds of an insertion point: `null` means "no neighbour on that side". */
type Bound = string | null | undefined;

/** Normalize an optional bound; empty strings are treated as absent. */
function bound(value: Bound): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

/**
 * Generate one key strictly between `prev` and `next`.
 *
 * `prev = null` inserts at the head of the list, `next = null` at the tail, and
 * both `null` produces the first key of an empty list ("a0"). This is the one
 * primitive; the three named helpers below exist for readability at call sites.
 */
export function orderKeyBetween(prev: Bound, next: Bound): string {
  const a = bound(prev);
  const b = bound(next);

  if (a !== null && b !== null && a >= b) {
    throw new OrderKeyError(
      `Cannot insert between order keys "${a}" and "${b}": the left key must ` +
        `sort strictly before the right one. The caller's list is stale — ` +
        `re-read the current order and retry.`,
    );
  }

  try {
    return generateKeyBetween(a, b, ORDER_KEY_DIGITS, ORDER_KEY_INT_DIGITS);
  } catch (cause) {
    throw new OrderKeyError(
      `Cannot generate an order key between ${format(a)} and ${format(b)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** The key for the first row of an empty list. Always "a0". */
export function firstOrderKey(): string {
  return orderKeyBetween(null, null);
}

/** Insert before the current head (`next` is the current first key). */
export function orderKeyBefore(next: Bound): string {
  return orderKeyBetween(null, next);
}

/** Append after the current tail (`prev` is the current last key). */
export function orderKeyAfter(prev: Bound): string {
  return orderKeyBetween(prev, null);
}

/**
 * Generate `count` keys in order between `prev` and `next` — for bulk inserts
 * (e.g. an OCR pass appending a screenful of utterances at once).
 */
export function orderKeysBetween(
  prev: Bound,
  next: Bound,
  count: number,
): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new OrderKeyError(`count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return [];

  const a = bound(prev);
  const b = bound(next);

  if (a !== null && b !== null && a >= b) {
    throw new OrderKeyError(
      `Cannot insert between order keys "${a}" and "${b}": the left key must ` +
        `sort strictly before the right one.`,
    );
  }

  try {
    return generateNKeysBetween(
      a,
      b,
      count,
      ORDER_KEY_DIGITS,
      ORDER_KEY_INT_DIGITS,
    );
  } catch (cause) {
    throw new OrderKeyError(
      `Cannot generate ${count} order keys between ${format(a)} and ` +
        `${format(b)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Whether `value` is a well-formed key for this alphabet pair. Used to guard
 * rows that predate the convention (or arrive from a client) before they are
 * fed back into key generation.
 *
 * The structural check is spelled out here rather than delegated: the library's
 * own validation is looser (it accepts stray characters in the fractional part,
 * since generation never produces them), and a key that survives generation but
 * carries junk would sort in surprising places.
 */
export function isOrderKey(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;

  // Head character: its position in the head alphabet encodes how long the
  // integer part is (outermost = longest, midpoint = shortest at 2).
  const headIndex = ORDER_KEY_INT_DIGITS.indexOf(value[0]);
  if (headIndex === -1) return false;
  const half = ORDER_KEY_INT_DIGITS.length / 2;
  const intLength =
    headIndex < half ? half - headIndex + 1 : headIndex - half + 2;
  if (value.length < intLength) return false;

  const integerDigits = value.slice(1, intLength);
  const fraction = value.slice(intLength);
  for (const char of integerDigits + fraction) {
    if (!ORDER_KEY_DIGITS.includes(char)) return false;
  }

  // A fractional part may not end in the zero digit (it would tie with the key
  // that omits it), and the smallest integer is reserved as a lower sentinel.
  const zero = ORDER_KEY_DIGITS[0];
  if (fraction.endsWith(zero)) return false;
  if (value[0] === ORDER_KEY_INT_DIGITS[0] && integerDigits === zero.repeat(intLength - 1)) {
    return false;
  }

  try {
    // Belt and braces: the library must also accept it as a bound.
    generateKeyBetween(value, null, ORDER_KEY_DIGITS, ORDER_KEY_INT_DIGITS);
    return true;
  } catch {
    return false;
  }
}

/** Comparator matching SQLite's BINARY collation on `order_key`. */
export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key that lands a row at `index` of `keys`.
 *
 * `keys` must be the destination list already sorted and WITHOUT the moved row
 * (removing it first is what makes "move down by one" land where the user sees
 * the drop indicator). `index` is clamped into `[0, keys.length]`, so index 0
 * is a head insert and `keys.length` a tail append.
 */
export function orderKeyForIndex(keys: readonly string[], index: number): string {
  const at = Math.max(0, Math.min(Math.trunc(index), keys.length));
  return orderKeyBetween(keys[at - 1] ?? null, keys[at] ?? null);
}

/** Render a bound for error messages. */
function format(value: string | null): string {
  return value === null ? "the list edge" : `"${value}"`;
}
