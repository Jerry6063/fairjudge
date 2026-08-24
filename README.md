# fairjudge

A single-party conflict-judgment pipeline: one person files a conflict record —
screenshots, recollections, retold lines — and receives a bounded, evidence-grounded
judgment that says out loud what its record cannot support.

- **Role-separated model stages** — analyst, expression, and verifier agents with
  disjoint prompts; each stage sees only what its job needs, and every model call is
  ledgered.
- **A nine-stage state machine owned by code** — stages advance on database facts
  (confirmed lines, settled participation, acknowledged adverse facts), never on
  anything a model says.
- **Refusal by design** — output levels are derived from the shape of the record;
  one-sided records are capped and labelled, unsafe cases are refused with referrals,
  and exports pass hard gates (quote attribution, counterparty address, PII scrubbing).
- **Local-first** — SQLite (SQLCipher) via drizzle; no case data lives in this
  repository. All fixtures are authored fiction.

Next.js + TypeScript; ~1,100 tests (vitest).
