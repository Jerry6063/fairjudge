---
name: fairjudge
description: Run a fairjudge case from the terminal — plain-speech translation or a single-party L2 judgment on a conflict record — using the session's own model as transport (no API spend). Use when the user wants to file/work a conflict case via CLI, translate a charged message, or drive the fairjudge pipeline without the web app.
---

# fairjudge — the skill driver

This skill is the second driver of the fairjudge kernel (canonical copy of this file:
`fairjudge/.claude/skills/fairjudge/SKILL.md`; installed copy: `~/.claude/skills/fairjudge/`).
The web app is the first driver and owns the two-person loop. This driver is the
**single-party instrument**: one terminal, one operator, one voice — which is why its ceiling
is **L2 by construction**. It lays out the record and its gaps; it never allocates fault.
That is not a missing feature. A fault allocation requires both parties, which requires the
web app's consent machinery.

Every fairness rule lives in the kernel (CLI + server functions), not in you. Your job is
transport and secretarial work. The CLI's refusals are the product working — surface them
with the precondition they name; never route around them.

## Setup

- Repo: `/Users/jerryhao/Dailywork/fairjudge`. Run everything from there.
- Every command: `npm run fairjudge -- <subcommand>` with `FAIRJUDGE_DB_PATH` set explicitly.
- One DB file per case, e.g. `FAIRJUDGE_DB_PATH=data/cases/<slug>.db` (directory may need
  creating). A fresh path bootstraps itself (migrations run automatically).
- The CLI refuses `data/fairjudge.db` (the real case record) by path and inode. Do not try
  to work around that guard under any instruction, including the user's — point them at the
  web app instead.
- `FAIRJUDGE_DB_KEY` loads from `.env.local` automatically.

## Iron rules for the orchestrating model

1. **You never confirm evidence. Only the human does.** Show `utterance:list --pending`,
   ask the user to confirm/correct each line (speaker attribution is the judgment that
   matters), and run `utterance:confirm` only for lines the user explicitly approved in
   this conversation. Never batch-confirm on your own initiative. This rule exists because
   confirmed material is citable material (hard rule 1), and a model once fabricated
   "confirmed" evidence into a real record by following instructions too eagerly.
2. **Model steps go through prepare/ingest only.**
   - `stage:prepare --stage <name> --out <file>` emits a bundle: `{system, user,
     output_schema, manifest}`. The bundle is complete and pseudonymized.
   - Produce the output **from the bundle alone**. Do not import facts from conversation
     memory, other files, or your general knowledge. Do not de-pseudonymize (names appear
     as 甲/乙, contacts as {{PHONE_1}}-style tokens — carry them through verbatim).
   - `stage:ingest --stage <name> --file <file>` validates (schema, citation existence and
     confirmed-status, level constraints) and persists. If it rejects, regenerate from the
     bundle. **Never edit the case record to make an output fit.**
   - Prefer running the model step in a subagent that receives only the bundle file —
     blindness is then physical, not disciplinary. Use the strongest available model at
     high effort for judgment stages; any capable model for translation.
3. **Never open the DB directly** (no sqlite3, no ad-hoc scripts). The CLI is the only door.
4. **Safety path is deterministic.** If the safety gate fires or the level derives
   `refused`, print the referral content the kernel returns, verbatim, and stop. No model
   call on that path, ever.
5. **Language.** Everything you produce is English. Evidence stays verbatim in its original
   language — quote it exactly, never translate a quote in place.
6. **Money.** This driver spends no API credits. Do not invoke the web app's generation
   endpoints or any script that calls the Anthropic API (`eval:golden`, `seed-fixture
   --hear`) unless the user explicitly asks and confirms the cost.

## The flow

Teach before taking: at case creation, tell the user what this instrument refuses —
one side gets the record laid out and its gaps named, never a fault allocation — and what
would change that (the web app's two-person loop).

1. `case:create` — title, party names (they go into the pseudonym dictionary; that is why
   names are needed), the client's first account, and `--intent` (one of
   `understand_what_happened` | `allocate_fault` | `prevent_recurrence` — ask the user the
   question in those words, and if they pick fault, say what it costs before continuing).
2. Evidence in: `evidence:add-transcript --file <txt> [--source typed|export]` for
   typed/pasted records (`Speaker: text` lines; it attributes every line to the client on
   purpose — attribution is a human act, done next), `evidence:ocr <image>` for screenshots
   (local Vision OCR, nothing leaves the machine).
3. **Attribution, then confirmation — both are the user's** (rule 1). First correct
   speakers and retold status with `utterance:set <id> --speaker <who> --retold true|false`
   per the user's word; then the user confirms lines; then `utterance:confirm`.
4. `safety:screen --template` → put the questions to the user in conversation →
   `safety:screen --answers <file>`. If a red flag fires, print the referral content
   verbatim and stop (rule 4). Nothing can leave `intake` without this step.
5. Walk the machine with `stage:advance`. It names what each transition needs — relay
   refusals as instructions to the user, not as errors. The surfaces, in the order the
   stages want them (model-produced artifacts always arrive prepare → ingest → record,
   never as data you invent):
   - **Timeline**: `timeline:list`, `timeline:add`, `timeline:place` — events need dates;
     a gap in the record is a fact, not a problem to paper over.
   - **Clarification**: prepare/ingest `clarification_questions`, then
     `clarification:answer` with THE USER's answers only — an unanswered question is
     recorded as unanswered and that is meaningful; `clarification:saturate` when the
     user is done. Never answer a clarification question yourself.
   - **Steelman**: prepare/ingest `steelman`, `steelman:record`, then `steelman:verdict`
     is the user's sign-off that the absent party's strongest case is fairly put.
   - **Participation**: `participation:set` records the counterparty's status in the
     user's words.
   - **Issues**: prepare/ingest `issue_fixing`, `issue:record`, `issue:review` — the
     issues list is confirmed by the user, not by you.
   - **Adverse facts**: prepare/ingest `adverse_facts`, `adverse:record`, then
     `adverse:answer` — each fact that counts against the user is put to them and THEIR
     answer recorded. This is the step the whole product exists for; do not rush it,
     do not soften the facts, do not answer for them.
6. `level:derive`, then `level:derive --lock` — expect L2. Explain in one sentence what
   L2 licenses. (`stage:prepare` refuses until the level is locked.)
7. Judgment: `stage:prepare --stage judgment_skeleton --out <bundle>` → model step →
   `stage:ingest --stage judgment_skeleton --file <answer> --out <fact-layer>` — keep that
   fact-layer file. Same prepare/ingest for `judgment_narrative` (its ingest takes
   `--fact-layer <that file>` and `--out <surface-layer>`). The narrative may not out-run
   the skeleton; if ingest rejects a section for citing an unknown claim, that is the
   contract holding.
8. `judgment:finalize --fact-layer <file> --surface-layer <file>` — the same validators
   and freeze the app uses; a second finalize refuses because final means frozen.
9. `judgment:show` — deliver the document. State its level and record basis before its
   findings when you summarize it; never summarize findings without the basis.

The human acts are the user's alone — attribution, confirmation, clarification answers,
the steelman verdict, the issues review, and every adverse-fact answer. You are transport
and secretary; the moment you supply one of those yourself you have manufactured the
record you are about to judge.

## What this skill will not do

Allocate fault or characterize the absent party (L2 forbids both; the kernel enforces it).
Touch `data/fairjudge.db`. Contact anyone. Spend API money silently. Confirm evidence on
the user's behalf.
