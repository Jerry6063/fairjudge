# fairjudge

A "plain-speech translator + fair judge" for intimate-relationship conflicts. Single-user
to start, architected to grow into both parties logging in.

- Product spec: `../relationship-analysis/analysis/01-pipeline-design.md`
- Engineering spec: `../relationship-analysis/analysis/02-engineering-architecture.md`
- Build plan: `../relationship-analysis/analysis/03-build-plan.md`
- Current milestone scope + acceptance: `SPEC.md` (read before you start, update before you stop)

## Language policy

**Everything in this repository is English** — code, comments, tests, commit messages,
docs, SPEC.md, prompt templates, and all product UI copy. Model output shown to the
user is English too.

**Exception: case evidence keeps its original language.** Screenshots, OCR text,
utterance content and quoted statements are verbatim records — never translated, never
normalized. A prompt written in English may analyze Chinese evidence and report in
English; it may not rewrite the evidence.

## Stack (decided — do not change)

Next.js 15 (App Router) + TypeScript strict + Tailwind. SQLite via
`better-sqlite3` (npm alias → `better-sqlite3-multiple-ciphers`, SQLCipher-encrypted)
+ Drizzle ORM. Tests: vitest. Package manager: npm. Drag & drop: dnd-kit +
fractional-indexing. LLMs: Anthropic only — `claude-fable-5` (judgment) /
`claude-opus-4-8` (support). The second vendor (OpenAI, polish) was removed on
2026-08-16; see doc 02 §1.1a. Structured output: zod → json_schema
(`output_config.format`), re-validated with `zod.parse` on the way back.

## Hard rules (each names the layer it lives in; if it shows up in a prompt instead of code, that's a bug)

1. **Unconfirmed material is not citable** — query layer: utterances whose
   `confirm_status` is not `confirmed`/`edited` are invisible to server-side fetch
   functions; `evidence_refs` returned by a model are validated server-side for
   existence and confirmed status, and an invalid reference rejects that generation.
2. **Output level (L1/L2/L3/refused) is derived in code** — pure function
   `deriveOutputLevel(participationState, evidenceProfile, safety)`, locked onto the
   case, unit-tested. The model only works inside the level it is given.
3. **The pseudonymization gateway is a mandatory checkpoint on every LLM egress** —
   `src/server/pseudonym/`: deterministic dictionary (longest-match + variants) plus
   regex PII scrubbing, local pure functions. The mapping table never leaves the
   machine. An unregistered person name blocks egress.
4. **Clarification: ≤3 rounds × ≤3 questions** — enforced by a server-side FSM counter;
   schema `maxItems: 3` is only a backstop.
5. **`is_retold = true` quotes render as "as you recall it, they said…"** — enforced in
   the render layer, not left to the model.
6. **A final judgment is frozen** — any regeneration becomes `version + 1` and must
   disclose the diff and which model produced it.
7. **Fable calls go through `src/server/llm/` only** — with
   `betas: ["server-side-fallback-2026-06-01"]` + `fallbacks: [{model: "claude-opus-4-8"}]`;
   never send `temperature`/`top_p`/`top_k`, never prefill, omit `thinking` on fable;
   check `stop_reason === "refusal"` before reading content; inspect
   `usage.iterations` for `fallback_message` (sticky-routing detection) and persist
   `fallback_used`; every call writes `llm_calls` + `egress_ledger`.
8. **Any layer that rewrites the judgment's prose gets the surface layer with the facts
   locked out of it** — render layer + `src/server/judgment/placeholders.ts`: quotes,
   numbers, confidences, grades and dates are lifted into `{{Q1}}`-style tokens before
   egress and refilled deterministically from a map that never leaves the process, so
   the facts are physically absent from the request rather than protected by asking the
   model nicely. Such a layer is best-effort by construction: it may only change wording,
   its failure ships the original, and it never sits between the hearing and publication.
   **There is no such layer today** — the GPT polish pass was removed on 2026-08-16 (doc
   02 §1.1a) — so this rule is a precondition on adding one, not a description of the
   running system. Do not build a rewriting pass that skips the lock.
9. **Crisis referral is a deterministic path, never a model call** — when a safety red
   flag fires, hotline/resource information renders with zero latency and no LLM in the loop.

## Verification rule (added 2026-08-12, after a real incident)

**End-to-end verification never runs against `data/fairjudge.db`.** Copy it to a temp path, point
`FAIRJUDGE_DB_PATH` at the copy, and run there. On 2026-08-12 an acceptance agent, following a task
book that said "run it on the real case", wrote three fabricated *confirmed* utterances attributed
to the real counterparty into the live record, recorded consent events for a person who has never
consented, and relocked the case to L1 on that basis. It marked them as fixtures in four places and
that was still not enough: confirmed material is citable material, and a case record about a real
person is not a test fixture. Restored from backup; snapshot kept at `data/contaminated-snapshot-*`.

## Conventions

- **The codebase knows no case.** Neither real people's names nor their actual words
  appear in code, comments, tests, docs, or SPEC — cases are data in the local DB, and
  every example, fixture and sample is invented. A real utterance is evidence; evidence
  belongs in the record, never in a repository.
- AI-produced content uses the same three fields everywhere: `ai_draft` /
  `human_final` / `confirm_status`.
- Event ordering uses fractional-indexing `order_key` (text), never integer re-numbering.
- JSON serialized into a prompt must be byte-stable (sorted by id, no timestamps or
  random values) — prompt-cache prefix discipline.
- Architectural deviations (overturning a decision in doc 02) must update the doc with
  the reasoning first; never drift silently in code.
- `../relationship-analysis/` is read-only input. This repo never writes to it and no
  tracked file reads it — a case reaches the product through the intake commands, not
  through a path baked into the source.
