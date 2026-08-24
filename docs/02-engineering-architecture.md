# Dual-LLM (Fable + GPT) Engineering Implementation Plan v1

Source: 4 engineering perspectives (LLM orchestration / full-stack / cost & reliability / privacy & security) + 1 critique-and-ruling round, 2026-07-17.
Full original analysis archived at: tasks/wtj5i0x92.output. Where sources conflict, the ruling from the critique round governs.

## 0. The architecture in one sentence

**A TypeScript monolith (Next.js) + local encrypted SQLite; the nine-stage pipeline is built as a server-side state machine; one vendor (Anthropic) does all the judging and all the writing, and the fact layer is structurally unreachable by anything that only rewrites prose; media (screenshots/voice) is transcribed locally, and any text leaving the machine goes through the pseudonymization gateway first.**

```
Screenshot/voice ──local OCR (macOS Vision) / whisper.cpp──▶ utterances (confirmed line by line, by a human)
                                                                    │
Pseudonymization gateway (dictionary+regex, deterministic, local) ──┤  ← mandatory checkpoint on every LLM egress
                                                                    ▼
   ┌─ Judgment layer   claude-fable-5:   clarification-question selection / steelmanning / issue fixing + adverse facts / judgment skeleton + narrative / appeal
   └─ Support layer    claude-opus-4-8:  safety screening / grading anomaly detection / timeline extraction / post-judgment documents / follow-ups (Batches)
                                                                    ▼
                  Judgment = fact_layer (immutable) + renditions (self-reflection version / shareable version)

   There is no third layer. An "expression layer" — GPT (OpenAI) rewriting surface_layer
   text — was built, measured and removed on 2026-08-16; see §1.1a.
```

## 1. Settled core decisions (including the critique round's rulings)

### 1.1 The two-layer boundary: guaranteed by data structure, not by promises in a prompt
- Fable outputs **two-layer JSON**: `fact_layer` (claims[], each carrying claim_id, evidence_refs, confidence — immutable) + `surface_layer` (narrative text, each paragraph bound to claim_ids). The same model writes both, in two calls (skeleton, then narrative), and the second call is checked against the first.
- The split is what makes the rest of the product possible and is not going anywhere: the fact layer is what the judgment contract validates, what the renditions are generated from, what the swap test compares, and what the reading view resolves citations against. **What changed is that nothing outside Anthropic is on the other side of it.**
- **Placeholder locking is retained as a capability, with no current caller.** `src/server/judgment/placeholders.ts` lifts quotations, numbers, confidence values, evidence grades and dates out of prose into `{{Q1}}/{{N1}}/{{G1}}/{{D1}}` tokens and refills them deterministically from a map that never leaves the process. It is the general answer to "how do you hand text to a model to be rewritten without letting it touch the facts inside the text", it round-tripped clean across every real run it ever made, and it is now a **precondition** (CLAUDE.md hard rule #8) rather than a description: any future rewriting pass — a plain-language version, a translation layer, a second attempt at polish — locks first or does not ship.
- The validation chain that guarded the polish (deterministic placeholder/structure checks, then an opus entailment comparison) was removed with it. §1.1a says why, and the finding about that guard is the part worth reading before anyone builds another one.
- ⚠️ Critique note, still standing and now generalized: regex assertions over Chinese-language material ("3次" vs "三次" vs "好几回" — the same count written three different ways) are unreliable. Any check over this product's material asserts structure, never meaning; semantic drift needs a model, and §1.1a records that a model asked to catch semantic drift did not catch it either. A checker that gets believed has to be one that is right.

### 1.1a Removal record: the two-vendor split was tested against its own premise and did not survive it (2026-08-16)

This overturns a decision the rest of this document treated as settled, so the reasoning is recorded here rather than left in a commit message.

**The premise.** The architecture assumed GPT writes more gently than Fable — that a verdict written by a judgment model would read as harsh, and that a second vendor's copy edit was the thing that made it readable. Everything above was built on that: a separate expression layer, a placeholder lock to keep it away from the facts, a three-level validation chain to catch it softening a finding, a circuit breaker, and a 20s budget.

**What the funded round trip measured** (2026-08-14, real key, six runs on a sandbox copy of the real case):
- `gpt-5-mini` changed **0 characters** on one run and **12** on another (four synonym swaps in one section; no adverse finding touched).
- `gpt-4.1-mini`, tested to separate "this model declines to edit" from "the layer is worthless", rewrote all seven sections for ~2.5% shorter text — roughly **80% typography churn** (it collapses spaced em-dashes, which reads *worse* against CJK quotation marks) and, **reproducibly in both runs, deleted the epistemic hedges the document's authority rests on**: "and on the record as it stands that supports reading" → "supporting reading"; "reads as a dispute of standard" → "**is** a dispute of standard", in a section whose own closing line says "not findings of fact".
- The drift was toward **more** certainty, not more comfort — the opposite of the feared direction, and equally a violation.
- **The opus entailment guard passed all of it.** Across six real runs it has never once rejected real GPT output; its only rejection to date was a deliberately-planted stub. A guard that passes hedge-removal is not evidence of safety, and it cost **7× the call it guards** ($0.0333 against ~$0.005) — so **91% of what this "second vendor" layer cost was in fact the first vendor, checking the second one and finding nothing**.
- **The 20s budget was a coin flip**: measured exchanges of 16.5 / 16.8 / 18.4 / 18.5s, with two of four production-budget runs timing out — so the same judgment polished on one run and shipped unpolished on the next. And `POLISH_TIMEOUT_MS` bounded only the OpenAI half; the entailment call ran under no budget at all, making the real added wait 18–21s with no ceiling above it.

**The ruling.** Cut the layer. Not "replace GPT with opus for polishing" (the escape hatch §1.8 and §3.2 left open) — the measurement says the *polish stage itself* does not earn its keep, so moving it to the other vendor would buy a smaller version of the same nothing. The engineering was sound; the value was absent. A layer that changes 0–12 characters when it works, deletes hedges when it works harder, is guarded by a checker that has never caught it, and is nondeterministic in the user's face is not a decoration layer — it is a second vendor, a 12 KB egress per judgment, ~$0.038 and 18–21s of user-facing wait, in exchange for typography.

**What this settles elsewhere in this document.** §1.8's open question ("either do equivalent due diligence on OpenAI's retention policy, or replace GPT polishing with opus and cut the vendor surface to one") and §3's open question 2 are both answered: the vendor surface is one vendor, by removal rather than by substitution, and no OpenAI retention diligence is owed because nothing goes there. §1.9's demand to measure the entailment validator's false-positive rate is superseded by a worse finding — its false-*negative* rate is what mattered, and on real output it was total.

**What was deliberately kept.** Placeholder locking and its tests (§1.1). The `judgment_polish_runs` rows, including the (original, polished, diff) triples of the real GPT runs — they are the audit record of what this product sent to a second vendor and the evidence behind this ruling, and the reading view still renders them on the judgments that carry one. The `llm_calls` / `egress_ledger` rows of those calls, for the same reason: they record a vendor this product used and stopped using. `LLM_PROVIDERS` keeps `"openai"` as a readable value so those rows can be read back honestly.

### 1.2 GPT does not act as a second judge (ruling: cut)
- Neither in the normal path nor on appeal do we **use GPT to produce an independent judgment** — it would send the full pseudonymized evidence set to OpenAI (breaching the privacy gradient) and it induces judge-shopping behavior.
- The fairness mechanism becomes instead: ① pseudonymize everyone before sending to a model (甲/乙); ② after the judgment skeleton is generated, run a **swap test** once (re-judge with the identities swapped, the address-term dictionary swapped with them, on a threshold calibrated on the original case) — what an exceedance *does* is set by the amendment below; ③ appeal = re-hearing at fable effort max + presenting the diff; if a "second opinion" is needed, use opus-4-8 (same organization, same retention boundary).
- Amended 2026-08-17 (docs/05 §B.2): *"The swap test is a publication gate, not an annotation: a responsibility difference above threshold triggers one re-hearing at effort max; a second exceedance publishes the judgment with the responsibility allocation withheld and the swap disagreement disclosed in its place. The case's output level is unaffected (hard rule 2); the gate is enforced in `checkLevelConstraints`/publication validation alongside the numeric-split scan. The swap pass receives the same inputs as the primary pass with identities and address-term dictionary exchanged, and must not receive the primary pass's output."*
- **Why the fairness machinery is this small — the rejected alternatives, recorded (docs/05 §B.1).** Three larger architectures were considered and cut. A **panel of independent verdict emitters** for the responsibility allocation fails on three counts: the vendor surface is Anthropic-only and fable accepts no sampling controls (§1.7), so a "panel" is fable/opus re-rolls differentiated only by persona brief — agent-count theater rather than the cross-family independence that makes multi-model disagreement informative; it costs +2 skeleton-class emissions (≈ +$3.6, ×2.4 on a hearing) for votes that are correlated anyway; and the requirement it claims to serve is already met cheaper, since the A-first and B-first swap runs are two independent emissions of the allocation by construction and the blind advocate pair supplies the opposed readings — four seats already paid for. **Iterated multi-round agent debate** is cut because measurement shows models entrench rather than converge under challenge (apparent consensus is not agreement), so rounds multiply cost with no convergence guarantee; the opposed-brief *structure* is kept and the debate is replaced by independent generation compared in deterministic code. An **LLM entailment/consistency guard** is cut on this repo's own measurement: the opus guard ran six times on real output, caught nothing, passed a reproducible hedge deletion, and cost 7× the call it guarded (§1.1a). Consistency checking therefore stays where it demonstrably works — `checkLevelConstraints`, the citation audit, `findNumericResponsibilitySplits`, and the golden harness.
- GPT across the board does polishing only + a "how the other party will read it" check on the shareable version. **Privacy dividend: OpenAI never touches the raw material, only pseudonymized derived text.**

### 1.3 Tech stack (ruling: TS monolith + encrypted SQLite)
- Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui; drag & drop via dnd-kit (fractional-indexing sort keys); server state via TanStack Query.
- Database: **SQLite + SQLCipher** (whole-database AES-256; master key = the user's passphrase derived through Argon2id, stored in the macOS Keychain), Drizzle ORM (portable to Postgres later). Envelope encryption for files (a DEK per file, which makes cryptographic deletion possible).
- Phase 0: fully local, localhost only; Phase 1 (the counterparty participates): Docker Compose onto a self-hosted VPS + Caddy HTTPS, migrate to Postgres. Do not start on Vercel or a hosted DB.
- Auth: Phase 0, the application passphrase is the SQLCipher unlock; Phase 1, Passkey + invite token (hashed in the DB, single-use, upgradable to a full account).
- Structured output: `output_config.format` json_schema (zod-to-json-schema, additionalProperties:false) + zod.parse re-validation.

### 1.4 Data model skeleton
`cases`(stage state machine, output_level derived and locked by a pure function in code) / `case_participants`(pseudonym, participation_state, invite_token_hash) / `evidence`(source_type, grade_final A-D, **derived_from_evidence_id provenance chain**) / `utterances`(the unit of line-by-line confirmation; is_retold → the render layer forces "as you recall it, they said…", confirm_status) / `events`(occurred_precision, order_key) / `clarification_rounds`(≤3 rounds × 3 questions, counted in code) / `steelman_versions` / `issues`(the three lists) / `adverse_facts`(ack_status) / `judgments`(content = fact_layer jsonb, model, effort, prompt_version, fallback_used) / `judgment_renditions`(self_reflection is never shareable / shareable carries an expiring share_token) / `improvement_contracts` / `followups` / `appeals` / `safety_screens` / `llm_calls`(usage and cost audit) / the egress ledger egress_ledger.

Three hard rules land in the schema/query layer rather than in a prompt:
1. An utterance whose `confirm_status≠confirmed` is already un-citable at the server-side query layer (anti-hallucinated-citation: evidence_refs are validated server-side for existence + confirmed status; an invalid one rejects that generation).
2. `output_level` (L1/L2/L3/refusal) is derived by a pure function over participation_state + evidence composition and locked onto the case, with unit tests; the model only works inside the level it is given.
3. AI-produced content uses one uniform three-field pattern, `ai_draft / human_final / confirm_status` (the ConfirmCard component is reused across transcription rows / steelmanning / the three lists / adverse facts).

### 1.5 Model tiering and cost

**Cost, re-checked against the ledger on 2026-08-16** (after the polish removal, because ~$0.038 per judgment and a vendor's worth of latency had just left and the claim deserved re-testing). The original heading read *"ordinary case ~$3-5, heavy case $8-15, personal monthly usage <$30"*. Measured, from all 26 `llm_calls` rows this product has ever written:

- **An ordinary case measures ~$2.25, not $3-5** — $2.08 counting the cheapest instance of each stage, $2.40 the priciest, ~$2.5-2.8 once the three stages that have never yet executed (timeline extraction, swap test, follow-ups) are allowed for. The judgment itself — skeleton + narrative, one pass — is **$0.91** of that. The $3-5 band is only reached with an appeal: one measured appeal (fable at effort `max` + a fresh narrative) cost **$2.57**, putting case-plus-appeal at ~$4.8. So the old band described a case *with* an appeal and called it ordinary.
- **"Heavy case $8-15" is untested.** Nothing has ever cost that. The largest figure anywhere is the whole ledger — $6.29 across three days — and that includes five skeleton re-runs and four shareable-narrative re-runs of the same case, which is development, not a heavy case.
- **"Monthly <$30" holds** on a case-a-month pattern, but as an inference rather than a measurement: the week that cost $8.9 was development against one case.
- **Removing the polish layer does not move any of this.** The pair cost ~$0.036 per judgment, ~1.6% of a case, and **91% of that was the opus entailment guard rather than OpenAI**. The layer was removed for vendor surface, user-facing latency and complexity; claiming a cost saving for it would be dishonest. Its latency case is the strong one: 20.3s measured, 4.4% of a full hearing but **~12% of the judgment-generation moment the user actually sits through**.
- ⚠️ **What this cannot support.** One case, one real judgment, one sandboxed appeal; most stages are N=1. There is no variance, no median and no band here — the figure above is a single measured point, and it should be re-derived rather than trusted once a second case exists.
- ⚠️ Two things the ledger shows that this table does not yet describe, both unreconciled: the post-judgment documents **ran on fable-5, not the opus-4-8 this table specifies** (opus is exactly half the rate, so the table's own tiering would have saved $0.31/case — about 9× the polish saving), and **prompt caching has never been exercised** — `cache_read_input_tokens` is 0 on all 26 rows, so §1.6's "saves 50-70% of input cost" is entirely unrealized, and since input is only 23.5% of spend its real ceiling is ~12-16% of a case.

| Stage | Model | effort | Notes |
|---|---|---|---|
| Safety screening | local keyword rules + opus-4-8 per item (high recall); one whole-case fable review before judgment | low | Crisis-referral information must be a deterministic, non-LLM path |
| OCR / speech transcription | **local**: macOS Vision / whisper.cpp | — | Ruling: media does not go to the cloud (screenshots contain real names/avatars and would bypass pseudonymization); cloud vision only as a fallback, one image at a time, after preview redaction and explicit consent |
| Evidence grading | **code rules** derived from source_type + opus-4-8 anomaly detection | low | Ruling: the main grading engine is deterministic rules; the LLM only looks for anomalies of the "this screenshot's content is actually an AI session, downgrade to C" kind |
| Timeline extraction | opus-4-8 | medium | Final ordering authority stays with the user's drag & drop |
| Plain-speech translator | **opus-4-8 by default**, a "deep reading" button upgrades to fable | medium | A high-frequency, low-unit-price entry point; fable's latency/cost is mismatched here; the three readings are enforced by schema |
| Clarification questions + steelmanning | fable-5 | high | The highest judgment density in the whole pipeline |
| Issue fixing + adverse facts | fable-5 (can be merged into a single call) | high | Every item carries evidence_refs |
| Judgment skeleton + narrative | fable-5 | xhigh | streaming, max_tokens≥32K; skeleton first (it drives the adverse-fact pre-acknowledgment UI and is the comparison object for the swap test) |
| swap test | fable-5 | medium | Once per case, no cache hit, billed at the cold price |
| Post-judgment documents (dual version / contract / repair script) | opus-4-8, converted from fact_layer | medium | Ruling: this is conversion, not adjudication; but it **still goes through placeholders + entailment validation** — switching to opus does not exempt it |
| Follow-ups | opus-4-8 via **Batches** (half price) | low | Naturally asynchronous |
| Appeal | fable-5 | max | Reuses the cache prefix, ≈ one more judgment, $1-3 |

There is no polish row and no polish-validation row. Both stages were removed on 2026-08-16 (§1.1a), which makes this table the whole of the product's model spend and Anthropic the whole of its vendor surface.

### 1.6 Prompt caching (saves 50-70% of input cost)
- Request structure: [frozen "constitution" system prompt (the full adjudication rules, ≥2048 tok, zero interpolation: no dates, no IDs)] → [the confirmed + pseudonymized evidence base, append-only, stably serialized in ID order] → cache_control breakpoint (ephemeral ttl:1h) → [this round's volatile content].
- Ruling: caching the pseudonymized evidence base is allowed (banning caching does not shrink the exposure surface, it merely doubles the cost); prefix discipline = the prefix must never contain real names or un-scrubbed content.
- Unconfirmed material goes after the breakpoint; opus's small calls do not carry the whole-base prefix (falling under its 4096 minimum threshold does not matter).
- Health check: from the 2nd fable call onward on the same case, assert `usage.cache_read_input_tokens>0` and alarm if it is 0; CI runs a byte-stability test on the serializer.

### 1.7 Reliability
- All fable calls: `betas:["server-side-fallback-2026-06-01"] + fallbacks:[{model:"claude-opus-4-8"}]`; always check `stop_reason=="refusal"` before reading content. A refusal across the whole chain → the product's "refusal + referral" exit (with this subject matter, refusal is an inevitable path, not an edge case); a mid-stream refusal discards the half-finished output. The UI strictly separates the two kinds of copy: "technical degradation" vs. "red-flag refusal + referral".
- ⚠️ **sticky routing** (the compound failure the critique caught): for roughly 1h after a fallback, non-streaming requests with the same prefix are silently routed to opus without a fallback block — **every call must check the `fallback_message` inside `usage.iterations`**; fallback_used is persisted, and the judgment page discloses "which model issued this judgment".
- **Judgment presentation gating** (ruling): streaming is used for progress only — stream `display:"summarized"` thinking summaries to the front end to render the "hearing in progress" panel + stage heartbeats; the judgment body is buffered, persisted, and **published in one shot** after it passes validation. Do not live-broadcast an unvalidated verdict to an emotionally fragile user.
- **Judgment version freeze**: fable has no sampling controls and thinking is always on → re-running the same input = a different judgment. Once a judgment is final it is frozen; any regeneration becomes version+1 and must explicitly disclose the differences to the user. Record a model snapshot; if the model has changed by the time of an appeal, that must be disclosed.
- Idempotency: memoize each step on (case_id, stage, canonical_input_hash); stage checkpoints keep the blast radius to a single stage. Timeout budgets: screening 30s / grading 60s / clarification 5min / judgment 15min; 60s with no stream event = judge the stream dead and restart that stage.
- Single-machine jobs: no Celery; a SQLite jobs table + asyncio/background tasks + SSE. **The Phase-0 scheduled-job problem** (critique): follow-ups / TTL deletion / backup rotation / token expiry all depend on a resident process, and closing the laptop lid kills it — use launchd timers + catch-up execution at application startup, otherwise the post-judgment loop and the privacy TTL die silently.

### 1.8 Privacy and security
- **Pseudonymization gateway** (a mandatory checkpoint on every LLM egress; local deterministic code; using a cloud LLM to de-identify is banned): at material registration, registering the person table is mandatory (real name / all nickname variants → 甲/乙/FRIEND_1); regex-scrub phone numbers, WeChat IDs, addresses and the like; the mapping table never leaves the machine (consider keeping it memory-resident only / behind its own passphrase). **Timing of confirmation** (ruling): moved earlier, into the line-by-line utterance confirmation stage — what the user confirms is already the pseudonymized form; from then on the pipeline passes material through automatically and only writes the ledger. A new person who has not been registered = a blocking validation failure.
- **Egress ledger**: every call records target / model / payload sha256 / 30-day expiry date, hash-chained against tampering; plus a "current exposure window" view. **This covers OpenAI too** (critique: either do equivalent due diligence on OpenAI's retention policy, or — after a blind test — replace GPT polishing with opus and cut the vendor surface down to a single vendor; left as an open question).
- 30-day retention (a hard fable requirement; ZDR returns 400): confirm the organization's retention configuration before launch; state it explicitly in the privacy notice.
- **Deletion channel**: case-level total destruction = delete the raw material + derivatives + destroy the DEK (cryptographic deletion inside backups) + delete the pseudonym mapping + tombstone; backup rotation ≤30 days guarantees the deletion propagates. **Audit side-channels are inside the same encryption domain** (critique): the diff triples / llm_calls / the ledger / review.json / logs are all sensitive copies; logs contain no payload plaintext by default.
- TTL: raw evidence is deleted 90 days after the case closes (explicitly renewable); C/D-grade material is deleted as soon as the case closes; judgments are retained long-term but only in the code-named version. Raw voice files get a short TTL once transcription is confirmed (open question: 7 days?).
- Shareable-version gate: a hit on a real name or a variant blocks it; verbatim quotes longer than 15 characters must be paraphrased (anti-fingerprinting); strip metadata + watermark; no one-click share; exports are audited. The self-reflection version can never be exported.
- Prompt injection (OCR'd screenshot text may contain instructions; an adversarial party may forge evidence): evidence enters the prompt as data fields + an "untrusted data" declaration; the judgment pipeline has no side effects (pure JSON out, no tools attached); instruction-like text is highlighted in the confirmation UI; an opus integrity check before judgment; output is sanitized against XSS.
- **Evidence one-sidedness** (critique): none of the fairness mechanisms work against selective submission — the judgment schema gains a mandatory "evidence one-sidedness / completeness statement" field, presented to both parties in L1/L2 outputs.
- consent is an event, not a status bit (supports withdrawal + audit); on withdrawal, an in-flight judgment aborts and a published judgment is marked void (the state machine must cover this branch).

### 1.9 Evaluation system (critique: entirely absent, must be added)
- A golden case set (starting from the original case + constructed cases); a prompt_version change triggers a regression run; swap-test threshold calibration; measuring the impact of fallback degradation on judgment quality; measuring the entailment validator's false-positive rate. The product's core promise is "fairness"; zero measurement = zero promise.

## 2. Delivery roadmap

- **M0 data foundation** (do this first): schema + SQLCipher + seed import script (80% of the existing markdown parses deterministically: the 00-index table / the E1-E11 event table; free text is extracted with opus → review.json for human review) + pseudonymization gateway + llm_calls/ledger.
- **M1 translator** (minimum usable product): a standalone lightweight feature, opus by default + a fable upgrade button, three readings enforced by schema; a warm-up for the LLM gateway layer (fallback / refusal / structured output / caching all converge in this layer).
- **M2 collection pipeline**: screenshot upload → local OCR → side-by-side line-by-line confirmation workbench → evidence grading (rules + anomaly detection) → timeline drag & drop.
- **M3 adjudication pipeline**: safety screening → clarification-loop FSM → steelmanning → the three issue lists → adverse-fact pre-acknowledgment → judgment skeleton + narrative (streaming progress panel + gated publication) → swap test → GPT polish + validation → dual-version presentation.
- **M4 post-judgment loop**: improvement contract / repair script / follow-ups (Batches + launchd) / appeal / share gate.
- **M5 two-person version**: invite token → self-hosted VPS → Postgres → row-level visibility + consent events.

## 3. Open questions for the user to settle

1. **The counterparty (甲)'s informed consent** (the ethical baseline; both the critique and the privacy perspective rank it first): the existing material is processed by this system and sent to LLMs — does she know? Recommend settling this before the first line of code is written; at the two-account stage, give her a "transparency view" + deletion rights.
2. The GPT polishing model and budget; or, after a blind test, simply use opus-4-8 for polishing and cut the vendor surface down to one.
3. Final deployment preference: Phase 1 self-hosted VPS (recommended), or accepting cloud hosting.
4. Retention policy for the raw screenshots/voice (their value for confrontation on appeal vs. privacy).
5. Follow-up delivery channel: is an in-app to-do enough, or is email/push needed?
6. The quality difference between judgment xhigh and high: decide after one A/B run on a real case (about $2).
