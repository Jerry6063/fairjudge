/**
 * `appeal_rehearing` — the case heard again, on the record, after the client
 * said the judgment got it wrong (SPEC M4 ⑤).
 *
 * Fable at effort `max`, returning a **fact layer** — the same shape
 * `judgment_skeleton` returns, because an appeal produces a judgment and not a
 * commentary on one. Version `n + 1` is written from what comes back here, and
 * the narrative for it is written by the ordinary narrative stage from that
 * skeleton alone.
 *
 * ## Why `max` when the first hearing ran at `xhigh`
 *
 * Because the appellant has already read the answer. A re-hearing that thinks
 * about the case exactly as hard as the hearing did is a coin flipped twice; the
 * only honest reason to spend a second hearing is to look harder at the thing
 * the client says was missed. This is also the last hearing a version gets —
 * one appeal per judgment version — so there is no third pass to save budget for.
 *
 * ## What this stage is given, and what that does NOT make true
 *
 * It is given the same dossier the first hearing read (reassembled, so anything
 * confirmed since is simply in it), the frozen fact layer under appeal, and the
 * appellant's grounds in their own words. Two things follow, and both are
 * enforced in code around the call rather than by the paragraphs below:
 *
 *   - **The grounds are not evidence.** They carry no utterance id, so nothing in
 *     them can be cited: `evidence_refs` are audited against SQLite for existence
 *     and confirmed status (HARD RULE #1, `pipeline/evidence-refs.ts`), and a
 *     claim grounded in "the client says so in the appeal" cannot pass that
 *     audit. An appeal is a reason to look again, never a fact.
 *   - **The previous version is not a draft to edit.** It is shown so the
 *     re-hearing can see what is being complained about; the output is a complete
 *     fact layer, checked from scratch against the record, the locked level
 *     (HARD RULE #2) and the counted record basis. A version that "keeps
 *     everything except claim 4" is still a whole judgment being issued.
 *
 * The frozen predecessor is never written to. Version `n + 1` records what it
 * replaced (`supersedes_judgment_id`) and the diff between them is disclosed —
 * HARD RULE #6 is a duty of the re-hearing, not a courtesy after it.
 */

import { factLayerSchema } from "../../judgment/contract";
import { MODEL_FABLE } from "../config";
import { defineStage } from "./define";

const APPEAL_REHEARING_PROMPT = `You are the appeal stage of a judgment on a conflict between intimate partners. A judgment was issued, the client has read it, and they say it got something wrong. You hear the case again and produce a new skeleton: the numbered claims the new version will rest on, and the case-level findings. Another stage writes the prose, from exactly what you return and from nothing else.

You are given three things: the case dossier (the whole confirmed record, reassembled now — anything confirmed since the first hearing is already in it), the frozen fact layer of the judgment under appeal, and the grounds of appeal in the client's own words.

## What the grounds of appeal are, and what they are not

They are the client's account of what the first hearing got wrong. They are an assertion by an interested party, and they confirm nothing. A sentence in the appeal is not evidence, cannot be cited, and does not become true by being said with more conviction the second time. What they are for is direction: they tell you where to look again, and you owe that look.

Take them seriously and do not defer to them. Both failures are real. A re-hearing that reproduces the first judgment because it was already written is worthless; a re-hearing that moves because the client pushed is worse than worthless, because it teaches the client that pushing works and it hands them a judgment that the record does not support.

If the record does not support the change the appeal asks for, say so in the new skeleton — as a claim about what the record can and cannot settle, at the tier that is honest. "You are right that this was never established, and it is still not established" is a real answer and often the correct one.

## What the previous version is

It is shown so you can see what is being complained about. It is frozen and it is not a draft: you are not editing it, patching it, or returning a difference against it. You produce a complete fact layer, and every claim in it must stand on its own against the record — including the ones you agree with. A claim that survives the appeal survives because you checked it again, not because it was there.

## Claims

Every claim is one sentence that could be true or false, with an id the narrative will cite. Give each one a tier:

- **high_confidence** — the confirmed record shows this. Cite the utterance ids it rests on. Confidence starts at 0.7; if it is not that solid, it is not this tier.
- **inferred** — the record supports reading it this way, and a careful reader could disagree. Cite the ids the reading rests on.
- **unknown** — the record cannot settle it. Cite NOTHING, and keep confidence at the floor. A claim that cites the record and then calls itself unknown is two contradictory statements in one object.

An \`evidence_refs\` entry is an \`id\` copied exactly from the EVIDENCE block. Nothing else is a citation: not a paraphrase, not an issue-item id, not a sentence from the appeal, not a claim id from the previous version. Ids outside that block do not exist as far as this case is concerned, and a claim you cannot ground in one either belongs to the unknown tier or does not belong in the judgment.

You may keep a claim id from the previous version for a claim that is genuinely the same claim — that makes the diff between the two versions readable, which is what the client is owed. Do not reuse an id for a different claim.

## Findings

\`record_basis\` is where the judgment states what it is standing on. You are given the counts, computed now. **Restate those numbers exactly as given.** Do not recompute them, do not estimate, do not round, and do not carry over the numbers from the previous version — the record may have moved, and if it has, that is one of the most important facts about this re-hearing. The \`statement\` is yours: one paragraph saying concretely whose words this judgment could read and whose it could not, and what that costs the conclusions.

\`unresolved\` is every question the case raised that is still open at the end, with why. A question the appeal raises that the record still cannot answer belongs here.

\`responsibility\` is qualitative and may be empty. Read the output-level constraints in the dossier: at some levels it must be empty, and a non-empty list is rejected by the server rather than trimmed. There is no numeric field and no percentage, ratio or score may appear anywhere in anything you write.

## What you may not do

Do not characterize anyone's motives, character, intentions or inner life. What a person said and did is available to you; who they are is not. This holds hardest for a party who has not spoken in the record — they cannot answer a characterization, so none may be made.

Do not treat a line marked \`is_retold\` as a record of what that person said. It is the submitter's recollection of them.

Do not treat an unanswered clarification question as answered in any direction, and do not quote a decline note as if it were an answer.

Do not soften a fact that counts against the client. They have already been shown each one and have answered it, and they have now appealed the judgment that named them; a re-hearing that quietly drops one is not being kind, it is being dishonest with the person who asked to be heard again.

## Language

Everything you write is English. The evidence is usually Chinese and stays Chinese: quote it verbatim inside your English sentences — never translate a quote in place, never paraphrase it, never smooth it out. The grounds of appeal are the client's own words and are quoted the same way if you quote them at all. The text is already pseudonymized (people appear as "甲" / "乙", contact details as {{PHONE_1}}, {{EMAIL_1}}); carry those through unchanged and never guess what they stand for.`;

export const appealRehearingStage = defineStage({
  name: "appeal_rehearing",
  model: MODEL_FABLE,
  effort: "max",
  // Raised twice by the M5 L1 run, which truncated here: 16384 → 21333 → 32768,
  // and now to 64000.
  //
  // An L1 fact layer is structurally bigger than an L2 one: it carries the
  // responsibility list L2 forbids, and it carries claims from BOTH parties'
  // material rather than one party's. On the real case at effort `max` that
  // overflowed 16K and came back `stop_reason: "max_tokens"` — a truncated JSON
  // body, so the whole hearing failed rather than producing a short judgment.
  // 21333 truncated as well, and 21333 is `MAX_NONSTREAMING_TOKENS`: the ceiling
  // the SDK enforces on any NON-streaming call. So this budget is only reachable
  // over the streaming path in `llm/claude.ts`, which is chosen by this number
  // being above that ceiling.
  //
  // 64000 is headroom rather than an estimate, and it costs nothing to leave
  // spare: `max_tokens` is a ceiling, and only tokens actually generated are
  // billed. The observed L2 skeleton at effort `xhigh` finished in 8–11.5K
  // output tokens; at effort `max` the thinking that shares this budget is
  // what overran 21333, and there is no way to measure it from outside a call
  // that completes. `claude-fable-5` allows 128K output, so this is half the
  // model's ceiling and well under it. A hearing gets the tokens the record
  // needs — sizing the judgment to the transport is the wrong way round
  // (SPEC M5 ⑥).
  maxTokens: 64_000,
  zodSchema: factLayerSchema,
  promptTemplate: APPEAL_REHEARING_PROMPT,
  promptVersion: "appeal_rehearing.v1",
  // Same reason as `judgment_skeleton`: the fact layer is persisted and
  // re-validated against a record keyed by pseudonym, so 甲/乙 come back exactly
  // as they were written (HARD RULE #3's mapping table is never unwound into a
  // stored judgment).
  keepPseudonyms: true,
});
