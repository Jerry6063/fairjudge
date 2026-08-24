// Deterministic dictionary substitution layer of the pseudonymization gateway.
//
// `pseudonymize` collapses a person's canonical name and every registered
// variant onto a single egress pseudonym using longest-match-first scanning;
// `depseudonymize` maps pseudonyms back to canonical names. A single
// left-to-right pass guarantees that emitted replacements are never re-scanned,
// so substitutions can never cascade (nested-safe by construction).
//
// Pure functions, no IO, no global mutable state.

import { detectPersonNames } from "./names";
import { scrubPii } from "./pii";
import type {
  NameWarning,
  PersonDict,
  PseudonymizeResult,
  PseudonymHit,
} from "./types";

interface Pattern {
  original: string;
  pseudonym: string;
}

/** Compare by length descending, then lexicographically for determinism. */
function byLengthDesc(a: string, b: string): number {
  return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Flatten a dict into (original -> pseudonym) patterns, longest first. */
function buildPatterns(dict: PersonDict): Pattern[] {
  const patterns: Pattern[] = [];
  for (const entry of dict) {
    if (entry.canonical.length > 0) {
      patterns.push({ original: entry.canonical, pseudonym: entry.pseudonym });
    }
    for (const variant of entry.variants) {
      if (variant.length > 0) {
        patterns.push({ original: variant, pseudonym: entry.pseudonym });
      }
    }
  }
  patterns.sort((a, b) => byLengthDesc(a.original, b.original));
  return patterns;
}

/**
 * Replace every registered name/variant with its pseudonym.
 *
 * Longest match wins at each position, so a longer registered name
 * ("知夏妈妈") is never partially matched by a shorter one ("知夏"). The result
 * text is built by appending pseudonyms to a separate buffer, so a pseudonym is
 * never itself re-scanned.
 */
export function pseudonymize(
  text: string,
  dict: PersonDict,
): PseudonymizeResult {
  const patterns = buildPatterns(dict);
  const hits: PseudonymHit[] = [];
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    let matched: Pattern | undefined;
    for (const p of patterns) {
      if (text.startsWith(p.original, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      out += matched.pseudonym;
      hits.push({ original: matched.original, pseudonym: matched.pseudonym, index: i });
      i += matched.original.length;
    } else {
      out += text[i];
      i += 1;
    }
  }

  return { text: out, hits };
}

/**
 * Inverse of `pseudonymize`: map each pseudonym back to its canonical name.
 *
 * Variants are lossy — they all collapse onto the pseudonym — so restoration
 * always yields the canonical form (e.g. "夏夏" -> "甲" -> "知夏"). Text that
 * used the canonical name round-trips exactly.
 */
export function depseudonymize(text: string, dict: PersonDict): string {
  const map = new Map<string, string>();
  for (const entry of dict) {
    if (entry.pseudonym.length > 0) map.set(entry.pseudonym, entry.canonical);
  }
  const pseudonyms = [...map.keys()].sort(byLengthDesc);

  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    let matched: string | undefined;
    for (const p of pseudonyms) {
      if (text.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      out += map.get(matched);
      i += matched.length;
    } else {
      out += text[i];
      i += 1;
    }
  }

  return out;
}

/**
 * Flag fragments that must not reach an LLM egress point.
 *
 * Two kinds, and both of them block:
 *
 *   - `residual_pii` — the regex layer still recognizes a phone / email /
 *     WeChat / ID pattern, which means the scrub did not hold.
 *   - `unregistered_name` — the text names a person the dictionary does not
 *     hold, so that name would leave this machine as itself. This is the second
 *     sentence of HARD RULE #3 ("an unregistered person name blocks egress"),
 *     which until now was documented as deferred and therefore was not true.
 *
 * The name half is deliberately conservative and Latin-script only; see
 * `names.ts` for what it does, what it refuses to guess at, and why the two
 * halves of the name rule over- and under-block in opposite directions.
 */
export function detectUnregisteredNames(
  text: string,
  dict: PersonDict,
): NameWarning[] {
  const { matches } = scrubPii(text);
  const residual = matches.map((m) => ({
    kind: "residual_pii" as const,
    original: m.original,
    index: text.indexOf(m.original),
    detail: `Residual ${m.type} pattern detected; scrub before egress.`,
  }));

  return [...residual, ...detectPersonNames(text, dict)];
}
