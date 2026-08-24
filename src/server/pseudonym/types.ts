// Shared types for the pseudonymization gateway.
//
// The gateway is the mandatory checkpoint in front of every LLM egress point:
// deterministic dictionary substitution (longest match + variant table) plus
// regex-based PII scrubbing. All functions here are pure — no IO, no global
// mutable state — so the mapping table never has to leave the process.

/** A registered person: real canonical name, its egress pseudonym, and every
 *  nickname / alias variant that should collapse onto the same pseudonym. */
export interface PersonEntry {
  /** The canonical real name, used as the restore target for depseudonymize. */
  canonical: string;
  /** The stable egress token that leaves the process (e.g. "甲", "乙"). */
  pseudonym: string;
  /** Alternative spellings / nicknames that also map to `pseudonym`. */
  variants: string[];
}

/** A person dictionary is just an ordered list of entries. */
export type PersonDict = readonly PersonEntry[];

/** One dictionary substitution performed by `pseudonymize`. */
export interface PseudonymHit {
  /** The exact source substring that matched (canonical or a variant). */
  original: string;
  /** The pseudonym it was replaced with. */
  pseudonym: string;
  /** Zero-based index of the match in the *source* text. */
  index: number;
}

export interface PseudonymizeResult {
  /** The pseudonymized text. */
  text: string;
  /** Every substitution, in left-to-right order of the source text. */
  hits: PseudonymHit[];
}

/** Categories of personally identifiable information the regex layer scrubs. */
export type PiiType = "PHONE" | "EMAIL" | "WECHAT" | "ID";

/** One PII value that was replaced with a numbered placeholder. */
export interface PiiMatch {
  type: PiiType;
  /** The numbered placeholder that replaced the value, e.g. "{{PHONE_1}}". */
  placeholder: string;
  /** The original sensitive value, kept only for local restoration. */
  original: string;
}

export interface ScrubPiiResult {
  /** The text with every PII value replaced by a placeholder. */
  text: string;
  /** Unique (placeholder -> original) pairs, in order of first appearance. */
  matches: PiiMatch[];
}

/** Why a fragment of text is flagged as potentially unregistered / leaking. */
export type NameWarningKind = "residual_pii" | "unregistered_name";

/** A warning surfaced by `detectUnregisteredNames`. */
export interface NameWarning {
  kind: NameWarningKind;
  /** The offending substring. */
  original: string;
  /** Zero-based index of the substring in the inspected text. */
  index: number;
  /** Human-readable explanation for the operator. */
  detail: string;
}
