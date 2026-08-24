/**
 * Registering a transcript that arrived as text — the single-party instrument.
 *
 * ## Why this module exists at all
 *
 * The product had exactly two ways to turn free text into evidence plus
 * utterances, and both of them belong to a person: `createCase` writes the
 * client's own first account, and `submitStatement` writes the counterparty's
 * written response. A tool that needed a third — "here is a chat log I pasted
 * out of my phone" — had no honest option, and the first version of the CLI
 * reached for `submitStatement`. That call does four things beyond storing text:
 * it attributes every line to the counterparty, it writes a `granted /
 * case_record` consent event in her name, it flips `participation_state` to
 * `written_response`, and through that column it moves the case towards L1 —
 * the one level that allocates fault between two people. A single operator
 * pasting a two-sided screenshot log therefore recorded the other party as
 * having answered, and the level derivation, working correctly on the facts it
 * was given, licensed a fault-allocating judgment about somebody who has never
 * been asked anything.
 *
 * So this module is the third path, and it is defined by what it does not do:
 *
 *   - **It never touches `participation_state`.** Participation is a fact about
 *     what the other party did. Pasting a log is a fact about what the client
 *     has. Nothing here may turn the second into the first, and the absence is
 *     load-bearing rather than an oversight — see the regression test in
 *     `tests/fairjudge-cli-flow.test.ts`, which drives the whole CLI over a
 *     two-sided transcript and asserts the case derives L2.
 *   - **It writes no consent event.** Consent is an act by the person consenting
 *     and it has one door (`/respond`).
 *   - **It attributes nothing to the counterparty.** A parsed "Nikhil:" prefix
 *     becomes a numbered speaker slot, exactly as OCR turns a bubble's position
 *     into `left` / `right`: a guess for a human to correct in the workbench
 *     (`updateUtteranceAttributes`), never an attribution the machine made
 *     stick. Nothing is citable until a human confirms the line anyway
 *     (HARD RULE #1), and nothing counts towards either party's side of the
 *     level until a human says whose line it is (HARD RULE #2).
 *
 * ## Why the slot label carries no name
 *
 * `speaker_label` is what egresses — `createCase` and `submitStatement` both say
 * so where they write the pseudonym into it. Copying "Nikhil" out of a pasted
 * prefix into that column would put a real name in an outbound field on every
 * later dossier, and it would do it at intake, before the operator has had any
 * chance to register that person (HARD RULE #3). The name is not lost: the line
 * is stored exactly as it was pasted, prefix included, so `utterance:list` shows
 * the operator which slot is which and the record is not edited to make the
 * plumbing tidier. Names *inside* evidence text are the pseudonymization
 * gateway's business, which is where they are handled for every other kind of
 * material.
 *
 * ## Grading
 *
 * By rule, from what the material is, through `deriveEvidenceGrade` — never from
 * who pasted it. A typed-out transcript is a recollection (B): somebody wrote it
 * down afterwards, and it is memory however honest. An app export is an original
 * record of the conversation, which is the same evidentiary class as a chat
 * screenshot (A). Which of the two this is cannot be observed from the bytes, so
 * it is declared by the operator and recorded on the row — and, exactly as with
 * an uploaded screenshot, `grade_final` stays NULL until a human signs it off in
 * the workbench. Intake produces claims to accept, never accepted claims.
 *
 * The text is a verbatim record and stays in whatever language it was written
 * in — never translated, never normalized (CLAUDE.md).
 */

import { and, eq } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";

import type { Db } from "../db";
import {
  caseParticipants,
  evidence as evidenceTable,
  utterances as utterancesTable,
  type EvidenceGrade,
  type EvidenceSourceType,
} from "../db/schema";
import { deriveEvidenceGrade, type GradeReason } from "../domain/grading";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the operator says this text is, mapped onto the schema's evidentiary
 * classes. Two answers, because there are two ways a transcript becomes text and
 * they are not the same kind of record.
 */
export const TRANSCRIPT_SOURCE_TYPES = {
  /** Typed or re-typed by hand from the conversation. */
  typed: "recollection",
  /** Exported or copied out of the app that holds the conversation. */
  export: "firsthand",
} as const satisfies Record<string, EvidenceSourceType>;

export type TranscriptSource = keyof typeof TRANSCRIPT_SOURCE_TYPES;

export const TRANSCRIPT_SOURCES = Object.keys(
  TRANSCRIPT_SOURCE_TYPES,
) as TranscriptSource[];

/** The cautious answer when the operator does not say. */
export const DEFAULT_TRANSCRIPT_SOURCE: TranscriptSource = "typed";

export function isTranscriptSource(value: unknown): value is TranscriptSource {
  return (
    typeof value === "string" &&
    Object.hasOwn(TRANSCRIPT_SOURCE_TYPES, value)
  );
}

/** Upper bound on one transcript, in characters. Mirrors `MAX_ACCOUNT_CHARS`. */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/** How much of the transcript is kept on `evidence.content_summary` for lists. */
const SUMMARY_MAX_CHARS = 160;

/**
 * The prefix a transcript line uses to name its speaker.
 *
 * Deliberately narrow. The speaker part may not contain a colon and is capped,
 * so a line that merely happens to contain a colon ("I said: never again", a
 * timestamp, a URL) is left whole and lands unparsed rather than being split at
 * the wrong place. Both the ASCII and the full-width colon are accepted, because
 * a Chinese log uses the second one.
 */
const SPEAKER_PREFIX = /^([^:：\n]{1,40})[:：]\s*(.*)$/;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type TranscriptErrorCode =
  /** The case has no participant marked as the submitter. */
  | "no_client_participant"
  /** Nothing was pasted, or only whitespace. */
  | "empty_transcript"
  /** Over `MAX_TRANSCRIPT_CHARS`. */
  | "transcript_too_long"
  /** `--source` was something other than the two answers. */
  | "unknown_source";

export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;

  constructor(code: TranscriptErrorCode, message: string) {
    super(message);
    this.name = "TranscriptError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Input / output                                                             */
/* -------------------------------------------------------------------------- */

export interface TranscriptInput {
  readonly caseId: string;
  /** The transcript, verbatim, in whatever language it was written. */
  readonly text: string;
  /** How this text came to exist. Defaults to the cautious answer. */
  readonly source?: TranscriptSource;
}

/** One stored line, as the operator needs to see it to correct the guess. */
export interface TranscriptLine {
  readonly utteranceId: string;
  /** The slot or pseudonym written to `speaker_label`. */
  readonly speakerLabel: string;
  /** The speaker prefix as it was pasted, when there was one. */
  readonly parsedSpeaker: string | null;
  /** The line, exactly as it was pasted. */
  readonly text: string;
}

/** A parsed speaker and the slot it was given. */
export interface TranscriptSpeaker {
  /** The prefix as pasted — reported, never stored in an outbound column. */
  readonly parsed: string;
  /** The label written to the rows: `speaker_1`, `speaker_2`, … */
  readonly slot: string;
  readonly lines: number;
}

export interface AddedTranscript {
  readonly evidenceId: string;
  readonly sourceType: EvidenceSourceType;
  /** Machine suggestion. `grade_final` is NULL until a human signs it off. */
  readonly gradeSuggested: EvidenceGrade;
  readonly gradeRationale: string;
  readonly gradeReasons: readonly GradeReason[];
  /** One per non-empty line, in reading order. All `pending`. */
  readonly lines: readonly TranscriptLine[];
  /** Distinct parsed speakers, in order of first appearance. */
  readonly speakers: readonly TranscriptSpeaker[];
  /** Lines with no parsable prefix — attributed to the client. */
  readonly unattributedLines: number;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

interface ParsedLine {
  /** The whole line as pasted, which is what gets stored. */
  readonly text: string;
  /** The speaker prefix, when the line had one. */
  readonly speaker: string | null;
}

/**
 * Split the transcript into lines and read each one's speaker prefix, if it has
 * one.
 *
 * Blank lines separate; nothing inside a line is touched beyond trimming the
 * ends, which is the same handling the client's account and the counterparty's
 * statement get. A prefix with nothing after it is not a speaker turn — it is a
 * line that happens to end in a colon — so it stays whole.
 */
export function parseTranscript(text: string): ParsedLine[] {
  if (typeof text !== "string") {
    throw new TranscriptError(
      "empty_transcript",
      "There is nothing here to register.",
    );
  }
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptError(
      "transcript_too_long",
      `That is longer than one transcript can carry ` +
        `(${MAX_TRANSCRIPT_CHARS} characters). Register it in parts — nothing ` +
        `is lost by doing so.`,
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const match = SPEAKER_PREFIX.exec(line);
      const speaker = match?.[1].trim() ?? "";
      const body = match?.[2].trim() ?? "";
      return {
        text: line,
        speaker: speaker !== "" && body !== "" ? speaker : null,
      };
    });

  if (lines.length === 0) {
    throw new TranscriptError(
      "empty_transcript",
      "There is nothing here to register. Paste the conversation first.",
    );
  }
  return lines;
}

function summarize(lines: readonly ParsedLine[]): string {
  const text = lines
    .map((line) => line.text)
    .join(" / ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/* -------------------------------------------------------------------------- */
/* The write                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Register a pasted transcript as one evidence row owned by the client, plus one
 * `pending` utterance per line.
 *
 * One transaction. Everything it writes is the client's own material, at the
 * same standing as anything else he brings: private, unconfirmed, graded by
 * rule.
 */
export function addTranscriptEvidence(
  db: Db,
  input: TranscriptInput,
): AddedTranscript {
  const source = input.source ?? DEFAULT_TRANSCRIPT_SOURCE;
  if (!isTranscriptSource(source)) {
    throw new TranscriptError(
      "unknown_source",
      `Unknown transcript source "${String(source)}". It is one of: ` +
        `${TRANSCRIPT_SOURCES.join(", ")}.`,
    );
  }

  // Refuse before writing anything.
  const lines = parseTranscript(input.text);
  const client = db
    .select({ id: caseParticipants.id, pseudonym: caseParticipants.pseudonym })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.caseId, input.caseId),
        eq(caseParticipants.isSubmitter, true),
      ),
    )
    .get();
  if (client === undefined) {
    throw new TranscriptError(
      "no_client_participant",
      `Case ${input.caseId} has no participant marked as the submitter, so ` +
        `there is nobody this material could belong to. Material is owned by ` +
        `the party who brought it (SPEC M5 ①); a row with no owner is one no ` +
        `visibility rule can answer for.`,
    );
  }

  // By rule, from what the material is — never asked of a model, never taken
  // from whoever pasted it.
  const decision = deriveEvidenceGrade({
    sourceType: TRANSCRIPT_SOURCE_TYPES[source],
  });

  // Slots, in order of first appearance. The mapping is reported back and never
  // written to a column that egresses — see the module header.
  const slots = new Map<string, { slot: string; lines: number }>();
  for (const line of lines) {
    if (line.speaker === null) continue;
    const existing = slots.get(line.speaker);
    if (existing === undefined) {
      slots.set(line.speaker, { slot: `speaker_${slots.size + 1}`, lines: 1 });
    } else {
      existing.lines += 1;
    }
  }

  return db.transaction((tx) => {
    const [item] = tx
      .insert(evidenceTable)
      .values({
        caseId: input.caseId,
        sourceType: decision.sourceType,
        gradeSuggested: decision.grade,
        // NULL, like every other registration: a human confirms in the
        // workbench what kind of artifact this is. Unlike a typed account, the
        // provenance of a pasted file is not something this process observed —
        // "I exported this from the app" is a claim, and it is exactly the
        // claim `grade_final` exists for a person to check.
        gradeFinal: null,
        gradeRationale: decision.rationale,
        contentSummary: summarize(lines),
        ownerParticipantId: client.id,
        visibility: "private",
      })
      .returning({ id: evidenceTable.id })
      .all();

    const keys = generateNKeysBetween(null, null, lines.length);
    const written = lines.map((line, index) => {
      const slot = line.speaker === null ? null : slots.get(line.speaker)!.slot;
      const [row] = tx
        .insert(utterancesTable)
        .values({
          caseId: input.caseId,
          evidenceId: item.id,
          // A parsed prefix is a guess about who spoke, so it resolves to
          // nobody until a human says otherwise. A line with no prefix is the
          // client's own text in his own file, which is the one attribution
          // this module is entitled to make.
          speakerParticipantId: slot === null ? client.id : null,
          speakerLabel: slot ?? client.pseudonym,
          // `is_retold` marks a quote of somebody else recalled from memory
          // (HARD RULE #5). Whether a given line is one is a claim about that
          // line, and this module cannot make it — `utterance:set --retold`
          // is how it gets made.
          isRetold: false,
          orderKey: keys[index],
          ownerParticipantId: client.id,
          visibility: "private",
          // No machine wrote this text, so there is no `ai_draft` to attribute
          // one. `pending` all the same: pasting something and standing behind
          // it are two acts, and HARD RULE #1 turns on the second.
          aiDraft: null,
          humanFinal: line.text,
          confirmStatus: "pending",
        })
        .returning({ id: utterancesTable.id })
        .all();

      return {
        utteranceId: row.id,
        speakerLabel: slot ?? client.pseudonym,
        parsedSpeaker: line.speaker,
        text: line.text,
      };
    });

    return {
      evidenceId: item.id,
      sourceType: decision.sourceType,
      gradeSuggested: decision.grade,
      gradeRationale: decision.rationale,
      gradeReasons: decision.reasons,
      lines: written,
      speakers: [...slots.entries()].map(([parsed, value]) => ({
        parsed,
        slot: value.slot,
        lines: value.lines,
      })),
      unattributedLines: lines.filter((line) => line.speaker === null).length,
    };
  });
}
