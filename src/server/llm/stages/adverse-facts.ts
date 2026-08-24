/**
 * `adverse_facts` — the facts that count against the client (SPEC M3 wave A ⑥).
 *
 * The one stage in the pipeline whose job is to argue against the person paying
 * for it. Everything else in the product reads the client's material to
 * understand their case; this reads the same material for what a fair reader
 * would hold against them, and hands it back before any judgment runs.
 *
 * Two things keep it from drifting into a general fault-finding pass:
 *   - it looks at the CLIENT only. A fact unfavourable to the other party is
 *     not an adverse fact — it is the thing the client already believes, and
 *     surfacing it here would turn the gate into flattery.
 *   - every item cites confirmed material, validated server-side like every
 *     other model-emitted reference (HARD RULE #1). An accusation with no line
 *     behind it is exactly the thing the client is entitled not to have to
 *     answer.
 *
 * Effort is `medium` rather than `high`: this is extraction from a record the
 * client supplied, not adjudication. The reasoning budget belongs downstream.
 */

import { z } from "zod";

import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

export const adverseFactsSchema = z.object({
  adverse_facts: z
    .array(
      z.object({
        statement: z
          .string()
          .min(1)
          .describe(
            "Two sentences at most, in English, addressed to the client as " +
              "'you': what the record shows you did or said, and why a fair " +
              "reader would hold it against you. A Chinese fragment may be " +
              "quoted inside it, verbatim.",
          ),
        evidence_refs: z
          .array(z.string().min(1))
          .min(1)
          .max(6)
          .describe(
            "Utterance ids from the EVIDENCE block that show this. Use ids " +
              "exactly as given; never invent one.",
          ),
      }),
    )
    .max(10)
    .describe(
      "Only facts unfavourable to the client. Ordered strongest first.",
    ),
});

export type AdverseFactsOutput = z.infer<typeof adverseFactsSchema>;

const ADVERSE_FACTS_PROMPT = `You are reading one party's own evidence for what counts against THEM.

The client is the party marked \`is_client: true\` in the PARTIES block. They assembled this material themselves, believing it supports them. Your job is the opposite reading: the facts in it that a fair reader would hold against the client, put to them plainly before anything is judged.

Rules of the work:
- Only facts unfavourable to the CLIENT. A fact unfavourable to the other party does not belong here at all, however true it is.
- Every item must rest on at least one utterance id from the EVIDENCE block, listed in evidence_refs. If you cannot point at a specific line, leave the item out — an accusation with nothing behind it is worse than an omission.
- Only ids that appear in the EVIDENCE block are usable. Do not construct, guess or adjust an id.
- Address the client directly as "you". Describe conduct, not character: what was said or done and why it lands badly, never what kind of person that makes them.
- Do not soften it, and do not moralize either. One or two plain sentences per item.
- Write in English. Where the exact wording is the point, quote the original fragment verbatim in its own language — never translate it.
- A line marked is_retold is a recollection, not a transcript; say so if you rest an item on one.
- Return an empty list only if the material genuinely contains nothing unfavourable to the client. That is rare; look again before concluding it.`;

export const adverseFactsStage = defineStage({
  name: "adverse_facts",
  model: MODEL_FABLE,
  effort: "medium",
  maxTokens: 4096,
  zodSchema: adverseFactsSchema,
  promptTemplate: ADVERSE_FACTS_PROMPT,
  promptVersion: "adverse_facts.v1",
});
