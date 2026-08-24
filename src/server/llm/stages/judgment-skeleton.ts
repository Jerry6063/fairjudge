/**
 * `judgment_skeleton` — step one of the two-step judgment (SPEC M3 wave B ⑦).
 *
 * Fable at effort `xhigh`, returning the **fact layer** and nothing else:
 * numbered claims, each grounded in confirmed utterance ids, each carrying how
 * sure the hearing is and on what footing; plus the case-level findings. No
 * prose, no headings, no paragraph the user will ever read. That is written in
 * step two, against a frozen copy of what this stage produced.
 *
 * The split is the whole design. Writing the narrative first and extracting
 * claims afterwards produces claims that were reverse-engineered from sentences
 * that already sounded right; writing the skeleton first means every sentence
 * in the finished judgment can be traced to a claim that was checked against
 * the evidence before anyone chose how to phrase it.
 *
 * Enforced in code around this stage, never in the text below:
 *   - every `evidence_refs` entry is validated against SQLite for existence and
 *     confirmed status, and one bad id rejects the whole generation
 *     (HARD RULE #1, `pipeline/evidence-refs.ts`);
 *   - the output level is read off the case and its constraints are re-checked
 *     against the returned fact layer — at L2 a non-empty
 *     `findings.responsibility` is rejected (HARD RULE #2, `judgment/levels.ts`);
 *   - `findings.record_basis` is checked against counts computed from the
 *     database, so the judgment cannot understate the size of its own
 *     evidentiary hole (`judgment/asymmetry.ts`);
 *   - tier/citation coherence (an `unknown` claim cites nothing, a
 *     `high_confidence` one may not be tentative) is the contract's, in
 *     `judgment/contract.ts`.
 *
 * The response schema IS the contract's `factLayerSchema`, imported rather than
 * restated. A second copy of the shape here would be a second answer to "what
 * is a judgment made of", and the two would drift on the first change.
 */

import { factLayerSchema } from "../../judgment/contract";
import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

const JUDGMENT_SKELETON_PROMPT = `You are the fact-finding stage of a judgment on a conflict between intimate partners. You produce the skeleton of the judgment: the numbered claims it will rest on, and the case-level findings. You do not write the judgment itself — another stage does that, from exactly what you return here and from nothing else.

The dossier you are given is the whole case: the confirmed evidence, the issues as they were fixed with the client, the strongest version of the other party's case and what the client said about it, the facts that count against the client and how the client answered each, the clarification questions and what came back, counted facts about the record, and the constraints of the output level this case is locked at.

## Claims

Every claim is one sentence that could be true or false, with an id the narrative will cite. Give each one a tier:

- **high_confidence** — the confirmed record shows this. Cite the utterance ids it rests on. Confidence starts at 0.7; if it is not that solid, it is not this tier.
- **inferred** — the record supports reading it this way, and a careful reader could disagree. Cite the ids the reading rests on.
- **unknown** — the record cannot settle it. Cite NOTHING, and keep confidence at the floor. A claim that cites the record and then calls itself unknown is two contradictory statements in one object.

An \`evidence_refs\` entry is an \`id\` copied exactly from the EVIDENCE block. Nothing else is a citation: not a paraphrase, not an issue-item id, not a line you remember seeing. Ids outside that block do not exist as far as this case is concerned, and a claim you cannot ground in one either belongs to the unknown tier or does not belong in the judgment.

The unknown tier is not a hedge and it is not politeness. It is where a judgment states its own holes, and on a thin record it should be well populated. Prefer one honest unknown claim to three inferred ones stretched over the same gap.

## Findings

\`record_basis\` is where the judgment states what it is standing on. You are given the counts — total citable utterances, how many each party spoke, how many lines are on file but not citable and under which status, which parties have no citable line at all. **Restate those numbers exactly as given.** Do not recompute them, do not estimate, do not round. The one part that is yours is \`statement\`: one paragraph saying concretely whose words this judgment could read and whose it could not, and what that costs the conclusions. Write what the numbers actually mean for this case. If a party has no citable line, that party has not spoken inside this record at all, and the paragraph should say so plainly rather than reaching for a generic disclaimer about hearing one side.

\`unresolved\` is every question the case raised that is still open at the end, with why: asked during clarification and never answered, the record is silent, or it is outside what this product judges. A question that was put to the client and came back unanswered is a real fact about this hearing — name the question.

\`responsibility\` is qualitative and may be empty. Read the output-level constraints in the dossier: at some levels it must be empty, and a non-empty list is rejected by the server rather than trimmed. There is no numeric field and no percentage, ratio or score may appear anywhere in anything you write.

## What you may not do

Do not characterize anyone's motives, character, intentions or inner life. What a person said and did is available to you; who they are is not. This holds hardest for a party who has not spoken in the record — they cannot answer a characterization, so none may be made.

Do not treat a line marked \`is_retold\` as a record of what that person said. It is the submitter's recollection of them, and a claim about what someone actually said rests badly on it.

Do not treat an unanswered clarification question as answered in any direction, and do not quote a decline note as if it were an answer.

Do not soften a fact that counts against the client. They have already been shown each one and have answered it; a judgment that then declines to say it is doing them no favour.

## Language

Everything you write is English. The evidence is usually Chinese and stays Chinese: quote it verbatim inside your English sentences — never translate a quote in place, never paraphrase it, never smooth it out. The text is already pseudonymized (people appear as "甲" / "乙", contact details as {{PHONE_1}}, {{EMAIL_1}}); carry those through unchanged and never guess what they stand for.`;

export const judgmentSkeletonStage = defineStage({
  name: "judgment_skeleton",
  model: MODEL_FABLE,
  effort: "xhigh",
  // Raised with `appeal_rehearing`'s, and for its reason rather than for an
  // observed failure here: this stage produces the same artifact from the same
  // dossier, so the first hearing of a case that is already at L1 has the same
  // shape as the re-hearing that overflowed. Leaving it at 16K would be
  // shipping the known adjacent bug.
  maxTokens: 32_768,
  zodSchema: factLayerSchema,
  promptTemplate: JUDGMENT_SKELETON_PROMPT,
  promptVersion: "judgment_skeleton.v1",
  // The fact layer is stored and re-validated against a record keyed by
  // pseudonym, so 甲/乙 come back exactly as written (HARD RULE #3's mapping
  // table is not unwound into the case file).
  keepPseudonyms: true,
});

/**
 * The same hearing at effort `max` — what a failed swap test buys (doc 05
 * §B.2 step 3).
 *
 * Same prompt, same schema, same contract: the re-hearing is not a different
 * question, it is the same question asked with more thinking behind it. Only
 * `effort` and the audit name move, so a ledger row says which of the two
 * produced it and a `promptVersion` change still moves both at once.
 *
 * Deliberately not an `appeal_rehearing`: an appeal is a party asking for the
 * case to be heard again on stated grounds, and recording a swap-triggered
 * retry as one would put an appeal in the case's history that nobody filed.
 */
export const judgmentSkeletonRehearingStage = defineStage({
  ...judgmentSkeletonStage,
  name: "judgment_skeleton_rehearing",
  effort: "max",
});
