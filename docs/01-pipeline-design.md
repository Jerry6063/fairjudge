# Input → Judgment → Improvement: Intermediate-Stage Design v1

Source: 4 independent expert perspectives (procedural justice / couples counseling / elicitation UX /
adversarial ethics) + 1 round of completeness critique, 2026-07-17.
Full original analysis: workflow output archived at tasks/wi8egs92o.output.

## Core conclusion

**The clarification / counter-questioning stage is not a "supplement" — it is the precondition for the system standing up at all.**
Without it, the system's default state = rubber-stamping bias in the name of a "fair Judge", on material that was filtered by one party and often reinforced by another AI acting as a mirror.
But counter-questioning is itself a source of risk (leading questions contaminate memory, interrogation causes secondary harm, an over-heavy process drives users away), so the stages must be "few and right", not "many and exhaustive".

## Pipeline overview (9 stages)

```
Input (text / voice / image)
  ↓
① Intake positioning + safety screening (a gate, not a stage)
② Material registration + evidence grading (A first-hand / B retold from memory / C AI-processed / D mass-market emotional content)
③ Transcription and speaker confirmation (line-by-line confirmation, speaker, three-way tone choice, follow-up on truncation)
④ Timeline reconstruction (drag-and-drop confirmation cards; ask only about gaps and contradictions)
⑤ Clarification loop + steelmanning the other party's position (system generates their strongest version → user confirms / rebuts)
⑥ Counterparty invitation and participation state settled (participating / written response / refused / unaware — must be settled before judgment)
⑦ Issue fixing (three lists: undisputed facts / disputes of fact / disputes of standard)
⑧ Pre-judgment confrontation: adverse-fact pre-acknowledgment + evidence-map sign-off
  ↓
⑨ Judgment output (graded: full judgment / one-sided perspective analysis / narrative analysis / refusal + referral)
  ↓
Post-judgment: dual-version output → improvement contract → repair-conversation script → 7/30-day follow-up → appeal channel
```

## Mandatory pre-judgment question list (by priority, merging all four perspectives)

1. **Safety gate** (before everything else): Has there been any moment in this relationship where you were afraid, threatened, monitored, or did not dare to say "no"? → A hit exits the adjudication frame entirely: referral to resources only, and never an output saying "both parties share responsibility".
2. **Winning-vs-fairness litmus test**: If the conclusion says your share of responsibility is the larger one, do you still want this judgment? What do you plan to do with the result (self-reflection / show it to the other party / get a third party to take your side)?
3. **Informed probe**: Does the other party know this material has been submitted? Would they agree to it?
4. **Evidence completeness**: Is this a verbatim record or a retelling from memory? What context did the screenshot crop out? **Is there any record unfavorable to you that you did not submit?**
5. **AI-material decontamination**: In this AI-session screenshot, which parts are facts you told it, and which are characterizations it made on your behalf? What was the original wording of your own opening question?
6. **Tone layering**: What was the tone of this line at the time — serious / weary / joking / passive-aggressive? (Literal content = fact layer, tone = claim layer; they must be recorded separately.)
7. **Timeline**: What was the real order of events? What happened during the blank periods? Is this the first time, or the Nth instance of the same pattern, and how did it end before?
8. **Steelmanning** (inability to answer is itself a downgrade signal): Tell this story in the other party's voice; what do they feel most wronged about, and what is the one point they would most likely use to rebut you? What might they have been afraid of, or protecting, at the time?
9. **Your own contribution**: Is there any part of this — even 10% — where you afterwards think "the way I said/did that hurt them too"?
10. **Need reconstruction**: Behind a conclusion like "they don't care about me", which specific behavior in which specific incident is it? What need of yours actually went unmet? What specifically do you want them to do next time?

## Stopping criteria (when is it enough to judge)

- Safety screening passed (precondition).
- Issues are fixed and the user has confirmed a one-sentence statement of "what is being judged this time".
- Every fact node supporting a conclusion: has A-grade evidence, or confirmed B-grade + a confidence label, or is marked "doubtful" and excluded from attribution of responsibility.
- The timeline has been confirmed segment by segment; nodes whose ordering is doubtful take no part in "who escalated first" style attribution.
- The counterparty participation state has settled into one of the four states (participating / written response / explicit refusal / unreachable); issuing a judgment while it is still open is not allowed.
- The steelmanning stage produced substantive content and the user agrees "the other party would probably say roughly this".
- Adverse-fact pre-acknowledgment is complete.
- Diminishing returns: two consecutive clarification rounds with no new information = saturation.
- Hard budget: clarification ≤3 rounds, ≤3 questions per round; when the budget is spent, grade and output on the information at hand — never interrogate indefinitely.

## Output grading (downgrading is honesty, not failure)

| Level | Condition | Output |
|------|------|------|
| L1 Full judgment | Both parties participate, or one party + sufficient first-hand evidence + steelmanning meets the bar | Two-way responsibility + both parties' needs + improvement contract |
| L2 One-sided perspective analysis | One party only, but with first-hand evidence | Prominently labeled "only one side heard"; evaluates only the part the client controls; no characterization of the absent party |
| L3 Narrative analysis / clarification mode | Predominantly C-grade (AI-processed) material | Refuses factual characterization; analyzes only "how you narrate this" + a list of material to supply |
| Refusal + referral | See below | States the category reason + professional resources, leaving no room for negotiation |

**Mandatory refusal (not a downgrade)**: ① domestic violence / coercive control / stalking red flags; ② self-harm or harm-to-others risk; ③ use for litigation / custody / gathering evidence for a police report; ④ disputes involving sexual consent or minors; ⑤ the other party explicitly objects to their material being used; ⑥ judgment shopping (resubmitting the same incident over and over to reroll the conclusion); ⑦ pure value disagreements (whether to have children, spending philosophy, etc. — communication guidance only, no ruling on right and wrong).

**General downgrade rules**: never output responsibility percentages or win/lose wording; unverifiable retellings are always written as "as you recall it, they said…"; the absent party is never subjected to motive inference or character characterization; every downgrade carries an "upgrade list" (what is missing, and which level it would reach once supplied).

## Post-judgment stages (where "guided improvement" actually lands; the critique round identified this as a collective blind spot)

1. **Post-judgment explanation**: every conclusion carries an evidence grade + confidence, presented in three tiers: "high confidence / inferred / unknown".
2. **Dual-version output (the core anti-weaponization mechanism)**: self-reflection version (contains the criticism directed at the client, visible only to them) / shareable version (no win-lose language, ends by inviting a conversation, mandatory embedded entry point for the other party's response, carries a non-removable "one-sided material only" label, laid out so it cannot be screenshot-quoted in isolation).
3. **24–48h cool-down buffer**: before sharing, ask once more "what do you want the other party to feel after reading this" — if the answer is "make them realize they were wrong", warn that this triggers defensiveness rather than change.
4. **Improvement contract**: 1–3 specific, positively framed, observable behavioral commitments per party, executable within 7 days (NVC standard: a request, not a demand); rejects empty phrases of the "communicate more, be more understanding" kind; includes a "what to do the next time it is triggered" script.
5. **Repair-conversation script**: a gentle-startup opening line + a derailment first-aid kit (a pause signal, a physiological-flooding self-check, a mandatory "come back within 20 minutes" rule).
6. **7/30-day follow-up**: asks only about behavior, never for a replay of feelings; includes "did you notice — and say out loud — the moments the other party got it right".
7. **Appeal channel** (*amended 2026-08-17 per docs/05 §A.1*): new evidence submitted within a time limit can trigger a partial re-hearing (once only, to prevent judgment rerolling); a supplementary statement from the absent party at any time makes a re-hearing **available** and both parties are told so. The re-hearing is **offered, never auto-fired** — a hearing both people will read has to be an act someone chose, filed through the per-actor appeal machinery. And it **voids nothing**: under hard rule 6 the original one-sided analysis stands frozen as version 1, superseded rather than erased, with the diff between the versions and the model that produced each disclosed.
8. **Dependency monitoring**: a third submission of the same pattern → warn that "the system is substituting for your direct communication with each other", refer to a human counselor; every output ends with the same fixed line: "The next step is a conversation between the two of you, not another judgment from me."

## Design conflicts already settled (found in the critique round; decided here)

1. **Repair first, attribution second**: the judge's output must structurally land on the behavioral layer (the improvement contract); assigning responsibility is an intermediate product, not the endpoint.
2. **Process completeness vs. churn**: a layered product — the translator is usable instantly with zero onboarding (deliver value before asking questions); adjudication features unlock progressively; clarification questions are ranked by "marginal impact on the conclusion", and those that do not fit the budget are dropped automatically and labeled as dropped.
3. **"Accepting an unfavorable judgment" is not set as a gate**, only as a probe: the answer shapes the output form (clearly only wants to win → give translation and organizing only, no ruling), it does not block service.
4. **Inviting the other party is offered by default but not pushed by default**: sending an invitation is forbidden before safety screening passes (to avoid tipping off an abuser); the invitation copy is a neutral summary generated by the system, and the first screen the other party sees is the steelmanned version of their own position, not a verdict.
5. **Draft confirmation vs. memory anchoring**: where a first-hand record exists, use draft confirmation (low burden); reconstruction from pure memory must use open-ended questions (to prevent contamination), even at the cost of being slower.
6. **Form of the safety screening**: at the entrance, low-friction behavior-description questions embedded in the intake conversation, plus passive red-flag detection throughout that triggers follow-up questions; not a first-screen questionnaire.

## Unresolved; must be closed before this becomes a product

- **Evidence authenticity**: all grading currently defaults to "screenshot = real", while the cost of forgery approaches zero. Minimum bar: state explicitly in the output that "authenticity has not been technically verified"; require context continuity for key A-grade evidence (N messages before and after); a single isolated screenshot may not support attribution of responsibility on its own.
- **The absent party's data rights**: a minimum retention period, one-click deletion, a channel for after-the-fact notification and deletion requests, de-identification in outputs.
- **Isolation between the translator and the Judge**: translator output is forced to be multi-valent (benign / neutral / negative readings + confidence) and never automatically flows back into the Judge's fact base as evidence.
- **System self-audit**: periodically re-run the same case with genders/positions swapped to test for bias; monitor "client win rate" — significantly high = systematic-favoritism alarm; iterate on the actual reconciliation rate measured at follow-up, not on instant satisfaction (satisfaction rewards favoritism).
