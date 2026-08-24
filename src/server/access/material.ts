/**
 * Putting your material into the case, and taking it back out (SPEC M5 ①③).
 *
 * The visibility state on a row and the consent event about it are two halves of
 * one act, and they are written together here so they cannot drift. A row that
 * says `case` with no consent event behind it is a claim nobody made; a consent
 * event with the rows still `private` is a promise the query layer does not
 * keep. Every caller that shares or withdraws material goes through these two
 * functions, in one transaction each.
 *
 * Withdrawal is real, and it is not deletion. The rows go back to `private` and
 * a `revoked` event is appended — so the material stays hers, the history stays
 * readable, and the next assembly of the case simply does not contain it. What
 * was already frozen into a judgment is not rewritten (HARD RULE #6); taking
 * material back changes what the *next* hearing may stand on, which is the
 * honest scope of the promise.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../db";
import {
  caseParticipants,
  evidence,
  events,
  files,
  utterances,
  type VisibilityState,
} from "../db/schema";
import { recordConsent, type ConsentRecord } from "./consent";
import { SHARED_VISIBILITY } from "./visibility";

/** The four tables a party can own rows in. */
const MATERIAL_TABLES = [files, evidence, utterances, events] as const;

export interface MaterialShareInput {
  readonly caseId: string;
  /** Whose material moves. Only their own rows are touched. */
  readonly ownerParticipantId: string;
  /** Their own words about the decision, verbatim. */
  readonly note?: string | null;
  readonly occurredAt?: Date;
}

export interface MaterialShareResult {
  readonly consent: ConsentRecord;
  /** How many rows moved, per table. Zero everywhere is a legitimate result. */
  readonly moved: Readonly<Record<"files" | "evidence" | "utterances" | "events", number>>;
}

function moveOwnedRows(
  tx: Db,
  caseId: string,
  ownerId: string,
  from: VisibilityState,
  to: VisibilityState,
): MaterialShareResult["moved"] {
  const counts = { files: 0, evidence: 0, utterances: 0, events: 0 };
  const names = ["files", "evidence", "utterances", "events"] as const;

  MATERIAL_TABLES.forEach((table, index) => {
    const rows = tx
      .update(table)
      .set({ visibility: to })
      .where(
        and(
          eq(table.caseId, caseId),
          eq(table.ownerParticipantId, ownerId),
          eq(table.visibility, from),
        ),
      )
      .returning({ id: table.id })
      .all();
    counts[names[index]] = rows.length;
  });

  return counts;
}

function requireParty(db: Db, caseId: string, participantId: string): void {
  const row = db
    .select({ id: caseParticipants.id })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.id, participantId),
        eq(caseParticipants.caseId, caseId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new Error(
      `Participant ${participantId} is not a party to case ${caseId}.`,
    );
  }
}

/**
 * Put one party's material into the case record: rows to `case`, and a
 * `granted case_record` event recording who decided that and when.
 */
export function shareMaterialIntoCase(
  db: Db,
  input: MaterialShareInput,
): MaterialShareResult {
  requireParty(db, input.caseId, input.ownerParticipantId);

  return db.transaction((tx) => {
    const moved = moveOwnedRows(
      tx as unknown as Db,
      input.caseId,
      input.ownerParticipantId,
      "private",
      SHARED_VISIBILITY,
    );
    const consent = recordConsent(tx as unknown as Db, {
      caseId: input.caseId,
      actorParticipantId: input.ownerParticipantId,
      kind: "granted",
      scope: "case_record",
      note: input.note ?? null,
      occurredAt: input.occurredAt,
    });
    return { consent, moved };
  });
}

/**
 * Take one party's material back out: rows to `private`, and a
 * `revoked case_record` event. The material is not deleted and the history is
 * not rewritten — the next assembly of the case simply will not contain it.
 */
export function withdrawMaterialFromCase(
  db: Db,
  input: MaterialShareInput,
): MaterialShareResult {
  requireParty(db, input.caseId, input.ownerParticipantId);

  return db.transaction((tx) => {
    const moved = moveOwnedRows(
      tx as unknown as Db,
      input.caseId,
      input.ownerParticipantId,
      SHARED_VISIBILITY,
      "private",
    );
    const consent = recordConsent(tx as unknown as Db, {
      caseId: input.caseId,
      actorParticipantId: input.ownerParticipantId,
      kind: "revoked",
      scope: "case_record",
      note: input.note ?? null,
      occurredAt: input.occurredAt,
    });
    return { consent, moved };
  });
}
