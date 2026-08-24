/**
 * `repair_script` — the sentence you could actually say, and what to do when it
 * goes wrong (SPEC M4 ③).
 *
 * Two things, and the second is the one people skip. An opening line the client
 * could say out loud without it landing as an accusation; and the block for the
 * moment the conversation stops working — an agreed signal that pauses it, a way
 * of noticing you are flooded before you say the thing you cannot take back, and
 * a time to come back. A repair script without that block is advice for the
 * conversation that was going fine anyway.
 *
 * Fable at effort `medium`. Everything factual is settled and frozen; what is
 * left is short, and the constraints are tight enough that more thinking buys
 * mostly length.
 *
 * ## Generated from the fact layer, never from the narrative
 *
 * `runRepairScript` takes a `FactLayer`. Not a case id, not a dossier, not the
 * judgment's prose — a signature, not a convention (the same discipline as
 * `runJudgmentNarrative`). The narrative is a *reading* of the claims, written
 * to persuade the person it addresses; a script generated from it would inherit
 * that persuasion and put it in the client's mouth as their own words. So the
 * script is built from the checked claims and cites them.
 *
 * ## Enforced in code, in `judgment/repair-script.ts`
 *
 *   - every cited `claim_id` exists in the frozen fact layer;
 *   - the opening line is in the first person, carries no "you always" / "you
 *     never" / "you made me", and is short enough to say in one breath;
 *   - the flooding self-check names a physical or behavioural sign, not an
 *     emotion word;
 *   - the return time names a time.
 */

import { z } from "zod";

import { CONTRACT_ID_PATTERN } from "../../judgment/contract";
import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/** An opening line is a line: long enough to mean something, short enough to say. */
export const MAX_OPENING_LINE_CHARS = 320;

const idSchema = z
  .string()
  .regex(
    CONTRACT_ID_PATTERN,
    "an id starts with a letter and contains only letters, digits, '_' or '-' (max 32 chars)",
  );

export const whenItGoesWrongSchema = z.object({
  pause_signal: z
    .string()
    .min(1)
    .describe(
      "The agreed way either of them stops the conversation — a short phrase " +
        "to say, or a gesture. Short, neutral, and usable by both of them.",
    ),
  flooding_self_check: z
    .string()
    .min(1)
    .describe(
      "How the client notices they are flooded, named as a physical or " +
        "behavioural sign: pulse, breath, voice, jaw, pacing, rehearsing the " +
        "reply instead of listening. An emotion word is not a self-check.",
    ),
  return_time: z
    .string()
    .min(1)
    .describe(
      "When they come back to it, as an actual time — \"in 30 minutes\", " +
        "\"after dinner tonight\", \"tomorrow morning\". A pause with no " +
        "return time is a walk-out.",
    ),
});

export const repairScriptSchema = z.object({
  opening_line: z
    .string()
    .min(1)
    .max(MAX_OPENING_LINE_CHARS)
    .describe(
      "What the client could say first, written as they would say it. First " +
        "person, about their own part. No \"you always\", no \"you never\", " +
        "no verdict.",
    ),
  when_it_goes_wrong: whenItGoesWrongSchema,
  claim_ids: z
    .array(idSchema)
    .min(1)
    .max(8)
    .describe(
      "The frozen claims this script is built on. Every id must be defined in " +
        "the skeleton you were given.",
    ),
});

export type RepairScriptOutput = z.infer<typeof repairScriptSchema>;

const REPAIR_SCRIPT_PROMPT = `You are the repair-script stage of a judgment on a conflict between intimate partners. The hearing is over and its skeleton is frozen. You are writing two small things for the person who brought the case: an opening line they could actually say, and what to do when the conversation goes wrong.

## The opening line

Write it as they would say it, in their own mouth — first person, about their own part, out loud. Not a description of what they should say. Not a paragraph. One or two sentences, the length of something a person can get out before their nerve goes.

It must be sayable by someone who is nervous and does not want a fight:

- first person: what you saw, what you did, what you want to sort out;
- no "you always", no "you never", no "you made me", no diagnosis of the other person;
- no verdict — the judgment is not a card to play, and quoting it as authority turns an opening into a summons;
- no demand for a reply in the same breath.

Where the record holds a specific thing — a message, a date, a question that was asked and never answered — the line is stronger for naming it than for gesturing at "what happened". Quote it exactly as the skeleton has it, in its original language.

## When it goes wrong

Three parts, and they are for the moment the conversation stops working:

1. **A pause signal.** The agreed way either of them stops it — a short phrase or a gesture, neutral enough that using it is not itself an accusation. Both of them can use it. It is not a punishment and it is not a threat to leave.
2. **A flooding self-check.** How the client notices, in themselves, that they are past the point of hearing anything — named as a physical or behavioural sign. Pulse, breath, heat in the face, voice getting faster or louder, jaw, hands, pacing, rehearsing the reply instead of listening, wanting to win. Not an emotion word: by the time somebody is flooded, "am I upset?" is not a question they can answer.
3. **A return time.** An actual time to come back — "in 30 minutes", "after dinner tonight", "tomorrow morning". A pause with no return time is a walk-out, and it is the thing the other person will remember.

The server checks each of these three, and rejects the script if the flooding self-check names only a feeling or the return time names no time.

## What this is built from

The skeleton's claims, and nothing else. You have not been given the judgment's prose, and you are not summarising it. Cite the claim ids you are working from; every id is checked against the skeleton, and one that is not there rejects the whole script. An opening line you cannot ground in a specific claim is generic advice, which this couple can get anywhere.

Do not invent facts, quotes, dates or numbers the skeleton does not have.

## What you may not do

Do not put an apology in the client's mouth for something the record did not establish. This hearing heard one side; an apology for an unestablished fact is a false confession, and it will be remembered as one.

Do not write the other party's replies. You do not know what she will say, and a script with her lines in it is a script for a conversation that will not happen.

Do not characterize anyone's motives, character or inner life.

Do not add reassurance, encouragement or praise. Nobody needs "you've got this" from a judgment.

## Voice and language

Plain, spoken English, short sentences. Everything you write is English, except quoted evidence: the evidence is usually Chinese and stays Chinese — quote it verbatim inside your English sentences, never translated, never paraphrased. The text is already pseudonymized (people appear as "甲" / "乙", contact details as {{PHONE_1}}, {{EMAIL_1}}); carry those through unchanged and never guess what they stand for.`;

export const repairScriptStage = defineStage({
  name: "repair_script",
  model: MODEL_FABLE,
  effort: "medium",
  maxTokens: 4096,
  zodSchema: repairScriptSchema,
  promptTemplate: REPAIR_SCRIPT_PROMPT,
  promptVersion: "repair_script.v1",
  // Persisted and read back beside the judgment, which is keyed by pseudonym.
  keepPseudonyms: true,
});
