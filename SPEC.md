# SPEC — Current milestone: M5 two-person case

Status: **in progress — one item outstanding** (started 2026-08-10; verification run 2026-08-12).

Everything M5 scoped is built and green except the last half of ⑥: on the real case
`deriveOutputLevel` now returns **L1** and the case is locked there, the counterparty's appeal is
filed and standing — and the version-2 document it would produce has not been generated, because
the Anthropic account ran out of credit mid-run. Nothing is wrong with the path; it has not been
walked to the end. See the last four decision-record entries and `blockers` below.

M5 makes the counterparty a participant instead of a subject. It also has to make good on two
promises M4's document already printed: a working `/respond`, and a re-hearing she can open
herself.

**Scope boundary, deliberate.** M5 builds the capability. It does not invite anyone. Sending a
real invitation to a real person is the operator's decision and a real-world act; no agent
performs it, and the counterparty in every test is a local fixture persona.

**Deployment is deferred to M5b, and not for scheduling reasons.** SQLCipher gives whole-database
encryption at rest on one laptop. A VPS Postgres does not have an equivalent — the encryption
model changes, and doc 02's "migrate to Postgres" line never priced that. Decide the at-rest story
(pgcrypto on the sensitive columns / full-disk plus a restricted host / staying on SQLite behind a
tunnel) before the data leaves this machine, not after.

## M5 scope

1. **Identity, invite tokens, visibility model** (the foundation):
   - `case_participants` gains a real identity path: a single-use, hashed, expiring invite token
     that upgrades into an account, per doc 02 §1.3.
   - Every piece of material carries an owner and a visibility state. **Default private.** The
     judgment assembler may read only what the case has consent for — enforced in the query
     layer, so a prompt can never widen it.
2. **`/respond` — the counterparty's entry** (fixes M4's 404):
   - Her first screen is **not** the judgment. Per doc 01 it is: what this is, what data about her
     already exists, and **the steelman of her own position that the system already wrote** —
     shown before anything else, because it is the one artifact proving the system tried to argue
     her side before she arrived.
   - From there: add her account, decline, or open the transparency view. Declining is a
     first-class recorded outcome that changes the participation state, not a dead end.
3. **Consent as events, not a state bit**: granted/revoked with actor and timestamp, append-only,
   audited. Revocation is real — it immediately blocks export and share tokens for any rendition
   naming her, and is visible on the case.
4. **Transparency view + deletion rights** for the counterparty:
   - Everything the system holds that concerns her, with provenance (who submitted it, when).
   - Unilateral deletion of material **she** submitted.
   - For material about her that the client submitted: a recorded deletion **request**, surfaced
     to the client — the system does not promise unilateral erasure of another person's records
     and must not pretend to.
   - Revoking consent invalidates the shareable rendition for export. That much she controls
     outright.
5. **Counterparty-initiated appeal** (makes M4's last line true): she can open a re-hearing on a
   judgment that names her. `fileAppeal` gains an actor, and the one-appeal-per-version rule
   becomes per-actor, so her appeal is not consumed by his.
6. **The L1 upgrade path** — the payoff for the whole level machinery: once both parties have
   confirmed material, `deriveOutputLevel` returns L1, and a re-hearing produces `version + 1` at
   L1 with a two-way responsibility finding, carried by the existing frozen chain.

## Explicitly not in M5

Sending any real invitation; VPS deployment and the Postgres migration (M5b, gated on the at-rest
encryption decision above); email or push delivery of anything.

## What is left before M5 closes

1. **Hear the standing appeal** (`5b454652-4d2f-427b-ac2c-85d6754c3918`, filed by 甲 against
   judgment `93ebbead`) on a funded account. Everything it needs is in place: the case is locked at
   L1, her material is confirmed and inside the case record, and the streaming path removes the
   token ceiling that truncated the first two attempts. One call.
2. **Read the v2 it produces** against the two questions this milestone exists to answer: does the
   responsibility finding address both parties, and does it do so without a percentage and without
   characterizing either of them. `findNumericResponsibilitySplits` and the golden harness check
   the first half of that mechanically; the second half is a human reading.
3. **Decide the shape of a withdrawal** (see the last decision-record entry): whether the product
   ever records a recipient-scoped `named_rendition` revocation, given that it half-closes the door.

## M5 acceptance checklist

- [x] `npm run typecheck && npm test && npm run build && npm run eval:golden` all green —
      839 tests, 45 files; 14/14 golden cases; `next build` clean. Three merge breakages were
      found and fixed on the way, all of them the ownership tightening landing after the fixtures
      that predated it (see the decision record).
- [x] `/respond` with a valid token renders the invitation, the data-about-her summary and the
      steelman — and does **not** render the judgment (test) — `tests/respond-entry.test.ts`,
      23 cases. Walked on the real case at `localhost:3010`: the steelman renders in full above the
      exits; the judgment is named, dated and linked at the foot of the page and its text appears
      nowhere in the HTML (four distinct phrases from the frozen v1 surface layer, all absent)
- [x] Invite token is single-use, hashed at rest, expiring; a replayed or expired token is refused
      — `tests/invite-tokens.test.ts`; and on the real case: the row holds only
      `invite_token_hash`, a 14-day `invite_token_expires_at`, and a replay of the redeemed token
      returned `already_redeemed`
- [x] Visibility: material submitted by one party is invisible to the other in the query layer
      until an explicit consent event grants it (the test attacks the query, not the UI) —
      `tests/visibility-model.test.ts`, 16 cases against ten exported read functions
- [x] Consent revocation blocks export and share tokens for any rendition naming her (test) —
      `tests/consent-events.test.ts`, 15 cases. One rule (`assertNamedRenditionAllowed`) behind
      three doors: the export gate, `mintShareToken`, and opening an already-minted link.
- [x] Transparency view lists every item concerning her with provenance; she can delete what she
      submitted; a deletion request against the client's material is recorded and surfaced —
      `tests/transparency-and-deletion.test.ts`, 27 cases. Completeness is enforced rather than
      intended: `TRANSPARENCY_TABLE_COVERAGE` names all 27 tables and is asserted against
      `sqlite_master` in both directions, and the fixture puts a row in every table declared
      covered and demands each one back. `/respond/[token]/data` renders it (the href the entry
      screen already pointed at), with delete / ask / withdraw-consent as three separate acts.
- [x] She can file an appeal on a judgment naming her, and his prior appeal on the same version
      does not consume hers (test) — `tests/judgment-appeal.test.ts`, 6 cases: hers files beside
      his, hers is still one-per-version, a non-party is refused, the unique index refuses a second
      row that goes around the service layer, and the re-hearing labels the grounds as hers
- [x] **The L1 upgrade runs on the real case with a fixture counterparty** — done 2026-08-14 in a
      sandbox copy (`FAIRJUDGE_DB_PATH` at a temp path; `data/fairjudge.db` sha256 identical before
      and after). `deriveOutputLevel` → `L1 / bilateral`; the re-hearing produced v2
      (`0e0a9fa2`, `claude-fable-5 @ max`, supersedes v1) carrying a two-way responsibility
      finding — `乙: shared` on 7 claims, `甲: shared` on 4, hinged on N8, the mutual-stalemate
      inference L2 structurally could not state. 24 claims vs v1's 15; one v1 unknown (U3, "were
      the drafted lines ever sent?") closed by confirmed testimony. No numeric split, no character
      or motive characterization, all 9 citations audit clean. $2.5725, 558.6s.
      Required one product change: `appeal_rehearing.maxTokens` 32,768 → 64,000 — the hearing
      consumed 32,142 output tokens, 98.1% of the old ceiling, which is why the three earlier
      attempts truncated. The streaming path was already committed and had simply never been
      exercised; it worked first try.
- [x] Evidence integrity holds and no frozen judgment row is mutated — the 7 seeded utterances,
      the 14 original evidence rows and the 11 events are byte-identical to a pre-run snapshot,
      hashed per row; four Chinese quotes spot-checked verbatim; frozen v1 hashes to
      `82518c18cfe6a0f9…` before and after, and still stands at L2 with no successor while the case
      column has moved to L1
- [x] clean commit

## M5 decision record

- 2026-08-14 (**egress audit hole, found by the funded GPT run, fixed**): a polish request that hit
  the timeout left the machine — 12,087 bytes to OpenAI — and wrote **no `llm_calls` and no
  `egress_ledger` row**, because `writeAudit` ran only after `transport()` returned. The egress
  ledger exists to answer "what did we send out"; on the abort path it was blind. Fixed by hashing
  the payload before the send and writing the pair from the catch, with tokens and cost `null`
  (unknown, not zero) and `stop_reason` distinguishing `no_response:aborted` from
  `no_response:transport_error`. A config error thrown before `fetch` still records nothing — the
  ledger may under-claim a connection it cannot confirm, but must never invent a send.
- 2026-08-14 (**the same hole exists in `src/server/llm/claude.ts` and matters more**): `runStage`'s
  catch returns before `recordCall`, so an Anthropic call that times out or drops also writes no
  rows — and that path carries full case material rather than placeholder-locked text. It
  contradicts hard rule #7 directly. Fixed separately.
- 2026-08-14 (OpenAI spend now visible): the six `POLISH_MODEL_PREFERENCE` models are priced from
  OpenAI's published list and `writeAudit` computes cost like the Anthropic path, so polish is no
  longer the only spend the ledger cannot see. Two OpenAI-specific accounting facts are handled:
  `completion_tokens` already includes reasoning tokens, and `prompt_tokens` already includes
  `cached_tokens` (subtracted out, or a cache hit bills twice). Dated snapshots deliberately do
  **not** inherit alias prices — OpenAI has kept a snapshot on an old higher price after the alias
  moved down, so unlisted ids price to `null` rather than to a plausible guess.
- 2026-08-14 (`temperature` waste removed): gpt-5-family ids reject `temperature: 0.2` with a 400,
  and the strip-and-retry was firing on every call, costing 325ms–1.06s of an already 92%-consumed
  budget. `temperature` is now omitted by model id; the retry is kept as a safety net for
  unclassified ids and caches the rejection per process instead of per judgment.

- 2026-08-14 (**open defect found by the first L1 hearing — the audience rule inverts at L1**):
  at L2, `audience: self_only` correctly keeps criticism of the client out of a document going to
  someone who was never asked. At L1 the same rule produces the opposite of fairness. In the real
  L1 run the section "Responsibility: 乙's share" was marked `self_only` and the section
  "Responsibility: 甲's share" was marked `both` — so the counterparty, who filed the appeal and
  won a two-way finding, receives the half that is against her and not the half that is against
  him. Worse, the limits section she *does* receive asserts a finding she cannot see: "This
  judgment allocates responsibility as shared between the parties." The model marked the sections
  exactly as the schema's own description instructs; the rule is what is wrong, not the output.
  **Recommended answer** (not yet implemented): at L1 the concept of a "shareable version" no
  longer applies — both parties are participants, so both responsibility findings belong to both
  readers, and only genuinely private material (a party's own self-reflection prompts) stays
  per-party. `audience` therefore has to become level-aware rather than a fixed section property.
- 2026-08-14 (**L1 was bought by ownership, not by voice**): the derivation promotes on
  `hasClientConfirmed && hasCounterpartyConfirmed`, but in the real run `citableUtterances.byClient`
  was still **0** — all nine citable lines were the counterparty's, and the client's five remain
  `pending` and `is_retold`. Both the derivation and the judgment state this repeatedly and
  correctly, but the level still promoted to "full judgment". Whether owning confirmed material
  should be sufficient, or whether L1 should additionally require the client to have spoken a
  citable word, is undecided.
- 2026-08-14 (**both parties received the identical `shared` label**): `乙: shared` rests on 7
  claims including 5 acknowledged adverse facts; `甲: shared` rests on 4, all self-volunteered
  admissions. The `claim_ids` preserve that asymmetry; the allocation label erases it, at the field
  a reader looks at first. One run cannot distinguish honest calibration from symmetry-seeking —
  this is what the golden-cases harness should be extended to measure.
- 2026-08-14 (**an appeal that quadrupled the record re-tiered nothing**): the citable record went
  from 2 utterances to 9 and `claimsRetiered` came back empty — ten claims changed only by having
  the new quote appended. Suggests the re-hearing adds rather than revisits; worth a prompt change
  before trusting appeals to correct a first hearing.
- 2026-08-14 (token budgets, evidence-backed): `appeal_rehearing` 32,768 → 64,000 (the hearing used
  32,142 output tokens = 98.1%); `judgment_narrative` 16,384 → 32,000 (the L1 narrative used 13,773
  = 84%, against 6,086 for L2). Truncating the narrative is the most expensive failure in the
  pipeline because `hearAppeal` re-runs the ~$1.80 skeleton before reaching it again.
- 2026-08-14 (OpenAI polish, item ⑩ stays open — reason amended): the key is no longer wrong. The
  `sk-proj-…` key authenticates and `GET /v1/models` returns 200 with 118 models, but
  `POST /chat/completions` returns **429 `credit_balance_exhausted`** on every model — the
  organization has no credits. Everything on both sides of the vendor call now has real-run
  evidence: hard rule #8 verified on a real 9,355-byte payload (41 locked values, no fact leaked),
  the circuit breaker opened against three real 429s and skipped the fourth call in 3 ms with no
  network, and the degradation path shipped Fable's prose unchanged. Only the middle is unbought.
  A clearly-labelled non-OpenAI stand-in polisher was `applied` but changed 25 characters across
  7 sections — suggestive that the layer earns little, but **not decisive**, because a Claude
  stand-in editing Claude prose is the case most likely to be a no-op. The premise being tested is
  cross-vendor tone; that test still needs a funded GPT call.

- 2026-08-10: M5 builds the capability but sends nothing. Inviting a real person is the client's
  act, not the system's and not an agent's.
- 2026-08-10: deployment split out to M5b because the at-rest encryption model changes when the
  database leaves this laptop, and that is a decision to make before the move, not after.
- 2026-08-10: the counterparty's first screen shows the steelman of her own position. She arrives
  as the person being talked about; the first thing she should see is the strongest version of her
  own case that the system already produced without her.
- 2026-08-10: deletion is asymmetric on purpose — unilateral for what she submitted, a recorded
  request for what he submitted, plus outright control over whether anything naming her can be
  exported. Promising unilateral erasure of another person's records would be a promise the system
  cannot keep.
- 2026-08-12: `responded` in `readParticipationEvidence` was the bug behind the red invite test,
  not redemption. It was hard-coded false with an honest M3 comment ("no channel exists yet"); M5 ①
  built the channel and the comment outlived it. It now reads the identity row through
  `hasIdentity`. **Declining is deliberately still not `responded`**, because
  `deriveCounterpartyParticipation` maps `responded` onto `participating` and a decline is the
  opposite claim — the `/respond` wave writes her decline as her own act, and must close the seam
  where `applyParticipationReset` would otherwise walk a recorded decline back to `pending`.
- 2026-08-12: the same hard-coded-false pattern is still live one layer up:
  `collectOutputLevelInputs` sets `hasCounterpartyConfirmed: false` unconditionally. Until that
  line reads the record, `deriveOutputLevel` cannot return L1 and M5 ⑥ cannot pass. It is left
  alone on purpose — the honest reading of "she confirmed something of her own" needs an owner
  stamped on the write path, which needs `/respond`. **(Closed later the same day: `/respond`
  stamps the owner, and the M5 ⑥ entry at the end of this record is what that line reads now.)**
- 2026-08-12: visibility is enforced in the query layer and now proven so by mutation — with
  `visibleMaterial` forced to match every row, 11 of the 16 attack cases fail; with `isVisible`
  forced true, 4 more do. `loadTimeline` was the one exported read over a material table with no
  audience parameter and was given one (defaulting to `CASE_RECORD`, so no caller changed).
  `/api/blob/[sha]` remains outside the model by construction: it serves content-addressed bytes
  off disk with no case, no owner and no audience, so the sha is the capability. That is safe only
  while no page renders a blob URL to a party who may not read its evidence row, which `/respond`
  will need to decide about.
- 2026-08-12: revocation bites at three doors and one of them is new. Export and `mintShareToken`
  were the two the spec named; **opening an already-minted share link** is the third, and it is
  included because a live link is the only already-shared copy this machine still controls. The
  link is suspended rather than burnt — the hash stays on the row, so a later grant makes the same
  link work again, since the log is the state and there is nothing else to restore.
- 2026-08-12: **an exported file cannot be recalled, and the code says so rather than implying
  otherwise.** Every reading of a revocation carries the export-audit rows for copies that already
  left, each stamped `recallable: false` (a literal, so no caller can branch on a `true` that will
  never arrive), and the refusal text ends "Revoking stops the next copy, not the last one." This
  is the one place the product could have quietly let somebody believe withdrawal reaches a
  document already in another person's hands.
- 2026-08-12: the consent fold's tie-break was wrong and only a two-call test could show it.
  Ordering was `occurred_at`, `created_at`, then **id** — and ids are random UUIDs, so a revocation
  and the re-grant answering it, written in the same millisecond, sorted by luck and the fold could
  return the withdrawal as the last word after she had taken it back. It now ends on SQLite's
  `rowid`: insertion order, which is what "the latest event wins" has always meant on an
  append-only table.
- 2026-08-12: **submitting grants `case_record` and leaves her rows `private`.** The obvious call
  was `shareMaterialIntoCase`, and it is the wrong one: it flips rows to `visibility = 'case'`,
  which means "every party to this case may read this" — a grant she has not made by writing her
  side down. Her material reaches the record through the consent event alone, which is exactly
  what `resolveMaterialGrant` reads for the `CASE_RECORD` audience, while the client as a
  participant audience still needs `counterparty_read` naming him. Consenting to be judged fairly
  is not consenting to hand the other party your files. **Residual, stated rather than hidden:**
  the client's own screens still read with the default `CASE_RECORD` audience, so what holds today
  is a rule about permission, not about what his laptop can render — which is why the copy on
  `/respond/[token]/submit` says he is given no permission to read it and does not promise he
  cannot.
- 2026-08-12: **her own act supersedes a report about her.** `participation_state` is the client's
  answer to "what happened when she was asked"; when she answers herself it is overwritten —
  submitting writes `written_response`, declining writes `refused`. The one exception is a row
  already reading `participating`, the stronger claim of the same kind. A record that keeps saying
  "unreachable" about a person whose statement it is currently holding is not a record, it is a
  leftover.
- 2026-08-12: the decline seam is closed **in the derivation, not in the repair tool**.
  `ParticipationEvidence` gained a third fact, `declined`, read straight off `respond_state` (which
  only her own acts write), and `deriveCounterpartyParticipation` maps it to `refused`. So
  `npm run purge:operator` now leaves a refusal she recorded herself exactly where she put it,
  while still un-doing what it was written for: an answer about her that nobody with standing
  entered. Closing it inside `applyParticipationReset` instead would have put a second copy of the
  derivation rules in the tool that exists to apply them.
- 2026-08-12: her typed statement lands as `human_final` with `ai_draft` NULL and
  `confirm_status = 'pending'`. No machine wrote it, so there is no draft to attribute to one —
  but standing behind it is still a second act, and HARD RULE #1 turns on that act for her exactly
  as it does for him. One line per line she typed, so the confirmation unit is the same
  `ConfirmCard` the client's OCR lines go through; her confirm/rewrite/withdraw calls are the
  workbench's own functions with an ownership check in front of them, not a second path to the
  same status.
- 2026-08-12 (M5 ⑤): **an appeal has an actor, and standing is being a party — not being named in
  the text.** `fileAppeal` takes a `case_participants` id, refuses anybody outside the case
  (`actor_not_on_case`), and the scarcity rule is per actor, enforced by
  `appeals_original_judgment_actor_uq` underneath the readable refusal. Scanning the document for
  her pseudonym was the other candidate and is worse: the judgment that never mentions her by name
  is exactly the one she has most reason to appeal. The grounds block in the re-hearing prompt now
  says whose words it is holding, by pseudonym — a heading that reads "the client's own words"
  over her paragraph would misattribute the one part of that prompt that is somebody's position
  rather than the record. `readAppealForJudgment` survives as "was this version appealed at all";
  the guard is `readAppealByActor`, and `listAppealsForJudgment` breaks its timestamp tie on the
  id, because two filings inside one millisecond is a real ordering and a random text primary key
  is not one.
- 2026-08-12 (M5 ⑥): **L1 is bought with OWNERSHIP of confirmed material by both parties, never
  with the participation column.** `collectOutputLevelInputs` no longer hard-codes the answer; it
  reads which parties own confirmed, citable material that the `CASE_RECORD` grant can see — the
  same two filters everything else on the citing path reads through, so her material counts from
  the moment she grants `case_record` and stops counting the moment she revokes it. The pure
  function gained the mirror fact (`hasClientConfirmed`) and a fifth rung: engaged but one-sided
  material is `L2` under its own reason, `one_sided_material`, instead of being waved through as
  `bilateral`.
  **This is a deliberate tightening, and it changed two existing tests.** Until now `participating`
  or `written_response` alone derived L1, and both are the CLIENT'S REPORT about the other person.
  Deriving a two-way responsibility finding from "he says she is taking part" is the failure M5
  exists to fix, and on the seeded real case it would have been worse than a report: every
  confirmed line there is hers, spoken, screenshotted, submitted and signed off by him, so a rule
  keyed on who SPOKE would promote the most one-sided case in the corpus to a full judgment.
  Ownership is the one fact one party cannot manufacture about the other.
  The two halves read the owner column asymmetrically, on purpose: a row with no owner counts for
  the client (that is what migration 0011's backfill says pre-M5 material is) and never for her,
  because her only path stamps her id. So a forgotten `owner` on some future write path can cost
  the client a level he could have had, and can never hand her participation she did not do.
- 2026-08-12 (M5 ⑥): **what L1 lets a judgment say is a table entry, and the standing bans moved
  into code.** The L2 refusal of a responsibility finding was already keyed on
  `allowsResponsibilitySplit` rather than on the level's name, and the test now proves it by
  running one fact layer through both levels. What was only prompt prose is the numeric split:
  `checkLevelConstraints` now scans the fact layer's own statements for a percentage, ratio or
  `七成责任`, at every level including L1, importing `rendition.ts`'s patterns rather than restating
  them — a skeleton that passes generation and produces an unshareable document would be two rules
  where there is one. Verbatim quotes are stripped first, so a party who put a number on it herself
  still said it. One local narrowing: a ratio-shaped match (`70/30`) counts only inside a sentence
  that is about responsibility, because `23:30` is the same shape and the cost of a false positive
  differs between the two callers — at the share door it blocks a copy and somebody reads why, here
  it kills a hearing twice and hands the user an error. The character-and-motive ban is now on L1's `forbids` as well as L2's (hearing
  both sides tells you what each did, not who either is) and stays a prompt constraint plus the
  golden harness's epithet scan, because that distinction is not lexical and a check that gets
  believed has to be one that is right. `renderLevelTask` assembles the level's operative
  instruction in code from the same table the validator reads, so "L1 may allocate" cannot be true
  in the check and absent from the ask — the first hearing and the re-hearing both carry it.
- 2026-08-12 (M5 ④): **the failure mode of a transparency view is a silent omission, so coverage is
  a test, not an intention.** `TRANSPARENCY_TABLE_COVERAGE` names every one of the 27 tables and
  says either which section shows its rows or, in one line, why it holds nothing about a person;
  the test asserts that list against `sqlite_master` in both directions, so a table added later
  fails a test instead of quietly going missing, and a stale entry fails too. The fixture then puts
  a row in every table declared covered and demands each one back — the list alone would only prove
  somebody wrote the list.
- 2026-08-12 (M5 ④): **subject access is a wider lens than the read audience, and the widening is
  exactly one clause.** A line the record ATTRIBUTES TO HER is shown to her even where the client
  submitted it and kept it private: it is her own sentence, quoted about her, and a page that hid
  what the record claims she said would be useless for the one thing it exists for. Everything else
  holds the visibility model as written — her own material, anything at `visibility = 'case'`, and
  the derived artifacts the system authored about her (issues, adverse facts, claims, steelman,
  renditions, aftermath, egress). His private material that does not name her is neither shown nor
  counted, and the page says so. That is the same sentence as the deletion rule in the other
  direction: this system does not hand one person's private records to another unilaterally, and
  does not erase them unilaterally either.
- 2026-08-12 (M5 ④): **`safety_screens` is covered and deliberately withheld**, and that is written
  on the page rather than handled by omission. A safety questionnaire is the one record whose
  disclosure to the other party can put somebody in danger, whichever party is asking. Its
  existence is disclosed in `limits`; its answers are shown to nobody but their author.
- 2026-08-12 (M5 ④): **an audit that quotes the deleted line is not an audit of a deletion, it is a
  second copy.** The obvious design writes the material into `target_summary` so the log stays
  legible; that design moves the sentence from one table to another and calls the move a deletion.
  Every summary now IDENTIFIES AND NEVER REPRODUCES — kind, owner, size, grade, id, character count
  — on the request as well as on the audit, because a request that is later granted would otherwise
  be the copy that outlives the material. The person answering a request does not need the quote:
  he owns the row, it is still there while he decides, and it is named by id. Migration 0011's
  comment on `deletion_requests.target_summary` ("quoted verbatim") was corrected to match.
- 2026-08-12 (M5 ④): **the deletion audit is its own table (`deletion_audit`, migration 0012),
  append-only by trigger.** `deletion_requests` is the asking and its status moves while an answer
  is pending; the audit is the record of acts, written in the same transaction as the act, so a
  deletion that happened cannot be a deletion that went unlogged. Four acts —
  `deleted` / `requested` / `granted` / `refused` — because "she deleted it" and "she asked and was
  refused" are different facts and a log that flattens them answers neither. `target_id` is
  deliberately not a foreign key: a reference that cascaded away with its target would delete the
  audit along with the thing it audits.
- 2026-08-12 (M5 ④): deleting a `files` row unlinks the stored bytes when no other row references
  that hash. `/api/blob/[sha]` serves content-addressed bytes with the sha as the capability
  (see the visibility entry above), so a row deleted while the picture is still served is not a
  deletion. The unlink happens after the commit, never before.

### The verification run, 2026-08-12 — what the fixtures had not caught

- **The ownership tightening landed after three fixtures that predated it, and every one of them
  was wrong in the same direction.** M5 ⑥ moved L1 from "the client reports her as participating"
  to "each party owns confirmed material", and three places still bought L1 the old way: the
  `bilateral_L1` golden case (`counterpartyState: "participating"` and nothing of hers), the
  appeal test's `seedCase("L1")` (which wrote `L1` straight onto the column), and — in a different
  way — `hearAppeal`, which read a level locked before she arrived. All three now buy L1 the way
  the product does: `submitStatement` + `confirmOwnLine` through the real path, so a fixture cannot
  assert a state the code cannot produce. The tightening's own tests passed throughout; what caught
  this was running the harness end to end, which is the argument for doing it.
- **A re-hearing may move the locked level, and nothing else may** (`relockOutputLevel`).
  `lockOutputLevel` refuses to rewrite a lock, and that refusal is right for every other caller:
  the judgment was written inside the frame. A re-hearing is the one act that does not edit
  anything — it issues `version + 1` (HARD RULE #6), and the level a judgment was issued at lives
  on the judgment's own row. So v1 keeps `L2` and stays byte-identical while the case column moves
  to `L1`, which is the frame the NEXT judgment is written inside. Without this the L1 upgrade was
  derivable and unreachable: `deriveOutputLevel` returned L1 and every re-hearing would still have
  assembled at the level locked before she existed. The move is disclosed — `VersionComparison`
  gained `levelChanged`, and its sentence is written before the `identical` short-circuit, because
  two versions whose prose matched word for word would still be different documents if one of them
  was allowed to allocate responsibility. **It relocks DOWN as well as up** (test): a ratchet on
  this column would let a re-hearing allocate responsibility on a record that lost its second side.
- **Her statement's grade is signed off at write time, to the rule's own answer.** It was NULL, on
  the honest reasoning that a party should not grade her own material — and that had exactly one
  consequence, which was not caution: `grade_final` is what the citation audit reads, so nothing
  she submitted could ever be rested on. L1 would have been reachable on her material and uncitable
  from it. This is the one artifact whose provenance the system observed directly — a statement
  typed into this form at this timestamp — so there is no registration claim to review and no
  second grade the rule can produce (`recollection` → B is total). The risk the instinct was about
  is a party awarding herself an A; that is closed by taking the grade from `deriveEvidenceGrade`
  rather than from her.
- **The entry screen became unreachable at the moment she joined, and nothing caught it** because
  every test held an unredeemed invite. The invitation is single-use, so a party who has an account
  holds a spent link plus an identity token; `/submit` and `/data` resolve either (they go through
  `resolveRespondingParty`), while `buildCounterpartyEntry` resolved only the invite. The page even
  carried copy for the case — "You have already set up your side of this" — that nothing could
  render. It now resolves both, with `touch: false`, because rendering a screen is not an act.
- **`deletion_audit` did not exist on the real database.** Migration 0012 had never been applied to
  `data/fairjudge.db`, so `/respond/[token]/data` — the transparency view, one of M5's four
  deliverables — was a 500 on the only case there is. Tests migrate a fresh database every run and
  cannot see this; the page was fine and the machine it runs on was not. Applied, and the view
  renders: 100 items, her four lines deletable, his two lines about her carrying "ask" instead, and
  the three consent controls showing where each one stands.
- **The judgment budget was sized to the transport, and the transport pushed back twice.** An L1
  fact layer is structurally bigger than an L2 one — it carries the responsibility list L2 forbids,
  and claims from both parties' material — and on the real case at effort `max` it did not fit
  16384: `stop_reason: "max_tokens"`, a truncated JSON body, the whole hearing failed. Raising it
  hit `MAX_NONSTREAMING_TOKENS`: the SDK estimates a request's duration as
  `60min × max_tokens / 128000` and refuses any NON-streaming call over ten minutes, unconditionally
  — no per-request or client-level `timeout` opts out, which cost one attempt to establish. 21333
  truncated as well. So `llm/claude.ts` gained a streaming path, and it is chosen **by the stage's
  own budget**: at or under the ceiling nothing changed, above it the call streams and
  `finalMessage()` returns the same object `create` did — same `content`, same `usage.iterations`
  for sticky-routing detection, same `stop_reason` checked before content is read. Nothing renders
  a token as it arrives and nothing may: every stage returns one structured document that is
  re-validated and audited before it is worth anything. Sizing the judgment to the transport was
  the alternative and it is the wrong way round.
- **The credit balance ran out before v2 existed, and that is where M5 stops.** Two truncated
  hearings cost $2.25; the third attempt returned `400 invalid_request_error: credit balance is too
  low`. The record it left is clean rather than half-written: no draft v2 on the chain, the appeal
  back at `submitted` (so it can be heard again), v1 untouched, and the case locked at L1. The
  remaining work is one `hearAppeal` call against a funded account.
- **The three guarantees were attacked on the real database, not on a fixture.** Her private
  material survived eleven exported read paths under the client's audience and a stranger's —
  `listCitableUtterances`, `buildCitableBrief`, `assembleCaseFile`, `listEvidenceUtterances`,
  `listEvidence`, `loadWorkbench`, `findEvidenceImage`, `loadTimeline`, `computeRecordAsymmetry`,
  and the whole serialized dossier — with `checkEvidenceRefs` refusing her utterance id as
  `not_in_record` even when handed it directly, and `CASE_RECORD` reading it as the control that
  proves the check measures something. A blanket revocation shut all three consent doors (export,
  mint, and an already-minted live link), and a re-grant made the same link work again. A second
  appeal by the same actor was refused by the service layer and by the unique index underneath it,
  while the other party's appeal went in beside hers.
- **One sharp edge found by attacking, and it is a real one:** a withdrawal recorded with a
  RECIPIENT (`subjectParticipantId = 甲`) blocks `exportRendition` — with or without a recipient
  named on the call — and does **not** block `mintShareToken`, which asks the blanket question
  because a share link has no named recipient. That is the documented design and it is defensible,
  but the two doors now answer differently to one act, and the act a person would describe as "stop
  sharing anything about me" must be recorded blanket or it half-works. Not changed here: the fix
  is a UI decision about which shape a withdrawal is recorded in, and inventing it inside a
  verification run would be changing the rule while testing it. Written down instead.

# M6 — Two-person product + design execution

Status: **batch 1 landed 2026-08-17 (999/999 tests, all routes 200); batch 2 gated on §D.1.**

## Batch 1 record (commits 23c854b, 6e963a5, 72070d7, 6a76443, d84967e, c987f78; migrations 0013–0014 applied to the live DB after backup)

- `createCase` + `/case/new` (intent question with the cost surfaced, advance-disclosure card,
  party registration = pseudonym-dictionary registration) + a real `/case` list. The product can
  file a second case for the first time.
- The fixture case (Adrian & Yiwen, `data/fairjudge-demo.db`): Act I heard for real — L2, citable
  14 / **0 by client** / 14 by counterparty, $1.93. Acts II–III staged in `docs/fixtures/demo-runbook.md`.
- `/respond/[token]`: share tokens became a third arrival credential (the dead link's root cause);
  arrival contract per §A.5; decline mechanics per §A.4 (standing revocable door, minting closure);
  **`markInviteOpened` deleted** — no-open-tracking is enforced by absence, and the wait view's
  read model carries no `respond_state`.
- A's wait surface with the refusals rendered as content; the invite-minting control (the loop's
  first production caller of `issueInviteToken`).
- The ammunition defect closed (`projectSection`: L1 findings reach both readers; reflection
  annexes stay private). `finalize` had been minting the counterparty's rendition **empty** —
  simultaneous release is now both-documents-or-neither in one transaction. One per-level
  provenance notice on every rendition; `assertShareable` refuses unresolvable `/respond` pointers.
- Honesty fixes: polish-archive copy branches on `outcome`; share-screen copy matches what is built.

Known debt from batch 1: `clarification_rounds` has no participant column — author-only visibility
for her answers currently rides a time predicate (open rounds created at/after her `case_record`
grant); the real fix is a `participant_id` column + unique `(case_id, participant_id, round_number)`.

## Batch 2 record (2026-08-17, after §D.1/§D.2 answered; commits a13aefe, kernel commit, 61a2446; 1064/1064)

- **Engine (05 §B):** blind advocate pair (L1 only, blindness = what gets serialized); the swap
  test wired into hearings for the first time — `runSwapTest` had NO production caller, the
  fifth zero-caller instance — and promoted to a publication gate (delta threshold 0; fail →
  one re-hear at max; fail again → allocation withheld + disagreement display; level untouched,
  hard rule 2 intact); `CASE_COST_CEILING_USD = 10` with the fixed degradation order, each cut
  disclosed in limits; disagreement rendered as contradiction, never averaged.
- **Kernel:** `llm_calls.input_manifest(+sha256)` (0015) derived from the assembled outbound
  text, not caller-declared; `prepareStage`/`ingestStage` split with the egress-ledger row
  written at emission and *claimed* by ingest via re-derived hash — an answer with no recorded
  question is refusable by construction; `scripts/fairjudge-cli.ts` (11 subcommands, live-DB
  guard by path+inode).
- **Skill driver:** `.claude/skills/fairjudge/SKILL.md` (installed to `~/.claude/skills/`) —
  the single-party L2 instrument; model-never-confirms-evidence codified as skill law.

Batch 2 debt: actual opus-Batches submission for post-judgment docs (decision + disclosure
implemented; transport needs `claude.ts`, frozen during the batch); the gated hearing writes
no `judgment_swap_tests` audit row yet (needs an extraction from `swap-test.ts`).

**Batch 2 debt closed 2026-08-18: the golden harness had gone stale on the gated hearing.**
`npm run eval:golden`'s `bilateral_L1` case errored (`the golden harness has no recording for
this stage`) from a13aefe onward — 1115/1115 vitest stayed green throughout, because the engine
was right and only the replay was behind it. The harness recorded two answers (skeleton,
narrative) and an L1 hearing now asks for five: two advocate briefs, the skeleton under both
seatings, the narrative. Fixed in the harness only, no engine change: `scripts/golden/fixtures.ts`
records a brief per seat and a fact layer per **seating** (the exchange moves the client marker,
so the counts follow it and the allocation, drawn from the lines rather than from who filed,
comes back the same either way and the gate publishes it intact), and `scripts/eval-golden.ts`
grew `checkHearing` — the pair ran at L1 and only at L1, both seatings were genuinely heard, the
gate's disposition, and the disclosure it composed reaching the published document. Asserted
directly because none of it is legible in the output: an untested judgment looks the same as a
tested one. Each new assertion was mutation-checked to confirm it fires.

### Skill driver acceptance (2026-08-18, three walkthrough rounds; 1120/1120)

Round 1 found the CLI impersonating the counterparty (a two-sided paste reached L1 via bare
`submitStatement`), zero substitution on the external channel, and two missing subcommands.
Round 2 found `detectUnregisteredNames` had been an M0 stub — half of hard rule 3 never
existed on ANY channel — and that the state machine's gates had no CLI surfaces past
`timeline`. Both fixed (commits cffd357/45a7a91): `evidence:add-transcript` never touches
participation; every stage binds `buildCaseDict`; unregistered names block; every gate got
its smallest honest surface (`timeline:*`, `clarification:*`, `steelman:*`,
`participation:*`, `issue:*`, `adverse:*`), no gate weakened. Round 3 completed the full
flow — empty DB → frozen L2 judgment → `judgment:show` — with all five checks passing and
one open cosmetic: `judgment:show` renders pseudonyms while other local surfaces
de-pseudonymize for the same reader; make that choice deliberately. Also open:
`grade_final` has no CLI confirm command, so a CLI-only case never reports a confirmed
grade profile (levels still derive from confirmed attributed utterances).

Scope: execute `docs/05-design-framework.md` — §A's two-party loop as the product's spine, and the
waves of `docs/04-ux-design-plan.md` as amended 2026-08-17 by 05 §C. M5 built the capability; M6
makes it something a person can walk through unaided, which is doc 04 §5's acceptance standard and
no milestone before this one used it.

## Batch 1 — in flight (no new spend approval needed)

Case creation · a fixture case · the `/respond` door (arrival contract §A.5, decline mechanics
§A.4) · A's wait surface (§A.2) and the three untrue screens · the L1 audience fix (§A.3).

Acceptance, copied from doc 04 §5 — every criterion is a person completing a task unaided:

- *"a person who has never seen the product creates a case from the home screen, and the app
  contains a demo case that can be opened, judged and shared without touching `data/fairjudge.db`.
  `mintShareToken` produces a link that resolves. No screen states something the same screen
  disproves."* (Wave 1)
- Wave 1 as amended: the decline path end to end — recorded as her act, the sender's minting
  closed, her link converted to a standing revocable door, the no-open-tracking sentence rendered,
  and later documents stating the decline only as a participation fact.
- *"a person can see exactly what the other party would receive and why the rest is withheld, and a
  test reader arriving cold at `/respond/<token>` can decline without confusion."* (Wave 5)
- Wave 5 as amended: *"a person whose counterparty has not answered can say what is happening, what
  is not being shown to them and why, and what would change the case's level."*

## Batch 2 — the engine (05 §B) — **gated on §D.1 ceiling approval**

Not to be started before the $10-per-case ceiling is approved and the account funded:

- **Blind advocate pair** at L1 hearings — two opposed briefs, neither agent seeing the other's
  output (≈ +$0.5 per hearing).
- **Swap test as a publication gate** — doc 02 §1.2 as amended 2026-08-17; a second exceedance
  publishes with the responsibility allocation withheld and the disagreement in its place.
- **Input manifests** — every stage declares the ids serialized into its prompt and the manifest
  hash lands on the `llm_calls` row, so "what did this agent see" is a ledger answer.
- **Disagreement display** — the spread rendered instead of averaged; contradiction reported as
  contradiction, never as a confident middle. Render layer, $0.

## M6 open items (05 §D — only the user can close these)

1. **CLOSED 2026-08-17 (user): the $10 per-case ceiling is approved.** Batch 2 unblocked.
2. **CLOSED 2026-08-17 (user): ownership is enough — L1 does NOT require a citable client
   voice.** The user overruled the framework's recommendation; `deriveOutputLevel` stands as
   built, the real case keeps L1, and the fixture's Act III design (byClient = 0 at L1) is
   valid as authored. The record-basis disclosure — which states the zero in the document's
   first section — is the honesty mechanism, not the level.
2a. **NEW 2026-08-17 (user): the skill runtime.** fairjudge grows a second driver — a Claude
   Code skill wrapping the same kernel (CLI over existing server functions; model stages split
   into prepare/ingest so a session's model can serve as transport, cost 0 API). Single-party
   L2 instrument by construction. Batch 2 includes the kernel work; SKILL.md follows it.
3. Inviting the real counterparty — a real-world act only the operator performs; §A.4's
   anti-badgering rules bind them too.
4. Where `/respond` runs when it runs for real — blocked on M5b's at-rest encryption decision.
5. Adopting ICODR publicly — strengthens the procedural-equivalence claim, commits to auditable
   process and human oversight.

# Completed milestones

## M4 post-judgment loop — accepted with two defects recorded (2026-08-10 → 2026-08-11)

All 8 acceptance items pass; the real case ran end to end on `claude-fable-5` and the frozen
judgment `93ebbead` is byte-identical before and after (`sha256(row)` =
`7fecc53f2e53d62224c0b35970212f2e44bdcb0aba6e0c5d0baff98481a4623c`, 16005 bytes, `updated_at`
still `1786410851374`). Two defects found on that run are recorded rather than hidden:

1. **Fixed here.** `src/instrumentation.ts` 500'd every route in `next dev`. It is compiled for
   the edge runtime too, and an `await import("./server/db")` written out in the entry body put
   `better-sqlite3` — and its `require("fs")` shim — into a bundle with no `fs`. `npm run build`
   did not catch it, so the four gates were all green while the application did not serve a
   page. Split into `src/instrumentation-node.ts`, reachable only from inside
   `if (process.env.NEXT_RUNTIME === "nodejs")` so webpack drops the branch.
2. **Open, handed to M5.** The counterparty copy ends "Add your side of it here: /respond" and
   `/respond` is not a route — it 404s. The route is out of M4 scope by design (invite tokens
   are M5), but the document promising it is not: this is the same class of defect as the M3
   one, in the same artifact, and it is the last line the other party reads. Either M5 ships the
   route or the rendition stops naming one.

## M4 scope

1. **Counterparty-addressed shareable rendition** (fixes the M3 defect) — **DONE 2026-08-10**.
   The shareable copy was the client-addressed narrative with `self_only` sections filtered out,
   so the document handed to 甲 said "You, 乙, submitted this case". Renditions are derived,
   never authored — so no pronoun rewriting at render time and nothing written to the frozen
   judgment. A `shareable_narrative` stage (fable, effort `high`) generates counterparty-addressed
   prose **from the same frozen `fact_layer`**, under the same contract validation (every
   `claim_id` must exist in the fact layer; no claim may be introduced). The self-reflection
   rendition is unchanged.
   Built as: `src/server/llm/stages/shareable-narrative.ts` (the stage),
   `src/server/judgment/shareable-narrative.ts` (prompt, checks, persistence, the whole act),
   `checkCounterpartyAddress` in `src/server/judgment/rendition.ts` (the gate, run on every
   render), migration `0008_shareable_narrative`, and `npm run judgment:shareable`.
2. **Improvement contract** — **DONE 2026-08-10**. 1-3 commitments that are concrete,
   observable and executable within 7 days, each tied to `claim_id`s. **L2 rule**: only the
   client's commitments are commitments — the counterparty has not been heard, so anything
   addressed to her is an invitation, and must be labelled and stored as one. No "you should
   both…" items.
   Built as: `src/server/llm/stages/improvement-contract.ts` (the stage, fable at `high`,
   four required fields per item), `src/server/judgment/improvement-contract.ts` (the binding
   rule at both doors, the vagueness checks, persistence, the whole act),
   `src/app/case/[id]/post_judgment/page.tsx` (the screen, with each item's claim provenance
   spelled out), and `npm run judgment:plan`. No migration.
3. **Repair-conversation script** — **DONE 2026-08-10**. A soft opening line, plus a "what to
   do when it goes wrong" block (a pause signal, a flooding self-check, an agreed return time).
   Generated from the fact layer, not from the narrative.
   Built as: `src/server/llm/stages/repair-script.ts` (fable at `medium`) and
   `src/server/judgment/repair-script.ts` (the sayability checks, persistence, the whole act);
   same screen and same script as ②.
4. **7 / 30-day follow-ups**: `followups` rows scheduled at freeze time; generation via the
   Message Batches API (50% cheaper, latency irrelevant); a launchd plist for the timer **plus
   catch-up on application start**, because Phase 0 is a laptop that sleeps — a follow-up that
   silently never fires is the failure mode here, so overdue follow-ups must be visible in the
   UI. Ask about behaviour, not feelings: did the committed action happen, was it noticed.
5. **Appeal channel** — **DONE 2026-08-10**. Re-hearing at fable effort `max` with the appeal
   grounds and any new confirmed material, producing `version + 1` through the existing chain,
   with the diff surfaced. One appeal per judgment version (no judgment shopping).
   Built as: `src/server/llm/stages/appeal-rehearing.ts` (the stage, fable at `max`, returning
   a fact layer) and `src/server/judgment/appeal.ts` (filing, the one-per-version rule, the
   hearing, the appeal-shaped diff), with the unique index in migration
   `0010_appeal_and_export_audit`. Filing and hearing are separate acts: a hearing that
   produced no version can be re-run, and only a version that was issued consumes the appeal.
6. **Shareable export gate** — **DONE 2026-08-10**. Real-name and variant scan against the
   pseudonym dictionary (a hit blocks), watermark, metadata-stripped export, no one-click
   social share, every export written to an audit log. **Quote-length rule, as decided here**:
   the >15-character verbatim-quote restriction applies only to quotes attributed to someone
   who is NOT the recipient. Quoting the recipient's own words back to them is the evidence
   basis, not de-anonymization, and must not be stripped.
   Built as: `src/server/judgment/export-gate.ts` (the whole gate) plus the `judgment_exports`
   audit table in migration `0010_appeal_and_export_audit`. Every check blocks and names what
   it found; nothing is silently stripped, softened or trimmed.

## Explicitly not in M4

Two-person login / invite tokens / VPS / Postgres (M5); a Chinese rendition of user-facing
output; changing anything inside a frozen judgment.

## M4 acceptance checklist

- [x] `npm run typecheck && npm test && npm run build && npm run eval:golden` all green
      (692 tests over 39 files; 14/14 golden cases, 1 advisory review on a fixture — re-run
      2026-08-11 after the instrumentation fix)
- [x] The shareable rendition addresses the counterparty throughout — no second-person
      reference to the client survives (asserted in a test over the real judgment)
      — `tests/judgment-shareable-narrative.test.ts`, over judgment `93ebbead`, and the same
      check fires on the M3 projection of that judgment, so the assertion has teeth
- [x] The shareable rendition introduces no claim absent from the frozen fact layer (contract
      validation, test)
- [x] Improvement contract: at L2 no commitment is stored against the counterparty; hers are
      stored as invitations (test) — `tests/improvement-contract.test.ts`, 25 cases, both doors
      of the rule separately: the generation boundary demotes her item to an invitation (with
      `demoted_from_commitment` recording that it was asked for as more) and the storage door
      throws on hand-built content that binds her, storing nothing. Plus the other two ways
      this feature fails: a vague item is refused field by field (`tests` cover "communicate
      more", "be more considerate", "work on my …", "try to …", a trigger with no occasion, an
      "observable" that is a state of mind) and an item citing a `claim_id` absent from the
      frozen fact layer rejects the whole contract. `tests/repair-script.test.ts` (17 cases)
      does the same for ③: the opening line, the flooding self-check, the return time, the
      citations. `tests/post-judgment-screen.test.ts` (4 cases) renders the real page component
      and asserts the surfacing half — that an invitation is labelled one on the item itself,
      and that each item shows the claim's own sentence and not just its id
- [x] A follow-up scheduled while the laptop was asleep fires via catch-up at next start and
      shows as overdue in the UI (test with a clock stub) — `tests/followups.test.ts`, 29 cases
      over an injected clock: the catch-up sweep, the exactly-once claim under two overlapping
      runs, the overdue query (including a row whose generation failed), and the batch
      submit / poll / retrieve path against a fake provider (unordered results, an errored
      request, a refusal, the retry budget)
- [x] Appeal produces v2 through the frozen chain with a visible diff; a second appeal on the
      same version is refused (test) — `tests/judgment-appeal.test.ts`, 11 cases. v2 carries
      `supersedes_judgment_id`, `effort = max` and `prompt_version = appeal_rehearing.v1`; the
      diff names the claim added, the claim removed and the one that dropped from `inferred` to
      `unknown`, alongside each version's serving model and `fallback_used`. The frozen
      predecessor is compared **byte-for-byte** across the re-hearing, raw out of SQLite. The
      refusal is asserted three ways: a second `fileAppeal`, a second `appealJudgment` (refused
      before any model call), and a version that has already been replaced (`not_current`).
      Plus the two failure paths that must not burn an appeal — a re-hearing rejected for
      restating the old record basis, and a transport failure heard again successfully — and
      the one that must: an appeal is never heard twice
- [x] Export gate: a shareable copy containing a real name or nickname variant is blocked; the
      recipient's own long quotes are NOT stripped; every export writes an audit row (tests) —
      `tests/judgment-export-gate.test.ts`, 19 cases. A hit names what it found, which
      pseudonym it should have been and where; a name split by a zero-width space is caught
      because metadata is stripped before anything is scanned; a blocked export writes **no**
      audit row, and a completed one writes exactly one carrying kind, version, rendition
      revision, recipient, channel, byte size and the sha256 of the exact bytes. Exporting a
      `self_reflection` rendition and asking for a social channel are both refused by name.
      The last case runs the gate over the **real** judgment's stored counterparty copy (read
      only — it asserts the checks, it does not export)
- [x] Run on the real case: generate the counterparty-addressed shareable rendition, the
      improvement contract and the repair script, and paste the full text in the report —
      done 2026-08-11, all three regenerated with real `claude-fable-5` calls against the dev
      server on 3009, **one attempt each, no retry**: the rendition at `high` ($0.4218, 84s,
      stored as revision 3), the contract at `high` ($0.1295, 21s) and the script at `medium`
      ($0.0793, 8s) — $0.6306 for the run. This run **exercised the demotion path on real
      data** where the 2026-08-10 run could not: 2 commitments bound to the client and 1 item
      the model wrote as binding 甲, demoted to an invitation carrying
      `demoted_from_commitment`. Frozen row byte-identical across all three generations plus
      the export (sha256 `7fecc53f…4623c`, 16005 bytes, `updated_at` unchanged); evidence 14 /
      events 11 / utterances 7 with every `created_at`/`updated_at` and every content hash
      unchanged. Full text is in the M4 report
- [x] clean commit

## M4 decision record

- 2026-08-10: the shareable-address defect is fixed by generating a second narrative from the
  frozen fact layer rather than by rewriting pronouns at render time — rewriting would either
  edit a frozen judgment or make the rendition an authored artifact, and both break the
  contract that renditions are derived.
- 2026-08-10: the quote-length restriction is scoped to quotes by someone other than the
  recipient. The original rule existed to stop re-identification when a judgment is shared
  publicly; applied to the counterparty's own words it would strip exactly the evidence she is
  entitled to see.
- 2026-08-10 (**item ① as built**): there is **no fallback to filtering**. `finalize` mints the
  shareable rendition row empty, and a judgment whose counterparty narrative has not been
  generated has no shareable copy at all — reading or minting a token for one fails with
  `shareable_narrative_missing`. A fallback would have made the defect the default behaviour of
  every judgment issued before someone remembered to run the second generation.
- 2026-08-10: the counterparty narrative lives on `judgment_renditions`, with its own
  `surface_layer`, model, effort, prompt version and `revision` (migration 0008, seven additive
  columns). That is what "renditions are derived artifacts with their own lifecycle" has to mean
  to be worth saying: regenerating one bumps the rendition's revision and writes nothing to
  `judgments` — asserted byte-for-byte in a test, and confirmed on the real run (the frozen row's
  sha256 is identical before and after).
- 2026-08-10: the address check (`checkCounterpartyAddress`) matches **client-role second
  person** — "put to you", "you acknowledged", "you submitted" — plus the pseudonym-in-apposition
  shape the real defect took ("You, 乙, …"). It deliberately does NOT match anything that could be
  true of either party: "your account", "your own words", "your side" and "you have no confirmed
  line" are all things the document says to the counterparty by design, and a check that fired on
  them would be enforcing a vocabulary and would end up switched off. It is lexical and therefore
  partial; what makes the copy counterparty-addressed is that it is *generated* that way, and the
  check is what proves the generation did what it said, re-run on every render.
- 2026-08-10: the shareable stage runs fable at effort `high`, not `xhigh`. The fact-finding is
  done and frozen; what is left is saying an established set of things to a different reader.
- 2026-08-10: the golden harness's fixture arm now labels its `renderShareable` call what it
  actually is — the **share gate** over the fixture's own narrative — because the fixtures record
  a skeleton and a client narrative and nothing records a counterparty one. The real-case arm
  checks the actual stored counterparty document, and reports (does not fail) when a judgment has
  not had one generated yet.
- 2026-08-10 (**item ④ as built**): the follow-up loop is built against silence, not against the
  happy path. Every state a check-in can be in is a **stored** state with a name
  (`generation_status`: pending / submitted / ready / failed, plus `last_error`), and "overdue" is
  **derived from the clock at read time** rather than written by a job — so there is no marker
  process that can forget to run. `needsAttention` (overdue with nothing to answer) is the state
  the whole feature is defending against and it renders on the case page, error text included.
- 2026-08-10: **two firing paths, deliberately overlapping** — a launchd plist checked into
  `scripts/launchd/` (never installed by the repo; the README has the `sed` + `launchctl bootstrap`
  steps) and a catch-up at application start (`src/instrumentation.ts`). launchd re-runs a missed
  calendar job after *wake* but not after *power-off*, and does nothing at all before the plist is
  installed; the start-up sweep covers both gaps. They are safe on top of each other because
  claiming a due row is a conditional `UPDATE` (`fired_at IS NULL AND generation_status =
  'pending'`), which is what makes firing exactly-once — asserted with two overlapping runs.
- 2026-08-10: generation goes through the **Message Batches API** on `claude-opus-4-8` at effort
  `medium` — template-shaped work with no reader waiting, so 50% off is free money. **`fallbacks`
  is not available on Batches** and the request carries neither it nor the fallback beta; nothing
  is lost, because server-side fallback exists to re-run a refusal on opus-4-8 and this stage
  already is opus-4-8. (That is also why a fable stage could not move to this path.) Results are
  keyed by `custom_id` — the follow-up row id — because they come back in any order. Usage is
  backfilled onto the `llm_calls` row written at submit, at batch prices: one call, one audit row,
  counted once, with the egress recorded when the payload actually left.
- 2026-08-10: the check-in asks about **behaviour on three axes only** — `action_taken`,
  `noticed_by_other`, `pattern_recurred` — and the ban on feelings questions is enforced in
  `checkFollowupQuestions`, not merely stated in the prompt. Every `claim_ref` a question carries
  must already exist in the frozen fact layer; a check-in is derived from a hearing that is closed,
  so a question citing a claim the hearing never made is rejected and the whole set is refused
  (never trimmed — a partial set looks finished and is not).
- 2026-08-10: the scheduler **keys off the judgment, not the improvement contract** — the
  documented seam. A contract may not exist when the judgment freezes, so the rows are written at
  freeze time regardless, `linkImprovementContract` attaches one written later, and
  `followups/commitments.ts` reads `improvement_contracts.content` through a tolerant extractor
  rather than importing the contract layer's types. An unrecognized shape degrades to "no
  commitments" and the questions rest on the claims instead — a worse check-in and a much better
  failure than none.
- 2026-08-10: one 7-day and one 30-day row **per case**, enforced by a unique index rather than by
  a caller's care, and the window is anchored to `finalized_at`. A re-hearing on appeal therefore
  lands on the same two rows: the check-in asks whether behaviour changed after the case was heard,
  and the case was heard once. Re-anchoring on every version would be a way to never be overdue.
- 2026-08-10 (**item ② as built**): the L2 binding rule runs at **two doors, doing two different
  things**. At the generation boundary `normalizeImprovementContract` **demotes**: an item bound to
  the counterparty becomes an `invitation`, carrying `demoted_from_commitment` so the demotion is in
  the data and not only in the label. At the storage door `persistImprovementContract` **refuses**:
  content holding a commitment bound to a party the level does not allow is rejected outright,
  whichever caller built it, and nothing is written. Demotion rather than deletion because "she is
  invited to X" is a true sentence where "she will do X" is not, and a silently dropped item leaves
  a contract that reads as complete with a piece missing; refusal at the write because the demotion
  is a courtesy to one path, and the invariant has to hold for all of them. Which of the two is
  "the rule" is the second one — a test builds the forbidden content by hand and asserts the throw.
- 2026-08-10: who may be bound is decided by the **locked output level** (`boundPartiesAllowed`:
  both parties at L1, the client alone everywhere else), not by participation state read at
  contract time. It lives in `judgment/improvement-contract.ts` rather than in the `levels.ts`
  table because that table answers what a level licenses the *judgment* to do and this answers what
  it licenses a *contract* to bind; both follow from the same fact — whether she was heard — and
  neither re-derives the level, which is decided once, in code, and locked (HARD RULE #2).
- 2026-08-10: **vagueness is refused structurally first and lexically second.** The schema does most
  of the work: `trigger`, `action`, `observable` and `within_days` are four separate required
  fields, and a disposition cannot be spread across them — "communicate more" has no occasion and
  nothing anyone could see. The lexical half (`VAGUE_PATTERNS`, an occasion marker on the trigger,
  an inner-state check on the observable) fires on the *grammar* of vagueness — a comparative where
  an act belongs, an intention verb standing in for the thing intended, a frequency where a moment
  belongs — and deliberately not on vocabulary anyone dislikes, because a check that fires on good
  items is a check somebody switches off. It is partial by construction and says so: it recognizes
  the empty shapes that are known, not an original way of saying nothing.
- 2026-08-10: **no migration for ②/③.** The structured contract goes in `improvement_contracts.content`
  (already a JSON column) and the structured script in `repair_scripts.ai_draft`, with
  `repair_scripts.content` holding the rendered text — the structure is the authority and the text is
  re-derived from it on read, the same relation a rendition has to its surface layer. Provenance
  (model, effort, prompt version, fallback) rides inside the JSON as `generated_by`, because neither
  table has provenance columns and a migration racing the other M4 agents' migrations buys nothing
  the JSON does not already give. Regeneration is guarded by state, not by ceremony: a contract that
  has left `draft` and a script a human has confirmed or edited are never written over, and the guard
  is on the UPDATE statement rather than on a read above it.
- 2026-08-10 (**item ③ as built**): the repair script is generated from the **fact layer**, and that
  is a signature (`runRepairScript(db, caseId, judgmentId, level, factLayer)`), not a convention —
  the same discipline `runJudgmentNarrative` uses one step earlier. The narrative is a reading of the
  claims written to persuade the person it addresses; a script derived from it would inherit that
  rhetoric and hand it to the client as their own words. A test plants a marker string in the
  narrative and asserts it never reaches the prompt.
- 2026-08-10: the script's checks are about **sayability**, not tone: first person, no "you always" /
  "you never" / "you made me", no quoting the judgment as leverage, and short enough to get out in
  one breath. Plus the two halves of the "when it goes wrong" block that are load-bearing — a
  flooding self-check must name a physical or behavioural sign, because by the time somebody is
  flooded "am I upset?" is not a question they can answer, and a return time must name a time,
  because a pause without one is a walk-out and that is what the other person will remember.
- 2026-08-10 (**item ⑤ as built**): **filing an appeal and hearing it are separate acts**, because
  only one of them is scarce. `fileAppeal` records that a version was appealed and refuses a second
  filing against it (backed by a unique index on `appeals.original_judgment_id`, so the rule is a
  property of the database and not of whichever caller remembered to check). `hearAppeal` runs the
  re-hearing and may be run again: a transport failure, a refusal or a rejected generation produced
  no version, so none of them consumed the appeal — the row returns to `submitted` and the appeal is
  still the client's to have heard. A network blip is not an answer. That includes the awkward case
  where the skeleton landed as a draft `version + 1` and the narrative call died: the chain does not
  fork, so a re-hearing **continues that draft** (new fact layer, narrative cleared) instead of
  opening a second one, and a test drives exactly that sequence.
- 2026-08-10: **no path writes `rejected` to an appeal.** This product does not refuse an appeal on
  its merits — "your grounds are not good enough to look again" is itself a judgment, made by the
  machine being complained about. The honest form of disagreeing with an appellant is to hear the
  case again and say plainly that the record still does not support what they wanted, which is what
  the re-hearing prompt asks for in as many words.
- 2026-08-10: the appeal grounds are **passed verbatim and are not evidence**, and that is structural
  rather than instructed: they carry no utterance id, `evidence_refs` are audited against SQLite
  (HARD RULE #1), so a claim grounded in the appeal cannot pass the same `checkFactLayer` the first
  hearing passed. The dossier is **reassembled** rather than reused, which is all "plus any newly
  confirmed material" needs to mean — evidence enters this product exactly one way. A test confirms
  a client line between the two hearings and asserts that a re-hearing restating the *old* record
  basis is rejected: that is also the proof the new line reached the hearing.
- 2026-08-10: the rule is one appeal **per version**, so the version an appeal produces can itself be
  appealed. That is the consequence of stating it that way and the test asserts it. What it is not is
  unlimited re-rolling: every round costs a fable hearing at `max`, produces a disclosed diff, and
  has to survive the same citation, level and record-basis checks — a chain of versions is a public
  record of having asked four times, which is a different thing from a second opinion nobody can see.
- 2026-08-10 (**item ⑥ as built**): every check in the export gate **blocks and names what it found**.
  Nothing is stripped, shortened or masked, because a gate that quietly fixes documents has invisible
  failures in the only place they matter. In particular a long quote is never trimmed to pass: a
  trimmed quote is an edited record (CLAUDE.md), and the recipient would be holding a document whose
  quotes are quietly not what was said.
- 2026-08-10: the quote rule's attribution test reads the speaker off the **speech verb**, not off who
  the sentence mentions. The first version asked "does the run-up name the recipient and nobody else",
  and the real judgment refuted it in one sentence: "The confirmed record shows you stated that 乙
  relied on AI …: (quoted in the case record)." Those are the recipient's own words
  *about* the other party, which is what most of a one-sided judgment's evidence looks like. It is
  still lexical and still biased towards refusing: a quote nobody is named as speaking falls under the
  rule, because an unattributed long quote is exactly the re-identification case the rule is for.
- 2026-08-10: the name scan is the dictionary (canonical + registered variants) **plus derived
  fragments** — the given name without the surname, one element of a Latin name — because the way a
  real name actually survives into prose is the part people say. It over-blocks by construction and
  says which of the three ways each hit was found. Direction chosen deliberately: a blocked export is
  a sentence to rewrite, an exported real name is a person identified to somebody holding a document
  about their relationship. Single characters are never derived — a check that fires on every 明 gets
  switched off.
- 2026-08-10: **metadata stripping runs before every other check**, not after. Front matter, HTML
  comments and the invisible character classes (zero-width, bidi controls, Unicode tag block) come out
  first, so a name hidden from the reader is not also hidden from the scan — a test splits a
  registered name with a zero-width space and the gate catches it. That pass is also the whole of
  what "metadata-stripped" means for a text export: no author, no tool string, no per-copy
  invisible marking, and the only provenance left is the watermark a reader can see.
- 2026-08-10: the watermark goes **on top**, carries the export id and names nobody. On top because the
  framed document underneath must stay intact — the one-sided label still opens it, the response entry
  point is still the last line, and `assertShareable` is re-run over the finished bytes, which is the
  literal meaning of "the last thing that runs". The id resolves to the audit row on this machine,
  which knows who received it; a watermark printing the recipient's name would be a privacy leak
  stamped on by the privacy machinery. Its date is ISO with hyphens because `08/10` reads as a numeric
  split to the shareable language check, which would refuse a document over its own watermark.
- 2026-08-10: **a refused export writes no audit row.** What `judgment_exports` audits is egress, and a
  document that was blocked never left; a table mixing copies that were handed over with copies that
  were not cannot answer the only question it exists for. The row stores `content_sha256` and not the
  text — enough to say whether a copy found later is this one, without making the audit a second place
  the judgment lives (the same discipline as `egress_ledger`).
- 2026-08-10: "no one-click social share" is implemented as a **named refusal**, not as an absent
  button. There is no network call anywhere in the module, so the list of refused channels is not what
  makes sharing impossible; it exists so that reaching for one gets a reason instead of a shrug.
  Exporting `self_reflection` calls `assertShareTokenAllowed` — the same single definition of which
  renditions may leave — and re-throws it as an export refusal, so there is one rule under both doors.

### From the real run, 2026-08-11 (what did not work, and what the output actually reads like)

- **The four gates were green while the app served nothing.** `next dev` 500'd on every route
  because `src/instrumentation.ts` — new in item ④ — is compiled for the edge runtime as well, and
  webpack resolves imports statically: an `await import("./server/db")` in the entry body pulled
  `better-sqlite3` and its `require("fs")` shim into a bundle with no `fs`. The early
  `if (NEXT_RUNTIME !== "nodejs") return;` guard is a *run-time* guard and does not stop a
  *build-time* resolution. `npm run build` passes, so nothing in the checklist would ever have
  caught this. Fixed by moving the body to `src/instrumentation-node.ts` and reaching it only
  from inside `if (process.env.NEXT_RUNTIME === "nodejs")`, which DefinePlugin folds to `false`
  on edge so the branch is dropped before resolution. The lesson worth keeping is the gap, not
  the fix: **`npm run build` is not evidence that the application runs.**
- **The document's last line points at a route that does not exist.** `DEFAULT_RESPONSE_ENTRY_POINT`
  is `/respond`; there is no `/respond` page and a request 404s. The shareable copy says "The way
  to respond is attached to this document" and "Add your side of it here: /respond", and the
  render layer is right to insist a response entry point exists — but nothing checks that the
  string resolves. M4 excluded invite tokens on purpose, so this is scope, not oversight; what is
  the defect is that the copy makes the promise anyway, in the artifact whose *whole reason for
  existing in M4* was that it was wrong about its reader. Left open and named, because quietly
  deleting the sentence would leave a one-sided document with no way to answer it, which is worse.
- **The copy also over-promises what responding does.** "Nothing has been decided that your side
  cannot change" is a stronger claim than the code supports: `fileAppeal` takes a judgment id and
  grounds and has no notion of who is filing, so there is no counterparty-initiated re-hearing
  anywhere in M4. Her account can be *added* as evidence and the case re-heard by the client; it
  cannot be re-opened by her. M5 either builds that or the sentence gets weaker.
- **Two quoted Chinese spans in the shareable copy are not from any citable utterance** (both
  quoted in the case record). They are not a HARD RULE #1 breach: both sit inside `unresolved`
  entries whose claims (`U2`, `U3`) carry **zero** `evidence_refs`, and both came from
  `evidence.content_summary` into the *frozen M3 fact layer*, so every M4 derivation inherited them
  correctly. Naming a hole does require naming the material that raised it. Worth recording anyway:
  the second span is a ChatGPT-drafted line from the client's side that the record says may never
  have been sent, and it is reproduced to 甲 in a document about her relationship. It is 13
  characters, so the export gate's 15-character cap never sees it.
- **The name scan is exactly as good as the dictionary, and the real case's dictionary is thin.**
  It holds exactly two registered names, one mapped to `甲` and one to `乙`. Splicing either
  registered name into the real document is blocked, including a form split by a zero-width space
  (metadata stripping runs first, as designed). The client's full legal name — never registered —
  is **not** caught, and `deriveNameFragments` cannot help because it derives from what is
  registered. The gate is sound; the registration step upstream of it is the weak link, and no
  test can cover a name nobody entered.
- **The export gate passed the real copy on every check**, and the quote rule did the thing it was
  rewritten for: 19 verbatim spans, 4 over the cap, all 4 exempted as 甲's own words via the
  speech-verb attribution test, 0 refused. One audit row written (`file` channel, 6423 bytes,
  sha256 `bc458aba…6167cd`); `wechat` refused by name and wrote none.
- **On the copy itself, read as 甲.** The M3 defect is gone — `checkCounterpartyAddress` returns
  empty on the stored copy and fires twice on the M3 projection of the same judgment, so the check
  has teeth. What the run exposes instead is a tension the document never acknowledges: it opens
  "you were not asked for your account and did not agree to be judged" while resting entirely on
  twelve verbatim quotations of her own messages. From her seat she has been read closely and
  never asked, and those are different complaints. It also tells her that the person who brought
  the case declined three clarification questions — true, and disclosed to the counterparty
  without the client necessarily knowing that is what "shareable" means.
- **The contract's weak item is the one that matters most.** Both commitments are things a person
  can do and someone else can see. But the record's central established fact is that he has not
  learned to drive despite repeated urging, and the contract's answer to it is *explain why you
  haven't* — a conversation, not the act. "Book a lesson or a theory test by Sunday" is the
  observable one-week version and no item says it. The second commitment ("the next time you use
  AI to draft a plan …") has an occasion marker, so the vagueness check passes it, but the
  occasion is **contingent**: within a 7-day window it may simply never arrive, and an item that
  can be honestly reported as "did not come up" is not yet a commitment. `checkImprovementItem`
  should probably require the trigger to be an occasion that *will* occur inside `within_days`,
  not merely one that is named.
- **The repair script assumes a cooperation she has not agreed to.** "Either of us says 'pause'
  and puts a hand flat on the table" is a bilateral mechanic in a document produced at L2, where
  the whole binding rule exists because she has not been heard. The L2 rule is scoped to the
  contract and the script is not in breach of it — but it is the same species of thing, and the
  sayability checks do not look for it.

---

## M3 adjudication pipeline — accepted with one item deferred (2026-08-09 → 2026-08-10)

12 of 13 acceptance items pass. The real OpenAI polish call is deferred to M4 as a credential
issue, not a code issue: `OPENAI_API_KEY` holds an `sk-ant-…` value. The degradation path and
the entailment check both ran on real text; only the vendor round trip is unverified.

Status: in progress (started 2026-08-09). Built in two waves; wave A is the pre-judgment
pipeline, wave B is the judgment machinery.

## M3 scope

### Wave A — pre-judgment pipeline

1. **Case shell** `/case/[id]`: a nine-stage stepper showing the current stage, what it
   needs, and what is blocking advancement. Stage transitions happen only in server-side
   functions that check preconditions (see hard rule #2); the UI cannot skip a stage.
2. **Safety screening gate**: deterministic local keyword/pattern rules run first, then a
   `safety_screen` stage (opus-4-8, high recall). Either layer firing routes the case to a
   referral page. **Crisis resources render with no model in the loop** (hard rule #9).
   A `safety_screens` row records answers, red flags and outcome.
3. **Clarification loop FSM**: `clarification_rounds` drives ≤3 rounds × ≤3 questions,
   counted in server code (schema `maxItems: 3` is only a backstop). A fable stage picks
   the questions and reports `can_proceed`; answers persist and feed the next round.
4. **Steelmanning**: a fable stage writes the counterparty's strongest version of the
   story; the user confirms ("they would probably say roughly this") or rebuts, via
   ConfirmCard. Inability to produce or confirm one is recorded as a downgrade signal.
5. **Issue fixing (three lists)**: undisputed facts / disputes of fact / disputes of
   standard. Every item carries `evidence_refs`; the server validates that each reference
   exists **and** is confirmed, and rejects the generation otherwise (hard rule #1).
6. **Adverse-fact pre-acknowledgment**: adverse facts about the client are surfaced and
   must be acknowledged or contested before judgment can run. This is the anti-"help me
   win" gate, so it is a hard precondition, not a screen the user can skip.

### Wave B — judgment machinery

7. **Judgment generation, two-step**: fable at effort `xhigh` produces a structured
   skeleton (`fact_layer`: claims with `claim_id`, `evidence_refs`, confidence, and the
   responsibility split) → then the narrative (`surface_layer`, each paragraph bound to
   `claim_id`s). The narrative may not introduce a claim the skeleton does not contain.
8. **Streamed progress, gated publication**: the SSE stream carries only
   `thinking: {display: "summarized"}` and stage heartbeats, rendered as a "hearing in
   progress" panel. The judgment body is buffered, persisted, validated, and published in
   one piece — never streamed to the user unvalidated.
9. **Swap test**: re-run the skeleton with the party identities swapped (address-term
   dictionary swapped too). Compare responsibility allocation; past the threshold, flag
   bias and re-hear once at effort `max`. Persist the comparison as an audit record.
10. **Polish + validation chain**: placeholder locking (quotes / numbers / grades / dates
    → `{{Q1}}`-style tokens) → GPT polish of surface text only → deterministic checks →
    opus-4-8 entailment check (`embellishment / weakening / reversal / omission`) → any
    failure ships Fable's original. Persist the (original, polished, diff) triple.
11. **Dual-version renditions**: `self_reflection` (contains the criticism directed at the
    client; the server refuses to mint a share token for it) and `shareable`. Visibility
    is enforced in the query layer, not the UI.
12. **Freezing and versioning**: a `final` judgment is immutable; regeneration creates
    `version + 1` and the UI must disclose the diff, the serving model, and
    `fallback_used` (hard rule #6).
13. **golden-cases harness**: `npm run eval:golden` runs the seeded real case plus
    constructed fixtures through the pipeline and asserts the invariants that matter
    (derived output level, no unconfirmed citations, no responsibility percentages, no
    characterization of the absent party).

## Explicitly not in M3

Improvement contract / repair script / 7-30 day follow-ups / appeal channel / shareable
export gate (all M4); two-person login (M5); GPT as an independent second judge (cut by
design — see doc 02 §1.2); a Chinese rendition of user-facing verdicts (a later output
variant, not a milestone blocker).

## M3 acceptance checklist

- [x] `npm run typecheck && npm test && npm run build` all green
- [x] Safety gate: a constructed red-flag case is refused and lands on the referral page,
      with the resource block rendered without any model call (asserted in a test)
- [x] Clarification FSM: a 4th round and a 4th question are both rejected server-side,
      with tests; the budget cannot be talked around from a prompt
- [x] Hard rule #1 holds under adversarial input: a model-emitted `evidence_ref` pointing
      at an unconfirmed or non-existent utterance rejects the generation (test)
- [x] Adverse-fact acknowledgment is a real precondition: judgment refuses to run while
      any adverse fact is `pending` (test)
- [x] The seeded real case produces its **first L2 one-sided perspective analysis** —
      L2 rather than L1 because only one party's material exists, which is itself the
      proof that output-level derivation works. Heard 2026-08-10 through
      `POST /api/case/:id/judgment` on a dev server: `claude-fable-5` at `xhigh`,
      `fallback_used=false`, one attempt per stage, v1 frozen with both renditions
      (judgment `93ebbead`, level locked at L2 with reason `counterparty_absent`)
- [x] The judgment carries no responsibility percentage and no motive/character
      characterization of the absent party (asserted by the golden-cases harness, which
      re-checks the frozen judgment on every run: `findings.responsibility` is empty,
      no numeric share survives either rendition, and no character epithet is attached
      to 乙 — the party with no confirmed line)
- [x] Swap test: built, unit-tested (`src/server/judgment/swap-test.ts`, 20 tests) **and
      run on the real case** (2026-08-10, both arms `claude-fable-5`, 103.7s / 132.4s,
      audit row in `judgment_swap_tests`). The seam it needed is
      `JudgmentRunOptions.dossier` plus `swapJudgmentDossier`; the two prompts differ in
      the party register and the record-basis client marker and in nothing else. It
      reports the case **degenerate first**, then three measured differences
      (`claim_only_in_one_arm`, `characterization_moved` ×8, `tier_changed` ×2) and no
      score — see the decision record for what those differences can and cannot mean here
- [x] **Polish chain — the real GPT round trip finally ran** (2026-08-14, funded key, sandbox copy).
      `gpt-5-mini` resolved via the `GET /v1/models` preflight; `outcome=applied`; deterministic
      checks clean; entailment `consistent: true`. Hard rule #8 verified on real GPT output, not
      just a real payload: 41 locked values egressed, `refill(lock(x)) === x`, zero quotes/grades/
      confidences leaked from a 9,205-char turn.
      **The finding is that the layer does not earn its keep, and the premise it was built on did
      not survive testing.** The architecture assumed GPT writes more gently than Fable. Measured:
      gpt-5-mini changed **0 characters** on one run and **12** on another (four synonym swaps in
      one section; no adverse finding touched). `gpt-4.1-mini`, tested to separate "this model
      declines to edit" from "the layer is worthless", rewrote all seven sections for −171/−144
      chars — ~80% typography (it collapses spaced em-dashes, which reads *worse* against CJK
      quotation marks) and, reproducibly in both runs, **deleted the epistemic hedges the document's
      authority rests on**: "and on the record as it stands that supports reading" → "supporting
      reading"; "reads as a dispute of standard" → "**is** a dispute of standard", in a section
      whose own closing line says "not findings of fact". The drift is toward more certainty, not
      more comfort — the opposite of the feared direction, and equally a violation.
      **The entailment guard passed all of it.** Across six real runs it has never rejected real GPT
      output; its only rejection to date remains the 2026-08-10 stub. A guard that passes
      hedge-removal is not evidence of safety, so `applied` currently means less than it appears to.
      It also costs 7× the call it guards ($0.0333 vs ~$0.005).
      **The 20s budget is a coin flip**: measured OpenAI exchanges 16.5 / 16.8 / 18.4 / 18.5s; two of
      the four production-budget runs timed out, so the same judgment polishes on one run and ships
      unpolished on the next. `POLISH_TIMEOUT_MS` bounds only the OpenAI half — the entailment call
      runs under no budget, making real added latency 18–21s, unbounded above.
      **Standing recommendation, not yet acted on:** cut the layer, or demote it to an explicit
      post-freeze opt-in that never sits in the hearing's latency path. The engineering is sound
      (placeholders, fallback, breaker, audit all behaved); the value is absent. Decision is the
      user's.
- [x] `final` judgment is frozen: a regeneration attempt produces version 2 and surfaces
      the diff (test) — `editJudgment` throws and leaves the row byte-identical,
      `regenerateJudgment` writes v2 pointing at v1, and `compareJudgmentVersions`
      surfaces the claim/section diff with the serving model and `fallback_used`
      (`tests/judgment-versions.test.ts`; view at `/case/[id]/judgment/versions`)
- [x] `npm run eval:golden` passes — 14/14 cases: 5 constructed cases that must go
      through (L1 / L2 / L3 / refused / gate-blocked), 8 built to be caught (unconfirmed
      citation, non-existent citation, allocation at L2, understated record basis,
      narrative out-running its skeleton, a percentage in the prose, a character label on
      the silent party, a claim on ungraded evidence), and the real case re-checked
      read-only against the record as it stands
- [x] clean commit
- **M3 is NOT closed.** Everything above passes except the real OpenAI polish call, which
  is blocked on a credential (`OPENAI_API_KEY` holds an `sk-ant-…` value). Paste a real
  `sk-…` key and re-run the hearing; no code change is needed. That one item is what
  remains.

## M3 decision record

- 2026-08-09: M3 runs in two waves (A pre-judgment, B judgment machinery) rather than one
  pass — the milestone is the largest in the plan, and wave A must be verifiable on the
  real case before the judgment machinery is built on top of it.
- 2026-08-09: new pipeline stages are registered in `src/server/llm/stages/*` rather than
  growing `src/server/llm/config.ts`, which was becoming a single crowded registry file.
- 2026-08-09 (wave A walked end to end on the real case, $0.6394 across 5 billed calls,
  0 fallbacks): safety screen → clear; one clarification round (3 case-specific questions,
  loop settled as saturated); steelman for 甲 accepted; 7 issue items (5 undisputed / 0
  disputes of fact / 2 disputes of standard); 5 adverse facts about the client, all
  acknowledged. Evidence-integrity invariant re-confirmed after the walk: 14/11/7 unchanged,
  every `utterances.updated_at` still at the seed-import timestamp, all quotes verbatim.
- 2026-08-09 (**finding — the case is more one-sided than its own disclaimer says**): all
  five of the client's own utterances are still `confirm_status = pending`, so under hard
  rule #1 the client has literally never spoken inside the record. Every issue item and all
  five adverse facts therefore cite one of the same two confirmed utterances, both spoken by
  甲. The pipeline behaved exactly as designed; the input is thinner than it looks. Two
  consequences: (a) the human confirmation pass on the client's own lines is a prerequisite
  for a judgment worth reading, and (b) wave B's judgment must state this asymmetry
  explicitly rather than relying on the generic L2 label.
- 2026-08-09 (**contamination — must be cleaned before any real judgment**): to walk the
  pipeline, the integration agent had to author the three clarification answers itself, each
  prefixed `[INTEGRATION WALK — answered by the operator running the wave-A test, not by the
  case submitter]`, and it moved 甲's `participation_state` to `unaware`. These are operator
  decisions sitting in a real case record. They must be purged or re-answered by the client
  before a judgment is generated; wave B starts by clearing them.
- 2026-08-09 (gap found by the walk, assigned to wave B): wave A dead-ends one step short of
  judgment — the only unmet precondition is `output_level_locked`, and the sole caller of
  `deriveOutputLevel` in the tree is `lockCaseAsRefused`, i.e. the level is only ever locked
  on the refusal path. Wave B must add the lock-on-pass path.
- 2026-08-09 (scope the integration agent took, and was right to): `runIntakeSafetyGate` had
  zero callers outside tests — nothing in the product could actually run the safety screen —
  and no code path could move `case_participants.participation_state` off `pending`, which
  permanently blocked entry into `issue_framing`. Both were wired up during integration.
- 2026-08-09: **working language switched to English, with the evidence layer deliberately
  exempt.** Code, comments, tests, commit messages, docs, SPEC.md, prompt templates, product
  UI copy and model output shown to the user are now all English. The reason is that the
  project's own artifacts have two different jobs, and only one of them is writing: source,
  prompts and UI are instructions the system issues, and a single language for them removes
  the constant translation tax at every boundary (a prompt written in Chinese producing an
  English schema field was already the most common source of drift).

  What was deliberately **not** translated, and why:
  - `utterances.content` (`ai_draft` / `human_final`), `events.title` / `events.description`,
    `evidence.content_summary`, the pseudonym tokens `甲` / `乙`, and the seed-import source
    files under `../relationship-analysis/transcripts/` and `analysis/events-referenced.md`.
  - These are records of what a person actually said. Translating them would destroy the
    thing the product reasons about: this case turns on readings of two short utterances
    (quoted in the case record), and the tone, the particles and the repetition ARE the evidence.
    A paraphrase silently substitutes the translator's judgment for the speaker's words and
    then invites the judge to rule on it — which is precisely the failure the whole
    confirm/citation apparatus exists to prevent.
  - The practical test used throughout: if a string is something a person said, it stays;
    if a string is something the system says, it becomes English.
  - Consequence for prompts: English prose may WRAP a Chinese quote but may never REPLACE
    it. `translate.v3` and `evidence_anomaly.v2` therefore instruct the model to answer in
    English while quoting the cited fragment verbatim in its original language; the schema
    field descriptions say the same thing, so the constraint survives structured output.
  - `evidence.grade_rationale` is machine-generated prose about the evidence, not evidence,
    so it is English. It was already English before this change and did not move.

  Verified at the time of the switch: evidence 14 / events 11 / utterances 7, all
  evidence-layer text byte-identical to the pre-change database snapshot (zero drifted
  rows) and to the source corpus, with the seed importer still idempotent across two runs.

- 2026-08-10 (wave B, the judgment data contract — `src/server/judgment/contract.ts`): the two
  layers, their coherence rule and their lifetime, with no model anywhere in the file. Four
  decisions worth recording.
  - **Freezing is literal (HARD RULE #6).** No column of a `final` row is ever written again,
    not even its status; every mutating statement carries `WHERE status = 'draft'` as its own
    guard, so the check that authorizes a write is the statement that performs it. Supersession
    is recorded on the *successor* (`supersedes_judgment_id`, migration 0005), never as a flag
    flipped on the predecessor, so the row a user already read stays byte-identical forever.
    "Which judgment stands" is answered by the version chain (`readCurrentJudgment` = highest
    `final`), and the chain is a line, not a tree: a predecessor may be re-heard once.
  - **The narrative may not out-run the skeleton.** `validateJudgmentContract` is the exposed
    validator; a section (or a finding) citing a `claim_id` the fact layer does not define is a
    violation that rejects the write, not a warning. Every write path runs it before touching
    SQLite.
  - **`unknown`-tier claims cite nothing.** high_confidence / inferred claims must carry ≥1
    `evidence_ref` (≥0.7 confidence for the former); an `unknown` claim must carry none and stay
    at ≤0.2. This is the shape the seeded case needs in order to state its own hole — "what 乙
    said at the time is not in the confirmed record" — without inventing a citation for it.
  - **The one-sidedness is data, not prose.** `findings.record_basis` carries the citable counts
    (total / by_client / by_counterparty) plus the client's pseudonym, and the schema refuses a
    `by_client: 0` that does not also name the client among the parties who have not spoken
    inside the record; `findings.unresolved` carries `clarification_unanswered` as a first-class
    reason, which is the state the operator purge leaves behind. Renditions are derived from the
    surface layer at `finalize` (audience filter in exactly one place: `self_only` marks the
    criticism aimed at the client), never authored, so `shareable` cannot contain a sentence
    `self_reflection` does not.
- 2026-08-10 (**wave B ⑦/⑧ — judgment generation and gated publication**): two fable stages at
  effort `xhigh` (`llm/stages/judgment-skeleton.ts`, `judgment-narrative.ts`), both declaring the
  contract's own `factLayerSchema` / `surfaceLayerSchema` as their response format rather than
  restating the shape. Four decisions worth recording:
  - **The asymmetry is arithmetic, not a canned sentence.** `judgment/asymmetry.ts` counts, from
    SQLite, who has confirmed speech, how many lines each party has on file but uncitable (and
    under which `confirm_status`), and how many issue items and adverse facts rest on each
    party's words. Those numbers go into the prompt; the paragraph is the model's. On the way
    back, `verifyRecordBasis` rejects a generation whose restated counts disagree with the
    database — a judgment may choose its words about the hole in its evidence, not its size.
    A canned sentence was rejected precisely because it would stay true after the record moved.
  - **The output level constrains the prompt in code.** `judgment/levels.ts` holds one table,
    used twice: it generates the constraint block the dossier carries, and it re-checks what
    comes back. At L2 `findings.responsibility` must be empty and a non-empty one rejects the
    generation whatever it contains — including `not_established`, which is still a row
    addressed to a party. A hearing that did not allocate responsibility says so in a `limits`
    section.
  - **The narrative call cannot see the record.** `runJudgmentNarrative` takes a `FactLayer` and
    builds its prompt from that alone (no dossier, no evidence block), so the one-way rule is
    enforced by what the second call is *given* as well as by the validator that checks what
    comes back. A section citing an unknown `claim_id` rejects the whole judgment; it is never
    dropped, because a judgment that quietly loses a paragraph reads as complete.
  - **Publication is gated and the progress channel cannot leak it.** `generateJudgment` runs
    buffer → persist draft → validate against a re-read of the record → `finalize` (freeze +
    both renditions, one transaction). The SSE route forwards a closed event union whose string
    fields are looked up in code-owned tables — there is no `message: string` parameter on the
    way to the wire, and a failure is sent as a *code* because the fault report quotes the
    model's own statements back. Asserted by streaming a sentinel-bearing judgment and reading
    every byte the viewer would have received.
  `runStage` is a buffered call, so the "summarized thinking" the panel shows is the server
  narrating its own phase, not model thinking deltas — honest, and structurally unable to carry
  a sentence of the judgment.
- 2026-08-10 (**polish + validation chain built, ⑩**): `judgment/placeholders.ts` →
  `judgment/polish.ts` → `judgment/polish-validation.ts` → `judgment/polish-chain.ts`, plus the
  `polish_entailment` stage and migration `0006_judgment_polish`. Four decisions worth keeping:
  - **Quotations lock first, and every occurrence gets its own token.** Locking numbers or
    dates before quotations turns `“你上次说3月2号会打电话，结果又没打”` into three fragments a
    polisher can reorder, and quotation marks then stop guaranteeing what sits between them.
    Deduplicating identical values would soften the deterministic rule from "each placeholder
    appears exactly once" to "at least once", which no longer notices a dropped occurrence.
  - **The deterministic layer asserts structure only, on purpose.** Token counts (per section,
    so a quote that moves between findings is caught as a re-attribution), id sets, length
    inflation. Regex assertions over Chinese — "3次" vs "三次" vs "好几回", a hedge added by one
    可能 — either fire on every legitimate rewording or miss every case that matters, and a
    check like that gets believed. Semantic drift is the entailment stage's job, and locking the
    facts out of the request beforehand is what makes that division safe.
  - **An entailment check that could not run rejects the draft.** "We could not check" and "we
    checked and it passed" must not produce the same output, so a refusal or transport error is
    `entailment_unavailable` and the original ships.
  - **Only vendor faults trip the breaker.** Three consecutive timeouts/5xx/malformed responses
    open it; a rejected polish does not, because that draft came back from a working vendor and
    content disagreements must not be able to disable the layer.
- 2026-08-10 (**blocker — the OpenAI key is not an OpenAI key**): `OPENAI_API_KEY` in
  `.env.local` holds an `sk-ant-…` value (an Anthropic key), and `GET https://api.openai.com/v1/models`
  with it returns HTTP 401. So the required "verify the model exists by listing models before
  use" could not be satisfied against the live account, and the acceptance item "the real GPT
  path runs once end to end" is blocked on a credential, not on code. The verification is
  implemented as a runtime preflight rather than a build-time choice: `resolvePolishModel`
  lists the account's models and takes `OPENAI_MODEL` when set (still verified) or else the
  first available id from `POLISH_MODEL_PREFERENCE`, and skips polish with a reason naming the
  account's own `gpt-*` ids when neither holds. Paste a real `sk-…` key (optionally set
  `OPENAI_MODEL`) and the path runs with no code change.
- 2026-08-10 (**swap test ⑨, dual renditions ⑪, freezing + version view ⑫**):
  `judgment/swap-test.ts`, `judgment/rendition.ts`, `judgment/versions.ts`, migration
  `0007_judgment_swap_tests`, and the view at `/case/[id]/judgment/versions`. Five decisions.
  - **No bias threshold, because nothing calibrated one.** SPEC ⑨ originally said "past the
    threshold, flag bias and re-hear at effort `max`". There is not one labelled pair of
    hearings behind this product, so any cut-off would be a number somebody chose, printed with
    the authority of a measurement and read as "the machine checked itself and passed". The
    module reports measured differences (allocation moves, claims present in one arm only,
    citation-signature pairings, tier changes, confidence deltas) plus qualitative flag codes,
    and exports no threshold. The automatic re-hearing at `max` is therefore not implemented
    either: it was the threshold's consequence, and a re-hearing triggered by an uncalibrated
    number is a cost with a rationale nobody can state.
  - **The transformation is a register exchange, not a relabel.** A full relabel (甲↔乙
    everywhere, quotes included) is an isomorphism: the swapped file has the same structure with
    the labels exchanged, so any hearing that reads the record at all mirrors its own output and
    "passing" means only that the model is insensitive to which token sits where. What runs
    instead exchanges the two parties' pseudonyms **in the party register and nowhere else** —
    every quote, speaker label, timeline entry and clarification exchange is byte-identical in
    both arms (CLAUDE.md: a record is never rewritten, not even for a test), and the audit row
    carries the line-level diff of the two prompts as the receipt. Consequence, recorded because
    it is easy to get backwards: the arms are **not** name-translated before diffing — 甲's lines
    are 甲's in both prompts, so translating one arm would manufacture a difference that is not
    in the data. `mapSkeletonBack` exists for the relabel arm and is documented as not used here.
  - **The address-term dictionary accounts for role words rather than exchanging them.**
    Pseudonyms are exchanged; `client` / `counterparty` / `submitter` / `initiator` / `respondent`
    are registered, counted per section, and left alone — a role word names a *position*, and the
    swap moves names between positions, so exchanging the position words as well would apply the
    swap twice. What the dictionary is for is the audit: everything that still marks who is who
    is listed in `residualChannels`, because the honest form of "the model can still tell" is a
    list, not a claim that the list is empty.
  - **On this case the test is degenerate, and says so first.** With only 甲's two lines
    confirmed, exchanging the register does not produce a mirror of the case — it produces one in
    which the only party who has spoken is also the one who brought the complaint. A difference
    between the arms is as consistent with the hearing responding honestly to that as with it
    following whoever filed, and the two cannot be told apart from this record. `degenerate` +
    `degenerate_reason` are first-class columns, computed from the record before either arm runs,
    so a tidy comparison cannot argue the record out of its own shape.
  - **The shareable frame is re-derived, never stored.** `contract.finalize` writes both
    renditions as plain projections; the label, the invitation and the response entry point are
    composed by `renderShareable` at every read and share, and `assertShareable` refuses a
    document lacking any of them. A label baked into a stored string is one UPDATE away from
    gone. The language check (win/lose vocabulary, responsibility percentages) runs over the
    judgment's own English prose with verbatim quotes stripped first: a counterparty who wrote
    `“你到底认不认错，这事你占七成责任”` is a fact about the record, and suppressing it to pass our
    own test would be rewriting evidence. `mintShareToken` refuses a `self_reflection` rendition
    through three independent guards — the contract's rule on the kind, the stored row's own
    `shareable` flag (still refuses when the row is doctored to `true`), and re-validation of the
    derived document — and stores only the token's SHA-256.
- 2026-08-10 (**seam wave B still needs**): the swap test takes an injected `SkeletonRunner`, so
  it is testable and complete, but `runJudgmentSkeleton(db, caseId)` assembles its own dossier
  from the database and offers no way to hand it a swapped one. Running the swapped arm on the
  real case therefore needs one seam in `judgment/generation.ts` — accepting a pre-assembled
  dossier (or a prompt override) — after which the swapped register is applied to the dossier's
  `Parties` section the way `swapCaseFile` applies it to the case file's. Left undone rather than
  taken, because generation is another agent's file this wave.
  **Taken 2026-08-10**: `JudgmentRunOptions.dossier` (one line in `runJudgmentSkeleton`) plus
  `swapJudgmentDossier`, which exchanges the register in the `Parties` section and moves the
  client marker in the `Record basis` section — those two and nothing else. The counts stay with
  the pseudonym who spoke them (甲 keeps its 2 citable lines in both arms; what moves is that the
  swapped register calls 甲 the client, so `by_client` reads 2 there and 0 in the filed arm), and
  the injected dossier is checked against its own asymmetry, so an arm is never validated against
  numbers describing the other one. Citations still audit against SQLite by `caseId`, so the seam
  cannot be used to smuggle an uncitable line into a hearing, and nothing produced from an
  injected dossier is publishable — `publication.ts` assembles its own.

- 2026-08-10 (**the first real judgment**, `POST /api/case/:id/judgment`, dev server on 3008):
  v1 published and frozen — `claude-fable-5` at `xhigh`, `fallback_used=false`, one attempt per
  stage, 15 claims (7 high_confidence / 3 inferred / 5 unknown — the unknowns citing nothing, as
  the contract requires), `findings.responsibility` empty, both renditions minted in the same
  transaction. Level locked at **L2**, reason `counterparty_absent`, over inputs
  `participation=pending, grades C:12/D:2, citable 2 (byClient 0, byCounterparty 2)`. Cost of the
  hearing that stands: **$0.9054** (skeleton $0.5387 / narrative $0.3667); cost of the whole
  wave-B run — the two rejected attempts below ($1.2525), the published hearing, both swap arms
  ($1.2999) and the entailment probe ($0.0475): **$3.5053** over 7 billed calls, 0 fallbacks.
  Three things the run revealed that no test had:

  - **The pseudonymization gateway was un-pseudonymizing the judgment** (found by two rejected
    generations, $1.25). `EgressPipeline.restoreDeep` walks every string coming back and puts the
    canonical names in — right for a translator card, wrong for anything stored: the skeleton
    restated `client_pseudonym: "乙"` exactly as given, the gateway rewrote it to the client's
    registered display name, and `verifyRecordBasis` rejected the generation for naming the client
    where the database says 乙. The retry did the same thing for the same reason, which is the
    useful part — the model was never wrong. Fix: `StageDescriptor.keepPseudonyms`, declared by
    the two judgment stages, restoring PII placeholders but not names. Had the check not existed, the case's real names
    would have been written into `judgments.content` and into the copy that gets shared, making
    the stored artifact the one place the mapping table is unwound.
  - **The shareable-language guard refused the judgment's own disclaimer.** The `limits` section
    ends "…and no percentage, ratio or score — should be read as answering it", and the rule
    banned the *word* `percentage`, so `renderShareable` threw and the document could not be
    shared. The rule now matches an allocation — `70%`, `70 per cent`, `70/30`, `七成责任`,
    "percentage of the responsibility" — and not the noun. Same lesson as the polish chain's
    deterministic layer, arriving from the other direction: a lexical rule that fires on the
    disclaimer as readily as on the offence silences the sentence a recipient most needs.
  - **The polish chain is wired into publication and degrades correctly.**
    `GenerateJudgmentOptions.polish` is opt-in (the route opts in; unit tests do not, which is
    why none of them reach for a network), runs between validation and the freeze so polished
    prose is checked by exactly the same code as unpolished prose, and recorded
    `skipped: model listing returned HTTP 401` on the real run with Fable's text published.

- 2026-08-10 (**the swap test, run on the real case**): both arms `claude-fable-5`, 103.7s and
  132.4s, audit row persisted. The two prompts differ in exactly two lines — the party register
  and the record-basis client marker — and the report leads with `DEGENERATE`. Measured:
  `characterization_moved` on 8 claims, `claim_only_in_one_arm` (3 filed-only, 1 swapped-only),
  `tier_changed` on 2 (one 0.95 high_confidence → 0.62 inferred, one 0.6 inferred → 0.88
  high_confidence). Both arms independently passed the citation audit, the level constraints and
  their own record-basis check, and neither allocated responsibility.
  **What that does not license:** on this record the only party with confirmed speech is 甲, so
  the swapped arm is a case where the complainant is also the only voice — a different case, not
  a mirror. Every difference above is as consistent with the hearing responding to that as with
  it following whoever filed. The honest reading is narrower and still worth having: the claims
  that moved are the ones a reader would call *interpretive* (tiers, framings of the dispute),
  while the two arms agree, near-verbatim and at the same tier, on what 甲 actually said. Run it
  again once 乙's five lines are confirmed and the test stops being degenerate.

- 2026-08-10 (**the entailment check, on real judgment text**): with the vendor call blocked, the
  chain was run on a scratch copy of the published judgment as a draft, with a stub polisher that
  softened one sentence of the `itinerary` finding — "You acknowledged this without rebuttal…the
  record supports reading the incident as having occurred substantially as 甲 described it" →
  "You have spoken to it, and it may be that part of the trip changed; nothing here settles
  whether it did". The **real** `polish_entailment` stage (opus-4-8) returned three violations —
  `weakening` on C8, `weakening` on C1, and, unprompted, `reversal` on C8: *"polished says 'You
  have spoken to it', reattributing an acknowledgment to 乙 actively speaking, contradicting that
  乙 has no citable words"*. It caught the one thing this record cannot afford to lose. Outcome
  `rejected`, original shipped.

- 2026-08-10 (**golden-cases harness**, `npm run eval:golden`, SPEC ⑬): fixtures replay recorded
  model answers through the whole pipeline instead of buying them — offline, free, byte-identical
  between runs — and the real case is re-checked read-only from `data/fairjudge.db`, skipping with
  a reason when there is no database (the real case is not in the repository). Three decisions:
  - **Half the fixtures are built to fail.** A harness of clean cases proves the checks did not
    fire and cannot distinguish that from checks that *cannot* fire, so each rule has a case that
    breaks it and a run fails if an expected check stays silent.
  - **The invariants are re-derived from the stored artifact**, not asserted on the pipeline's
    return value. That is the only form of the check that can catch a judgment written before the
    rule existed — which is exactly what the percentage rule's change made possible.
  - **Two severities, and only one soft check.** Citations, claim grading and responsibility
    percentages are fatal. Motive attribution to the absent party is reported for a human and
    never fails a run: "甲 asked for an answer that day" and "甲 wanted to corner him" differ in
    what they claim about a mind, not in their vocabulary, and a pattern list that fails a build
    on the second will eventually fail it on the first. Character *epithets* are fatal, because a
    label applied to a person who never spoke has no legitimate use in a one-sided judgment.

- 2026-08-10 (**defect the first real judgment exposed, not fixed, assigned to M4 — the shareable
  copy speaks to the wrong person**): the narrative is written in the second person to the client
  ("You, 乙, submitted this case…", "Three clarification questions were put to you"), and the
  audience filter selects *sections*, not the person of address. So the copy handed to 甲 addresses
  her as 乙 throughout. The rendition layer must not paper over this — rewriting "you" into "乙"
  at render time would be editing the judgment's own words after it was frozen — so the fix
  belongs upstream, in the narrative stage: a section marked `audience: "both"` may not address
  either party in the second person, checked in code the way the other rendition rules are. A
  second, related observation from the same document: at L2 with this record both findings of
  fact are `self_only`, so the shareable copy carries the disclosure, the standards, the open
  questions and the limits — and no finding at all. That may well be right for a document sent to
  someone who has not been heard, but it is a product decision that has never been made
  explicitly, and it should be made before anything is actually shared.

---

## M2 capture pipeline — accepted (started 2026-08-08, accepted 2026-08-09)

## M2 scope

1. **Local OCR tool** (technical validation first): `tools/ocr/` Swift CLI (Vision framework, `VNRecognizeTextRequest`, recognitionLanguages ["zh-Hans","en-US"], accurate level) + Node wrapper `src/server/ocr/`. Input is an image path, output is JSON: per-line text + bounding box + inferred bubble attribution (left = counterparty / right = phone owner / centered = timestamp, clustered by the box's x position). Validate quality against the 14 real screenshots in `../relationship-analysis/screenshots/` and produce a report; the binary is not committed (source is, build script `npm run build:ocr`).
2. **Switch to SQLCipher**: swap the dependency to `better-sqlite3-multiple-ciphers` (drop-in); the DB key lives in `.env.local` (`FAIRJUDGE_DB_KEY`, generated with openssl rand -hex 32; Keychain integration deferred); a migration script encrypts the existing data/fairjudge.db, preserving all M0/M1 data; tests use :memory:+key. This milestone is allowed to touch package.json (all in one pass: multiple-ciphers, sharp, @dnd-kit/core, @dnd-kit/sortable, fractional-indexing).
3. **Upload and evidence management**: `/evidence` list + upload (sha256 dedupe, sharp re-encode to strip EXIF, stored at data/blobs/<sha256>); an upload triggers an OCR job → utterances(confirm_status=pending); grading = rules derived from source_type + a new gateway stage `evidence_anomaly_check` (opus, catching anomalies of the kind "the screenshot content is actually an AI chat session, downgrade to C") → grade_final confirmed by a human.
4. **Line-by-line confirmation workbench** `/evidence/[id]`: screenshot on the left (zoomable), per-line list on the right; ConfirmCard: confirm / edit / delete + is_retold checkbox + tone-tag dropdown + speaker-attribution correction; a server action persists. The hard-rule test that unconfirmed lines are not citable stays green.
5. **Timeline** `/timeline`: dnd-kit vertical card flow + order_key (fractional-indexing) persistence; occurred_precision badge; events with unknown dates live in an "undated" sidebar and can be dragged into the main line.

## Explicitly not in M2

Cloud vision OCR (only to be discussed separately if local quality proves unusable); speech transcription; per-file envelope encryption (deferred, FileVault + SQLCipher as the fallback); multi-case management UI; the judgment pipeline; GPT.

## M2 acceptance checklist

- [x] `npm run typecheck && npm test` all green (new: opening the encrypted DB / failing on a wrong key, grading rules, upload dedupe, order_key utilities)
- [x] OCR validation report: all 14 real screenshots produce per-line text + bubble attribution; key-sentence spot check (eight key sentences, quoted in the case record) ≥80% findable in the output
- [x] data/fairjudge.db is encrypted: opening with no key / a wrong key fails; M0/M1 row counts unchanged after migration
- [x] uploading the same image twice does not duplicate files; EXIF stripping is verified (`tests/evidence-upload.test.ts`: same buffer twice → duplicate, files/evidence/utterances row counts unchanged, only one blob, OCR and anomaly detection each run only once; a constructed image carrying EXIF comes out of sanitize with exif/icc/xmp/iptc all empty, the camera-model and capture-time strings are not findable in the bytes written to disk, and orientation=6 is baked into the pixels)
- [x] the full upload → OCR → confirmation workbench flow works: confirm / edit / mark as retold / change speaker / tone tag
- [x] the grading suggestions for the 14 screenshots match the current DB (C:12 D:2)
- [x] /timeline drag persistence; undated area → main line drag works (server-side and action-layer unit tests green; the real browser drag was confirmed by hand by the operator on 2026-08-09 — headless automation could not synthesize a valid dnd-kit drop, which was an environment limitation, not a defect)
- [x] clean commit

## M2 decision record

- 2026-08-08: the DB key goes in .env.local (FileVault as the backstop), Keychain deferred; per-file envelope encryption deferred; if OCR quality turns out unusable, escalate for discussion rather than silently switching to the cloud.
- 2026-08-08 (SQLCipher): the driver is installed as an npm alias — `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@^12.11.1"`. `drizzle-orm/better-sqlite3` unconditionally imports the bare package name `better-sqlite3` at module top level; the alias means the process holds exactly one native module, and no SQLite without encryption capability exists anywhere in the dependency tree. `@types/better-sqlite3` removed (mc ships its own index.d.ts).
- 2026-08-08 (SQLCipher): pragma order `cipher='sqlcipher'` → `legacy=4` → `key`, with the key given in SQLCipher's raw-key form `x'<64 hex>'` (skipping the 256k-round KDF: measured ~0.1ms per open vs ~80ms for the passphrase form). A missing key, or one that is not 64 hex digits, fails hard (with remediation guidance) and never silently falls back to plaintext; error messages never echo the key.
- 2026-08-08 (SQLCipher): sqlite3mc has no `sqlcipher_export()` function, so the migration became file-level: WAL checkpoint → record per-table row counts → back up to `data/backup-<ts>.db.plain` → copy and `PRAGMA rekey` the copy → re-check per-table row counts with the key → swap it in. The plaintext backup is kept and deleted by hand; `.gitignore` gains `*.db.plain` and `/data/`.
- 2026-08-08 (SQLCipher): sqlite3mc refuses to set a key on `:memory:` ("Setting key not supported for in-memory or temporary databases"), so the "tests use :memory:+key" written in M2 scope item 2 is void — the encryption test uses a file DB in the system temp directory instead (`tests/db-encryption.test.ts`), `:memory:` stays unencrypted, and the existing M0/M1 tests are unaffected.
- 2026-08-08 (SQLCipher): `drizzle-kit push`/`studio` cannot open the encrypted DB (nowhere to pass the key). Schema changes now go through `drizzle-kit generate` + `runMigrations()` on a keyed connection; noted in drizzle.config.ts.
- 2026-08-08 (evidence grading): the single `evidence(grade_final A-D)` column from doc 02 is split into `grade_suggested` (machine suggestion, nullable) + `grade_final` (human-confirmed, nullable) + `grade_anomaly` (verbatim trace of the anomaly detection). Rationale: M2 scope item 3 requires "grade_final confirmed by a human"; if the rules wrote grade_final directly, "what the machine guessed" and "what the human accepted" would be indistinguishable within one column and downstream code could only reverse-infer from another timestamp — which is also inconsistent with the `ai_draft`/`human_final`/`confirm_status` triple used for utterances. Once split, `grade_final IS NULL` simply means "ungraded", isomorphic to the confirm-status gate of hard rule #1. Migration `0003_evidence_grade_suggestion.sql` has to rebuild the table (SQLite cannot drop NOT NULL in place); the two ADD COLUMN statements were hand-hoisted above the rebuild, otherwise drizzle's generated INSERT…SELECT reads columns that do not yet exist on the old table.
- 2026-08-08 (evidence grading): grading rules only downgrade, never upgrade — base is determined by source_type (firsthand A / recollection B / ai_processed C / public_sentiment D), and of the three downgrade signals (derived_from→C, anomaly detection is_ai_artifact→C, is_mass_content→D) only the harshest takes effect; a signal that lands above base records a reason but does not move the grade. Rationale: a wrong upgrade launders weak material into the fact layer, whereas a wrong downgrade only costs one extra human correction. `evidence_anomaly_check` is sent the OCR summary (≤1200 characters, with left/right/center bubble markers) rather than the full text, and goes through runStage so it passes the pseudonymization gateway; a refusal, a timeout, or an empty summary all fall back to the source_type rules — a broken model should not stop someone from uploading an image.
- 2026-08-08 (full acceptance): `npm run typecheck` 0 errors, `vitest` 218/218 (14 test files), `next build` passes (`/evidence`, `/evidence/[id]`, `/timeline`, `/api/evidence/upload`, `/api/blob/[sha]` all present in the route table). Re-running the OCR calibration harness reproduced its previous report byte for byte (the only difference is wall clock 5.4s→5.3s): 14/14 screenshots produce per-line text + bubble attribution, **key-sentence recall 87.5% (7/8)**, and the sole miss (quoted in the case record) does not exist anywhere in `../relationship-analysis` at all — excluding it, 7/7; the status-bar clock matches `transcripts/00-index.md` on 14/14. Structure over the same run, recorded here because the generated report is not in the repository: 393 recognized lines, 201 blocks (129 content, 72 flagged noise), 3 non-noise blocks attributed to the phone owner (the index says two screenshots carry her own words; both were found, and the third is a partly-visible outgoing bubble verified against the image), 0.38s per screenshot. Speaker attribution produced no false positives on the one error that would matter — machine-generated analysis entering the record as first-hand testimony.
- 2026-08-08 (full acceptance · encryption): a wrong key (64 zeros) fails to open `data/fairjudge.db` and yields migration guidance ("file is not a database"); with no `FAIRJUDGE_DB_KEY` it fails hard rather than falling back to plaintext; the file header is not `SQLite format 3`. Under the correct key, the per-table re-check matches the M0/M1 record: cases 1, participants 2, files 14, evidence 14 (grades C:12 / D:2), utterances 7 (is_retold 5/2, confirmed 2 / pending 5), events 11, event_evidence 18, llm_calls 4, egress_ledger 4. Grading rules re-checked: the DB holds 12 rows of `source_type=ai_processed` and 2 of `public_sentiment`, which under `GRADE_BY_SOURCE_TYPE` derive to exactly C:12 / D:2.
- 2026-08-08 (full acceptance · end to end): the dev server ran on 3004 (3000 is still occupied by the leftover M1 process, not cleaned up). POSTing the original of the real screenshot `Weixin Image_20260717115524_3312_38.jpg` to `/api/evidence/upload` hit the M0 seed's sha256 dedupe directly (duplicate=true, row counts unchanged) — the seed had recorded the original's hash back then; re-encoding the same image and uploading that took the new-row path: files/evidence +1 each, utterances +10 and all `pending`, `grade_suggested=C` while `grade_final` is NULL, anomaly detection returning `is_ai_artifact=true` (it recognized the "Ask ChatGPT" interface); uploading the same image again returns duplicate=true and does not run OCR or the model a second time. The confirmation workbench was walked control by control in the browser: confirm, edit and save, tick retold, tone dropdown, reassign the speaker to 甲 (party A, the respondent), and confirm the grade, writing `grade_final` — the page-header counter went from "pending 9" to "pending 7 · confirmed 2 · edited 1". Hard rule #1 re-checked: `listCitableUtterances` cannot see these rows before confirmation, and after confirmation it gains only the 3 confirmed/edited ones, with not one of the 7 pending rows leaking; the text cited is the human-written line, not the OCR draft. The 1 files / 1 evidence / 10 utterances and the blob created during acceptance have all been deleted, row counts are back to 14/14/7, and `foreign_key_check` reports 0 violations; only the 1 model call that genuinely happened remains, as 1 row each in llm_calls + egress_ledger (4→5) — the audit ledger is never deleted.
- 2026-08-08 (full acceptance · outstanding): `/timeline` returns 200, both columns (3 in the main line / 8 in the undated area) and the `occurred_precision` badges render correctly, and server-side `moveEvent` and `moveEventAction` have unit coverage for order_key persistence, undated area → main line, and refusing to drag a dated event out of the main line; but in the headless browser both dnd-kit pointer drag and keyboard drag only fired onDragStart/onDragEnd without producing a valid `over`, so no card moved and nothing was written to the DB (the 11 events rows are field-for-field identical to before the drag). Judged an acceptance-environment limitation rather than a proven defect; the item stays unchecked, left for a human to drag once in a real browser and confirm.
- 2026-08-08 (full acceptance · plaintext backup not cleaned): `data/backup-2026-08-08T21-11-02.db.plain` (332KB) is still present, and `sqlite3` can read the entire case content out of it with no key (evidence 14 / events 11 / utterances 7, quotes visible in plaintext). It is doubly excluded by `.gitignore`'s `/data/` and `*.db.plain`, so it will not be committed, but it makes SQLCipher effectively useless on this machine — per the SQLCipher migration decision, the deletion is left to a human: `rm` it by hand once the encrypted DB is confirmed working.

---



## M1 LLM gateway + plain-speech translator — accepted (started 2026-07-17, accepted 2026-08-08)

## M1 scope

1. **LLM gateway** `src/server/llm/` (the only channel for every model call):
   - `config.ts`: model price list (fable 10/50, opus 5/25 per MTok; cache reads 0.1×, writes 1.25×/2×), stage registry (each stage declares provider/model/effort/maxTokens/zodSchema/promptTemplate+version)
   - `claude.ts`: unified wrapper — `betas:["server-side-fallback-2026-06-01"]+fallbacks:[{model:"claude-opus-4-8"}]` (for fable calls); never pass temperature/top_p/top_k, no prefill, omit thinking on fable; always check `stop_reason==="refusal"` before reading content → domain result `{kind:"refused", category}`; every call checks `usage.iterations` for `fallback_message` (sticky-routing detection) → fallback_used persisted; structured output zod→json_schema (`output_config.format`) + zod.parse re-validation on the way back
   - `ledger.ts`: every call writes llm_calls (tokens/cost/stop_reason/fallback) + egress_ledger (payload sha256, 30-day expiry date)
   - PII scrubbing through the pseudonymization gateway is mandatory before egress (the person dictionary may be empty at the M1 stage, the regex layer must be live)
   - New dependency: `@anthropic-ai/sdk` (this milestone is allowed to touch package.json, for this one item only)
2. **Plain-speech translator**: page `/translate` + `POST /api/translate`
   - the schema forces three readings: `{benign:{reading,confidence}, neutral:{…}, negative:{…}, cues:[]}` (all three fields required, confidence 0-1)
   - default `claude-opus-4-8` effort medium; the "deep reading" button upgrades to `claude-fable-5`
   - UI: three-column cards (benign / neutral / negative), confidence bars, cues list, model and cost badges; Chinese copy
3. **Live smoke test** `scripts/smoke-translate.ts` (`npm run smoke:translate`): a real call translating one sentence of test corpus, asserting the schema passes, llm_calls and egress_ledger each gain a row, and cost>0.

## Explicitly not in M1

GPT polish (M3); prompt cache breakpoints (M3 — the translator has no stable long prefix); case linkage / evidence ingestion; OCR; the judgment pipeline.

## M1 acceptance checklist

- [x] `npm run typecheck && npm test` all green (unit tests mock the SDK, no real API calls)
- [x] refusal-path unit test: mock `stop_reason:"refusal"` → domain result refused, no exception thrown
- [x] sticky-routing unit test: mock `usage.iterations` containing `fallback_message` → fallback_used=true persisted
- [x] grep over the codebase finds no `temperature`/`top_p`/`top_k` in request construction
- [x] `npm run smoke:translate` passes live: the three-reading schema is valid, llm_calls+egress_ledger persisted, cost_usd>0
- [x] the fable upgrade path verified live once ("deep reading")
- [x] `/translate` works under `npm run dev` (Chinese UI, three-column cards render)
- [x] clean commit

## M1 decision record

- 2026-08-08: M1 full acceptance passed — typecheck 0 errors, vitest 71/71; grep confirms `temperature`/`top_p`/`top_k` appear only in the rule comments in `claude.ts`, with zero hits in request construction; `smoke:translate` green on two live calls (default → claude-opus-4-8, $0.016150 / 8.1s; deep → claude-fable-5, $0.037850 / 11.0s; fallback_used false both times, llm_calls and egress_ledger +1 row each, $0.054 total); under `next dev`, `/translate` returned 200 and included the deep-reading control.
- 2026-08-08: port 3000 on this machine is held by a leftover fairjudge dev server from a previous run (pid 11234), so this acceptance ran the current code on port 3003 instead; `/translate` returns 200 on both ports, and the leftover process was not cleaned up by this acceptance.
- 2026-08-08: acceptance found that `egress.ts` (M1) and `pii.ts` (M0) used a **bare NUL byte** as the separator in composite map keys, which made git classify the source files as binary (`Bin 0 -> 4353 bytes`, no diff / blame / merge). Both were changed to the `\u0000` escape form — the template string produces the same U+0000 code point, so keys are byte-for-byte unchanged at runtime; typecheck 0 errors and vitest 71/71 re-ran green, and both files are now UTF-8 text.

---



## M0 data foundation — accepted (started 2026-07-17, accepted 2026-07-17)

## Scope

1. Project scaffold: Next.js 15 + TS strict + Tailwind + Drizzle + better-sqlite3 + vitest + zod; npm; `npm run dev` serves a placeholder home page.
2. The full Drizzle schema (see doc 02 §1.4): cases / case_participants / files / evidence / utterances / events / event_evidence / clarification_rounds / steelman_versions / issues / adverse_facts / judgments / judgment_renditions / improvement_contracts / repair_scripts / followups / appeals / safety_screens / llm_calls / egress_ledger. Includes the `deriveOutputLevel` pure function (may initially return just the L2/L3 logic skeleton) + unit tests.
3. Pseudonymization gateway `src/server/pseudonym/`: person dictionary (longest match, variants table) + regex PII (phone numbers / emails / WeChat IDs); `pseudonymize()` / `depseudonymize()` round-trip unit tests; unregistered-name detection interface.
4. seed import `scripts/seed-import.ts` (`npm run seed:import`): parses `../relationship-analysis/`
   - the 14-row screenshot table in `transcripts/00-index.md` → files (placeholders, originals not copied) + evidence (#1-2 from 小红书 (Xiaohongshu) → grade D, #3-14 ChatGPT session screenshots → grade C, noted in grade_rationale)
   - the E1–E11 table in `analysis/events-referenced.md` → events (E5/E9 have time ranges, the rest occurred_precision=unknown); quotes from the "B 方回应" ("party B's response") column → utterances(speaker=乙, is_retold=true)
   - the two 【A 原话】 ("A's own words") passages in `transcripts/2026-07-17-chatgpt-session.md` → utterances(speaker=甲, is_retold=false, confirm_status=confirmed)
   - create 1 case + 2 participants (initiator=乙, respondent=甲 — note that the phone in the screenshots belongs to 甲 while the submitter is 乙)
   - sha256 idempotency: re-running produces no duplicate rows
5. Repo governance: CLAUDE.md, SPEC.md, .gitignore (including *.db, .env*), initial commit.

## Explicitly not done (anything past M0's line gets cut)

- No LLM API integration (M1); no screenshot OCR (M2); no UI pages (except the placeholder home page); no SQLCipher (an M2 prerequisite); LLM fallback parsing of the free-text md files (01-background etc.) is skipped.

## Acceptance checklist

- [x] `npm install && npm run typecheck && npm test` all green
- [x] after `npm run seed:import`: evidence 14 rows (grades C/D correct), events 11 rows, utterances contain both values of is_retold, case + participants in place
- [x] re-running seed:import leaves row counts unchanged (idempotent)
- [x] pseudonymization round-trip test: covers a nickname variant of a registered name and regex PII cases
- [x] deriveOutputLevel unit test: one-sided material → L2, predominantly grade C → L3
- [x] git log shows a clean initial commit, *.db not committed

## Decision record

- 2026-07-17: package manager is npm (no pnpm on this machine); M0 uses plain SQLite (FileVault as the backstop), SQLCipher deferred to M2.
- 2026-07-17: M0 full acceptance passed — typecheck 0 errors, vitest 35/35, two seed:import runs with identical row counts (evidence C:12/D:2, events 11, utterances 2+5), *.db excluded by .gitignore; initial commit established.
