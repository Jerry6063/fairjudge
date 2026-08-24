# 05 — Design Framework v1

Synthesis of `docs/research/comparative-survey.md` (2026-08-17) against the repo's own corpus
(CLAUDE.md hard rules, doc 01 pipeline, doc 02 architecture, doc 04 UX plan, SPEC.md M5).
This document sits between doc 04 and execution: it settles what 04 left open, and it is written
to be executed by agents that did not read the survey — every decision carries its evidence inline.

Precedence used throughout: **CLAUDE.md hard rules > repo measurements (doc 02 §1.1a, SPEC M5
record) > survey evidence > survey suggestion.** Two survey patterns are overruled below on repo
evidence, and each overruling says so where it happens.

---

## 0. What this document settles

1. The two-party loop: six named states, what each party sees and cannot see in each, and which
   existing machinery carries each transition (§A.1).
2. The asymmetric-wait state: discrete acts, never live presence (§A.2).
3. A per-artifact-type privacy rule between partners (§A.3).
4. The non-response doctrine in one paragraph, including decline mechanics and re-invite rules (§A.4).
5. The `/respond/[token]` arrival contract (§A.5).
6. The multi-agent core: four seats, two adoptions, three rejections, one flagged deviation from
   doc 02, a $10 per-case ceiling with a named degradation order (§B).
7. Eight numbered amendments to doc 04 (§C).
8. Five questions only the user can answer (§D).

Two survey-level questions are closed here as side effects:
- **Survey open question 9 (refusal vs. AYTA envelope):** at L2 the answer is refusal-with-artifact,
  not the envelope. An envelope of readings ("harshest / most sympathetic / middle") on a one-sided
  record necessarily characterizes the absent party, which doc 01's L2 rule forbids ("no
  characterization of the absent party"). The envelope idea survives in one place only: the
  disagreement display at L1, where both parties have spoken and the spread comes from the swap
  pair rather than from invented readings (§B.1.d).
- **Survey open question 10 (firewall raw evidence vs. surface confirmed utterances):** fairjudge
  keeps the confirmed-utterance model. TheMediator.AI's full firewall (survey §3.1) removes the
  "you screenshotted me" injury but also removes contestability — a party cannot rebut a synthesis
  of words she cannot see. Hard rule 1 (only confirmed material is citable) plus the transparency
  view (SPEC M5 ④: every line attributed to her is shown to her) is the contestable version of the
  same protection. The judgment document is the only aperture through which one party's material
  reaches the other (§A.3).

---

## A. The two-person core

### A.1 The minimal two-party loop

Six states. Party A = the client (乙 in the real case), party B = the invited counterparty (甲).
Everything below runs on machinery that exists as of M5 except the two items marked **(new)**.

| # | State | What A sees | What B sees | What is hidden from whom | Carried by |
|---|---|---|---|---|---|
| 1 | **DRAFTED** | Own intake, evidence, v1 judgment at L2 (frozen) | Nothing; B does not know the case exists | Everything from B | Stages ①–⑨ (doc 01), `deriveOutputLevel` → L2, frozen v1 (hard rule 6) |
| 2 | **INVITED** | "Invitation created, not yet opened" + what the link contains | The link, in whatever channel A sent it | A's evidence store from B; B's existence from no one | `case_participants.invite_token_hash`, single-use, hashed, 14-day expiry (SPEC M5 ①) |
| 3 | **ARRIVED** | Nothing — opening the page is not an act and is not reported (see A.5) | Entry screen: what this is, who made it, the steelman of her own position, the data-about-her summary, a link to the shareable v1 | The judgment text is not inline (steelman first — SPEC 2026-08-10 decision); A's material not concerning her; A's clarification answers; safety-screen answers (author-only, SPEC M5 ④) | `/respond/[token]`, `buildCounterpartyEntry`, transparency view `/respond/[token]/data` |
| 4 | **DECIDED** | The recorded act: `refused`, or consent granted | Consequence of her act, stated before she takes it | — | Consent events (append-only); decline writes `respond_state` → `refused`; her act supersedes his report (SPEC 2026-08-12) |
| 5 | **HEARD** (her intake) | Discrete completed acts only: "she has submitted a statement", "her confirmation is complete" — never counts, never content (see A.2) | Her own intake: typed statement → per-line `ConfirmCard` confirmation → clarification (same ≤3×3 FSM, hard rule 4) → `case_record` grant | **A sees none of her content until publication.** Her rows stay `private`; consenting to be judged is not handing A her files (SPEC 2026-08-12: `submitStatement` grants `case_record` only) | `submitStatement`, `confirmOwnLine`, `deriveEvidenceGrade` (recollection → B), consent grant |
| 6 | **RE-HEARD → BOTH READ** | v2 at L1, simultaneously | v2 at L1, simultaneously | `self_only` shrinks at L1 to genuinely private annexes only (per-party self-reflection prompts); both responsibility findings go to both readers (ratifies SPEC 2026-08-14 recommended answer) | Either party files (`fileAppeal` per-actor), `hearAppeal` → `relockOutputLevel` → `version + 1`; **(new)** simultaneous release choreography |

Two loop rules that are decisions, not descriptions:

- **The re-hearing is offered, never auto-fired.** When her confirmed, granted material makes L1
  derivable, both parties see "the record has changed — a re-hearing is available" and either may
  file. Doc 01's post-judgment rule 7 ("a supplementary statement… triggers review and voids the
  original") is superseded in both halves: nothing is voided (hard rule 6 — v1 stands frozen and
  superseded), and nothing auto-runs — a ~$3.5 hearing both people will read must be an act someone
  chose, and the per-actor appeal machinery (SPEC M5 ⑤) already models it.
- **v2 releases to both parties at the same instant** (the **(new)** item). SyncWithLove is the
  survey's only designed instance and states why: *"nobody got to read first and prepare a
  rebuttal"* (survey §2.2, pattern 2). Sequential unlock manufactures exactly the grievance a
  judgment exists to retire. Mechanically: publication writes the rendition, then notifies both;
  neither party's read state gates the other's access.

### A.2 The asymmetric-wait state

While only A has spoken, the product is **a standing record with a named unblocking condition** —
Matterhorn's remand loop, not a countdown (survey §3.2: the judge "asks the parties for more
information, in which case the cycle restarts"; pattern 10c). The case page for A shows:

1. The frozen v1 and its level, with the level's reason stated as the key (doc 04 principle 2:
   "because only one person has spoken here — that changes if she answers").
2. The invitation's state as **discrete completed acts with timestamps**: created → (nothing) →
   consented/declined → statement submitted → confirmation complete → re-hearing available.
3. What A can still do that improves the record regardless of her: confirm remaining material,
   answer open clarification questions.

**What the product refuses to show, with reasons:**

- **A does not see B's progress.** No "she is on line 7 of 40", no live presence, no line counts.
  This deliberately rejects the survey's only prior art (SyncWithLove's *"partner is on question 7
  of 15"*, §2.2). SyncWithLove is a quiz between people at peace; fairjudge's waiter is a party to
  a conflict, and live progress on a rebuttal is surveillance of an adversary's drafting. Counts
  are also volume signals, and volume must never read as strength (survey pattern 9, verbosity
  bias; anti-pattern 6). Discrete acts are facts; presence is pressure.
- **A does not learn that B opened the page.** Rendering is not an act — the code already says so
  (`touch: false`, SPEC verification run). A reader who knows the sender is notified on open cannot
  safely read before deciding (see A.5).
- **B, before consenting, does not see A's evidence store, clarification answers, or anything not
  concerning her.** She sees what the case *says about her* (subject access, one clause wider than
  the read audience — SPEC M5 ④) and the shareable v1. Reason for showing v1 pre-consent: consent
  to answer a record you cannot read is not informed consent (ICODR Transparent — disclosure
  *before* participation, survey §3.5). Reason for hiding the rest: her arrival must not be a
  discovery channel into his files; the visibility model already enforces this in the query layer.
- **No deadline on the merits is displayed anywhere.** A timer next to a judgment implies the
  timer decides something. It never does (A.4).

### A.3 Privacy between partners, per artifact type

The single governing rule: **the judgment document is the only aperture.** One party's material
reaches the other only by being cited in a published judgment, quoted with grade and provenance
labels — never by browsing. Per type:

| Artifact | Owner sees | Other party sees | When |
|---|---|---|---|
| Evidence files / screenshots | Always | Never as files. Only the confirmed utterances a judgment cites, inside the document, provenance-labelled | On publication of the version citing them |
| Utterances | Own: always. Attributed-to-them: via subject access (SPEC M5 ④) | Confirmed ones, as quoted in a published judgment (hard rules 1, 5) | On publication |
| Clarification answers | Author only, permanently | Never. Facts they establish enter as claims with `evidence_refs`; the other party sees the claim, not the answer | Claims: on publication |
| Steelman versions | Both parties, once both are participants: each reads the strongest version of the *other's* position and of their own. Pre-consent, B sees only the steelman of B | — | B's own: at arrival (SPEC 2026-08-10). The rest: on consent |
| Safety-screen answers | Author only, disclosed-as-existing in limits, shown to no one else — including on subject-access | Never | Never (SPEC M5 ④; disclosure can endanger, whichever party asks) |
| Judgment sections, L2 | Client reads all; `self_only` criticism of the client stays with him | Counterparty receives the shareable rendition | Existing |
| Judgment sections, L1 | **Both responsibility findings belong to both readers.** `audience` becomes level-aware; only per-party self-reflection annexes stay private | Same document, both readers | Ratifies SPEC 2026-08-14: the L2 rule inverts at L1 and produced the ammunition case (each party got only the finding against the other) |
| Consent/participation acts | Both parties see the acts (grant, decline, revocation) — acts are case facts | Same | Immediately |

Two consequences worth stating:

- **Paired's both-submit lock, translated.** fairjudge cannot lock A's answers until B submits —
  the invitation is intrinsically post-hoc; v1 exists before B knows the case does. What *can* be
  blind is preserved exactly where anchoring does damage: B's intake is written before she can see
  anything of A's beyond the published v1, and A sees nothing of B's until simultaneous
  publication. The lock protects the unpublished, both directions (survey §2.1, pattern 1).
- **Withdrawal is recorded blanket, and recipient-scoped revocation is not offered.** This closes
  SPEC's open item 3. The verification run proved the half-working door: a recipient-scoped
  withdrawal blocked export but not `mintShareToken`, so one act answered differently at two
  doors. The act a person means by "stop sharing anything about me" is blanket; offering a shape
  the machinery half-honors is the Replika failure in miniature (behavior differs from what the
  user was told — survey anti-pattern 15).

### A.4 The non-response doctrine

**One paragraph, the doctrine:** A one-sided record licenses exactly three things — a description
of the record and its gaps, an evaluation of the submitting party's own conduct, and a statement of
what is missing and what supplying it would change (doc 01's L2 plus the upgrade list). It never
licenses allocation of responsibility, characterization of or motive-inference about the absent
party, or **any inference from the silence itself** — silence is not evidence, not acquiescence,
and not a waiver. When an invited party never answers, the consequence is purely procedural: the
invite token expires (14 days, existing), the case remains at L2 — it does not "decay" to L2, it
never left — and v1 stands frozen. Nothing about the merits moves, ever, on a timer. Evidence:
Utah is the measured counterexample — a mandatory ODR that converted 14 days of silence into
default judgment moved default rates 43%→59% (62% for institutional plaintiffs) and transferred
outcomes to whoever files most fluently (survey §3.0); every other real ODR timeout found
terminates procedurally, never in a finding (survey §3.8b). The existing L2 machinery already obeys
this — L2 limits scope rather than allocating — and the M5 relock rule extends it in the honest
direction: the level relocks *down* as well as up when a revocation removes the second side (SPEC
verification run), which is this doctrine applied in reverse.

Mechanics settled around the doctrine:

- **Token expiry is credential hygiene, not a case event.** A live single-use credential sitting in
  a chat thread should die; the case notices nothing. A may re-mint after expiry — one live token
  at a time, re-minting is A's recorded act, and **the system never nudges B.** Matterhorn's remand
  loop has a court's authority to summon; fairjudge has none, and an automated nudge cadence aimed
  at someone who owes the system nothing is the Utah fluency advantage rebuilt in miniature.
- **A recorded decline closes A's minting for that participant.** No re-invite stream after a
  refusal — invite-spam is harassment with case-management UI. Her decline simultaneously converts
  her link from a single-use invite into her **standing personal door** (no expiry, revocable by
  her) to the transparency view and to reversing her decision. A decline that cannot be reversed
  by its author is a trap in the other direction; the consent machinery already prefers suspension
  to burning (SPEC 2026-08-12: "the link is suspended rather than burnt").
- **A decline appears in later documents as a participation fact, never as color.** "Invited
  2026-08-20; declined 2026-08-24" in the limits section — in the same register as any other
  record-basis count, with no adverse-inference wording. Her own act supersedes his report
  (`refused` over `unreachable`), and `purge:operator` leaves her refusal where she put it.

### A.5 What arrival must answer

The `/respond/[token]` reader is a person in conflict with the sender, holding a link she did not
ask for. The first screen answers four questions in order, before any ask:

1. **What is this** — the positive scope claim before the limits, TheMediator.AI's register
   (survey §3.1: *"a communication facilitator, not a judge, lawyer, or court"* — say what it is,
   then what it is not). Procedure stated in advance, ICODR Transparent (survey §3.5).
2. **Who made it and what it already says about you** — the steelman of her own position first
   (the one artifact proving the system argued her side before she arrived — SPEC 2026-08-10),
   then the data-about-her summary with provenance, then the shareable v1, linked not inlined.
3. **What happens if you close this tab** — nothing. Nothing is reported to the sender; the page
   does not record reading as an act (`touch: false`). This sentence is on the screen because a
   reader who suspects open-tracking cannot read freely, and free reading is the precondition for
   everything else.
4. **What each exit does** — three exits of equal visual weight: consent and add your side;
   decline (recorded as your act; the case stays one-sided and says so; your door stays open);
   read everything first (transparency view). Refusability without penalty means concretely: no
   merits consequence, no adverse wording, no further invitations (A.4), and the decline is
   reversible by her alone.

What refusing does to the case record, stated on the decline confirmation itself: participation
becomes `refused` by your own act; the existing judgment stands unchanged at its one-sided level;
future versions state "invited, declined" as a fact and may not infer anything from it; you keep
this door.

---

## B. The multi-agent core

### B.1 Which stages get multiple agents — adopt/reject, with cost deltas

Baseline for arithmetic: an ordinary one-sided case measures **$2.25** (doc 02 §1.5, re-checked
2026-08-16; judgment skeleton+narrative is $0.91 of it); the one measured L1 re-hearing cost
**$2.57** at effort max (SPEC M5 ⑥). The survey's three reference architectures: MAD's structural
adversarialism (§4.1), ChatEval's panel with separated verdict emission (§4.3), Perspectives'
blind-proposals-before-debate (§4.7).

**a. Per-party steelman as a blind adversarial pair — ADOPT, at L1 hearings only.**
Two agents, one brief per party, each arguing that party's strongest case from the record; neither
sees the other's output; both briefs are inputs to the skeleton. This is MAD's core lesson made
structural — *"an instruction to be balanced does not produce balance"* (survey pattern 6) — and it
is Perspectives' blind-proposal rule applied to agents (survey §4.7). At L2 the existing single
steelman-of-the-absent-party (doc 01 stage ⑤) already is the advocate and stays a single call: with
one party's material there is nothing for a second advocate to argue from.
**Cost: +2 fable calls at effort high ≈ +$0.5 per L1 hearing (~×1.2 on the hearing).**

**b. The swap test as a standing gate — ADOPT; this is the promotion, see B.2.**
**Cost: the swap pass was always budgeted (doc 02 §1.5, medium, cold price ≈ $0.4–0.5) and has
never executed; running it adds ~×1.2 to a hearing. Worst case adds one max-effort re-hear ≈
+$2.5, bounded at one (B.2).**

**c. A panel of independent verdict emitters for the responsibility allocation — REJECT.**
Three reasons, one decisive. (1) CLAUDE.md fixes the vendor surface at Anthropic only, and fable
accepts no sampling controls (doc 02 §1.7) — so a "panel" is fable/opus re-rolls differentiated by
persona brief, which is agent-count theater, not the cross-family independence that made Berkeley's
seven-model disagreement informative (survey §1.8). (2) Cost: +2 skeleton-class emissions ≈ +$3.6,
×2.4 on the hearing, for correlated votes. (3) The independent-seatings requirement is already
satisfied cheaper: the A-first and B-first swap runs *are* two independent emissions of the
allocation by construction, and the blind advocate pair supplies the opposed readings. The panel
fairjudge can defend is **four seats it already pays for**: advocate-A, advocate-B (blind, opposed
briefs), and the judge run twice through both seatings.

**d. Disagreement display instead of collapse — ADOPT, render layer, no model cost.**
Where the four seats diverge — the two advocates' irreconcilable readings, any swap-pair delta
under threshold — the judgment renders the spread instead of averaging it (ChatEval retains every
evaluation, survey §4.3; AYTA displays the labelled envelope, §1.6; pattern 12: *"the spread across
judges is the confidence interval"*). PandaLM's conflict→tie rule (survey §5.3) governs
aggregation: contradictory readings are reported as contradiction, never averaged into confident
middle. **Cost: $0.**

**e. Iterated multi-round agent debate — REJECT.**
MAD supplies the framing (Degeneration-of-Thought) but its debate loop is not adopted: Berkeley
measured models resisting position change under challenge (survey §1.8, anti-pattern 8 —
"apparent consensus may just be entrenchment"), and rounds multiply cost without a measurable
convergence guarantee. fairjudge takes MAD's structure (opposed briefs) and replaces the debate
with **independent generation compared in code** — the comparison is deterministic, auditable, and
free.

**f. LLM entailment/consistency checking — REJECT, on the repo's own measurement.**
This overrules the survey's candidate list with local evidence, per the precedence rule: the opus
entailment guard ran six times on real output, caught nothing, passed reproducible hedge-deletion,
and cost 7× the call it guarded (doc 02 §1.1a — "a guard that passes hedge-removal is not evidence
of safety"). Consistency checking stays where it already works: deterministic code —
`checkLevelConstraints`, the citation audit, `findNumericResponsibilitySplits`, the golden harness.

### B.2 The swap test's promotion — gate on publication, not on level

Today the swap test annotates and, above threshold, flags + re-hears (doc 02 §1.2). The survey's
number says annotation is not enough: the median model flips its choice in **41.3%** of decisive
swapped-order pairs, with a 64.3% first-shown preference (survey §5.2) — and party A always files
first (survey §4.5's first-mover asymmetry). A verdict that reverses when the seats are exchanged
is not a verdict.

**Decision: swap failure blocks publication of the responsibility allocation. It never touches the
level.** Hard rule 2 makes `deriveOutputLevel` a pure function of (participation, evidence,
safety); feeding swap results into it would make the level depend on a model output, which is the
architectural line the rule exists to hold — so the survey's suggestion that swap results feed the
L-grade (survey §5.2, pattern 8) is **explicitly not adopted in that form**. Instead the swap
result becomes a *validity precondition on the artifact*, enforced where artifact validity already
lives (`checkLevelConstraints` and the publication gate, both code):

1. Skeleton generated (A-first seating). Swap pass regenerates the allocation from the same inputs
   with identities and the address-term dictionary exchanged, **without seeing the first pass's
   output** — independence is the measurement's precondition (position_bias rates both orders
   independently; if the current implementation feeds pass 1's skeleton into pass 2, that is a bug
   against the method and is corrected by this section).
2. Delta ≤ threshold → publish, with the swap result disclosed in limits.
3. Delta > threshold → one re-hearing at effort max (doc 02 §1.2's existing remedy), swap-tested
   again.
4. Still > threshold → **publish with the allocation withheld**: the document ships at its level,
   states that the allocation was withheld because the finding did not survive exchanging the
   parties' positions, and shows the two readings as the disagreement display (B.1.d). The
   level is untouched; L1 still licenses allocation — this generation failed to earn it. A
   refusal must hand over an artifact (survey pattern 10), and this one hands over the most
   legible artifact possible: the flip itself.

`DEVIATION(doc 02 §1.2)` — amendment text for doc 02: *"The swap test is a publication gate, not
an annotation: a responsibility difference above threshold triggers one re-hearing at effort max;
a second exceedance publishes the judgment with the responsibility allocation withheld and the
swap disagreement disclosed in its place. The case's output level is unaffected (hard rule 2);
the gate is enforced in `checkLevelConstraints`/publication validation alongside the numeric-split
scan. The swap pass receives the same inputs as the primary pass with identities and address-term
dictionary exchanged, and must not receive the primary pass's output."* Per repo convention, doc 02
is updated before code changes.

Silent downgrade is the failure mode this design avoids by construction: the withholding is
announced in the document, in the same breath, with its ground (survey anti-pattern 15 — Replika's
*"Let's change the subject"*; pattern 10d).

### B.3 Blind independence — who is withheld from whom

Perspectives' rule ("blind proposals first" — survey §4.7) plus AutoGen's lesson that visibility
is enforced in the message graph, not by prompt discipline (survey §4.6, pattern 14). fairjudge's
enforcement point is the existing query-layer visibility model plus per-stage input assembly.
Concrete withholding table:

| Stage | Receives | Withheld, deliberately |
|---|---|---|
| Advocate-A brief | A's citable material, case file, issues list | Advocate-B's output; any draft skeleton; B's clarification answers (cross-party, always) |
| Advocate-B brief | B's citable material, case file, issues list | Symmetric |
| Skeleton pass 1 (A-first) | Both briefs, full citable record | Nothing else exists yet |
| Swap pass (B-first) | Same inputs, identities + address-term dictionary exchanged | **Pass 1's output** (B.2) |
| Narrative | The validated skeleton | The rejected/withheld allocation content, if the gate fired |
| Human: B's intake | Her own material, the published v1, subject-access items | A's evidence store, A's clarification answers, drafts (A.3) |
| Human: A during HEARD | Discrete acts | B's content, counts, presence (A.2) |

Mechanism: every stage call declares an **input manifest** (the list of ids serialized into its
prompt — the byte-stable serialization discipline already exists for cache reasons, CLAUDE.md
conventions), and the manifest hash is recorded on the `llm_calls` row. "What did this agent see"
becomes a ledger answer, not a prompt-reading exercise. Withholding is free — fewer tokens — and
cache-friendlier.

### B.4 The honest multi-agent story (printable)

> fairjudge's judgment is produced by four seats, not one mind. Two advocate agents receive
> opposed briefs — each argues one party's strongest case from the confirmed record, blind to the
> other's output — because asking a single model to "consider both perspectives" measurably
> produces hedged consensus, and a single self-reflecting model fails in three named ways the
> literature calls Degeneration-of-Thought: distorted perception, resistance to revision, no
> external feedback. The judge then emits its finding twice, once from each party's seating, with
> the parties' identities exchanged; the median LLM reverses its preference in 41.3% of such
> swapped pairs, so agreement between the two seatings is a load-bearing check, not a formality.
> The seats never debate each other — measured deliberation shows models entrench rather than
> converge — their outputs are compared in deterministic code, and where they disagree, the
> disagreement is printed, not averaged. The biases are instantiated and labelled rather than
> claimed away: there is no neutral seat, only opposed seats whose construction is disclosed. What
> this is not: a jury of vendors, a crowd, or a debate club. It is the smallest number of agents
> that makes one-sidedness structurally visible — and when the seats cannot agree, the product
> says so instead of picking one.

(Register per AYTA, survey §1.6: instantiate the bias and label it, never claim neutrality.
Citable numbers: 41.3% flip / 64.3% first-shown, survey §5.2; DoT, survey §4.1; entrenchment,
survey §1.8.)

### B.5 Cost ceiling

**The full architecture must fit $10 per case**, all versions included. Arithmetic against
measurements: one-sided case with swap pass ≈ $2.7; her intake + her clarification budget ≈ +$0.5;
L1 re-hearing with advocate pair and swap pass ≈ $2.57 + $0.5 + $0.5 ≈ $3.6; worst case one
swap-failure re-hear at max ≈ +$2.5. Total worst case ≈ **$9.3**. (All per-stage figures are N=1
per doc 02 §1.5's own warning; the ceiling is the commitment, the estimates are not.)

**Degradation order when a case would exceed $10** — cut in this order, disclose each cut in the
document's limits section (anti-pattern 15: no silent state changes):

1. The swap-failure re-hear (step 3 of B.2): go directly to withhold-allocation. Cheaper *and*
   more honest than paying $2.5 to retry what may be a coin flip.
2. The advocate pair collapses to the single combined steelman call (the pre-M5 shape).
3. Post-judgment documents defer to opus Batches at half price (already doc 02 §1.5).

**Never cut, at any spend:** the swap pass itself (it is the product's honesty instrument), the
deterministic validators, the pseudonymization gateway, and the crisis path (deterministic,
zero-LLM, hard rule 9 — it costs nothing to keep).

---

## C. Amendments to doc 04

Format: what 04 says → what it should say → forcing evidence.

1. **Hero-screen order: the refusal becomes three screens and moves up.** §6.5 ranks "a refusal
   state" sixth of six → the refusal is a triptych — capability ("only one side has spoken"),
   uncertainty ("the finding did not survive the swap / the evidence contradicts itself"), policy
   ("this is the wrong instrument; here is the referral") — and the triptych takes hero position
   3, after the record-basis `0` and the judgment document; intake's question, the share diff and
   evidence confirmation follow. → Forced by: the survey's central gap finding ("nobody refuses
   well" — §4.1, §4.8b: "the most under-explored design surface identified in this entire
   survey"), and the three-kind taxonomy with three different emotional messages (§6.6:
   "collapsing them into one generic screen is the mistake"). Doc 04 §4.6 already wanted these
   "the best screens in the product"; the hero list contradicted it.

2. **Neutrality is signaled by procedure stated in advance, and the adjective is banned from UI
   copy.** §4.1's intake states what the product refuses → intake additionally carries the
   advance-disclosure card: the procedure, what each level licenses, what participation changes —
   before any evidence is requested; and no surface ever describes the product or its output as
   "fair", "unbiased", "neutral" or "objective" — the name `fairjudge` is the last place that
   adjective appears. → Forced by: Matterhorn signaling neutrality by procedural equivalence,
   never by adjective (§3.2, pattern 10b); ICODR Transparent — disclosure before participation
   (§3.5); anti-pattern 2 (the *"Unbiased: No taking sides"* product that outputs 80/20 from one
   side).

3. **The asymmetric-wait state enters Wave 5 scope with its own acceptance line.** §5 Wave 5 lists
   the counterparty surfaces only → Wave 5 gains A's side of the same period: the waiting surface
   per §A.2 (discrete acts, named unblocking condition, no presence, no counts), accepted when *"a
   person whose counterparty has not answered can say what is happening, what is not being shown
   to them and why, and what would change the case's level."* → Forced by: gap 7 (§4:
   "fairjudge's hardest and most ownable screen"; the only prior art is a quiz app), and the
   deliberate rejection of live presence for a conflict product (§A.2).

4. **The referral screen offers graded next steps, hotline last.** §4.6 names "the safety referral
   path" as one refusal state → the policy-refusal screen orders its offers by measured uptake:
   something to do now (grounding), something structural (a safety plan / next step), the external
   handoff (988 call *and* text/chat) last — all deterministic content, preserving hard rule 9's
   zero-latency no-LLM path; detection confirms with the user before escalating (Wysa's
   confirmation gate). → Forced by: Wysa's uptake table — safety plan 49.2%, grounding 46.6%,
   hotline **2.4%** (§6.2: "a crisis referral that is only a phone number is, empirically, a
   referral to nothing"); confirm-before-escalate (§6.2); pattern 10f.

5. **Every exported rendition carries a non-removable provenance-and-redistribution notice.** §4.5
   designs the share diff and consent gate but no rule rides on the artifact itself → every
   shareable/exported document carries, in the document: *"An AI-mediated document, not a human
   judgment. Produced at level ⟨L⟩ on ⟨N⟩ confirmed items — ⟨basis summary⟩. Do not present this
   as a neutral third party's finding."* (wording per level; the one-sided label doc 01 already
   mandates at L2 merges into this notice). → Forced by: AYTA's redistribution rule attached to
   the artifact (§1.6: *"please do not share these as human judgements"*), pattern 11, and
   anti-pattern 4 (any verdict is manufactured ammunition; the notice travels with the ammunition).

6. **Act II of the showcase walks the full loop, including the wait.** §6.3 compresses Act II to
   "the counterparty arrives, consents, speaks" → Act II demonstrates the state machine of §A.1:
   the invitation, A's wait surface (what it shows and refuses to show), arrival, the pre-consent
   read, decline-as-first-class (shown once in the fixture before the consent path), her blind
   intake, and the simultaneous release of v2. → Forced by: the wait state and refusal states are
   the two most differentiated surfaces the survey found (§4 gaps 7 and 8b); a demo that skips
   them demos the parts competitors also have.

7. **Wave 5's consent gate adds the simultaneous-release rule.** §4.5's share flow is
   sender-initiated unlock → the re-heard version publishes to both parties at once; neither
   party's reading gates the other's; the share diff remains for what *else* A may send. → Forced
   by: SyncWithLove's simultaneity ("nobody got to read first and prepare a rebuttal", §2.2,
   pattern 2) — for a conflict product, sequential unlock is itself a grievance generator.

8. **The decline path gets its full mechanics in Wave 1's `/respond` work.** §5 Wave 1 accepts
   when "a test reader arriving cold can decline without confusion" → the acceptance additionally
   covers §A.4/A.5 mechanics: decline recorded as her act, A's minting closed, her link converted
   to a standing revocable door, the no-open-tracking sentence rendered on the entry screen, and
   the decline wording in later documents limited to participation fact. → Forced by: the Utah
   doctrine (§3.0 — silence and refusal must be procedurally inert), ARSH (§6.6 — a refusal
   delivered badly teaches people not to return; here the refuser must not be punished for
   refusing), and anti-pattern 11 (the unjoined-partner state is universally undesigned — this is
   the designed version).

Ruled on and **not** amended: doc 04's "no warmth / no gamification / no dashboards" (§7) stands —
the survey's Woebot "sitting with open hands" register (§6.1) is compatible with precision-as-
respect and requires no softening pass; and doc 04's portfolio thesis (§6.1) already matches the
survey's strongest positioning claim (gap 1) and needs no change beyond amendment 6.

---

## D. Open questions that require the user

1. **The $10 per-case ceiling and funding the standing appeal.** §B.5's ceiling and the one
   `hearAppeal` call that closes M5 both spend real money on a real account. Approve the ceiling
   (or set a different number) and fund the account; nothing in §B ships before the number is
   yours.
   **ANSWERED 2026-08-17 (user): approved at $10.**
2. **L1: is ownership enough, or must the client have spoken?** SPEC (2026-08-14) records that L1
   promoted with `citableUtterances.byClient = 0`. Requiring a citable client voice is arguably
   truer to "both sides heard" — but it would relock the real case down from L1 today. Because it
   changes the pure function's inputs (hard rule 2 territory) *and* re-grades your own live case,
   it is your call, not an agent's. Framework's recommendation: require it; the record-basis `0`
   was the product's most honest sentence.
   **ANSWERED 2026-08-17 (user): ownership is enough — the recommendation is overruled and
   `deriveOutputLevel` stands as built. The zero stays a disclosure, not a gate.**
3. **Inviting the real counterparty.** All of §A is exercised by fixture personas. Sending a real
   invitation remains a real-world act that only you perform (M5 scope boundary; doc 02 §3.1's
   consent question is still the first-ranked open item). §A.4's anti-badgering rules bind you
   too: one live token, no nudges, a decline closes minting.
4. **Where `/respond` runs when it runs for real.** The two-person loop is localhost-only until
   M5b's at-rest encryption decision (SQLCipher has no automatic Postgres equivalent — SPEC M5
   preamble). A real invitation requires this settled first; it changes what §A.5 can honestly
   promise about custody of her data.
5. **Adopting ICODR publicly.** The nine ICODR standards (survey §3.5) are a ready-made external
   rubric — adopting them on the record strengthens the procedural-equivalence claim (amendment
   2) but commits to auditable process and human oversight ("Accountable"). Positioning
   commitment with ongoing obligations: yours to make.
