/**
 * `improvement_contract` — what actually changes on Monday (SPEC M4 ②).
 *
 * A judgment that is read and agreed with changes nothing. This stage turns a
 * frozen fact layer into at most three undertakings that a person can execute
 * inside a week and that somebody other than the author could tell had happened.
 *
 * Fable at effort `high`. This is not fact-finding — the facts are frozen — but
 * it is not writing either: naming an occasion in this couple's actual week and
 * an act that fits it is the hard part, and effort is what buys the difference
 * between "communicate more" and "when she asks a question I do not want to
 * answer, I answer it the same evening, even badly".
 *
 * ## Every rule below is also enforced in code
 *
 * The prompt states them because a model that is told a rule usually keeps it.
 * None of them is enforced *here* (CLAUDE.md: a hard rule that lives in a prompt
 * and nowhere else is a bug). `judgment/improvement-contract.ts` holds:
 *
 *   - **provenance** — every `claim_ids` entry must already exist in the frozen
 *     fact layer, checked against that layer, whole generation rejected on a miss;
 *   - **the L2 binding rule** — at any level below L1 the counterparty was never
 *     heard, so an item bound to her is not a commitment. The server demotes it
 *     to an invitation and labels it one; the storage door refuses to write a
 *     counterparty commitment at all;
 *   - **vagueness** — a trigger that names no occasion, an action wearing a
 *     comparative ("be more considerate") or an "observable" that is somebody's
 *     inner state is rejected item by item;
 *   - **within seven days** — an integer field, bounded by the schema.
 *
 * The one thing the model is trusted with is judgment about *which* undertaking
 * is worth making. The checks can only refuse the shapes that are known to be
 * empty.
 */

import { z } from "zod";

import { CONTRACT_ID_PATTERN } from "../../judgment/contract";
import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/** Which party an item binds. Whether it may is a question of level, in code. */
export const COMMITMENT_PARTIES = ["client", "counterparty"] as const;
export type CommitmentParty = (typeof COMMITMENT_PARTIES)[number];

/** The longest a commitment may run and still be this milestone's business. */
export const MAX_COMMITMENT_DAYS = 7;

/** Same id shape as the judgment contract's — these travel next to claim ids. */
const idSchema = z
  .string()
  .regex(
    CONTRACT_ID_PATTERN,
    "an id starts with a letter and contains only letters, digits, '_' or '-' (max 32 chars)",
  );

export const commitmentItemSchema = z.object({
  item_id: idSchema.describe("Short stable id for this item, e.g. k1."),
  bound_party: z
    .enum(COMMITMENT_PARTIES)
    .describe(
      "Who would have to do this. Below L1 only the client may be bound: the " +
        "other party was never heard, and the server stores anything addressed " +
        "to her as an invitation instead.",
    ),
  trigger: z
    .string()
    .min(1)
    .describe(
      "The occasion this starts on, as an occasion: \"when …\", \"if …\", " +
        "\"the next time …\", \"after …\". Not a disposition and not a mood — " +
        "a situation that either happens or does not.",
    ),
  action: z
    .string()
    .min(1)
    .describe(
      "What the bound party does when the trigger fires. One act, in plain " +
        "words. No comparatives (\"more patient\"), no \"try to\", no verbs of " +
        "intention.",
    ),
  observable: z
    .string()
    .min(1)
    .describe(
      "What another person could see or hear that tells them it happened. A " +
        "feeling is not an observation: \"she feels heard\" is not something " +
        "anyone can check.",
    ),
  within_days: z
    .number()
    .int()
    .min(1)
    .max(MAX_COMMITMENT_DAYS)
    .describe(
      `How many days this needs, 1-${MAX_COMMITMENT_DAYS}. Anything longer is ` +
        `a plan, not a commitment, and nothing follows it up.`,
    ),
  claim_ids: z
    .array(idSchema)
    .min(1)
    .max(6)
    .describe(
      "The frozen claims this rests on. At least one, and every id must be " +
        "defined in the skeleton you were given.",
    ),
});

export type CommitmentItem = z.infer<typeof commitmentItemSchema>;

export const improvementContractSchema = z.object({
  items: z
    .array(commitmentItemSchema)
    .min(1)
    .max(3)
    .describe(
      "One to three items. Three is a ceiling, not a target: a list nobody " +
        "can hold in their head on a bad evening is a list that gets dropped " +
        "whole.",
    ),
});

export type ImprovementContractOutput = z.infer<typeof improvementContractSchema>;

const IMPROVEMENT_CONTRACT_PROMPT = `You are the improvement-contract stage of a judgment on a conflict between intimate partners. The hearing is over and its skeleton is frozen. Your job is the part that changes something: one to three undertakings, drawn from what the record actually established, that can be carried out inside a week.

## What an item has to be

Each item has four parts, and every one of them is checked by the server before anything is stored.

1. **A trigger.** The occasion it starts on, phrased as an occasion: "when she asks …", "if the conversation reaches …", "the next time …", "after …". A situation that either happens or does not. "In general", "going forward" and "at all times" are not triggers — they are dispositions wearing a trigger's clothes, and an undertaking with no occasion has no moment at which anyone has failed to keep it.
2. **An action.** One act, in plain words, that the bound party performs when the trigger fires. Not an attitude, not an intention, not a comparative. "Be more considerate", "communicate more", "try to be present" and "work on my defensiveness" are all rejected: none of them names anything anybody does.
3. **An observation.** What another person could see or hear that tells them the action happened. If the only evidence would be inside somebody's head — "she feels heard", "he understands me better" — it is not an observation and the item is rejected.
4. **A number of days**, at most seven. Anything longer is a plan.

Each item also cites the claim ids it rests on, from the frozen skeleton. At least one. The server checks every id against the skeleton and rejects the whole contract if one is not there — so an undertaking you cannot ground in a specific claim is one you must not write. This is what keeps the contract about *this* case: generic relationship advice cites nothing, and nothing is what it is worth here.

## Who may be bound

The output level tells you whether both parties were heard.

Below L1, only one of them was. An item that requires the other party to do something is not a commitment — nobody asked her, she has not agreed to anything, and a document that says she will do X is inventing her consent. You may still write such an item: mark \`bound_party: "counterparty"\` and the server stores it as an **invitation**, labelled as one, which is what it honestly is. What you may not do is dress it as an undertaking she has made.

At least one item must be bound to the client. A contract in which every line is something the other person should do is not a contract; it is a complaint with numbering, and the server rejects it.

## What to draw on

Work from the skeleton's claims, its unresolved questions and its record basis. The strongest items usually come from three places:

- a specific thing the record shows went wrong, whose repeat is predictable enough to name a trigger for;
- an unresolved question the client could simply answer, in words, this week;
- an asymmetry the record basis states in numbers — for example, that one party's own words were never in evidence at all.

Do not invent facts, dates, quotes or numbers that are not in the skeleton. Quotes are reproduced exactly as they appear there, in their original language.

## What you may not do

Do not write an item whose whole content is a feeling: nobody can commit to feeling something.

Do not write an apology as an item unless the record supports what would be apologised for — an apology for an unestablished fact is a false confession, and this hearing heard one side.

Do not characterize anyone's motives, character or inner life. What was said and done is in the skeleton; who anyone is, is not.

Do not soften an item aimed at the client. They asked for this.

## Voice and language

Write plainly. Short sentences, ordinary words, the second person for the client ("you"). No therapeutic vocabulary, no exhortation, no praise. Everything you write is English.

The evidence is usually Chinese and stays Chinese: quote it verbatim inside your English sentences — never translate a quote in place, never paraphrase it. The text is already pseudonymized (people appear as "甲" / "乙", contact details as {{PHONE_1}}, {{EMAIL_1}}); carry those through unchanged and never guess what they stand for.`;

export const improvementContractStage = defineStage({
  name: "improvement_contract",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 8192,
  zodSchema: improvementContractSchema,
  promptTemplate: IMPROVEMENT_CONTRACT_PROMPT,
  promptVersion: "improvement_contract.v1",
  // Persisted, re-validated against a fact layer keyed by pseudonym, and shown
  // beside the judgment. Same reason the judgment stages keep 甲/乙.
  keepPseudonyms: true,
});
