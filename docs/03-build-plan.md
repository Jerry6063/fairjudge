# Build Plan v1 (2026-07-17)

## Spec strategy: no traditional PRD; three lightweight specs instead

The reasoning: a PRD's core job is "get everyone aligned on what to build and prevent execution drift". In this project:
- The product rules are already in [01-pipeline-design.md](01-pipeline-design.md) (nine stages, evidence grading, output grading, post-judgment loop — that *is* the product spec)
- The engineering decisions are already in [02-engineering-architecture.md](02-engineering-architecture.md) (tech stack, model tiering, privacy boundaries — that *is* the technical spec)
- The rest of a traditional PRD (personas, market analysis, KPI tree, full wireframes) is pure ceremony for a single-user, real-need project. Cut.

But vibe coding ≠ no spec. The drift risk is real (especially for principles like "hard rules must land in the code layer, not in a prompt", which are the easiest to violate for convenience while writing code). Three lightweight specs catch it:

1. **`SPEC.md` (living document, repo root)**: only the current milestone's scope + acceptance checklist ("what you can click, what is forbidden"), within one screen. Updated as soon as a milestone completes. It is the starting baseline for every vibe-coding session.
2. **The repo's `CLAUDE.md`**: the conventions for pairing with AI — tech stack, directory structure, **the hard-rules list** (unconfirmed material is not citable / output level derived in code / the pseudonymization gateway is mandatory / judgments are frozen… each one labeled with which layer it lives in). This binds tighter than a PRD, because it is read in every session.
3. **golden cases (an executable spec)**: turn the original case into an evaluation set. The spec for judgment quality cannot be written down in prose; it can only be anchored by "this is how this case should come out". Established before M3.

## Milestone plan

Each milestone = one or a few vibe-coding sessions. Rhythm: update the SPEC milestone section → write code → run the acceptance checklist → update SPEC.

### M0 Repository and data foundation
Deliverables:
- New repository (separate from the data folder; name TBD, placeholder `fairjudge/`), Next.js 15 + TS + Drizzle + SQLite
- The full schema (cases/participants/evidence/utterances/events/…/llm_calls/egress_ledger)
- Seed import script: existing markdown → DB (mostly deterministic parsing; the 00-index table + the E1-E11 event table; skip the free-text part for now, no rush to fall back to an LLM)
- Pseudonymization gateway module (dictionary + regex, pure functions, round-trip unit tests)
- The repo's CLAUDE.md + the first version of SPEC.md

Acceptance: after `pnpm seed:import`, the DB contains 14 evidence rows (with grades) + 11 events + a number of utterances (is_retold correct); the pseudonymization round-trip test is green; `git log` is clean.

Simplification decision: M0 uses plain SQLite (macOS FileVault already provides encryption at rest, and the existing markdown is already sitting on disk in plaintext); SQLCipher + envelope encryption is listed as a prerequisite of M2, to be completed before large amounts of new sensitive material enter the DB.

### M1 LLM gateway + plain-speech translator (the first usable feature)
Deliverables:
- `src/server/llm/` gateway: stageRegistry, the fable call wrapper (fallback beta + refusal check + sticky-routing detection + banned parameters), structured output (zod), llm_calls/ledger persistence, cost calculation
- Plain-speech translator page: input one sentence → opus-4-8 three readings + confidence (schema-enforced) → three-column cards; a "deep reading" button upgrades to fable; GPT polishing deferred (done together in M3, to avoid standing up two vendors too early)

Acceptance: translating a real quoted line from the record (an everyday remark, e.g. 「订好了不就直接说了？」) produces three readings; pulling the network cable or using a wrong key gets the error swallowed by the gateway and turned into a plain-language message; the llm_calls table has a complete usage record; a unit test asserts that fable calls carry the fallbacks parameter.

### M2 Collection pipeline
Deliverables: screenshot upload (sha256 dedupe, strip EXIF) → local OCR (macOS Vision; called from Node via a swift script or an `osascript`/`shortcuts` approach — the first technical validation point of M2) → side-by-side line-by-line confirmation workbench (ConfirmCard component) → evidence grading (source_type rule derivation + opus anomaly detection) → timeline drag & drop (dnd-kit + fractional-indexing). The SQLCipher switch is completed in this milestone.
Acceptance: run the 14 real screenshots through the full flow again and produce confirmed utterances identical to the current hand transcription; unconfirmed rows are invisible to any downstream query (server-side test).

### M3 Adjudication pipeline (the core)
Deliverables: safety screening (local rules + opus) → clarification-loop FSM (≤3×3 enforced in code) → steelmanning → the three issue lists → adverse-fact pre-acknowledgment → judgment (skeleton + narrative, xhigh streaming, "hearing in progress" panel, gated publication) → swap test → GPT polish + opus entailment validation + placeholder locking → dual-version presentation → judgment freezing and versioning. The golden-cases evaluation script is established alongside this milestone.
Acceptance: run a real case and produce the first L2 one-sided perspective analysis (the current material only supports L2 — which itself verifies that output-level derivation is correct); the swap test runs end to end and produces a difference report; the polish-validation fallback path has tests.

### M4 Post-judgment loop
Deliverables: improvement contract, repair-conversation script, 7/30-day follow-ups (Batches + launchd timer + startup catch-up), appeal channel, shareable-version gate (real-name scan + quote-length limit + watermark).
Acceptance: a follow-up still fires via catch-up at the next startup after the laptop was closed overnight; a shareable version containing a real-name variant is blocked.

### M5 Two-person version (starts once the counterparty participates)
Invite token → self-hosted VPS + Postgres migration → row-level visibility + consent events + transparency view and deletion rights.
Prerequisite: the counterparty's informed consent.

## What must be decided now (only 2 of these block M0)

1. **Repository name and location**: recommend `/Users/jerryhao/Dailywork/fairjudge` (a separate git repo, keeping the relationship-analysis data folder pure data). The name is yours to change.
2. **API key**: M1 needs an Anthropic key (via `ant auth` or env); the OpenAI key is not needed until M3.
3. (Not blocking, but recommended as early as possible) the counterparty's informed consent — see section 3 of doc 02.

## Session working conventions

- Start each session by reading the current milestone section of SPEC.md; update it before stopping (tick off completed items, record new decisions).
- Architecture-level changes (overturning a decision in doc 02) require an explicit statement of the reasoning plus a doc update; never drift silently in the code.
- A hard-rule violation (e.g. a prompt containing something like "do not cite unconfirmed material" — a constraint that belongs in the code layer) counts as a bug at code review.
