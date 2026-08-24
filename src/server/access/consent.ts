/**
 * Consent as events (SPEC M5 ③).
 *
 * A boolean cannot carry consent. "She agreed" is a claim about a moment — who
 * said it, when, about what — and it has to survive the answer changing.
 * Revocation is therefore not the deletion of a grant but a later event that
 * supersedes it: both stay readable, and the case can show what was true while
 * it was true. The table is append-only in the database (a BEFORE UPDATE trigger
 * in migration 0011), not merely by convention here.
 *
 * ## Three-valued on purpose
 *
 * `consentStandingFor` answers `granted` / `revoked` / `unrecorded`, and the
 * third is not a synonym for the second. Nobody has been asked yet in the real
 * case, and collapsing "she has not been asked" into "she said no" would make
 * the record assert something on her behalf — the same failure
 * `deriveCounterpartyParticipation` exists to avoid on the participation column.
 *
 * It also lets each caller state its own default out loud, which is the only way
 * they can differ honestly:
 *
 *   - the query layer treats `unrecorded` as **not granted** — a non-submitter's
 *     material stays out of the case record until she puts it there;
 *   - the export gate treats `unrecorded` as **not revoked** — M4 shipped an
 *     export path that never asked, and quietly disabling it the moment this
 *     table existed would be a policy change disguised as plumbing.
 *
 * ## Which event wins
 *
 * The latest one, by `occurred_at`, then `created_at`, then id — every component
 * a stored value, so two readers of one record always agree. An event with no
 * subject is about everyone the scope can mean; an event naming a subject is
 * about that person. Asking about a subject therefore reads both, which is what
 * makes a blanket revocation actually revoke the person-specific grant that came
 * before it.
 *
 * The rule is written once, as {@link foldConsent} over the events in order, and
 * every reading below goes through it. A second place that decided "which event
 * wins" would eventually decide it differently.
 *
 * ## Where revocation bites, and where it cannot
 *
 * `named_rendition` is the scope with teeth (SPEC M5 ③): while a revocation of it
 * stands, no copy of a document naming that party is exported and no share link
 * is minted or opened. Both doors call {@link assertNamedRenditionAllowed}, which
 * is the only definition of the rule; the export gate and the share-token guard
 * translate its refusal into their own error type rather than restating it.
 *
 * And it stops there, which has to be said out loud. A copy that was exported
 * before the revocation is bytes on somebody else's machine: there is no recall,
 * no expiry and no delete-from-a-distance, and a product that implied otherwise
 * would be lying at the exact moment the person is trusting it most. So every
 * reading of a revocation carries {@link ExportedCopy} rows for what already
 * left, each stamped `recallable: false`. Revoking stops the next copy, not the
 * last one, and the record says so in those words.
 *
 * A share link is the other case, and it is genuinely different: the token opens
 * a document *this* machine serves, so the promise is keepable there and it is
 * kept — a live link stops working while the revocation stands. It is suspended,
 * not burnt. Re-granting makes the same link work again, because the log is the
 * state and there is nothing else to restore.
 */

import { and, eq, getTableColumns, sql } from "drizzle-orm";

import type { Db } from "../db";
import {
  caseParticipants,
  consentEvents,
  judgmentExports,
  type ConsentKind,
  type ConsentScope,
  type ExportChannel,
  type RenditionKind,
} from "../db/schema";
import type { Reader } from "../pipeline/stage-machine";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a scope stands right now, for one actor.
 *
 * `unrecorded` means nobody has ever answered. See the module header for why it
 * is not folded into `revoked`.
 */
export type ConsentStanding = "granted" | "revoked" | "unrecorded";

/** Where a scope stands, and the event that put it there. */
export interface ConsentFold {
  readonly standing: ConsentStanding;
  /** The event that decided it — null only when nobody has ever answered. */
  readonly decidedBy: ConsentRecord | null;
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type ConsentErrorCode =
  | "actor_not_in_case"
  | "subject_not_in_case"
  /** A document naming somebody who has withdrawn tried to leave anyway. */
  | "named_rendition_revoked";

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;

  constructor(code: ConsentErrorCode, message: string) {
    super(message);
    this.name = "ConsentError";
    this.code = code;
  }
}

/**
 * The refusal both doors raise: export and share-token minting.
 *
 * It carries the whole state rather than a boolean, because the sentence the
 * person needs is not "blocked" — it is who withdrew, when, in whose words, and
 * which copies had already left and cannot be brought back. A caller that only
 * wants to know whether to stop reads `.code`; a caller with a screen to fill
 * reads `.consent`.
 */
export class NamedRenditionRevokedError extends ConsentError {
  readonly consent: NamedRenditionConsent;

  constructor(consent: NamedRenditionConsent) {
    super("named_rendition_revoked", describeRevocation(consent));
    this.name = "NamedRenditionRevokedError";
    this.consent = consent;
  }
}

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

export interface ConsentRecord {
  readonly id: string;
  readonly caseId: string;
  /** Null only if the participant row was removed; the pseudonym still names them. */
  readonly actorParticipantId: string | null;
  readonly actorPseudonym: string;
  readonly kind: ConsentKind;
  readonly scope: ConsentScope;
  /** Who it is about, when that is somebody other than the actor. */
  readonly subjectParticipantId: string | null;
  /** Their own words, verbatim. Never normalized, never translated. */
  readonly note: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

type ConsentRow = typeof consentEvents.$inferSelect;

/**
 * A row plus the order it was written in.
 *
 * `seq` is SQLite's `rowid` — monotonic per insert, never reused while the row
 * lives, and the only thing on this table that knows which of two events written
 * in the same millisecond came second. Read only where events are sorted; an
 * insert already knows its own row. See {@link byRecency}.
 */
type OrderedConsentRow = ConsentRow & { readonly seq: number };

function toRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    actorParticipantId: row.actorParticipantId,
    actorPseudonym: row.actorPseudonym,
    kind: row.kind,
    scope: row.scope,
    subjectParticipantId: row.subjectParticipantId,
    note: row.note,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

/**
 * Deterministic ordering: stored values only, so no reading depends on a clock.
 *
 * When the act happened, then when it was written, then which was written first.
 * The last component used to be the id, and that was wrong in a way only the
 * fold could show: ids here are random UUIDs, so two events sharing a
 * millisecond — a revocation and the re-grant that answers it, written by two
 * calls in a row — sorted in whichever order the random bytes fell, and the fold
 * could return the withdrawal as the last word after she had already taken it
 * back. `rowid` is insertion order, which is what "the latest event wins" has
 * always meant on an append-only table.
 */
function byRecency(a: OrderedConsentRow, b: OrderedConsentRow): number {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.seq - b.seq
  );
}

/* -------------------------------------------------------------------------- */
/* Writing (the only write there is)                                          */
/* -------------------------------------------------------------------------- */

export interface RecordConsentInput {
  readonly caseId: string;
  /** Whose consent this is. Their material, their say. */
  readonly actorParticipantId: string;
  readonly kind: ConsentKind;
  readonly scope: ConsentScope;
  /** Null (the default) means everyone the scope can mean. */
  readonly subjectParticipantId?: string | null;
  /** What they said about it, verbatim. */
  readonly note?: string | null;
  /** When the act happened, as distinct from when the row is written. */
  readonly occurredAt?: Date;
}

/**
 * Append one consent event.
 *
 * The only mutation this module has: there is no update path and no delete path,
 * because a consent history that can be edited is not a consent history. Both
 * participant ids are checked against the case, so an event cannot record an act
 * by somebody who is not a party to it.
 */
export function recordConsent(db: Db, input: RecordConsentInput): ConsentRecord {
  const actor = db
    .select({ id: caseParticipants.id, pseudonym: caseParticipants.pseudonym })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.id, input.actorParticipantId),
        eq(caseParticipants.caseId, input.caseId),
      ),
    )
    .get();
  if (actor === undefined) {
    throw new ConsentError(
      "actor_not_in_case",
      `Participant ${input.actorParticipantId} is not a party to case ` +
        `${input.caseId}, so there is no consent of theirs to record on it.`,
    );
  }

  const subjectId = input.subjectParticipantId ?? null;
  if (subjectId !== null) {
    const subject = db
      .select({ id: caseParticipants.id })
      .from(caseParticipants)
      .where(
        and(
          eq(caseParticipants.id, subjectId),
          eq(caseParticipants.caseId, input.caseId),
        ),
      )
      .get();
    if (subject === undefined) {
      throw new ConsentError(
        "subject_not_in_case",
        `Participant ${subjectId} is not a party to case ${input.caseId}, so ` +
          `consent cannot be granted or revoked with respect to them.`,
      );
    }
  }

  const [row] = db
    .insert(consentEvents)
    .values({
      caseId: input.caseId,
      actorParticipantId: actor.id,
      actorPseudonym: actor.pseudonym,
      kind: input.kind,
      scope: input.scope,
      subjectParticipantId: subjectId,
      note: input.note ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning()
    .all();

  return toRecord(row);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Every consent event on a case, oldest first. The audit, in full. */
export function listConsentEvents(db: Reader, caseId: string): ConsentRecord[] {
  return db
    .select({ ...getTableColumns(consentEvents), seq: sql<number>`rowid` })
    .from(consentEvents)
    .where(eq(consentEvents.caseId, caseId))
    .all()
    .sort(byRecency)
    .map(toRecord);
}

/** Every consent event by one actor, oldest first. */
export function listConsentEventsByActor(
  db: Reader,
  caseId: string,
  actorParticipantId: string,
): ConsentRecord[] {
  return listConsentEvents(db, caseId).filter(
    (event) => event.actorParticipantId === actorParticipantId,
  );
}

/**
 * The events that answer one question, oldest first.
 *
 * An event with no subject is about everyone the scope can mean, so it is read
 * alongside the subject-specific ones. That is what lets a blanket revocation
 * supersede a person-specific grant made before it.
 */
function eventsAnswering(
  events: readonly ConsentRecord[],
  actorParticipantId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null,
): ConsentRecord[] {
  return events.filter(
    (event) =>
      event.actorParticipantId === actorParticipantId &&
      event.scope === scope &&
      (event.subjectParticipantId === null ||
        event.subjectParticipantId === subjectParticipantId),
  );
}

/**
 * The fold: current state is the last word, and nothing else.
 *
 * The whole state model in one function, over events already in order. No event
 * is ever removed by it — a revocation is the newest entry in a history that
 * still contains every grant before it — which is what makes the log auditable
 * after the answer changes.
 */
export function foldConsent(events: readonly ConsentRecord[]): ConsentFold {
  const latest = events[events.length - 1];
  if (latest === undefined) return { standing: "unrecorded", decidedBy: null };
  return {
    standing: latest.kind === "granted" ? "granted" : "revoked",
    decidedBy: latest,
  };
}

/**
 * Where one actor's scope stands, optionally as it applies to one subject, and
 * the event that decided it.
 */
export function consentFoldFor(
  db: Reader,
  caseId: string,
  actorParticipantId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null = null,
): ConsentFold {
  return foldConsent(
    eventsAnswering(
      listConsentEvents(db, caseId),
      actorParticipantId,
      scope,
      subjectParticipantId,
    ),
  );
}

/**
 * Where one actor's scope stands, optionally as it applies to one subject.
 *
 * Events with no subject are read too, which is what makes a blanket revocation
 * actually revoke a person-specific grant that came before it.
 */
export function consentStandingFor(
  db: Reader,
  caseId: string,
  actorParticipantId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null = null,
): ConsentStanding {
  return consentFoldFor(
    db,
    caseId,
    actorParticipantId,
    scope,
    subjectParticipantId,
  ).standing;
}

/** True only when a grant stands. `unrecorded` is not consent. */
export function hasActiveConsent(
  db: Reader,
  caseId: string,
  actorParticipantId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null = null,
): boolean {
  return (
    consentStandingFor(
      db,
      caseId,
      actorParticipantId,
      scope,
      subjectParticipantId,
    ) === "granted"
  );
}

/**
 * True when the latest word on this scope is a revocation.
 *
 * The question an export gate asks, and deliberately not the negation of
 * `hasActiveConsent`: a scope nobody has ever been asked about is not a scope
 * somebody withdrew (see the module header).
 */
export function isConsentRevoked(
  db: Reader,
  caseId: string,
  actorParticipantId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null = null,
): boolean {
  return (
    consentStandingFor(
      db,
      caseId,
      actorParticipantId,
      scope,
      subjectParticipantId,
    ) === "revoked"
  );
}

/**
 * The actors whose grant for one scope currently stands.
 *
 * The query layer's input: these are the participants whose private material a
 * given audience may read (`access/visibility.ts`).
 */
export function actorsWithActiveConsent(
  db: Reader,
  caseId: string,
  scope: ConsentScope,
  subjectParticipantId: string | null = null,
): string[] {
  const events = listConsentEvents(db, caseId);
  const actors = new Set<string>();
  for (const event of events) {
    if (event.actorParticipantId !== null) actors.add(event.actorParticipantId);
  }

  return [...actors]
    .filter(
      (actorId) =>
        foldConsent(
          eventsAnswering(events, actorId, scope, subjectParticipantId),
        ).standing === "granted",
    )
    .sort();
}

/* -------------------------------------------------------------------------- */
/* named_rendition — the scope with teeth                                     */
/* -------------------------------------------------------------------------- */

/** Where one party stands on one scope, with the event that put them there. */
export interface PartyConsentStanding {
  /** Null only when the participant row is gone; the pseudonym still names them. */
  readonly participantId: string | null;
  readonly pseudonym: string;
  readonly isSubmitter: boolean;
  readonly standing: ConsentStanding;
  readonly decidedBy: ConsentRecord | null;
}

/**
 * A copy that left this machine.
 *
 * Read out of the export audit (`judgment_exports`), which is the only record
 * there is of an egress, and reported alongside a revocation so the person
 * withdrawing sees what withdrawing cannot reach.
 */
export interface ExportedCopy {
  readonly exportId: string;
  readonly judgmentId: string;
  readonly judgmentVersion: number;
  readonly kind: RenditionKind;
  readonly recipientPseudonym: string;
  readonly recipientParticipantId: string | null;
  readonly channel: ExportChannel;
  /** SHA-256 of the exact bytes handed over — enough to identify a copy found later. */
  readonly contentSha256: string;
  readonly exportedAt: Date;
  /** True when this copy left before the standing revocation was recorded. */
  readonly beforeRevocation: boolean;
  /**
   * Always false, and a literal rather than a boolean on purpose: there is no
   * recall path in this product and there is no way to write one, so no caller
   * may branch on it as though a `true` could ever arrive.
   */
  readonly recallable: false;
}

/** Where a case stands on documents that name its parties. */
export interface NamedRenditionConsent {
  readonly caseId: string;
  /** The recipient the question was asked about, when it was asked about one. */
  readonly recipientParticipantId: string | null;
  /** True when any party's latest word on this scope is a revocation. */
  readonly revoked: boolean;
  /** Every party of the case, including those nobody has asked. */
  readonly parties: readonly PartyConsentStanding[];
  /** The parties whose latest word is a revocation. Empty when `revoked` is false. */
  readonly revokedBy: readonly PartyConsentStanding[];
  /** When the door closed — the earliest standing revocation. */
  readonly revokedAt: Date | null;
  /**
   * Every copy of this case that has already left, newest first.
   * `beforeRevocation` marks the ones a revocation arrived too late for; all of
   * them are `recallable: false`.
   */
  readonly alreadyExported: readonly ExportedCopy[];
}

function toExportedCopy(
  row: typeof judgmentExports.$inferSelect,
  revokedAt: Date | null,
): ExportedCopy {
  return {
    exportId: row.id,
    judgmentId: row.judgmentId,
    judgmentVersion: row.judgmentVersion,
    kind: row.kind,
    recipientPseudonym: row.recipientPseudonym,
    recipientParticipantId: row.recipientParticipantId,
    channel: row.channel,
    contentSha256: row.contentSha256,
    exportedAt: row.exportedAt,
    beforeRevocation:
      revokedAt !== null && row.exportedAt.getTime() <= revokedAt.getTime(),
    recallable: false,
  };
}

/** One line naming a copy that cannot be brought back. */
function describeCopy(copy: ExportedCopy): string {
  return (
    `export ${copy.exportId.slice(0, 8)} — ${copy.kind} of judgment v` +
    `${copy.judgmentVersion} to ${copy.recipientPseudonym} via ${copy.channel} ` +
    `on ${copy.exportedAt.toISOString().slice(0, 10)}`
  );
}

/**
 * The refusal, in the words the person is owed.
 *
 * Names who withdrew and when, says the block is not permanent, and then says
 * the part a product would rather leave out: the copies that already left are
 * gone, and this stops the next one rather than the last one.
 */
function describeRevocation(consent: NamedRenditionConsent): string {
  const who = consent.revokedBy.map((party) => party.pseudonym).join(", ");
  const when =
    consent.revokedAt === null ? "" : ` (${consent.revokedAt.toISOString()})`;
  const notes = consent.revokedBy
    .map((party) => party.decidedBy?.note)
    .filter((note): note is string => note !== null && note !== undefined && note.trim() !== "");

  const gone = consent.alreadyExported.filter((copy) => copy.beforeRevocation);
  const irrecoverable =
    gone.length === 0
      ? `Nothing had been exported before it, so no copy of this case is out there.`
      : `${gone.length} cop${gone.length === 1 ? "y" : "ies"} left before the ` +
        `revocation and cannot be recalled — this product has no way to reach a ` +
        `file it already handed over, and will not pretend it has: ` +
        `${gone.map(describeCopy).join("; ")}. Revoking stops the next copy, ` +
        `not the last one.`;

  return (
    `${who} withdrew consent for a document naming them to leave this ` +
    `machine${when}. While that stands, no rendition of case ${consent.caseId} ` +
    `is exported and no share link for it is minted or opened. It is not a ` +
    `permanent state: a later grant is another event, and it reopens both. ` +
    `${irrecoverable}` +
    (notes.length === 0 ? "" : ` In their words: ${notes.map((note) => `“${note}”`).join(" ")}`)
  );
}

/**
 * Where the case stands on documents naming its parties.
 *
 * Asked with a recipient when the door knows one (the export gate does), and
 * without when it does not (a share token has no named recipient). A revocation
 * with no subject is about every recipient and bites either way; a revocation
 * naming one recipient closes that door and leaves the others as they were —
 * "not to him" and "to nobody" are different sentences and the log can hold both.
 */
export function namedRenditionConsent(
  db: Reader,
  caseId: string,
  recipientParticipantId: string | null = null,
): NamedRenditionConsent {
  const relevant = listConsentEvents(db, caseId).filter(
    (event) =>
      event.scope === "named_rendition" &&
      (event.subjectParticipantId === null ||
        event.subjectParticipantId === recipientParticipantId),
  );

  // Keyed by participant where there is one, by pseudonym where the row is gone:
  // a withdrawal does not stop counting because the participant row was removed.
  const ORPHAN = "pseudonym:";
  const byActor = new Map<string, ConsentRecord[]>();
  for (const event of relevant) {
    const key = event.actorParticipantId ?? `${ORPHAN}${event.actorPseudonym}`;
    const group = byActor.get(key);
    if (group === undefined) byActor.set(key, [event]);
    else group.push(event);
  }

  const parties: PartyConsentStanding[] = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .map((party) => ({
      participantId: party.id,
      pseudonym: party.pseudonym,
      isSubmitter: party.isSubmitter,
      ...foldConsent(byActor.get(party.id) ?? []),
    }));

  for (const [key, group] of byActor) {
    if (!key.startsWith(ORPHAN)) continue;
    parties.push({
      participantId: null,
      pseudonym: group[0].actorPseudonym,
      isSubmitter: false,
      ...foldConsent(group),
    });
  }

  parties.sort((a, b) => (a.pseudonym < b.pseudonym ? -1 : a.pseudonym > b.pseudonym ? 1 : 0));

  const revokedBy = parties.filter((party) => party.standing === "revoked");
  const revokedTimes = revokedBy
    .map((party) => party.decidedBy?.occurredAt.getTime())
    .filter((time): time is number => time !== undefined);
  const revokedAt =
    revokedTimes.length === 0 ? null : new Date(Math.min(...revokedTimes));

  const alreadyExported = db
    .select()
    .from(judgmentExports)
    .where(eq(judgmentExports.caseId, caseId))
    .all()
    .sort((a, b) => b.exportedAt.getTime() - a.exportedAt.getTime())
    .map((row) => toExportedCopy(row, revokedAt));

  return {
    caseId,
    recipientParticipantId,
    revoked: revokedBy.length > 0,
    parties,
    revokedBy,
    revokedAt,
    alreadyExported,
  };
}

/** What a door passes when it asks whether this document may leave. */
export interface NamedRenditionContext {
  readonly db: Reader;
  readonly caseId: string;
  /** Who the copy is for, when the door knows. Blanket revocations bite anyway. */
  readonly recipientParticipantId?: string | null;
}

/**
 * The one definition of "may a document naming this person leave".
 *
 * Both doors call it — the export gate and the share-token guard — and each
 * translates the refusal into its own error type rather than restating the rule.
 * `unrecorded` passes: M4 shipped an export path that never asked anybody, and
 * disabling it the moment this table existed would be a policy change disguised
 * as plumbing (module header). Only a standing revocation blocks.
 */
export function assertNamedRenditionAllowed(
  context: NamedRenditionContext,
): void {
  const consent = namedRenditionConsent(
    context.db,
    context.caseId,
    context.recipientParticipantId ?? null,
  );
  if (consent.revoked) throw new NamedRenditionRevokedError(consent);
}

/* -------------------------------------------------------------------------- */
/* Granting and withdrawing the named-rendition scope                         */
/* -------------------------------------------------------------------------- */

export interface NamedRenditionActInput {
  readonly caseId: string;
  /** The person the document names. Their name, their say. */
  readonly actorParticipantId: string;
  /** One recipient, when the decision is about one. Null means everybody. */
  readonly subjectParticipantId?: string | null;
  /** Their own words, verbatim. Never normalized, never translated. */
  readonly note?: string | null;
  readonly occurredAt?: Date;
}

export interface NamedRenditionChange {
  /** The event just appended. Nothing was edited to make room for it. */
  readonly event: ConsentRecord;
  /** Where the case stands now, including what already left. */
  readonly state: NamedRenditionConsent;
}

/**
 * Withdraw consent for documents naming this party.
 *
 * Appends one event and reads the case back, so the caller is handed the two
 * things this act produces: the door is now shut, and here is the list of copies
 * that went out before it shut. The second half is the reason this is a function
 * rather than a bare `recordConsent` call — a revocation whose already-exported
 * copies are never surfaced is a revocation the person will misread as a recall.
 */
export function revokeNamedRendition(
  db: Db,
  input: NamedRenditionActInput,
): NamedRenditionChange {
  const event = recordConsent(db, {
    caseId: input.caseId,
    actorParticipantId: input.actorParticipantId,
    kind: "revoked",
    scope: "named_rendition",
    subjectParticipantId: input.subjectParticipantId ?? null,
    note: input.note ?? null,
    occurredAt: input.occurredAt,
  });

  return {
    event,
    state: namedRenditionConsent(
      db,
      input.caseId,
      input.subjectParticipantId ?? null,
    ),
  };
}

/**
 * Grant it, or grant it again after a withdrawal.
 *
 * Re-granting is a first-class act, not an undo: it appends a third event on top
 * of the grant and the revocation, both of which stay readable. The log tells the
 * whole story — she agreed, she stopped agreeing, she agreed again — and a reader
 * of the record can see all three, which is the difference between a history and
 * a flag that happens to be true right now.
 */
export function grantNamedRendition(
  db: Db,
  input: NamedRenditionActInput,
): NamedRenditionChange {
  const event = recordConsent(db, {
    caseId: input.caseId,
    actorParticipantId: input.actorParticipantId,
    kind: "granted",
    scope: "named_rendition",
    subjectParticipantId: input.subjectParticipantId ?? null,
    note: input.note ?? null,
    occurredAt: input.occurredAt,
  });

  return {
    event,
    state: namedRenditionConsent(
      db,
      input.caseId,
      input.subjectParticipantId ?? null,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The case view's read                                                       */
/* -------------------------------------------------------------------------- */

/** Every scope, for one party, as it stands. */
export interface PartyConsentSummary {
  readonly participantId: string;
  readonly pseudonym: string;
  readonly isSubmitter: boolean;
  readonly standings: Readonly<Record<ConsentScope, ConsentStanding>>;
  /** Their most recent event on any scope, or null if they have never acted. */
  readonly latest: ConsentRecord | null;
}

/**
 * What the case view needs in order to say "revoked" — and to say the rest of it
 * honestly.
 */
export interface CaseConsentState {
  readonly caseId: string;
  /** The whole log, oldest first. Revocation supersedes; it never deletes. */
  readonly events: readonly ConsentRecord[];
  readonly parties: readonly PartyConsentSummary[];
  readonly namedRendition: NamedRenditionConsent;
  /** The two doors, named separately so the UI does not have to know they are one question. */
  readonly exportBlocked: boolean;
  readonly shareTokensBlocked: boolean;
  /** Copies that are out there regardless of any of the above. */
  readonly unrecallableCopies: readonly ExportedCopy[];
  /** One English sentence a screen can print as it is. Quoted notes stay verbatim. */
  readonly summary: string;
}

/**
 * Read the consent state of a case, for a screen.
 *
 * A read, and only a read: it appends nothing, and it hands back the events as
 * well as the fold so a transparency view can show the history rather than the
 * conclusion. The UI belongs to somebody else; this is the data it needs.
 */
export function readCaseConsentState(
  db: Reader,
  caseId: string,
): CaseConsentState {
  const events = listConsentEvents(db, caseId);
  const namedRendition = namedRenditionConsent(db, caseId);

  const parties: PartyConsentSummary[] = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .map((party) => {
      const mine = events.filter(
        (event) => event.actorParticipantId === party.id,
      );
      return {
        participantId: party.id,
        pseudonym: party.pseudonym,
        isSubmitter: party.isSubmitter,
        // Blanket standings — the answer to "where does this party stand on the
        // case", which is the question a case view is asking. A decision made
        // about one named recipient is narrower than that and is read by asking
        // `consentStandingFor` with that recipient; folding it in here would let
        // "not to him" render as "not to anyone".
        standings: {
          case_record: foldConsent(
            eventsAnswering(mine, party.id, "case_record", null),
          ).standing,
          counterparty_read: foldConsent(
            eventsAnswering(mine, party.id, "counterparty_read", null),
          ).standing,
          named_rendition: foldConsent(
            eventsAnswering(mine, party.id, "named_rendition", null),
          ).standing,
        },
        latest: mine[mine.length - 1] ?? null,
      };
    });

  return {
    caseId,
    events,
    parties,
    namedRendition,
    exportBlocked: namedRendition.revoked,
    shareTokensBlocked: namedRendition.revoked,
    unrecallableCopies: namedRendition.alreadyExported,
    summary: summarize(events, namedRendition),
  };
}

/** The sentence a case view opens with. */
function summarize(
  events: readonly ConsentRecord[],
  namedRendition: NamedRenditionConsent,
): string {
  // A revocation already accounts for the copies that escaped it, in more
  // detail than this line could; saying it twice reads as two different facts.
  if (namedRendition.revoked) return describeRevocation(namedRendition);

  const copies = namedRendition.alreadyExported.length;
  const outThere =
    copies === 0
      ? "No copy of this case has left the machine."
      : `${copies} cop${copies === 1 ? "y has" : "ies have"} already left the ` +
        `machine and cannot be recalled.`;

  if (events.length === 0) {
    return (
      `No consent event has been recorded on this case. Nobody has been asked, ` +
      `which is not the same as anybody saying no. ${outThere}`
    );
  }

  const granted = namedRendition.parties.filter(
    (party) => party.standing === "granted",
  );
  if (granted.length > 0) {
    return (
      `${granted.map((party) => party.pseudonym).join(", ")} consented to a ` +
      `document naming them being shared, and has not withdrawn it. Export and ` +
      `share links are open. ${outThere}`
    );
  }

  return (
    `${events.length} consent event${events.length === 1 ? "" : "s"} on record, ` +
    `none of them about documents naming a party — that question has not been ` +
    `asked, so export and share links are open by the M4 policy this product ` +
    `shipped with. ${outThere}`
  );
}
