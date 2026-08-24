/**
 * The counterparty's own write path (SPEC M5 ②, the write half).
 *
 * Everything the other party can put into a case from `/respond` goes through
 * this module: her account of what happened, her decision to decline, and the
 * confirmations that turn what she wrote into material anything downstream may
 * quote. It is the mirror of the client's intake, and it is deliberately built
 * out of the same parts rather than beside them.
 *
 * ## Four properties, each enforced by a write rather than by a screen
 *
 * 1. **Owned by her, private by default.** Every row this module inserts carries
 *    `owner_participant_id = her` and `visibility = 'private'`, so the query
 *    layer (`server/access/visibility.ts`) decides who may read it and no page
 *    has to remember to. The client does not see it — see (3).
 *
 * 2. **Unconfirmed is not citable (HARD RULE #1), for her identically.** Her
 *    lines land `pending` and become citable only when she confirms them,
 *    through `confirmUtterance` — the same function the client's OCR lines go
 *    through, called with an ownership check in front of it. There is no second
 *    confirmation path in this file, because a second confirmation path is how a
 *    hard rule ends up enforced in one of two places.
 *
 * 3. **Submitting is consent to be read as part of the case, and nothing more.**
 *    A `granted / case_record` event is appended in the same transaction as the
 *    material, so the record cannot hold her words without also holding the act
 *    that put them there. What it deliberately does NOT do is call
 *    `shareMaterialIntoCase`: that flips rows to `visibility = 'case'`, which is
 *    the stronger grant "every party to this case may read this", and she has not
 *    made it. Her material reaches the case record through the consent event —
 *    which is exactly what `resolveMaterialGrant` reads for the `CASE_RECORD`
 *    audience — while the client, as a participant audience, still needs a
 *    `counterparty_read` grant naming him. Consenting to be judged fairly is not
 *    consenting to hand the other party your files.
 *
 * 4. **Declining deletes nothing.** It writes what she did (`respond_state`,
 *    `decline_reason`, verbatim) and what the case now says about her
 *    (`participation_state = 'refused'`), and it touches no material at all.
 *    `DeclineOutcome.kept` reports what is still on file, so "nothing was
 *    deleted" is a value a test can assert instead of a promise in a comment.
 *    Taking material back out is a separate act with its own record
 *    (`withdrawMaterialFromCase`); doing it silently on a decline would decide
 *    for her that a person who will not take part also wants her side unheard.
 *
 * ## Her own acts outrank reports about her
 *
 * `participation_state` is the client's report of what happened when the other
 * party was asked. When she answers through the product herself, the report is
 * superseded: submitting writes `written_response`, declining writes `refused`.
 * A record that keeps saying "unreachable" about a person whose statement it is
 * currently holding is not a record, it is a leftover.
 *
 * Her words are evidence and stay in her language, verbatim — stored as typed,
 * never translated, never normalized (CLAUDE.md).
 */

import { and, count, eq, inArray } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";

import {
  asParticipant,
  consentStandingFor,
  hasIdentity,
  recordConsent,
  type ConsentRecord,
  type ConsentStanding,
  type IdentityRecord,
  type InvitedParticipant,
} from "../access";
import {
  openStandingDoor,
  resolveArrival,
  type ArrivalCredential,
} from "./door";
import type { Db } from "../db";
import {
  caseParticipants,
  evidence as evidenceTable,
  events as eventsTable,
  files as filesTable,
  utterances as utterancesTable,
  type ParticipationState,
  type RespondState,
} from "../db/schema";
import { deriveEvidenceGrade } from "../domain/grading";
import {
  CITABLE_STATUSES,
  confirmUtterance,
  editUtterance,
  listEvidenceUtterances,
  rejectUtterance,
  type WorkbenchUtterance,
} from "../evidence/workbench";
import type { Reader } from "../pipeline/stage-machine";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a written statement is, evidentially: a recollection (grade B).
 *
 * Not `firsthand` (A). A first-hand item is an original record of the moment —
 * a chat capture, a recording. An account written afterwards is memory, however
 * honest, and grading it A would put one party's recollection above the other's
 * on nothing but who typed it. The same rule already applies to the client's own
 * retellings (`REGISTRATION_SOURCE_TYPES.retelling`).
 */
const STATEMENT_SOURCE_TYPE = "recollection" as const;

/**
 * Upper bound on one submission, in characters.
 *
 * Not a judgment about how much she is allowed to say — she may submit again.
 * It is the bound that stops a single form post from writing an unbounded number
 * of rows into a case.
 */
export const MAX_STATEMENT_CHARS = 20_000;

/** How much of her statement is kept on `evidence.content_summary` for lists. */
const SUMMARY_MAX_CHARS = 160;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type SubmissionErrorCode =
  /** The participant is not a party to this case. */
  | "not_a_party"
  /** This path belongs to the other party; the client has his own intake. */
  | "is_submitter"
  /** Nothing was typed, or only whitespace was. */
  | "empty_statement"
  /** Over `MAX_STATEMENT_CHARS`. */
  | "statement_too_long"
  /** The row she is trying to confirm is not hers to touch. */
  | "material_not_hers";

/** A refusal with copy that is safe to show the person who hit it. */
export class SubmissionError extends Error {
  readonly code: SubmissionErrorCode;

  constructor(code: SubmissionErrorCode, message: string) {
    super(message);
    this.name = "SubmissionError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Who is holding the link                                                    */
/* -------------------------------------------------------------------------- */

/** How the person on this screen proved they are the party they claim to be. */
export type RespondingCredential = ArrivalCredential;

export interface RespondingParty {
  readonly participant: InvitedParticipant;
  /** Her account, once she has taken one up. Null while she is still on the invite. */
  readonly identity: IdentityRecord | null;
  readonly via: RespondingCredential;
}

/**
 * Resolve the `[token]` in the URL to the party it belongs to.
 *
 * Three credentials are accepted, because there are three moments: the
 * single-use invite before she has an account, the identity token afterwards,
 * and the share token on the document the client actually has a button for
 * (`participation/door.ts` explains why the third one had to be added). All
 * three are bearer capabilities checked against a stored hash, so this function
 * is the whole authentication of the `/respond` write path — nothing below it
 * takes a participant id from a request.
 *
 * Returns null for anything that does not resolve, with no distinction between
 * "wrong" and "expired": the entry screen owns the copy that tells her which,
 * and a write path that explains why a token failed is a write path that
 * answers questions for whoever is guessing.
 *
 * `touch` is accepted and ignored for the identity branch, which never writes
 * any more: rendering a screen is not an act, and neither is posting from one
 * (doc 05 §A.5). Her acts are recorded as acts; her presence is not recorded at
 * all.
 */
export function resolveRespondingParty(
  db: Db,
  token: string,
  options: {
    readonly now?: Date;
    /** Retained for callers; nothing on this path writes `last_seen_at`. */
    readonly touch?: boolean;
  } = {},
): RespondingParty | null {
  const outcome = resolveArrival(db, token, { now: options.now });
  return outcome.ok ? outcome.arrival : null;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

type ParticipantRow = typeof caseParticipants.$inferSelect;

/**
 * The party this module writes for: on the case, and not the person who filed
 * it. Re-read from the database on every call, so a stale page cannot decide
 * whose material it is writing.
 */
function requireRespondent(
  db: Reader,
  caseId: string,
  participantId: string,
): ParticipantRow {
  const row = db
    .select()
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.id, participantId),
        eq(caseParticipants.caseId, caseId),
      ),
    )
    .get();

  if (row === undefined) {
    throw new SubmissionError(
      "not_a_party",
      "You are not a party to this case, so there is nothing here to add to.",
    );
  }
  if (row.isSubmitter) {
    throw new SubmissionError(
      "is_submitter",
      "This is the other party's entry to the case. The person who filed it " +
        "adds material through their own workspace.",
    );
  }
  return row;
}

/** One line of hers, named the way a request names it. */
export interface OwnLineRef {
  readonly caseId: string;
  readonly participantId: string;
  readonly evidenceId: string;
  readonly utteranceId: string;
}

/**
 * Prove a row is hers before the workbench is allowed near it.
 *
 * The workbench checks that an utterance belongs to the evidence it was posted
 * with; it does not check who owns either, because until M5 there was one owner.
 * That check is this function, and it is why her confirm actions do not call the
 * workbench directly: an id in a form post is a claim, and a claim about whose
 * material a row is must be re-derived from the database.
 */
export function requireOwnLine(db: Reader, ref: OwnLineRef): void {
  const owned = db
    .select({ id: evidenceTable.id })
    .from(evidenceTable)
    .where(
      and(
        eq(evidenceTable.id, ref.evidenceId),
        eq(evidenceTable.caseId, ref.caseId),
        eq(evidenceTable.ownerParticipantId, ref.participantId),
      ),
    )
    .get();

  const line = db
    .select({ id: utterancesTable.id })
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.id, ref.utteranceId),
        eq(utterancesTable.evidenceId, ref.evidenceId),
        eq(utterancesTable.ownerParticipantId, ref.participantId),
      ),
    )
    .get();

  if (owned === undefined || line === undefined) {
    throw new SubmissionError(
      "material_not_hers",
      "That line is not yours, so it cannot be changed from here. You can only " +
        "confirm, rewrite or withdraw what you submitted yourself.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Submitting her side                                                        */
/* -------------------------------------------------------------------------- */

export interface StatementInput {
  readonly caseId: string;
  readonly participantId: string;
  /** Her account, in her own words and her own language. Stored verbatim. */
  readonly text: string;
  /** What she wants said about the decision to submit it, verbatim. */
  readonly note?: string | null;
  /** Injected clock, so tests are deterministic. */
  readonly now?: Date;
}

export interface SubmittedStatement {
  readonly evidenceId: string;
  /** One per line she wrote, in reading order. All `pending`. */
  readonly utteranceIds: readonly string[];
  /** The `granted / case_record` event written in the same transaction. */
  readonly consent: ConsentRecord;
  readonly participationState: ParticipationState;
}

/**
 * Split her statement into the lines the confirmation cards work on.
 *
 * Blank lines separate; nothing inside a line is touched. This is the only
 * handling her text gets before it is stored, and it is deliberately the least
 * that still produces reviewable units — collapsing whitespace or joining
 * paragraphs would be editing a record of what somebody said.
 */
function splitStatement(text: string): string[] {
  if (typeof text !== "string") {
    throw new SubmissionError(
      "empty_statement",
      "There is nothing to submit yet. Write what happened in your own words.",
    );
  }
  if (text.length > MAX_STATEMENT_CHARS) {
    throw new SubmissionError(
      "statement_too_long",
      `That is longer than one submission can carry (${MAX_STATEMENT_CHARS} ` +
        `characters). Submit it in parts — nothing is lost by doing so.`,
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new SubmissionError(
      "empty_statement",
      "There is nothing to submit yet. Write what happened in your own words.",
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
 * Take her side of it: material owned by her, private, unconfirmed, plus the
 * consent event that puts it inside the case record.
 *
 * One transaction. Material without the consent event would be words the record
 * holds with no act behind them; the consent event without the material would be
 * a grant over nothing.
 */
export function submitStatement(
  db: Db,
  input: StatementInput,
): SubmittedStatement {
  // Refuse before writing anything; both checks are pure and cheap.
  requireRespondent(db, input.caseId, input.participantId);
  const lines = splitStatement(input.text);
  const now = input.now ?? new Date();

  // Deterministic, by rule, from what the material is — never asked of a model.
  const decision = deriveEvidenceGrade({ sourceType: STATEMENT_SOURCE_TYPE });

  return db.transaction((tx) => {
    // Re-read inside the transaction, as every other write path here does: the
    // decision that authorizes a write is made against the database at write
    // time, not against whatever a page last rendered.
    const party = requireRespondent(tx, input.caseId, input.participantId);

    // Her own act outranks any report about her, except one that already says
    // she is taking part — `participating` is the stronger claim of the same
    // kind, and stepping it down to `written_response` would lose what the
    // client recorded.
    const participationState: ParticipationState =
      party.participationState === "participating"
        ? "participating"
        : "written_response";

    const [item] = tx
      .insert(evidenceTable)
      .values({
        caseId: input.caseId,
        sourceType: decision.sourceType,
        gradeSuggested: decision.grade,
        // Signed off at write time, to the rule's own answer and to nothing
        // else. This is the one artifact in the product whose PROVENANCE the
        // system observed directly: it is a statement typed into this form at
        // this timestamp, so there is no registration claim for a human to
        // review and no second grade the rule can produce (`recollection` → B
        // is total). `grade_final` elsewhere means "a human checked what kind
        // of artifact this is"; here that check has no question in it.
        //
        // Leaving it NULL was the first instinct — a party should not grade her
        // own material — and it has exactly one consequence, which is not
        // caution: `grade_final` is what the citation audit reads, so nothing
        // she submits could ever be rested on. L1 would be reachable on her
        // material and uncitable from it. The risk the instinct was about is a
        // party awarding herself grade A; that is closed by taking the grade
        // from `deriveEvidenceGrade` rather than from her, not by withholding
        // it. See SPEC M5 ⑥ (2026-08-12, the L1 run).
        gradeFinal: decision.grade,
        gradeConfirmedAt: now,
        gradeRationale: decision.rationale,
        contentSummary: summarize(lines),
        ownerParticipantId: party.id,
        visibility: "private",
      })
      .returning({ id: evidenceTable.id })
      .all();

    const keys = generateNKeysBetween(null, null, lines.length);
    const utteranceIds = lines.map((line, index) => {
      const [row] = tx
        .insert(utterancesTable)
        .values({
          caseId: input.caseId,
          evidenceId: item.id,
          // She is the speaker of her own account, and the label is the
          // pseudonym, because the label is what egresses (HARD RULE #3).
          speakerParticipantId: party.id,
          speakerLabel: party.pseudonym,
          // Her own words, first-hand from her mouth. `is_retold` marks a quote
          // of somebody else recalled from memory (HARD RULE #5) — a different
          // claim, and not this one.
          isRetold: false,
          orderKey: keys[index],
          ownerParticipantId: party.id,
          visibility: "private",
          // No machine wrote this, so there is no `ai_draft` to attribute one.
          // The text is hers from the first byte; `confirm_status` still starts
          // at `pending`, because typing something and standing behind it are
          // two acts and the citation rule turns on the second one.
          aiDraft: null,
          humanFinal: line,
          confirmStatus: "pending",
        })
        .returning({ id: utterancesTable.id })
        .all();
      return row.id;
    });

    const consent = recordConsent(tx as unknown as Db, {
      caseId: input.caseId,
      actorParticipantId: party.id,
      kind: "granted",
      scope: "case_record",
      note: input.note ?? null,
      occurredAt: now,
    });

    tx.update(caseParticipants)
      .set({ participationState })
      .where(eq(caseParticipants.id, party.id))
      .run();

    return {
      evidenceId: item.id,
      utteranceIds,
      consent,
      participationState,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Confirming what she wrote                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stand behind a line as written (pending → confirmed).
 *
 * Delegates to the workbench, so the transition table, the terminal-`rejected`
 * rule and the empty-text refusal are the same ones the client's material is
 * held to. The only thing added here is the ownership check.
 */
export function confirmOwnLine(db: Db, ref: OwnLineRef): WorkbenchUtterance {
  requireOwnLine(db, ref);
  return confirmUtterance(db, {
    evidenceId: ref.evidenceId,
    utteranceId: ref.utteranceId,
  });
}

/** Rewrite a line in different words (→ edited). Still hers, still citable after. */
export function reviseOwnLine(
  db: Db,
  ref: OwnLineRef & { readonly text: string },
): WorkbenchUtterance {
  requireOwnLine(db, ref);
  return editUtterance(db, {
    evidenceId: ref.evidenceId,
    utteranceId: ref.utteranceId,
    text: ref.text,
  });
}

/**
 * Take a line back before it is ever cited (→ rejected, terminal).
 *
 * The text stays on the row for the audit trail; what changes is that nothing
 * downstream may quote it (HARD RULE #1). Deleting material outright is the
 * transparency view's job and a different act.
 */
export function withdrawOwnLine(db: Db, ref: OwnLineRef): WorkbenchUtterance {
  requireOwnLine(db, ref);
  return rejectUtterance(db, {
    evidenceId: ref.evidenceId,
    utteranceId: ref.utteranceId,
  });
}

/* -------------------------------------------------------------------------- */
/* Declining                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeclineInput {
  readonly caseId: string;
  readonly participantId: string;
  /** Why, in her own words, verbatim. Null is a legitimate answer. */
  readonly reason?: string | null;
  readonly now?: Date;
}

/** What one party still has on file. Reported so "nothing was deleted" is checkable. */
export interface MaterialTally {
  readonly files: number;
  readonly evidence: number;
  readonly utterances: number;
  readonly events: number;
}

export interface DeclineOutcome {
  readonly participantId: string;
  readonly respondState: RespondState;
  readonly participationState: ParticipationState;
  /** Her words, unedited. Null when she gave no reason. */
  readonly reason: string | null;
  readonly declinedAt: Date;
  /** Everything of hers that is still here, counted after the write. */
  readonly kept: MaterialTally;
  /**
   * True once the client can no longer mint her an invitation. Reported rather
   * than implied, so the screen that promised it can be tested against the
   * write that delivered it.
   */
  readonly mintingClosed: boolean;
  /**
   * True once her link has no deadline on it: the single-use invitation became
   * her standing personal door. False when she already holds an account, where
   * the identity token is the standing door and there is nothing to convert.
   */
  readonly standingDoor: boolean;
}

/**
 * Exactly what declining does, in the order it does it.
 *
 * Exported so the confirmation screen and the record cannot drift: the sentences
 * a person is shown *before* she presses the button are the same strings this
 * module can be tested against. Doc 05 §A.4 fixes all four; none of them is a
 * consequence on the merits, because a one-sided record licenses no inference
 * from silence and none from a refusal either.
 */
export const DECLINE_CONSEQUENCES: readonly string[] = [
  "Your participation is recorded as refused, by your own act. It replaces " +
    "whatever the other party reported about whether you could be reached.",
  "The analysis that already exists stands unchanged, at the level it was " +
    "written at — one account only. Declining does not lower it, raise it, or " +
    "alter a word of it.",
  "Any later version states one fact about this: invited on a date, declined " +
    "on a date. Nothing may be inferred from it — not agreement, not fault, " +
    "not avoidance. Silence and refusal are not evidence of anything.",
  "You keep this door. Your link stops expiring, no further invitation is " +
    "created for you, and you can come back to read what is held about you or " +
    "to change this answer.",
];

/** Count one owner's rows on the four material tables. */
function tallyMaterial(
  db: Reader,
  caseId: string,
  ownerId: string,
): MaterialTally {
  const tally = (table: typeof filesTable | typeof evidenceTable | typeof utterancesTable | typeof eventsTable): number => {
    const [row] = db
      .select({ n: count() })
      .from(table)
      .where(
        and(eq(table.caseId, caseId), eq(table.ownerParticipantId, ownerId)),
      )
      .all();
    return row?.n ?? 0;
  };

  return {
    files: tally(filesTable),
    evidence: tally(evidenceTable),
    utterances: tally(utterancesTable),
    events: tally(eventsTable),
  };
}

/**
 * Record that she will not take part.
 *
 * A first-class outcome, not a dead end and not an absence: `respond_state`
 * records what she did, `decline_reason` keeps her words, and
 * `participation_state = 'refused'` is what the case shows the client — the same
 * column his own screen writes, so a decline she made herself and a refusal he
 * reported are the same fact to everything downstream, and the two columns
 * together still say which of them it was.
 *
 * Nothing is deleted. Declining again with no new reason keeps the reason she
 * gave the first time, because the alternative is a second click erasing her own
 * words.
 *
 * ## Two things the write does besides recording the answer (doc 05 §A.4)
 *
 * **The client's minting closes.** Enforced in `issueInviteToken`, which reads
 * `respond_state` before it writes, so it holds against any caller rather than
 * against the one screen that would have offered a re-invite button. There is no
 * re-invite stream after a refusal.
 *
 * **Her link stops expiring.** `openStandingDoor` clears the deadline on the
 * unspent invitation, so the single-use credential she is holding becomes her
 * standing personal door — to the transparency view, and to reversing this exact
 * decision. Those two are the same act read from two directions: closing the
 * client's ability to ask again is only fair if her ability to answer again
 * stays open, and a decline its author cannot reverse is a trap in the other
 * direction.
 *
 * Both happen in the same transaction as the answer itself, because a decline
 * recorded without them is a decline whose stated consequences are false.
 */
export function declineParticipation(
  db: Db,
  input: DeclineInput,
): DeclineOutcome {
  const party = requireRespondent(db, input.caseId, input.participantId);
  const now = input.now ?? new Date();

  const typed = typeof input.reason === "string" ? input.reason.trim() : "";
  const reason = typed === "" ? party.declineReason : typed;

  db.transaction((tx) => {
    tx.update(caseParticipants)
      .set({
        respondState: "declined",
        respondStateAt: now,
        declineReason: reason,
        participationState: "refused",
      })
      .where(eq(caseParticipants.id, party.id))
      .run();

    openStandingDoor(tx as unknown as Db, party.id);
  });

  const after = db
    .select({
      hash: caseParticipants.inviteTokenHash,
      expiresAt: caseParticipants.inviteTokenExpiresAt,
      redeemedAt: caseParticipants.inviteTokenRedeemedAt,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, party.id))
    .get();

  return {
    participantId: party.id,
    respondState: "declined",
    participationState: "refused",
    reason,
    declinedAt: now,
    kept: tallyMaterial(db, input.caseId, party.id),
    mintingClosed: true,
    standingDoor:
      after !== undefined &&
      after.hash !== null &&
      after.redeemedAt === null &&
      after.expiresAt === null,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One thing she submitted, with its lines as the confirmation cards see them. */
export interface OwnSubmission {
  readonly evidenceId: string;
  readonly submittedAt: Date;
  readonly lines: readonly WorkbenchUtterance[];
  /** Lines that are confirmed or rewritten — i.e. citable. */
  readonly confirmedLines: number;
  /** Lines still waiting on her. */
  readonly pendingLines: number;
}

export interface SubmissionState {
  readonly caseId: string;
  readonly participantId: string;
  /** The token that egresses. Her real name never leaves this machine. */
  readonly pseudonym: string;
  readonly displayName: string | null;
  readonly respondState: RespondState;
  readonly declineReason: string | null;
  readonly participationState: ParticipationState;
  /** Whether she has taken up an account, as opposed to holding an invite. */
  readonly hasAccount: boolean;
  /** Where her `case_record` grant stands: granted / revoked / never asked. */
  readonly caseRecordConsent: ConsentStanding;
  /**
   * Whether the client may read her material. `unrecorded` here is the normal
   * state and means no: nothing she submits reaches him without this grant.
   */
  readonly clientMayRead: boolean;
  readonly submissions: readonly OwnSubmission[];
  readonly totalLines: number;
  readonly confirmedLines: number;
}

/**
 * Everything her submission screen renders, and nothing about the client.
 *
 * The lines come from `listEvidenceUtterances` with her own audience, so this
 * read is filtered by the same predicate that would refuse the client — a screen
 * that fetched her rows by owner alone would work today and be the wrong shape
 * the moment anything else is put on it.
 */
export function readSubmissionState(
  db: Db,
  caseId: string,
  participantId: string,
): SubmissionState {
  const party = requireRespondent(db, caseId, participantId);
  const audience = asParticipant(party.id);

  const owned = db
    .select({ id: evidenceTable.id, createdAt: evidenceTable.createdAt })
    .from(evidenceTable)
    .where(
      and(
        eq(evidenceTable.caseId, caseId),
        eq(evidenceTable.ownerParticipantId, party.id),
      ),
    )
    .all()
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const submissions: OwnSubmission[] = owned.map((row) => {
    const lines = listEvidenceUtterances(db, row.id, audience);
    const confirmed = lines.filter((line) =>
      (CITABLE_STATUSES as readonly string[]).includes(line.confirmStatus),
    ).length;
    return {
      evidenceId: row.id,
      submittedAt: row.createdAt,
      lines,
      confirmedLines: confirmed,
      pendingLines: lines.filter((line) => line.confirmStatus === "pending")
        .length,
    };
  });

  const client = db
    .select({ id: caseParticipants.id })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.caseId, caseId),
        eq(caseParticipants.isSubmitter, true),
      ),
    )
    .get();

  return {
    caseId,
    participantId: party.id,
    pseudonym: party.pseudonym,
    displayName: party.displayName,
    respondState: party.respondState,
    declineReason: party.declineReason,
    participationState: party.participationState,
    hasAccount: hasIdentity(db, party.id),
    caseRecordConsent: consentStandingFor(db, caseId, party.id, "case_record"),
    clientMayRead:
      client !== undefined &&
      consentStandingFor(
        db,
        caseId,
        party.id,
        "counterparty_read",
        client.id,
      ) === "granted",
    submissions,
    totalLines: submissions.reduce((sum, item) => sum + item.lines.length, 0),
    confirmedLines: submissions.reduce(
      (sum, item) => sum + item.confirmedLines,
      0,
    ),
  };
}

/**
 * Has this party confirmed material of their own?
 *
 * The fact behind `EvidenceProfileInput.hasCounterpartyConfirmed` (HARD RULE #2)
 * — exported here rather than derived at the call site so that "she confirmed
 * something of her own" has one definition: a line she owns, that she settled,
 * on this case. It is not "the counterparty appears in the record": on the real
 * seeded case every confirmed line was spoken by her and confirmed by the client
 * out of his screenshots, and reading that as her engagement would promote the
 * most one-sided case in the corpus to a full judgment.
 */
export function hasConfirmedMaterialFrom(
  db: Reader,
  caseId: string,
  participantId: string,
): boolean {
  const [row] = db
    .select({ n: count() })
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        eq(utterancesTable.ownerParticipantId, participantId),
        inArray(utterancesTable.confirmStatus, [...CITABLE_STATUSES]),
      ),
    )
    .all();
  return (row?.n ?? 0) > 0;
}
