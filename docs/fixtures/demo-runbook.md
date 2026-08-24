# Demo runbook — driving the three acts

Operating instructions for the authored demonstration case. The case itself is
`docs/fixtures/demo-case.md`; this file is how you make it happen, and which screen each step is
there to photograph.

**Act I is done and reproducible today.** Acts II and III are staged here rather than run: they
need the counterparty surfaces from the engine batch (`/respond/<token>` decline mechanics, the
standing door, the wait panel, simultaneous release). Every command below is written against
functions that exist; the ones that need a screen that does not exist yet are marked **(needs UI)**.

---

## 0. Rules that apply to every command here

- **Everything runs against `data/fairjudge-demo.db`.** Never `data/fairjudge.db`. The seed script
  refuses that path four ways (unset variable, same path, same inode, `DATABASE_URL` outranking
  the variable you set) and refuses any database that already holds a non-fixture case.
- **The demo database is not committed.** `/data/` is git-ignored in full. Rebuild it from the
  seed; that is what the seed is for.
- `.env.local` supplies `FAIRJUDGE_DB_KEY` (the demo DB is SQLCipher-encrypted like any other) and
  `ANTHROPIC_API_KEY`. Scripts load it with `loadEnvLocal()`.
- Money: Act I costs about **$1.95**. Act III's re-hearing is the expensive one — the equivalent
  run on the real case cost **$2.57** at `max` effort. Budget accordingly; `--budget` caps Act I.

---

## Act I — alone (L2). Runs today.

```bash
# 1. Seed. Deterministic, free, re-runnable: it drops and rebuilds its own case.
FAIRJUDGE_DB_PATH=data/fairjudge-demo.db npx tsx scripts/seed-fixture.ts

# 2. Hear it. Real model calls: steelman → issue lists → adverse facts → level lock → judgment.
FAIRJUDGE_DB_PATH=data/fairjudge-demo.db npx tsx scripts/seed-fixture.ts --hear
```

`--hear` re-seeds first, so step 2 alone is enough for a clean run. `--budget 3.5` is the default;
the script checks `llm_calls` before each paid step and stops rather than overrun.

**Verified 2026-08-17.** Level `L2` / `counterparty_absent`; grades A:3 B:1 C:2 D:1; citable 14,
by client **0**, by counterparty 14; judgment v1 `final` on `claude-fable-5` @ `xhigh`, no
fallback; 20 claims, 8 sections, one `self_only`. Five calls, **$1.9338**.

### What to photograph, and which state it is

| # | Surface | Doc 05 §A.1 state | What it demonstrates |
|---|---|---|---|
| 1 | `/case/<id>` — intake summary | **1 DRAFTED** | The case labelled fictional (`is_fixture`), and the intake answer *"I want to know whose fault it was"* standing next to a product that will not answer it from one account |
| 2 | Evidence workbench | 1 | Grades A–D on the same board; EV-7 sitting at C with reason `derived_from` although it is a genuine unaltered screenshot |
| 3 | Timeline | 1 | The 23-day gap between 2026-05-03 and 2026-05-27 rendered as a gap; four dated events carrying no material at all |
| 4 | **Judgment → `record_basis` section** | 1 | **Beat 3.** *"spoken by you — zero."* The single strongest screen in the piece |
| 5 | Judgment → `to_you_alone` (`audience: self_only`) | 1 | The paragraph that counts against the person who commissioned the judgment |
| 6 | Judgment → `unresolved` | 1 | The February question, carried through as `reason: clarification_unanswered` — the thing Act II closes |
| 7 | Clarification board | 1 | Round 1 closed, round 2 saturated with its only question still open |

---

## Act II — she answers

Doc 05 §C amendment 6: Act II walks the **whole** state machine, including the wait and including
a decline. A demo that jumps from "invite sent" to "she consented" demos the parts competitors
also have.

### II-a. The invitation is minted — state 2 INVITED

```ts
import { issueInviteToken } from "../src/server/access/invite";
const invite = issueInviteToken(db, counterpartyId);   // single-use, hashed, 14-day expiry
console.log(invite.token);                              // returned once, never stored
```

**Photograph (needs UI):** *Adrian's* wait surface — `src/app/case/[id]/wait-panel.tsx`. Doc 05
§A.2: invitation state as **discrete completed acts with timestamps**, the level's reason stated as
the unblocking condition, and the three things he can still do. It must show **no** progress, **no**
counts, and **no** notification that she opened anything. This is the screen the survey found
nobody has built.

### II-b. She arrives — state 3 ARRIVED

Open `/respond/<token>`. `buildCounterpartyEntry` renders what the case says *about her*, the
steelman of her own position, and a link to the shareable v1 — and not the judgment inline, not his
evidence store, not his clarification answers, not the safety-screen answers.

**Photograph:** the entry screen, and `/respond/<token>/data` (subject access: every row concerning
her, with provenance). Note the sentence that says opening this page was not reported to him —
rendering is not an act (`touch: false`).

### II-c. She declines — state 4 DECIDED, the branch

Run this on a **branch copy** so the canonical demo can continue down the consent path. Nothing is
retconned: the decline is a real recorded act, shown once, in its own database.

```bash
cp data/fairjudge-demo.db data/fairjudge-demo-decline.db
```

```ts
import { declineParticipation } from "../src/server/participation/submission";
declineParticipation(db, {
  caseId,
  participantId: counterpartyId,
  reason: "我现在不想被评判。如果他想说什么,让他自己来说。",  // verbatim, never translated
});
```

**Photograph (needs UI):** her confirmation that the refusal is recorded and procedurally inert;
his side showing `refused` as a participation fact and nothing more; the minting closed
(`mintingRefusal`); the link converted to a standing revocable door (`openStandingDoor`,
`readDoorStanding` in `src/server/participation/door.ts`). Doc 05 §A.4 — the refuser must not be
punished for refusing.

### II-d. She consents and speaks — state 5 HEARD

Back on `data/fairjudge-demo.db`:

```ts
import { submitStatement, confirmOwnLine } from "../src/server/participation/submission";

// Six lines, verbatim from demo-case.md §5.2. Grade B by rule (recollection),
// owned by her, and `submitStatement` grants `case_record` in the same transaction.
const submitted = submitStatement(db, {
  caseId,
  participantId: counterpartyId,
  text: [
    "I'm answering because he wrote it all down and I'd rather be quoted from my own mouth than from his screenshots.",
    "我从来没说过不做。我说的是\"以后再说\"。他听成了\"不做\",然后自己做了决定。",
    "The account has no rule because we never needed one. Neither of us had ever taken anything out of it without the other knowing. He is right that there was no rule. He is wrong that there was no expectation.",
    "What I couldn't forgive in April wasn't the money. It was that he told two other people in March, and then arranged the moment so that the only way to say no was in front of them.",
    "我也有错。我这四年里把每一件事都推到\"以后\",他跟我说了两年\"我们一起做点什么\",我一次都没有给过他一个日子。",
    "I'd have said yes to the studio. I'd have said yes in February. He never gave me the chance to be the person who said yes, and now I can't prove I would have been.",
  ].join("\n"),
});

// Her own per-line confirmation pass — the act that makes her material citable.
for (const utteranceId of submitted.utteranceIds) {
  confirmOwnLine(db, { caseId, participantId: counterpartyId, evidenceId: submitted.evidenceId, utteranceId });
}
```

Then her clarification round — her own ≤3 × ≤3 budget, and the answer that closes Act I's open
question (demo-case.md §5.3):

```ts
import { recordClarificationRound, answerClarificationQuestion } from "../src/server/pipeline/clarification";
const round = recordClarificationRound(db, {
  caseId,
  questions: [{ question: "In February, when the two of you talked about \"doing something together\", what did you actually say?" }],
});
answerClarificationQuestion(db, {
  caseId,
  roundId: round.round.id,
  questionId: round.round.questions[0].id,
  answer: "我说的是\"以后再说\"。这四个字他听成了\"好\"。我当时确实没有拒绝——我也确实没有答应。",
});
```

**Photograph (needs UI):** her `ConfirmCard` pass — the same confirmation discipline he went
through, applied to her own words. And, on **his** side, the wait panel showing only *"she has
submitted a statement"* and *"her confirmation is complete"* — discrete acts, no content, no
counts, no live progress.

### II-e. The level moves, and is offered rather than fired

```ts
import { collectOutputLevelInputs, readOutputLevel } from "../src/server/pipeline/output-level";
console.log(collectOutputLevelInputs(db, caseId));  // hasCounterpartyConfirmed → true
console.log(readOutputLevel(db, caseId));           // locked L2, decision L1, stale: true
```

`stale: true` is the whole design: the locked level does not quietly follow her around. v1 stands
frozen at L2 (hard rule 6) and both parties are told a re-hearing is **available**.

**Photograph (needs UI):** the "the record has changed — a re-hearing is available" state, shown to
both, with neither auto-fired. Doc 05 §A.1: a ~$2.5 hearing that two people will read has to be an
act somebody chose.

---

## Act III — re-heard (L1, v2)

Either party may file; the appeal machinery is per-actor, so his filing does not consume hers.

```ts
import { fileAppeal, hearAppeal } from "../src/server/judgment/appeal";

const appeal = fileAppeal(db, judgmentV1Id, {
  actorParticipantId: clientId,          // or counterpartyId — both are first-class
  grounds: "She has answered. The record this was decided on no longer exists.",
});

// The expensive call. The equivalent run on the real case: $2.5725, 558.6s, claude-fable-5 @ max.
const outcome = await hearAppeal(db, appeal.id);
```

`hearAppeal` runs `relockOutputLevel` and writes `version + 1`; v1 is left `superseded`, never
edited and never deleted.

**Expected:** L1 / `bilateral`; finding `both_parties_submitted_material` replaces
`counterparty_submitted_nothing`; a two-way responsibility finding, which L2 structurally could not
state. `citableUtterances.byClient` is **still 0** — see demo-case.md §6, and say so on the page
rather than hoping nobody checks.

| # | Surface | Doc 05 §A.1 state | What it demonstrates |
|---|---|---|---|
| 8 | Judgment v2 at L1 | **6 RE-HEARD → BOTH READ** | **Beat 5.** Responsibility allocated for the first time; what became sayable when the record changed |
| 9 | Version list — v1 `superseded`, frozen | 6 | Hard rule 6: nothing was voided, and the diff discloses what changed and which model produced it |
| 10 | Simultaneous release **(needs UI)** | 6 | Doc 05 §C amendment 7: neither party's reading gates the other's. Sequential unlock manufactures the exact grievance a judgment exists to retire |
| 11 | Share diff + export gate | 6 | **Beat 6.** What is withheld from her copy and why; the non-removable provenance notice riding on the artifact (amendment 5) |

---

## The refusal triptych — beat 7, and not part of this case

Doc 05 §C amendment 1 promotes the refusal states to hero position 3, as **three** screens with
three different messages. Two of them this case already produces:

- **Capability** — "only one side has spoken." Act I's L2 disclosure, live.
- **Uncertainty** — "the finding did not survive the swap / the evidence contradicts itself."
  From `judgment/swap-test.ts` on this same case.

The third — **policy**, the safety referral — must **not** be demonstrated on this fixture. Its
questionnaire is all-clear by design, and flipping an answer to force a referral would put a
domestic-violence flag on an invented couple purely to generate a screenshot. Build that screen
from `src/server/safety/resources.ts` against a throwaway case instead. The referral path is
deterministic and takes no model call (hard rule 9), so it needs no fixture at all.

---

## Rebuilding from nothing

```bash
rm -f data/fairjudge-demo.db data/fairjudge-demo.db-shm data/fairjudge-demo.db-wal
FAIRJUDGE_DB_PATH=data/fairjudge-demo.db npx tsx scripts/seed-fixture.ts --hear
```

`createDb` + `runMigrations` bootstrap an empty encrypted file; the seed refuses to touch anything
that already holds a real case. Expect ~$1.95 and about four minutes.

## Known friction

- **The judgment prose names 甲 and 乙, not Adrian and Yiwen.** The judgment stages run with
  pseudonyms kept, which is correct — that is what leaves the machine. Restoring display names is
  the render layer's job (`depseudonymize`, `src/server/pseudonym/gateway.ts`); take case-study
  screenshots from a surface that does it, or the piece will read as machine output rather than as
  a document about two people.
- **No image blobs.** The fictional artifacts have no screenshots behind them, so `evidence.file_id`
  is NULL throughout and the evidence board has summaries where a case study might want thumbnails.
  Inventing image files would be the only dishonest thing in the fixture; if the piece needs them,
  they should be drawn as obvious illustrations, not passed off as captures.
- **Two people is the dictionary's limit.** `buildCaseDict` registers `case_participants`, so the
  record deliberately names no third party. Friends are "two other people"; the mother is 我妈.
