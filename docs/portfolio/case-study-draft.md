# Case study — draft v1

*Draft text for the one-page portfolio piece (doc 06, evening 3). Body is ~720 words. Beat
headings below are working labels, not necessarily printed headings — see the note after the
captions. Everything in this file is English per CLAUDE.md.*

---

## Title options

1. **Zero, Before Anything Else** — *favored.* It names the product's central move and it is
   concrete enough to survive a scan. Optional deck line: *designing a judgment product that
   counts your own words first.*
2. **The Refusals Are the Product** — accurate, and it tells a hiring manager what kind of
   designer wrote it. Slightly more abstract on first read.
3. **A Person Who Never Agreed to Be Discussed** — strongest ethical framing, weakest at
   telling anyone what the thing is.

---

## Draft

An interface is about to tell someone something they do not want to hear, about a person who
never agreed to be discussed. What does it owe them? That is the whole design brief for
fairjudge. One person files a conflict; the other may not know it exists. I built it, and
most of the work was deciding what it must refuse to do.

### 1. The ask

Intake ends with one question: what do you want from this. Adrian picks *I want to know whose
fault it was.* The screen answers him on the spot — that is the one answer that requires the
other person. Fault is an allocation between two people; it cannot be made from one side. So
the central constraint arrives as a promise at the moment of ambition rather than a
disappointment forty minutes later, once the folder is uploaded: ask for this, and here is
what it will take.

### 2. The zero

Before the judgment says anything about the conflict, it counts. In the record Adrian
assembled about his own conflict — seven items, all submitted by him, mostly first-hand — the
query layer counts the lines that can be cited: fourteen. It counts how many are his: zero.
Not because his material is thin. Because nobody screenshots themselves. What you preserve is
proof of what *you* were told, so a case built from one person's screenshots is one in which
only the other person speaks. The judgment prints that number, in a sentence, before its first
finding. The limit precedes the finding.

### 3. The judgment

The output is a document, not a dashboard. Long-form measure, twenty claims across eight
sections, evidence quoted verbatim in the language it was said in — this record moves from
English to Chinese exactly where it starts to hurt, and translating it would destroy it. Each
claim carries its evidence tier and a confidence. Open questions stay listed as open, tied to
the claim that depends on them. And the passages that count against the reader are marked
`self_only`: they stay with him, and are never released to her.

### 4. The second voice

If she is invited, she lands on a page that does four things before asking anything of her. It
says what this is. It shows the strongest version of her position, in her words, before any
request. It states plainly that opening this page is not reported to anyone. And it offers
three exits of equal weight: answer, decline in your own words, or close the tab. Decline is a
first-class outcome — it supersedes his account of her and leaves her link a standing
revocable door. If she answers, the case is re-heard with two blind advocates and an
identity-swap gate — built and tested — and the fault question becomes answerable only once
both have spoken.

### 5. The refusal

The block that prints the zero is also where the product declines what he asked for. The level
is derived in code, not by the model: one side has spoken, so fault is not allocated, and the
reason is named rather than hidden behind a label. Two numbers set that policy. The median LLM
reverses its preference in **41.3%** of position-swapped judgments, which is why agreement
across a seat swap gates publication. And Utah's mandatory
online dispute resolution turned fourteen days of silence into default judgment; default rates
went **43% → 59%**. Here, silence is procedurally inert — not consent, not admission, not a
countdown.

### The case I cannot show you

One more refusal, and it points at me. This product exists because of a real conflict, and its
consent architecture will not let its author show it: the other person never agreed to become
a case study, and anonymizing does not change that. So everything on this page runs on a
fiction I wrote — Adrian and Yiwen, a joint account, a studio deposit, an anniversary dinner
with an audience. The seed script refuses to run against the real database. The architecture
binds the person who built it.

### How it is built

The judgment comes from four seats, not one mind. Two advocate agents argue opposed briefs
from the confirmed record, each blind to the other, because a single model asked to weigh both
sides produces hedged consensus. The judge emits twice, from exchanged seatings; outputs are
compared in deterministic code, and disagreement is printed rather than averaged. No seat
claims neutrality — the biases are instantiated and labelled. And every rule lives in code,
not in a prompt: citability at the query layer, level derivation as a pure function, a
pseudonymization gateway on every egress.

---

## Caption stubs — 6–8 stills

Core six: **1, 2, 3, 4, 5, 7.** Stills 6 and 8 are taken only if those surfaces render from
the current snapshot; drop them rather than build for them (doc 06: two surfaces, not five).

**Still 1 — Intake, the what-do-you-want question.**
In frame: all intent options with *I want to know whose fault it was* selected, and the cost
line that appears on selection (this is the answer that requires the other person). The
fictional-case label must be visible somewhere in the shot.

**Still 2 — Judgment page, the "Before you read it" block, top of page.**
In frame: the citable-utterance count as both number and sentence — 14 total, 0 by the client
— sitting above any finding about the conflict. Nothing from the conflict itself in frame.

**Still 3 — Judgment page, the `record_basis` finding in full.**
In frame: the finding's opening sentence naming the count and both parties, plus the output
level and its reason rendered as words rather than a badge. Capture from a surface that
restores display names, not the 甲/乙 egress pseudonyms.

**Still 4 — Judgment document body, one claim.**
In frame: a claim paragraph with its verbatim quote in the original language (U04, 「我不是生
气,我是没话说了。」), its evidence tier and confidence, and enough surrounding text to show the
long-form measure and the 中文-in-English line height.

**Still 5 — Judgment document, a `self_only` passage.**
In frame: the audience marker and the passage it governs, cropped tight enough that the marker
and the first two lines read together in one glance.

**Still 6 — Judgment page, the timeline.** *(optional)*
In frame: the 23-day gap rendered as a gap rather than closed up, and at least one dated-but-
empty event — E1 or E3 — showing that the two events his case rests on carry no material.

**Still 7 — Arrival screen, `/respond/<token>`.**
In frame: the steelman of her position above any request, the sentence that opening the page
is not reported to anyone, and all three exits at equal visual weight — in one shot, not
stitched.

**Still 8 — The client's waiting surface.** *(optional)*
In frame: the list of discrete completed acts with timestamps and nothing else. The point of
the shot is the absence — no counts, no progress bar, no "she opened it".

---

## Notes for the build pass

- Beat headings 1–5 are labels for this draft. On the page, consider dropping the numbered
  headings and letting the stills carry the segmentation; keep **The case I cannot show you**
  and **How it is built** as real headings.
- Placement decision: the unshowable-case passage sits directly after the refusal beat so the
  two refusals read as a pair — the product refuses him, the architecture refuses me. Moving
  it to the top turns it into a disclaimer, which is the one register it must not have.
- Numbers to keep verbatim: 14 / 0, 41.3%, 43% → 59%, twenty claims across eight sections.
- Words that must not appear as claims about the product: fair, unbiased, neutral, objective.
  Neutrality is shown procedurally (the swap gate, printed disagreement) or not at all.
