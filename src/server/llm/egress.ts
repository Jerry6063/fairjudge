// The mandatory egress checkpoint in front of every provider call — HARD RULE #3.
//
// Order is fixed and non-negotiable: dictionary pseudonymization first (so real
// names collapse onto 甲/乙 before anything else looks at the text), then the
// regex PII scrub (phone / email / WeChat / national ID). The person dictionary
// may be empty in M1; the regex layer runs regardless.
//
// The placeholder map is process-local state on this object: it is never
// persisted and never serialized into a request. Restoration happens on the way
// back, so the model only ever sees pseudonyms and placeholders.

import {
  depseudonymize,
  detectUnregisteredNames,
  pseudonymize,
  restorePii,
  scrubPii,
  type NameWarning,
  type PersonDict,
  type PiiMatch,
  type PiiType,
} from "../pseudonym";

/** Matches a numbered PII placeholder emitted by `scrubPii`. */
const PLACEHOLDER = /\{\{(?:PHONE|EMAIL|WECHAT|ID)_\d+\}\}/g;

/** How far back a restoration goes. See `EgressPipeline.restore`. */
export interface RestoreOptions {
  /** Default true — put the canonical names back for display. */
  readonly pseudonyms?: boolean;
}

/**
 * One outbound conversation's scrub state.
 *
 * `scrubPii` numbers placeholders per call, so scrubbing several texts
 * independently would reuse `{{PHONE_1}}` for two different numbers. This class
 * renumbers each call's local placeholders into a conversation-wide namespace,
 * keeping one placeholder per distinct value across the whole request.
 */
export class EgressPipeline {
  private readonly dict: PersonDict;
  /** Next unused index per PII type, conversation-wide. */
  private readonly counters = new Map<PiiType, number>();
  /** `${type}\u0000${original}` -> conversation-wide placeholder. */
  private readonly assigned = new Map<string, string>();
  /** Conversation-wide placeholder -> original value, for restoration. */
  private readonly matches: PiiMatch[] = [];

  constructor(dict: PersonDict = []) {
    this.dict = dict;
  }

  /**
   * Run one outbound text through the gateway. Safe to call repeatedly: already
   * pseudonymized text and existing placeholders pass through untouched.
   */
  apply(text: string): string {
    const { text: masked } = pseudonymize(text, this.dict);
    const { text: scrubbed, matches } = scrubPii(masked);

    // Map this call's local placeholders onto conversation-wide ones, then
    // rewrite in a single pass so a local "{{PHONE_1}}" that becomes
    // "{{PHONE_2}}" can never be re-matched by a later substitution.
    const localToGlobal = new Map<string, string>();
    for (const match of matches) {
      localToGlobal.set(match.placeholder, this.globalPlaceholder(match));
    }
    return scrubbed.replace(
      PLACEHOLDER,
      (found) => localToGlobal.get(found) ?? found,
    );
  }

  /**
   * Final assertion before the payload leaves the process: anything the regex
   * layer still recognizes as PII means the scrub did not hold, and egress must
   * be blocked rather than "mostly" masked.
   */
  residualPii(text: string): NameWarning[] {
    return detectUnregisteredNames(text, this.dict);
  }

  /**
   * Restore a model-produced display string: PII placeholders back to their
   * values, then pseudonyms back to canonical names. Both mappings are local —
   * this runs after the response is already in the process.
   *
   * `pseudonyms: false` restores the placeholders and stops there, leaving 甲/乙
   * as the model wrote them. That is the right answer whenever the value is
   * about to be **stored** rather than displayed: a judgment is written in
   * pseudonyms, validated against a record keyed by pseudonyms, and shared with
   * a party who receives it as a document. Putting the real names back on the
   * way in would make the stored artifact the one place the mapping table is
   * unwound, which is the opposite of what HARD RULE #3 is for. PII placeholders
   * are restored either way: a `{{PHONE_1}}` inside a verbatim quote is a hole
   * in the evidence, not a protection.
   */
  restore(text: string, options: RestoreOptions = {}): string {
    const filled = restorePii(text, this.matches);
    return options.pseudonyms === false ? filled : depseudonymize(filled, this.dict);
  }

  /** Deep-restore every string in a parsed structured-output value. */
  restoreDeep<T>(value: T, options: RestoreOptions = {}): T {
    return this.walk(value, options) as T;
  }

  private walk(value: unknown, options: RestoreOptions): unknown {
    if (typeof value === "string") return this.restore(value, options);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, options));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.walk(item, options);
      }
      return out;
    }
    return value;
  }

  private globalPlaceholder(match: PiiMatch): string {
    const key = `${match.type}\u0000${match.original}`;
    const existing = this.assigned.get(key);
    if (existing) return existing;

    const next = (this.counters.get(match.type) ?? 0) + 1;
    this.counters.set(match.type, next);
    const placeholder = `{{${match.type}_${next}}}`;
    this.assigned.set(key, placeholder);
    this.matches.push({
      type: match.type,
      placeholder,
      original: match.original,
    });
    return placeholder;
  }
}
