/**
 * Dual-version renditions (SPEC M3 wave B ⑪, M4 ①) — two audiences, one frozen
 * fact layer, and one place where the difference between them is decided.
 *
 * ## The two versions
 *
 * `self_reflection` is the copy written for the person who brought the case. It
 * carries **every** section of the judgment's own narrative, including the ones
 * marked `audience: "self_only"` — the criticism directed at the client. That is
 * the half of a judgment that is worth reading and the half nobody wants to
 * forward, and this module never hands it to a share path: `mintShareToken`
 * refuses it in the server, and the refusal is the point, not a UI affordance.
 *
 * `shareable` is the copy the other party may be shown, and since M4 it is a
 * **different narrative**, not a filtered view of the first one. The
 * `shareable_narrative` stage writes it to the counterparty from the same frozen
 * fact layer; this module renders and gates it, adding three things:
 *
 *   1. a **non-removable provenance-and-redistribution notice** at the top,
 *      per level (doc 05 §C amendment 5) — which is also where doc 01's
 *      one-sidedness label now lives, merged in rather than stacked,
 *   2. an ending that **invites a conversation** rather than closing one, and
 *   3. the **other party's response entry point** embedded in that ending.
 *
 * And it forbids three things: win/lose framing, a responsibility percentage,
 * and any sentence that addresses the CLIENT in the second person. A document
 * that reaches the person who was never heard must not tell them they lost, must
 * not put a number on how much of this was theirs — the contract has no numeric
 * responsibility field precisely so no such number can be true — and must not
 * talk to them as if they were their partner.
 *
 * ## The defect the third rule exists for
 *
 * Until M4 the shareable copy was the client-addressed narrative with the
 * self_only sections removed. A filter cannot change who a sentence is talking
 * to, so the document the first real judgment would have handed 甲 opened with
 * "You, 乙, submitted this case" and told her that three clarification questions
 * had been put to her. Every fact in it was true and every one was addressed to
 * the wrong person.
 *
 * `checkCounterpartyAddress` is the check that would have caught it, and it runs
 * on the text on its way out rather than on the model's answer alone. It is
 * lexical and therefore partial — see "What the language check can and cannot
 * see" below — so it is the second line. The first is structural: the shareable
 * rendition renders a surface layer that was WRITTEN to the counterparty, and
 * there is no code path left that projects the client's copy into a share.
 *
 * ## Why the frame is re-derived, never stored
 *
 * `contract.finalize` writes the self-reflection rendition and opens an empty
 * shareable row for the counterparty narrative to be generated into. This module
 * does not edit the judgment — a final judgment is frozen (HARD RULE #6) — it
 * **re-derives** the framed text every time one is read or shared, and validates
 * it at that moment.
 *
 * That is what makes the label non-removable in the only sense that matters. A
 * label baked into a stored string is one UPDATE away from gone; a label
 * composed by the function that produces the text cannot be absent from the
 * text, and `assertShareable` refuses to return a document that lacks it anyway.
 * Anything that leaves this machine goes out through `renderShareable`, so the
 * label leaves with it.
 *
 * ## What the language check can and cannot see
 *
 * The lexical checks run over the judgment's **own prose, in English** — the
 * language policy for every word this product writes (CLAUDE.md). Verbatim
 * evidence is quoted inside that prose in Chinese and is never edited, never
 * suppressed and never scanned: a counterparty who wrote 谁对谁错 in a message
 * is a fact about the record, not the judgment picking a winner, and stripping
 * that would be rewriting evidence to pass our own test. Quoted spans are
 * removed before scanning for exactly that reason.
 *
 * The gap this leaves is worth stating: a ratio written as "70/30" is not caught
 * lexically. What actually prevents a responsibility percentage is structural —
 * `RESPONSIBILITY_ALLOCATIONS` is an enum of four words and there is no numeric
 * field for a number to come from. The lexical check is the second line, for
 * prose that invents one.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  judgmentRenditions,
  type OutputLevel,
  type RenditionKind,
} from "../db/schema";
import {
  assertShareTokenAllowed,
  parseSurfaceLayer,
  readJudgment,
  renderRendition,
  type FactLayer,
  type JudgmentRecord,
  type SurfaceLayer,
} from "./contract";

/* -------------------------------------------------------------------------- */
/* The frame                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The provenance-and-redistribution notice every shareable rendition opens with
 * (doc 05 §C amendment 5).
 *
 * ## One notice, not two stacked
 *
 * This replaces `ONE_SIDED_LABEL`. There used to be two frames competing for
 * the top of the same document: doc 01's mandatory one-sidedness label, and the
 * redistribution rule amendment 5 adds. Stacking them would have put two
 * paragraphs of disclaimer above the first sentence anyone actually reads,
 * which is how a notice becomes furniture. They are merged: the one-sidedness
 * statement is now what the L2 wording of the middle sentence *says*, so the
 * document carries one notice whose content adapts to what the hearing could
 * read.
 *
 * ## Three sentences, and each is load-bearing
 *
 *   1. **What it is** — "An AI-mediated document, not a human judgment." AYTA's
 *      finding (survey §1.6) is that people forward these as verdicts; the
 *      first thing the recipient reads has to say what produced it.
 *   2. **What it rests on** — the level, the number of confirmed items, and the
 *      basis in one clause. Naming the level alone ("L2, one-sided") describes
 *      the frame; the counts describe the actual hole, which is the finding the
 *      real case forced (see `recordBasisSchema` in contract.ts).
 *   3. **What not to do with it** — "Do not present this as a neutral third
 *      party's finding." Any verdict is manufactured ammunition (anti-pattern
 *      4); the rule that governs redistribution travels attached to the thing
 *      being redistributed, not in a settings page nobody opens.
 *
 * Sentences 1 and 3 are fixed strings and are what `assertShareable` looks for:
 * the notice is per-level, so its presence cannot be checked by comparing the
 * whole thing to a constant. It contains none of the vocabulary the shareable
 * rendition forbids — no win/lose word, no ratio, no second person — so the
 * frame can never be what trips its own check.
 */
export const NOTICE_OPENING = "An AI-mediated document, not a human judgment.";

/** The redistribution rule, attached to the artifact. Fixed at every level. */
export const NOTICE_REDISTRIBUTION =
  "Do not present this as a neutral third party's finding.";

/** How the middle sentence starts. Checked, so the level is never omitted. */
export const NOTICE_BASIS_OPENING = "Produced at level";

/** What the notice needs to state its basis. Comes from the frozen fact layer. */
export interface NoticeBasis {
  /** The level the judgment was issued at. */
  readonly level: OutputLevel;
  /** Confirmed, citable items the hearing could read (HARD RULE #1's own set). */
  readonly confirmedItems: number;
  readonly byClient: number;
  readonly byCounterparty: number;
  /** The client's pseudonym, for the L1 wording. */
  readonly clientPseudonym: string;
}

/** The basis clause, in the level's own terms. */
function basisSummary(basis: NoticeBasis): string {
  const { confirmedItems, byClient, byCounterparty, clientPseudonym } = basis;

  switch (basis.level) {
    case "L1":
      // Both accounts are on the record, so the notice says whose words those
      // items were. No second person: this document is read by one party and
      // archived by the other, and the sentence has to be true in both hands.
      return (
        `${byClient} from ${clientPseudonym} and ${byCounterparty} from the ` +
        `other party, both accounts on the record`
      );
    case "L2":
      // Doc 01's one-sidedness label, merged in as the basis clause.
      return (
        `all of them from one person's account. The other person has not been ` +
        `heard, and nothing here is a finding about them`
      );
    case "L3":
      return (
        `too thin a record to allocate anything. This describes what was ` +
        `submitted and what is missing from it; it decides nothing`
      );
    case "refused":
      return (
        `nothing was decided. This is a referral, not a finding, and the ` +
        `record was not judged`
      );
  }
}

/**
 * Compose the notice for one judgment.
 *
 * Deterministic, no timestamps: it is part of the document text, so it has to
 * diff cleanly version to version like everything else in a rendition.
 */
export function provenanceNotice(basis: NoticeBasis): string {
  return (
    `${NOTICE_OPENING} ${NOTICE_BASIS_OPENING} ${basis.level} on ` +
    `${basis.confirmedItems} confirmed items — ${basisSummary(basis)}. ` +
    `${NOTICE_REDISTRIBUTION}`
  );
}

/** The notice's fixed parts, as read off a finished document. */
export function hasProvenanceNotice(text: string): boolean {
  return (
    text.includes(NOTICE_OPENING) &&
    text.includes(NOTICE_BASIS_OPENING) &&
    text.includes(NOTICE_REDISTRIBUTION)
  );
}

/**
 * The notice as it stands in a finished document, for a screen that has to show
 * a reader the actual words rather than assert they are there.
 *
 * Returns the line, not a reconstruction: the point of quoting the notice back
 * is that it is the notice this document carries.
 */
export function findProvenanceNotice(text: string): string | null {
  const line = text
    .split("\n")
    .find((candidate) => candidate.includes(NOTICE_OPENING));
  return line === undefined ? null : line.trim();
}

/**
 * The notice's basis, read off a fact layer.
 *
 * Every number in it is `record_basis`, verbatim — the same counts the contract
 * validated and the same set HARD RULE #1 allows anything to be cited from. The
 * notice does not compute a basis of its own, because a second count of the
 * record is a second answer to a question that must only have one.
 */
export function noticeBasisFrom(
  level: OutputLevel,
  factLayer: FactLayer,
): NoticeBasis {
  const basis = factLayer.findings.record_basis;
  return {
    level,
    confirmedItems: basis.citable_utterances.total,
    byClient: basis.citable_utterances.by_client,
    byCounterparty: basis.citable_utterances.by_counterparty,
    clientPseudonym: basis.client_pseudonym,
  };
}

/** The notice a judgment record carries, read off its own frozen row. */
export function noticeBasisFor(judgment: JudgmentRecord): NoticeBasis {
  return noticeBasisFrom(judgment.outputLevel, judgment.factLayer);
}

/** Heading of the closing block. */
export const INVITATION_HEADING = "Where this can go from here";

/**
 * The ending. It invites a conversation and does not ask for agreement — the
 * document is supposed to open a door, and a document that ends on a conclusion
 * closes one.
 */
export const INVITATION_TEXT =
  "If you read this and it does not match what you remember, that is expected: " +
  "it was written without you. Your account can be added to the same record, in " +
  "your own words, and everything above is re-heard with both accounts in it. " +
  "Nothing has been decided that your side cannot change.";

/** Sentence that carries the response entry point. Only used with a real door. */
export const RESPONSE_PROMPT = "Add your side of it here:";

/**
 * The last line when there is no working door to print.
 *
 * ## Why a document may not carry a link that does not open
 *
 * The frame used to end every copy with `Add your side of it here: /respond`,
 * and `/respond` is not a page: the only route this product serves a recipient
 * is `/respond/<token>`, and a token is minted by the sender. So the one
 * actionable line in a document handed to the person who was never asked was an
 * instruction that failed when she followed it. A dead link is worse than no
 * link — it reads as "there is a way in" and then closes, which is the exact
 * shape of the grievance this document exists to avoid creating.
 *
 * The replacement says the true thing, including the part that is unflattering:
 * she cannot let herself in, and the person who sent this controls the
 * invitation. Naming who holds the door is what makes the sentence usable —
 * "ask them" is an action, "/respond" was not.
 */
export const RESPONSE_WITHOUT_LINK =
  "This copy carries no link. Adding your account to the same record needs an " +
  "invitation, and only the person who sent this can open one — ask them for " +
  "it, and your side is heard inside the same case rather than beside it.";

/**
 * The tokenless route. **Not a door**: it is the prefix a minted token is
 * appended to, and on its own it resolves to nothing.
 *
 * Kept as the default that callers pass because it is the prefix, and a caller
 * that has no token has nothing to append to it — `renderShareable` prints
 * `RESPONSE_WITHOUT_LINK` rather than this string whenever what it holds is not
 * a door (`isResolvableEntryPoint`).
 */
export const DEFAULT_RESPONSE_ENTRY_POINT = "/respond";

/**
 * Whether an entry point is somewhere a reader can actually go.
 *
 * Two shapes count. `/respond/<token>` is the route this product serves — the
 * bare prefix, with nothing after it, is the dead link this predicate exists to
 * catch. An absolute `http(s)` URL is somebody else's door and this module has
 * no standing to judge it, so it is taken at face value.
 */
export function isResolvableEntryPoint(entryPoint: string | undefined): boolean {
  if (entryPoint === undefined) return false;
  const value = entryPoint.trim();
  if (value.length === 0) return false;
  const tokenised = /^\/respond\/([^/?#\s]+)/.exec(value);
  if (tokenised !== null) return true;
  return /^https?:\/\/\S+$/i.test(value);
}

/** The last line a document ends on, given whatever door the caller holds. */
export function responseClosing(entryPoint: string | undefined): string {
  return isResolvableEntryPoint(entryPoint)
    ? `${RESPONSE_PROMPT} ${entryPoint}`
    : RESPONSE_WITHOUT_LINK;
}

/**
 * A `/respond` pointer in the text that is not a door.
 *
 * Runs over the finished document, not over the entry point the caller passed,
 * because the string can also arrive from a section's own prose — a narrative
 * that helpfully tells the reader to "go to /respond" ships the same dead link
 * by a different route.
 */
export function deadRespondPointers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\/respond(\/[^\s)]*)?/g)) {
    const [pointer] = match;
    if (isResolvableEntryPoint(pointer)) continue;
    found.push(pointer);
  }
  return found;
}

/** How long a minted share token stays valid. Fourteen days. */
export const SHARE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type RenditionErrorCode =
  /** A share token was asked for on a rendition that may never be shared. */
  | "not_shareable"
  /** The shareable text carries language it may not carry. */
  | "unsafe_language"
  /** The shareable text talks to the client, who is not its reader (M4 ①). */
  | "client_addressed"
  /**
   * A counterparty narrative was offered for storage and did not hold up —
   * against the frozen fact layer, or against the rules that exist only for the
   * copy the other party receives. The message names every fault.
   */
  | "narrative_invalid"
  /** The frame is missing from a document about to leave the machine. */
  | "frame_missing"
  /** The document points the reader at a route that does not resolve. */
  | "dead_link"
  | "judgment_not_found"
  /** Renditions exist from `finalize` onwards; a draft has none to share. */
  | "not_final"
  | "surface_layer_missing"
  /**
   * The counterparty narrative has not been generated for this judgment yet, so
   * there is no shareable document. Not an error state to work around: the
   * shareable copy is written, not filtered, and until it is written there is
   * nothing to hand anyone.
   */
  | "shareable_narrative_missing"
  | "rendition_missing";

export interface RenditionViolation {
  readonly code: RenditionErrorCode;
  /** One sentence naming what is wrong. */
  readonly detail: string;
  /** The offending fragment, when there is one to point at. */
  readonly excerpt?: string;
}

export class RenditionError extends Error {
  readonly code: RenditionErrorCode;
  readonly violations: readonly RenditionViolation[];

  constructor(
    code: RenditionErrorCode,
    message: string,
    violations: readonly RenditionViolation[] = [],
  ) {
    super(message);
    this.name = "RenditionError";
    this.code = code;
    this.violations = violations;
  }
}

/* -------------------------------------------------------------------------- */
/* Forbidden language                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Win/lose vocabulary. Each entry is matched on word boundaries against the
 * judgment's own prose, with quoted evidence removed first.
 *
 * The list is deliberately short and specific. It is not a profanity filter and
 * not a tone police: every word here turns a description of what happened into a
 * scoreline, which is the one thing a document handed to the unheard party must
 * not be.
 */
const WIN_LOSE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // `won't` is not a win. Everything else in this family is.
  { label: "won", pattern: /\bwon\b(?!['’])/i },
  { label: "win / wins", pattern: /\bwins?\b/i },
  { label: "winner", pattern: /\bwinner\b/i },
  { label: "lose / loses / losing", pattern: /\blos(e|es|ing)\b/i },
  { label: "lost", pattern: /\blost\b/i },
  { label: "loser", pattern: /\bloser\b/i },
  { label: "victory", pattern: /\bvictor(y|ious)\b/i },
  { label: "defeat", pattern: /\bdefeat(ed|s)?\b/i },
  { label: "at fault", pattern: /\bat fault\b/i },
  { label: "fault", pattern: /\b(the|their|your|his|her|its) fault\b/i },
  { label: "blame", pattern: /\bblam(e|ed|es|ing)\b/i },
  { label: "guilty", pattern: /\bguilty\b/i },
  { label: "innocent", pattern: /\binnocent\b/i },
  { label: "in the wrong", pattern: /\bin the wrong\b/i },
  { label: "in the right", pattern: /\bin the right\b/i },
  { label: "who was right", pattern: /\bwho (was|is) right\b/i },
  { label: "right and wrong", pattern: /\bright (and|or) wrong\b/i },
  { label: "wrongdoer", pattern: /\bwrongdoer\b/i },
];

/**
 * Anything that puts a NUMBER on responsibility.
 *
 * The bare noun used to be on this list, and the first real judgment is what
 * took it off. Its `limits` section ends "…and no percentage, ratio or score —
 * should be read as answering it", which is the product's own promise stated in
 * the document, and the check refused to let that document be shared. A rule
 * that fires on the disclaimer as readily as on the offence is not enforcing
 * the rule; it is enforcing a vocabulary, and the sentence it silences is the
 * one a recipient most needs to read.
 *
 * So what is matched is an allocation: a number attached to a share, a
 * ratio-shaped split, or the noun in the act of dividing something up
 * ("percentage of the responsibility"). `70%`, `70 percent`, `70/30` and
 * `七成责任` are all still caught, in the judgment's own prose, with verbatim
 * quotes stripped first.
 */
export const PERCENTAGE_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  { label: "a percentage", pattern: /\d+(\.\d+)?\s*%/ },
  { label: "a percentage in words", pattern: /\b\d+(\.\d+)?\s*per\s?cent\b/i },
  {
    // Spelled-out shares, to the tens. Not every English number word is here
    // and none needs to be: this is a document a model wrote from a skeleton
    // that carries no percentages, so the rule is a backstop, not a parser.
    label: "a spelled-out percentage",
    pattern:
      /\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half)([\s-]\w+)?\s*per\s?cent\b/i,
  },
  {
    label: "a percentage of responsibility",
    pattern: /\bpercentages?\s+of\s+(the\s+|their\s+|his\s+|her\s+|your\s+)?(responsibility|blame|fault)\b/i,
  },
  { label: "a numeric split", pattern: /\b\d{1,3}\s*[:/]\s*\d{1,3}\b/ },
  {
    label: "a share of responsibility in Chinese",
    pattern: /[一二三四五六七八九十两0-9]+\s*[成分]\s*(的)?\s*责任/,
  },
];

/**
 * Remove verbatim quotes before scanning.
 *
 * Evidence is quoted inside the prose and is never rewritten (CLAUDE.md), so it
 * is also never scanned: what the parties said to each other is not what the
 * judgment is saying. Curly, straight and CJK quotation marks are all handled,
 * because the evidence in this case is Chinese and the prose around it is
 * English.
 */
export function stripVerbatimQuotes(text: string): string {
  return text
    .replace(/“[^”]*”/g, " ")
    .replace(/「[^」]*」/g, " ")
    .replace(/『[^』]*』/g, " ")
    .replace(/"[^"]*"/g, " ");
}

/**
 * Check a shareable document's own prose.
 *
 * Returns every violation rather than the first, so a caller (or a regeneration
 * prompt) is told the whole problem at once.
 */
export function checkShareableLanguage(text: string): RenditionViolation[] {
  const prose = stripVerbatimQuotes(text);
  const violations: RenditionViolation[] = [];

  for (const { label, pattern } of WIN_LOSE_PATTERNS) {
    const match = pattern.exec(prose);
    if (match === null) continue;
    violations.push({
      code: "unsafe_language",
      detail:
        `The shareable rendition uses win/lose framing (${label}). A document ` +
        `handed to the party who was never heard may describe what happened; it ` +
        `may not hand them a result.`,
      excerpt: excerptAround(prose, match.index),
    });
  }

  for (const { label, pattern } of PERCENTAGE_PATTERNS) {
    const match = pattern.exec(prose);
    if (match === null) continue;
    violations.push({
      code: "unsafe_language",
      detail:
        `The shareable rendition states ${label}. Responsibility in this ` +
        `product is one of four words and never a number: a percentage is a ` +
        `precision the record cannot support, and it reads as arithmetic to ` +
        `whoever receives it.`,
      excerpt: excerptAround(prose, match.index),
    });
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* Who the document is talking to (M4 ①)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Second-person constructions that can only be about the CLIENT.
 *
 * Each entry names an act that, in this product, exactly one party performs.
 * The client brings the case; the client is asked the clarification questions;
 * the client is shown the adverse facts and acknowledges or contests them. The
 * counterparty does none of these — she is not asked anything, which is the
 * whole reason the document she receives has to say so. So "put to you" or "you
 * acknowledged", in a copy addressed to her, is not a tone problem: it is a
 * sentence about somebody else with her name on it.
 *
 * Deliberately NOT on this list: anything that could be true of either party.
 * "You have no confirmed line in the record" is a real possibility for a
 * counterparty whose messages were never submitted; "your account", "your own
 * words" and "your side" are what the invitation says to her by design. A check
 * that fired on those would be enforcing a vocabulary rather than a rule, and
 * would eventually be turned off.
 */
const CLIENT_ROLE_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
  /**
   * Only a fault when the surrounding sentence also matches this.
   *
   * Two of these constructions are ambiguous outside the hearing: being "asked"
   * something and "declining" it are things the parties also do to each other,
   * and a counterparty who declined the invitation to take part declined
   * something real. Scoping them to a sentence that is about the hearing keeps
   * the rule aimed at what it is for.
   */
  readonly within?: RegExp;
}[] = [
  {
    label: "the reader is told they brought this case",
    pattern: /\byou\s+(submitted|brought|filed|opened|raised|started)\b/i,
  },
  {
    label: "the case is called the reader's",
    pattern: /\byour\s+(case|submission|filing)\b/i,
  },
  {
    label: "clarification questions are put to the reader",
    pattern: /\b(put|putting)\s+to\s+you\b/i,
  },
  {
    label: "the reader is told the hearing asked them something",
    pattern: /\byou\s+(were|have been)\s+asked\b/i,
    within: /\b(clarification|question|hearing|judgment|analysis)/i,
  },
  {
    label: "the reader is told they answered the hearing, or did not",
    pattern:
      /\byou\s+(declined|did not answer|never answered|gave no answer|left them unanswered)\b/i,
    within: /\b(clarification|question|hearing|judgment|analysis)/i,
  },
  {
    label: "the reader is told they acknowledged the adverse facts",
    pattern:
      /\byou\s+(acknowledged|did not rebut|rebutted|contested|were shown|have been shown)\b/i,
  },
  {
    label: "the reader is told the hearing was written for them",
    pattern: /\bwritten\s+for\s+you\b/i,
  },
];

/** Escape a pseudonym for use inside a pattern. It is data, not a regex. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The sentence a match sits in, for the `within` test above. */
function enclosingSentence(text: string, index: number): string {
  const boundary = /[.!?。！？\n]/;
  let start = index;
  while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !boundary.test(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * Check that a shareable document is not talking to the client.
 *
 * Two families, and they fail differently. The role patterns above catch a
 * sentence that attributes a client-only act to "you" — they need no pseudonym
 * and always run. The apposition check needs to know who the client is, and
 * catches the exact shape the first real judgment produced: the pronoun and the
 * client's pseudonym side by side, "You, 乙, submitted this case".
 *
 * Verbatim quotes are stripped first, for the same reason every other check
 * here strips them: what the parties said to each other is evidence, it is
 * theirs, and a message in which one of them wrote "你" is not this document
 * addressing anybody.
 *
 * Lexical, and therefore partial. It cannot resolve a pronoun, so it will not
 * catch every mis-addressed sentence a model could write. What makes the
 * shareable copy counterparty-addressed is that it is generated that way, from
 * the fact layer, by a stage that was told who its reader is; this is the check
 * that the generation did what it said, run again every time the document is
 * rendered.
 */
export function checkCounterpartyAddress(
  text: string,
  clientPseudonym?: string,
): RenditionViolation[] {
  const prose = stripVerbatimQuotes(text);
  const violations: RenditionViolation[] = [];

  for (const { label, pattern, within } of CLIENT_ROLE_PATTERNS) {
    const match = pattern.exec(prose);
    if (match === null) continue;
    if (within !== undefined && !within.test(enclosingSentence(prose, match.index))) {
      continue;
    }
    violations.push({
      code: "client_addressed",
      detail:
        `The shareable rendition addresses the client in the second person: ` +
        `${label}. This copy is read by the other party, who did not bring ` +
        `this case and was never asked anything — a sentence like this tells ` +
        `her that something happened to her that happened to somebody else.`,
      excerpt: excerptAround(prose, match.index),
    });
  }

  if (clientPseudonym !== undefined && clientPseudonym.length > 0) {
    const name = escapeForPattern(clientPseudonym);
    const appositions: readonly { readonly label: string; readonly pattern: RegExp }[] = [
      {
        label: `"you, ${clientPseudonym}"`,
        pattern: new RegExp(
          `\\b(you|your|yours|yourself)\\s*[,，(（\\[—–-]\\s*${name}`,
          "i",
        ),
      },
      {
        label: `"${clientPseudonym}, you"`,
        pattern: new RegExp(
          `${name}\\s*[,，)）\\]—–-]\\s*(you|your|yours|yourself)\\b`,
          "i",
        ),
      },
    ];

    for (const { label, pattern } of appositions) {
      const match = pattern.exec(prose);
      if (match === null) continue;
      violations.push({
        code: "client_addressed",
        detail:
          `The shareable rendition puts the client's pseudonym and a ` +
          `second-person pronoun in apposition (${label}), which tells the ` +
          `reader that she is ${clientPseudonym}. In this copy ` +
          `${clientPseudonym} is a third party and "you" is the reader; the ` +
          `two are never the same person.`,
        excerpt: excerptAround(prose, match.index),
      });
    }
  }

  return violations;
}

function excerptAround(text: string, index: number, span = 60): string {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}

/* -------------------------------------------------------------------------- */
/* The disagreement display (doc 05 §B.1.d)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the seats diverge, the document shows the spread instead of averaging
 * it.
 *
 * This is the render half of the fairness machinery, and it costs nothing: the
 * two advocates' irreconcilable readings and the two swap arms' allocations are
 * already paid for by the time anything is rendered. What this function refuses
 * to do is the cheap thing — take two contradictory readings of the same lines
 * and emit one confident sentence between them. A judgment that reports "the
 * hearing found roughly a middle position" where its own two passes disagreed
 * has manufactured a finding that neither pass made, and printed it in the
 * typeface of the ones that were checked.
 *
 * So: **contradictory readings are reported as contradiction, never averaged.**
 * The rule is a property of this function — there is no path through it that
 * merges two readings — rather than an instruction in a prompt.
 *
 * The output is markdown prose, and it is composed here rather than asked for,
 * which is what makes it a deterministic artifact: the same spread renders the
 * same bytes every time, and the withheld-allocation state (doc 05 §B.2 step 4)
 * ships this display in place of the allocation it could not publish.
 */
export const DISAGREEMENT_HEADING = "Where the readings diverge";

/**
 * The aggregation rule, stated in the document that applies it.
 *
 * In the document because a reader who sees two answers to the same question
 * needs to know that the two answers ARE the finding, rather than a mistake the
 * product failed to resolve.
 */
export const DISAGREEMENT_RULE =
  "Two readings are shown here because the hearing produced two and the " +
  "confirmed record does not settle which is right. They are set side by side " +
  "rather than merged: a single sentence composed between them would be a " +
  "finding neither reading makes, stated more confidently than either.";

/** One seat's reading of the thing under disagreement. */
export interface DisagreementReading {
  /** Whose reading this is, named as a position: an advocate seat, a pass. */
  readonly seat: string;
  /** What that seat read, in its own terms. */
  readonly reading: string;
}

/** One subject the seats did not agree on. */
export interface Disagreement {
  /** What they disagreed about, as a phrase a reader can locate in the document. */
  readonly subject: string;
  readonly readings: readonly DisagreementReading[];
  /** What the record can and cannot settle about this spread. Optional. */
  readonly note?: string;
}

/**
 * Render one or more disagreements as the document's own section body.
 *
 * Returns an empty string for an empty list, so a caller can append the result
 * unconditionally: nothing diverged is a legitimate state and it renders as
 * nothing, not as a heading over silence. A subject with fewer than two readings
 * is dropped for the same reason — one reading is not a disagreement, and
 * printing it under this heading would suggest a dispute where there is none.
 */
export function renderDisagreement(
  disagreements: readonly Disagreement[],
): string {
  const real = disagreements.filter((item) => item.readings.length >= 2);
  if (real.length === 0) return "";

  const blocks = real.map((item) => {
    const readings = item.readings
      .map((reading) => `- **${reading.seat}:** ${reading.reading}`)
      .join("\n");
    const note = item.note === undefined ? "" : `\n\n${item.note}`;
    return `**${item.subject}**\n\n${readings}${note}`;
  });

  return [DISAGREEMENT_RULE, ...blocks].join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface RenditionView {
  readonly kind: RenditionKind;
  readonly shareable: boolean;
  /** The document, framed and validated. */
  readonly text: string;
  readonly sectionIds: readonly string[];
  /** Sections withheld from this audience. Empty for self_reflection. */
  readonly omittedSectionIds: readonly string[];
  /**
   * Sections marked `self_only` that this rendition carries — the criticism
   * directed at the client. Non-empty is the normal state of a self-reflection
   * copy, and it is surfaced so a caller can see the copy is doing its job.
   */
  readonly criticismSectionIds: readonly string[];
}

export interface ShareableOptions {
  /**
   * Where the other party can add their account. Embedded verbatim in the last
   * line, so a caller that has minted a token passes the tokenized route here.
   */
  readonly responseEntryPoint?: string;
  /**
   * The client's pseudonym, when the caller knows it — every db-backed path
   * does, from `fact_layer.findings.record_basis.client_pseudonym`.
   *
   * Supplying it turns on the apposition half of the address check. The half
   * that does not need it runs either way, so omitting it weakens the check
   * rather than disabling it.
   */
  readonly clientPseudonym?: string;
}

/**
 * Everything the shareable frame needs that the caller cannot leave out.
 *
 * `level` and `basis` are required, and required is the point. The notice (doc
 * 05 §C amendment 5) states the level and what the hearing could read, and a
 * notice that can be composed without those is a notice that can be wrong about
 * them. Every db-backed door builds this from the frozen judgment
 * (`noticeBasisFor`), so no route has to remember; a caller holding only a
 * surface layer has to say what it is a surface layer of.
 *
 * `level` is also what the audience projection is level-aware *by*
 * (`projectSection`), so the same field settles both questions.
 */
export interface ShareableFrame extends ShareableOptions {
  readonly level: OutputLevel;
  readonly basis: NoticeBasis;
}

/**
 * The client's own copy: every section, criticism included.
 *
 * There is no filter here and there is not supposed to be one. This is the
 * version that says the hard part, and the reason the product bothers. The
 * level is accepted so the projection is called the same way from both doors;
 * it cannot change this document, because the client's copy carries every
 * section at every level.
 */
export function renderSelfReflection(
  surfaceLayer: SurfaceLayer,
  level: OutputLevel = "L2",
): RenditionView {
  const rendition = renderRendition(surfaceLayer, "self_reflection", level);
  return {
    kind: "self_reflection",
    shareable: false,
    text: rendition.text,
    sectionIds: rendition.sectionIds,
    omittedSectionIds: rendition.omittedSectionIds,
    criticismSectionIds: surfaceLayer.sections
      .filter((section) => section.audience === "self_only")
      .map((section) => section.section_id),
  };
}

/**
 * The copy the other party may see: the notice, the counterparty-addressed
 * findings, and an ending that hands them a way in.
 *
 * `surfaceLayer` here is the narrative written TO the counterparty (M4 ①), not
 * the judgment's own. The projection still runs over it — a counterparty
 * document has no business carrying a section marked as the client's alone, and
 * projecting it out is cheaper than trusting that none arrived. What the level
 * changes (doc 05 §A.3) is which `self_only` sections that means: below L1, all
 * of them; at L1, only the client's own reflection annexes, because at L1 both
 * parties are participants and a finding about either of them belongs to both.
 *
 * Throws rather than returning a flawed document. A shareable rendition is the
 * one artifact of this product that reaches someone who never agreed to be
 * judged by it, so "render it anyway and warn" is not an option available here.
 */
export function renderShareable(
  surfaceLayer: SurfaceLayer,
  frame: ShareableFrame,
): RenditionView {
  const options: ShareableOptions = frame;
  const entryPoint = options.responseEntryPoint ?? DEFAULT_RESPONSE_ENTRY_POINT;
  const rendition = renderRendition(surfaceLayer, "shareable", frame.level);

  const text = [
    provenanceNotice(frame.basis),
    "",
    rendition.text,
    "",
    "---",
    "",
    `## ${INVITATION_HEADING}`,
    "",
    INVITATION_TEXT,
    "",
    // A link only when the caller holds one that opens. Otherwise the words,
    // which are true in every case a link is not.
    responseClosing(entryPoint),
  ].join("\n");

  assertShareable(text, entryPoint, options.clientPseudonym);

  return {
    kind: "shareable",
    shareable: true,
    text,
    sectionIds: rendition.sectionIds,
    omittedSectionIds: rendition.omittedSectionIds,
    criticismSectionIds: [],
  };
}

/**
 * The gate every shareable document passes on its way out.
 *
 * Checks the frame is intact (the provenance-and-redistribution notice is
 * present, and the document ends on the invitation carrying the response entry
 * point), that the prose carries neither win/lose framing nor a responsibility
 * percentage, and that it is not talking to the client.
 *
 * The notice is checked by its fixed sentences rather than by comparing the
 * whole string to a constant: its middle sentence states the level and the
 * counts, so there is no one notice to compare against. That is also why the
 * check cannot be "some notice-ish text is present" — the two sentences it
 * looks for are the two that carry the claim ("not a human judgment") and the
 * rule ("do not present this as a neutral third party's finding"), and a
 * document that lost either of them lost the notice.
 */
export function assertShareable(
  text: string,
  entryPoint?: string,
  clientPseudonym?: string,
): void {
  const violations: RenditionViolation[] = [];

  if (!hasProvenanceNotice(text)) {
    violations.push({
      code: "frame_missing",
      detail:
        `The provenance-and-redistribution notice is not in this document. It ` +
        `is not decoration: it is the sentence that tells the person receiving ` +
        `it what they are holding and what not to do with it, and nothing goes ` +
        `out without it. Expected "${NOTICE_OPENING}", "${NOTICE_BASIS_OPENING} ` +
        `<level> on <n> confirmed items — …" and "${NOTICE_REDISTRIBUTION}".`,
    });
  }

  const tail = text.trimEnd();
  if (!tail.includes(INVITATION_TEXT)) {
    violations.push({
      code: "frame_missing",
      detail:
        `The document does not end by inviting a conversation. A shareable ` +
        `rendition that stops on its findings hands the other party a verdict ` +
        `and no way to answer it.`,
    });
  }

  const expectedEnding = responseClosing(entryPoint);
  if (!tail.endsWith(expectedEnding)) {
    violations.push({
      code: "frame_missing",
      detail:
        `The document does not end on the way in. Where there is a working ` +
        `door it is the last thing the reader sees; where there is not, the ` +
        `last thing they see is how to ask for one.`,
    });
  }

  // A pointer that does not resolve, wherever in the document it came from.
  for (const pointer of deadRespondPointers(tail)) {
    violations.push({
      code: "dead_link",
      detail:
        `This document contains "${pointer}", which is not a page. The only ` +
        `route a recipient can open is /respond/<token>, and the token is ` +
        `minted by the sender. A link that fails when she follows it tells ` +
        `her there is a way in and then closes it, which is worse than the ` +
        `document saying plainly that she has to ask for one.`,
      excerpt: pointer,
    });
  }

  violations.push(...checkShareableLanguage(text));
  violations.push(...checkCounterpartyAddress(text, clientPseudonym));

  if (violations.length === 0) return;

  const code =
    violations.find(
      (violation) =>
        violation.code === "unsafe_language" ||
        violation.code === "client_addressed",
    )?.code ?? "frame_missing";

  throw new RenditionError(
    code,
    `This shareable rendition may not leave the machine:\n` +
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

/* -------------------------------------------------------------------------- */
/* The query layer                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The counterparty-addressed narrative stored against a judgment, or null when
 * it has not been generated (M4 ①).
 *
 * It lives on the rendition row rather than on the judgment: the judgment is
 * frozen, and this document is derived from it and re-generatable, so it has its
 * own row, its own provenance and its own revision counter.
 */
export function readShareableNarrative(
  db: Db,
  judgmentId: string,
): SurfaceLayer | null {
  const row = db
    .select({ surfaceLayer: judgmentRenditions.surfaceLayer })
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgmentId),
        eq(judgmentRenditions.kind, "shareable"),
      ),
    )
    .get();

  if (row === undefined || row.surfaceLayer === null) return null;
  return parseSurfaceLayer(
    row.surfaceLayer,
    `judgment_renditions[${judgmentId}].surface_layer`,
  );
}

/**
 * Render one audience's copy of a stored judgment.
 *
 * The two audiences read two different narratives, which is why this needs the
 * database: `self_reflection` renders the judgment's own frozen surface layer,
 * `shareable` renders the counterparty narrative stored beside it. There is no
 * longer a path that turns the first into the second — that path is the M3
 * defect (see the module header).
 */
export function renderJudgmentRendition(
  db: Db,
  judgment: JudgmentRecord,
  kind: RenditionKind,
  options: ShareableOptions = {},
): RenditionView {
  if (judgment.surfaceLayer === null) {
    throw new RenditionError(
      "surface_layer_missing",
      `Judgment ${judgment.id} has no narrative yet, so there is nothing to ` +
        `render for any audience.`,
    );
  }

  if (kind === "self_reflection") {
    return renderSelfReflection(judgment.surfaceLayer, judgment.outputLevel);
  }

  const narrative = readShareableNarrative(db, judgment.id);
  if (narrative === null) {
    throw new RenditionError(
      "shareable_narrative_missing",
      `Judgment ${judgment.id} has no counterparty-addressed narrative, so ` +
        `there is no shareable copy of it. The shareable rendition is written ` +
        `to the other party by the shareable_narrative stage from the frozen ` +
        `fact layer; it is not the client's copy with sections removed, ` +
        `because removing sections does not change who they are addressed to. ` +
        `Generate it first (judgment/shareable-narrative.ts).`,
    );
  }

  // The level and the basis come off the frozen row, never off the argument:
  // the projection rule and the notice both depend on them, and a caller that
  // could pass a different level could hand one party a document assembled
  // under the other party's rule.
  return renderShareable(narrative, {
    ...options,
    level: judgment.outputLevel,
    basis: noticeBasisFor(judgment),
    clientPseudonym:
      options.clientPseudonym ??
      judgment.factLayer.findings.record_basis.client_pseudonym,
  });
}

/**
 * Read one rendition by id and audience — the door the UI uses.
 *
 * Derives the text rather than returning the stored projection, so the frame and
 * the language check are applied to what is actually shown, every time.
 */
export function readRenditionView(
  db: Db,
  judgmentId: string,
  kind: RenditionKind,
  options: ShareableOptions = {},
): RenditionView {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new RenditionError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  return renderJudgmentRendition(db, judgment, kind, options);
}

/* -------------------------------------------------------------------------- */
/* Share tokens                                                               */
/* -------------------------------------------------------------------------- */

export interface ShareToken {
  /**
   * The token itself, returned exactly once. Only its hash is stored — a
   * database that can produce the link is a database that leaks the judgment.
   */
  readonly token: string;
  readonly judgmentId: string;
  readonly kind: RenditionKind;
  readonly expiresAt: Date;
  /** The framed, validated document this token grants access to. */
  readonly text: string;
}

export interface MintShareTokenOptions {
  /** Overrides the default TTL. */
  readonly ttlMs?: number;
  /** Route prefix the token is appended to for the response entry point. */
  readonly responseEntryPointPrefix?: string;
  /** Injectable clock, so an expiry test does not have to wait. */
  readonly now?: Date;
}

/** SHA-256, hex. The share token is stored the way a password would be. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mint a share token — and refuse to, for a self-reflection rendition.
 *
 * This is the enforcement point SPEC ⑪ asks for, in the service layer rather
 * than the UI: the criticism written for the client alone has no shareable form,
 * so there is no token that can be created for it and no code path that hides
 * the button instead. Four guards, deliberately redundant, because each of them
 * fails differently:
 *
 *   1. `assertShareTokenAllowed` — the rule stated on the kind, from the
 *      contract, so there is one definition of it;
 *   2. the same guard again once the judgment has been read, this time carrying
 *      the case: a party who has withdrawn consent for documents naming them
 *      (SPEC M5 ③) gets no new link while that stands. It throws
 *      `NamedRenditionRevokedError`, which carries who withdrew and what had
 *      already left, and it is deliberately not flattened into `RenditionError`:
 *      this refusal is about a person's decision, not about the document;
 *   3. the stored row's own `shareable` flag, which is what the database
 *      believes independent of the argument that was passed in;
 *   4. re-validating the derived document, so content that should never have
 *      been written cannot be shared even if it was persisted.
 *
 * Minting is not an edit to the judgment: the frozen row (HARD RULE #6) is not
 * touched. Sharing is a separate act, recorded on the rendition.
 */
export function mintShareToken(
  db: Db,
  judgmentId: string,
  kind: RenditionKind,
  options: MintShareTokenOptions = {},
): ShareToken {
  // 1. The rule about the kind, from the contract. Throws JudgmentStoreError
  //    with code "not_shareable" — the same error the rest of the store raises.
  assertShareTokenAllowed(kind);

  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new RenditionError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  if (judgment.status !== "final") {
    throw new RenditionError(
      "not_final",
      `Judgment ${judgmentId} is ${judgment.status}. A draft is work in ` +
        `progress; nothing is shared out of one.`,
    );
  }

  // 2. The same door, asked again now that the case is known. A share token has
  //    no named recipient — the link goes to whoever is handed it — so the
  //    question is the blanket one, and only a blanket withdrawal answers it.
  assertShareTokenAllowed(kind, { db, caseId: judgment.caseId });

  const row = db
    .select()
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgmentId),
        eq(judgmentRenditions.kind, kind),
      ),
    )
    .get();

  if (row === undefined) {
    throw new RenditionError(
      "rendition_missing",
      `Judgment ${judgmentId} has no ${kind} rendition. Renditions are minted ` +
        `when the judgment is finalized.`,
    );
  }

  // 3. What the database believes, independent of the argument.
  if (!row.shareable) {
    throw new RenditionError(
      "not_shareable",
      `Rendition ${row.id} (${row.kind}) is stored as not shareable. No share ` +
        `token is minted for it, whatever kind the caller asked for.`,
    );
  }

  const now = options.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const prefix = options.responseEntryPointPrefix ?? DEFAULT_RESPONSE_ENTRY_POINT;

  // 4. Re-derive and re-validate the document this token would expose.
  const view = renderJudgmentRendition(db, judgment, kind, {
    responseEntryPoint: `${prefix}/${token}`,
  });

  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? SHARE_TOKEN_TTL_MS));

  db.update(judgmentRenditions)
    .set({ shareTokenHash: hashShareToken(token), shareExpiresAt: expiresAt })
    .where(eq(judgmentRenditions.id, row.id))
    .run();

  return { token, judgmentId, kind, expiresAt, text: view.text };
}

/**
 * Resolve a share token to the document it grants — and to nothing else.
 *
 * Looks the token up by hash (the plaintext is never stored), refuses an expired
 * one, and refuses any rendition that is not marked shareable, so a token that
 * somehow landed on the wrong row still cannot open the client's own copy.
 *
 * And it asks the consent question again, on every open (SPEC M5 ③). This is the
 * one place a withdrawal can still reach a copy that has already been handed
 * out: a share link is a document *this* machine serves, so "stop sharing it"
 * is a promise that can actually be kept here, and it is kept. An exported file
 * is the opposite case and the refusal says so rather than implying a recall
 * that does not exist.
 *
 * The link is suspended, not burnt — the hash stays on the row, so granting
 * again makes the same link work again. Nothing needs restoring, because the log
 * is the state.
 */
export function readSharedRendition(
  db: Db,
  token: string,
  options: { readonly now?: Date } = {},
): RenditionView {
  const now = options.now ?? new Date();
  const row = db
    .select()
    .from(judgmentRenditions)
    .where(eq(judgmentRenditions.shareTokenHash, hashShareToken(token)))
    .get();

  if (row === undefined || !row.shareable || row.kind !== "shareable") {
    throw new RenditionError(
      "not_shareable",
      `That share link does not open anything. A link is only ever minted for a ` +
        `shareable rendition, and it opens that one.`,
    );
  }
  if (row.shareExpiresAt !== null && row.shareExpiresAt.getTime() <= now.getTime()) {
    throw new RenditionError(
      "not_shareable",
      `That share link expired on ${row.shareExpiresAt.toISOString()}.`,
    );
  }

  const judgment = readJudgment(db, row.judgmentId);
  if (judgment === null) {
    /* c8 ignore next 5 -- the rendition row cascades with its judgment. */
    throw new RenditionError(
      "judgment_not_found",
      `No judgment with id ${row.judgmentId}.`,
    );
  }
  assertShareTokenAllowed(row.kind, { db, caseId: judgment.caseId });

  return readRenditionView(db, row.judgmentId, "shareable", {
    responseEntryPoint: `${DEFAULT_RESPONSE_ENTRY_POINT}/${token}`,
  });
}
