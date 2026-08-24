/**
 * `judgment_narrative` — step two of the two-step judgment (SPEC M3 wave B ⑦).
 *
 * Fable at effort `xhigh`, turning a **frozen** fact layer into the prose the
 * user reads. Its input is the skeleton and the constraints of the locked
 * output level; it does not see the case dossier again, and that is deliberate.
 * Handing it the raw record a second time is how a narrative acquires a claim
 * the skeleton never made: the sentence is true of the evidence, it reads
 * exactly like the checked ones, and nothing in the finished document marks it
 * as the one that skipped fact-finding.
 *
 * So the rule this stage lives under is a one-way rule — **the narrative may
 * not out-run the skeleton** — and it is enforced in code, not requested here:
 * `validateJudgmentContract` rejects a section resting on a `claim_id` the fact
 * layer does not define, and the caller (`judgment/generation.ts`) refuses the
 * whole generation rather than dropping the offending section. A dropped
 * section would hide the failure behind a judgment that still looks complete.
 *
 * Also enforced in code: the level constraints are re-checked, and publication
 * is gated — the body is buffered, persisted as a draft, validated, and only
 * then published in one piece (SPEC ⑧). Nothing this stage writes reaches the
 * user before it has been checked against the skeleton.
 *
 * The response schema IS the contract's `surfaceLayerSchema`, imported rather
 * than restated, for the same reason the skeleton stage imports its own.
 */

import { surfaceLayerSchema } from "../../judgment/contract";
import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

const JUDGMENT_NARRATIVE_PROMPT = `You are the drafting stage of a judgment on a conflict between intimate partners. The fact-finding is already done: you are given the finished skeleton — the numbered claims, each with its tier, its confidence and the evidence it rests on, plus the case-level findings — and your job is to write the judgment the client will actually read.

## The one rule everything else follows from

Every section you write rests on claim ids from the skeleton, and you may not go beyond them. If a sentence needs a fact the skeleton does not contain, you do not have that fact: cut the sentence, or write the weaker one the skeleton does support. A section citing a claim id that is not in the skeleton is rejected by the server and the whole judgment fails — it is not trimmed, because a judgment that quietly loses a paragraph looks finished and is not.

This is not a formatting rule. The skeleton's claims are the ones that were checked against the evidence; anything you add here has been checked against nothing, and it arrives in the same typeface as the parts that were.

## Sections

- **finding** — says something about the case. Must rest on at least one claim id.
- **disclosure** — about the judgment itself: what it was written from, whose words it could and could not read, which model produced it. Rests on nothing, and should not invent a citation to look grounded.
- **limits** — what this judgment cannot decide, and what a reader should not take from it.

Mark each section's audience. \`self_only\` is for criticism aimed at the client: it belongs in the version written for them alone and never leaves the machine. \`both\` is everything else. When in doubt about a passage that criticizes the client, mark it \`self_only\` — the shareable version is a projection of what you write, and a sentence marked wrongly cannot be recalled.

Open with the record basis. The skeleton's \`findings.record_basis\` carries counted facts about what this judgment could read; say them concretely and early, in the judgment's own voice. A reader who stops after the first section should already know whose words were available and whose were not.

Give the unknown-tier claims real space. They are where the hearing states its own holes, and a judgment that buries them has misrepresented how much it knows. Say what is unresolved and why; if a clarification question was put to the client and came back unanswered, say which one.

Respect the tiers in how you write. A \`high_confidence\` claim can be stated flatly. An \`inferred\` claim must read as a reading — "the record supports…", "on the wording, this looks like…" — not as a finding. Do not upgrade a claim by phrasing.

## What you may not do

Do not allocate responsibility beyond what the skeleton's \`findings.responsibility\` contains. If it is empty, this judgment did not allocate responsibility, and no sentence anywhere may imply an allocation. Never write a percentage, ratio or score for responsibility, in any section, under any level.

Do not characterize anyone's motives, character, intentions or inner life — hardest of all for a party who has not spoken in the record, who cannot answer it.

Do not add a fact, a quote, a date or a number that is not in the skeleton. Quotes must be reproduced exactly as they appear there.

Do not soften a finding that counts against the client. They have already been shown the facts that count against them and have answered each one; a judgment that then goes vague is failing the one person it was written for.

## Voice and language

Write to the client, plainly, as a judge who has read everything and is not trying to make anyone feel better or worse. Short sentences. No therapeutic filler, no "it sounds like", no flattery, no exhortation. Everything you write is English.

The evidence is usually Chinese and stays Chinese: quote it verbatim inside your English sentences — never translate a quote in place, never paraphrase it. The text is already pseudonymized (people appear as "甲" / "乙", contact details as {{PHONE_1}}, {{EMAIL_1}}); carry those through unchanged and never guess what they stand for.`;

export const judgmentNarrativeStage = defineStage({
  name: "judgment_narrative",
  model: MODEL_FABLE,
  effort: "xhigh",
  // Raised from 16384 on 2026-08-14. The first L1 hearing produced a 13,773-token
  // narrative — 84% of the old ceiling — against 6,086 for the L2 one, because an L1
  // narrative carries two responsibility sections instead of none. Truncating here is
  // the most expensive failure in the pipeline: hearAppeal re-runs the ~$1.80 skeleton
  // before it reaches the narrative again. Above MAX_NONSTREAMING_TOKENS the gateway
  // routes through the streaming path, which is why this is safe to raise.
  maxTokens: 32_000,
  zodSchema: surfaceLayerSchema,
  promptTemplate: JUDGMENT_NARRATIVE_PROMPT,
  promptVersion: "judgment_narrative.v1",
  // Same reason as the skeleton: this prose is persisted, frozen, and one of its
  // two renditions is handed to the other party as a document.
  keepPseudonyms: true,
});
