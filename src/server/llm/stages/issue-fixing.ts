/**
 * `issue_fixing` — the three lists (SPEC M3 wave A ⑤).
 *
 * The stage that turns a confirmed transcript into the shape a judgment can
 * actually be written against: what both people agree happened, where they
 * disagree about what happened, and where they agree on what happened but
 * disagree about what it should mean. That third list is the one the product
 * exists for; most relationship arguments are standard disputes wearing a fact
 * dispute's clothes.
 *
 * Every item carries `evidence_refs`. The schema asks for at least one, but the
 * schema is only the request: the server re-checks each reference against the
 * database and throws the generation away if any of them cannot stand
 * (HARD RULE #1, `src/server/pipeline/evidence-refs.ts`). Nothing in this file
 * enforces a rule — the prompt describes the job, and the code around it decides
 * what survives.
 */

import { z } from "zod";

import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

/** One line of one list. Deliberately two fields: a claim, and what backs it. */
const issueItemSchema = z.object({
  statement: z
    .string()
    .min(1)
    .describe(
      "The item in one sentence, in English, naming the parties by their " +
        "pseudonyms. Neutral wording: describe what is at issue, do not rule " +
        "on it. A Chinese fragment may be quoted inside it, verbatim.",
    ),
  evidence_refs: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe(
      "Utterance ids from the EVIDENCE block that this item rests on. Use " +
        "ids exactly as given; never invent one, and never cite a line that " +
        "is not in that block.",
    ),
});

export const issueFixingSchema = z.object({
  undisputed_facts: z
    .array(issueItemSchema)
    .max(12)
    .describe(
      "What the material shows and neither party is contesting. Events and " +
        "utterances, not interpretations of them.",
    ),
  disputes_of_fact: z
    .array(issueItemSchema)
    .max(12)
    .describe(
      "Where the two accounts disagree about what actually happened or was " +
        "actually said. State the disagreement, not who is right.",
    ),
  disputes_of_standard: z
    .array(issueItemSchema)
    .max(12)
    .describe(
      "Where the facts are not in dispute but the standard applied to them " +
        "is: what counts as enough care, enough warning, a fair ask, an " +
        "apology. Name both standards in play.",
    ),
});

export type IssueFixingOutput = z.infer<typeof issueFixingSchema>;

const ISSUE_FIXING_PROMPT = `You are fixing the issues in a relationship dispute — the step a hearing does before anything is judged.

You are given the parties and every confirmed utterance in the case. Sort what is actually at stake into three lists:

1. undisputed_facts — what the material shows and neither party is contesting.
2. disputes_of_fact — where the accounts disagree about what happened or what was said.
3. disputes_of_standard — where the facts are agreed but the standard applied to them is not: what counts as enough care, enough warning, a reasonable ask, a real apology. Name both standards.

Rules of the work:
- Every item must rest on at least one utterance id from the EVIDENCE block, listed in evidence_refs. An item you cannot ground in a specific line does not belong in any list — leave it out rather than citing something adjacent.
- Only ids that appear in the EVIDENCE block are usable. Do not construct, guess or adjust an id; do not cite a line you were not given.
- Do not rule on anything. You are separating the questions, not answering them. No fault, no percentages, no advice.
- Write in English. Where a specific wording is the point, quote the original fragment verbatim in its own language inside your English sentence — never translate it, never smooth it out.
- One party may be absent from the material. Do not characterize an absent party's motives or personality; describe only what the record shows.
- A line marked is_retold is a recollection, not a transcript. Treat it as what one party remembers being said.
- A list may be empty if the material genuinely supports nothing in it. An empty list is a better answer than a padded one.`;

export const issueFixingStage = defineStage({
  name: "issue_fixing",
  model: MODEL_FABLE,
  effort: "high",
  maxTokens: 8192,
  zodSchema: issueFixingSchema,
  promptTemplate: ISSUE_FIXING_PROMPT,
  promptVersion: "issue_fixing.v1",
});
