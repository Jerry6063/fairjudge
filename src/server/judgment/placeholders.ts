/**
 * Placeholder locking — the mechanism behind HARD RULE #8.
 *
 * The rule says any layer that rewrites the judgment's prose sees the surface
 * layer only, never the fact layer. This file is what makes that enforceable
 * rather than aspirational: before such text leaves the machine, every piece of
 * it that *is* a fact — a quotation, a number, a confidence value, an evidence
 * grade, a date — is lifted out and replaced with an opaque token (`{{Q1}}`,
 * `{{N1}}`, `{{G1}}`, `{{D1}}`). The values stay here, in a map that never
 * leaves the process, and are refilled deterministically when the rewritten
 * prose comes back.
 *
 * What that buys is not privacy (the surface layer is already pseudonymized on
 * its way out); it is **integrity**. A rewriter that cannot see "三次" cannot
 * turn it into "several times", and one that cannot see 0.62 cannot round it up
 * to "clearly". The facts are not defended by asking the model nicely — they
 * are physically absent from the request, and a check afterwards only has to
 * confirm the tokens came back intact.
 *
 * ## Its caller is gone, and it stays anyway
 *
 * The GPT polish layer was this module's only caller, and it was removed on
 * 2026-08-16 after the funded round trip measured what it actually did (doc 02
 * §1.1a). Nothing in this repository locks a document today.
 *
 * This module was kept deliberately, and HARD RULE #8 was rewritten around it
 * rather than deleted. Of everything that experiment built, this is the part
 * that was unambiguously right: the six real runs egressed 41 locked values and
 * came back with `refill(lock(x)) === x`, zero quotes, grades or confidences
 * leaked from a 9,205-character turn. It is not a polish-specific trick — it is
 * the general answer to "how do you hand a model your text to rewrite without
 * letting it touch the facts inside the text", and the moment a shareable-copy
 * rewriter, a plain-language pass, a translation layer or a second attempt at
 * polish appears, this is what stands between it and the evidence. Deleting a
 * working safety mechanism because the one thing that used it went away would
 * mean rebuilding it, worse, under deadline, the next time.
 *
 * Its tests (`tests/polish-placeholders.test.ts`) were kept for the same reason
 * and still assert the round-trip property directly.
 *
 * ## Order of locking, and the Chinese quote that forces it
 *
 * Quotations are locked FIRST, as whole spans, and this is the single most
 * important line in the module. Take a line of evidence like:
 *
 *     “你上次说3月2号会打电话，结果又没打”
 *
 * Lock numbers or dates first and that quote is no longer one thing: it becomes
 * `“你上次说{{D1}}会打电话，结果又没打”`, three fragments the polisher can
 * reorder, re-punctuate or split across sentences, and the quotation marks stop
 * guaranteeing that what sits between them is what someone actually said.
 * Locking the quote whole means the polisher receives `{{Q1}}` — one atom it can
 * move but cannot open — and the date inside it is protected by the same token.
 *
 * Both Chinese quotation styles (“…” and 「…」, with nesting) and straight
 * ASCII quotes are recognized. A naive `/"[^"]*"/` finds none of the first two
 * and mis-pairs the third across a Chinese full stop; the scanner below walks
 * the text with an explicit open/close depth instead.
 *
 * ## Deterministic numbering, and why nothing is deduplicated
 *
 * Tokens are numbered per kind in order of first appearance, and **every
 * occurrence gets its own token** — the same quote appearing twice becomes
 * `{{Q1}}` and `{{Q2}}`. Deduplicating would be tidier and is wrong: the
 * deterministic validator's rule is "every placeholder appears exactly once",
 * which is an exact, countable statement only if the lock never emits a token
 * twice. With dedup the check degrades into "appears at least once", which no
 * longer notices a polisher that dropped one of the two occurrences.
 *
 * ## Pure
 *
 * No I/O, no clock, no randomness, no module-level state: `lockText` threads its
 * counters through an explicit `LockState` so a document and its claim summary
 * can be locked into ONE token namespace across several calls. Round-tripping
 * (`refill(lock(x)) === x`) is a property the tests assert directly.
 */

import type { JudgmentSection, SurfaceLayer } from "./contract";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The four things a polisher may not touch.
 *
 * `N` covers confidence values as well as plain counts: a confidence is a
 * number, and giving it a fifth letter would only invite the question of which
 * kind a bare `0.62` is when it appears in prose rather than in the fact layer.
 */
export const PLACEHOLDER_KINDS = ["Q", "N", "G", "D"] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export interface PlaceholderEntry {
  /** The token as it appears in the locked text, e.g. `{{Q1}}`. */
  readonly token: string;
  readonly kind: PlaceholderKind;
  /** The exact original substring. Refilled verbatim — never normalized. */
  readonly value: string;
}

export type PlaceholderMap = readonly PlaceholderEntry[];

/** Per-kind counters, threaded between calls so one namespace spans a request. */
export interface LockState {
  readonly counters: Readonly<Record<PlaceholderKind, number>>;
}

export const EMPTY_LOCK_STATE: LockState = {
  counters: { Q: 0, N: 0, G: 0, D: 0 },
};

/** Matches any `{{…}}` token: ours, and the PII gateway's `{{PHONE_1}}`. */
export const ANY_TOKEN_PATTERN = /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g;

/** Matches a token this module mints. */
export const LOCK_TOKEN_PATTERN = /\{\{([QNGD])(\d+)\}\}/g;

export interface LockResult {
  /** The text with every fact replaced by a token. */
  readonly text: string;
  /** Entries minted by THIS call, in order of appearance. */
  readonly entries: PlaceholderEntry[];
  /** Counters after this call — pass into the next one. */
  readonly state: LockState;
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/** Opening quote -> its closing partner. Straight quotes close with themselves. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["“", "”"], // “ ”
  ["「", "」"], // 「 」
  ["『", "』"], // 『 』
  ["‘", "’"], // ‘ ’
  ['"', '"'],
];

const OPENERS = new Map(QUOTE_PAIRS.map(([open, close]) => [open, close]));

/**
 * A quotation may not run past this many characters.
 *
 * An unbalanced opener would otherwise swallow the rest of the document into a
 * single token, which is technically safe (the text round-trips) but useless —
 * the polisher would receive one atom and nothing to polish. Past the ceiling
 * the scanner gives up on that opener and treats it as ordinary punctuation.
 */
const MAX_QUOTE_LENGTH = 600;

/**
 * Dates, most specific first.
 *
 * Anchored shapes only. "the 2nd" and a bare "2026" are numbers as far as this
 * module is concerned; a date is something that names a day or a month.
 */
const MONTH =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";

const DATE_PATTERNS: readonly RegExp[] = [
  // 2026年8月9日 / 2026 年 8 月 9 日 / 8月9日 / 2026年8月
  /(?:\d{2,4}\s*年\s*)?\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?/y,
  // 2026-08-09 / 2026/8/9 / 08-09-2026
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/y,
  /\d{1,2}[-/]\d{1,2}[-/]\d{4}/y,
  // August 9, 2026 / Aug 9 / 9 August 2026
  new RegExp(`${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{4})?`, "y"),
  new RegExp(`\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:\\s+\\d{4})?`, "y"),
  new RegExp(`${MONTH}\\s+\\d{4}`, "y"),
];

/**
 * Evidence grades (`domain/grading.ts` grades evidence A-D).
 *
 * The whole phrase is locked, not the bare letter: if only "A" were tokenized,
 * a polisher could rewrite "grade" into "rating" and leave the token dangling
 * next to a word that no longer means what the grade meant. And a bare capital
 * letter is far too common in prose to lock on its own.
 */
const GRADE_PATTERNS: readonly RegExp[] = [
  /(?:grade|Grade|GRADE)[-\s]?[A-D]\b/y,
  /[A-D]\s*级/y,
];

/**
 * Numbers, including confidence values and percentages.
 *
 * Runs after quotations, dates and grades, so what reaches here is a number
 * standing in the open: "0.62", "3", "40%", "1,200", "３" (full-width).
 */
const NUMBER_PATTERN =
  /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*[%％])?|[０-９]+(?:\s*[%％])?/y;

/**
 * Chinese numerals are NOT locked.
 *
 * "三次" and "好几回" are counts written as words, and a pattern that caught them
 * would also catch 一 as a particle, 万 in a place name and 十分 meaning "very".
 * They are protected the other way round: a Chinese count almost always appears
 * inside quoted evidence, and quotations lock whole and first. What survives
 * outside a quotation is prose about the record rather than the record, and
 * prose is what a rewriting layer is for.
 *
 * (The removed `polish-validation.ts` carried the long form of this argument:
 * a lexical check strong enough to police Chinese counts fires constantly on
 * legitimate rewording, and one weak enough not to misses every case that
 * matters — and gets believed anyway.)
 */

/** `kind: null` means "copy this span through verbatim, do not lock it". */
interface Match {
  readonly kind: PlaceholderKind | null;
  readonly value: string;
}

/** A `{{…}}` token already in the text, matched whole. */
const EXISTING_TOKEN = /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/y;

/**
 * Try every fact pattern at exactly `index`, most specific first.
 * Returns the span found, or undefined when the character is ordinary prose.
 */
function matchAt(text: string, index: number): Match | undefined {
  const char = text[index];

  // 1. Quotations, whole, including whatever nests inside them.
  const closer = OPENERS.get(char);
  if (closer !== undefined) {
    const end = findQuoteEnd(text, index, char, closer);
    if (end !== -1) return { kind: "Q", value: text.slice(index, end + 1) };
  }

  // 2. An existing `{{…}}` token — a PII placeholder minted by the egress
  //    gateway, or a token from an earlier lock pass — is already an atom.
  //    Skipped WHOLE rather than character by character: the digits in
  //    `{{PHONE_1}}` are part of a placeholder, and locking them would produce
  //    `{{PHONE_{{N1}}}}` and destroy the very thing that layer protects.
  if (char === "{") {
    const token = stickyMatch(EXISTING_TOKEN, text, index);
    if (token !== undefined) return { kind: null, value: token };
  }

  // 3. Dates before numbers — a date is made of numbers.
  for (const pattern of DATE_PATTERNS) {
    const value = stickyMatch(pattern, text, index);
    if (value !== undefined) return { kind: "D", value };
  }

  for (const pattern of GRADE_PATTERNS) {
    const value = stickyMatch(pattern, text, index);
    if (value !== undefined) return { kind: "G", value };
  }

  const number = stickyMatch(NUMBER_PATTERN, text, index);
  if (number !== undefined) return { kind: "N", value: number };

  return undefined;
}

/** Run a sticky regex at one position; returns the match text or undefined. */
function stickyMatch(
  pattern: RegExp,
  text: string,
  index: number,
): string | undefined {
  pattern.lastIndex = index;
  const found = pattern.exec(text);
  if (found === null || found[0].length === 0) return undefined;
  return found[0];
}

/**
 * Index of the closing quote that matches the opener at `start`, or -1.
 *
 * Nesting is tracked by depth so 「他说“三次”都没来」 closes on the 」 and not
 * on the ”. Straight quotes cannot nest (opener and closer are the same
 * character), so the first partner closes them.
 */
function findQuoteEnd(
  text: string,
  start: number,
  open: string,
  close: string,
): number {
  const nestable = open !== close;
  let depth = 1;
  const limit = Math.min(text.length, start + MAX_QUOTE_LENGTH);

  for (let i = start + 1; i < limit; i += 1) {
    const char = text[i];
    if (nestable && char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Locking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Replace every quotation, date, grade and number in `text` with a token.
 *
 * Left-to-right, one pass, longest-match-at-position: once a span is taken the
 * scanner resumes after it, so nothing inside a locked quotation is ever locked
 * again (which is exactly what keeps a quote from being split into pieces).
 */
export function lockText(
  text: string,
  state: LockState = EMPTY_LOCK_STATE,
): LockResult {
  const counters = { ...state.counters };
  const entries: PlaceholderEntry[] = [];
  let out = "";
  let index = 0;

  while (index < text.length) {
    const match = matchAt(text, index);
    if (match === undefined) {
      out += text[index];
      index += 1;
      continue;
    }
    if (match.kind === null) {
      out += match.value;
      index += match.value.length;
      continue;
    }

    counters[match.kind] += 1;
    const token = `{{${match.kind}${counters[match.kind]}}}`;
    entries.push({ token, kind: match.kind, value: match.value });
    out += token;
    index += match.value.length;
  }

  return { text: out, entries, state: { counters } };
}

/**
 * Put the facts back.
 *
 * One pass, table-driven: every `{{…}}` occurrence is looked up and replaced by
 * its stored value, and a token the map does not know is left standing rather
 * than guessed at — it is either the egress gateway's (`{{PHONE_1}}`, restored
 * by that layer) or something the polisher invented, and inventing a value for
 * the latter would be the one failure mode this whole module exists to prevent.
 * The deterministic validator runs before this and rejects such a draft outright.
 *
 * A single pass also means a refilled value containing something token-shaped is
 * never rescanned.
 */
export function refillText(text: string, map: PlaceholderMap): string {
  const table = new Map(map.map((entry) => [entry.token, entry.value]));
  return text.replace(ANY_TOKEN_PATTERN, (token) => table.get(token) ?? token);
}

/** Every `{{…}}` occurrence in `text`, in order, duplicates included. */
export function findTokens(text: string): string[] {
  return text.match(ANY_TOKEN_PATTERN) ?? [];
}

/* -------------------------------------------------------------------------- */
/* Surface layer                                                              */
/* -------------------------------------------------------------------------- */

export interface LockedSurface {
  /** The same sections, with headings and body text locked. */
  readonly surfaceLayer: SurfaceLayer;
  /** Every entry minted, in document order. */
  readonly map: PlaceholderMap;
  /** Counters after the whole document — continue the namespace from here. */
  readonly state: LockState;
}

/**
 * Lock a whole surface layer, headings included.
 *
 * Headings are prose the polisher is allowed to rewrite, so a date or a number
 * sitting in one needs the same protection the body gets. Structure (ids, kind,
 * audience, claim_ids) is copied through untouched: this module changes text
 * and only text.
 */
export function lockSurfaceLayer(
  surfaceLayer: SurfaceLayer,
  state: LockState = EMPTY_LOCK_STATE,
): LockedSurface {
  const map: PlaceholderEntry[] = [];
  let cursor = state;
  const sections: JudgmentSection[] = [];

  for (const section of surfaceLayer.sections) {
    const heading = lockText(section.heading, cursor);
    map.push(...heading.entries);
    const body = lockText(section.text, heading.state);
    map.push(...body.entries);
    cursor = body.state;

    sections.push({ ...section, heading: heading.text, text: body.text });
  }

  return { surfaceLayer: { sections }, map, state: cursor };
}

/** Refill a locked surface layer. The inverse of `lockSurfaceLayer`. */
export function refillSurfaceLayer(
  locked: SurfaceLayer,
  map: PlaceholderMap,
): SurfaceLayer {
  return {
    sections: locked.sections.map((section) => ({
      ...section,
      heading: refillText(section.heading, map),
      text: refillText(section.text, map),
    })),
  };
}
