/**
 * The export gate — SPEC M4 ⑥. The last thing that runs before a copy of a
 * judgment leaves this machine.
 *
 * Everything upstream of here is about being right. This is about what happens
 * when a document produced from one person's account of their relationship is
 * handed to somebody else, on purpose, and cannot be taken back.
 *
 * Six rules, in the order they run:
 *
 *   1. **Only a shareable rendition leaves.** `self_reflection` carries the
 *      criticism written for the client alone; there is no export of it, the same
 *      way there is no share token for it. The rule has one definition
 *      (`assertShareTokenAllowed`) and this path calls it rather than restating
 *      it, because two copies of "which kinds may leave" is one copy too many.
 *   1b. **Consent, once the recipient is known** (SPEC M5 ③). A party who has
 *      withdrawn consent for documents naming them closes this door while the
 *      withdrawal stands — same guard, same single definition in
 *      `access/consent`, asked a second time now that the export knows who the
 *      copy is for. It refuses before any audit row is written, and it says what
 *      it cannot undo: copies exported before the revocation are on somebody
 *      else's machine and there is no recall.
 *   2. **Metadata is stripped before anything is inspected.** Front matter, HTML
 *      comments and every invisible character class — zero-width spaces, bidi
 *      controls, Unicode tag characters — are removed. Those are where a name, a
 *      fingerprint or an instruction hides from a reader and from a check.
 *   3. **The pseudonym dictionary is scanned, and a hit blocks.** A real name or
 *      a registered nickname in a document about to be handed over is the failure
 *      HARD RULE #3 exists to prevent, arriving at the one moment it cannot be
 *      undone. The export is refused and the hit is named — which name, which
 *      pseudonym it should have been, and where.
 *   4. **The quote rule, scoped by attribution.** A verbatim quote longer than
 *      {@link MAX_THIRD_PARTY_QUOTE_CHARS} characters is refused **only when it
 *      is not the recipient's own words**. See below.
 *   5. **Watermark, then the share gate again, on the actual bytes.** The
 *      watermark goes on top so the framed document underneath is unchanged, and
 *      `assertShareable` runs over the finished text — the label, the invitation,
 *      the response entry point, the win/lose vocabulary, the responsibility
 *      percentage, and every check that the copy is not addressed to the client.
 *
 * Then one audit row, and only then. A blocked export writes nothing, because
 * what this table audits is egress and a refused document never left.
 *
 * ## The quote rule, and why a blanket length filter was wrong
 *
 * The >15-character restriction exists to stop a judgment shared publicly from
 * re-identifying the people in it: a long verbatim line is a fingerprint of the
 * person who wrote it. Applied to the counterparty's own messages, in the copy
 * being handed to the counterparty, it strips exactly the evidence she is
 * entitled to check — the quotes are the reason to believe any of it, and she
 * already knows what she wrote. So the rule is attribution-scoped (SPEC M4
 * decision record, 2026-08-10): the recipient's own words pass at any length,
 * and somebody else's do not.
 *
 * Attribution is lexical and deliberately conservative: the speaker is the party
 * named before the speech verb the quote hangs off ("you stated that …", "乙 put
 * it this way: …"), and a quote nobody is named as speaking falls under the rule.
 * That direction is chosen — a long quote whose speaker this gate cannot
 * establish is precisely the re-identification case the rule is for. The exact
 * shape of the test, and the sentence in the real judgment that forced it, are
 * in `isRecipientQuote`.
 *
 * And it **blocks** rather than trimming. Truncating a quote would edit evidence
 * to pass our own test (CLAUDE.md: quoted material is a verbatim record and is
 * never rewritten), and would hand the recipient a document whose quotes are
 * quietly not what was said.
 *
 * ## Why blocking is the only failure mode here
 *
 * Every check in this module refuses the whole export and says what it found.
 * Nothing is silently removed, softened or masked, because the artifact is the
 * one thing this product makes that reaches a person who never agreed to any of
 * it: a gate that quietly fixes documents is a gate whose failures are invisible
 * in the only place they matter.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";

import {
  NamedRenditionRevokedError,
  type NamedRenditionContext,
} from "../access/consent";
import type { Db } from "../db";
import {
  EXPORT_CHANNELS,
  caseParticipants,
  judgmentExports,
  judgmentRenditions,
  type ExportChannel,
  type RenditionKind,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { detectUnregisteredNames, type PersonDict } from "../pseudonym";
import {
  JudgmentStoreError,
  assertShareTokenAllowed,
  readJudgment,
  type JudgmentRecord,
} from "./contract";
import {
  DEFAULT_RESPONSE_ENTRY_POINT,
  assertShareable,
  renderJudgmentRendition,
  RenditionError,
} from "./rendition";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How long a verbatim quote by someone other than the recipient may be.
 *
 * Characters, counted as code points. Fifteen is short enough that what survives
 * is a phrase rather than a passage, which is the line between citing something
 * and reproducing it.
 */
export const MAX_THIRD_PARTY_QUOTE_CHARS = 15;

/**
 * Channels this product will not export to, named so the refusal can say what it
 * is refusing.
 *
 * There is no code in this module that posts anywhere — no network call, no
 * intent handler, no clipboard-to-app bridge — so this list is not what makes a
 * one-click share impossible. It exists so that asking for one gets an answer
 * instead of a shrug: the missing feature is a decision, and a decision should be
 * legible at the point somebody reaches for it.
 */
export const REFUSED_SHARE_CHANNELS = [
  "wechat",
  "wechat_moments",
  "weibo",
  "xiaohongshu",
  "douyin",
  "qq",
  "qzone",
  "twitter",
  "x",
  "facebook",
  "instagram",
  "threads",
  "telegram",
  "reddit",
  "social",
] as const;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type ExportRefusalCode =
  /** The kind may never leave (self_reflection), or the row says not shareable. */
  | "not_shareable"
  /** A registered real name or nickname variant is in the document. */
  | "real_name_present"
  /** A name the dictionary does not know — reserved for the NER seam. */
  | "unregistered_name"
  /** A phone number, email, WeChat handle or ID survived into the document. */
  | "residual_pii"
  /** A long verbatim quote that is not the recipient's own words. */
  | "third_party_quote"
  /** A party withdrew consent for documents naming them, and it still stands. */
  | "consent_revoked"
  /** A one-click social share. Not a missing feature; a refused one. */
  | "social_share_refused"
  | "unknown_channel"
  | "judgment_not_found"
  /** A draft is work in progress; nothing is exported out of one. */
  | "not_final"
  | "rendition_missing"
  /** Who is receiving this could not be established, and it is audited. */
  | "recipient_unknown";

export interface ExportViolation {
  readonly code: ExportRefusalCode;
  /** One sentence naming what is wrong, readable by the person exporting. */
  readonly detail: string;
  /** The offending fragment, when there is one to point at. */
  readonly excerpt?: string;
}

export class ExportBlockedError extends Error {
  readonly code: ExportRefusalCode;
  readonly violations: readonly ExportViolation[];

  constructor(
    code: ExportRefusalCode,
    message: string,
    violations: readonly ExportViolation[] = [],
  ) {
    super(message);
    this.name = "ExportBlockedError";
    this.code = code;
    this.violations = violations;
  }
}

function blocked(
  code: ExportRefusalCode,
  violations: readonly ExportViolation[],
): ExportBlockedError {
  return new ExportBlockedError(
    code,
    `This copy may not leave the machine:\n` +
      violations
        .map(
          (violation) =>
            `  - [${violation.code}] ${violation.detail}` +
            (violation.excerpt === undefined ? "" : `\n      …${violation.excerpt}…`),
        )
        .join("\n"),
    violations,
  );
}

/**
 * What may be exported — the share-token guard, applied to export.
 *
 * `assertShareTokenAllowed` is the single definition of both rules that decide
 * whether a copy may leave at all: which kinds are shareable, and whether the
 * people named in it still consent (SPEC M5 ③). It is called rather than copied.
 * Its refusals are caught and re-thrown so a caller of the export path has one
 * error type and a message about exporting; the codes are the same rules under
 * both doors.
 *
 * Passing `consent` is what turns the second rule on. It is optional for the
 * same reason it is optional upstream: the kind is answerable immediately, the
 * case is not known until the judgment has been read.
 */
export function assertExportAllowed(
  kind: RenditionKind,
  consent?: NamedRenditionContext,
): void {
  try {
    assertShareTokenAllowed(kind, consent);
  } catch (error) {
    if (error instanceof NamedRenditionRevokedError) {
      // The whole message, verbatim: it already names who withdrew, when, in
      // their own words, and which copies had left before they did. Shortening
      // it here is how a UI ends up printing "blocked" and nothing else.
      throw blocked("consent_revoked", [
        { code: "consent_revoked", detail: error.message },
      ]);
    }
    /* c8 ignore next -- assertShareTokenAllowed throws nothing else. */
    if (!(error instanceof JudgmentStoreError)) throw error;
    throw blocked("not_shareable", [
      {
        code: "not_shareable",
        detail:
          `A "${kind}" rendition is the copy written for the client alone — it ` +
          `carries the criticism aimed at them. It is not exported, the same way ` +
          `no share token is minted for it: ${error.message}`,
      },
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/* Metadata stripping                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Characters that carry information no reader can see.
 *
 * Zero-width spaces and joiners, the bidirectional overrides, the word joiner
 * block, the deprecated format controls, the byte-order mark, and the Unicode
 * tag block (U+E0000–U+E007F) — the last one being the standard way to hide a
 * whole string of text inside a document that renders as if it were not there.
 * All of them are how a document gets fingerprinted per-recipient, and how text
 * gets smuggled past a check that is looking at what a person would read.
 */
const INVISIBLE_CHARACTERS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

/** A YAML front-matter block, only when it opens the document. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

/** HTML comments — invisible to a reader, present in the file. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Remove everything that is in the document but not in the reading of it.
 *
 * Run before every other check, so a name hidden in a comment is either gone or
 * caught, never both invisible and present. It is also the whole of what
 * "metadata-stripped export" means for a text document: this function's output
 * carries no author, no tool string, no timestamps and no per-copy invisible
 * marking, and the only provenance on the finished export is the watermark line
 * a reader can see.
 *
 * The evidence is untouched by this: verbatim Chinese contains none of these
 * characters, and nothing here rewrites a visible character.
 */
export function stripExportMetadata(text: string): string {
  return text
    .replace(FRONT_MATTER, "")
    .replace(HTML_COMMENT, "")
    .replace(INVISIBLE_CHARACTERS, "")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* The name scan                                                              */
/* -------------------------------------------------------------------------- */

export type NameHitKind =
  /** The registered real name itself. */
  | "canonical"
  /** A registered nickname or alternative spelling. */
  | "variant"
  /** A fragment derived from the registered name — see `deriveNameFragments`. */
  | "derived_fragment";

export interface NameHit {
  readonly kind: NameHitKind;
  /** The exact text that matched. */
  readonly found: string;
  /** The pseudonym this document should have been carrying instead. */
  readonly pseudonym: string;
  /** Where it is, so the operator can go and look at it. */
  readonly index: number;
}

/** Escape a dictionary entry for use inside a pattern. It is data, not a regex. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A matcher for one name. Word boundaries are added only for names that begin
 * and end in ASCII, because `\b` is meaningless between two Han characters and
 * would make a Chinese name unmatchable in running text.
 */
function nameMatcher(name: string): RegExp {
  const escaped = escapeForPattern(name);
  const ascii = /^[A-Za-z0-9]/.test(name) && /[A-Za-z0-9]$/.test(name);
  return new RegExp(ascii ? `\\b${escaped}\\b` : escaped, "i");
}

const CJK_ONLY = /^[㐀-䶿一-鿿豈-﫿]+$/u;

/**
 * Fragments of a registered name that are still that person's name.
 *
 * The dictionary holds what somebody remembered to register. The commonest way a
 * real name survives into a document is not the full name — it is the part of it
 * people actually say: the given name without the surname (顾明远 → 明远), or one
 * element of a Latin name (Adrian Cole → Adrian, Cole).
 *
 * This over-blocks by construction — a two-character given name can be an
 * ordinary word — and that is the direction chosen. A blocked export is a
 * sentence to rewrite; an exported real name is a person identified to somebody
 * who was handed a document about their relationship. Every hit says which of
 * the three ways it was found, so an operator can see when it is this one.
 *
 * Single characters are never derived: one Han character is a word far more often
 * than it is a name, and a check that fires on every 明 in the document is a check
 * that gets turned off.
 */
export function deriveNameFragments(canonical: string): string[] {
  const name = canonical.trim();
  if (name.length === 0) return [];
  const out: string[] = [];

  if (CJK_ONLY.test(name)) {
    const chars = Array.from(name);
    // Given name after a one-character family name, then after a two-character
    // one (欧阳明远 → 明远). Both only when what is left is at least two chars.
    if (chars.length >= 3) out.push(chars.slice(1).join(""));
    if (chars.length >= 4) out.push(chars.slice(2).join(""));
  } else {
    for (const part of name.split(/\s+/)) {
      if (part.length >= 3) out.push(part);
    }
  }

  return [...new Set(out)].filter((part) => part.length > 0 && part !== name);
}

/**
 * Scan a document for anything in the pseudonym dictionary.
 *
 * Returns every hit rather than the first, so the refusal names the whole problem
 * and the document is fixed once.
 */
export function scanRealNames(text: string, dict: PersonDict): NameHit[] {
  const hits: NameHit[] = [];

  const record = (
    kind: NameHitKind,
    name: string,
    pseudonym: string,
  ): void => {
    if (name.length === 0) return;
    const match = nameMatcher(name).exec(text);
    if (match === null) return;
    hits.push({ kind, found: match[0], pseudonym, index: match.index });
  };

  for (const entry of dict) {
    record("canonical", entry.canonical, entry.pseudonym);
    for (const variant of entry.variants) {
      record("variant", variant, entry.pseudonym);
    }
    for (const fragment of deriveNameFragments(entry.canonical)) {
      record("derived_fragment", fragment, entry.pseudonym);
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

function nameViolations(text: string, dict: PersonDict): ExportViolation[] {
  const violations: ExportViolation[] = [];

  for (const hit of scanRealNames(text, dict)) {
    const how =
      hit.kind === "canonical"
        ? "a registered real name"
        : hit.kind === "variant"
          ? "a registered nickname or alternative spelling"
          : "a fragment of a registered real name (a given name on its own)";
    violations.push({
      code: "real_name_present",
      detail:
        `The document contains "${hit.found}" — ${how}, which should be ` +
        `"${hit.pseudonym}" everywhere outside this machine. A copy handed to ` +
        `another person identifies whoever is in it, permanently, and the ` +
        `mapping table is the one thing that never leaves (HARD RULE #3).`,
      excerpt: excerptAround(text, hit.index),
    });
  }

  // The same seam wave-A egress uses. Today it reports residual PII; when name
  // recognition lands behind it, the export gate gets it without a change here.
  for (const warning of detectUnregisteredNames(text, dict)) {
    violations.push({
      code:
        warning.kind === "residual_pii" ? "residual_pii" : "unregistered_name",
      detail:
        `${warning.detail} Found "${warning.original}" in a document about to ` +
        `be handed to somebody.`,
      excerpt:
        warning.index < 0 ? undefined : excerptAround(text, warning.index),
    });
  }

  return violations;
}

function excerptAround(text: string, index: number, span = 50): string {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}

/* -------------------------------------------------------------------------- */
/* The quote rule                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Quotation marks that open a verbatim span in this product's documents.
 *
 * Curly doubles and both CJK forms, plus straight doubles. Single quotes are
 * deliberately absent: they are apostrophes far more often than quotations in
 * English prose, and treating one as a quote opener would make the rule fire on
 * "the client's account".
 */
const QUOTE_PAIRS: readonly { readonly open: string; readonly close: string }[] = [
  { open: "“", close: "”" }, // “ ”
  { open: "「", close: "」" }, // 「 」
  { open: "『", close: "』" }, // 『 』
  { open: '"', close: '"' },
];

export interface QuoteSpan {
  /** What is between the marks, exactly as written. Never edited. */
  readonly content: string;
  /** Length in code points — one Han character is one character. */
  readonly length: number;
  /** Index of the opening mark in the scanned text. */
  readonly index: number;
  /** The pair that delimited it, e.g. `“”`. */
  readonly marks: string;
}

/** Every verbatim span in a document, in the order they appear. */
export function findVerbatimQuotes(text: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];

  for (const { open, close } of QUOTE_PAIRS) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(open, cursor);
      if (start === -1) break;
      const closeAt = text.indexOf(close, start + open.length);
      if (closeAt === -1) break;
      const content = text.slice(start + open.length, closeAt);
      spans.push({
        content,
        length: Array.from(content).length,
        index: start,
        marks: `${open}${close}`,
      });
      cursor = closeAt + close.length;
    }
  }

  return spans.sort((a, b) => a.index - b.index);
}

/** Second person — in a shareable copy, this is the recipient and nobody else. */
const SECOND_PERSON = /\b(you|your|yours|yourself)\b/gi;

/** Sentence boundaries, in both scripts. */
const SENTENCE_BOUNDARY = /[.!?。！？\n]/;

/** The run of text from the start of the sentence up to a given index. */
function sentenceHead(text: string, index: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start - 1])) start -= 1;
  return text.slice(start, index);
}

export interface QuoteAudience {
  /** The pseudonym of the person this copy is being handed to. */
  readonly recipientPseudonym: string;
  /** Every other party who could be the speaker of a quote. */
  readonly otherPseudonyms: readonly string[];
}

/**
 * Whoever is named as speaking. Ordinary English attribution, nothing clever.
 *
 * Used to find the speech verb the quote hangs off, so the speaker can be read
 * as the party named before that verb rather than as whichever party the
 * sentence happens to mention last.
 */
const SPEECH_VERBS =
  /\b(said|says|saying|stated|states|stating|wrote|writes|writing|puts?\s+it|putting\s+it|asked|asks|told|tells|reported|reports|describes?|described|answered|answers|replied|replies|recalls?|recalled|quotes?|quoted|according\s+to)\b/gi;

interface SpeakerMark {
  readonly index: number;
  readonly isRecipient: boolean;
}

/** Every party named in a run of text, in order, tagged by who they are. */
function speakerMarks(head: string, audience: QuoteAudience): SpeakerMark[] {
  const marks: SpeakerMark[] = [];

  SECOND_PERSON.lastIndex = 0;
  for (const match of head.matchAll(SECOND_PERSON)) {
    marks.push({ index: match.index ?? 0, isRecipient: true });
  }
  const named: readonly { readonly name: string; readonly isRecipient: boolean }[] = [
    { name: audience.recipientPseudonym, isRecipient: true },
    ...audience.otherPseudonyms.map((name) => ({ name, isRecipient: false })),
  ];
  for (const { name, isRecipient } of named) {
    if (name.length === 0) continue;
    let cursor = 0;
    for (;;) {
      const at = head.indexOf(name, cursor);
      if (at === -1) break;
      marks.push({ index: at, isRecipient });
      cursor = at + name.length;
    }
  }

  return marks.sort((a, b) => a.index - b.index);
}

/**
 * The attribution test, stated once: is this quote the recipient's own words?
 *
 * The rule is "who is named as speaking", read off the sentence the quote sits
 * in: take the last speech verb before the quote, and the speaker is the last
 * party named before that verb. No speech verb, and it is the last party named
 * at all. No party named, and the quote is not attributed to anyone — which
 * fails, because an unattributed long quote is exactly the re-identification
 * case this rule exists for.
 *
 * The first version of this asked something simpler — "does the run-up name the
 * recipient and nobody else" — and a stored judgment refuted it with a sentence
 * of this shape (illustrated with invented text): "The confirmed record shows
 * you stated that 乙 mixed up the reservation date: “订位的日子他记错了也不核对，
 * 到了饭店才发现根本没有位子”." Those are the recipient's own words about the other
 * party, which is what most of a one-sided judgment's evidence looks like, and
 * merely mentioning 乙 does not make him the speaker. The verb does: `you stated`.
 *
 * Still lexical, still partial, and still biased towards refusing — "乙 told you
 * that 甲 had said" will defeat it, and a refusal is a sentence to rewrite while
 * a wrong pass is somebody's words handed to a third party.
 */
export function isRecipientQuote(
  text: string,
  quote: QuoteSpan,
  audience: QuoteAudience,
): boolean {
  const head = sentenceHead(text, quote.index);
  const marks = speakerMarks(head, audience);
  if (marks.length === 0) return false;

  SPEECH_VERBS.lastIndex = 0;
  let lastVerb = -1;
  for (const match of head.matchAll(SPEECH_VERBS)) lastVerb = match.index ?? -1;

  const beforeVerb =
    lastVerb === -1 ? marks : marks.filter((mark) => mark.index < lastVerb);
  const speaker =
    beforeVerb.length > 0
      ? beforeVerb[beforeVerb.length - 1]
      : marks[marks.length - 1];

  return speaker.isRecipient;
}

/**
 * Apply the quote rule.
 *
 * The recipient's own words pass at any length — they are the evidence basis of
 * the document she is holding, and she wrote them. Everybody else's are capped,
 * and a quote over the cap refuses the export rather than being trimmed: a
 * shortened quote is an edited record.
 */
export function checkQuoteAttribution(
  text: string,
  audience: QuoteAudience,
): ExportViolation[] {
  const violations: ExportViolation[] = [];

  for (const quote of findVerbatimQuotes(text)) {
    if (quote.length <= MAX_THIRD_PARTY_QUOTE_CHARS) continue;
    if (isRecipientQuote(text, quote, audience)) continue;

    violations.push({
      code: "third_party_quote",
      detail:
        `A ${quote.length}-character verbatim quote is reproduced without ` +
        `being attributed to ${audience.recipientPseudonym}, the person ` +
        `receiving this copy. Over ${MAX_THIRD_PARTY_QUOTE_CHARS} characters, ` +
        `somebody else's exact words identify them to whoever reads this. The ` +
        `recipient's own words are exempt — they are what this document rests ` +
        `on and she already knows she wrote them — so either attribute this ` +
        `quote to her plainly in the same sentence, or say what it means in the ` +
        `judgment's own words. It is not shortened here: a trimmed quote is an ` +
        `edited record.`,
      excerpt: `${quote.marks[0]}${quote.content}${quote.marks[1]}`,
    });
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* The watermark                                                              */
/* -------------------------------------------------------------------------- */

export interface WatermarkInput {
  /** The audit row's id. What makes a leaked copy traceable to one export. */
  readonly exportId: string;
  readonly judgmentVersion: number;
  readonly exportedAt: Date;
}

/**
 * The line every exported copy opens with.
 *
 * It carries the export id and nothing about the recipient. That is the point:
 * the id resolves to the audit row on this machine, which knows who received it,
 * so the copy is traceable without the copy itself naming anyone. A watermark
 * that printed the recipient's name would be a privacy leak stamped onto the
 * document by the privacy machinery.
 *
 * It goes at the TOP, above the one-sided-material label, so the framed document
 * underneath is untouched — the label still opens the judgment, the response
 * entry point is still the last thing the reader sees, and `assertShareable` can
 * be run again over the finished bytes.
 *
 * The date is the UTC day, in ISO form, with hyphens rather than slashes — the
 * shareable language check reads `08/10` as a numeric split and would refuse the
 * document over its own watermark.
 */
export function composeWatermark(input: WatermarkInput): string {
  const day = input.exportedAt.toISOString().slice(0, 10);
  return (
    `fairjudge · export ${input.exportId.slice(0, 8)} · judgment v${input.judgmentVersion} · ${day} · ` +
    `written by a machine from one person's account; this copy is traceable to ` +
    `this export`
  );
}

/* -------------------------------------------------------------------------- */
/* The audit                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExportAuditRecord {
  readonly id: string;
  readonly caseId: string;
  readonly judgmentId: string;
  readonly renditionId: string | null;
  readonly kind: RenditionKind;
  readonly judgmentVersion: number;
  readonly renditionRevision: number;
  readonly recipientPseudonym: string;
  readonly recipientParticipantId: string | null;
  readonly channel: ExportChannel;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly watermark: string;
  readonly exportedAt: Date;
}

type ExportRow = typeof judgmentExports.$inferSelect;

function toAudit(row: ExportRow): ExportAuditRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    judgmentId: row.judgmentId,
    renditionId: row.renditionId,
    kind: row.kind,
    judgmentVersion: row.judgmentVersion,
    renditionRevision: row.renditionRevision,
    recipientPseudonym: row.recipientPseudonym,
    recipientParticipantId: row.recipientParticipantId,
    channel: row.channel,
    contentSha256: row.contentSha256,
    byteSize: row.byteSize,
    watermark: row.watermark,
    exportedAt: row.exportedAt,
  };
}

/** Every copy of one judgment that left, newest first. */
export function listExports(db: Db, judgmentId: string): ExportAuditRecord[] {
  return db
    .select()
    .from(judgmentExports)
    .where(eq(judgmentExports.judgmentId, judgmentId))
    .orderBy(desc(judgmentExports.exportedAt))
    .all()
    .map(toAudit);
}

/** Every copy of anything on one case that left, oldest first. */
export function listCaseExports(db: Db, caseId: string): ExportAuditRecord[] {
  return db
    .select()
    .from(judgmentExports)
    .where(eq(judgmentExports.caseId, caseId))
    .orderBy(asc(judgmentExports.exportedAt))
    .all()
    .map(toAudit);
}

/* -------------------------------------------------------------------------- */
/* The export                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExportRecipient {
  /** Pseudonym of the person receiving the copy. Never a real name. */
  readonly pseudonym?: string;
  readonly participantId?: string;
}

export interface ExportRequest {
  readonly judgmentId: string;
  /** Defaults to `shareable`; `self_reflection` is refused. */
  readonly kind?: RenditionKind;
  /** How it leaves. Anything social is refused by name. */
  readonly channel: string;
  /** Who gets it. Defaults to the case's non-submitting participant. */
  readonly recipient?: ExportRecipient;
  /**
   * The dictionary the document is scanned against. Defaults to the case's own
   * (`buildCaseDict`); a caller with registered nickname variants passes them
   * here, since the participant table has nowhere to store one yet.
   */
  readonly dict?: PersonDict;
  /** Where the other party can reply; embedded in the document's last line. */
  readonly responseEntryPoint?: string;
  /** Injectable clock, so an audit assertion does not race a real one. */
  readonly now?: Date;
}

export interface ExportedDocument {
  /** Id of the audit row, and the id printed in the watermark. */
  readonly exportId: string;
  readonly caseId: string;
  readonly judgmentId: string;
  readonly judgmentVersion: number;
  readonly kind: RenditionKind;
  readonly recipientPseudonym: string;
  readonly channel: ExportChannel;
  readonly watermark: string;
  /** The bytes that leave: watermarked, metadata-stripped, gate-checked. */
  readonly text: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly exportedAt: Date;
  readonly audit: ExportAuditRecord;
}

/** Resolve the channel, refusing a social share by name. */
function resolveChannel(channel: string): ExportChannel {
  const wanted = channel.trim().toLowerCase();

  if ((EXPORT_CHANNELS as readonly string[]).includes(wanted)) {
    return wanted as ExportChannel;
  }

  if ((REFUSED_SHARE_CHANNELS as readonly string[]).includes(wanted)) {
    throw blocked("social_share_refused", [
      {
        code: "social_share_refused",
        detail:
          `There is no one-click share to ${wanted}, and its absence is a ` +
          `decision rather than a gap. This document is one person's account of ` +
          `a relationship the other person was never asked about; handing it to ` +
          `someone chosen deliberately is what it is for, and posting it is not ` +
          `the same act. Export it as a file and give it to the person it was ` +
          `written for.`,
      },
    ]);
  }

  throw blocked("unknown_channel", [
    {
      code: "unknown_channel",
      detail:
        `"${channel}" is not an export channel. The list is short on purpose: ` +
        `${EXPORT_CHANNELS.join(", ")}.`,
    },
  ]);
}

interface ResolvedRecipient {
  readonly pseudonym: string;
  readonly participantId: string | null;
  readonly others: readonly string[];
}

/**
 * Who is receiving this copy, and who else could be quoted in it.
 *
 * Defaults to the case's non-submitting participant — the counterparty, who is
 * the reader the shareable rendition is written to. Refuses to guess when the
 * case does not answer the question: the recipient decides which quotes are
 * exempt from the length rule and is written into the audit row, so an export to
 * "whoever" is an export whose central check was skipped.
 */
function resolveRecipient(
  db: Db,
  caseId: string,
  judgment: JudgmentRecord,
  request: ExportRequest,
): ResolvedRecipient {
  const participants = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const everyone = new Set<string>(participants.map((row) => row.pseudonym));
  everyone.add(judgment.factLayer.findings.record_basis.client_pseudonym);

  const named = request.recipient;
  let pseudonym: string | undefined;
  let participantId: string | null = null;

  if (named?.participantId !== undefined) {
    const row = participants.find((item) => item.id === named.participantId);
    if (row === undefined) {
      throw blocked("recipient_unknown", [
        {
          code: "recipient_unknown",
          detail:
            `Participant ${named.participantId} is not part of case ${caseId}, ` +
            `so this export has no recipient the audit could name.`,
        },
      ]);
    }
    pseudonym = row.pseudonym;
    participantId = row.id;
  } else if (named?.pseudonym !== undefined && named.pseudonym.trim() !== "") {
    pseudonym = named.pseudonym.trim();
    participantId =
      participants.find((item) => item.pseudonym === pseudonym)?.id ?? null;
  } else {
    const candidates = participants.filter((item) => !item.isSubmitter);
    if (candidates.length !== 1) {
      throw blocked("recipient_unknown", [
        {
          code: "recipient_unknown",
          detail:
            `Case ${caseId} has ${candidates.length} participants who did not ` +
            `bring it, so who this copy is for cannot be inferred. Name the ` +
            `recipient: it decides which quotes are the reader's own words, and ` +
            `it is what the audit row records.`,
        },
      ]);
    }
    pseudonym = candidates[0].pseudonym;
    participantId = candidates[0].id;
  }

  return {
    pseudonym,
    participantId,
    others: [...everyone].filter((value) => value !== pseudonym).sort(),
  };
}

/**
 * Export one rendition of a frozen judgment.
 *
 * Throws `ExportBlockedError` when a check refuses it, and `RenditionError` when
 * the document itself is not one that may be shared — a missing counterparty
 * narrative, a broken frame, a sentence addressed to the client. Both are
 * refusals; they are separate types because they are separate failures, and the
 * second one means the document is wrong rather than the export.
 *
 * On success the returned bytes are exactly what was audited: same string, same
 * sha256, same watermark. Nothing re-renders afterwards.
 */
export function exportRendition(
  db: Db,
  request: ExportRequest,
): ExportedDocument {
  const kind: RenditionKind = request.kind ?? "shareable";
  const now = request.now ?? new Date();

  // 1. May this kind leave at all, and by this route?
  assertExportAllowed(kind);
  const channel = resolveChannel(request.channel);

  const judgment = readJudgment(db, request.judgmentId);
  if (judgment === null) {
    throw blocked("judgment_not_found", [
      {
        code: "judgment_not_found",
        detail: `No judgment with id ${request.judgmentId}.`,
      },
    ]);
  }
  if (judgment.status === "draft") {
    throw blocked("not_final", [
      {
        code: "not_final",
        detail:
          `Judgment ${judgment.id} is a draft. A draft is work in progress and ` +
          `nothing is handed to anyone out of one.`,
      },
    ]);
  }

  const row = db
    .select()
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgment.id),
        eq(judgmentRenditions.kind, kind),
      ),
    )
    .get();

  if (row === undefined) {
    throw blocked("rendition_missing", [
      {
        code: "rendition_missing",
        detail:
          `Judgment ${judgment.id} has no ${kind} rendition. Renditions are ` +
          `minted when a judgment is frozen.`,
      },
    ]);
  }
  // What the database believes, independent of the argument that was passed in.
  if (!row.shareable) {
    throw blocked("not_shareable", [
      {
        code: "not_shareable",
        detail:
          `Rendition ${row.id} (${row.kind}) is stored as not shareable. No ` +
          `copy of it leaves, whatever kind the caller asked for.`,
      },
    ]);
  }

  const entryPoint = request.responseEntryPoint ?? DEFAULT_RESPONSE_ENTRY_POINT;
  const clientPseudonym =
    judgment.factLayer.findings.record_basis.client_pseudonym;

  // 2. Derive the document. This is the share gate's own render path, so the
  //    label, the invitation and the address check have already run once here.
  const view = renderJudgmentRendition(db, judgment, kind, {
    responseEntryPoint: entryPoint,
    clientPseudonym,
  });

  // 3. Strip what a reader cannot see, before anything inspects the text.
  const body = stripExportMetadata(view.text);

  const recipient = resolveRecipient(db, judgment.caseId, judgment, request);

  // 4. Consent, asked with the recipient known — which is why it is here rather
  //    than beside the kind check at the top: a withdrawal aimed at one recipient
  //    ("not to him") is a different sentence from a blanket one, and only this
  //    line knows which one is being asked about. Nothing has been written yet
  //    and nothing has left, so a refusal here costs a render and no more.
  assertExportAllowed(kind, {
    db,
    caseId: judgment.caseId,
    recipientParticipantId: recipient.participantId,
  });

  const dict = request.dict ?? buildCaseDict(db, judgment.caseId);

  // 5. The two content rules, reported together so one pass fixes the document.
  const violations: ExportViolation[] = [
    ...nameViolations(body, dict),
    ...checkQuoteAttribution(body, {
      recipientPseudonym: recipient.pseudonym,
      otherPseudonyms: recipient.others,
    }),
  ];

  if (violations.length > 0) {
    throw blocked(violations[0].code, violations);
  }

  // 6. Watermark, then the share gate over the finished bytes.
  const exportId = randomUUID();
  const watermark = composeWatermark({
    exportId,
    judgmentVersion: judgment.version,
    exportedAt: now,
  });
  const text = `${watermark}\n\n${body}`;

  // The last check, on exactly what leaves. It re-runs the frame, the win/lose
  // vocabulary, the responsibility percentage and the client-address rule over
  // the watermarked document, so the watermark itself cannot be what breaks it.
  assertShareable(text, entryPoint, clientPseudonym);

  const contentSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const byteSize = Buffer.byteLength(text, "utf8");

  const [written] = db
    .insert(judgmentExports)
    .values({
      id: exportId,
      caseId: judgment.caseId,
      judgmentId: judgment.id,
      renditionId: row.id,
      kind,
      judgmentVersion: judgment.version,
      renditionRevision: row.revision,
      recipientPseudonym: recipient.pseudonym,
      recipientParticipantId: recipient.participantId,
      channel,
      contentSha256,
      byteSize,
      watermark,
      exportedAt: now,
    })
    .returning()
    .all();

  const audit = toAudit(written);

  return {
    exportId,
    caseId: judgment.caseId,
    judgmentId: judgment.id,
    judgmentVersion: judgment.version,
    kind,
    recipientPseudonym: recipient.pseudonym,
    channel,
    watermark,
    text,
    contentSha256,
    byteSize,
    exportedAt: audit.exportedAt,
    audit,
  };
}

/**
 * Re-export of the render-layer failure, so a caller of this module can catch
 * both refusals without reaching into `rendition.ts` for the second one.
 */
export { RenditionError };
