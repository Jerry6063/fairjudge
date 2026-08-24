/**
 * Person names the dictionary does not literally hold — both halves of them.
 *
 * HARD RULE #3 says two things about names, and until now this package
 * implemented neither:
 *
 *   1. a registered person's name is replaced by their pseudonym, and
 *   2. an unregistered person name BLOCKS egress.
 *
 * (1) was implemented as exact-string substitution over `canonical` plus
 * whatever variants a caller happened to register, and `buildCaseDict`
 * registered none — so a case whose parties are "Nikhil Raman" and "Dara Osei"
 * masked those two strings and let every "Nikhil" through untouched. The name
 * people actually write is the given name, so the dictionary was masking the
 * form that almost never appears. (2) did not exist at all:
 * `detectUnregisteredNames` was an M0 stub that reported residual PII and
 * documented NER as deferred, which meant the rule's second sentence was a
 * comment.
 *
 * This module is both halves, kept pure and kept here rather than at the call
 * sites, because the gateway is the one checkpoint and a name rule enforced
 * anywhere else is a name rule with a way round it.
 *
 * ## The deliberate asymmetry between the two halves
 *
 * `deriveNameFragments` over-blocks and `detectPersonNames` under-blocks, on
 * purpose, because the cost of being wrong points in opposite directions:
 *
 *   - A fragment of a REGISTERED name is substituted, not refused. Over-firing
 *     costs a pseudonym where a common word stood; the text still egresses and
 *     the judgment still reads. So the rule is generous.
 *   - An unregistered name BLOCKS the send outright. Over-firing costs the
 *     operator a stage that will not run until they register somebody or edit a
 *     sentence, and a check that fires on ordinary English prose is a check that
 *     gets switched off — which is worse than the leak it was meant to stop. So
 *     the rule fires only where the text is naming a person: after an
 *     introducing word ("with Nikhil"), before an act of speech ("Nikhil said"),
 *     or after an honorific.
 *
 * ## What this does not do
 *
 * Latin script only. A Han given name cannot be told from an ordinary word by
 * context markers — Chinese has no capitalization to key on and the naming
 * contexts are the same characters as ordinary verbs — so a token-level scan
 * would either fire on most sentences or on none. Registered Chinese parties are
 * covered by `deriveNameFragments`, which splits 顾明远 into 明远 and masks it;
 * an unregistered Chinese third party is a gap, and it is named here rather than
 * papered over. Real NER remains the way to close it.
 */

import type { NameWarning, PersonDict, PersonEntry } from "./types";

/* -------------------------------------------------------------------------- */
/* Fragments of a registered name                                             */
/* -------------------------------------------------------------------------- */

const CJK_ONLY = /^[㐀-䶿一-鿿豈-﫿]+$/u;

/**
 * Fragments of a registered name that are still that person's name.
 *
 * The dictionary holds what somebody typed into the form. The commonest way a
 * real name survives into a document is not the full name — it is the part of it
 * people actually say: the given name without the surname (顾明远 → 明远), or one
 * element of a Latin name (Nikhil Raman → Nikhil, Raman).
 *
 * Single characters are never derived: one Han character is a word far more
 * often than it is a name, and a rule that rewrites every 明 in the record is a
 * rule that destroys the evidence it was protecting.
 *
 * TWIN: `judgment/export-gate.ts` carries the same derivation for the document
 * export gate, which is a different checkpoint on a different artifact (a
 * finished document about to be handed to a person, where the answer is "refuse"
 * rather than "substitute"). The two are kept behaviourally identical on
 * purpose; if you change the rule here, change it there.
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
 * One registered person, with the fragments of their name folded into the
 * variant table so `pseudonymize` substitutes them like any other alias.
 *
 * This is where "the egress gate must treat a bare token of a registered name as
 * that person" is implemented: not as a second matching rule inside the gateway,
 * but by putting the token in the dictionary the gateway already reads. The
 * longest-match pass then handles precedence for free — "Nikhil Raman" is
 * matched whole before either half is considered.
 *
 * Caller-supplied variants win: they are listed first, and duplicates are
 * dropped, so a registration that already names a nickname is not disturbed.
 *
 * Two parties who share a surname ("Dara Osei" and "Ada Osei") both register
 * "Osei", and the first entry in the dictionary wins that token. The masking
 * property is unharmed — the surname leaves as *a* pseudonym either way, which
 * is what HARD RULE #3 protects — and what degrades is restoration, which is
 * already lossy for every variant ("夏夏" restores as "知夏", never as itself).
 * Dropping the shared token instead would be the worse trade: it would put a
 * real surname back on the wire to avoid an ambiguity in a column nobody reads
 * outside this machine.
 */
export function expandPersonEntry(entry: PersonEntry): PersonEntry {
  const variants = [...entry.variants, ...deriveNameFragments(entry.canonical)];
  return {
    canonical: entry.canonical,
    pseudonym: entry.pseudonym,
    variants: [...new Set(variants)].filter(
      (variant) => variant.length > 0 && variant !== entry.canonical,
    ),
  };
}

/** `expandPersonEntry` over a whole dictionary. */
export function expandPersonDict(dict: PersonDict): PersonEntry[] {
  return dict.map(expandPersonEntry);
}

/* -------------------------------------------------------------------------- */
/* Unregistered person names                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Words that introduce a person, immediately before the name.
 *
 * Chosen from how a conflict record actually names third parties — "at the
 * allotment with Nikhil", "a message from Dara", "Dr Okafor" — rather than from
 * a grammar. Each one has to be followed by whitespace and then a capitalized
 * token for anything to fire.
 */
const INTRODUCERS = [
  "with",
  "from",
  "about",
  "and",
  "by",
  "met",
  "meets",
  "meeting",
  "saw",
  "seen",
  "told",
  "texted",
  "texting",
  "messaged",
  "called",
  "calling",
  "named",
  "asked",
  "dated",
  "dating",
  "married",
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
] as const;

/** Verbs of speech and act, immediately after the name. */
const ATTRIBUTIONS = [
  "said",
  "says",
  "wrote",
  "writes",
  "replied",
  "replies",
  "texted",
  "told",
  "asked",
  "asks",
  "admitted",
  "denied",
  "refused",
  "apologised",
  "apologized",
  "insisted",
  "shouted",
] as const;

/**
 * Capitalized tokens that are never a person's name.
 *
 * Every entry here is a word this product's own prose puts after an introducer
 * or before a verb of speech — the four that the whole prompt corpus produces
 * ("Every", "The", "They"), the rest of the sentence-leading function words that
 * would join them as the prompts are edited, and the calendar and product
 * vocabulary that shows up in case material. Nothing on this list is a name
 * anybody has: the moment an entry would suppress a real first name, it belongs
 * in the record instead of on this list.
 */
const NOT_NAMES = new Set<string>(
  [
    // Function words that can lead a sentence.
    "The", "This", "That", "These", "Those", "Then", "Than", "There", "Their",
    "They", "Them", "Its", "His", "Her", "Him", "She", "You", "Your", "Yours",
    "Our", "Ours", "Mine", "Who", "Whom", "Whose", "What", "Which", "When",
    "Where", "Why", "How", "If", "And", "But", "Not", "Nor", "For", "Yet",
    "All", "Any", "Each", "Every", "Both", "Some", "One", "Two", "Three",
    "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Nothing",
    "Nobody", "Anybody", "Somebody", "Everybody", "Everyone", "Someone",
    "Anyone", "Never", "Always", "Only", "Also", "Note", "Write", "Read",
    "Answer", "Return", "Because", "Before", "After", "During", "Since",
    "Until", "While", "Without", "Within", "Whatever", "Whenever", "Whoever",
    // Calendar.
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    "Sunday", "January", "February", "March", "April", "June", "July",
    "August", "September", "October", "November", "December",
    // Products and platforms a record names the way it names a person.
    "Claude", "Gemini", "Weibo", "Douyin", "Taobao", "Alipay", "Zoom",
    "Slack", "Discord", "Instagram", "Twitter", "Facebook", "Reddit",
    // The product's own vocabulary.
    "Judgment", "Judgement", "Evidence", "Claim", "Claims", "Section",
    "Sections", "Level", "Stage", "Case", "Client", "Counterparty", "English",
    "Chinese", "Timeline", "Intake", "Findings", "Finding", "Responsibility",
  ],
);

/** `\p{Lu}\p{Ll}{2,}` — a capitalized word of at least three letters. */
const NAME_TOKEN = "\\p{Lu}\\p{Ll}{2,}";
/** Not preceded by a letter, digit or underscore. */
const LEFT_EDGE = "(?:^|[^\\p{L}\\p{N}_])";
/** Not followed by a letter or digit, so CamelCase brands never match. */
const RIGHT_EDGE = "(?![\\p{L}\\p{N}])";

/**
 * A trigger word, matched with either case on its first letter.
 *
 * Spelled out rather than reached with the `i` flag, which would be the obvious
 * move and is a trap: under `i`, `\p{Lu}` case-folds and matches lowercase
 * letters, so one flag meant for the triggers would quietly turn the name token
 * into "any word" and fire on every sentence.
 */
function eitherCase(word: string): string {
  const first = word[0];
  return `[${first.toUpperCase()}${first}]${word.slice(1)}`;
}

const INTRODUCED = new RegExp(
  `${LEFT_EDGE}(?:${INTRODUCERS.map(eitherCase).join("|")})\\.?\\s+` +
    `(${NAME_TOKEN})${RIGHT_EDGE}`,
  "gu",
);

const ATTRIBUTED = new RegExp(
  `${LEFT_EDGE}(${NAME_TOKEN})\\s+` +
    `(?:${ATTRIBUTIONS.map(eitherCase).join("|")})${RIGHT_EDGE}`,
  "gu",
);

/** Every string the dictionary already accounts for, fragments included. */
function registeredTokens(dict: PersonDict): Set<string> {
  const known = new Set<string>();
  for (const entry of expandPersonDict(dict)) {
    known.add(entry.canonical.toLowerCase());
    known.add(entry.pseudonym.toLowerCase());
    for (const variant of entry.variants) known.add(variant.toLowerCase());
    // A Latin canonical is matched token by token below, so its parts count as
    // known even when they were too short to become fragments.
    for (const part of entry.canonical.split(/\s+/)) {
      if (part.length > 0) known.add(part.toLowerCase());
    }
  }
  return known;
}

/**
 * Names of people who are not in the dictionary — the fragments that must block
 * egress rather than be masked.
 *
 * Registered names are skipped: they are the substitution layer's business, and
 * a text that still carries one after `pseudonymize` ran is a different failure
 * with a different report (`scanRealNames`, on the export side).
 *
 * Each warning names the offending token, because unlike a phone number a name
 * is not made safer by hiding it from the operator who has to decide whether to
 * register the person or rewrite the sentence.
 */
export function detectPersonNames(
  text: string,
  dict: PersonDict,
): NameWarning[] {
  const known = registeredTokens(dict);
  const seen = new Set<string>();
  const warnings: NameWarning[] = [];

  const consider = (found: string, index: number, how: string): void => {
    if (NOT_NAMES.has(found)) return;
    if (known.has(found.toLowerCase())) return;
    // The token, not the position: one warning per distinct name is what an
    // operator acts on, and a name repeated forty times is still one decision.
    if (seen.has(found)) return;
    seen.add(found);
    warnings.push({
      kind: "unregistered_name",
      original: found,
      index,
      detail:
        `"${found}" reads as a person's name (${how}) and is not registered in ` +
        `this case's dictionary, so it would leave this machine as itself. ` +
        `Register them as a party, or take the name out of the text.`,
    });
  };

  for (const match of text.matchAll(INTRODUCED)) {
    const found = match[1];
    consider(found, match.index + match[0].lastIndexOf(found), "introduced by name");
  }
  for (const match of text.matchAll(ATTRIBUTED)) {
    const found = match[1];
    consider(found, match.index + match[0].indexOf(found), "credited with speech");
  }

  return warnings.sort((a, b) => a.index - b.index);
}
