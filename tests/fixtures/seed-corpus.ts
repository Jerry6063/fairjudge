/**
 * A self-contained fictional corpus, for tests that need a populated case.
 *
 * Everything below is invented: two people who do not exist, fourteen materials
 * that were never captured, eleven events that never happened. Nothing is read
 * from disk, nothing outside this file is touched, and no real person is named
 * (CLAUDE.md: the codebase knows no case). The corpus IS this file.
 *
 * The shape is fixed on purpose, because the tests assert against it:
 *   - 1 case, 2 participants (甲 respondent / 乙 initiator + submitter)
 *   - 14 files + 14 evidence rows, graded C:12 / D:2 by the deterministic
 *     source_type rule (ai_processed => C, public_sentiment => D)
 *   - 11 events labelled E1..E11 carrying order keys "a0".."aA"; E5 and E9 are
 *     dated ranges and the other nine are `unknown`
 *   - 7 utterances: 5 retold (乙, pending) and 2 first-hand (甲, confirmed)
 *
 * Idempotent: every table is upserted by a natural key (case title, (case,
 * role), (case, sha256), (case, file), (case, label), the composite PK, or a
 * content signature for utterances), so calling it twice leaves row counts
 * unchanged.
 *
 * Ownership is deliberately left unset: these rows belong to the case rather
 * than to a participant, which is what `resolveMaterialGrant`'s `case_record`
 * audience reads as unowned material (`includeUnowned`). The fixture is about
 * timeline and storage behaviour, not about the M5 visibility split.
 */

import { createHash } from "node:crypto";

import { and, count, eq } from "drizzle-orm";

import type { Db } from "../../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  eventEvidence,
  events,
  files,
  utterances,
  type EvidenceGrade,
  type EvidenceSourceType,
  type OccurredPrecision,
} from "../../src/server/db/schema";

/* -------------------------------------------------------------------------- */
/* Identity of the corpus                                                     */
/* -------------------------------------------------------------------------- */

/** Natural key of the case row: re-seeding finds this one instead of adding another. */
export const CORPUS_CASE_TITLE = "Demo corpus — E1–E11 timeline fixture";

/** Invented display names. Neither person exists. */
const RESPONDENT_NAME = "知夏";
const INITIATOR_NAME = "Adrian";

/** Egress pseudonyms, matching the product's convention. */
const RESPONDENT_PSEUDONYM = "甲";
const INITIATOR_PSEUDONYM = "乙";

/**
 * The mandatory one-sidedness note. Fictional like the rest of the corpus, but
 * written the way a real one would be: it says who submitted the material, who
 * narrated it, and what is missing.
 */
const ONESIDEDNESS_DISCLAIMER =
  "Fictional corpus — both people in it are invented. The material was submitted by 乙 " +
  "(the initiator) and narrated by 甲, who typed the assistant session the screenshots " +
  "come from. Every item is therefore one side's account, mostly second-hand and " +
  "assistant-processed; 乙's own words survive only as 甲's recollection of them, and the " +
  "two parties' original messages are not in the record at all.";

/** MIME type of the (non-existent) screenshot images. */
const SCREENSHOT_MIME = "image/jpeg";

/**
 * The deterministic grade rule, applied to `source_type` in code — never
 * inferred, never asked of a model.
 */
const GRADE_BY_SOURCE: Record<"ai_processed" | "public_sentiment", EvidenceGrade> = {
  ai_processed: "C",
  public_sentiment: "D",
};

const GRADE_RATIONALE: Record<"ai_processed" | "public_sentiment", string> = {
  ai_processed:
    "Assistant-session screenshot: AI-processed second-hand material that inherits one " +
    "party's (甲) narrative frame. source_type=ai_processed => grade C.",
  public_sentiment:
    "Public forum content (post/comments); emotive mass-media, not evidence about a " +
    "party. source_type=public_sentiment => grade D.",
};

/* -------------------------------------------------------------------------- */
/* Deterministic ordering keys (fractional-index style, no integer reindex)    */
/* -------------------------------------------------------------------------- */

// ASCII-ordered alphabet: '0'-'9' < 'A'-'Z' < 'a'-'z'. A single-char suffix
// keeps lexical order equal to insertion order for < 62 items, which is what
// makes E1..E11 read back as "a0".."aA" (see tests/order-key.test.ts).
const ORDER_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function orderKeyAt(i: number): string {
  return `a${ORDER_ALPHABET[i] ?? "z"}`;
}

/* -------------------------------------------------------------------------- */
/* The record — fourteen invented materials                                   */
/* -------------------------------------------------------------------------- */

interface MaterialSpec {
  /** Local reference used by the event and utterance tables below. */
  readonly ref: string;
  readonly filename: string;
  readonly sourceType: Extract<
    EvidenceSourceType,
    "ai_processed" | "public_sentiment"
  >;
  readonly summary: string;
}

const MATERIALS: readonly MaterialSpec[] = [
  {
    ref: "M01",
    filename: "corpus-forum-post-01.jpeg",
    sourceType: "public_sentiment",
    summary: "A viral forum post about splitting moving costs, saved by 甲.",
  },
  {
    ref: "M02",
    filename: "corpus-forum-comments-02.jpeg",
    sourceType: "public_sentiment",
    summary: "The comment thread under the same post, several hundred replies.",
  },
  {
    ref: "M03",
    filename: "corpus-session-03.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: 甲 lists the four things she says went unanswered.",
  },
  {
    ref: "M04",
    filename: "corpus-session-04.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the lease-renewal thread, drafted and redrafted.",
  },
  {
    ref: "M05",
    filename: "corpus-session-05.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: a rewrite of the same message, softer wording.",
  },
  {
    ref: "M06",
    filename: "corpus-session-06.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: 甲 asks how to raise the missing kitchen box.",
  },
  {
    ref: "M07",
    filename: "corpus-session-07.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the reply she says she got, retyped from memory.",
  },
  {
    ref: "M08",
    filename: "corpus-session-08.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the navigation route argument on moving day.",
  },
  {
    ref: "M09",
    filename: "corpus-session-09.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the dog walker's schedule and who booked it.",
  },
  {
    ref: "M10",
    filename: "corpus-session-10.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the vet bill, and who paid which half.",
  },
  {
    ref: "M11",
    filename: "corpus-session-11.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: three months of weekend viewings, summarised.",
  },
  {
    ref: "M12",
    filename: "corpus-session-12.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: which viewings each of them cancelled.",
  },
  {
    ref: "M13",
    filename: "corpus-session-13.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the two flats they disagreed about most.",
  },
  {
    ref: "M14",
    filename: "corpus-session-14.jpeg",
    sourceType: "ai_processed",
    summary: "Assistant session: the housewarming list and the standing chores.",
  },
];

/* -------------------------------------------------------------------------- */
/* The record — eleven invented events                                        */
/* -------------------------------------------------------------------------- */

interface EventSpec {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly materials: readonly string[];
  /** Months are 0-indexed in `Date.UTC`. Absent = occurred_precision "unknown". */
  readonly range?: { readonly start: Date; readonly end: Date };
}

const EVENTS: readonly EventSpec[] = [
  {
    label: "E1",
    title: "The lease renewal notice",
    description:
      "甲 says the renewal notice sat on the counter for eleven days and neither of them raised it until the deadline week.",
    materials: ["M03"],
  },
  {
    label: "E2",
    title: "Who called the landlord",
    description:
      "A call was made about the renewal without telling the other. They disagree about whether it had been agreed first.",
    materials: ["M03", "M04"],
  },
  {
    label: "E3",
    title: "The moving quote",
    description:
      "The van was booked at a price one of them considered settled and the other considered a draft.",
    materials: ["M01", "M04", "M05"],
  },
  {
    label: "E4",
    title: "Talking past each other about the deadline",
    description:
      "A long exchange in which, by 甲's account, each answered a different question from the one asked.",
    materials: ["M05"],
  },
  {
    label: "E5",
    title: "The missing box of kitchen things",
    description:
      "A box was not on the van at the other end. Neither remembers loading it, and each recalls asking the other about it.",
    materials: ["M06", "M07"],
    range: {
      start: new Date(Date.UTC(2026, 6, 13)),
      end: new Date(Date.UTC(2026, 6, 17)),
    },
  },
  {
    label: "E6",
    title: "The route the app chose",
    description:
      "On moving day the navigation app routed the van the long way; the argument was about who had insisted on following it.",
    materials: ["M08"],
  },
  {
    label: "E7",
    title: "The dog walker's schedule",
    description:
      "The walker was booked for mornings, which collided with one of the two commutes. Each says the other set the times.",
    materials: ["M09"],
  },
  {
    label: "E8",
    title: "The vet bill",
    description:
      "The bill was paid by one of them and split later, and the split is the part they still disagree about.",
    materials: ["M02", "M09", "M10"],
  },
  {
    label: "E9",
    title: "Three months of weekend viewings",
    description:
      "A long stretch of flat viewings that both describe as the point at which the disagreement stopped being occasional.",
    materials: ["M11", "M12", "M13"],
    range: {
      start: new Date(Date.UTC(2026, 3, 1)),
      end: new Date(Date.UTC(2026, 5, 30)),
    },
  },
  {
    label: "E10",
    title: "The housewarming guest list",
    description:
      "The list was drawn up by one of them; the other found out who was coming on the day.",
    materials: ["M14"],
  },
  {
    label: "E11",
    title: "Chores, counted",
    description:
      "甲 kept a count of the standing chores for a fortnight and read it out. Nothing in the record shows what was said back.",
    materials: ["M14"],
  },
];

/* -------------------------------------------------------------------------- */
/* The record — seven invented utterances                                     */
/* -------------------------------------------------------------------------- */

interface UtteranceSpec {
  readonly materialRef: string;
  readonly speaker: "initiator" | "respondent";
  /** True = 甲's recollection of what 乙 said; nothing recorded those words. */
  readonly isRetold: boolean;
  readonly confirmStatus: "pending" | "confirmed";
  readonly text: string;
}

/**
 * Five retold lines and two first-hand ones.
 *
 * The retold five are 乙's words as 甲 recalls them, so they stay `pending` —
 * an unconfirmed line is not citable (HARD RULE #1). The two first-hand lines
 * are 甲's own typed bubbles inside the session, directly visible in the
 * screenshot, so they are confirmed and their text is also the human_final.
 */
const UTTERANCES: readonly UtteranceSpec[] = [
  {
    materialRef: "M03",
    speaker: "initiator",
    isRetold: true,
    confirmStatus: "pending",
    text: "I already called them on Monday. I thought you knew.",
  },
  {
    materialRef: "M05",
    speaker: "initiator",
    isRetold: true,
    confirmStatus: "pending",
    text: "The quote is the quote. There is nothing left to decide there.",
  },
  {
    materialRef: "M06",
    speaker: "initiator",
    isRetold: true,
    confirmStatus: "pending",
    text: "We can sort the boxes out when we get there.",
  },
  {
    materialRef: "M09",
    speaker: "initiator",
    isRetold: true,
    confirmStatus: "pending",
    text: "I said I would handle the walker, and I handled it.",
  },
  {
    materialRef: "M11",
    speaker: "initiator",
    isRetold: true,
    confirmStatus: "pending",
    text: "You never told me you wanted to see that one again.",
  },
  {
    materialRef: "M03",
    speaker: "respondent",
    isRetold: false,
    confirmStatus: "confirmed",
    text:
      "I am writing this down because I keep losing track of who said what. None of it is meant as an accusation yet.",
  },
  {
    materialRef: "M10",
    speaker: "respondent",
    isRetold: false,
    confirmStatus: "confirmed",
    text:
      "The part I cannot get past is not the money. It is that the call happened and I found out afterwards.",
  },
];

/* -------------------------------------------------------------------------- */
/* Synthetic file identity                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A distinct, stable sha256 per material — hashed over an invented string, so
 * no real bytes are read and re-seeding produces the same digest.
 */
function syntheticSha256(spec: MaterialSpec): string {
  return createHash("sha256")
    .update(`fairjudge/tests/fixtures/seed-corpus/${spec.ref}/${spec.filename}`)
    .digest("hex");
}

/** A plausible, deterministic size for an image nobody ever captured. */
function syntheticByteSize(index: number): number {
  return 180_224 + index * 4_096;
}

/* -------------------------------------------------------------------------- */
/* Idempotent upsert helpers                                                  */
/* -------------------------------------------------------------------------- */

function getOrCreateCase(db: Db): string {
  const existing = db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.title, CORPUS_CASE_TITLE))
    .all();
  if (existing[0]) return existing[0].id;

  const [row] = db
    .insert(cases)
    .values({
      title: CORPUS_CASE_TITLE,
      // Materials registered and graded = pipeline stage ② evidence_intake.
      stage: "evidence_intake",
      // Every person in this case is invented; the UI has to be able to say so.
      isFixture: true,
      onesidednessDisclaimer: ONESIDEDNESS_DISCLAIMER,
    })
    .returning({ id: cases.id })
    .all();
  return row.id;
}

function getOrCreateParticipant(
  db: Db,
  caseId: string,
  values: {
    role: "initiator" | "respondent";
    pseudonym: string;
    displayName: string;
    isSubmitter: boolean;
    participationState: "pending" | "participating";
  },
): string {
  const existing = db
    .select({ id: caseParticipants.id })
    .from(caseParticipants)
    .where(
      and(eq(caseParticipants.caseId, caseId), eq(caseParticipants.role, values.role)),
    )
    .all();
  if (existing[0]) return existing[0].id;

  const [row] = db
    .insert(caseParticipants)
    .values({ caseId, ...values })
    .returning({ id: caseParticipants.id })
    .all();
  return row.id;
}

function getOrCreateFile(
  db: Db,
  caseId: string,
  spec: MaterialSpec,
  index: number,
): string {
  const sha256 = syntheticSha256(spec);
  const existing = db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.caseId, caseId), eq(files.sha256, sha256)))
    .all();
  if (existing[0]) return existing[0].id;

  const [row] = db
    .insert(files)
    .values({
      caseId,
      kind: "screenshot",
      originalFilename: spec.filename,
      // There is no image anywhere; the path names where one would have lived.
      storagePath: `fixture://seed-corpus/${spec.filename}`,
      sha256,
      byteSize: syntheticByteSize(index),
      mimeType: SCREENSHOT_MIME,
    })
    .returning({ id: files.id })
    .all();
  return row.id;
}

function getOrCreateEvidence(
  db: Db,
  caseId: string,
  fileId: string,
  spec: MaterialSpec,
): string {
  const existing = db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.caseId, caseId), eq(evidence.fileId, fileId)))
    .all();
  if (existing[0]) return existing[0].id;

  const [row] = db
    .insert(evidence)
    .values({
      caseId,
      fileId,
      sourceType: spec.sourceType,
      gradeFinal: GRADE_BY_SOURCE[spec.sourceType],
      gradeRationale: GRADE_RATIONALE[spec.sourceType],
      contentSummary: spec.summary,
    })
    .returning({ id: evidence.id })
    .all();
  return row.id;
}

function getOrCreateEvent(
  db: Db,
  caseId: string,
  values: {
    label: string;
    title: string;
    description: string;
    occurredPrecision: OccurredPrecision;
    occurredStart: Date | null;
    occurredEnd: Date | null;
    orderKey: string;
  },
): string {
  const existing = db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.caseId, caseId), eq(events.label, values.label)))
    .all();
  if (existing[0]) return existing[0].id;

  const [row] = db
    .insert(events)
    .values({ caseId, ...values })
    .returning({ id: events.id })
    .all();
  return row.id;
}

function linkEventEvidence(
  db: Db,
  eventId: string,
  evidenceId: string,
  note: string,
): void {
  // Composite PK (event_id, evidence_id) makes this naturally idempotent.
  db.insert(eventEvidence).values({ eventId, evidenceId, note }).onConflictDoNothing().run();
}

function getOrCreateUtterance(
  db: Db,
  caseId: string,
  values: {
    evidenceId: string;
    speakerParticipantId: string;
    speakerLabel: string;
    isRetold: boolean;
    text: string;
    confirmStatus: "pending" | "confirmed";
    orderKey: string;
  },
): void {
  // No dedicated text column — content lives in the confirm triple. Natural key
  // = (speakerLabel, isRetold, ai_draft text) within the case.
  const existing = db
    .select({
      label: utterances.speakerLabel,
      retold: utterances.isRetold,
      draft: utterances.aiDraft,
    })
    .from(utterances)
    .where(eq(utterances.caseId, caseId))
    .all();
  const duplicate = existing.some(
    (u) =>
      u.label === values.speakerLabel &&
      u.retold === values.isRetold &&
      u.draft === values.text,
  );
  if (duplicate) return;

  db.insert(utterances)
    .values({
      caseId,
      evidenceId: values.evidenceId,
      speakerParticipantId: values.speakerParticipantId,
      speakerLabel: values.speakerLabel,
      isRetold: values.isRetold,
      aiDraft: values.text,
      // Confirmed = the text was directly visible and a human accepted it.
      humanFinal: values.confirmStatus === "confirmed" ? values.text : null,
      confirmStatus: values.confirmStatus,
      orderKey: values.orderKey,
    })
    .run();
}

/* -------------------------------------------------------------------------- */
/* Seed                                                                       */
/* -------------------------------------------------------------------------- */

export interface CorpusStats {
  readonly caseId: string;
  readonly cases: number;
  readonly participants: number;
  readonly files: number;
  readonly evidence: number;
  readonly events: number;
  readonly eventEvidence: number;
  readonly utterances: number;
  readonly evidenceByGrade: Readonly<Record<EvidenceGrade, number>>;
}

/**
 * Write the whole fictional corpus into `db` (migrations must already be
 * applied). Safe to call repeatedly — row counts do not change on re-run.
 */
export function seedCorpus(db: Db): CorpusStats {
  const caseId = getOrCreateCase(db);

  const respondentId = getOrCreateParticipant(db, caseId, {
    role: "respondent",
    pseudonym: RESPONDENT_PSEUDONYM,
    displayName: RESPONDENT_NAME,
    isSubmitter: false,
    participationState: "pending",
  });
  const initiatorId = getOrCreateParticipant(db, caseId, {
    role: "initiator",
    pseudonym: INITIATOR_PSEUDONYM,
    displayName: INITIATOR_NAME,
    isSubmitter: true,
    participationState: "participating",
  });

  // Files + evidence, one pair per material.
  const evidenceByRef = new Map<string, string>();
  MATERIALS.forEach((spec, index) => {
    const fileId = getOrCreateFile(db, caseId, spec, index);
    evidenceByRef.set(spec.ref, getOrCreateEvidence(db, caseId, fileId, spec));
  });

  // Events, in label order, plus their evidence links.
  EVENTS.forEach((spec, index) => {
    const eventId = getOrCreateEvent(db, caseId, {
      label: spec.label,
      title: spec.title,
      description: spec.description,
      occurredPrecision: spec.range ? "range" : "unknown",
      occurredStart: spec.range?.start ?? null,
      occurredEnd: spec.range?.end ?? null,
      orderKey: orderKeyAt(index),
    });

    for (const ref of spec.materials) {
      const evidenceId = evidenceByRef.get(ref);
      if (evidenceId === undefined) continue;
      linkEventEvidence(db, eventId, evidenceId, `${spec.label} (${spec.title}) <- ${ref}`);
    }
  });

  // Utterances, in reading order.
  UTTERANCES.forEach((spec, index) => {
    const evidenceId = evidenceByRef.get(spec.materialRef);
    if (evidenceId === undefined) return;
    getOrCreateUtterance(db, caseId, {
      evidenceId,
      speakerParticipantId:
        spec.speaker === "initiator" ? initiatorId : respondentId,
      speakerLabel:
        spec.speaker === "initiator" ? INITIATOR_PSEUDONYM : RESPONDENT_PSEUDONYM,
      isRetold: spec.isRetold,
      text: spec.text,
      confirmStatus: spec.confirmStatus,
      orderKey: orderKeyAt(index),
    });
  });

  return collectStats(db, caseId);
}

function collectStats(db: Db, caseId: string): CorpusStats {
  const one = (rows: readonly { n: number }[]): number => rows[0]?.n ?? 0;

  // `grade_final` is nullable (NULL until a human signs the grade off), so a row
  // awaiting review is simply not counted under any letter.
  const evidenceByGrade: Record<EvidenceGrade, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const row of db
    .select({ grade: evidence.gradeFinal, n: count() })
    .from(evidence)
    .groupBy(evidence.gradeFinal)
    .all()) {
    if (row.grade !== null) evidenceByGrade[row.grade] = row.n;
  }

  return {
    caseId,
    cases: one(db.select({ n: count() }).from(cases).all()),
    participants: one(db.select({ n: count() }).from(caseParticipants).all()),
    files: one(db.select({ n: count() }).from(files).all()),
    evidence: one(db.select({ n: count() }).from(evidence).all()),
    events: one(db.select({ n: count() }).from(events).all()),
    eventEvidence: one(db.select({ n: count() }).from(eventEvidence).all()),
    utterances: one(db.select({ n: count() }).from(utterances).all()),
    evidenceByGrade,
  };
}
