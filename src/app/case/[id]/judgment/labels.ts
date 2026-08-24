// UI vocabulary for the judgment reading view.
//
// The server speaks in codes (`high_confidence`, `clarification_unanswered`,
// `self_only`); this is the only place those codes become sentences a person
// reads, the same split `src/app/evidence/labels.ts` makes. Keeping the wording
// here rather than in the database means the stored values stay stable machine
// records and the copy can be rewritten without a migration.
//
// Nothing in this file re-words anything the judgment itself wrote. The
// judgment's own prose, the record-basis statement and the level rationale are
// rendered verbatim from storage; what is named here is only the vocabulary of
// the schema around them.

import type { PolishOutcome } from "../../../../server/db/schema";
import type {
  ClaimTier,
  SectionAudience,
  UnresolvedReason,
} from "../../../../server/judgment";

/**
 * The three tiers, said plainly.
 *
 * Not a politeness scale (see the contract's header): these are three different
 * relationships to the record, and `unknown` is a finding of its own rather than
 * a weaker version of the other two.
 *
 * The tiers carry no colour. They used to render as three coloured pills —
 * green, blue, grey — which ranked them: a green claim looked better than a
 * grey one. They are not a scale, so the distinction is carried by the words,
 * and the only tier that gets a mark is `unknown`, because it is the one whose
 * emptiness is deliberate (see the basis rule on its note in `page.tsx`).
 */
export const TIER_LABELS: Record<ClaimTier, { name: string; hint: string }> = {
  high_confidence: {
    name: "Shown by the record",
    hint: "The confirmed lines say this. Cites at least one of them.",
  },
  inferred: {
    name: "A reading of the record",
    hint: "The confirmed lines support reading it this way; they do not state it outright.",
  },
  unknown: {
    name: "The record cannot say",
    hint: "Cites nothing, deliberately. A claim that cited evidence and then called itself unknown would be two contradictory statements in one object.",
  },
};

/* -------------------------------------------------------------------------- */
/* Verbatim evidence inside the judgment's own prose                          */
/* -------------------------------------------------------------------------- */

/**
 * A run of prose split into the judgment's own voice and the words it quotes.
 *
 * The judgment argues in English and quotes the record in Chinese, verbatim and
 * untranslated (CLAUDE.md), inside its own sentences. Those two things are not
 * the same kind of statement: one is the document speaking, the other is a
 * fragment of somebody's actual message sitting inside it. Set identically they
 * read as one voice, and a reader loses the line between what the judgment
 * asserts and what the record contains — which is the single distinction this
 * product exists to hold.
 *
 * So the render layer marks the quoted runs as objects (`.fj-verbatim`: a
 * ground of its own, never italics — a synthetic slant of CJK glyphs is a
 * distortion, not an emphasis).
 *
 * **A quote qualifies only if it contains a CJK character.** Evidence in this
 * product is Chinese by the language policy, so that test separates a quotation
 * of the record from the judgment's ordinary use of quotation marks (naming a
 * stored value, scare-quoting a word). Marking those as evidence would be a
 * false claim about where a phrase came from, and the render layer does not get
 * to make one.
 *
 * Pure and dependency-free so both the document body and the fact layer split
 * the same way.
 */
export interface ProseRun {
  readonly text: string;
  readonly verbatim: boolean;
}

/** Straight quotes, curly quotes, and CJK corner brackets. */
const QUOTED = /("[^"]*"|“[^”]*”|「[^」]*」)/g;

/** Han, kana, and the CJK punctuation that travels with them. */
const HAS_CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** The same shape, anchored — `split` hands back whole quotes, so test whole. */
const IS_QUOTED = new RegExp(`^(?:${QUOTED.source.slice(1, -1)})$`);

export function splitVerbatim(prose: string): readonly ProseRun[] {
  const runs: ProseRun[] = [];
  for (const piece of prose.split(QUOTED)) {
    if (piece === "") continue;
    runs.push({
      text: piece,
      verbatim: IS_QUOTED.test(piece) && HAS_CJK.test(piece),
    });
  }
  return runs;
}

/** What a narrative section is doing. */
export const SECTION_KIND_LABELS: Record<string, string> = {
  finding: "A finding — rests on claims",
  disclosure: "About this judgment, not about the case",
  limits: "What this judgment cannot decide",
};

/**
 * The stored `audience` marking, named as a stored value.
 *
 * Deliberately not phrased as a guarantee. The marking is what a filtered copy
 * would act on; whether it is marked correctly is not something this screen can
 * verify, and there is an open defect in how the rule behaves once both parties
 * are in the record. So the copy describes the field, and claims nothing about
 * whether it is right.
 */
export const AUDIENCE_LABELS: Record<SectionAudience, string> = {
  both: 'marked "both"',
  self_only: 'marked "self_only"',
};

/** Why a question the case raised is still open. */
export const UNRESOLVED_REASON_LABELS: Record<UnresolvedReason, string> = {
  clarification_unanswered: "Put to you during clarification and never answered",
  record_silent: "The confirmed record does not contain the answer",
  outside_scope: "Outside what this product decides",
};

/** How a responsibility allocation reads. */
export const ALLOCATION_LABELS: Record<string, string> = {
  primary: "Primary",
  shared: "Shared",
  contributing: "Contributing",
  not_established: "Not established",
};

/**
 * What happened to the polished draft, on the judgments that carry an archived
 * polish run.
 *
 * Past tense throughout: the layer these describe was removed on 2026-08-16
 * (doc 02 §1.1a), and every one of these sentences is now a statement about
 * something that happened to a particular judgment rather than about how the
 * product behaves. A judgment with no archived run renders no such sentence at
 * all — see `judgment-document.tsx`.
 */
export const POLISH_OUTCOME_LABELS: Record<PolishOutcome, string> = {
  applied:
    "The polished wording was accepted, so the text above is the polished version.",
  rejected:
    "The polished wording failed validation and was discarded. The text above is the original.",
  failed:
    "The polish call failed. The text above is the original, which is what a failure was supposed to cost.",
  skipped:
    "No polish was performed. The text above is the original, exactly as it was written.",
};

/* -------------------------------------------------------------------------- */
/* The polish archive, in provenance                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the archived row establishes, and nothing beyond it.
 *
 * This copy replaces a sentence that said a second vendor "rewrote the phrasing
 * of the narrative" on every judgment carrying a run. On the real judgment the
 * run is `skipped` — the vendor returned HTTP 401 and the stage never executed —
 * so the screen asserted a rewrite that never happened, four lines above the
 * evidence that it had not. Doc 04 §2.2 lists it first among the screens that
 * assert something untrue.
 *
 * The fix is structural rather than a softer adjective: the preamble states only
 * that a layer was configured, and the sentence about THIS judgment is selected
 * by the row's own outcome. Only `applied` may say anything was rewritten,
 * because only `applied` ever wrote the polished draft back.
 */
export const POLISH_ARCHIVE_PREAMBLE =
  "While this judgment was produced, a language-polish layer was configured on " +
  "this product: a second vendor would be handed the narrative's surface wording " +
  "with the quotes, numbers, confidences, grades and dates lifted out into " +
  "placeholders first, so the facts were physically absent from the request " +
  "rather than protected by asking. That layer has since been removed. What the " +
  "archived row below establishes is what it did here:";

/** One sentence per outcome. Only `applied` describes a rewrite. */
export const POLISH_ARCHIVE_WHAT_HAPPENED: Record<PolishOutcome, string> = {
  applied:
    "the polished wording came back, passed validation and was written onto this " +
    "judgment — the phrasing above was rewritten by the second vendor. The " +
    "claims, quotes, numbers and grades are unchanged, because it never saw them.",
  rejected:
    "the polished wording came back and was refused by validation. Nothing it " +
    "wrote reached this judgment — the text above is the original wording.",
  failed:
    "the call failed and nothing came back. No wording here was changed, which is " +
    "what a failure was supposed to cost.",
  skipped:
    "it never ran. Nothing of this judgment was sent to the second vendor, nothing " +
    "came back, and the wording above is exactly what the judgment model wrote.",
};

/** A row with no outcome. It still may not be read as a rewrite. */
export const POLISH_ARCHIVE_UNKNOWN =
  "the row records no outcome, so this screen cannot say what happened on this " +
  "judgment. It does not assert that anything was rewritten; only a run recorded " +
  "as applied ever changed a judgment's wording.";
