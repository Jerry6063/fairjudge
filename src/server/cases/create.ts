/**
 * Case creation — the front door (04-ux-design-plan.md §4.1).
 *
 * Until this module existed, the only way a case got into the database was the
 * seed importer. That is not a missing screen; it is a missing act. Filing is
 * the moment four things become true at once, and this function is written so
 * that they become true together or not at all:
 *
 *   1. **A case exists, at stage `intake`.** Not at `evidence_intake` — the
 *      importer starts there because it arrives holding materials, and a person
 *      arrives holding a fight. Stage ① is where the safety screen lives, and a
 *      case that skipped into stage ② would be one the screen has to be
 *      retro-fitted onto (the intake page already has copy apologizing for
 *      exactly that state).
 *
 *   2. **Both parties are registered in the pseudonym dictionary.** HARD RULE #3
 *      makes an unregistered person name block egress, which means that until
 *      both names are on `case_participants` as (display_name → pseudonym), the
 *      case is one where nothing can be sent anywhere. Registration is therefore
 *      part of creating the case rather than an error somebody meets later, at
 *      the first model call, with a fight already typed in. `buildCaseDict`
 *      (server/evidence/anomaly.ts) reads exactly the rows written here.
 *
 *   3. **What the client came for is on file.** `client_intent` records the
 *      answer to "what do you want out of this", including the answer the
 *      product refuses to deliver from one account. It is a record of a request:
 *      nothing downstream reads it as an instruction, and the level derivation
 *      never sees it (HARD RULE #2).
 *
 *   4. **The first account is material, held to the same rules as everybody
 *      else's.** It lands as `recollection` evidence owned by the client, split
 *      into one `pending` utterance per line — so it is not citable until he
 *      confirms it (HARD RULE #1), and it is graded by
 *      `deriveEvidenceGrade` rather than by whoever typed it. This is the same
 *      shape `submitStatement` gives the counterparty's account, deliberately:
 *      the client's first telling is a recollection too, and a front door that
 *      quietly graded his words higher than hers would decide the case at the
 *      form.
 *
 * One transaction. A case with a title and no parties would be a case that
 * cannot reach a model; parties with no case would be dictionary entries about
 * nothing.
 *
 * The account is evidence and stays in whatever language it was typed in —
 * never translated, never normalized (CLAUDE.md).
 */

import { and, eq } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";

import type { Db } from "../db";
import {
  CLIENT_INTENTS,
  caseParticipants,
  cases,
  evidence as evidenceTable,
  utterances as utterancesTable,
  type ClientIntent,
} from "../db/schema";
import { deriveEvidenceGrade } from "../domain/grading";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The pseudonyms the two roles get.
 *
 * Fixed per role, not allocated per person: the pseudonym is the token that
 * egresses, and it has to be derivable from the case rather than from a
 * counter somewhere. Matches the seed importer (甲 = respondent, 乙 = the party
 * who filed), so a hand-made case and the imported one read alike downstream.
 */
export const INITIATOR_PSEUDONYM = "乙";
export const RESPONDENT_PSEUDONYM = "甲";

/**
 * What a typed first account is, evidentially: a recollection (grade B).
 *
 * Same rule and same reason as the counterparty's statement
 * (server/participation/submission.ts): an account written after the fact is
 * memory, however honest, and the party who happens to own the device does not
 * get a better grade for it.
 */
const ACCOUNT_SOURCE_TYPE = "recollection" as const;

/** Upper bound on one account, in characters. Mirrors `MAX_STATEMENT_CHARS`. */
export const MAX_ACCOUNT_CHARS = 20_000;

/** Upper bound on the case title. A title is a line, not a statement. */
export const MAX_TITLE_CHARS = 200;

/** Upper bound on a party name. */
export const MAX_NAME_CHARS = 120;

/** How much of the account is kept on `evidence.content_summary` for lists. */
const SUMMARY_MAX_CHARS = 160;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type CaseCreationErrorCode =
  /** No title, or only whitespace. */
  | "empty_title"
  /** Over `MAX_TITLE_CHARS`. */
  | "title_too_long"
  /** The intent field was missing or not one of the three answers. */
  | "unknown_intent"
  /** One or both party names were blank. Registration needs a name (rule 3). */
  | "empty_party_name"
  /** Over `MAX_NAME_CHARS`. */
  | "party_name_too_long"
  /** Both parties were given the same name; the dictionary cannot hold that. */
  | "duplicate_party_name"
  /** Nothing was typed as an account, or only whitespace. */
  | "empty_account"
  /** Over `MAX_ACCOUNT_CHARS`. */
  | "account_too_long";

/** A refusal with copy that is safe to show the person who hit it. */
export class CaseCreationError extends Error {
  readonly code: CaseCreationErrorCode;
  /** Which form field the refusal is about, for the screen to point at. */
  readonly field: CaseCreationField;

  constructor(
    code: CaseCreationErrorCode,
    field: CaseCreationField,
    message: string,
  ) {
    super(message);
    this.name = "CaseCreationError";
    this.code = code;
    this.field = field;
  }
}

/** The fields the form has, named once so the action and the page agree. */
export type CaseCreationField =
  | "intent"
  | "title"
  | "clientName"
  | "counterpartyName"
  | "account";

/* -------------------------------------------------------------------------- */
/* Input / output                                                             */
/* -------------------------------------------------------------------------- */

export interface CreateCaseInput {
  /** One line naming what is being judged. */
  readonly title: string;
  /** What the client answered when asked what they wanted out of this. */
  readonly intent: ClientIntent;
  /** The client's own name — local only, never sent to any model. */
  readonly clientName: string;
  /** The other party's name. Registered now, present or not (HARD RULE #3). */
  readonly counterpartyName: string;
  /** The client's first account, verbatim, in whatever language it was typed. */
  readonly account: string;
  /**
   * True only for authored demonstration cases whose every person is invented
   * (docs/05 §C). Never set from a form the real user fills in.
   */
  readonly isFixture?: boolean;
  /** Injected clock, so tests are deterministic. */
  readonly now?: Date;
}

export interface CreatedCase {
  readonly caseId: string;
  readonly clientParticipantId: string;
  readonly counterpartyParticipantId: string;
  /** The evidence row holding the first account. */
  readonly evidenceId: string;
  /** One per line of the account, in reading order. All `pending`. */
  readonly utteranceIds: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function readLine(
  value: unknown,
  field: CaseCreationField,
  limit: number,
  empty: CaseCreationErrorCode,
  long: CaseCreationErrorCode,
  emptyMessage: string,
  longMessage: string,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new CaseCreationError(empty, field, emptyMessage);
  if (text.length > limit) {
    throw new CaseCreationError(long, field, longMessage);
  }
  return text;
}

/**
 * Split the account into the lines the confirmation cards work on.
 *
 * Blank lines separate; nothing inside a line is touched. Same handling the
 * counterparty's statement gets, and for the same reason: collapsing whitespace
 * or joining paragraphs would be editing a record of what somebody said.
 */
function splitAccount(value: unknown): string[] {
  const text = typeof value === "string" ? value : "";
  if (text.length > MAX_ACCOUNT_CHARS) {
    throw new CaseCreationError(
      "account_too_long",
      "account",
      `That is longer than one account can carry (${MAX_ACCOUNT_CHARS} ` +
        `characters). Put the rest in as evidence once the case is open — ` +
        `nothing is lost by doing so.`,
    );
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    throw new CaseCreationError(
      "empty_account",
      "account",
      "There is nothing here yet. Write what happened, in your own words.",
    );
  }
  return lines;
}

function summarize(lines: readonly string[]): string {
  const text = lines.join(" / ");
  return text.length <= SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/**
 * Check every field before anything is written.
 *
 * Exported because the form wants the same answers without creating a case:
 * one implementation of what a valid filing is, or the screen and the database
 * will eventually disagree about it.
 */
export function validateCaseInput(input: {
  readonly title?: unknown;
  readonly intent?: unknown;
  readonly clientName?: unknown;
  readonly counterpartyName?: unknown;
  readonly account?: unknown;
}): {
  readonly title: string;
  readonly intent: ClientIntent;
  readonly clientName: string;
  readonly counterpartyName: string;
  readonly lines: readonly string[];
} {
  const title = readLine(
    input.title,
    "title",
    MAX_TITLE_CHARS,
    "empty_title",
    "title_too_long",
    "Give this case a name. One line about what is being judged is enough.",
    `Keep the title under ${MAX_TITLE_CHARS} characters — the account below is ` +
      `where the detail goes.`,
  );

  if (
    typeof input.intent !== "string" ||
    !(CLIENT_INTENTS as readonly string[]).includes(input.intent)
  ) {
    throw new CaseCreationError(
      "unknown_intent",
      "intent",
      "Choose one of the three answers before continuing.",
    );
  }
  const intent = input.intent as ClientIntent;

  // Both names, then the comparison. HARD RULE #3: a name that is not in the
  // dictionary blocks egress, so "I would rather not say" is not an option the
  // form can offer — it is an option that stops the case working.
  const clientName = readLine(
    input.clientName,
    "clientName",
    MAX_NAME_CHARS,
    "empty_party_name",
    "party_name_too_long",
    "Your name is needed to register it for replacement. Without it, nothing " +
      "about this case can be sent anywhere.",
    `That is longer than ${MAX_NAME_CHARS} characters. Use the name that ` +
      `appears in the messages.`,
  );
  const counterpartyName = readLine(
    input.counterpartyName,
    "counterpartyName",
    MAX_NAME_CHARS,
    "empty_party_name",
    "party_name_too_long",
    "The other person's name is needed to register it for replacement. " +
      "Without it, nothing about this case can be sent anywhere.",
    `That is longer than ${MAX_NAME_CHARS} characters. Use the name that ` +
      `appears in the messages.`,
  );

  if (clientName === counterpartyName) {
    throw new CaseCreationError(
      "duplicate_party_name",
      "counterpartyName",
      "Both parties are down as the same name. The replacement table maps one " +
        "name to one person, so two people sharing an entry would make every " +
        "later quote ambiguous about who said it.",
    );
  }

  return {
    title,
    intent,
    clientName,
    counterpartyName,
    lines: splitAccount(input.account),
  };
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * File a case: the case row, both parties registered, the first account stored.
 *
 * Validates completely before opening the transaction, so a refusal never
 * leaves a half-made case behind.
 */
export function createCase(db: Db, input: CreateCaseInput): CreatedCase {
  const { title, intent, clientName, counterpartyName, lines } =
    validateCaseInput(input);
  const now = input.now ?? new Date();

  // By rule, from what the material is — never asked of a model, never taken
  // from the person submitting it.
  const decision = deriveEvidenceGrade({ sourceType: ACCOUNT_SOURCE_TYPE });

  return db.transaction((tx) => {
    const [row] = tx
      .insert(cases)
      .values({
        title,
        // Stage ①. The safety screen has not run yet and nothing may act as
        // though it has.
        stage: "intake",
        stageEnteredAt: now,
        clientIntent: intent,
        isFixture: input.isFixture ?? false,
      })
      .returning({ id: cases.id })
      .all();
    const caseId = row.id;

    // Dictionary registration (HARD RULE #3). `display_name` is the canonical
    // real name and stays on this machine; `pseudonym` is the only one of the
    // two that ever leaves it.
    const parties = tx
      .insert(caseParticipants)
      .values([
        {
          caseId,
          role: "initiator",
          displayName: clientName,
          pseudonym: INITIATOR_PSEUDONYM,
          isSubmitter: true,
          // He is here by the act of filing; that is not a report about a third
          // party but an observed fact.
          participationState: "participating",
        },
        {
          caseId,
          role: "respondent",
          displayName: counterpartyName,
          pseudonym: RESPONDENT_PSEUDONYM,
          isSubmitter: false,
          // Nothing has been asked of her yet. `pending` is the honest state:
          // not invited, not refused, not unreachable.
          participationState: "pending",
        },
      ])
      .returning({ id: caseParticipants.id, role: caseParticipants.role })
      .all();

    const clientParticipantId = parties.find(
      (party) => party.role === "initiator",
    )!.id;
    const counterpartyParticipantId = parties.find(
      (party) => party.role === "respondent",
    )!.id;

    const [item] = tx
      .insert(evidenceTable)
      .values({
        caseId,
        sourceType: decision.sourceType,
        gradeSuggested: decision.grade,
        // Signed off at write time, to the rule's own answer — the same call
        // `submitStatement` makes, with the same reasoning: this is the one
        // artifact whose provenance the system observed directly (text typed
        // into this form at this timestamp), so there is no registration claim
        // for a human to review. Leaving `grade_final` NULL would make the
        // client's own account permanently uncitable, which is not caution.
        gradeFinal: decision.grade,
        gradeConfirmedAt: now,
        gradeRationale: decision.rationale,
        contentSummary: summarize(lines),
        ownerParticipantId: clientParticipantId,
        // Private, like everybody's material. For the submitter this is still
        // inside the case record — `resolveMaterialGrant` puts the submitter's
        // rows in the CASE_RECORD audience, because filing a case is what
        // putting your own material into it means.
        visibility: "private",
      })
      .returning({ id: evidenceTable.id })
      .all();

    const keys = generateNKeysBetween(null, null, lines.length);
    const utteranceIds = lines.map((line, index) => {
      const [utterance] = tx
        .insert(utterancesTable)
        .values({
          caseId,
          evidenceId: item.id,
          speakerParticipantId: clientParticipantId,
          // The label is the pseudonym, because the label is what egresses.
          speakerLabel: INITIATOR_PSEUDONYM,
          // His own words about his own experience. `is_retold` marks a quote
          // of somebody else recalled from memory (HARD RULE #5) — a different
          // claim, and one this form cannot make for him line by line.
          isRetold: false,
          orderKey: keys[index],
          ownerParticipantId: clientParticipantId,
          visibility: "private",
          // No machine wrote this. `pending` all the same: typing something and
          // standing behind it are two acts, and HARD RULE #1 turns on the
          // second one.
          aiDraft: null,
          humanFinal: line,
          confirmStatus: "pending",
        })
        .returning({ id: utterancesTable.id })
        .all();
      return utterance.id;
    });

    return {
      caseId,
      clientParticipantId,
      counterpartyParticipantId,
      evidenceId: item.id,
      utteranceIds,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Read-back                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two parties of a case, as the dictionary holds them.
 *
 * Exists so a caller can assert what registration actually did without
 * assembling the join itself.
 */
export function readCaseParties(
  db: Db,
  caseId: string,
): {
  readonly role: "initiator" | "respondent";
  readonly displayName: string | null;
  readonly pseudonym: string;
}[] {
  return db
    .select({
      role: caseParticipants.role,
      displayName: caseParticipants.displayName,
      pseudonym: caseParticipants.pseudonym,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();
}

/** The client's stated intent, or null if the case was made without the question. */
export function readClientIntent(db: Db, caseId: string): ClientIntent | null {
  const [row] = db
    .select({ clientIntent: cases.clientIntent })
    .from(cases)
    .where(and(eq(cases.id, caseId)))
    .all();
  return row?.clientIntent ?? null;
}
