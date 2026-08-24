// Copy for the front door, kept in one file so it can be read as a register
// rather than found in fragments.
//
// Two rules govern every string here, and both come from 05-design-framework.md
// §C amendment 2:
//
//   1. **The adjective is banned.** No surface describes this product or its
//      output as fair, unbiased, neutral or objective. What replaces the
//      adjective is procedure stated in advance — what the steps are, what each
//      level of output licenses, and what the other person's participation
//      changes — printed before any evidence is asked for. A claim about
//      procedure can be checked against the machine; an adjective cannot.
//   2. **No warmth.** Nothing here reassures, sympathizes, or thanks. A person
//      filing a case about their own relationship is not helped by being
//      managed, and precision is the form of respect this surface has to offer.
//
// A refusal is written as a promise about procedure ("nothing you have not
// confirmed is quoted anywhere"), never as a mood ("we take care with your
// words").
//
// English, like everything in this repository — including all product copy. The
// pseudonyms 甲/乙 are named because those are the literal tokens the machine
// uses.

import type { ClientIntent } from "../../../server/db/schema";
import type { CaseCreationField } from "../../../server/cases";

/* -------------------------------------------------------------------------- */
/* The question, and what each answer costs                                   */
/* -------------------------------------------------------------------------- */

export interface IntentOption {
  readonly value: ClientIntent;
  readonly label: string;
  /** The short flag next to the option, before it is chosen. */
  readonly flag: string | null;
  /** The cost, surfaced the moment the option is chosen. */
  readonly consequence: readonly string[];
}

/**
 * Three answers, and the cost of each stated at the moment of ambition rather
 * than as a disappointment at the end (04-ux-design-plan.md §4.1).
 *
 * The middle one is the whole reason this screen exists: it names the output the
 * product will not produce from one account, before the person has invested
 * anything in it.
 */
export const INTENT_OPTIONS: readonly IntentOption[] = [
  {
    value: "understand_what_happened",
    label: "I want to work out what actually happened",
    flag: null,
    consequence: [
      "One account supports this. You get the record laid out in order, with " +
        "each item labelled by what it is — an original message, or something " +
        "recalled afterwards — and with the gaps named.",
      "Where your account is the only source for something, the document says " +
        "so instead of resting on it.",
    ],
  },
  {
    value: "allocate_fault",
    label: "I want to know whose fault it was",
    flag: "needs both of you",
    consequence: [
      "That requires the other person to answer too. It is the one output " +
        "this will not produce from one side.",
      "On your own, you get the record laid out and its gaps named — never an " +
        "allocation of fault, and nothing about what she was thinking or why " +
        "she did it.",
      "You can still file. The case opens at the one-sided level, and it says " +
        "on the document that it is there because only one person has spoken. " +
        "Her answering is the only thing that moves it.",
    ],
  },
  {
    value: "prevent_recurrence",
    label: "I want to know how to stop it happening again",
    flag: null,
    consequence: [
      "One account supports this in one direction only: what the record shows " +
        "about your own conduct, and what you could do differently.",
      "It does not support claims about what the other person will do, because " +
        "nothing in the record is from her.",
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* The advance-disclosure card                                                */
/* -------------------------------------------------------------------------- */

const PROCEDURE: readonly string[] = [
  "You write your account, then confirm it line by line. Nothing you have not " +
    "confirmed can be quoted in any document.",
  "You add what you have — screenshots, messages, recordings. Each item is " +
    "graded by rule from what it is, not by how convincing it reads.",
  "You can invite the other person. Before she decides anything, she is shown " +
    "what the case already says about her.",
  "The level this case can reach is computed from the record before any " +
    "document is written. The model writes inside that level and cannot raise it.",
  "A finished document is frozen. A later version is numbered, states what " +
    "changed, and names which model produced it.",
];

interface LevelLine {
  readonly level: string;
  readonly when: string;
  readonly licenses: string;
}

/**
 * What each level licenses, in the same words the derivation uses.
 *
 * This is the disclosure that makes the level legible before it is locked: a
 * person who reads this at filing cannot be surprised at the end by an output
 * that stopped short of what they wanted.
 */
const LEVELS: readonly LevelLine[] = [
  {
    level: "L3",
    when: "nothing in the record grounds a fact",
    licenses:
      "a description of the account. Nothing rests on it and no finding is made.",
  },
  {
    level: "L2",
    when: "one person has spoken, with material behind it",
    licenses:
      "a description of the record and its gaps, an evaluation of your own " +
      "conduct, and a list of what is missing and what supplying it would " +
      "change. No allocation of responsibility, nothing about the absent " +
      "person's motives, and no inference from her silence.",
  },
  {
    level: "L1",
    when: "both people have spoken and both have material of their own",
    licenses:
      "everything above, plus findings about both parties' responsibility. " +
      "Both findings go to both readers.",
  },
  {
    level: "Refused",
    when: "the safety screen finds this is the wrong instrument",
    licenses:
      "the reason it stopped and where to go instead. No document is produced.",
  },
];

const PARTICIPATION: readonly string[] = [
  "Only her answering moves the case from one-sided to both-sided. Time does " +
    "not. Silence is not evidence, not agreement, and not a waiver — if she " +
    "never answers, the case stays where it is and the document says why.",
  "Her material reaches you only by being quoted in a published document, with " +
    "its grade and where it came from attached. There is no browsing her files, " +
    "in either direction.",
  "Both names are replaced with placeholders before any text is sent to a " +
    "model. The table that maps the placeholders back never leaves this machine.",
];

/**
 * The card printed before any evidence is asked for (doc 05 §C amendment 2).
 *
 * Static: it is not conditional on the answer above it, because the point is
 * that the procedure is disclosed to everybody in advance rather than produced
 * as an explanation once somebody is disappointed.
 */
export function AdvanceDisclosure() {
  return (
    <section
      aria-labelledby="disclosure-heading"
      className="flex flex-col gap-5 rounded-xl border border-neutral-300 bg-neutral-50 p-5"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="disclosure-heading"
          className="text-base font-medium text-neutral-900"
        >
          How this works, before you type anything into it
        </h2>
        <p className="text-sm leading-relaxed text-neutral-700">
          Stated in advance so it can be checked against what actually happens,
          rather than explained afterwards.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          The procedure
        </h3>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5">
          {PROCEDURE.map((step) => (
            <li key={step} className="text-sm leading-relaxed text-neutral-800">
              {step}
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          What each level of output licenses
        </h3>
        <dl className="flex flex-col gap-2">
          {LEVELS.map((line) => (
            <div key={line.level} className="flex flex-col gap-0.5">
              <dt className="text-sm font-medium text-neutral-900">
                {line.level}
                <span className="font-normal text-neutral-500">
                  {" — "}
                  {line.when}
                </span>
              </dt>
              <dd className="text-sm leading-relaxed text-neutral-700">
                {line.licenses}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-relaxed text-neutral-500">
          The level is decided by code from what the record contains, and locked
          onto the case before the document is written. It is not something the
          model is asked for or allowed to argue with.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          What the other person taking part changes
        </h3>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          {PARTICIPATION.map((line) => (
            <li key={line} className="text-sm leading-relaxed text-neutral-800">
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Field copy                                                                 */
/* -------------------------------------------------------------------------- */

export const FIELD_COPY: Readonly<
  Record<
    Exclude<CaseCreationField, "intent">,
    { readonly label: string; readonly help: string }
  >
> = {
  title: {
    label: "Name this case",
    help:
      "One line about what is being judged. It can be changed later, when the " +
      "issues are framed.",
  },
  clientName: {
    label: "Your name",
    help: "The name that appears in the messages.",
  },
  counterpartyName: {
    label: "The other person's name",
    help:
      "Needed whether or not she ever takes part: a name that is not in the " +
      "replacement table stops this case from sending anything at all.",
  },
  account: {
    label: "What happened, in your own words",
    help:
      "Blank lines split it into lines you will confirm one at a time. It is " +
      "stored exactly as typed, in the language you type it in.",
  },
};

/** Why the form asks for two real names, printed next to the fields. */
export const WHY_NAMES: readonly string[] = [
  "Both names are stored on this machine and replaced with placeholders — 乙 " +
    "for you, 甲 for the other person — before any text is sent to a model. " +
    "The table that maps them back is never sent.",
  "This is also why neither field can be left blank or filled with a " +
    "placeholder of your own: an unregistered name is not a small gap, it " +
    "blocks the case from sending anything.",
];
