/**
 * Seed the authored demonstration case — Act I.
 *
 * The showcase cannot run on the real case: its counterparty never consented to
 * the material being processed, let alone published (04-ux-design-plan.md §6.2).
 * So the demo is an authored fiction, written in `docs/fixtures/demo-case.md`,
 * and this script is the only thing that turns that document into a database.
 *
 * Two people, both invented. Adrian (initiator, submitter, 乙) and Yiwen
 * (respondent, 甲) do not exist. The case row carries `is_fixture = true`, which
 * is product content rather than a debug flag: every surface that names this
 * case has to say it is fictional.
 *
 * ## What this script refuses to do
 *
 * It will not run without `FAIRJUDGE_DB_PATH`, and it will not run against
 * `data/fairjudge.db` — not by path, not by symlink, not by hard link, and not
 * by way of `DATABASE_URL` quietly outranking the variable you set. It also
 * refuses any database that already contains a case which is not a fixture,
 * which catches the backups and snapshots too. On 2026-08-12 an agent following
 * a task book wrote fabricated confirmed utterances into the live record of a
 * real person's relationship; the guards below are that incident, in code.
 *
 * ## Two phases, and why the money one is opt-in
 *
 *   `tsx scripts/seed-fixture.ts`          seeds Act I. Deterministic, free,
 *                                          re-runnable: it drops and rebuilds
 *                                          its own case by a stable title.
 *   `tsx scripts/seed-fixture.ts --hear`   additionally drives the real pipeline
 *                                          — steelman, issue lists, adverse
 *                                          facts, level lock, judgment — through
 *                                          the same server functions the app
 *                                          calls. This spends real money and is
 *                                          capped (`--budget`, default $3.50).
 *
 * Splitting them is not fastidiousness: seeding has to stay free so the fixture
 * can be rebuilt at will, and a hearing has to be an act somebody chose.
 *
 * ## Evidence content is verbatim
 *
 * Every line of the record below is authored content, and authored content is a
 * verbatim record the moment it exists (CLAUDE.md, language policy). The strings
 * in this file are byte-identical to `docs/fixtures/demo-case.md` — the couple
 * writes mostly in English and switches to Chinese exactly where the document
 * says they do. Nothing here is normalized, re-punctuated or translated.
 */

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq, sql } from "drizzle-orm";

import { createDb, runMigrations, DEFAULT_DB_PATH, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  eventEvidence,
  events,
  llmCalls,
  utterances,
  type EvidenceSourceType,
  type OccurredPrecision,
  type UtteranceTone,
} from "../src/server/db/schema";
import { deriveEvidenceGrade } from "../src/server/domain/grading";
import { loadEnvLocal, PROJECT_ROOT } from "../src/server/env";
import { confirmEvidenceGrade, confirmUtterance } from "../src/server/evidence/workbench";
// Imported from concrete modules rather than the `pipeline` / `judgment`
// barrels: a seed script should not stop working because an unrelated
// re-export somewhere in a barrel is mid-edit.
import {
  acknowledgeAdverseFact,
  generateAdverseFacts,
  listAdverseFacts,
} from "../src/server/pipeline/adverse-facts";
import {
  answerClarificationQuestion,
  markClarificationSaturated,
  recordClarificationRound,
} from "../src/server/pipeline/clarification";
import { confirmIssue, generateIssues, listIssues } from "../src/server/pipeline/issue-fixing";
import {
  collectOutputLevelInputs,
  lockOutputLevel,
} from "../src/server/pipeline/output-level";
import { setCounterpartyParticipation } from "../src/server/pipeline/participation";
import { advanceStage } from "../src/server/pipeline/stage-machine";
import { generateSteelman, recordSteelmanVerdict } from "../src/server/pipeline/steelman";
import { generateJudgment } from "../src/server/judgment/publication";
import { runIntakeSafetyGate } from "../src/server/safety/gate";
import { buildSafetyAnswers } from "../src/server/safety/questionnaire";

/* -------------------------------------------------------------------------- */
/* Identity of the fixture                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stable marker. Re-running drops the case with exactly this title and
 * rebuilds it, so the script is safely re-runnable without accumulating copies;
 * nothing else in any database is touched.
 */
const FIXTURE_TITLE = "Demo case — the someday account (fictional)";

/** Local-only real names. Registered so the gateway has something to replace. */
const CLIENT_NAME = "Adrian";
const COUNTERPARTY_NAME = "Yiwen";

/** Egress pseudonyms, matching the product's existing convention. */
const CLIENT_PSEUDONYM = "乙";
const COUNTERPARTY_PSEUDONYM = "甲";

const ONESIDEDNESS_DISCLAIMER =
  "This is an authored demonstration case. Both people in it are fictional. " +
  "Every item in the record was submitted and confirmed by 乙 (the client): it " +
  "is his collection of her messages, her voice memos, her note and one post " +
  "she forwarded him. 甲 has put nothing of her own into this record and does " +
  "not know the case exists, so nothing here can be read as her account of " +
  "anything. Read every quotation attributed to her as material he kept, and " +
  "hold his account of himself to the same standard as her recorded words.";

/* -------------------------------------------------------------------------- */
/* The record — authored content, byte-exact with docs/fixtures/demo-case.md   */
/* -------------------------------------------------------------------------- */

interface EvidenceSpec {
  readonly ref: string;
  /** Registration kind in the intake vocabulary, for the audit sentence. */
  readonly registeredAs: string;
  readonly sourceType: EvidenceSourceType;
  /** Set on EV-7: a real screenshot of something produced from other evidence. */
  readonly derivedFrom?: string;
  readonly contentSummary: string;
}

const EVIDENCE: readonly EvidenceSpec[] = [
  {
    ref: "EV-1",
    registeredAs: "screenshot",
    sourceType: "firsthand",
    contentSummary:
      "2026-04-25. Her messages the night of the anniversary dinner, screenshotted one at a time as they arrived.",
  },
  {
    ref: "EV-2",
    registeredAs: "ai_session",
    sourceType: "ai_processed",
    contentSummary:
      "2026-04-26. Auto-transcripts of two voice messages she sent (1:47 and 3:12), screenshotted from the transcript pane.",
  },
  {
    ref: "EV-3",
    registeredAs: "screenshot",
    sourceType: "firsthand",
    contentSummary:
      "2026-05-02. A note she wrote in their shared notes app, titled \"before we talk again\".",
  },
  {
    ref: "EV-4",
    registeredAs: "retelling",
    sourceType: "recollection",
    contentSummary:
      "2026-05-04. His typed recollection of the kitchen argument of 2026-05-03, written the next morning. No record of that conversation exists.",
  },
  {
    ref: "EV-5",
    registeredAs: "mass_content",
    sourceType: "public_sentiment",
    contentSummary:
      "2026-05-28. A 小红书 post she forwarded him (4.2k comments), with her one-line caption. The post's author is not a party to this case.",
  },
  {
    ref: "EV-6",
    registeredAs: "screenshot",
    sourceType: "firsthand",
    contentSummary:
      "2026-06-02. Her messages after she learned that two friends had been told in March.",
  },
  {
    ref: "EV-7",
    registeredAs: "screenshot",
    sourceType: "firsthand",
    derivedFrom: "EV-1",
    contentSummary:
      "2026-06-03. An assistant's summary of EV-1, which he generated to work out what she meant, then screenshotted.",
  },
];

interface UtteranceSpec {
  readonly ref: string;
  readonly evidenceRef: string;
  readonly speaker: "client" | "counterparty";
  readonly isRetold: boolean;
  readonly confirmed: boolean;
  readonly tone?: UtteranceTone;
  readonly text: string;
}

/**
 * Nineteen lines, in reading order.
 *
 * Fourteen are confirmed and every one of them is hers. Five are his, or unsure
 * of themselves, and every one of those is `pending` — which is the whole point
 * of the fixture: under HARD RULE #1 an unconfirmed line is not citable, so the
 * client of this case has never spoken in it.
 */
const UTTERANCES: readonly UtteranceSpec[] = [
  // EV-1 — 2026-04-25, after the dinner (A).
  {
    ref: "U01",
    evidenceRef: "EV-1",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "I need you to hear that I'm not upset about the studio.",
  },
  {
    ref: "U02",
    evidenceRef: "EV-1",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "I'm upset that I found out at the same time as everyone else at that table.",
  },
  {
    ref: "U03",
    evidenceRef: "EV-1",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "Adrian. You didn't give me a present. You gave me a receipt and four people watching to see how I'd take it.",
  },
  {
    ref: "U04",
    evidenceRef: "EV-1",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "tired",
    text: "我不是生气,我是没话说了。",
  },

  // EV-2 — 2026-04-26, two voice messages, auto-transcribed (C).
  {
    ref: "U05",
    evidenceRef: "EV-2",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "okay I slept on it and I still — I don't think you did this to hurt me. I think you did it because you knew I'd say let's wait and you didn't want to hear it. That isn't a surprise. That's going around me.",
  },
  {
    ref: "U06",
    evidenceRef: "EV-2",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "我昨天晚上算了一下,那个账户里大概六成是我放进去的。不是钱要分那么清楚,是你动的时候一句都没问我。",
  },
  {
    ref: "U18",
    evidenceRef: "EV-2",
    speaker: "client",
    isRetold: true,
    confirmed: false,
    text: "那个账户就是留着我们一起做点什么的。",
  },

  // EV-3 — 2026-05-02, her note "before we talk again" (A).
  {
    ref: "U07",
    evidenceRef: "EV-3",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "Three things I need you to answer instead of explain. 1) When did you decide. 2) Who knew before I did. 3) What happens if I say no.",
  },
  {
    ref: "U08",
    evidenceRef: "EV-3",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "I keep hearing that I defer everything. I do. I defer things I haven't agreed to yet. That is not the same as never.",
  },
  {
    ref: "U15",
    evidenceRef: "EV-3",
    speaker: "client",
    isRetold: true,
    confirmed: false,
    text: "We can figure out the details later, the point is that it's ours.",
  },

  // EV-4 — 2026-05-04, his recollection of the 2026-05-03 argument (B).
  {
    ref: "U13",
    evidenceRef: "EV-4",
    speaker: "counterparty",
    isRetold: true,
    confirmed: true,
    tone: "serious",
    text: "Yiwen said the worst part wasn't the money. It was that other people already knew, so saying no would have made her the one who ruined it.",
  },
  {
    ref: "U14",
    evidenceRef: "EV-4",
    speaker: "counterparty",
    isRetold: true,
    confirmed: false,
    text: "I think she said something like \"you've made me the villain in a story I wasn't even in\". I'm not certain those were the words.",
  },
  {
    ref: "U17",
    evidenceRef: "EV-4",
    speaker: "client",
    isRetold: true,
    confirmed: false,
    text: "I told her I'd called the co-op on the 26th and asked for the deposit back and they said no. She didn't answer that.",
  },

  // EV-5 — 2026-05-28, the forwarded 小红书 post (D).
  {
    ref: "U09",
    evidenceRef: "EV-5",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "tired",
    text: "看到这个的时候我在车里坐着哭了十分钟。你自己看吧。",
  },

  // EV-6 — 2026-06-02, after she learned the date (A).
  {
    ref: "U10",
    evidenceRef: "EV-6",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "I asked him tonight how long he'd known about the studio. He said since March.",
  },
  {
    ref: "U11",
    evidenceRef: "EV-6",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "三月。你三月就跟别人说了,四月底才告诉我,还是当着他们的面。",
  },
  {
    ref: "U12",
    evidenceRef: "EV-6",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "I'm not asking for the money back. I'm asking you to say out loud that you decided I would say no, and made it so I couldn't.",
  },
  {
    ref: "U19",
    evidenceRef: "EV-6",
    speaker: "counterparty",
    isRetold: false,
    confirmed: true,
    tone: "serious",
    text: "你每次都说\"我是为了我们\"。你有没有发现,你一次都没说过\"我应该先问你\"。",
  },
  {
    ref: "U16",
    evidenceRef: "EV-6",
    speaker: "client",
    isRetold: true,
    confirmed: false,
    text: "我是为了我们。",
  },
];

interface EventSpec {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly occurredAt: Date | null;
  readonly precision: OccurredPrecision;
  readonly evidenceRefs: readonly string[];
}

/** Months are 0-indexed in `Date.UTC`. */
const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

/**
 * Eleven events. Four of them are dated and carry no material at all —
 * including the two the client's whole case rests on (E1, the agreement he
 * believes he had; E3, the act itself). The timeline shows them as dated and
 * empty, and the twenty-three days between E7 and E8 are rendered as a gap
 * rather than closed up: the shape of a record is itself a finding.
 */
const EVENTS: readonly EventSpec[] = [
  {
    label: "E1",
    title: "The \"someday\" conversation",
    description:
      "He says she agreed in principle to doing something together. Nothing from this conversation was kept by either of them.",
    occurredAt: day(2026, 2, 1),
    precision: "month",
    evidenceRefs: [],
  },
  {
    label: "E2",
    title: "Two friends are told",
    description:
      "He tells two friends about the studio plan. Known only from what she was told on 2026-06-02; no material from March is in this case.",
    occurredAt: day(2026, 3, 1),
    precision: "month",
    evidenceRefs: [],
  },
  {
    label: "E3",
    title: "The deposit is paid",
    description:
      "$2,400 leaves the joint account as a non-refundable deposit on a year's shared studio membership. Non-refundable at the moment of payment.",
    occurredAt: day(2026, 4, 11),
    precision: "day",
    evidenceRefs: [],
  },
  {
    label: "E4",
    title: "The anniversary dinner",
    description:
      "The studio is announced at dinner, in front of two friends. Her messages that night are EV-1.",
    occurredAt: day(2026, 4, 25),
    precision: "day",
    evidenceRefs: ["EV-1"],
  },
  {
    label: "E5",
    title: "Two voice messages",
    description: "She sends two voice messages the next morning; he screenshots the transcripts.",
    occurredAt: day(2026, 4, 26),
    precision: "day",
    evidenceRefs: ["EV-2"],
  },
  {
    label: "E6",
    title: "The note",
    description: "She writes three questions in their shared notes app and asks him to answer rather than explain.",
    occurredAt: day(2026, 5, 2),
    precision: "day",
    evidenceRefs: ["EV-3"],
  },
  {
    label: "E7",
    title: "The kitchen argument",
    description:
      "The only face-to-face conversation about any of this. Nothing recorded it; what is in this case is his recollection, written the next morning.",
    occurredAt: day(2026, 5, 3),
    precision: "day",
    evidenceRefs: ["EV-4"],
  },
  {
    label: "E8",
    title: "The balance-due email",
    description:
      "The co-op emails the balance due on the membership, twenty-three days into a silence in which nothing was said that either of them kept.",
    occurredAt: day(2026, 5, 27),
    precision: "day",
    evidenceRefs: [],
  },
  {
    label: "E9",
    title: "She forwards a post",
    description: "She forwards a viral 小红书 post with a one-line caption.",
    occurredAt: day(2026, 5, 28),
    precision: "day",
    evidenceRefs: ["EV-5"],
  },
  {
    label: "E10",
    title: "She learns the date",
    description: "She learns that his friends were told in March, seven weeks before she was.",
    occurredAt: day(2026, 6, 2),
    precision: "day",
    evidenceRefs: ["EV-6"],
  },
  {
    label: "E11",
    title: "He asks an assistant what she meant",
    description: "He runs her 2026-04-25 messages through an assistant and screenshots the summary.",
    occurredAt: day(2026, 6, 3),
    precision: "day",
    evidenceRefs: ["EV-7"],
  },
];

/**
 * Clarification, in two rounds.
 *
 * Round 1 closes: both questions are answered. Round 2 asks the one thing that
 * would have produced his first citable line — what she actually said in
 * February — and it is left genuinely unanswered, not declined. Declining is an
 * act; this is a man who could not answer. The round is marked saturated
 * because nothing further was coming, which is what ends the loop.
 */
const ROUND_ONE = [
  {
    question:
      "You describe the account as joint. Was there ever a rule — written or spoken — about what either of you could take out of it alone?",
    whyNeeded:
      "Whether an expectation existed is the difference between a withdrawal and a breach, and it is not visible in the material.",
    answer:
      "No. We opened it in a bank lobby in about twenty minutes and never talked about rules. I assumed joint meant joint. She never said otherwise until this.",
  },
  {
    question:
      "Was the deposit non-refundable at the moment you paid it, or did it become non-refundable later?",
    whyNeeded:
      "It decides whether the announcement at dinner presented her with a choice or with a fact.",
    answer:
      "At the moment. I knew that when I paid it. It's a small co-op and the deposit is what holds the kiln slot. I called them the next morning anyway and they said no, which I have never had any way to prove to her.",
  },
] as const;

const ROUND_TWO = {
  question:
    "You say she agreed in principle in February. What did she actually say, as close to her words as you can get?",
  whyNeeded:
    "Everything he believes he was owed rests on this sentence, and it is the only thing in the case that no submitted material touches.",
} as const;

/** All-clear questionnaire. Fictional case, no safety flags, no crisis path. */
const SAFETY_FORM: Readonly<Record<string, string>> = {
  fear_of_partner: "no",
  physical_harm: "no",
  control: "no",
  monitoring: "no",
  self_harm: "no",
  anything_else:
    "No. It's an argument about money and about being told last. Nothing about it frightens me.",
};

/* -------------------------------------------------------------------------- */
/* Guards — the reason this file exists in the shape it does                   */
/* -------------------------------------------------------------------------- */

function die(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`seed-fixture: ${message}`);
  process.exit(1);
}

/** Same file on disk, through any number of links. */
function isSameFile(a: string, b: string): boolean {
  try {
    if (realpathSync(a) === realpathSync(b)) return true;
  } catch {
    // One of them does not exist yet — fall through to the inode check.
  }
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Resolve the target database, or refuse.
 *
 * `DATABASE_URL` is checked because `resolveDbPath` prefers it over
 * `FAIRJUDGE_DB_PATH`: a guard that validates one variable while the connection
 * factory reads another is not a guard.
 */
function resolveSandboxTarget(): string {
  const raw = process.env.FAIRJUDGE_DB_PATH;
  if (raw === undefined || raw.trim() === "") {
    die(
      "FAIRJUDGE_DB_PATH is not set.\n" +
        "  This script never picks its own database. Point it at the demo file:\n" +
        "    FAIRJUDGE_DB_PATH=data/fairjudge-demo.db tsx scripts/seed-fixture.ts",
    );
  }

  if (process.env.DATABASE_URL !== undefined) {
    die(
      "DATABASE_URL is set, and it outranks FAIRJUDGE_DB_PATH in resolveDbPath().\n" +
        "  Unset it so the path you asked for is the path that gets written.",
    );
  }

  const target = resolve(raw.trim());
  const live = resolve(PROJECT_ROOT, DEFAULT_DB_PATH);

  if (target === live || isSameFile(target, live)) {
    die(
      `refusing to run against the live database (${live}).\n` +
        "  End-to-end verification never runs there (CLAUDE.md, Verification rule).\n" +
        "  The demonstration case is fiction; the live record is about a real person\n" +
        "  who never consented to any of this. Use data/fairjudge-demo.db.",
    );
  }

  return target;
}

/**
 * The last guard, and the one that catches the paths a name check cannot: a
 * backup, a snapshot, a copy someone made last week. If anything in this
 * database is a real case, this script has no business writing to it.
 */
function assertNoRealCases(db: Db): void {
  const rows = db
    .select({ id: cases.id, title: cases.title, isFixture: cases.isFixture })
    .from(cases)
    .all();
  const real = rows.filter((row) => !row.isFixture);
  if (real.length === 0) return;

  die(
    `this database already holds ${real.length} case(s) that are not fixtures.\n` +
      "  Refusing to seed into a database that contains a real case record.\n" +
      "  Seed into a fresh file instead: FAIRJUDGE_DB_PATH=data/fairjudge-demo.db",
  );
}

/* -------------------------------------------------------------------------- */
/* Deterministic ordering keys                                                */
/* -------------------------------------------------------------------------- */

const ORDER_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Lexical order equal to insertion order for < 62 items. Enough for this case. */
function orderKeyAt(i: number): string {
  return `a${ORDER_ALPHABET[i] ?? "z"}`;
}

/* -------------------------------------------------------------------------- */
/* Act I — the deterministic seed                                             */
/* -------------------------------------------------------------------------- */

export interface SeedResult {
  readonly caseId: string;
  readonly clientId: string;
  readonly counterpartyId: string;
  readonly evidenceIds: ReadonlyMap<string, string>;
  readonly utteranceIds: ReadonlyMap<string, string>;
}

/** Drop the fixture case if it is already here. Cascades do the rest. */
function dropExistingFixture(db: Db): number {
  const existing = db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.title, FIXTURE_TITLE))
    .all();
  for (const row of existing) {
    db.delete(cases).where(eq(cases.id, row.id)).run();
  }
  return existing.length;
}

async function seedActOne(db: Db): Promise<SeedResult> {
  const dropped = dropExistingFixture(db);
  if (dropped > 0) log(`  dropped ${dropped} previous copy of the fixture case`);

  // --- stage ① intake ------------------------------------------------------
  const [caseRow] = db
    .insert(cases)
    .values({
      title: FIXTURE_TITLE,
      stage: "intake",
      isFixture: true,
      // "I want to know whose fault it was" — the one answer the product has to
      // respond to with a cost rather than with agreement.
      clientIntent: "allocate_fault",
      onesidednessDisclaimer: ONESIDEDNESS_DISCLAIMER,
    })
    .returning({ id: cases.id })
    .all();
  const caseId = caseRow.id;

  // Registering both people in the pseudonym dictionary IS creating these rows:
  // `buildCaseDict` reads display_name → pseudonym off this table, and an
  // unregistered name blocks egress (HARD RULE #3).
  const [client] = db
    .insert(caseParticipants)
    .values({
      caseId,
      role: "initiator",
      displayName: CLIENT_NAME,
      pseudonym: CLIENT_PSEUDONYM,
      isSubmitter: true,
      participationState: "participating",
    })
    .returning({ id: caseParticipants.id })
    .all();

  const [counterparty] = db
    .insert(caseParticipants)
    .values({
      caseId,
      role: "respondent",
      displayName: COUNTERPARTY_NAME,
      pseudonym: COUNTERPARTY_PSEUDONYM,
      isSubmitter: false,
      // Act I is state 1 of the two-party loop: she does not know this exists.
      participationState: "pending",
    })
    .returning({ id: caseParticipants.id })
    .all();

  const gate = await runIntakeSafetyGate(db, caseId, buildSafetyAnswers(SAFETY_FORM), {
    localOnly: true,
  });
  if (gate.decision !== "pass") {
    die(`the safety gate did not pass on an all-clear questionnaire (${gate.decision}).`);
  }
  log(`  safety screen: ${gate.decision} / ${gate.outcome} (local only, no model call)`);

  // --- stage ② evidence intake --------------------------------------------
  advanceStage(db, caseId, "evidence_intake");

  const evidenceIds = new Map<string, string>();
  EVIDENCE.forEach((spec, index) => {
    const derivedFromEvidenceId = spec.derivedFrom
      ? (evidenceIds.get(spec.derivedFrom) ?? null)
      : null;
    const decision = deriveEvidenceGrade({
      sourceType: spec.sourceType,
      derivedFromEvidenceId,
      anomaly: null,
    });

    const [row] = db
      .insert(evidence)
      .values({
        caseId,
        // The fictional artifacts have no image bytes; there is nothing to
        // point a `files` row at, and inventing one would be the only dishonest
        // thing in this file.
        fileId: null,
        sourceType: decision.sourceType,
        gradeSuggested: decision.grade,
        gradeRationale: `Registered as ${spec.registeredAs}. ${decision.rationale}`,
        derivedFromEvidenceId,
        contentSummary: spec.contentSummary,
        ownerParticipantId: client.id,
        // His own material, in the case he brought: in the case record, not
        // shared with her (SPEC M5 ①).
        visibility: "private",
      })
      .returning({ id: evidence.id })
      .all();
    evidenceIds.set(spec.ref, row.id);
    void index;

    // The human half of the grade. `grade_final` is NULL until this runs, and
    // the level derivation counts nothing but `grade_final`.
    confirmEvidenceGrade(db, { evidenceId: row.id, grade: decision.grade });
  });

  // --- stage ③ transcription ----------------------------------------------
  advanceStage(db, caseId, "transcription");

  const utteranceIds = new Map<string, string>();
  UTTERANCES.forEach((spec, index) => {
    const evidenceId = evidenceIds.get(spec.evidenceRef);
    if (evidenceId === undefined) die(`utterance ${spec.ref} points at unknown ${spec.evidenceRef}`);

    const speakerId = spec.speaker === "client" ? client.id : counterparty.id;
    const speakerLabel =
      spec.speaker === "client" ? CLIENT_PSEUDONYM : COUNTERPARTY_PSEUDONYM;

    const [row] = db
      .insert(utterances)
      .values({
        caseId,
        evidenceId,
        speakerParticipantId: speakerId,
        speakerLabel,
        isRetold: spec.isRetold,
        tone: spec.tone ?? null,
        orderKey: orderKeyAt(index),
        aiDraft: spec.text,
        // Everything starts pending; confirmation is an act, below.
        confirmStatus: "pending",
        // Owned by the client whoever spoke it: he collected all of it.
        ownerParticipantId: client.id,
        visibility: "private",
      })
      .returning({ id: utterances.id })
      .all();
    utteranceIds.set(spec.ref, row.id);

    if (spec.confirmed) {
      confirmUtterance(db, { evidenceId, utteranceId: row.id });
    }
  });

  // --- stage ④ timeline ----------------------------------------------------
  advanceStage(db, caseId, "timeline");

  EVENTS.forEach((spec, index) => {
    const [row] = db
      .insert(events)
      .values({
        caseId,
        label: spec.label,
        title: spec.title,
        description: spec.description,
        occurredAt: spec.occurredAt,
        occurredPrecision: spec.precision,
        orderKey: orderKeyAt(index),
        inTimeline: true,
        confirmStatus: "confirmed",
        ownerParticipantId: client.id,
        visibility: "private",
      })
      .returning({ id: events.id })
      .all();

    for (const ref of spec.evidenceRefs) {
      const evidenceId = evidenceIds.get(ref);
      if (evidenceId === undefined) continue;
      db.insert(eventEvidence)
        .values({ eventId: row.id, evidenceId, note: `${spec.label} ← ${ref}` })
        .onConflictDoNothing()
        .run();
    }
  });

  // --- stage ⑤ clarification ----------------------------------------------
  advanceStage(db, caseId, "clarification");

  const roundOne = recordClarificationRound(db, {
    caseId,
    questions: ROUND_ONE.map((q) => ({ question: q.question, whyNeeded: q.whyNeeded })),
  });
  roundOne.round.questions.forEach((question, i) => {
    answerClarificationQuestion(db, {
      caseId,
      roundId: roundOne.round.id,
      questionId: question.id,
      answer: ROUND_ONE[i].answer,
    });
  });

  const roundTwo = recordClarificationRound(db, {
    caseId,
    questions: [{ question: ROUND_TWO.question, whyNeeded: ROUND_TWO.whyNeeded }],
  });
  // Deliberately unanswered — see the constant's comment. Marking the round
  // saturated is what ends the loop with the question still open.
  markClarificationSaturated(db, { caseId, roundId: roundTwo.round.id });

  return {
    caseId,
    clientId: client.id,
    counterpartyId: counterparty.id,
    evidenceIds,
    utteranceIds,
  };
}

/* -------------------------------------------------------------------------- */
/* Act I — the hearing (real model calls, capped)                             */
/* -------------------------------------------------------------------------- */

/**
 * Total spend on this database so far, in USD, straight off `llm_calls`.
 *
 * Every call writes that table (HARD RULE #7), so the budget is measured
 * against what actually left the machine rather than against an estimate.
 */
function spendSoFar(db: Db): number {
  const row = db
    .select({ total: sql<number | null>`sum(${llmCalls.costUsd})` })
    .from(llmCalls)
    .get();
  return row?.total ?? 0;
}

interface HearOptions {
  readonly budgetUsd: number;
}

async function hearActOne(db: Db, caseId: string, options: HearOptions): Promise<void> {
  const { budgetUsd } = options;

  const checkpoint = (label: string): number => {
    const spent = spendSoFar(db);
    log(`  ${label} — spend so far $${spent.toFixed(4)} of $${budgetUsd.toFixed(2)}`);
    return spent;
  };

  const guard = (next: string, estimate: number): void => {
    const spent = spendSoFar(db);
    if (spent + estimate > budgetUsd) {
      die(
        `stopping before ${next}: $${spent.toFixed(4)} spent, and this step could ` +
          `cost about $${estimate.toFixed(2)}, which would break the $${budgetUsd.toFixed(2)} cap.\n` +
          "  Nothing is lost — re-run with a higher --budget to continue.",
      );
    }
  };

  // --- the steelman: her strongest case, written before she can write it ----
  guard("the steelman", 0.4);
  const steelman = await generateSteelman(db, caseId);
  if (steelman.kind !== "ok" && steelman.kind !== "unable") {
    die(`steelman failed: ${steelman.kind} — ${steelman.message}`);
  }
  if (steelman.kind === "unable") {
    // A real answer, and the pipeline records it as a downgrade signal. It
    // would also change the level, so the fixture wants to know loudly.
    log(`  steelman: UNABLE — ${steelman.reason}`);
  }
  recordSteelmanVerdict(db, {
    caseId,
    steelmanId: steelman.steelman.id,
    answer: "accepted",
  });
  checkpoint("steelman written and accepted");

  // --- stage ⑥ participation ----------------------------------------------
  advanceStage(db, caseId, "participation");
  // Act I's truth: he has not told her. Not refused, not unreachable — unaware.
  setCounterpartyParticipation(db, caseId, "unaware");

  // --- stage ⑦ issue framing -----------------------------------------------
  advanceStage(db, caseId, "issue_framing");
  guard("the issue lists", 0.6);
  const issues = await generateIssues(db, caseId);
  if (issues.kind !== "ok") die(`issue generation failed: ${issues.kind}`);
  for (const list of listIssues(db, caseId).lists) {
    for (const item of list.items) {
      confirmIssue(db, { caseId, issueId: item.id });
    }
  }
  checkpoint("issue lists generated and confirmed");

  // --- stage ⑧ pre-judgment ------------------------------------------------
  advanceStage(db, caseId, "pre_judgment");
  guard("the adverse facts", 0.5);
  const adverse = await generateAdverseFacts(db, caseId);
  if (adverse.kind !== "ok") die(`adverse-fact generation failed: ${adverse.kind}`);
  for (const item of listAdverseFacts(db, caseId).items) {
    acknowledgeAdverseFact(db, { caseId, adverseFactId: item.id });
  }
  checkpoint("adverse facts surfaced and acknowledged");

  // --- HARD RULE #2: the level is derived in code, then locked -------------
  const inputs = collectOutputLevelInputs(db, caseId);
  const locked = lockOutputLevel(db, caseId);
  log("");
  log("  Output level, derived from the record:");
  log(`    level        ${locked.decision.level}  (${locked.decision.reason})`);
  log(
    `    grades       A:${inputs.evidence.counts.A} B:${inputs.evidence.counts.B} ` +
      `C:${inputs.evidence.counts.C} D:${inputs.evidence.counts.D}`,
  );
  log(
    `    citable      total ${inputs.evidence.citableUtterances.total}  ` +
      `by client ${inputs.evidence.citableUtterances.byClient}  ` +
      `by counterparty ${inputs.evidence.citableUtterances.byCounterparty}`,
  );
  for (const finding of locked.decision.findings) log(`    finding      ${finding.code}`);
  log("");

  if (locked.decision.level !== "L2") {
    die(`expected Act I to derive L2, got ${locked.decision.level}. The record is wrong.`);
  }
  if (inputs.evidence.citableUtterances.byClient !== 0) {
    die(
      `expected the client to have 0 citable lines, got ` +
        `${inputs.evidence.citableUtterances.byClient}. The record is wrong.`,
    );
  }

  // --- stage ⑨ judgment ----------------------------------------------------
  advanceStage(db, caseId, "judgment");
  guard("the judgment", 1.8);
  const outcome = await generateJudgment(db, caseId);
  if (outcome.kind !== "published") {
    die(`judgment did not publish: ${outcome.kind} — ${JSON.stringify(outcome)}`);
  }
  log(
    `  judgment v${outcome.judgment.version} published (${outcome.judgment.status}), ` +
      `attempts skeleton=${outcome.attempts.skeleton} narrative=${outcome.attempts.narrative}`,
  );
  checkpoint("judgment published");
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

function reportSeed(db: Db, seed: SeedResult): void {
  const confirmed = UTTERANCES.filter((u) => u.confirmed);
  const byCounterparty = confirmed.filter((u) => u.speaker === "counterparty").length;
  const byClient = confirmed.filter((u) => u.speaker === "client").length;
  const retold = UTTERANCES.filter((u) => u.isRetold).length;

  log("");
  log("Act I seeded.");
  log(`  case            ${seed.caseId}  (is_fixture = true)`);
  log(`  participants    ${CLIENT_NAME} → ${CLIENT_PSEUDONYM} (client, submitter),`);
  log(`                  ${COUNTERPARTY_NAME} → ${COUNTERPARTY_PSEUDONYM} (counterparty, unaware)`);
  log(`  evidence        ${EVIDENCE.length}  (one per grade path; EV-7 demoted by derived_from)`);
  log(`  utterances      ${UTTERANCES.length}  (confirmed ${confirmed.length}, retold ${retold})`);
  log(`  citable record  by client ${byClient}   by counterparty ${byCounterparty}`);
  log(`  events          ${EVENTS.length}  (gap 2026-05-04 → 2026-05-26, 23 days)`);
  log(`  clarification   2 rounds, 3 questions, 1 left unanswered`);
  void db;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_BUDGET_USD = 3.5;

function parseArgs(argv: readonly string[]): { hear: boolean; budgetUsd: number } {
  let hear = false;
  let budgetUsd = DEFAULT_BUDGET_USD;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hear") hear = true;
    else if (arg === "--budget") {
      const value = Number.parseFloat(argv[++i] ?? "");
      if (!Number.isFinite(value) || value <= 0) die("--budget needs a positive number of dollars");
      budgetUsd = value;
    } else if (arg.startsWith("--budget=")) {
      const value = Number.parseFloat(arg.slice("--budget=".length));
      if (!Number.isFinite(value) || value <= 0) die("--budget needs a positive number of dollars");
      budgetUsd = value;
    } else die(`unknown argument "${arg}". Usage: seed-fixture.ts [--hear] [--budget 3.5]`);
  }
  return { hear, budgetUsd };
}

async function main(): Promise<void> {
  const { hear, budgetUsd } = parseArgs(process.argv.slice(2));
  const target = resolveSandboxTarget();

  loadEnvLocal();
  // Explicit path, so nothing read out of the environment after this point can
  // redirect the connection somewhere else.
  const { db, sqlite } = createDb(target);
  try {
    runMigrations(db);
    assertNoRealCases(db);

    log(`seed-fixture: ${target}`);
    const seed = await seedActOne(db);
    reportSeed(db, seed);

    if (!hear) {
      log("");
      log("  Act I is seeded but not heard. To run the real hearing (costs money):");
      log("    FAIRJUDGE_DB_PATH=data/fairjudge-demo.db tsx scripts/seed-fixture.ts --hear");
      return;
    }

    log("");
    log(`Hearing Act I. Budget $${budgetUsd.toFixed(2)}.`);
    await hearActOne(db, seed.caseId, { budgetUsd });
    log("");
    log(`Done. Total spend on this database: $${spendSoFar(db).toFixed(4)}`);
  } finally {
    sqlite.close();
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
