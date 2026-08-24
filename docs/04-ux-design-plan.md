# 04 — UX Design Plan v1

v1.1 — amended 2026-08-17 per docs/05 §C (evidence-driven revisions after the comparative survey).

Companion to `01-pipeline-design.md` (what the product decides), `02-engineering-architecture.md`
(how it decides it), and `03-build-plan.md` (what got built). This one is about the half that was
never specified: **what a person actually does, sees and understands.**

---

## 0. Why this document exists

Every milestone from M0 to M5 was accepted on the same three criteria: *it runs, the tests are
green, it was verified on the real case.* Not once did an acceptance criterion say **"a person can
do this unaided."**

The result is exactly what those criteria selected for. The pipeline is complete and correct — nine
stages, evidence grading, level derivation, frozen judgments, swap tests, consent gates, export
gating, appeals. And:

- there is **no way to create a case** from the product; the only case in existence was inserted by
  a seed script;
- `mintShareToken` produces a link that lands on a refusal, because the route it promises was never
  built;
- the L1 shareable document sends each party the finding about the *other* one, while telling them
  about a finding they cannot see;
- the judgment page tells the reader a second vendor rewrote its phrasing, then displays, four
  lines below, that the vendor returned HTTP 401 and rewrote nothing.

None of these are cosmetic. Each is a **design decision that was never made**, which meant the code
made it by default. That is what this document is for, and it is why the fix list and the design
list are the same list.

---

## 1. The design problem

A person opens this product because they feel wronged. They want to be told they are right.

The product's entire architecture exists to prevent exactly that. It will not allocate
responsibility without hearing the other side. It grades your screenshots and tells you which ones
cannot support a finding. It runs a swap test to check whether the judgment survives exchanging the
two names. It writes paragraphs specifically about what you did wrong and marks them `self_only` so
you cannot escape them by sharing a filtered copy. It refuses outright when it sees a safety flag.

So the single UX requirement, from which everything below is derived:

> **Being judged has to feel like being taken seriously, not like being attacked.**

Every screen either earns the right to say something the user doesn't want to hear, or it doesn't.
That is the only quality bar that matters here. A beautiful interface that loses the user's consent
at the moment of the finding has failed at the one thing.

A second requirement, from the ethics rather than the psychology:

> **The absent party is a person in the room.**

A counterparty who has never consented, has never spoken in the record, and cannot answer anything
the product says about them is still a person the product is talking about. Every surface that
touches their words has to carry that fact visibly, not in a footnote.

---

## 2. Inventory: what is actually wrong

Sorted by kind, because the kinds want different work.

### 2.1 Screens that do not exist

| Missing | Consequence |
| --- | --- |
| Case creation | The product runs on exactly one case, forever. Nothing else can be demoed, designed against, or tested without touching the live record. |
| `/respond/[token]` landing | The share flow mints a token and hands over a dead link. |
| A fixture / demo case | Design iteration is currently forbidden by our own Verification rule, because the only case is a real person's relationship. |

### 2.2 Screens that assert something untrue

| Screen | The untrue thing |
| --- | --- |
| Judgment → polish archive | "a second vendor rewrote the phrasing" — on this judgment it rewrote nothing (`skipped`, 401). |
| L1 shareable document | Each reader gets the finding against the other party, while the limits section names a finding they cannot see. |
| Share screen | Offers a link that does not resolve. |

These are the highest-priority items in the entire plan. A product whose thesis is evidentiary
integrity cannot ship screens that state falsehoods about itself.

### 2.3 Screens that work and were never designed

Everything else. `/evidence`, `/timeline`, the stage list, `/translate`, the judgment reading view.
They are built out of the same bordered-white-card vocabulary because that is what an agent writes
when the acceptance criterion is "renders". They are not bad; they are undesigned, which shows most
where the product asks the most of the user.

---

## 3. Principles

Seven, each derived from something the architecture already does. They are the tie-breakers for
every decision below.

1. **The limit precedes the finding.** The judgment page already does this — it states the level,
   the level's constraints, and the counted record basis *before* any finding. Make it global:
   no surface states a conclusion before stating what it was allowed to know.

2. **Every refusal names the key.** A locked door with no key is a bug report. A locked door with a
   visible key is the product working correctly. "I cannot allocate responsibility" must always be
   followed by "because only one person has spoken here — that changes if she answers."

3. **Labor buys legibility, visibly.** Confirming utterances is the bulk of the user's time and
   currently returns nothing until the very end. Never request the next confirmation without
   showing what the last one bought.

4. **Internal vocabulary is translated into consequence at the surface.** The system needs `L2` and
   grade `C`. The user needs *"I can say what happened, not whose fault it is"* and *"I can mention
   this, I can't rest a finding on it."* Keep the code words visible as secondary labels — they are
   the audit trail — but never make them carry the meaning.

5. **What counts against the reader is the most carefully designed thing on the page.** Not
   softened — HARD RULE and the narrative prompt both forbid softening. *Designed*: given room,
   given its evidence inline, given the reader's own answer to it if they gave one.

6. **The absent party is visible on every surface that uses her words.** Count, provenance, and the
   fact that she never agreed. This is not a disclaimer; it is a running fact that shapes what the
   product is allowed to say.

7. **Neutrality is demonstrated by procedure stated in advance, never claimed as an adjective.**
   The product earns the word by telling the user the procedure before it runs — what each level
   licenses, what participation changes, what is withheld from whom — and by treating both parties
   procedurally alike. It never asserts the property. No surface calls the product or its output
   "fair", "unbiased", "neutral" or "objective"; the name `fairjudge` is the last place that
   adjective appears (survey §3.2, Matterhorn's procedural equivalence; §3.5, ICODR Transparent;
   anti-pattern 2 — the *"Unbiased: No taking sides"* product that outputs 80/20 from one side).

---

## 4. The design objects

Six. Roughly in the order a person meets them.

### 4.1 立案 · Intake — *the missing front door*

**Job:** get a person from "we had a fight" to a case, in under two minutes, while teaching them
what this product refuses to do — before they have invested anything.

The critical move: **ask what they want, and answer immediately with what that costs.**

```
What do you want out of this?
  ○ I want to work out what actually happened
  ○ I want to know whose fault it was          → needs both of you
  ○ I want to know how to stop it happening again
```

Choosing the middle option surfaces, right there: *"That requires the other person to answer too.
On your own I can lay out the record and tell you where it is thin, but I will not assign fault
based on one side. Here is what it takes to reach that."*

This is the same information the current build delivers as a **disappointment at the end**. Moving
it to the moment of ambition converts the product's central constraint from a letdown into a
promise. It is the highest-leverage single change in this document.

**Before any evidence is requested, intake also carries the advance-disclosure card**: the
procedure the case will run through, what each level licenses and forbids, and what the other
party's participation would change. Disclosure *before* participation is the ICODR Transparent
standard (survey §3.5), and stating the procedure in advance is the only honest way to signal
neutrality — the working ODR systems signal it by procedural equivalence and never by adjective
(survey §3.2, Matterhorn). So the card describes what the product does; it does not describe the
product as fair, unbiased, neutral or objective, here or anywhere else in the UI (principle 7).

Then: name the case, name the parties (this is also pseudonym-dictionary registration — HARD RULE 3
blocks egress on unregistered names, so it belongs here rather than as a later error), and a first
free-text account of the conflict.

**Also to design:** the case list at `/case`, which currently has one row and no concept of an
empty state, an archived case, or a case someone abandoned halfway.

---

### 4.2 证据台 · Evidence — *where the user's time actually goes*

The heaviest surface and the least designed. Three moves:

**a. Confirmation is recognition, not reading.** Render OCR'd bubbles in their original chat
layout — left/right, in order — so the user confirms by *recognising the conversation they lived*,
not by reading a table of extracted strings. The one thing that genuinely needs their judgment is
speaker attribution, which OCR infers from bubble position and gets wrong at the edges. Make that
the primary gesture and demote everything else.

**b. Batch, with exceptions.** Confirm-all-visible, then correct the few that are wrong. The
current one-at-a-time model prices a 40-message screenshot at 40 decisions, and a person in a bad
week will not pay it.

**c. Grades stated as what they do.**

| Now | Should read |
| --- | --- |
| Grade A | Can be quoted directly as something that was said |
| Grade B | Can only be quoted as *your recollection* of what was said |
| Grade C | Can be mentioned; a finding cannot rest on it |
| Grade D | Not evidence about you two — this is generic content |

Keep `A`/`B`/`C`/`D` as a small secondary token. The badge should say the consequence.

**d. Progressive payoff.** A quiet running line: *"With what you've confirmed, I can now speak to
the keys incident and the driving-lessons argument. The February gap is still unreadable."* This is
principle 3, and it is what makes the labor survivable.

---

### 4.3 时间线 · Timeline — *the case as a story, not a sort control*

Already has dnd-kit ordering, which is the mechanically hard part. What is missing is that this is
the only screen where the user sees their conflict **as a whole**, and it should be built for
reading, not just reordering.

- **Gaps are evidence.** Three weeks with no record is a fact about the case and should render as
  one, not as whitespace.
- **Who speaks, over time.** A minimal two-track marking of whose words exist when. On the real
  case this renders as one continuous track and one entirely empty one — which is the whole finding
  of that judgment, visible at a glance, before any prose.
- Events carry their evidence grade, so a stretch of the story built on C-grade material *looks*
  thinner than one built on A.

This is the one place a graphical treatment is warranted, and the reason is not decoration: the
shape of the record is itself the product's most important finding.

---

### 4.4 判决 · The judgment — *finish the document*

The reading view exists and its section order is right. What it needs:

**a. Typography, treated as a document.** It is long-form prose that someone will read once,
carefully, about their own life. Measure, leading, the handling of verbatim Chinese quotes inside
English sentences (mixed-script line height is currently uneven). This is a real pass, not a
`prose` class.

**b. Design the `0`.** The record-basis card currently reports *"Spoken by you (乙): 0"* as a
number in a grid. It is the most important sentence the product has ever produced for this user:
in the entire record he assembled about his own relationship, he never once appears speaking. That
deserves to be a designed moment — stated in words, given the page, placed before the findings.

**c. `self_only` must be legible as a boundary.** The reader has to understand, while reading it,
that this paragraph exists in their copy and in no other. Right now `audience` is printed as a
stored value. It needs to read as *"this stays here."*

**d. Fix the polish archive copy.** Say what happened: the layer was configured, never successfully
ran on this judgment, and has since been removed. The current sentence claims a rewrite that never
occurred.

**e. Limits as the frame.** Already first in order. Give it the weight of a frame rather than a
preamble the eye skips.

---

### 4.5 对方的那一份 · The counterparty surfaces — *the ethically loaded ones*

**a. The diff view.** The share screen should show, side by side, *what you are reading* and *what
she would receive*, with the withheld paragraphs visibly withheld and the reason stated. A user who
cannot see what is being filtered cannot meaningfully consent to sending it.

**b. Fix the L1 audience rule before designing anything on top of it.** At L1 both responsibility
findings belong to both readers — a judgment that tells each party only about the other's fault is
not a judgment, it is ammunition. This is a data-model decision (`audience` must become
level-aware), and it has to land before the share UI is worth designing.

**c. Build `/respond/[token]` as the front door for someone who did not ask to be here.** This is
the hardest screen in the product and currently does not exist. Its reader is a person who received
a link from someone they are in conflict with. Before anything else it must answer: *what is this,
who made it, what does it already say about me, what happens if I close this tab.* Consent has to
be refusable without penalty, and refusing has to be a visible outcome in the case rather than a
silent nothing.

**d. The consent gate needs a real cost.** Currently a state transition. It should read as the
serious act it is. And it now carries the **simultaneous-release rule**: a re-heard version
publishes to both parties at the same instant — publication writes the rendition, then notifies
both, and neither party's reading gates the other's access. Sender-initiated sequential unlock is
retired for re-hearings, because in a conflict product "he got to read it first and prepare a
rebuttal" is itself a grievance, and retiring grievances is what a judgment is for (survey §2.2,
SyncWithLove's simultaneity: *"nobody got to read first and prepare a rebuttal"*). The share diff
survives unchanged for everything *else* A chooses to send.

**e. The artifact carries its own provenance and redistribution rule.** The diff view and the
consent gate govern the moment of sending; nothing yet rides on the document after it leaves. So
every shareable or exported rendition carries, inside the document and non-removable: *"An
AI-mediated document, not a human judgment. Produced at level ⟨L⟩ on ⟨N⟩ confirmed items —
⟨basis summary⟩. Do not present this as a neutral third party's finding."* Wording varies by
level, and the one-sided label doc 01 already mandates at L2 merges into this notice rather than
sitting beside it. Any verdict is manufactured ammunition; the notice has to travel with the
ammunition, not stay behind on the screen that produced it (survey §1.6, AYTA's *"please do not
share these as human judgements"*; pattern 11; anti-pattern 4).

---

### 4.6 拒绝与降级 · Refusal and downgrade states — *make these the best screens in the product*

The safety referral path, "not enough evidence to say that", "this claim is unresolved because you
didn't answer the clarification question", "this case cannot be shared." These are currently the
least designed screens, and by the logic of this product they should be the **most** designed —
they are the only proof the thing has integrity. Every one gets principle 2: what it cannot do,
why, and what would change it.

They are also not one screen. There are three kinds of refusal and they carry three different
messages to the reader: **capability** ("only one side has spoken here"), **uncertainty** ("the
finding did not survive the swap test" / "the evidence contradicts itself"), and **policy** ("this
is the wrong instrument for what you are describing; here is the referral"). Collapsing them into
one generic screen is the mistake (survey §6.6). Each one hands over an artifact rather than a
closed door: the capability refusal hands over the upgrade list, the uncertainty refusal hands
over the two readings side by side, the policy refusal hands over the referral itself.

**The policy-refusal screen orders its offers by measured uptake, and the hotline is last.** A
crisis referral that is only a phone number is, empirically, a referral to nothing: measured uptake
runs safety plan 49.2%, grounding 46.6%, hotline **2.4%** (survey §6.2, Wysa). So the screen
offers, in this order — something to do right now (grounding), something structural (a safety plan
or a concrete next step), and only then the external handoff, given as 988 **call and** text/chat
rather than a single number. All of it is deterministic authored content, which preserves hard
rule 9's zero-latency, no-model-in-the-loop path. And detection confirms with the person before it
escalates — the screen states what it noticed and asks, rather than announcing a conclusion about
their safety (survey §6.2, Wysa's confirmation gate; pattern 10f).

---

## 5. Sequencing

Five waves. **Every acceptance criterion is a person completing a task unaided** — that is the
process fix, not just the screen fix.

### Wave 1 — Make it enterable and make it honest
*Case creation · fixture cases · the three untrue screens · `/respond/[token]`*

Case creation and a pair of fixture cases first, because **every other wave is blocked on being
able to look at a case that is not a real person's relationship.** Two fixtures, not one:

- **Fixture A — one-sided (→ L2).** Mirrors the real case's shape. Rich enough to exercise all four
  evidence grades, unknown-tier claims, and an unanswered clarification question.
- **Fixture B — both parties (→ L1).** The only way to see responsibility allocation, `self_only`
  sections, the share diff and an appeal. This is also the fixture the showcase runs on.

Both labelled as fictional inside the UI itself, not only in a README.

> **Done when:** a person who has never seen the product creates a case from the home screen, and
> the app contains a demo case that can be opened, judged and shared without touching
> `data/fairjudge.db`. `mintShareToken` produces a link that resolves. No screen states something
> the same screen disproves. **And the decline path works end to end with its full mechanics:** a
> decline is recorded as *her* act and supersedes the sender's report of her; it closes the
> sender's ability to mint further invitations for that participant; her link converts from a
> single-use invite into a standing, revocable personal door back to the transparency view and to
> reversing her decision; the entry screen renders the sentence saying that closing the tab reports
> nothing and that opening the page is not recorded as an act; and every later document states the
> decline only as a participation fact ("invited 2026-08-20; declined 2026-08-24"), with no adverse
> wording and no inference drawn from it. Forced by the Utah result — silence and refusal must be
> procedurally inert (survey §3.0) — and by ARSH's finding that a refusal delivered badly teaches
> people not to come back (§6.6); the refuser must not be punished for refusing.

### Wave 2 — Intake as the teaching moment
*The what-do-you-want question · level as a negotiated promise · party registration · the case list*

> **Done when:** a person finishes intake able to say, in their own words, what this product will
> refuse to tell them and what it would take to change that.

### Wave 3 — The labor surfaces
*Evidence confirmation in chat layout · batch confirm · consequence-worded grades · progressive payoff · timeline as story*

> **Done when:** a person imports a 40-message screenshot and finishes confirming it in under three
> minutes, and can say what their confirmations bought.

### Wave 4 — The document
*Typography pass · the `0` moment · `self_only` as boundary · limits as frame · refusal states*

> **Done when:** a person reads a judgment end to end without scrolling past anything, and can
> correctly state which paragraphs would never be shown to the other party.

### Wave 5 — The counterparty
*L1 audience fix · the diff view · the consent gate and simultaneous release · the `/respond` experience · **the waiting surface, A's side of the same period***

Wave 5 owns both halves of the two-person period, not just the arriving party's. While only one
person has spoken, the product is a standing record with a named unblocking condition — not a
countdown. A's surface shows the frozen v1 with its level and the level's reason stated as the key,
the invitation's state as **discrete completed acts with timestamps** (created → consented or
declined → statement submitted → confirmation complete → re-hearing available), and the work A can
still do that improves the record regardless of her. It refuses to show live presence, line counts
or progress of any kind — the only prior art is a quiz app between people at peace (survey §2.2),
whereas this waiter is a party to a conflict and live progress on a rebuttal is surveillance of an
adversary's drafting; counts are also volume signals, and volume must never read as strength. It
does not report that she opened the page, and it displays no deadline on the merits. This is the
hardest and most ownable screen in the product (survey §4, gap 7).

> **Done when:** a person can see exactly what the other party would receive and why the rest is
> withheld, and a test reader arriving cold at `/respond/<token>` can decline without confusion —
> **and a person whose counterparty has not answered can say what is happening, what is not being
> shown to them and why, and what would change the case's level.**

**Sequencing note:** Wave 5's `audience` fix is a data-model change and can start in parallel with
Wave 2 — it does not depend on any design work, and everything in Wave 5's UI depends on it.

---

## 6. The showcase

**Format: portfolio piece.** Decided 2026-08-17. The primary artefact is a written case study that
a reader gets through in a few minutes; the running app is supporting evidence, not the deliverable.
Most readers will never open it.

### 6.1 The thesis, stated so it does not read as a gimmick

The obvious framing — *"I built an AI that judges relationship arguments"* — is the weakest one
available. It invites "did this need AI" and "isn't that a bit creepy", and it puts the model at
the centre when the model is the least interesting part.

The real subject:

> **What does an interface owe someone when it is about to tell them something they do not want to
> hear, about a person who never agreed to be discussed?**

That is a design problem, and every hard decision in this repository is an answer to it: evidence
grading, level derivation, the swap test, `self_only` sections, the export gate, the deterministic
crisis path. Presented that way, the LLM is an implementation detail and the design work is the
content — which is the correct emphasis for this audience and also happens to be true.

### 6.2 The original case cannot be shown — and that is the strongest page in the piece

The counterparty never consented to that material being processed at all, let alone published. So
the case study cannot show the case it was built for.

**Do not treat that as a limitation to apologise for. It is the demonstration.** The product's own
consent architecture forbids its author from using its only real output in his portfolio — the
constraint the system imposes on strangers, imposed on the person who wrote it, with no exception
available. A page that says so proves more about the design than any screenshot could.

Origin story, told in the abstract: built for a real conflict, all displayed material fictional,
the real case unshowable by the system's own rule. That keeps the motivation — which is what makes
the piece credible — without exposing her.

### 6.3 The demo is one case at two points in time, not two cases

The earlier draft of this plan called for two separate fixtures. That is worse. Make them **the
same case before and after the other party answers**:

- **Act I — alone (L2).** One-sided record. The product lays out what happened, states what it
  cannot say, and reports the record basis: *spoken by you — zero.*
- **Act II — the invitation and the answer.** Act II is the whole state machine, not a single
  beat: the invitation is created; A's waiting surface shows what it shows and, more importantly,
  what it refuses to show and why (discrete acts, no presence, no counts, no deadline on the
  merits); she arrives at `/respond/<token>` and reads before deciding, including the steelman of
  her own position; **the decline is shown as a first-class outcome** — walked once in the fixture
  before the consent path, so the reader sees that refusing costs her nothing and leaves her door
  open; then the consent path, and her intake written blind to everything of A's beyond the
  published v1.
- **Act III — re-heard (L1, version 2), released to both at once.** Responsibility allocated for
  the first time, and the document reaches both parties in the same instant — neither reads first
  and prepares a rebuttal. The frozen version 1 still sits there, and the diff discloses what
  changed and why.

The wait state and the refusal states are the two most differentiated surfaces this product has
(survey §4, gaps 7 and 8b); a demo that compresses Act II into "she consents and speaks" demos
only the parts competitors also have.

This runs on machinery that already exists (appeal → re-hearing → `version + 1` with disclosed
diff), and it makes the product's central argument **narratively instead of by assertion**: you
watch the record change, and you watch what becomes sayable change with it.

It also resolves a trap in the earlier plan. The `0` only exists in a one-sided case; a
both-parties fixture has no such moment. Sequencing the acts preserves the strongest beat *and*
reaches the L1 surfaces.

**Constraint on the fixture writing:** Act I's record must be built to produce a striking
record-basis count, and the conflict must be specific enough to feel like a real argument between
real people while sharing nothing with the actual case. This is authored content and its quality
matters as much as any screen's.

### 6.4 The narrative

The differentiated thing about this product is not that it analyses a conflict. It is that **it
refuses to.** Anyone can ship "AI reads your chat history." Almost nobody ships one that counts how
many times you spoke, tells you the answer is zero, and declines to assign fault on that basis.

So the spine is the refusals:

1. **The ask.** "I want to know whose fault it was." → *That requires both of you.*
2. **The evidence.** Grades, and the ones that cannot carry a finding.
3. **The record basis.** The `0`. The single strongest moment; give it its own beat.
4. **The judgment.** What it says, and the paragraph that counts against the person who
   commissioned it.
5. **The wait, and her right to say no.** What the product shows the waiting party — and the four
   things it refuses to show him. The decline, walked as a real outcome: recorded as her act, inert
   on the merits, no further invitations, her door still open.
6. **She answers, and it is re-heard.** What became sayable — the frozen v1 still standing, and
   both parties reading the new version at the same moment.
7. **What she receives.** The diff: what is withheld, and why.
8. **The refusals.** Three kinds, three screens: the capability refusal with its upgrade list, the
   uncertainty refusal showing the two readings the swap test could not reconcile, and the policy
   refusal — a safety flag answered with zero latency and no model in the loop, graded offers
   first and the hotline last.

Beat 3 is the one people remember. Beat 6 is the one that proves the architecture was worth it.
Beats 5 and 8 are the ones nobody else has.

### 6.5 Hero screens

The portfolio direction gives us a prioritisation lever the plan otherwise lacks: **only the screens
that appear in the case study need the full design pass.** In priority order —

1. The record-basis moment (beat 3)
2. The judgment document, including a `self_only` paragraph
3. **The refusal triptych** (beat 8) — three screens, not one: capability ("only one side has
   spoken"), uncertainty ("the finding did not survive the swap" / "the evidence contradicts
   itself"), policy ("this is the wrong instrument; here is the referral")
4. Intake's what-do-you-want question (beat 1)
5. The share diff (beat 7)
6. Evidence confirmation in chat layout (beat 2)

The refusal moved up from last place because the survey found that nobody refuses well — it is the
most under-explored design surface in the whole comparative field (survey §4.1, §4.8b), and the
three kinds carry three different emotional messages, so one generic screen forfeits the surface
(§6.6). §4.6 already called these the best screens in the product; ranking them sixth of six
contradicted it.

Everything else gets consistency, not composition. This is how Waves 2–5 get scoped down if time
runs short — cut by screen, not by quality.

### 6.6 Publication and 在职保密

The piece has to be showable to named people without being indexed: unlisted URL or password, not
a public site, and no repository made public while the origin material sits in it. The case study
carries screenshots of fictional content only; the real `data/fairjudge.db` never leaves the
machine, which is the same rule the product enforces on its own users.

---

## 7. What I would not do

- **No charts, no dashboard, no metrics.** The document-first instinct is correct. A verdict about
  your relationship should not look like analytics. The timeline is the one place a graphical
  treatment earns its place, and only because the record's shape is itself a finding.
- **No warmth.** The narrative prompt already forbids therapeutic filler; the interface must not
  add it back. No encouragement, no emoji, no "you've got this." The product's respect for the user
  is expressed as precision.
- **No progress gamification.** The confirmation work gets *legibility* as its reward — what became
  answerable — never streaks or badges.
- **No neutrality adjectives, anywhere in the UI.** The product never describes itself or its
  output as "fair", "unbiased", "neutral" or "objective". It shows the procedure instead — stated
  in advance, applied to both parties alike — and lets the reader draw the conclusion. The name
  `fairjudge` is the last place that adjective appears. The claim is the anti-pattern: the surveyed
  product advertising *"Unbiased: No taking sides"* is the one that returns 80/20 from a single
  side's material (survey anti-pattern 2; §3.2, Matterhorn signals neutrality by procedural
  equivalence and never by adjective).
- **No hiding the machinery.** Grades, levels, model provenance and frozen-version history stay
  visible. They are the reason to believe any of it. Translate them; do not remove them.
- **Do not redesign `/translate`.** It is the one surface that already works, does one thing, and
  needs nothing.
