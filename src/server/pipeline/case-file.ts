/**
 * The case file — the one document every wave-A stage reads.
 *
 * Two properties are the whole point of this module, and both of them are
 * properties of *code*, not of a prompt:
 *
 *   1. **Only confirmed material is in it (HARD RULE #1).** Utterances are
 *      filtered on `confirm_status IN ('confirmed','edited')` in SQL, using the
 *      same `CITABLE_STATUSES` constant the evidence workbench gates on. Events
 *      are filtered the same way, and material appears only once a human has
 *      signed off its grade (`grade_final` set). A stage physically cannot cite
 *      a pending line, because the line is not in the bytes it was given.
 *   2. **It serializes byte-stably.** Every list is sorted by stored values
 *      (never by a clock), object keys are emitted in sorted order, and no
 *      `created_at` / `updated_at` / "generated at" value appears anywhere. Two
 *      assemblies of an unchanged record produce identical bytes, which is what
 *      the prompt-cache prefix discipline in CLAUDE.md asks for.
 *
 * Sections are emitted in a fixed order with the volatile one (the clarification
 * history, which grows a round at a time) last, so everything before it stays a
 * stable cache prefix across the rounds of one case.
 *
 * Citations use short per-assembly handles — `U1`, `E1`, `V1` — rather than
 * UUIDs. Three reasons: a handle is a fraction of the tokens; a UUID is a
 * meaningless string a model is likely to copy wrong; and the handle table only
 * ever contains citable rows, so "resolve this ref" and "prove this ref is
 * citable" become the same lookup. Handles are per-assembly and are resolved
 * immediately after the call that produced them — they are never persisted.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { resolveSpeaker } from "../../lib/utterance-speaker";
import {
  CASE_RECORD,
  resolveMaterialGrant,
  visibleMaterial,
  type MaterialAudience,
} from "../access/visibility";
import {
  caseParticipants,
  cases,
  clarificationRounds,
  evidence as evidenceTable,
  events as eventsTable,
  utterances as utterancesTable,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type EvidenceGrade,
  type EvidenceSourceType,
  type OccurredPrecision,
  type ParticipationState,
  type UtteranceTone,
} from "../db/schema";
import { CITABLE_STATUSES } from "../evidence/workbench";
import type { Reader } from "./stage-machine";

/* -------------------------------------------------------------------------- */
/* Stable JSON                                                                */
/* -------------------------------------------------------------------------- */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * `JSON.stringify` with every object's keys emitted in sorted order.
 *
 * Insertion order would already be deterministic today; sorting makes it
 * deterministic *for reasons that survive a refactor*, since it no longer
 * depends on the order literals happen to be written in.
 */
export function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as { readonly [key: string]: JsonValue };
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value as JsonValue;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** Format marker, bumped when the document's shape changes. */
export const CASE_FILE_FORMAT = "fairjudge.case_file.v1";

/** A confirmed utterance, as a stage sees it. `text` is verbatim evidence. */
export interface CaseFileUtterance {
  /** Per-assembly citation handle (`U1`, `U2`, …). */
  readonly ref: string;
  /** Database id. Server-side only — never serialized into the prompt. */
  readonly id: string;
  /** Pseudonym of the speaker, or null when nobody has attributed the line. */
  readonly speaker: string | null;
  /** HARD RULE #5: a retold line renders as "as you recall it, they said…". */
  readonly isRetold: boolean;
  readonly tone: UtteranceTone | null;
  /** The line itself, in the language it was said in. Never translated. */
  readonly text: string;
}

export interface CaseFileEvent {
  readonly ref: string;
  readonly id: string;
  readonly label: string | null;
  readonly title: string | null;
  readonly description: string | null;
  /** Occurrence, formatted per its stored precision; null when undated. */
  readonly when: string | null;
  readonly onTimeline: boolean;
}

export interface CaseFileMaterial {
  readonly ref: string;
  readonly id: string;
  readonly grade: EvidenceGrade;
  readonly sourceType: EvidenceSourceType;
  readonly summary: string | null;
}

export interface CaseFileParty {
  readonly pseudonym: string;
  readonly role: string;
  readonly isSubmitter: boolean;
  readonly participationState: ParticipationState;
}

/**
 * What became of one clarification question, as a stage reads it.
 *
 * `declined` is kept separate from `unanswered` on purpose. Both leave `answer`
 * null — nothing downstream may quote a sentence the client did not write — but
 * they are different facts about the record: one says the client was asked and
 * refused, the other says the question is still open. A judgment that has to
 * disclose what it does not know needs to be able to tell them apart.
 */
export type CaseFileAnswerStatus = "answered" | "declined" | "unanswered";

export interface CaseFileRound {
  readonly roundNumber: number;
  readonly questions: readonly {
    readonly question: string;
    /** Verbatim, and null unless the client actually answered. */
    readonly answer: string | null;
    readonly status: CaseFileAnswerStatus;
  }[];
}

/** One titled section of the serialized document. */
export interface CaseFileSection {
  readonly title: string;
  readonly body: JsonValue;
}

export interface CaseFile {
  readonly caseId: string;
  readonly title: string | null;
  readonly parties: readonly CaseFileParty[];
  readonly material: readonly CaseFileMaterial[];
  readonly timeline: readonly CaseFileEvent[];
  /** Confirmed utterances only. Nothing else can get in here. */
  readonly utterances: readonly CaseFileUtterance[];
  readonly clarification: readonly CaseFileRound[];
  /** Sections in emission order; the volatile one is last. */
  readonly sections: readonly CaseFileSection[];
  /** `U1` → utterance id. Contains citable rows and nothing else. */
  readonly utteranceRefs: ReadonlyMap<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read one case's confirmed record, as one audience may read it.
 *
 * Takes a `Reader` so it runs inside a transaction as happily as on the pooled
 * handle, and so tests drive exactly the code the server does. The audience
 * defaults to `CASE_RECORD` — the case as the document a stage reasons over —
 * so every pre-M5 caller reads exactly what it read before.
 */
export function assembleCaseFile(
  db: Reader,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): CaseFile {
  const grant = resolveMaterialGrant(db, caseId, audience);
  const caseRow = db.select().from(cases).where(eq(cases.id, caseId)).get();
  if (caseRow === undefined) {
    throw new Error(`No case with id ${caseId}.`);
  }

  const parties = db
    .select({
      id: caseParticipants.id,
      role: caseParticipants.role,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
      participationState: caseParticipants.participationState,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .sort((a, b) => compare(a.pseudonym, b.pseudonym) || compare(a.id, b.id));

  // Material a human has graded. `grade_final` is the human column (the rule's
  // suggestion lives in `grade_suggested`), so this is the same "a person signed
  // this off" gate the utterance filter applies.
  const material: CaseFileMaterial[] = db
    .select({
      id: evidenceTable.id,
      gradeFinal: evidenceTable.gradeFinal,
      sourceType: evidenceTable.sourceType,
      contentSummary: evidenceTable.contentSummary,
    })
    .from(evidenceTable)
    .where(
      and(
        eq(evidenceTable.caseId, caseId),
        visibleMaterial(evidenceTable, grant),
      ),
    )
    .all()
    .flatMap((row) =>
      row.gradeFinal === null
        ? []
        : [
            {
              id: row.id,
              grade: row.gradeFinal,
              sourceType: row.sourceType,
              summary: row.contentSummary,
            },
          ],
    )
    .sort((a, b) => compare(a.id, b.id))
    .map((row, index) => ({ ...row, ref: `V${index + 1}` }));

  const timeline: CaseFileEvent[] = db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.caseId, caseId),
        inArray(eventsTable.confirmStatus, [...CITABLE_STATUSES]),
        visibleMaterial(eventsTable, grant),
      ),
    )
    .all()
    .sort((a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id))
    .map((row, index) => ({
      ref: `E${index + 1}`,
      id: row.id,
      label: row.label,
      title: row.title,
      description: row.description,
      when: formatOccurrence(row),
      onTimeline: row.inTimeline || row.occurredPrecision !== "unknown",
    }));

  // HARD RULE #1, in SQL. The filter is the same constant the write side
  // enforces, so "citable" has exactly one definition in the codebase — and the
  // visibility predicate rides in the same WHERE clause (SPEC M5 ①), so does
  // "readable".
  const utteranceRows = db
    .select()
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        inArray(utterancesTable.confirmStatus, [...CITABLE_STATUSES]),
        visibleMaterial(utterancesTable, grant),
      ),
    )
    .all();

  const speakerCandidates = parties.map((p) => ({
    id: p.id,
    pseudonym: p.pseudonym,
  }));

  const utterances: CaseFileUtterance[] = utteranceRows
    .slice()
    // Grouped by the material it came from, then in reading order inside it.
    // Every component is a stored value, so the order never depends on a clock.
    .sort(
      (a, b) =>
        compare(a.evidenceId ?? "", b.evidenceId ?? "") ||
        compare(a.orderKey ?? "", b.orderKey ?? "") ||
        compare(a.id, b.id),
    )
    .map((row, index) => {
      const speaker = resolveSpeaker(row, speakerCandidates);
      return {
        ref: `U${index + 1}`,
        id: row.id,
        speaker: speaker.kind === "participant" ? speaker.pseudonym : null,
        isRetold: row.isRetold,
        tone: row.tone,
        // `edited` means the human wrote this text themselves; it wins.
        text: row.humanFinal ?? row.aiDraft ?? "",
      };
    })
    // A timestamp row or an unrecognized line carries no speech worth asking
    // about, but an empty string would still burn a handle — drop empties and
    // renumber so the handles stay dense.
    .filter((row) => row.text.trim() !== "")
    .map((row, index) => ({ ...row, ref: `U${index + 1}` }));

  const clarification: CaseFileRound[] = db
    .select()
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .orderBy(asc(clarificationRounds.roundNumber))
    .all()
    .map((row) => {
      const answers: readonly ClarificationAnswer[] = row.answers ?? [];
      const questions: readonly ClarificationQuestion[] = row.questions ?? [];
      return {
        roundNumber: row.roundNumber,
        questions: questions.map((question) => {
          const entry = answers.find((a) => a.questionId === question.id);
          // An entry written before the state field existed is an answer; only
          // an explicit `declined` withholds the reply.
          const status: CaseFileAnswerStatus =
            entry === undefined
              ? "unanswered"
              : entry.state === "declined"
                ? "declined"
                : "answered";
          return {
            question: question.question,
            answer: status === "answered" ? entry?.answer ?? null : null,
            status,
          };
        }),
      };
    });

  const sections: CaseFileSection[] = [
    {
      title: "Case",
      body: {
        format: CASE_FILE_FORMAT,
        title: caseRow.title,
        stage: caseRow.stage,
        output_level: caseRow.outputLevel,
      },
    },
    {
      title: "Parties",
      body: parties.map((party) => ({
        pseudonym: party.pseudonym,
        role: party.role,
        is_submitter: party.isSubmitter,
        participation_state: party.participationState,
      })),
    },
    {
      title: "Material (graded, human-confirmed)",
      body: material.map((item) => ({
        ref: item.ref,
        grade: item.grade,
        source_type: item.sourceType,
        summary: item.summary,
      })),
    },
    {
      title: "Timeline (confirmed events)",
      body: timeline.map((event) => ({
        ref: event.ref,
        label: event.label,
        title: event.title,
        description: event.description,
        when: event.when,
        on_timeline: event.onTimeline,
      })),
    },
    {
      title: "Confirmed utterances (verbatim; cite these by ref)",
      body: utterances.map((utterance) => ({
        ref: utterance.ref,
        speaker: utterance.speaker,
        is_retold: utterance.isRetold,
        tone: utterance.tone,
        text: utterance.text,
      })),
    },
    // Last on purpose: this is the only section that changes between the rounds
    // of one case, so everything above it stays a stable cache prefix.
    {
      title: "Clarification so far",
      body: clarification.map((round) => ({
        round: round.roundNumber,
        exchanges: round.questions.map((item) => ({
          question: item.question,
          answer: item.answer,
          // Named, not inferred from a null: a question the client refused and a
          // question nobody has reached are both "no answer here", and only one
          // of them is going to stay that way.
          answer_status: item.status,
        })),
      })),
    },
  ];

  return {
    caseId,
    title: caseRow.title,
    parties: parties.map((party) => ({
      pseudonym: party.pseudonym,
      role: party.role,
      isSubmitter: party.isSubmitter,
      participationState: party.participationState,
    })),
    material,
    timeline,
    utterances,
    clarification,
    sections,
    utteranceRefs: new Map(utterances.map((u) => [u.ref, u.id])),
  };
}

/**
 * Render the case file as the text a stage is actually handed.
 *
 * Deterministic in the strong sense: same record in, same bytes out. Nothing
 * here reads the clock, and no id, ordering or key comes from anywhere but the
 * stored row.
 */
export function serializeCaseFile(file: CaseFile): string {
  return file.sections
    .map((section) => `## ${section.title}\n${stableStringify(section.body)}`)
    .join("\n\n");
}

/**
 * Resolve a citation handle a model returned.
 *
 * Returns null for anything that is not a live handle in this assembly — a
 * hallucinated ref, an id copied from somewhere else, or a line whose status is
 * not citable (such a line never got a handle in the first place). Callers
 * reject the whole generation on a null, per HARD RULE #1.
 */
export function resolveUtteranceRef(file: CaseFile, ref: string): string | null {
  return file.utteranceRefs.get(ref.trim()) ?? null;
}

/** The utterance behind a handle, for rendering a citation. */
export function findUtteranceByRef(
  file: CaseFile,
  ref: string,
): CaseFileUtterance | null {
  const wanted = ref.trim();
  return file.utterances.find((u) => u.ref === wanted) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** UTC, so the same row formats identically on every machine. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface OccurrenceColumns {
  readonly occurredAt: Date | null;
  readonly occurredStart: Date | null;
  readonly occurredEnd: Date | null;
  readonly occurredPrecision: OccurredPrecision;
}

/**
 * Format an event's occurrence at the precision it was actually recorded with.
 *
 * An event dated to the month prints as `2026-05`, not as midnight on the 1st:
 * printing more precision than the record has is how a guess becomes a fact.
 */
function formatOccurrence(row: OccurrenceColumns): string | null {
  switch (row.occurredPrecision) {
    case "exact":
      return row.occurredAt === null ? null : row.occurredAt.toISOString();
    case "day":
      return row.occurredAt === null ? null : isoDay(row.occurredAt);
    case "month":
      return row.occurredAt === null ? null : row.occurredAt.toISOString().slice(0, 7);
    case "range": {
      const start = row.occurredStart === null ? "?" : isoDay(row.occurredStart);
      const end = row.occurredEnd === null ? "?" : isoDay(row.occurredEnd);
      return start === "?" && end === "?" ? null : `${start}..${end}`;
    }
    case "unknown":
      return null;
  }
}
