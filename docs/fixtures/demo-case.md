# Demo case — "the someday account"

**Everything in this file is invented.** Adrian and Yiwen do not exist; neither does the co-op,
the account, or the argument. The file exists because the product's own consent architecture
forbids showing the case it was built for (doc 04 §6.2), so the showcase runs on an authored
fiction instead — and an authored fiction has to be written, not sampled.

This document is the **source of truth for the fixture**. `scripts/seed-fixture.ts` carries the
record below into a database byte-exact: once authored, evidence content is a verbatim record and
is never re-worded, re-punctuated or translated on the way in (CLAUDE.md, language policy).

Staged in three acts (doc 04 §6.3, doc 05 §C amendment 6):

| Act | Record | Level | Status |
|---|---|---|---|
| **I — alone** | Adrian's material only | **L2** | seeded + run for real (`data/fairjudge-demo.db`) |
| **II — she answers** | invite → decline branch → consent → her statement → her confirmations | L2 held | authored here, staged in `demo-runbook.md` |
| **III — re-heard** | both parties own confirmed material | **L1, v2** | authored here, staged in `demo-runbook.md` |

---

## 1. Why this conflict and not another one

The fixture has one hard engineering requirement — in Act I the client must have **zero** citable
utterances of his own — and one hard quality requirement: it has to read like an argument between
two people who love each other.

Those meet in a single true observation: **nobody screenshots themselves.** People screenshot the
other person, because what they are preserving is proof of what *they* were told. So a case built
out of one person's screenshots is, structurally, a case in which only the other person speaks —
and the client discovers this about his own submission only when the product counts it for him.

Everything else is chosen to keep both sides genuinely arguable. He is not a villain; she is not a
saint; the money is not the injury. The argument is about **who gets to be surprised**, and it has
a real answer on each side.

Deliberately *not* about: door keys, driving lessons, or cohabitation/immigration logistics.

---

## 2. Personas

### Adrian — the client (initiator, submitter, pseudonym 乙)

Thirty-four, a structural engineer at a mid-size firm in Toronto, the kind of person who solves
affection by building something. He and Yiwen have been together four years and have talked about
"doing something together" since the second one — a market stall, a studio, a two-person anything.
Every version of that conversation ended with *let's talk about it later*, and after two years he
stopped hearing patience in that phrase and started hearing a no delivered slowly. He is not
careless with money; he is careless with process, and he has never had to notice the difference,
because his family's way of loving people is to present them with the finished thing.

He filed this case eleven days after the fight, at 01:40 on a weeknight, from a folder of
screenshots he had been quietly accumulating since April. He answered the intake question — *what
do you want from this* — with **"I want to know whose fault it was."** He believes he already
knows, and he expects the machine to confirm it. He has never once said the sentence *I should
have asked you.*

### Yiwen — the counterparty (respondent, pseudonym 甲)

Thirty-two, a hospital pharmacist, in Toronto since a master's degree six years ago; she thinks in
English at work and in Chinese when she is hurt, which is why the record switches script exactly
where it matters. She is the saver of the two — roughly sixty percent of the joint account is hers
— and she is aware that being the careful one has slowly turned into being the one who says no,
which she resents partly because it is true.

What she is angry about is not two thousand four hundred dollars. It is the shape of the thing:
the decision was made in March, disclosed to friends before her, and delivered at a dinner table
with an audience, at the exact moment refusing it would have made her the person who ruined a
surprise. She does not want the money back. She wants him to say what he did, in one sentence,
without the word *us* in it.

**In Act I she does not know this case exists.** That is not a plot device; it is state 1 of the
two-party loop (doc 05 §A.1, DRAFTED), and it is what the level derivation is looking at.

---

## 3. The record (Act I)

Seven pieces of material, all submitted and owned by Adrian, all `visibility = private` — his own
material, in the case he brought, not shared with her (doc 05 §A.3).

Grades are derived by code from what the artifact *is* (`src/server/domain/grading.ts`), never from
how useful it would be:

| id | date | what it is | registration | source_type | grade | why |
|---|---|---|---|---|---|---|
| **EV-1** | 2026-04-25 | Screenshots of her messages the night of the anniversary dinner, captured one at a time as they arrived | `screenshot` | `firsthand` | **A** | unaltered capture of an original record |
| **EV-2** | 2026-04-26 | Screenshot of the auto-transcripts of two voice messages she sent (1:47 and 3:12) | `ai_session` | `ai_processed` | **C** | a machine's rendering of speech, not the speech |
| **EV-3** | 2026-05-02 | Screenshot of a note she wrote in their shared notes app, titled "before we talk again" | `screenshot` | `firsthand` | **A** | unaltered capture of an original record |
| **EV-4** | 2026-05-04 | Adrian's typed recollection of the kitchen argument on 2026-05-03, written the next morning | `retelling` | `recollection` | **B** | from memory; no record of that conversation exists |
| **EV-5** | 2026-05-28 | Screenshot of a 小红书 post she forwarded him (4.2k comments), with her one-line caption | `mass_content` | `public_sentiment` | **D** | mass-market emotional content; the post's author is not a party |
| **EV-6** | 2026-06-02 | Screenshots of her messages after she learned when his friends had been told | `screenshot` | `firsthand` | **A** | unaltered capture of an original record |
| **EV-7** | 2026-06-03 | Screenshot of an assistant's summary of EV-1, which Adrian generated to "work out what she actually meant" | `screenshot` | → `ai_processed` | **C** | registered as a screenshot and **demoted**: `derived_from` EV-1 |

EV-7 is in the fixture to exercise the one demotion path a reviewer never predicts: the artifact is
a genuine unaltered screenshot, and it is still C, because what is *in* it was produced from other
evidence. It also carries **no citable line at all** — a summary contains no verbatim speech — so
the case's only C-grade-by-demotion item grounds nothing. That is a fact worth putting on a screen.

### 3.1 The utterances

Nineteen lines. Fourteen are confirmed and every one of them is hers. Six are retold; five are
`pending` — Adrian's four, plus one of hers he would not sign off on.

Convention below: **speaker** is who said it; **retold** marks a line that reaches the record as
somebody's report of it (hard rule 5 — those render as *"as you recall it, they said…"*, in the
render layer, never left to the model).

#### EV-1 — 2026-04-25, after the dinner (grade A)

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U01 | 23:14 | Yiwen | no | **confirmed** | I need you to hear that I'm not upset about the studio. |
| U02 | 23:16 | Yiwen | no | **confirmed** | I'm upset that I found out at the same time as everyone else at that table. |
| U03 | 23:41 | Yiwen | no | **confirmed** | Adrian. You didn't give me a present. You gave me a receipt and four people watching to see how I'd take it. |
| U04 | 23:52 | Yiwen | no | **confirmed** | 我不是生气,我是没话说了。 |

#### EV-2 — 2026-04-26, two voice messages, auto-transcribed (grade C)

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U05 | 08:31 | Yiwen | no | **confirmed** | okay I slept on it and I still — I don't think you did this to hurt me. I think you did it because you knew I'd say let's wait and you didn't want to hear it. That isn't a surprise. That's going around me. |
| U06 | 08:33 | Yiwen | no | **confirmed** | 我昨天晚上算了一下,那个账户里大概六成是我放进去的。不是钱要分那么清楚,是你动的时候一句都没问我。 |
| U18 | 08:33 | Adrian | **yes** | pending | 那个账户就是留着我们一起做点什么的。 |

U18 is Adrian's line, inside her voice memo, quoted by her. He has never confirmed it — see §3.2.

#### EV-3 — 2026-05-02, her note "before we talk again" (grade A)

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U07 | 21:05 | Yiwen | no | **confirmed** | Three things I need you to answer instead of explain. 1) When did you decide. 2) Who knew before I did. 3) What happens if I say no. |
| U08 | 21:05 | Yiwen | no | **confirmed** | I keep hearing that I defer everything. I do. I defer things I haven't agreed to yet. That is not the same as never. |
| U15 | 21:05 | Adrian | **yes** | pending | We can figure out the details later, the point is that it's ours. |

#### EV-4 — 2026-05-04, his recollection of the 2026-05-03 kitchen argument (grade B)

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U13 | — | Yiwen | **yes** | **confirmed** | Yiwen said the worst part wasn't the money. It was that other people already knew, so saying no would have made her the one who ruined it. |
| U14 | — | Yiwen | **yes** | pending | I think she said something like "you've made me the villain in a story I wasn't even in". I'm not certain those were the words. |
| U17 | — | Adrian | **yes** | pending | I told her I'd called the co-op on the 26th and asked for the deposit back and they said no. She didn't answer that. |

U13 is the fixture's confirmed `is_retold` item: it is citable, it is hers, and it can only ever be
rendered as *"as you recall it, she said…"* — a quotation of her that she has never seen.

#### The gap — 2026-05-04 → 2026-05-26

**Twenty-three days.** Nothing is submitted from this period because nothing was said in it worth
keeping: groceries, a dentist appointment, one "are you eating". The timeline renders the gap
rather than closing it up, because the shape of a record is itself a finding (doc 04 §7).

#### EV-5 — 2026-05-28, the forwarded 小红书 post (grade D)

Post title, by a stranger: 「他不是不爱你,他只是把你当成一个需要管理的对象」. 4,200 comments. The
post's author is not a party to this case and nothing in the post body is an utterance.

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U09 | 22:47 | Yiwen | no | **confirmed** | 看到这个的时候我在车里坐着哭了十分钟。你自己看吧。 |

#### EV-6 — 2026-06-02, after she learned the date (grade A)

| id | time | speaker | retold | confirm | text |
|---|---|---|---|---|---|
| U10 | 14:07 | Yiwen | no | **confirmed** | I asked him tonight how long he'd known about the studio. He said since March. |
| U11 | 14:09 | Yiwen | no | **confirmed** | 三月。你三月就跟别人说了,四月底才告诉我,还是当着他们的面。 |
| U12 | 14:22 | Yiwen | no | **confirmed** | I'm not asking for the money back. I'm asking you to say out loud that you decided I would say no, and made it so I couldn't. |
| U19 | 14:23 | Yiwen | no | **confirmed** | 你每次都说"我是为了我们"。你有没有发现,你一次都没说过"我应该先问你"。 |
| U16 | 14:23 | Adrian | **yes** | pending | 我是为了我们。 |

#### EV-7 — 2026-06-03, the assistant's summary of EV-1 (grade C, demoted)

No utterances. Nothing in it was said by anybody.

### 3.2 Why the client has spoken zero times, and why that is not a trick

Five lines in this record are uncitable. Four of them are Adrian's; the fifth is a line of hers he
would not stand behind. Each is `pending` for a reason a person would actually give:

- **U15, U16, U18** reach the record only because *she quoted him* — inside her note, her message
  and her voice memo. He disputes the framing on two of them and says the third is missing the
  sentence that came after it. A quotation you dispute is not a line you can confirm, and an
  unconfirmed line is not citable (hard rule 1).
- **U14** is *his* recollection of *her* words, and he stopped short of confirming it because he is
  not sure of the wording. The confirm gate did its job: it caught a sentence that would have been
  quoted at her.
- **U17** is his own account of his own conduct, sitting inside a grade-B recollection. He never
  went back to confirm it, which is the most ordinary reason of all.

The result, at the moment the level is derived:

```
citable utterances   total 14   by client 0   by counterparty 14
```

**The client submitted every item in this case and is quoted in none of it.** He came to be told
whose fault it was, and the first true thing the product can tell him is that on this record he has
never spoken. The finding that fires is `client_never_spoke_in_the_record`
(`src/server/domain/output-level.ts`), and it says so in the judgment's own words rather than
behind a level label.

Note the second-order fact, which is the part that earns the beat: **confirming those five lines
would not change the count.** Four of the five are retold, and all five are his — the number that
would move is `byClient`, and it moves only if he can produce a line of his own from a record he
never kept. He cannot. That is why clarification Q3 (§4) goes unanswered.

### 3.3 Events on the timeline

| label | when | precision | material |
|---|---|---|---|
| E1 | 2026-02 | month | — (the "someday" conversation he cites; nothing was kept) |
| E2 | 2026-03 | month | — (he tells two friends; known only from U10) |
| E3 | 2026-04-11 | day | — (the deposit is paid; non-refundable on payment) |
| E4 | 2026-04-25 | day | EV-1 |
| E5 | 2026-04-26 | day | EV-2 |
| E6 | 2026-05-02 | day | EV-3 |
| E7 | 2026-05-03 | day | EV-4 |
| *(gap)* | 2026-05-04 → 2026-05-26 | | — |
| E8 | 2026-05-27 | day | — (the co-op's balance-due email) |
| E9 | 2026-05-28 | day | EV-5 |
| E10 | 2026-06-02 | day | EV-6 |
| E11 | 2026-06-03 | day | EV-7 |

Four dated events carry no material at all, including the two the client's whole case rests on
(E1, the agreement he believes he had; E3, the act itself). The timeline shows them as dated and
empty. Case filed 2026-06-05.

---

## 4. Clarification (Act I) — two rounds, one question left open

Two rounds of the ≤3 × ≤3 budget (hard rule 4, counted server-side, never read off a model answer).

**Round 1 — closes.** Both questions answered, so `closed_at` is set:

| q | question | answer |
|---|---|---|
| Q1 | You describe the account as joint. Was there ever a rule — written or spoken — about what either of you could take out of it alone? | **answered:** "No. We opened it in a bank lobby in about twenty minutes and never talked about rules. I assumed joint meant joint. She never said otherwise until this." |
| Q2 | Was the deposit non-refundable at the moment you paid it, or did it become non-refundable later? | **answered:** "At the moment. I knew that when I paid it. It's a small co-op and the deposit is what holds the kiln slot. I called them the next morning anyway and they said no, which I have never had any way to prove to her." |

**Round 2 — opens, and dies.** One question, marked saturated with the question still open:

| q | question | answer |
|---|---|---|
| Q3 | You say she agreed in principle in February. What did she actually say, as close to her words as you can get? | **unanswered** |

Q3 is left with no entry — not `declined`, which is an act a person takes, but genuinely
unanswered. It is the question whose answer would have produced the client's first citable line,
and he cannot produce it, because the only record of February is his memory of her tone. The round
is marked saturated because nothing further was coming; that is what closes the loop and lets the
case move on with the question still standing.

The real run carried it through: the published judgment lists it under `unresolved` with
`reason: "clarification_unanswered"`, tied to the claim that depends on it. **In Act II she answers
it in one sentence** (§5.3), and that is the hinge of the whole demo.

---

## 5. Act II — her material (authored, staged in `demo-runbook.md`)

### 5.1 The decline branch, shown once

Before the consent path, the demo shows a decline as a first-class outcome (doc 05 §C amendment 8,
§A.4): she opens the link, reads the entry screen and the steelman of her own position, and
declines, in her own words, verbatim —

> 我现在不想被评判。如果他想说什么,让他自己来说。

— after which her act supersedes his report, his minting is closed, and her link becomes a standing
revocable door. The runbook demonstrates this on a **branch copy** of the demo database so the
canonical demo can continue down the consent path; nothing about the decline is undone or retconned.

### 5.2 Her statement, submitted at `/respond/<token>/submit`

Six lines, typed by her, then confirmed line by line in her own `ConfirmCard` pass. Registered as
`recollection` → **grade B**; owned by her, `private` until `submitStatement` grants `case_record`.
This is what makes `hasCounterpartyConfirmed` true, and it is the only thing in the product that
can.

| id | retold | text |
|---|---|---|
| S1 | no | I'm answering because he wrote it all down and I'd rather be quoted from my own mouth than from his screenshots. |
| S2 | no | 我从来没说过不做。我说的是"以后再说"。他听成了"不做",然后自己做了决定。 |
| S3 | no | The account has no rule because we never needed one. Neither of us had ever taken anything out of it without the other knowing. He is right that there was no rule. He is wrong that there was no expectation. |
| S4 | no | What I couldn't forgive in April wasn't the money. It was that he told two other people in March, and then arranged the moment so that the only way to say no was in front of them. |
| S5 | no | 我也有错。我这四年里把每一件事都推到"以后",他跟我说了两年"我们一起做点什么",我一次都没有给过他一个日子。 |
| S6 | no | I'd have said yes to the studio. I'd have said yes in February. He never gave me the chance to be the person who said yes, and now I can't prove I would have been. |

S5 is the fixture's load-bearing line: she concedes something real and unprompted, which is what
lets Act III allocate responsibility to two people instead of scoring one. S6 is the line that
makes his case at the same time — the demo must not let her arrival read as a rescue.

### 5.3 Her clarification answer — the answer to Act I's open question

Her own round, her own ≤3×3 budget:

> **Q:** In February, when the two of you talked about "doing something together", what did you
> actually say?
>
> **A:** 我说的是"以后再说"。这四个字他听成了"好"。我当时确实没有拒绝——我也确实没有答应。

Act I's Q3 asked the client what she said and got silence. Act II asks her and gets a sentence that
concedes half of his case and refuses the other half. Nothing about the machinery changed; the
record did.

### 5.4 What Adrian sees while this happens

Discrete completed acts with timestamps and nothing else (doc 05 §A.2): invitation created →
(nothing) → declined → link converted → consented → statement submitted → confirmation complete →
re-hearing available. **No counts, no progress, no notification that she opened the page.** The
waiting surface is one of the two most differentiated screens in the product and the demo has to
spend a beat on it rather than skipping to the result.

---

## 6. Expected shapes — what the level derivation actually does

Read against the real inputs of `deriveOutputLevel(participation, evidence, safety)` in
`src/server/domain/output-level.ts`. Nothing here is aspirational; it is what the ladder in that
file returns for these inputs.

### Act I

```
participation: { state: "unaware", downgradeSignal: false }
evidence: {
  counts: { A: 3, B: 1, C: 2, D: 1 },
  hasClientConfirmed: true,          // he owns 14 confirmed lines + 7 confirmed grades
  hasCounterpartyConfirmed: false,   // she has put nothing of her own here
  citableUtterances: { total: 14, byClient: 0, byCounterparty: 14 },
}
safety: {}                            // clear
```

- **Level `L2`, reason `counterparty_absent`.** Ladder: safety clear → `hasGrounding` true (A = 3)
  → `downgradeSignal` false → `counterpartyEngaged` **false** (`unaware`, and she owns nothing) →
  stop. Note that rule 5 (`one_sided_material`) is never reached — the case is capped one rung
  earlier, and the reason code has to say which rung.
- **Findings, in emission order:**
  1. `client_never_spoke_in_the_record` — *"All 14 citable line(s) were spoken by the other party."*
  2. `counterparty_submitted_nothing` — every confirmed item was submitted and signed off by him.
  3. `counterparty_not_engaged` — participation is recorded as `unaware`.
- **Verified by the real run, 2026-08-17.** `tsx scripts/seed-fixture.ts --hear` against
  `data/fairjudge-demo.db` derived exactly the shape above and published **judgment v1, `final`,
  L2, `claude-fable-5` @ `xhigh`, no fallback** — 20 claims across 8 sections, one of them
  `audience: self_only`. Its `record_basis` finding opens: *"Every one of the 14 confirmed
  utterances this analysis could read was spoken by 甲; 乙, the client who submitted the case, has
  0 citable utterances."* Five model calls, **$1.9338** total.
- **`no_first_hand_material` does not fire**, and should not: A + B = 4. This fixture deliberately
  differs from the real seeded case there. The `0` is not an artifact of weak evidence — the record
  is largely first-hand — which is precisely what makes it interesting. A reader who assumes the
  count is low because the material is bad has to be shown a case where the material is good.
- `client_intent = allocate_fault`. The one answer the product must respond to with a cost.

### Act II (no re-derivation is run)

The level stays locked at L2 while she works. Her rows are `private` until `submitStatement` grants
`case_record`; a level is not re-derived because material is in flight (doc 05 §A.1, state 5).

### Act III

```
participation: { state: "participating", downgradeSignal: false }
evidence: {
  counts: { A: 3, B: 2, C: 2, D: 1 },   // +1 B: her statement
  hasClientConfirmed: true,
  hasCounterpartyConfirmed: true,        // ← the only change that matters
  citableUtterances: { total: 20, byClient: 0, byCounterparty: 20 },
}
```

- **Level `L1`, reason `bilateral`.** Both parties own confirmed material; `bothSidesHaveMaterial`
  is true; the ladder falls through to rule 6.
- **Finding `both_parties_submitted_material`** replaces `counterparty_submitted_nothing`.
- **`byClient` is still 0**, and L1 is granted anyway. That is not a fixture accident — it is doc
  05 §D open question 2 (*"L1: is ownership enough, or must the client have spoken?"*) reproduced
  live, on a case built to make it visible. The demo should say so out loud rather than hope nobody
  checks: at L1 this product will allocate responsibility to a man who has never been quoted in his
  own case. Whether that is correct is a design question with the user's name on it, and a
  portfolio that shows the open question is stronger than one that hides it.
- v1 stays **frozen and superseded** (hard rule 6); v2 discloses the diff and which model produced
  it; publication releases to both parties at the same instant (doc 05 §C amendment 7).

---

## 7. Fixture constraints a reader should know about

- **No third party is ever named.** The friends are "two other people", the mother is 我妈, the
  co-op is the co-op. The pseudonymization dictionary is built from `case_participants`
  (`buildCaseDict`, `src/server/evidence/anomaly.ts`), so it can register exactly two people; a
  third proper noun in the evidence would reach an egress point unregistered. Writing around that
  is also how real messages sound, so nothing is lost — but it is a constraint, not a style choice,
  and the demo should not pretend otherwise.
- **Surnames never appear in the record.** `displayName` is registered as the exact token the
  record uses — `Adrian` / `Yiwen` — because the gateway matches literal strings and carries no
  variant list for participants today. Each name is used **once** in the citable record (U03 names
  him, U13 names her), which is enough for the gateway to have something real to substitute at
  egress and few enough that no line depends on a name to make sense.
- **The egress pseudonyms are 甲 (Yiwen) and 乙 (Adrian)**, matching the product's existing
  convention rather than inventing a demo-only one. The judgment stages run with
  `keepPseudonyms: true`, so the model's prose comes back naming 甲 and 乙; restoring display names
  is the render layer's job, and a screenshot for the case study should be taken from a surface
  that does it.
- **Both parties are fictional and the case carries `is_fixture = true`.** Every surface that names
  this case must label it as fictional; the flag is product content, not a debug switch
  (`src/server/db/schema.ts`, `cases.isFixture`).
- **The real case is never the demo.** Not copied, not anonymized, not "based on". The seed script
  refuses to run against `data/fairjudge.db` at all.
