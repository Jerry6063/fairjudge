// Regex-based PII scrubbing layer.
//
// Replaces Chinese mobile numbers, emails, WeChat handles and 18-digit national
// ID numbers with numbered placeholders ("{{PHONE_1}}" etc.) and returns the
// mapping needed to restore them locally. Pure functions, no global state: the
// module-level regexes are only ever consumed through `String.matchAll`, which
// clones the RegExp internally and therefore never mutates their `lastIndex`.

import type { PiiMatch, PiiType, ScrubPiiResult } from "./types";

interface PiiRule {
  type: PiiType;
  /** Global (`g`) + hasIndices (`d`) regex; `d` gives per-group spans. */
  regex: RegExp;
  /** Which capture group holds the sensitive value (0 = the whole match). */
  group: number;
}

// Ordering matters: the 18-digit ID rule runs first so an 11-digit phone can
// never be carved out of the middle of an ID number (overlap resolution below
// keeps the earliest-starting, longest span). WeChat's label form runs before
// the bare `wxid_` form so "微信号：wxid_x" scrubs the value once, not twice.
const RULES: readonly PiiRule[] = [
  // Mainland China resident ID: 17 digits + a final digit or X, not embedded in
  // a longer alphanumeric run.
  { type: "ID", regex: /(?<![\dXx])\d{17}[\dXx](?![\dXx])/gd, group: 0 },
  // Mobile number 1[3-9]xxxxxxxxx, optional +86 / 86 country code, optional
  // single space or hyphen separators between digit groups. Bounded so it does
  // not swallow a 12th trailing digit.
  {
    type: "PHONE",
    regex: /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/gd,
    group: 0,
  },
  // Email addresses.
  {
    type: "EMAIL",
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gd,
    group: 0,
  },
  // "微信号：xxx" — replace only the handle, keep the informative label.
  { type: "WECHAT", regex: /微信号[:：]\s*([A-Za-z0-9_-]{3,})/gd, group: 1 },
  // Bare WeChat internal id.
  { type: "WECHAT", regex: /\bwxid_[A-Za-z0-9_-]+/gd, group: 0 },
];

interface Candidate {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  rule: number;
}

/** Minimal shape of a `d`-flag match result's `.indices` array. */
type WithIndices = { indices?: Array<[number, number] | undefined> };

function collect(text: string): Candidate[] {
  const out: Candidate[] = [];
  RULES.forEach((rule, ruleIdx) => {
    for (const m of text.matchAll(rule.regex)) {
      const indices = (m as unknown as WithIndices).indices;
      let start: number;
      let end: number;
      if (rule.group === 0 || !indices) {
        start = m.index ?? 0;
        end = start + m[0].length;
      } else {
        const span = indices[rule.group];
        if (!span) continue;
        [start, end] = span;
      }
      const value = text.slice(start, end);
      if (value.length === 0) continue;
      out.push({ type: rule.type, start, end, value, rule: ruleIdx });
    }
  });
  return out;
}

/**
 * Replace every detected PII value with a numbered placeholder.
 *
 * Identical values within a type collapse onto a single placeholder, so the
 * returned `matches` are unique and directly usable by `restorePii`.
 */
export function scrubPii(text: string): ScrubPiiResult {
  const candidates = collect(text);
  // Earliest start first; at a tie the longest span wins; then rule priority.
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      a.rule - b.rule,
  );

  // Greedily accept non-overlapping spans (candidates are start-sorted).
  const accepted: Candidate[] = [];
  let boundary = 0;
  for (const c of candidates) {
    if (c.start < boundary) continue;
    accepted.push(c);
    boundary = c.end;
  }

  const counters = new Map<PiiType, number>();
  const byValue = new Map<string, string>();
  const matches: PiiMatch[] = [];
  const placeholderOf = (c: Candidate): string => {
    const key = `${c.type}\u0000${c.value}`;
    const existing = byValue.get(key);
    if (existing) return existing;
    const next = (counters.get(c.type) ?? 0) + 1;
    counters.set(c.type, next);
    const placeholder = `{{${c.type}_${next}}}`;
    byValue.set(key, placeholder);
    matches.push({ type: c.type, placeholder, original: c.value });
    return placeholder;
  };

  let result = "";
  let cursor = 0;
  for (const c of accepted) {
    result += text.slice(cursor, c.start);
    result += placeholderOf(c);
    cursor = c.end;
  }
  result += text.slice(cursor);

  return { text: result, matches };
}

/**
 * Inverse of `scrubPii`: substitute each placeholder back with its original
 * value. Longer placeholders are restored first as a defensive measure, though
 * the trailing "}}" already prevents "{{PHONE_1}}" from matching inside
 * "{{PHONE_10}}".
 */
export function restorePii(text: string, matches: readonly PiiMatch[]): string {
  const sorted = [...matches].sort(
    (a, b) => b.placeholder.length - a.placeholder.length,
  );
  let out = text;
  for (const m of sorted) out = out.split(m.placeholder).join(m.original);
  return out;
}
