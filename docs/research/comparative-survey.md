# Comparative survey — how others build judgment, mediation, and two-person products

**Date:** 2026-08-17
**Prepared for:** fairjudge redesign (two-person evidence intake → evidence-graded LLM judgment, with refusal-by-default when only one party has spoken)

## Method note

Sources are marked two ways throughout:

- **Plain statement** = taken from a page I actually fetched and read (App Store listings, repo READMEs, arXiv abstracts, article bodies, `gh api` responses).
- **`(snippet only)`** = seen only in a search-result summary. Treat these as leads to verify, not as facts. Star counts and user numbers are either from a fetched page / `gh api` call, or explicitly marked.

Research ran as three parallel streams (main survey: categories 1, 2, 4, 5; two sub-agents: category 3 ODR, category 6 safety/refusal UX). All three completed.

Dead or blocked links encountered (noted so nobody re-burns time on them): `whowon.storqlabs.com` (403), `disputron.ai` (403), `junkee.com/am-i-the-asshole-reddit/328221` (403), `aijudge.me` (DNS failure), `apps.apple.com/.../settleitgpt/id6743547528` (404 — the ID returned by search was wrong), `news.ycombinator.com/item?id=46960241` (429), `colinrule.com/writing/negjo.pdf` (DNS failure on both host variants — **so no "four ODR principles" attributed to Colin Rule could be verified, and none is asserted anywhere in this report**), `neweraadr.com/our-tech` (404), `getmatterhorn.com/.../Matterhorn_Outcomes_White_Paper.pdf` (301 to a marketing landing page; the white paper appears retired post-Catalis merger), `wysa.com/role-of-ai-in-sos` and `wysa.com/clinical-evidence` (403, two attempts each), `mobihealthnews.com` (403), arXiv:2512.18776 PDF (undecodable binary; abstract fetched).

Nothing below is invented. Where a number could not be verified, that is stated rather than filled in.

---

# 1. Per-project entries

## Category 1 — Consumer "AI judges your argument" products

This category is **crowded and shallow**. There are many shipping products; almost all of them are one-sided (only the complainant submits), entertainment-framed, and optimized for a shareable verdict card. That is the single most important finding in this survey: *the closest competitors have already conceded the exact thing fairjudge refuses to concede.*

### 1.1 Let's Settle This (iOS)

- **Traction:** 5.0 stars from **1 rating**. Free. 9.1 MB. Category: Entertainment. Developer: Ian SMITH. Effectively pre-traction.
- **What it does:** Multi-party argument judging, 2–5 participants, on one device.
- **DESIGN takeaways — the most relevant entry in this whole category:**
  - It solves two-person intake with **pass-the-phone**, not with invites: *"pass the phone to each person so they can privately type their side of the story without the other person seeing."* This is the cheapest possible answer to the two-person problem and it completely sidesteps accounts, invites, notifications, and async waiting. It also assumes co-location.
  - **"private input so no one sees what others typed"** — the privacy boundary is enforced by the physical device handoff.
  - **16 judge personas** as the product's variety axis: Clinical Psychologist, Marriage Counselor, Wise Grandparent, Federal Judge, World Class Arbitrator, Seasoned Diplomat, Socratic Philosopher, Tough Love Life Coach, Impartial Referee, Zen Master, Retired FBI Negotiator, Wise Village Elder, Stoic Philosopher, Forensic Investigator, AI Jesus, Jewish Rabbi. Note that persona *is* the product differentiation here — not evidence handling, not rigor.
  - **Privacy as headline copy:** *"Your arguments never leave your device"* — it runs on **on-device Apple Intelligence**. This is a direct precedent for fairjudge's local-first positioning being marketable, not just an engineering choice.
  - **No stated handling of the one-party case.** The listing does not describe what happens if only one person types.
  - **No entertainment-vs-advice disclaimer** in the listing, despite personas named "Clinical Psychologist" and "Marriage Counselor." That is a liability gap, and an opening.
- **CODE takeaways:** On-device Apple Intelligence (Foundation Models framework) is evidently sufficient for this class of output at 9.1 MB app size — i.e. the judging workload here is a single small-model call, not a pipeline. fairjudge's multi-stage pipeline is far heavier than what the market currently ships.
- **Link:** https://apps.apple.com/us/app/lets-settle-this/id6762212267

### 1.2 Verdict: AI Conflict Solver (iOS)

- **Traction:** Insufficient reviews for an average rating to display. Free with IAP **$9.99–$159.99** (monthly/annual "Pro" and "Diamond" tiers). Developer: CUNEYT CUNEYDIOGLU. v1.0 released January 21; last update v2.2.0 on May 6 ("UX improved - bugs fixed").
- **What it does:** One-sided AI verdict on partner disputes, friendship misunderstandings, workplace drama.
- **DESIGN takeaways:**
  - **Three intake modalities**, and the framing of each is instructive: *"Upload screenshots of your texts, record a voice note, or simply write down what happened."* The voice pitch is *"Record your story as if you're talking to a friend. Verdict listens, transcribes, and analyzes your voice."* — i.e. intake is deliberately made to feel like venting, not like filing.
  - **Only the complainant submits.** The other party never participates. This is the industry default.
  - **Output is a blame split:** *"determines a fair verdict (e.g., You: 80% / Them: 20%)"*. A numeric responsibility allocation, derived from one side's account. This is precisely the output fairjudge refuses to produce under those conditions.
  - **Community voting** as an appeal/challenge layer on top of the AI verdict — crowd as second instance.
  - Neutrality is claimed by assertion, not by mechanism: *"Unbiased: No taking sides. Just pure logic and emotional intelligence."* Note the incoherence — a product that outputs "You: 80% / Them: 20%" is by definition taking sides.
- **CODE takeaways:** Screenshot → OCR → analysis, plus ASR for voice. Same intake pipeline shape as fairjudge, minus any confirmation step (no evidence that the user reviews/corrects the OCR output).
- **Link:** https://apps.apple.com/us/app/verdict-ai-conflict-solver/id6757810106

### 1.3 AI Judgement (iOS)

- **Traction:** No ratings data. Free. 340.9 MB. Developer: toru sugitani. Categorized under "Word" (miscategorized). EN/JA.
- **What it does:** *"Everyday arguments, relationship conflicts, workplace issues - let AI Judge settle everything."* One-sided input.
- **DESIGN takeaway — the disclaimer is worth copying the *shape* of:** *"This app is for entertainment purposes only, simulating AI-based verdicts. It does not provide actual legal advice or information about real laws and precedents."* This is the standard defensive posture in this category: claim entertainment, disclaim advice. **fairjudge cannot use this shield** — a product that refuses to judge on principle is implicitly claiming to be serious. That means fairjudge must carry a *different* boundary statement (what it is not for, when it will not answer), which is a design deliverable, not a legal footnote.
- **Link:** https://apps.apple.com/us/app/-/id6748558666

### 1.4 WhoWon (Storq Labs) `(snippet only)`

- **Traction:** unknown — site returned 403, no numbers obtained.
- **What it does `(snippet only)`:** Upload a text screenshot; AI declares who won the exchange; produces a shareable **"verdict card"** for TikTok/Instagram/Twitter. Claims "detailed power dynamics analysis" and that screenshots are "processed securely and never stored."
- **DESIGN takeaway:** The **verdict card as the distribution mechanic** is the growth engine for this whole category — the artifact exists to be posted, and posting means publishing your partner's messages. This is the sharpest ethical contrast available for fairjudge's consent gate: the competitive default is *frictionless public exposure of the other party*, and fairjudge's consent gate is the exact inverse. That contrast is a portfolio narrative, not just a feature.
- **Link:** https://whowon.storqlabs.com/ (403 to automated fetch)

### 1.5 InstantVerdict, aijudge.pro, thecourthouse.ai, wram.chat, Disputron, Angie "Couples Court" `(snippet only)`

Grouped because I could not fetch any of them meaningfully; all are corroborating evidence of category density rather than individual case studies.

- **InstantVerdict** — *"settles arguments with verdicts backed by actual law from your country"* `(snippet only)`. https://instantverdict.com/
- **Disputron** — "AI-powered small claims court"; users *"watch AI lawyers battle it out in real time"*, an AI judge delivers a verdict that can be **shared or appealed** `(snippet only)`. The "watch the lawyers argue" mechanic is the only consumer product found that exposes the deliberation process rather than just the conclusion — worth revisiting. https://disputron.ai/ (403)
- **Angie / Couples Court** — *"bring a dispute, plead your case on camera, snap photo evidence, and let an AI judge deliver the verdict"* `(snippet only)`. Game-framed, realtime, co-located, camera-based. https://getangie.com/court (page returned title only)
- **thecourthouse.ai** — Show HN, "AI Courtroom to settle arguments with your family this X-mas", **1 point, 0 comments**. https://news.ycombinator.com/item?id=46379952
- **wram.chat** — Show HN, "Settle any argument with a friend – an AI judge decides who's right", **1 point, 3 comments**. https://news.ycombinator.com/item?id=48874871

**Note on HN traction:** every "AI settles your argument" Show HN found scored 1–2 points with ~0 comments. This category has *zero* technical-community traction despite many App Store entries. Interpretation: it reads as a novelty, and novelty framing is what's capping it.

### 1.6 AYTA — "Are You The Asshole?"

- **Traction:** Not obtained (the Junkee coverage 403'd; the site itself was fetched).
- **What it does:** An AITA-parody generator built from **three separately-trained models**.
- **DESIGN takeaway — the single most interesting idea in category 1:**
  - **Model 1 (red)** trained *only* on YTA responses — "will always say you are at fault."
  - **Model 2 (green)** trained *only* on NTA responses — "will always absolve you."
  - **Model 3 (white)** trained on pre-filtered/mixed data.
  - The three verdicts are shown together. **The bias is not hidden and corrected — it is instantiated, labelled, and displayed.** The user sees the maximally-condemning read, the maximally-exonerating read, and the middle, and has to hold all three. This is a legitimate alternative to fairjudge's "refuse when one-sided": instead of withholding, you show the *envelope* of possible readings and make the width of that envelope the honest signal.
  - Explicit self-disclosure: *"AYTA is meant to be imperfect, biased, and most importantly completely fabricated."* And a use-rule: *"Please do not share these as human judgements, and make sure you link back to this site so people can understand what they are reading."* — a **redistribution rule attached to the artifact**, directly analogous to fairjudge's consent gate.
- **Link:** https://areyoutheasshole.com/

### 1.7 The real incumbent: ChatGPT itself (and its documented backlash)

This is not a product entry but it is the actual competitor, and it is the best-documented failure mode available.

**Futurism, "ChatGPT Is Blowing Up Marriages as Spouses Use AI to Attack Their Partners" (2025-09-18)** — fetched. Documented harms:

- **One-sided validation loops:** partners feed grievances in, get confirmation back, then deploy the output as evidence in the argument. A therapist quoted: *"It's not giving objective analysis. It's only giving her back what she's putting in."*
- **The AI as a cited authority against a partner:** *"ChatGPT said that you're not a supportive partner, and this is what a supporting partner would do."*
- **Volume asymmetry as a weapon:** *"There is no way to communicate when somebody's using this tool that can create 30 pages in a heartbeat to defend themselves."*
- **Dialogue replacement:** *"It's being leveraged like 'ChatGPT said you're wrong,' rather than actual dialogue between partners."* and *"He just shares these outputs that ChatGPT writes...instead of engaging with me."*

**HuffPost, "Couples Are Already Using ChatGPT To Solve Arguments. Here's How To Do It Fairly." (2024-11-05)** — fetched. Therapists interviewed:

- Melanie McNally (psychologist): *"people structure the prompts from their own biased perspective, [so] the responses could also be biased"* — the model won't challenge your role unless asked.
- Natalie Grierson (counselor): the partner *"may feel 'duped' and betrayed if they find out"* — i.e. **covert use is itself the injury**, independent of the verdict's accuracy.
- Janet Bayramyan (trauma therapist): *"'Fair' fighting requires both parties to be present, listen and express feelings authentically"*.
- Their recommended safe use is **before** a conflict (rehearsal, skill-learning, emotional processing), not during it as an adjudicator.

**Link:** https://futurism.com/chatgpt-marriages-divorces · https://www.huffpost.com/entry/chatgpt-argument_l_6729047ce4b05debb72b89a2

### 1.8 UC Berkeley D-Lab — do chatbots have a moral compass?

- **Traction:** Academic; covered by Berkeley News 2025-09-10. Pre-print: https://arxiv.org/abs/2501.18081
- **What it is:** Pratik Sachdeva and Tom van Nuenen (UC Berkeley D-Lab) ran **over 10,000 real AITA moral dilemmas** through **seven LLMs**: GPT-3.5, GPT-4, Claude Haiku, PaLM 2 Bison, Gemma 7B, LLaMa 2 7B, Mistral 7B.
- **Findings relevant to fairjudge:**
  - The **consensus** of the seven roughly tracked Reddit's collective verdict, but **individual models frequently disagreed with each other.** → A single-model verdict on a moral dispute is not stable; agreement across models is doing real work. This is a direct argument for a panel architecture and for surfacing inter-judge disagreement as a confidence signal.
  - GPT models **resisted changing their moral judgments when challenged by other models** in follow-up deliberation. → Naive multi-agent debate does not automatically produce convergence; stubbornness is a failure mode you have to design around (see §1.6 of category 4).
  - Sachdeva: *"Through their advice and feedback, these technologies are shaping how humans act, what they believe and what norms they adhere to."* and *"We want people to be actively thinking about why they are using LLMs...and if they are losing the human element."*
  - van Nuenen: *"The situations are messy, and it's that messiness that we wanted to confront large language models with."*
- **`(snippet only)`, needs verification:** a separate figure circulating in search results claims AI "misjudged the moral standing of the posters 42% of the time, often siding with the poster when human Redditors disagreed," and that ChatGPT matched community judgment in only 5 of 14 recent posts, with Grok and Claude at 2–3 of 14. I could not confirm these against a primary source and they may come from a different, smaller study. **Do not cite these numbers without verifying.**
- **Link:** https://news.berkeley.edu/2025/09/10/do-chatbots-have-a-moral-compass-researchers-turn-to-reddit-to-find-out/

---

## Category 2 — Two-person / couples apps (the two-person UX mechanics)

Treated as first-class per the brief. The finding here is much better than category 1: **the two-person mechanics problem is solved, repeatedly, and the solutions converge.**

### 2.1 Paired — the reference implementation

- **Traction (fetched from App Store):** **4.7/5 from 206K ratings**. **"8 million downloads"** (developer claim in the listing). **Apple App of the Day, January 2024.** Developer: Better Half Limited. Rank **#196 in Lifestyle (iPhone)**. Free with IAP: Premium monthly **$14.99**, annual **$39.99–$74.99**. `(snippet only)` HN records a $1M funding round at launch: https://news.ycombinator.com/item?id=24674475
- **DESIGN takeaways — this is the mechanic to steal:**
  1. **Locked-until-both-answer.** From the listing: users *"unlock your partner's responses"* only after both answer. A user review the listing surfaces states the rationale exactly: *"our answers to the 'question sets' are locked until we both answer so that we aren't biased by what the other person's response is."* **The blindness is the feature, and users articulate the reason unprompted.** This is enormous for fairjudge: it means the "you must submit before you can see" constraint is not experienced as a gate, it is experienced as *fairness*, and the audience already understands why.
  2. **Pairing is a 6-character code plus a link.** From Paired's own support docs: *"Your Pairing link and code are unique to your Paired profile. The code is made of 6 characters (letters and/or numbers)."* Surfaced at account creation and via an explicit **"Invite Partner"** button placed **after the first onboarding question** — i.e. the user experiences value once *before* being asked to recruit their partner. That ordering is deliberate and worth copying.
  3. **What happens if the partner never joins is undocumented** — not in the App Store listing, not in the support article. Across every couples app I looked at, **this state is systematically under-designed and under-explained.** That is a gap (see §4).
- **Links:** https://apps.apple.com/us/app/paired-couples-relationship/id1469609343 · https://support.paired.com/en/articles/164636-how-do-i-pair-with-my-partner

### 2.2 SyncWithLove — the frictionless-pairing + live-presence variant

- **Traction (fetched):** claims **"10,000+ couples have played"**, 200+ questions, 6 categories. Free, no paywall.
- **DESIGN takeaways — three mechanics fairjudge should consider directly:**
  1. **Simultaneous reveal, stated as the product's identity.** Verbatim: *"The instant both submit, both screens reveal at the same moment. You see their answer; they see yours. At. The. Same. Time."* The typographic emphasis is theirs. Compare with Paired's *unlock*: Paired is "you may now view", SyncWithLove is "you both see it in the same instant." For a conflict product, the *simultaneity* framing is meaningfully stronger than the *unlock* framing — nobody got to read first and prepare a rebuttal.
  2. **Zero-account pairing.** No signup. Party A picks a category, gets a **private link**, sends it over any messenger; Party B clicks and is in. For fairjudge — where asking a defensive partner to create an account is a hard conversion wall — this is the single highest-leverage onboarding idea in the survey.
  3. **Waiting is designed, not blank.** While one side hasn't finished, the other sees **live progress**: *"Partner is on question 7 of 15"*, plus states *"Partner ready · Your turn →"* and *"Not answered yet."* This is the one product found that explicitly designs the **asymmetric waiting state** — the exact state fairjudge lives in whenever only party A has submitted. Note the ambient-presence effect: it turns "nothing is happening" into "they're engaged with this right now."
  4. Sessions auto-delete; works cross-device.
- **Link:** https://syncwithlove.com/

### 2.3 Lasting — therapy-grade, and the asymmetry compromise

- **Traction (fetched):** **4.7/5 from 25K ratings.** Developer: Groop Internet Platform inc. Free with IAP; Premium **$11.99–$79.99**, Plus **$19.99–$89.99**, 7-day free trial. Apple "App of the Day." No download count disclosed. Gottman-method curriculum (`(snippet only)`: four horsemen — criticism, contempt, defensiveness, stonewalling — and their antidotes).
- **DESIGN takeaways:**
  - **Answer-separately-then-compare**, same family as Paired. A review surfaced in the listing: *"at the end it shares my partners answers with me so I can see what exactly she is feeling in comparison to mine."*
  - **Pricing carries the two-person model:** *"Lasting Premium unlocks the entire app for two users (you and your partner!)."* One purchase, two seats — the paying party sponsors the reluctant party. For fairjudge, whoever initiates is the motivated party; the invited party should never hit a paywall.
  - **Solo use — conflicting evidence.** The App Store listing does **not** promote solo use and is framed around joint use. But `(snippet only)` third-party reviews claim Lasting explicitly tells users *"if you can't get your partner to join you, that's okay—in fact, many people who use Lasting are using it alone."* If true, this is a category leader **capitulating on the two-person premise** because partner recruitment is too hard. **This needs verification — it is the most decision-relevant unresolved fact in this survey** (see §5).
  - `(snippet only)` The recruitment problem is well-known in the field: research cited in the same results says that when one partner suggests counseling, the other switches into *"super defensive mode."* Gottman Institute has a whole article on inspiring a partner to attend: https://www.gottman.com/blog/5-steps-to-inspire-your-partner-to-join-you-in-attending-couples-therapy/
- **Link:** https://apps.apple.com/us/app/lasting-marriage-couples/id1225049619

### 2.4 Cupla, Couply, Evergreen, Love Nudge, Connected `(snippet only)`

Surveyed only at snippet level; none fetched. Recorded for completeness and as leads.

- **Cupla** — shared couples calendar, syncs Google/Apple calendars. Pairing exists but the value (your own calendar) survives a partner not joining — a **graceful-degradation-to-solo** design. https://cupla.app/
- **Couply, Evergreen, Love Nudge, Connected (shared journaling)** — appear in every "best couples apps 2026" roundup. Not investigated. Comparison roundups: https://unstar.app/blog/paired-lasting-love-nudge-evergreen-cupla-couples-apps-ranked-2026 · https://ourcouple.app/blog/best-couples-apps-2026

### 2.5 Cross-category note: TheMediator.AI sits between categories 1 and 2

Covered fully in category 3 below, but flagged here: it is the **only consumer AI product found that genuinely invites a second party and withholds each party's raw statements from the other.** It is the closest existing thing to fairjudge's architecture, and its traction counter reads **0**.

---

## Category 3 — Online Dispute Resolution (ODR) platforms

This category turned out to be the richest source of *hard evidence* in the survey — including a natural experiment that directly measures what happens when a system does allocate outcomes on a one-sided record.

### 3.0 Utah small-claims ODR — the natural experiment that validates fairjudge's core rule

**Read this before anything else in the report.** Source: The Markup, "Payday Lenders Are Big Winners in Utah's Chatroom Justice Program", 2022-03-16 — https://themarkup.org/remote-justice/2022/03/16/payday-lenders-are-big-winners-in-utahs-chatroom-justice-program

- **The rule:** Utah's small-claims ODR is **mandatory**. Defendants must register within **14 days** of the summons. **Failing to register automatically triggers a default judgment.** The registration instruction sat on page three of a five-page document, as a 55-character web address.
- **The measured result — default judgments went UP** (West Valley City Justice Court):

  | Metric | Before ODR (Sep 2016–2018) | After ODR (Sep 2018–Jan 2021) |
  |---|---|---|
  | Overall default judgment rate | 43% | **59%** |
  | Institutional plaintiffs (incl. payday lenders) | 46% | **62%** |
  | Action Rent to Own specifically | 49% | **65%** |

  That is **603 additional default judgments**. **Five payday lenders filed 83% of all small claims cases** in that court over the period. A University of Arizona usability study had warned *in advance* that the summons paperwork would prevent actual users from engaging.
- Chris Peterson (Univ. of Utah law), quoted: *"The more efficient the system, the lower the marginal cost of debt collection, the more likely that repeat, high-interest lending predators will use the system"* aggressively.
- `(snippet only)` Other Utah figures: only **36% of defendants registered**; of those, ~50% reached settlement or voluntary dismissal.
- **Why this is the single most important finding in the survey:** Utah is a fully-worked, measured example of a system that converts *one party's silence* into a binding adverse outcome on a timer. The effect was that the sophisticated, high-volume, more procedurally fluent side won **more** often than under the old in-person process. **fairjudge's refusal to allocate responsibility on a one-sided record is not an ethical nicety — it is the specific defect that made Utah's system a net transfer to whoever files most fluently.** If fairjudge ever adds a timeout, this is the evidence for why that timeout must not resolve the merits.
- **Primary source not yet fetched:** Utah ODR Pilot Project Final Report — https://ncsc.contentdm.oclc.org/digital/collection/adr/id/63/

### 3.1 TheMediator.AI — the closest shipping analog to fairjudge's architecture

- **Traction (fetched):** The site's own metrics counters read **"0 successful mediations"** and **"0 outcomes."** No user adoption whatsoever. Pricing: **$4.99 per dispute**, paid by the initiator.
- **What it does:** Two-party AI-facilitated mediation from a mobile app.
- **DESIGN takeaways — nearly every one maps 1:1 onto a fairjudge decision:**
  1. **Asymmetric initiation with a cost gate on the initiator only.** Party A starts by *"privately explaining the dispute"* and pays $4.99. Party B is invited free. The motivated party pays; the reluctant party faces zero friction. Same principle as Lasting's two-seat license.
  2. **Guided questions, answered separately** — not free-form venting. Structure is imposed at intake, for both parties, symmetrically.
  3. **Raw statements are firewalled.** Verbatim: *"Your private answers to the mediator are not shown directly to the other party."* The system **synthesizes** across both perspectives without exposing either side's words. This is a materially different consent model from fairjudge's (which surfaces confirmed utterances) and is worth weighing: it removes the "you screenshotted me" injury entirely, at the cost of evidence transparency.
  4. **Non-binding by construction.** *"suggests a non-binding resolution that both parties can review"*; *"the final decision rests with you and the other party."*
  5. **Failure has an artifact.** If no agreement is reached, *"progress made can be downloaded as a PDF for future reference."* A dispute that doesn't resolve still produces something the parties keep. fairjudge's "refused" output level needs exactly this: **a refusal must still hand the user an artifact**, or it reads as a dead end.
  6. **Explicit role disclaimer, and it is a boundary rather than an entertainment shield:** *"TheMediator.AI is a communication facilitator, not a judge, lawyer, or court. We do not provide legal advice or binding rulings."* Contrast with category 1's "entertainment purposes only." This is the register fairjudge should study — it claims to be serious *and* limits its claims, rather than disclaiming seriousness altogether.
  7. **Unaddressed, same as everyone else:** what happens if Party B never responds. Not documented.
- **Link:** https://themediator.ai/

### 3.2 Matterhorn (Court Innovations) — the best-documented real ODR flow

A **live production Matterhorn court instance FAQ** was fetched (Michigan district court MID54B) — the most concrete production UX evidence in this report: https://cii2.courtinnovations.com/MID54B/faq

- **Traction `(snippet only)`:** "trusted by over 70 courts, resolution centers, and municipalities in 12 states." Courts collecting 51% of fines pre-Matterhorn reported 92% within 30 days and 99% within 90 days; small-claims/landlord-tenant/contract cases resolved before going to court reportedly rose 46% → 76%; cases closed in 14 days vs. an average of 50. Merged with Catalis Gov, August 2022. Sources: https://www.cioreview.com/company-govsolution/matterhorn-by-court-innovations-improve-access-to-justice-via-odr-cid-16552.html
- **Better-sourced Michigan numbers (from the fetched JTC bulletin):** a study of three courts and 17,000 cases found a **74% reduction in average days to case resolution**; **nearly 40% of Michigan users reported they would not have been able to appear in court in person**; **more than 80%** said they would recommend it.

**DESIGN takeaways — several map 1:1 onto fairjudge screens:**

1. **Eligibility gating happens BEFORE any narrative work.** The user enters ticket/case information to search for eligibility first. Only if eligible do they proceed to "submit a request online." Nobody writes their story into a system that was never going to accept it. fairjudge's analog: check whether this dispute is in scope (and whether the other party is reachable) *before* asking anyone to upload evidence.
2. **The three-role state machine — the most transferable pattern in this category.** `(snippet only)` The citizen's argument is routed to the **opposing party (prosecutor or police officer), who enters their response and often recommends a disposition**; the case is **then reviewed by the judge**, who either rules **or asks the parties for more information, in which case the cycle restarts.** The live FAQ confirms the two-reviewer structure plainly: **"A real judge and law enforcement officer"** examine each case.
   → **The "request more information and re-enter the loop" transition is exactly the state fairjudge needs when only one side has spoken: a non-terminal, non-judgmental *pending* state rather than a resolution.**
3. **Deadlines, exact (from the live FAQ):** decisions delivered by email or text; the user has **10 days to act on the result**. Traffic: must decide within **8 calendar days** of receiving the ticket to remain eligible. Parking: **"a default judgment enters against you" after 14 days** if no review is requested.
4. **Neutrality signaling — and this is the key technique.** The court's copy does **not** claim the algorithm is fair. It claims **procedural equivalence to the physical courtroom**: a real judge and real law enforcement use *"the same criteria"* and *"same considerations"* as they would in person, and the offer is described as identical to what you'd receive by appearing. **Neutrality is signaled by sameness-to-a-known-process, not by asserting the software is unbiased.** (Contrast category 1's *"Unbiased: No taking sides"* — assertion without referent.)
5. **The exit ramp is always visible.** If a request is rejected, users can "deny responsibility and request a hearing."

### 3.3 Modria / Tyler Technologies — the eBay lineage and the escalation ladder

- **History `(snippet only)`:** Colin Rule directed eBay and PayPal's ODR systems 2003–2011, licensed the eBay software, co-founded Modria. Tyler Technologies acquired Modria in 2017.
- **The "60 million disputes" number — verified in a primary institutional document, WITH an important caveat.** The **JTC Resource Bulletin, *Online Dispute Resolution and the Courts*, v1.0 (adopted 2016-11-30)** states verbatim: *"eBay alone resolves more than 60 million disputes annually using ODR, and more than 90% of those disputes are resolved without a third-party mediator."* **But trace the footnote:** the bulletin's citation (fn. 3) is not an eBay disclosure — it is a conference talk (Petreikyte, Gintare, "ODR Platforms: eBay Resolution Center," 15th ODR Conference, The Hague, 2016). **Cite it as "widely cited, sourced to a 2016 conference paper," not as an audited figure.** PDF: https://ncsc.contentdm.oclc.org/digital/api/collection/tech/id/867/download
- **The four-stage ladder `(snippet only)`:** **Diagnosis → Negotiation → Mediation → Arbitration.** Diagnosis collects/organizes information and suggests possible solutions; Negotiation distills points of contention and lets parties talk directly *and on the record*; Mediation introduces an impartial third party; Arbitration lets parties select a decision-maker. Modria claimed the "vast majority" of claims settle in the first two stages with no human involved.
- **The primitive flow, from the fetched JTC bulletin:** *"In its simplest form, this process consisted of one party filing a complaint online where the other party could see and respond to it. If the two parties were unable to come to an agreement, a mediator could be assigned."*
- **DESIGN takeaway:** the ladder is **escalation-gated by failure, not by severity.** Nobody is assigned a neutral until the parties have demonstrably failed to self-resolve. The cheap, automated, *no-judgment* layer comes first; the responsibility-allocating layer is the last resort and is reached only by progression. **fairjudge's L1/L2/L3 ladder can borrow this logic: the top rung should be earned by the process, not offered by default.**

### 3.4 NCSC / JTC published design principles

**JTC Resource Bulletin** (fetched in full, 15pp). Definition: *"ODR is a digital space where the appropriate parties can convene to work out a resolution to their dispute or case."*

Three passages map directly onto fairjudge's open problems:

1. **On consent and asymmetric visibility:** *"Courts will need to thoughtfully define who owns ODR system data, how it will be protected, how it can be used… what information should be private, and **what information should be available to whom, when, and how?**"* — this is fairjudge's consent gate, stated as an open question by the field itself.
2. **On power imbalance:** *"if the plaintiff is a debt collector with representation, **how should the software ensure that the defendant knows his/her rights and how the relevant burden of proof works?**"* — the field explicitly names the duty fairjudge is built around: when one side is prepared and the other is not, **the software owes the weaker party orientation.**
3. **On refusing to optimize for throughput:** *"**A public dispute resolution system must produce outcomes that are fair and just, not just convenient, efficient, and cheap.**"* (quoting Condlin, *Online Dispute Resolution: Stinky, Repugnant, or Drab*, U. Md. Legal Studies Research Paper 2016-40)

Other JTC points worth noting: ODR *"can increasingly shape online written communication to avoid escalating situations by blocking foul language, 'flaming,' and other communication patterns that escalate conflict"* — **de-escalation as a platform feature, not a moderator's job.** And: ODR users are heavily mobile-dependent, and mobile-dependent populations *"are also likely to have more limited ability to communicate effectively in writing — a skill essential to utilizing an ODR system."* Directly relevant when asking two upset people to write evidence narratives.

**NCSC "Lessons Learned"** (fetched) — https://www.ncsc.org/resources-courts/lessons-learned-online-dispute-resolution — eight principles. The two most relevant: *"A platform alone doesn't guarantee success. ODR must be supported by rules, staffing, training, and clear litigant guidance to ensure it meets due process standards"*; and **"Prioritize user experience — simplify the litigant journey even if backend processes become more complex."** Program stats on the same page: Utah (reduced workloads, faster resolution), Franklin County Ohio (first court-annexed U.S. ODR platform; reduced default judgments), Connecticut traffic (cut resolution times by over 100 days). **Notably, this page does not address what happens when one party fails to respond.**

**Four integration models** (from HiiL, cited by JTC): Full Integration (notification → self-diagnosis → negotiation → court review → adjudication → recording of settlements), **Pretrial ODR** (negotiate before any court filing — Franklin County Ohio Small Claims), ODR-as-competitor-to-courts, and ODR-as-marketplace.

### 3.5 ICODR standards — neutrality as a published, checkable standard

Fetched: https://icodr.org/standards/ — nine standards. The four load-bearing ones, verbatim:

- **Fair and Impartial** — *"ODR must treat all parties equitably and with due process, without bias or benefits for or against individuals, groups, or entities"*, with **advance disclosure of conflicts of interest**.
- **Transparent** — providers must *"explicitly disclose in advance and in a meaningful and accessible manner"* the forms of process, enforceability, risks, costs and benefits of participation. **This is informed consent as a UI requirement, stated before participation.**
- **Confidential** — clear policies addressing *"who will see what data, how and to what purposes that data can be used, how data will be stored."*
- **Equal** — *"ODR must seek to enable often silenced or marginalized voices to be heard and strive to ensure that offline privileges and disadvantages are not replicated in the ODR process."*

The other five: Accessible, Accountable (*"continuously accountable… with auditable processes and human oversight"*), Competent, Legal, Secure.

**This is a ready-made evaluation rubric for fairjudge**, published by a standards body, and a stronger framing device for the portfolio case study than any self-invented principle list.

### 3.6 Cybersettle and blind bidding — mechanism that deliberately refuses to touch fault

`(snippet only)` — https://libraryguides.missouri.edu/c.php?g=557240&p=3832248

- **Mechanism:** patented **double-blind bidding**. Each side submits up to 3 settlement offers/demands **without revealing them** to the other; the system compares confidentially; **if a demand is ≤ the corresponding offer, the claim settles at the average of the two**; otherwise additional rounds. Claimed traction: nearly 200,000 transactions totaling over $1.4B in settlements; NYC reportedly saved over $11M in its first year.
- **The scope limitation is the lesson.** Blind bidding is explicitly scoped to claims *where there are no unresolved liability issues* — **the mechanism resolves amount, never fault, and only runs once fault is off the table.** A neutral mechanical procedure was designed by people who understood exactly which question it was and was not entitled to answer. That is the same discipline fairjudge is claiming.
- **DESIGN takeaway:** the settlement point (the midpoint) is **mechanically neutral, so neither party conceded.** Symmetric sealed simultaneous disclosure with an arithmetic outcome is the purest possible neutrality signal — no one has to trust a judge.

### 3.7 Modern platforms and AI-native ADR `(all snippet only)`

- **New Era ADR** — fully digital mediation/arbitration; secure document upload, scheduling, virtual presentation before neutrals. June 2025: tooling for high-volume automotive warranty/lemon-law mediations under California AB 1755 / SB 26. (`neweraadr.com/our-tech` returned 404.)
- **Immediation** — 30+ purpose-built tools; automated intake forms, customizable workflows, case and panel management, secure client portal.
- **FairClaims** — online arbitration/mediation, case management, document sharing, virtual hearings.
- **AAA-ICDR announced an AI-native arbitrator** — https://www.adr.org/press-releases/aaa-icdr-to-launch-ai-native-arbitrator-transforming-dispute-resolution/
- **Dyspute.ai "Adri v2"** — a 24/7 **asynchronous** AI mediation platform (LawSites, Jan 2026) — https://www.lawnext.com/2026/01/dyspute-ai-launches-adri-v2-a-24-7-asynchronous-ai-mediation-platform.html — **the closest named competitor to fairjudge in the ODR space; not fetched, high-priority follow-up.**
- **Disputron** (see §1.5) markets as "AI-powered small claims court" — consumer ODR cosplay rather than real ODR.
- Estonian "AI judge" / Canadian-UK robot mediator coverage: https://www.lexisnexis.com/en-ca/ihc/from-estonian-ai-judges-to-robot-mediators-in-canada-uk

### 3.8 ODR's answers to fairjudge's four questions

**(a) One-sided filings — two opposite philosophies, with evidence on which works.**
- *Utah (mandatory):* silence + 14 days = **default judgment on the merits against the silent party.** Empirically **increased** defaults 43% → 59% and advantaged repeat institutional filers (§3.0).
- *Matterhorn / Franklin County / the JTC "supplementary process" model:* ODR is an **additional lane, never a substitute.** JTC, verbatim: *"Litigants always have a right to their day in court even if they first explore other options. ODR does not supplant the hearing but instead serves as a supplementary process."* Non-participation drops the case back into the normal process; it doesn't decide it.
- *Cybersettle's structural answer:* the mechanism **only operates on quantum, never liability.**

**(b) Timeouts — every real one found terminates in "default judgment" or "eligibility expires," never in a finding.** Utah: 14 days → default judgment. Matterhorn parking: 14 days → default judgment. Matterhorn traffic: 8-day eligibility window; 10 days to act on a decision. **Note the pattern: even the harshest of these is procedurally, not substantively, adverse — the plaintiff wins because the defendant didn't appear, not because a system judged the evidence.** fairjudge can honestly state: **no ODR system in this survey adjudicates the merits from a one-sided record.**

**(c) Neutrality signaling — four techniques, none of which is "we are unbiased."**
- *Procedural-equivalence copy* (Matterhorn: "a real judge and law enforcement officer," "the same criteria," "same considerations").
- *Advance disclosure* (ICODR Transparent: process form, enforceability, risks, costs, benefits, and conflicts, disclosed **before** participation).
- *A visible exit ramp* — the stated right to leave for the normal process is itself a neutrality signal: the system isn't trapping you.
- *Mechanical symmetry* (Cybersettle's midpoint — the outcome is arithmetic, so neither party conceded).

**(d) Consent for what the other party sees — the weakest-covered area in the ODR literature.** The framing questions are canonical (JTC's *"available to whom, when, and how?"*; ICODR's *"who will see what data"*), but **no source fetched documented an explicit caucus/private-channel feature.** Modria's Mediation module implies a neutral-mediated channel, and blind bidding is by construction a private channel *to the system* rather than to the other party — but that is inference, not documentation. Genuine gap.

---

## Category 4 — Multi-agent deliberation code and papers

Star counts below are from `gh api` calls made 2026-08-17 and are exact as of that date.

### 4.1 MAD — Multi-Agents-Debate (Skytliang) — **605 stars**

- **Paper:** "Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate", Liang, He, Jiao, Wang, Yang, Tu, Shi (2023) — arXiv:2305.19118. Repo last pushed 2025-12-16.
- **ARCHITECTURE:**
  - **Three roles, and the naming is doing real work:** an affirmative debater (**"Devil"**), a negative debater (**"Angel"**) whose job is to *challenge and correct mistakes*, and a **Judge**.
  - Debate proceeds as alternating counter-arguments; the **judge intervenes periodically** to assess reasoning quality rather than only at the end.
  - The judge **receives the full debate transcript** and decides which side is more convincing; the verdict is extracted from the judge's final statement.
- **Why this matters for fairjudge — "Degeneration-of-Thought" (DoT).** MAD's entire motivation is that a *single* self-reflecting model fails in three named ways:
  1. *"Bias and Distorted Perception"* leading to inaccurate conclusions
  2. *"Rigidity and Resistance to Change"* preventing revision
  3. *"Limited External Feedback"* creating blind spots

  These three are **exactly the failure modes of a relationship-conflict judgment**, and DoT gives fairjudge a citable, pre-existing name for why one model reading one person's evidence cannot be trusted. The mitigation is agents that *"correct each other's distorted thinking."*
- **Design transfer:** the Devil/Angel split is a **structural** guarantee that someone argues the other side — not a prompt asking one model to "consider both perspectives." That distinction is the core lesson of category 4.
- **Link:** https://github.com/Skytliang/Multi-Agents-Debate

### 4.2 Du et al. — "society of minds" multiagent debate — arXiv:2305.14325

- **Authors:** Yilun Du, Shuang Li, Antonio Torralba, Joshua B. Tenenbaum, Igor Mordatch. Submitted 2023-05-23.
- **Mechanism (from abstract, verbatim):** *"multiple language model instances propose and debate their individual responses and reasoning processes over multiple rounds to arrive at a common final answer."* Reported to improve reasoning **and** *"the factual validity of generated content, reducing fallacious answers and hallucinations."*
- **Key practical note from the abstract:** *"Our approach may be directly applied to existing black-box models and uses identical procedure and prompts for all tasks we investigate."* — no fine-tuning, no per-task prompt engineering. This is a cheap architecture to adopt.
- **Caveat:** the abstract does not state agent count, round count, what each agent sees of the others, or the aggregation rule (majority vote vs. consensus). Those specifics require the full paper — flagged in §5.
- **Link:** https://arxiv.org/abs/2305.14325

### 4.3 ChatEval (thunlp) — **340 stars**

- Repo last pushed 2024-10-19. Paper: "ChatEval: Towards Better LLM-based Evaluators through Multi-Agent Debate."
- **ARCHITECTURE:** Multiple LLM agents act as autonomous referees and debate to *"autonomously determine which response stands out."* Each agent produces its own **"Evaluation evidence"** plus separate scores; the final output retains **all** the individual evaluations rather than collapsing to one number.
- **CODE takeaway — the config schema is directly copyable.** Agents are declared in YAML with these fields: `agent_type`, `name`, `role_description`, `final_prompt_to_use`, `memory`, `memory_manipulator`, `prompt_template`, `llm` (model, temperature, max_tokens). Two of these are unusually well-chosen for fairjudge:
  - **`role_description`** — persona is data, not code. Adding a new panel member is a config edit.
  - **`final_prompt_to_use`** — a *separate* prompt for the last round. The instruction that produces the final verdict is decoupled from the instruction that produces deliberation. fairjudge needs exactly this separation: deliberation prompts explore, the final prompt must emit the structured, schema-conformant judgment that code then grades into L1/L2/L3/refused.
  - **Communication strategy is a first-class parameter** (documented default: "one-by-one", "2 agent roles for 2 discussion turns"; the paper also describes simultaneous-talk and simultaneous-talk-with-summarizer variants, though the README did not detail them).
- **Link:** https://github.com/thunlp/ChatEval

### 4.4 AgentCourt — arXiv:2408.08089 — **97 stars**

- **Paper:** "AgentCourt: Simulating Court with Adversarial Evolvable Lawyer Agents", Chen, Fan, Gong, Xie, Li, Liu, Li, Qu, Alinejad-Rokny, Ni, Yang. Submitted 2024-08-15, revised 2025-06-16. Repo last pushed 2024-09-05.
- **ARCHITECTURE:** Judge, plaintiff's lawyer, defense lawyer, and other courtroom participants as LLM agents replicating *"the entire courtroom process."*
- **The distinctive contribution — AdvEvol:** an adversarial evolution loop that performs *"dynamic knowledge learning and evolution through structured adversarial interactions,"* explicitly *"breaking the limitations of the traditional reliance on static knowledge bases or manual annotations."* They simulated **1,000 civil cases** to build an evolving knowledge base; evolved lawyer agents scored **12.1% better** than the originals on their own **CourtBench** benchmark. Professional lawyers evaluated the improvement across three dimensions: *"cognitive agility, professional knowledge, and logical rigor."*
- **Honest limitation:** neither the abstract nor the README specifies the stage decomposition of the trial, the per-agent memory architecture, or **how the judge agent actually renders a verdict** — which is the part fairjudge most needs. The README notes code was unreleased at publication time. Worth a source-level read if the multi-agent direction is chosen (§5).
- **Transferable idea regardless:** the three evaluation dimensions (cognitive agility / professional knowledge / logical rigor) are a ready-made **rubric for evaluating fairjudge's own output quality with human raters**.
- **Links:** https://arxiv.org/abs/2408.08089 · https://github.com/relic-yuexi/AgentCourt

### 4.5 AI safety via debate (Irving, Christiano, Amodei) — arXiv:1805.00899 `(snippet only — abstract read via search results, PDF not fetched)`

Included because its central premise is the theoretical justification for fairjudge's entire design.

- **Premise `(snippet only)`:** two agents argue before a judge; *the adversarial structure makes the correct answer easier to identify than to generate.* The judge **does not solve the problem** — the judge arbitrates between competing arguments.
- **Why it matters here:** the agenda rests on a claimed **structural asymmetry between truth and falsehood** — it should be easier to argue compellingly for true claims. And debate helps most when **debaters have information the judge lacks**. That is precisely fairjudge's situation: each party holds context the system cannot access, so a structure that makes them argue *against each other* extracts more than interrogating either one alone.
- **Documented weakness that fairjudge must handle:** debate as described *"has an asymmetry between the first and second player, which could produce a significant first mover advantage or disadvantage."* In fairjudge, party A always files first. **Order is a bias vector**, and it needs an explicit countermeasure (see §2.4 and §5).
- **Link:** https://arxiv.org/pdf/1805.00899

### 4.6 Orchestration frameworks — the generic patterns

Star counts from `gh api`, 2026-08-17:

| Repo | Stars | Relevance |
|---|---|---|
| FoundationAgents/MetaGPT | 69,858 | SOP-driven role decomposition |
| microsoft/autogen | 60,457 | GroupChat + Reflection/critic patterns |
| langchain-ai/langgraph | 39,825 | Explicit graph/state-machine orchestration |
| camel-ai/camel | 17,593 | Role-playing agent pairs |
| confident-ai/deepeval | 17,628 | (eval — see category 5) |

- **AutoGen's Reflection pattern** `(snippet only, from docs summaries)`: a generator agent and a **separate critic agent** iterate until a stopping condition (max iterations **or approval from the critic**). Strict generator/critic role separation is enforced structurally. Documented cost: *near-doubling of LLM inference calls*, with latency and expense impact. AutoGen Core uses an actor model with async pub/sub topics — agents subscribe to typed message topics (e.g. a coder subscribes to `CodeWritingTask` and `CodeReviewResult`, publishes `CodeReviewTask` and `CodeWritingResult`). **The typed-message design is the transferable bit:** each agent's inputs are declared, so "what does this agent see" is enforced by the topic graph rather than by prompt discipline. For fairjudge, where "the advocate for party A must not see party B's private notes" is a *correctness* requirement, this is the right shape.
  https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/reflection.html
- **Dynamic Group Chat** `(snippet only)`: a `GroupChatManager` orchestrates a pool of specialized agents roundtable-style — i.e. speaker selection is itself a policy.

### 4.7 Perspectives (Show HN) — forcing disagreement rather than hoping for it

- **Traction:** Show HN, **2 points, 0 comments**. https://news.ycombinator.com/item?id=46717233
- **The stated problem, verbatim:** *"Ask any LLM to 'consider multiple perspectives' and you get hedged consensus."* Result: moderate positions that satisfy nobody and are *"useless for decision making."*
- **ARCHITECTURE — three mechanisms, all directly applicable:**
  1. **Eight personas with deliberately incompatible frameworks** — disagreement is guaranteed by construction, not requested.
  2. **Blind proposals.** Each persona generates its position **independently first**, to prevent *"the anchoring problem where early responses shape later ones."* This is Paired's locked-until-both-answer mechanic, applied to *agents*. The same principle protects both the humans and the model panel: **generate independently, then reveal, then debate.**
  3. **Structured interrogation with matched opposition:** *"A 'high-empathy' persona will be challenged by a 'low-empathy' cluster."*
  4. **Single Transferable Vote** to aggregate positions rather than averaging them — an aggregation rule that preserves minority positions instead of collapsing to the mean.
  5. Outputs a **PDF report**, not a chat reply. (Same instinct as TheMediator.AI's PDF: deliberation should terminate in a document.)
- **Also fetched:** the author's prediction-mode idea — resolve predictions against real outcomes to build calibration data over time. For fairjudge, the analog is: did the parties agree the judgment was fair, weeks later?

### 4.8 Neighbouring repos found but not investigated

From `gh api` searches, recorded as leads only, star counts exact:

- `AnttiHero/lavern` — **288 stars** — *"An agentic law firm. Yours. 67 specialist AI agents that review documents through evidence-backed debate, with mandatory human gat[es]"*. **The combination of evidence-backed debate + mandatory human gates is the closest architectural description to fairjudge found on GitHub.** Not fetched — highest-value follow-up in this category.
- `wan-huiyan/agent-review-panel` — **31 stars** — Claude Code skill: *"4-6 AI reviewers debate your code/plans, then a supreme judge delivers"*.
- `trekhleb/yesbrainer` — **29 stars** — *"A council of AI models... answer in parallel, debate to consensus, or get judged"*. Note the three named modes: **parallel / debate-to-consensus / judged** — a clean taxonomy of panel aggregation strategies.
- `baobaodawang-creater/moot-court-ai-lite` — 1 star — but the description is notable: *"Local-first AI mock-trial system — three LLM roles (plaintiff, defendant, judge) run an FSM-controlled courtroom simulation."* **FSM-controlled** is the right instinct and matches fairjudge's "output levels derived in code."
- `Pyrallux/CourtArena` — 1 star — a benchmark for adversarial legal reasoning in multi-agent courtroom settings.
- Direct GitHub searches for `argument+judge+ai+relationship` and `evidence+ocr+chat+screenshot+analysis` returned **zero results**. **There is no open-source project doing what fairjudge does.**

---

## Category 5 — "LLM-as-judge" eval tooling (ADJACENT — mechanics only)

Per the brief's term-collision warning, restricted to three entries, included only for transferable mechanics. **These are model-evaluation harnesses, not dispute judges.**

### 5.1 MT-Bench / Chatbot Arena — arXiv:2306.05685 — the bias taxonomy

- The canonical paper. Reports that strong LLM judges *"can match both controlled and crowdsourced human preferences well, achieving over 80% agreement, the same level of agreement between humans."*
- **The four named failure modes are the ones fairjudge inherits:** *"position, verbosity, and self-enhancement biases, as well as limited reasoning ability."*
  - **Position bias** → in fairjudge, whichever party's evidence is presented first to the model.
  - **Verbosity bias** → **the most dangerous one for this product.** The party who submits more screenshots and writes longer explanations will be favored. This mirrors the Futurism finding exactly (*"30 pages in a heartbeat"*) — the human-side and model-side failure modes are the same failure mode.
  - **Self-enhancement bias** → relevant if the same model both generates a party's summary and judges it.
- **Link:** https://arxiv.org/abs/2306.05685 · HN: https://news.ycombinator.com/item?id=36363818

### 5.2 lechmazur/position_bias — **16 stars** — how bad position bias actually is

Small repo, but it produced the hardest number in this survey.

- **Method (verbatim from the repo):** the evaluated model sees *"the original assignment, two sibling story versions, answer labels such as `1` and `2`, rating tags for the first-shown and second-shown story"* and does **not** see *"the hidden edit request, which editor produced which story version, the fact that the same pair will later appear in the opposite order."* Each pair is rated in **both display orders**, and preference-flip rate is computed.
- **Dataset:** 193 verified story pairs, 36 models, 386 prompts per fully-evaluated model.
- **Headline result:** *"the median model flips its underlying choice in 41.3% of decisive swapped-order case pairs."* Model-average first-shown pick rate: **64.3%** (vs. 50% neutral).
- **Implication for fairjudge, stated bluntly:** if you present party A's evidence then party B's and ask "who is more responsible," a median model changes its answer ~41% of the time when you swap the order. **A swap test is not an optimization — it is a correctness requirement**, and the swap-consistency result is itself a legitimate input to the L1/L2/L3/refused grading. If the verdict flips on swap, the confidence is not there.
- **Link:** https://github.com/lechmazur/position_bias

### 5.3 Mitigation vocabulary worth adopting `(snippet only)`

From secondary sources: **position consistency** (stability of judgment after swapping) and **preference fairness** (degree of positional favoritism) as named metrics. Two aggregation conventions exist for swap disagreements — **average the two scores** (Wang et al. calibration) or **annotate the conflict as a "tie"** (PandaLM). **PandaLM's "conflict → tie" rule is essentially fairjudge's refusal rule at the mechanic level**, and is the more honest of the two for this domain: averaging manufactures a confident midpoint out of two contradictory readings.

Other repos noted but not investigated (star counts from `gh api`): `agentscope-ai/OpenJudge` (**791**), `confident-ai/deepeval` (**17,628**), `UW-Madison-Lee-Lab/LLM-judge-reporting` (**82**, "corrects bias and computes confidence intervals in reporting LLM-as-a-judge evaluation" — potentially relevant for confidence display).

---

## Category 6 — Safety / refusal UX in sensitive-domain apps

### 6.0 What the AI-judge category itself does: nothing

- Of the four category-1 apps whose listings were fetched, exactly one (**AI Judgement**, §1.3) has any disclaimer, and it is the entertainment shield. **Let's Settle This** ships personas named *"Clinical Psychologist"* and *"Marriage Counselor"* with **no disclaimer at all**. No app examined showed any abuse-detection, crisis-referral, or scope-boundary language.
- **TheMediator.AI is the one product with a well-constructed boundary statement**, and it is a *positive* scope claim rather than a disclaimer: *"a communication facilitator, not a judge, lawyer, or court."* It says what it **is**, then what it is **not**.
- **AYTA's self-description** (§1.6) — *"meant to be imperfect, biased, and most importantly completely fabricated"* plus *"Please do not share these as human judgements"* — is the clearest refusal-adjacent precedent in the consumer category: undermining your own authority, on purpose, on the results screen.

### 6.1 Woebot — the safety-maximalist that died of it

- **Traction:** total funding **$107.5M** ($8M Series A 2018, $90M Series C 2021, $9.5M 2022), **1.5 million users** at shutdown. Founded 2017 by clinical psychologist Alison Darcy with backing from Andrew Ng's AI Fund. (`(snippet only)`: a separate "$124M burned" figure circulates; unverified, prefer $107.5M.)
- **Shutdown — CONFIRMED.** Announced late April 2025; the direct-to-consumer app was discontinued **June 30, 2025**; conversation export until that date; account data anonymized after **July 31, 2025**. The stated reason is **not** a safety failure — no business model survived the regulatory gap. Darcy: **"The gap between what's regulated and what's deployed has never been wider."** `(snippet only)` FDA has a pathway for rules-based chatbots as SaMD but none for LLM-based ones; Woebot held a 2021 Breakthrough Device Designation but never obtained marketing authorization.
- **The design decision — rules-based, not generative.** From Woebot's own AI Core Principles (fetched), the architecture separates two LLM uses and ships only one:
  - LLMs are used **for understanding intent only**, routing to human-written content: *"Where LLMs are used for understanding intent, the user never sees any AI-generated content."*
  - Generation is confined to research: *"we therefore only use generative capabilities in IRB-regulated study settings."* In product, *"all text is developed by our conversational writers, and always with clinical oversight."*
- **Concrete guardrail stack:** a proprietary **Concerning Language Detection** algorithm that *"runs on user input before it is passed to an LLM"*; prompt architecture designed against injection; and output-side controls — *"off-topic identification, maximum turn enforcement, and output validation."*
- **The scope disclaimer is explicit and load-bearing:** *"Woebot does not provide crisis counseling and is not a suicide prevention or crisis intervention service."* Disclosed with unusual candor: *"Concerning language and escalation data is not reviewed or assessed internally at Woebot Health in real-time"* — they tell you nobody is watching.
- **On user agency:** *"Users retain agency in terms of what the next step in their conversation is."* IEEE Spectrum describes the house philosophy as **"sitting with open hands"** — extending invitations rather than forcing engagement. **The most transferable piece of copy-philosophy found for fairjudge's refusal screens.**
- **Why they refused generative** (their own essay, fetched): hallucination *"while appearing highly authoritative"*; an uncanny-valley harm where the system characterized users negatively, playing *"into many people's darkest fears about themselves"*; and unforecast boundary violations.
- **The structural warning.** The most clinically rigorous product in the space shut down with 1.5M users and $107.5M raised. The market *"eliminates caution and rewards engagement"*, teaching the industry that *"safety doesn't pay."* **The lesson is not "don't be safe" — it is "don't make safety a cost center with no product value." fairjudge's refusal must BE the product, not a tax on it.**
- **Links:** https://woebothealth.com/ai-core-principles/ · https://woebothealth.com/why-generative-ai-is-not-yet-ready-for-mental-healthcare/ · https://hlth.com/insights/news/woebot-health-is-shutting-down-its-app-2025-04-28 · https://feltreal.org/blog/woebot-shutdown · https://spectrum.ieee.org/woebot

### 6.2 Wysa — the best-documented crisis-escalation flow, with uptake numbers

- **Traction:** `(snippet only)` ~**$35.4M** raised across 5 rounds, including a verified **$20M Series B (July 2022)**. User counts conflict across sources — "over 6 million" vs "over 4.5 million across 65 countries." **Do not cite a single number.** FDA Breakthrough Device Designation for chronic MSK pain with associated depression/anxiety `(snippet only)`. `wysa.com` 403'd on two attempts; the blog subdomain worked.
- **The SOS flow (from Wysa's published global study, fetched):** 19,000 anonymized users across 99 countries; **5.2% (1 in 20) hit a crisis instance in one year**; **82% of those were detected by the AI**, not self-reported.
- **Two deliberately redundant entry paths:**
  1. **AI-driven** — the system detects mentions of suicidal ideation, trauma, abuse, or self-harm mid-conversation and **asks the user to confirm before escalating.** Confirmation-gated, not auto-fired.
  2. **User-initiated** — a persistent SOS button on the home screen, always visible.
- **What the escalation offers, and the uptake — the most useful design data in this entire survey:**

  | Post-escalation option | Chosen by |
  |---|---|
  | Safety plan | **49.2%** |
  | Grounding / breathing / mindfulness | **46.6%** |
  | Call a local helpline | **2.4%** |

  **Read that carefully.** The hotline — the thing every safety review demands — is chosen by **one in forty**. What people actually take are the two options that let them stay in the product and do something immediately. **A crisis referral that is only a phone number is, empirically, a referral to nothing.**
- **Timing:** 28.1% of SOS triggers fire after midnight; 31% between 6pm and midnight — **roughly six in ten crisis moments land outside business hours**, which is the actual argument for automated escalation existing.
- **Link:** https://blogs.wysa.io/blog/company-news/ai-detects-82-of-mental-health-app-users-in-crisis-finds-wysas-global-study-released-on-the-role-of-ai-to-detect-and-manage-distress

### 6.3 Replika — the canonical sudden-change catastrophe, and the sharpest refusal lesson in the survey

- **Traction `(snippet only, poorly sourced — do not print without a better source):`** 40M+ total users, ~2M active, 500K+ paying; funding ~$11M across 4 rounds.
- **Regulatory — safe to cite, consistent across multiple independent sources `(snippet only)`:** the Italian Garante suspended Replika in **February 2023** over risks to minors and absent age verification. Then a **€5 million** fine on **Luka Inc.**, decision *provvedimento n. 232* adopted **April 10, 2025**, announced **May 19, 2025**. Grounds: no valid legal basis for processing, and no age-verification mechanism.
- **The ERP removal and the backlash.** Over a single weekend in **February 2023**, Luka stripped erotic/romantic roleplay, reportedly in response to the Garante order. Per a peer-reviewed Socius analysis (Hanson & Bolthouse, 2024) `(snippet only)`: long-term users logged in to find companions replaced by *"cold, robotic customer-service assistants"* that answered affection with **"Let's change the subject."** The recurring user metaphors were **"lobotomy"** and **"a friend with dementia."**
- **The detail that should shape fairjudge's design:** moderators of r/Replika **pinned suicide-prevention hotline links to the subreddit** `(snippet only)`. **A product change — not a crisis event — generated enough acute distress that the community had to stand up a crisis referral the company hadn't.** Roleplay was eventually restored for accounts created before February 1, 2023.
- **What actually drew the backlash — and it was not the policy.** Users overwhelmingly did not argue the new boundary was wrong in principle. They objected to: (a) **no warning**, (b) **no explanation at the moment of refusal** — the bot deflected rather than saying what had changed or why, (c) **retroactive application**, (d) **no opt-out or grandfathering**. The eventual fix *was* a grandfather clause, which tells you the boundary was never the real problem.
- **THE LESSON, and it is the most important one in this section:** *a refusal delivered without an explanation reads as the product being broken or betraying you.* **"Let's change the subject" is the exact failure mode fairjudge's description-only and refused output levels must avoid.** If the app declines to assign responsibility, the screen must say **that it is declining, and on what specific ground**, in the same breath. Silent degradation is what generated the grief.
- **Links:** https://journals.sagepub.com/doi/10.1177/23780231241259627 · https://www.vice.com/en/article/replika-brings-back-erotic-ai-roleplay-for-some-users-after-outcry/ · https://www.pymnts.com/cpi-posts/italy-fines-ai-chatbot-maker-replika-e5-million-over-privacy-violations/

### 6.4 Character.AI — safety UI retrofitted under litigation, and a copy register worth stealing

- **The lawsuit `(snippet only, consistent across outlets; court documents not fetched):`** Sewell Setzer III, 14, died by suicide in **February 2024**. *Garcia v. Character Technologies* filed **October 2024**. A federal judge **rejected the First Amendment defense in May 2025**. In **January 2026**, Google and Character.AI agreed to settle multiple suits including Garcia.
- **The under-18 restrictions — VERIFIED from the primary source** (https://blog.character.ai/u18-chat-announcement/, posted **2025-10-29**, effective no later than **2025-11-25**):
  - **Open-ended chat removed entirely for under-18s** — a hard block, not a nudge.
  - **A ramp, not a cliff:** during the transition, under-18 chat time was capped at **2 hours/day**, *"ramping down in the coming weeks"* before the cutoff. **They spent four weeks tapering a feature they were removing.**
  - **Substitution, not just subtraction:** video creation, story writing, and streaming with Characters offered as replacement surface.
  - **Age assurance:** in-house model plus third-party vendor Persona.
  - An independently funded nonprofit **AI Safety Lab**.
- **`(snippet only)`** Safety UI added to the running product: a revised per-chat disclaimer reminding users the character is not real; **a notification when a user passes one hour on the platform**; improved detection of ToS-violating characters; crisis pop-ups routing to 988 on self-harm terms.
- **The framing language is worth stealing outright.** They name the external pressure honestly ("recent news reports", "questions from regulators") and concede the risk is **structural, not a content bug**: they cite worry about *"how open-ended AI chat in general might affect teens, even when content controls work perfectly."* **A company saying the feature itself is the hazard is a far stronger integrity signal than "we're improving our filters."**
- **And they apologize without hedging:** *"We understand that this is a significant change for you. We are deeply sorry that we have to eliminate a key feature."* Note the construction — **"we *have to*."** It asserts the constraint as binding rather than chosen. **That is exactly the register a principled refusal needs.**
- **Backlash `(snippet only)`:** families and safety advocates said it came too late — after a death, after the suit, after the First Amendment ruling failed. Teen users experienced it as the Replika pattern again; the 4-week taper and substitute features were clearly designed to blunt exactly that.

### 6.5 Crisis-referral conventions and platform policy — mostly a vacuum

**The important negative finding: neither app store requires crisis resources.** Both policies were fetched.

- **Apple App Review Guidelines** (fetched) contains **no** guideline mandating suicide/self-harm resources. The relevant text is **1.4.1**: medical apps that could provide inaccurate data *"may be reviewed with greater scrutiny"*, must *"clearly disclose data and methodology to support accuracy claims"*, and *"should remind users to check with a doctor."* https://developer.apple.com/app-store/review/guidelines/
- **Google Play Health Content and Services** (fetched) likewise has **no** crisis-resource requirement, but does require non-medical-device health apps to carry *"a clear disclaimer in their app description indicating that the app is 'not a medical device and does not diagnose, treat, cure, or prevent any medical condition'"* plus a prompt to consult a professional. `(snippet only)` All developers must complete a Health apps declaration form — including certifying *no* health features if that's the case (effective **2025-08-28**). https://support.google.com/googleplay/android-developer/answer/16679511
- **So crisis referral is a norm, not a rule — and compliance is poor.** `(snippet only)` A study of **302 mental-health apps found 217 lacked any crisis hotline or resource contact information** whatsoever (Psychiatric Services — https://psychiatryonline.org/doi/10.1176/appi.ps.20240485). **The bar is on the floor; clearing it is cheap differentiation.**
- **988 basics `(snippet only)`:** the US 3-digit code for suicide, mental-health, and substance-use crisis via **call, text, or chat**; legacy 1-800-273-8255 still routes. Established by the National Suicide Hotline Designation Act (2020). **Note for design: text and chat matter more than the call, per Wysa's 2.4% figure.**

**NEDA / Tessa (2023) — the failure mode to design against `(snippet only; CNN, NPR, NBC, BBC consistent)`.** NEDA took its chatbot Tessa offline around **June 1, 2023** after it advised users with eating disorders to count calories, restrict diets, measure body fat, and lose 1–2 lbs/week — and **kept doing so after being told the user had an eating disorder.** Contributing factors: the harmful behavior arrived via a vendor *"systems upgrade"* that added an *"enhanced question and answer feature"*; NEDA reportedly knew of issues months before disclosure; NEDA **initially denied** the advocate's account, then deleted the denial when evidence surfaced. Context: NEDA had shortly before eliminated most of its human helpline staff.

**The Tessa lesson is not "chatbots are bad."** It is that (a) a rules-based safe system **silently became generative through a vendor upgrade — the safety property was not pinned to anything durable**; (b) the bot had **no concept of user state overriding topic** — being told "I have an eating disorder" should have hard-switched response mode and didn't; and (c) **denying the first report cost more trust than the bug did.**

### 6.6 The refusal literature — a purpose-built framework exists

**"Even GPT Can Reject Me": Conceptualizing Abrupt Refusal Secondary Harm (ARSH) and Reimagining Psychological AI Safety with Compassionate Completion Standard (CCS)** — Yang Ni and Tong Yang, arXiv:2512.18776, submitted **2025-12-21**. Abstract fetched; PDF undecodable.

- **ARSH** = *"the psychological impacts of sudden conversational discontinuation caused by AI safety protocols"*, with three named harms: rupture of perceived relational continuity; **evocation of rejection or shame**; **discouragement of future help-seeking**.
- **That third harm is the killer for fairjudge.** A badly delivered refusal doesn't just fail this interaction — **it teaches the user not to come back.** In a conflict app, where the user is already defensive, a refusal that reads as "you did this wrong" makes them stop submitting evidence entirely.
- **The proposed fix, CCS, is a four-beat structure** — verbatim from the abstract: **"empathetic acknowledgment, transparent boundary articulation, graded conversational transition, and guided redirection."** Goal: *"replacing abrupt disengagement with psychologically informed closure"* while *"maintaining safety constraints but preserving relationship coherence."* Note **graded** — same insight as Character.AI's 4-week taper: **the transition is a design surface, not just the endpoint.**
- **Link:** https://arxiv.org/abs/2512.18776

**Refusal taxonomy worth adopting verbatim in the UI.** `(snippet only)` Anthropic's platform docs distinguish **policy refusals** vs **capability refusals** vs **uncertainty refusals** (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback), with streaming refusals surfacing a `stop_details` object carrying *"a category and a human-readable explanation that you can surface to the user."* **These map exactly onto fairjudge:**

- **Capability refusal** — "only one side submitted; I lack the input" *(the main case)*
- **Uncertainty refusal** — "the evidence is contradictory; I won't pretend confidence"
- **Policy refusal** — "this involves possible abuse; this tool is the wrong instrument"

**These are three completely different emotional messages. Collapsing them into one generic "I can't judge this" screen is the mistake.**

Also `(snippet only)`, from arXiv:2510.07686 on stress-testing model specs: OpenAI models tend toward hard refusal ("I can't help with that") while **Claude models *"tend to adopt softer rejection strategies that include at least some explanation."***

**On expressing uncertainty `(snippet only)`.** OpenAI's stated preference ordering, per commentary on the Model Spec: **confident right answer > hedged right answer > no answer > hedged wrong answer > confident wrong answer.** Read against fairjudge: **a hedged partial judgment outranks silence, and silence outranks a confident wrong verdict.** That ordering is a direct argument for the four-level output ladder existing at all — the description-only tier *is* the "hedged right answer," and it beats both refusing outright and guessing.

**HCI on uncertainty display `(snippet only)`:** simplified uncertainty visualizations improve trust and decision quality, and communicating uncertainty is necessary for **trust calibration** — but **a bare confidence number is insufficient**; users need explanation to decide whether to rely on the system. Relevant venue: CURE 2026 workshop — https://cureworkshop.github.io/cure-2026/

**Practitioner refusal-copy consensus `(snippet only, folk wisdom not evidence)`:** clarify the boundary → acknowledge intent → lead with what you *can* do → make next steps obvious. Two lines worth keeping: *"Treat refusal messages like UX copy, not legal disclaimers"* and *"a refusal ends one path, but good design opens another."*

### 6.7 Table-stakes safety rails for a relationship-conflict app

What this evidence says fairjudge cannot ship without:

- **An abuse / IPV detection path that overrides the judgment flow entirely.** This is the **policy** refusal tier and it must be **architecturally separate** from the evidence-sufficiency tier. Tessa's core failure was that a disclosed user state did not override topical response mode. If a submission contains indicators of coercion, control, or violence, the correct output is **not a downgraded judgment** — it is **no judgment plus a resource handoff**, because adjudicating "fault" in an abusive dynamic actively harms the victim. `(snippet only)` Validated screening instruments exist; see https://www.jmir.org/2021/12/e24114 (Dec 2021), whose stated finding is that most publicly available screening apps *"did not use validated screening questions."*
- **A persistent, always-visible crisis affordance** (Wysa's model), not buried in settings.
- **Confirm-before-escalate on AI detection.** Wysa asks the user to confirm before triggering SOS. Do not auto-fire a crisis screen on a keyword.
- **Tiered escalation content, weighted by real uptake:** something to do now (grounding), something structural (plan/next step), external referral last. **Ship the hotline, but do not mistake it for the intervention** — 2.4%.
- **An explicit "this tool is not for X" boundary, stated in onboarding.** Copy Woebot's directness. Say plainly it is not for abuse situations, not for legal use, not a therapist.
- **A Google Play–compliant disclaimer** if anything health-adjacent is touched.
- **Pin safety properties to something durable.** Tessa's guardrails evaporated in a vendor upgrade nobody safety-reviewed. **If fairjudge's refusal logic lives in a prompt, it will drift** — which is a second, independent argument for deriving output levels in code.

---

# 2. Cross-cutting patterns worth stealing

1. **Blind-until-both-submitted, and say why on the screen.**
   *From:* Paired (§2.1, 206K ratings / 8M downloads), SyncWithLove (§2.2), Perspectives' blind proposals (§4.7).
   The strongest validated mechanic in the survey, and it appears independently at *both* layers — for humans (don't let partner B anchor on partner A's story) and for agents (don't let agent 1 anchor agent 2). Paired users articulate the rationale themselves: *"locked until we both answer so that we aren't biased."* fairjudge should adopt it as a stated principle, not a silent gate, and apply it in both places.

2. **Simultaneous reveal beats sequential unlock.**
   *From:* SyncWithLove (§2.2) vs. Paired (§2.1).
   *"You see their answer; they see yours. At. The. Same. Time."* For a conflict product this is not a flourish — it eliminates the "they read mine first and prepared a rebuttal" grievance. The judgment, and the other party's submissions, should land on both devices in the same instant.

3. **Design the waiting state as presence, not absence.**
   *From:* SyncWithLove (§2.2) — *"Partner is on question 7 of 15"*, *"Partner ready · Your turn →"*, *"Not answered yet."*
   This is the only concrete prior art found for the asymmetric state, and fairjudge lives in that state by design. Everyone else leaves it blank (§2.1, §3.1 — both undocumented).

4. **The initiator pays; the invited party faces zero friction.**
   *From:* TheMediator.AI's $4.99-on-the-initiator (§3.1), Lasting's *"unlocks the entire app for two users"* (§2.3), SyncWithLove's no-account link (§2.2).
   Three independent products converge on this. The reluctant party must never hit an account wall or a paywall.

5. **Ask for the partner only after the user has felt value once.**
   *From:* Paired's "Invite Partner" placed **after the first onboarding question** (§2.1).

6. **Structural adversarialism, not prompted even-handedness.**
   *From:* MAD's Devil/Angel/Judge (§4.1), Perspectives' incompatible personas (§4.7), AI-safety-via-debate (§4.5), AgentCourt's opposing counsel (§4.4).
   *"Ask any LLM to 'consider multiple perspectives' and you get hedged consensus."* If fairjudge wants both sides genuinely argued, it needs **separate agents with separate briefs**, one per party. An instruction to be balanced does not produce balance.

7. **Name the single-model failure mode: Degeneration-of-Thought.**
   *From:* MAD (§4.1).
   *Bias and Distorted Perception*, *Rigidity and Resistance to Change*, *Limited External Feedback* — a citable, pre-existing three-part account of why one model on one person's evidence is untrustworthy. Use this vocabulary in the case study; it converts a design intuition into a referenced argument.

8. **Swap-test the verdict; treat the flip as data, not noise.**
   *From:* position_bias (§5.2 — **41.3% median flip rate**, 64.3% first-shown preference), MT-Bench's bias taxonomy (§5.1), PandaLM's conflict→tie rule (§5.3).
   Run the judgment with party A first and with party B first. If the outcome flips, that is not a bug to smooth over — it is *evidence that the evidence does not support a verdict*, and it should feed directly into the L1/L2/L3/refused grading. This gives fairjudge's output levels a **measured** basis rather than a heuristic one, which is a genuinely defensible engineering story.

9. **Verbosity bias is the same failure mode on both sides of the screen.**
   *From:* MT-Bench (§5.1) + Futurism (§1.7).
   The model favors the longer submission; the human weaponizes volume (*"30 pages in a heartbeat"*). One countermeasure serves both: normalize submission weight, and never let quantity of evidence read as strength of evidence.

10. **Deliberation should terminate in a document, and even failure gets one.**
    *From:* TheMediator.AI's PDF-on-no-agreement (§3.1), Perspectives' PDF report (§4.7).
    Pairs directly with fairjudge's frozen-and-versioned judgments. Critically: **a refusal must also produce an artifact.** "We could not judge this, here is what we did establish and what is missing" is a deliverable; a blank screen is a bug report.

10b. **Signal neutrality by procedural equivalence and advance disclosure — never by claiming to be unbiased.**
    *From:* Matterhorn's *"the same criteria," "same considerations,"* "a real judge and law enforcement officer" (§3.2); ICODR's **Transparent** standard requiring process, enforceability, risks, costs and benefits *"disclosed in advance"* (§3.5); Cybersettle's arithmetic midpoint so neither party conceded (§3.6); the always-visible exit ramp (§3.2, §3.8c).
    Four working techniques, none of which is an adjective. Compare category 1's *"Unbiased: No taking sides"* (§1.2) — an assertion with no referent. **fairjudge should state its procedure in advance and let the procedure carry the neutrality claim.**

10c. **Escalate by failure, not by severity — and make the pending state non-terminal.**
    *From:* Modria's Diagnosis → Negotiation → Mediation → Arbitration ladder, where the responsibility-allocating stage is reached only after self-resolution demonstrably fails (§3.3); Matterhorn's judge-asks-for-more-information transition that **restarts the cycle rather than resolving it** (§3.2).
    This is the missing piece for fairjudge's one-sided case. The correct state when only party A has spoken is not "refused" as an endpoint — it is **pending, with a named unblocking condition**, exactly the shape of Matterhorn's remand loop.

10d. **Explain the refusal in the same breath as delivering it, and taper rather than flip.**
    *From:* Replika's *"Let's change the subject"* catastrophe (§6.3); Character.AI's 4-week ramp-down and *"we are deeply sorry that we have to eliminate a key feature"* (§6.4); the ARSH/CCS four-beat structure — *"empathetic acknowledgment, transparent boundary articulation, graded conversational transition, and guided redirection"* (§6.6).
    **A refusal without a stated ground reads as the product being broken or betraying you.** Replika users did not object to the boundary; they objected to no warning, no explanation, retroactive application, and no opt-out. All four are avoidable in fairjudge by construction.

10e. **Split refusals into three named kinds and give each its own screen.**
    *From:* the policy / capability / uncertainty refusal taxonomy (§6.6).
    **Capability** ("only one side submitted — I lack the input"), **uncertainty** ("the evidence contradicts itself — I won't fake confidence"), **policy** ("this involves possible abuse — this is the wrong instrument"). Three completely different emotional messages. Collapsing them into one generic "I can't judge this" is the mistake, and it is the mistake fairjudge is currently closest to making.

10f. **Tier the escalation by what people actually take.**
    *From:* Wysa's measured uptake — safety plan **49.2%**, grounding **46.6%**, call a helpline **2.4%** (§6.2).
    Something to do right now, then something structural, then the external handoff. **Ship the hotline; do not mistake it for the intervention.** Also: confirm before escalating (Wysa asks the user to confirm before firing SOS), and keep the affordance persistent rather than buried.

11. **Attach a redistribution rule to the artifact itself.**
    *From:* AYTA's *"Please do not share these as human judgements"* (§1.6); inverted from WhoWon's shareable verdict card (§1.4).
    fairjudge's consent gate is the strong version of this. The rule should be visible **on** the judgment, not buried in settings.

12. **Show the panel's disagreement instead of collapsing it.**
    *From:* ChatEval retaining all individual evaluations with per-agent "Evaluation evidence" (§4.3), AYTA showing three differently-biased verdicts side by side (§1.6), Berkeley's finding that individual models frequently disagreed even when the consensus tracked humans (§1.8), Perspectives' STV aggregation preserving minority positions (§4.7).
    The spread across judges *is* the confidence interval. A wide spread on a one-sided submission is the most legible possible justification for a refusal — the user sees *why*, rather than being told.

13. **Separate the deliberation prompt from the final verdict prompt.**
    *From:* ChatEval's `final_prompt_to_use` config field (§4.3).
    Exploration and schema-conformant emission are different jobs. Since fairjudge derives output levels in code, the final call must produce structured, validated output — a distinct prompt with a distinct contract.

14. **Enforce "what each agent sees" in the message graph, not in the prompt.**
    *From:* AutoGen Core's typed pub/sub topics (§4.6), AgentCourt's role separation (§4.4).
    fairjudge has hard visibility requirements (party A's advocate must not see party B's private material). Prompt discipline is not an access-control mechanism.

15. **Personas as config, not code.**
    *From:* ChatEval's `role_description` (§4.3), Let's Settle This's 16 judge personalities (§1.1).
    Note the divergence in *purpose*: competitors use personas as **entertainment variety**; fairjudge should use them as **structural role assignment**. Same mechanism, opposite intent — and worth saying so explicitly in the case study.

16. **Say what you are before you say what you are not.**
    *From:* TheMediator.AI (§3.1) — *"a communication facilitator, not a judge, lawyer, or court"* — vs. category 1's *"entertainment purposes only"* (§1.3).
    A refusal-first product cannot hide behind an entertainment disclaimer; it needs a positive scope claim with explicit limits.

---

# 3. Anti-patterns observed

1. **One-sided input producing a two-sided verdict.** The category default (Verdict §1.2, AI Judgement §1.3, WhoWon §1.4, InstantVerdict, aijudge.pro). Verdict outputs *"You: 80% / Them: 20%"* from one person's account. This is not a small inaccuracy — it is the thing the Futurism reporting shows destroying marriages: *"It's not giving objective analysis. It's only giving her back what she's putting in."*

2. **Neutrality claimed by adjective.** *"Unbiased: No taking sides. Just pure logic and emotional intelligence"* (§1.2) — on a product that assigns a percentage of blame from a single account. Neutrality asserted in marketing copy, contradicted by the output format. Users will eventually notice; the credibility loss is total when they do.

3. **The verdict card as growth engine.** (§1.4, and Disputron's shareable verdict §1.5.) The virality mechanic requires publishing the other party's private messages, without their knowledge or consent, wrapped in an authoritative-looking judgment. This is the category's central ethical failure and the clearest thing for fairjudge to define itself against.

4. **The AI verdict as a rhetorical weapon.** (§1.7, fetched.) *"ChatGPT said that you're not a supportive partner"*; *"It's being leveraged like 'ChatGPT said you're wrong,' rather than actual dialogue."* **Any product that outputs a verdict is manufacturing ammunition.** The output format itself determines whether it gets used as a conversation-starter or as a citation in an argument — and a percentage split is unambiguously the latter.

5. **Covert use as the injury.** (§1.7, HuffPost.) A partner *"may feel 'duped' and betrayed if they find out"* — the harm lands **independent of** whether the verdict was correct. This validates the consent gate as a *product-integrity* requirement, not a compliance checkbox.

6. **Volume asymmetry.** *"There is no way to communicate when somebody's using this tool that can create 30 pages in a heartbeat to defend themselves"* (§1.7) — reinforced by MT-Bench's verbosity bias (§5.1). Uncapped generation makes the more AI-fluent party win.

7. **Sycophancy as the default output.** (§1.7, §1.8, §4.7.) Models validate the person in front of them. Perspectives names the consequence of the naive fix: asking for "multiple perspectives" yields *"hedged consensus"* — moderate positions *"useless for decision making."* Both poles are failures: agreeing with whoever asked, and refusing to say anything at all.

8. **Stubbornness in deliberation.** (§1.8.) Berkeley found GPT models **resisted changing their moral judgments when challenged by other models.** Multi-agent debate does not automatically produce convergence — apparent consensus may just be entrenchment. Whatever panel fairjudge builds must be measured for whether positions actually move.

9. **Position/order bias, unmeasured.** (§5.2.) A median model flips its choice **41.3%** of the time on order swap. Party A always files first in fairjudge. Nobody in category 1 shows any sign of testing for this.

10. **Judge personas with clinical titles and no disclaimer.** (§1.1.) *"Clinical Psychologist"*, *"Marriage Counselor"* as selectable AI judges, in a product with no advice disclaimer. Regulatory and ethical exposure, and it borrows credibility the system has not earned.

11. **The unjoined-partner state is universally undesigned.** Paired's own support docs and App Store listing (§2.1) say nothing about it; TheMediator.AI (§3.1) says nothing about Party B never responding. The one exception is SyncWithLove's progress indicators (§2.2). This is a systemic blind spot in the whole two-person category.

12. **Capitulating on the two-person premise.** `(snippet only, unverified)` Lasting reportedly telling users solo use is fine and common (§2.3). If true, this is the market's honest verdict on how hard partner recruitment is — and it is the risk fairjudge must plan for, because the same pressure will arrive.

13. **Entertainment framing as a liability shield.** (§1.3.) Fine for a novelty; unavailable to fairjudge, and it may be *why* this category is stuck. Every "AI settles your argument" Show HN found scored 1–2 points with ~0 comments (§1.5).

14. **Converting silence into an adverse finding — measured, and it backfired.** (§3.0.) Utah's mandatory ODR made non-registration within 14 days an automatic default judgment. Default rates went **43% → 59%** overall and **46% → 62%** for institutional plaintiffs; 603 extra default judgments; five payday lenders filed 83% of cases. **A usability study had warned in advance.** Efficiency gains accrued to the party who files most fluently. This is the strongest available empirical argument for fairjudge's core rule.

15. **Silent state changes.** (§6.3 Replika, §6.5 Tessa.) Replika's *"Let's change the subject"*; Tessa's rules-based system silently becoming generative via an unreviewed vendor upgrade. **Same failure: behavior changed and the user wasn't told.** If fairjudge starts toward a full judgment and then downgrades on encountering one-sided evidence, the downgrade must be announced at the moment it happens, with the reason.

16. **A safety property that isn't pinned to anything durable.** (§6.5.) Tessa's guardrails evaporated in a vendor upgrade nobody safety-reviewed. **A refusal rule that lives in a prompt will drift.** Independent second argument for deriving output levels in code.

17. **User state that doesn't override topic.** (§6.5.) Tessa kept giving calorie-restriction advice *after* being told the user had an eating disorder. For fairjudge: an abuse indicator must hard-switch the response mode, not merely adjust the judgment's tone.

18. **Denying the first report.** (§6.5.) NEDA initially denied the advocate's account, then deleted the denial when evidence surfaced. **The denial cost more trust than the bug did.**

19. **A crisis referral that is only a phone number.** (§6.2.) 2.4% uptake, against 49.2% for a safety plan. Shipping the hotline alone satisfies the review and helps almost nobody. Related: `(snippet only)` **217 of 302 mental-health apps ship with no crisis resource at all** — the floor is low enough that clearing it is nearly free.

20. **Treating safety as a cost center.** (§6.1.) The most clinically rigorous product in the mental-health category — 1.5M users, $107.5M raised, the best-documented guardrails found anywhere in this survey — shut down its consumer app on 2025-06-30. **fairjudge's refusal has to be the thing users tell their friends about, not a gate they resent.** That is a positioning problem, and it is the one that killed the best-designed player in an adjacent category.

---

# 4. The gap — what nobody in this survey does

Ordered by how defensible each is as differentiation.

1. **Nobody refuses — and the one system that adjudicated on a one-sided record made things measurably worse.** Not one consumer product examined has a "we will not render a verdict on this" state; the category's entire value proposition is *always* producing a verdict. The nearest neighbours are TheMediator.AI's non-binding framing and AYTA's self-undermining disclaimer — both still always output something. Meanwhile, the professional systems **agree with fairjudge without saying so**: every ODR timeout found terminates in *default judgment* or *eligibility expiry*, i.e. procedurally adverse, never a finding on the merits (§3.8b); blind bidding refuses to touch liability at all (§3.6); and Utah — the one system that let silence decide outcomes — produced a **43% → 59% jump in default judgments** favouring high-volume institutional filers (§3.0). **fairjudge's refusal-by-default inverts the consumer category's premise while being the only consumer product that follows the professional field's actual practice.** That is the strongest single positioning claim available.

2. **Nobody derives output level from evidence quality in code.** Every product produces one output shape regardless of input quality. fairjudge's L1/L2/L3/refused ladder, computed deterministically outside the model, has **no analog anywhere in this survey** — not in the consumer apps, not in the ODR products, not in the multi-agent repos. The closest structural relatives are PandaLM's conflict→tie rule (§5.3) and `moot-court-ai-lite`'s FSM control (§4.8), and neither is grading evidence.

3. **Nobody combines genuine two-party intake with adversarial multi-agent deliberation.** They split cleanly: the two-party products (Paired, Lasting, TheMediator.AI) use no debate architecture; the debate architectures (MAD, ChatEval, AgentCourt, Perspectives) all operate on a single input from a single user. **fairjudge sits in an empty cell.** `AnttiHero/lavern` (288 stars, "evidence-backed debate with mandatory human gates") is the only thing near it and it is a legal-document product, not a two-person one.

4. **Nobody makes consent a gate on what the other party receives.** The competitive default is the opposite: the verdict card exists to be broadcast (§1.4). TheMediator.AI firewalls raw statements from both parties (§3.1) but that is confidentiality, not consent — neither party chooses what the other receives. **A judgment whose distribution the subject controls is, as far as this survey found, novel.**

5. **Nobody freezes and versions a judgment.** Every product treats the verdict as ephemeral content. TheMediator.AI's PDF and Perspectives' PDF report are the closest, and both are exports rather than immutable versioned records. Freezing matters precisely because of anti-pattern #4 — a frozen, versioned judgment cannot be re-rolled until it says what one party wants.

6. **Nobody instruments for their own biases.** No consumer product shows evidence of swap-testing, position-consistency measurement, or verbosity normalization — despite the eval literature (§5.1, §5.2) having established both the failure and the fix. A product in this domain that ships a measured position-consistency check is doing something the entire consumer category has skipped, and it is *demonstrable* in a case study.

7. **Nobody designs the asymmetric wait.** One partial exception (SyncWithLove's progress indicators, §2.2), and it is a lightweight quiz app, not a conflict product. Nobody has designed for *"you filed, they haven't, and we won't judge until they do — here is what that feels like for the next three days."* **This is fairjudge's hardest and most ownable screen.**

8. **Nobody carries safety design into relationship conflict.** Zero abuse-detection, crisis-referral, or scope-boundary language in any category-1 listing examined — while marketing personas named "Clinical Psychologist" (§1.1). An intimate-conflict product will encounter coercive control and abuse; the entire consumer category is silent on it. Note that **neither app store requires crisis resources** (§6.5) and `(snippet only)` **217 of 302 mental-health apps ship without any** — so the differentiation is available and cheap. The specific unoccupied position: **an abuse-detection path that is architecturally separate from the evidence-sufficiency path**, because adjudicating "fault" inside an abusive dynamic actively harms the victim and is a categorically different refusal from "I don't have enough evidence."

8b. **Nobody has designed a good refusal.** The mental-health category supplies the negative examples (Replika's *"Let's change the subject"*, §6.3) and the theory (ARSH/CCS's four beats, §6.6), and Character.AI supplies the copy register (*"we are deeply sorry that we **have to**"*, §6.4) — but **no shipping product was found whose core UX is a well-executed refusal.** fairjudge's refusal screens are not a defensive necessity to be minimized; they are the most under-explored design surface identified in this entire survey, and the most portfolio-legible.

9. **Local-first is claimed by exactly one competitor, and it is a headline.** Let's Settle This: *"Your arguments never leave your device"* (§1.1), on-device Apple Intelligence, 9.1 MB. Not a gap so much as a confirmation — **the positioning works and it is nearly unoccupied.** It is also the natural resolution of anti-pattern #5: covert use is much less injurious when nothing was uploaded anywhere.

---

# 5. Open questions the synthesis agent should settle

**Unfinished research (would resolve with more time):**

1. **Highest-value unfetched primary sources**, in priority order: (a) the **Utah ODR Pilot Project Final Report** — https://ncsc.contentdm.oclc.org/digital/collection/adr/id/63/ — would firm up the snippet-only Utah participation/default figures behind §3.0, this survey's central evidence; (b) **Dyspute.ai "Adri v2"**, a 24/7 *asynchronous* AI mediation platform launched Jan 2026 (§3.7) — the closest named competitor found and completely uninvestigated; (c) the **ARSH/CCS paper PDF** (arXiv:2512.18776), whose four-beat refusal structure is only known here at abstract level.
2. **Verify the Lasting solo-use claim.** `(snippet only)` third-party reviews say Lasting tells users solo use is fine and common; the App Store listing frames it as two-user. **This is the most decision-relevant unverified fact in the survey** — if the category leader quietly abandoned the two-person premise, fairjudge needs a plan for the same pressure.
3. **Verify or discard the "42% misjudgment / 5-of-14" AITA figures** (§1.8). They appear in search summaries but I could not attach them to a primary source. Do not cite until confirmed against arXiv:2501.18081 or the underlying study.
4. **Read `AnttiHero/lavern` (288 stars).** "Evidence-backed debate with mandatory human gates" is the closest architectural description found to fairjudge. Not opened.
5. **Read the full Du et al. paper (arXiv:2305.14325).** The abstract does not give agent count, round count, inter-agent visibility, or the aggregation rule — all four are needed to actually implement it.
6. **Read AgentCourt's source, not just the paper.** Neither the abstract nor the README explains **how the judge agent renders a verdict**, which is the part fairjudge most needs.
7. **Retry the blocked pages:** WhoWon (403), Disputron (403), Junkee's AYTA coverage (403), Angie Couples Court (title only), HN 46960241 (429). Disputron's "watch the AI lawyers argue" and "appeal" mechanics are the most interesting unretrieved items.
8. Product Hunt was not usefully reached; no upvote figures for any category-1 product were obtained. X/Twitter coverage of viral "we let AI judge our fight" moments was not found beyond TikTok discovery pages — this may genuinely be a TikTok-native phenomenon rather than an X one.

**Design decisions this survey surfaces but cannot make:**

9. **Refusal vs. the AYTA envelope.** When only party A has spoken, is the right output *"we will not judge"* (fairjudge's current stance) or *"here is the harshest reading, the most sympathetic reading, and the middle — and their spread is the point"* (AYTA, §1.6)? The second still refuses to allocate responsibility, but it hands the user something. Given that a refusal with no artifact reads as a broken product (§2.10), the envelope may be the better *presentation* of the same principled position. **This is the highest-leverage open design question in the survey.**

10. **Firewall the raw evidence, or surface confirmed utterances?** TheMediator.AI never shows either party the other's actual words (§3.1) — which structurally eliminates the "you screenshotted me" injury (§3.5). fairjudge's confirmed-utterance model is more transparent and more contestable. These are genuinely different products, not two implementations of one; pick deliberately.

11. **How is the second party invited?** Three validated options with different costs: no-account private link (SyncWithLove — lowest friction, weakest identity, hard to reconcile with local-first), 6-character code + link (Paired — proven at 8M downloads), or pass-the-phone co-located (Let's Settle This — no infrastructure, no async, but requires both people willing to be in a room during a fight, which is exactly when they may not be). **Local-first storage and remote two-party pairing are in real tension and this survey does not resolve it.**

12. **What is the timeout?** Now answerable in principle, and the ODR evidence constrains it hard. Real deadlines exist everywhere (Utah 14 days, Matterhorn parking 14 days, Matterhorn traffic 8 days to enter and 10 days to act — §3.8b), but **every one of them terminates in a procedural outcome, never a finding on the merits**, and the one that came closest to a merits outcome measurably backfired (§3.0). So the remaining question is narrow but real: on expiry, does a fairjudge filing (a) go dormant and re-openable, (b) expire and require refiling, or (c) convert to a permanently one-sided *descriptive* artifact that explicitly allocates nothing? **What it must not do is resolve responsibility.** Matterhorn's remand loop (§3.2) suggests a fourth option worth costing: no expiry at all, just a pending state with a named unblocking condition and a nudge cadence.

12b. **Does refusal present as a terminal state or a pending one?** Related to 12 but distinct, and it may be the highest-leverage copy decision in the product. "Refused" frames the system as having judged the *submission*; "pending — waiting on the other party" frames it as having judged nothing yet. The ARSH finding (§6.6) — that a badly delivered refusal **discourages future help-seeking** — argues strongly for the second framing wherever it is honest. But it is only honest if the other party genuinely can still act.

12c. **Where does the abuse/IPV path live, and who builds it?** §6.7 argues it must be architecturally separate from the evidence-sufficiency ladder (this matches the repo's existing rule that crisis referral is a deterministic path with no model call). Unsettled: what triggers it, whether detection is model-side or rule-side, whether the *other* party is notified when it fires, and whether a case that trips it is deleted, frozen, or simply never judged. `(snippet only)` Validated screening instruments exist (https://www.jmir.org/2021/12/e24114) and most consumer apps do not use them.

12d. **Does fairjudge adopt the ICODR standards explicitly?** §3.5 is a published, checkable nine-point standard from a real standards body — Fair and Impartial, Transparent, Confidential, Equal, Accessible, Accountable, Competent, Legal, Secure. Adopting it publicly gives the product an external referent for its neutrality claim (§2.10b) and gives the portfolio case study a rubric it did not invent for itself. The cost is that some of the nine are genuinely demanding (Accountable requires *"auditable processes and human oversight"*).

13. **Does the first-mover bias get an explicit countermeasure?** Party A always files first (§4.5's first-mover asymmetry; §5.2's 41.3% flip rate). Options: swap-test every judgment and use consistency as a grading input; randomize presentation order; or normalize both submissions before the judging stage. Probably all three, but the swap-test result feeding the L-level grade is the one that is both principled and demonstrable.

14. **How much of the deliberation is shown?** Disputron shows the AI lawyers arguing (§1.5); ChatEval retains every judge's separate evidence (§4.3); most products show only the conclusion. Showing the work makes refusals legible and disagreement visible — and it is also more surface area to be weaponized in an argument (anti-pattern #4).

15. **Cost and latency.** AutoGen's docs note the critic pattern roughly doubles inference calls (§4.6); a multi-agent panel plus swap testing multiplies further. Against a competitor running a single on-device model in a 9.1 MB app (§1.1), fairjudge's pipeline is orders of magnitude heavier. If local-first is a hard requirement, the panel size and the swap-test budget are constrained by what runs on-device — **this constraint should be settled before the architecture is, not after.**
