/**
 * Deletion rights, asymmetric on purpose (SPEC M5 ④).
 *
 * Two acts, and the difference between them is the honest part:
 *
 *   - **Material she submitted** — `deleteOwnMaterial`. Unilateral. The row is
 *     removed, the bytes behind an orphaned upload are removed with it, and an
 *     audit row is written in the same transaction. No approval, no queue, no
 *     "we will review your request".
 *
 *   - **Material about her that the other party submitted** —
 *     `requestMaterialDeletion`. A recorded request, surfaced to him, and
 *     **nothing is deleted**. The system does not erase one person's records
 *     because the other person asked, and it must not imply anywhere that it
 *     does: the return value says `deleted: false`, the copy says so in a
 *     sentence, and `refused` is a legitimate terminal state of the request.
 *
 * The third right — whether anything naming her may leave this machine at all —
 * is consent, and it lives in `./consent.ts`. It is not reimplemented here;
 * `deletionRightsFor` reports where it stands by calling that module, so there
 * is exactly one place that decides what consent means.
 *
 * ## Why the audit is a separate table
 *
 * `deletion_requests` is the asking, and its status moves while an answer is
 * pending. `deletion_audit` is the record of acts: append-only in the database
 * (BEFORE UPDATE trigger, migration 0012), written inside the same transaction
 * as the act it records, and holding a one-line label for the target — one that
 * identifies it without reproducing it, so the log stays legible after the
 * material is gone without becoming a copy of it. Its `target_id` is
 * deliberately not a foreign key — a reference that cascaded away with the row
 * would delete the audit along with the thing it audits.
 *
 * ## What deletion does not do
 *
 * It does not rewrite a frozen judgment (HARD RULE #6). A judgment that cited a
 * line she later deleted keeps its text, because a frozen judgment is never
 * edited; what changes is what the *next* hearing may stand on. `deleteOwnMaterial`
 * reports the frozen judgments that cited the row (`citedByFrozenJudgments`) so
 * the screen can say that to her before she decides, rather than after.
 */

import { unlinkSync } from "node:fs";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  caseParticipants,
  deletionAudit,
  deletionRequests,
  evidence as evidenceTable,
  eventEvidence,
  events as eventsTable,
  files as filesTable,
  judgments,
  utterances as utterancesTable,
  type DeletionAct,
  type DeletionRequestStatus,
  type DeletionTargetKind,
} from "../db/schema";
import { blobPath } from "../evidence/blob-store";
import type { Reader } from "../pipeline/stage-machine";
import { consentStandingFor, type ConsentStanding } from "./consent";

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type DeletionErrorCode =
  /** The actor is not a party to this case. */
  | "actor_not_in_case"
  /** No row of that kind with that id on this case. */
  | "target_not_found"
  /** She tried to delete material she does not own. Ask instead. */
  | "not_your_material"
  /** She asked for deletion of her own material. Delete it instead. */
  | "target_is_yours"
  /** No such request, or it belongs to another case. */
  | "request_not_found"
  /** The request has already been answered; an answer is not revised. */
  | "request_not_open"
  /** Only the owner of the material answers a request about it. */
  | "not_yours_to_answer";

export class DeletionError extends Error {
  readonly code: DeletionErrorCode;

  constructor(code: DeletionErrorCode, message: string) {
    super(message);
    this.name = "DeletionError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

export interface DeletionAuditRecord {
  readonly id: string;
  readonly caseId: string;
  readonly actorParticipantId: string | null;
  readonly actorPseudonym: string;
  readonly act: DeletionAct;
  readonly targetKind: DeletionTargetKind;
  readonly targetId: string;
  readonly targetSummary: string | null;
  readonly targetOwnerParticipantId: string | null;
  readonly targetOwnerPseudonym: string | null;
  readonly requestId: string | null;
  readonly note: string | null;
  readonly occurredAt: Date;
}

export interface DeletionRequestRecord {
  readonly id: string;
  readonly caseId: string;
  readonly requesterParticipantId: string | null;
  readonly requesterPseudonym: string;
  readonly targetKind: DeletionTargetKind;
  readonly targetId: string;
  readonly targetSummary: string | null;
  readonly reason: string | null;
  readonly status: DeletionRequestStatus;
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedByParticipantId: string | null;
  readonly createdAt: Date;
  /**
   * Always false on the way out of `requestMaterialDeletion`. The field exists
   * so no caller has to infer it, and so a screen cannot accidentally render
   * "deleted" for an act that deleted nothing.
   */
  readonly deleted: boolean;
}

export interface DeletionOutcome {
  readonly deleted: true;
  readonly targetKind: DeletionTargetKind;
  readonly targetId: string;
  readonly audit: DeletionAuditRecord;
  /** Rows that pointed at the deleted one and no longer do. */
  readonly alsoAffected: Readonly<Record<string, number>>;
  /** True when the stored bytes were removed because nothing else referenced them. */
  readonly blobRemoved: boolean;
  /**
   * Frozen judgment versions that cited this material. They are NOT rewritten
   * (HARD RULE #6); this is what the screen tells her before she deletes.
   */
  readonly citedByFrozenJudgments: readonly number[];
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

interface ResolvedTarget {
  readonly kind: DeletionTargetKind;
  readonly id: string;
  readonly caseId: string;
  readonly ownerParticipantId: string | null;
  /**
   * A label that identifies the row without reproducing what is in it. See
   * `describe*` below for why this is not the verbatim line.
   */
  readonly summary: string;
  /** Content hash, for the four-way file case only. */
  readonly sha256: string | null;
}

/*
 * ## Why the audit does not quote the material
 *
 * The obvious design writes the deleted line into `target_summary` so the log
 * stays legible. That design does not delete anything: it moves the sentence
 * from one table to another and calls the move a deletion, and the first person
 * to read the audit finds exactly what she asked to have removed.
 *
 * So every summary below **identifies, and never reproduces**: what kind of row
 * it was, whose it was, when, how big — enough to answer "what did she delete
 * and when", and not enough to recover the content. The same labels go on the
 * request, because a request that is later granted would otherwise be the copy
 * that outlives the material. The person answering a request does not need the
 * quote in the request: he owns the row, it is still there while he decides,
 * and it is named by id.
 *
 * This is the one place where "keep the record legible" and "deletion is real"
 * genuinely conflict, and deletion wins.
 */

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * Find one deletable row and describe it.
 *
 * Returns null rather than throwing, so both callers can raise the failure that
 * fits what they were asked to do.
 */
function resolveTarget(
  db: Reader,
  caseId: string,
  kind: DeletionTargetKind,
  targetId: string,
): ResolvedTarget | null {
  switch (kind) {
    case "file": {
      const row = db
        .select()
        .from(filesTable)
        .where(and(eq(filesTable.id, targetId), eq(filesTable.caseId, caseId)))
        .get();
      return row === undefined
        ? null
        : {
            kind,
            id: row.id,
            caseId: row.caseId,
            ownerParticipantId: row.ownerParticipantId,
            // Not the filename: a filename is content too ("和知夏的聊天记录.png").
            summary:
              `${row.kind} upload, ${row.mimeType ?? "unknown type"}, ` +
              `${row.byteSize ?? "unknown"} bytes, content hash ` +
              `${row.sha256.slice(0, 12)}…`,
            sha256: row.sha256,
          };
    }
    case "evidence": {
      const row = db
        .select()
        .from(evidenceTable)
        .where(
          and(eq(evidenceTable.id, targetId), eq(evidenceTable.caseId, caseId)),
        )
        .get();
      return row === undefined
        ? null
        : {
            kind,
            id: row.id,
            caseId: row.caseId,
            ownerParticipantId: row.ownerParticipantId,
            // `content_summary` is a description of the content, so it is
            // content. Grade and source type are facts about the row.
            summary:
              `${row.sourceType} material, grade ` +
              `${row.gradeFinal ?? "unconfirmed"}, id ${shortId(row.id)}`,
            sha256: null,
          };
    }
    case "utterance": {
      const row = db
        .select()
        .from(utterancesTable)
        .where(
          and(
            eq(utterancesTable.id, targetId),
            eq(utterancesTable.caseId, caseId),
          ),
        )
        .get();
      return row === undefined
        ? null
        : {
            kind,
            id: row.id,
            caseId: row.caseId,
            ownerParticipantId: row.ownerParticipantId,
            summary:
              `line attributed to ${row.speakerLabel ?? "nobody in particular"}, ` +
              `${(row.humanFinal ?? row.aiDraft ?? "").length} characters, ` +
              `${row.confirmStatus}, id ${shortId(row.id)}`,
            sha256: null,
          };
    }
    case "event": {
      const row = db
        .select()
        .from(eventsTable)
        .where(and(eq(eventsTable.id, targetId), eq(eventsTable.caseId, caseId)))
        .get();
      return row === undefined
        ? null
        : {
            kind,
            id: row.id,
            caseId: row.caseId,
            ownerParticipantId: row.ownerParticipantId,
            // The label is the case's own external handle (E1…E11), not text
            // somebody wrote about what happened; the title and description are.
            summary:
              `timeline entry ${row.label ?? shortId(row.id)}, ` +
              `${row.occurredAt === null ? "undated" : `dated ${row.occurredAt.toISOString().slice(0, 10)}`}` +
              `, ${row.confirmStatus}`,
            sha256: null,
          };
    }
  }
}

function requireParty(
  db: Reader,
  caseId: string,
  participantId: string,
): { readonly id: string; readonly pseudonym: string } {
  const row = db
    .select({ id: caseParticipants.id, pseudonym: caseParticipants.pseudonym })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.id, participantId),
        eq(caseParticipants.caseId, caseId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new DeletionError(
      "actor_not_in_case",
      `Participant ${participantId} is not a party to case ${caseId}, so there ` +
        `is no act of theirs to record on it.`,
    );
  }
  return row;
}

function pseudonymOf(db: Reader, participantId: string | null): string | null {
  if (participantId === null) return null;
  const row = db
    .select({ pseudonym: caseParticipants.pseudonym })
    .from(caseParticipants)
    .where(eq(caseParticipants.id, participantId))
    .get();
  return row?.pseudonym ?? null;
}

/* -------------------------------------------------------------------------- */
/* The audit write                                                            */
/* -------------------------------------------------------------------------- */

interface AuditInput {
  readonly caseId: string;
  readonly actorParticipantId: string;
  readonly actorPseudonym: string;
  readonly act: DeletionAct;
  readonly target: ResolvedTarget;
  readonly targetOwnerPseudonym: string | null;
  readonly requestId?: string | null;
  readonly note?: string | null;
  readonly occurredAt: Date;
}

/**
 * Write one audit row. Called inside the transaction that performs the act, so
 * an act that happened cannot be an act that went unlogged.
 */
function writeAudit(db: Db, input: AuditInput): DeletionAuditRecord {
  const [row] = db
    .insert(deletionAudit)
    .values({
      caseId: input.caseId,
      actorParticipantId: input.actorParticipantId,
      actorPseudonym: input.actorPseudonym,
      act: input.act,
      targetKind: input.target.kind,
      targetId: input.target.id,
      targetSummary: input.target.summary,
      targetOwnerParticipantId: input.target.ownerParticipantId,
      targetOwnerPseudonym: input.targetOwnerPseudonym,
      requestId: input.requestId ?? null,
      note: input.note ?? null,
      occurredAt: input.occurredAt,
    })
    .returning()
    .all();

  return {
    id: row.id,
    caseId: row.caseId,
    actorParticipantId: row.actorParticipantId,
    actorPseudonym: row.actorPseudonym,
    act: row.act,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetSummary: row.targetSummary,
    targetOwnerParticipantId: row.targetOwnerParticipantId,
    targetOwnerPseudonym: row.targetOwnerPseudonym,
    requestId: row.requestId,
    note: row.note,
    occurredAt: row.occurredAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Deleting your own material                                                 */
/* -------------------------------------------------------------------------- */

export interface DeleteOwnMaterialInput {
  readonly caseId: string;
  readonly actorParticipantId: string;
  readonly targetKind: DeletionTargetKind;
  readonly targetId: string;
  /** Her own words about why, verbatim. Optional — a right does not need a reason. */
  readonly reason?: string | null;
  readonly occurredAt?: Date;
}

/**
 * Delete one row of your own material. Unilateral, immediate, audited.
 *
 * Ownership is checked against the row, not against the caller's claim about
 * it: `not_your_material` is what a party gets for pointing this at the other
 * one's evidence, and the message names `requestMaterialDeletion` rather than
 * leaving them to guess that asking is the available act.
 */
export function deleteOwnMaterial(
  db: Db,
  input: DeleteOwnMaterialInput,
): DeletionOutcome {
  const actor = requireParty(db, input.caseId, input.actorParticipantId);
  const target = resolveTarget(
    db,
    input.caseId,
    input.targetKind,
    input.targetId,
  );

  if (target === null) {
    throw new DeletionError(
      "target_not_found",
      `No ${input.targetKind} with id ${input.targetId} on case ${input.caseId}.`,
    );
  }
  if (target.ownerParticipantId !== actor.id) {
    throw new DeletionError(
      "not_your_material",
      `The ${input.targetKind} ${input.targetId} was not submitted by ` +
        `${actor.pseudonym}. This system does not delete one party's records ` +
        `because the other party asked; use requestMaterialDeletion, which ` +
        `records the request and shows it to the person whose record it is.`,
    );
  }

  const now = input.occurredAt ?? new Date();
  const citedByFrozenJudgments = frozenJudgmentsCiting(db, input.caseId, target);

  const { audit, alsoAffected } = db.transaction((tx) => {
    const handle = tx as unknown as Db;
    const affected = removeRow(handle, target);
    const record = writeAudit(handle, {
      caseId: input.caseId,
      actorParticipantId: actor.id,
      actorPseudonym: actor.pseudonym,
      act: "deleted",
      target,
      targetOwnerPseudonym: actor.pseudonym,
      note: input.reason ?? null,
      occurredAt: now,
    });
    return { audit: record, alsoAffected: affected };
  });

  // After the commit, never before: bytes must not go for a transaction that
  // rolled back. Best effort — a blob that is already gone is not a failure.
  const blobRemoved = target.sha256 === null ? false : purgeBlob(db, target.sha256);

  return {
    deleted: true,
    targetKind: target.kind,
    targetId: target.id,
    audit,
    alsoAffected,
    blobRemoved,
    citedByFrozenJudgments,
  };
}

/**
 * Delete the row, and report what else stopped pointing at it.
 *
 * The foreign keys do the pointing: `evidence.file_id`, `utterances.evidence_id`
 * and `adverse_facts.evidence_id` are ON DELETE SET NULL, and `event_evidence`
 * cascades. Nothing here deletes a second person's row, and deleting a file does
 * not delete the evidence built from it — that evidence may be somebody else's
 * work, and orphaning it is the honest outcome.
 */
function removeRow(db: Db, target: ResolvedTarget): Record<string, number> {
  switch (target.kind) {
    case "file": {
      const unlinked = db
        .select({ id: evidenceTable.id })
        .from(evidenceTable)
        .where(eq(evidenceTable.fileId, target.id))
        .all().length;
      db.delete(filesTable).where(eq(filesTable.id, target.id)).run();
      return { evidenceRowsLeftWithoutTheirFile: unlinked };
    }
    case "evidence": {
      const lines = db
        .select({ id: utterancesTable.id })
        .from(utterancesTable)
        .where(eq(utterancesTable.evidenceId, target.id))
        .all().length;
      const links = db
        .select({ evidenceId: eventEvidence.evidenceId })
        .from(eventEvidence)
        .where(eq(eventEvidence.evidenceId, target.id))
        .all().length;
      db.delete(evidenceTable).where(eq(evidenceTable.id, target.id)).run();
      return {
        utterancesLeftWithoutTheirSource: lines,
        eventLinksRemoved: links,
      };
    }
    case "utterance": {
      db.delete(utterancesTable).where(eq(utterancesTable.id, target.id)).run();
      return {};
    }
    case "event": {
      const links = db
        .select({ eventId: eventEvidence.eventId })
        .from(eventEvidence)
        .where(eq(eventEvidence.eventId, target.id))
        .all().length;
      db.delete(eventsTable).where(eq(eventsTable.id, target.id)).run();
      return { eventLinksRemoved: links };
    }
  }
}

/**
 * Remove the stored bytes when no `files` row anywhere still references them.
 *
 * The store is content-addressed, so two rows can share one blob; deleting the
 * bytes while another row points at them would break somebody else's evidence.
 * "Actually removed" has to mean the bytes too, though — a row deleted while
 * `/api/blob/<sha>` keeps serving the picture is not a deletion.
 */
function purgeBlob(db: Reader, sha256: string): boolean {
  const stillReferenced = db
    .select({ id: filesTable.id })
    .from(filesTable)
    .where(eq(filesTable.sha256, sha256))
    .all();
  if (stillReferenced.length > 0) return false;

  const path = blobPath(sha256);
  if (path === null) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Frozen judgment versions whose fact layer cited this row.
 *
 * Read-only, and it stays read-only: HARD RULE #6 puts a frozen judgment beyond
 * editing, so the answer to "this line is cited" is to tell her, not to rewrite
 * the judgment. A re-hearing is what produces a version that no longer stands
 * on it.
 */
function frozenJudgmentsCiting(
  db: Reader,
  caseId: string,
  target: ResolvedTarget,
): number[] {
  if (target.kind !== "utterance") return [];
  return db
    .select({
      version: judgments.version,
      status: judgments.status,
      content: judgments.content,
    })
    .from(judgments)
    .where(eq(judgments.caseId, caseId))
    .all()
    .filter(
      (row) =>
        row.status === "final" &&
        JSON.stringify(row.content ?? {}).includes(target.id),
    )
    .map((row) => row.version)
    .sort((a, b) => a - b);
}

/* -------------------------------------------------------------------------- */
/* Asking about somebody else's material                                      */
/* -------------------------------------------------------------------------- */

export interface RequestDeletionInput {
  readonly caseId: string;
  readonly requesterParticipantId: string;
  readonly targetKind: DeletionTargetKind;
  readonly targetId: string;
  /** Why she wants it gone, in her own words. Verbatim, never normalized. */
  readonly reason?: string | null;
  readonly occurredAt?: Date;
}

/**
 * Record a request to delete material somebody else submitted. Deletes nothing.
 *
 * The two writes are one transaction: the request (which is what the other party
 * is shown) and the audit row (which is the record that the asking happened).
 * `deleted: false` comes back on the record itself, so a caller cannot render
 * this as an erasure by accident.
 */
export function requestMaterialDeletion(
  db: Db,
  input: RequestDeletionInput,
): DeletionRequestRecord {
  const actor = requireParty(db, input.caseId, input.requesterParticipantId);
  const target = resolveTarget(
    db,
    input.caseId,
    input.targetKind,
    input.targetId,
  );

  if (target === null) {
    throw new DeletionError(
      "target_not_found",
      `No ${input.targetKind} with id ${input.targetId} on case ${input.caseId}.`,
    );
  }
  if (target.ownerParticipantId === actor.id) {
    throw new DeletionError(
      "target_is_yours",
      `The ${input.targetKind} ${input.targetId} is yours. There is nobody to ` +
        `ask: use deleteOwnMaterial, which removes it.`,
    );
  }

  const now = input.occurredAt ?? new Date();
  const ownerPseudonym = pseudonymOf(db, target.ownerParticipantId);

  return db.transaction((tx) => {
    const handle = tx as unknown as Db;
    const [row] = handle
      .insert(deletionRequests)
      .values({
        caseId: input.caseId,
        requesterParticipantId: actor.id,
        requesterPseudonym: actor.pseudonym,
        targetKind: target.kind,
        targetId: target.id,
        targetSummary: target.summary,
        reason: input.reason ?? null,
        status: "open",
      })
      .returning()
      .all();

    writeAudit(handle, {
      caseId: input.caseId,
      actorParticipantId: actor.id,
      actorPseudonym: actor.pseudonym,
      act: "requested",
      target,
      targetOwnerPseudonym: ownerPseudonym,
      requestId: row.id,
      note: input.reason ?? null,
      occurredAt: now,
    });

    return toRequestRecord(row);
  });
}

function toRequestRecord(
  row: typeof deletionRequests.$inferSelect,
): DeletionRequestRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    requesterParticipantId: row.requesterParticipantId,
    requesterPseudonym: row.requesterPseudonym,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetSummary: row.targetSummary,
    reason: row.reason,
    status: row.status,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    resolvedByParticipantId: row.resolvedByParticipantId,
    createdAt: row.createdAt,
    deleted: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Answering a request                                                        */
/* -------------------------------------------------------------------------- */

export interface ResolveDeletionRequestInput {
  readonly caseId: string;
  readonly requestId: string;
  /** The owner of the material. Only they can answer. */
  readonly actorParticipantId: string;
  readonly decision: "granted" | "refused";
  /** Their answer in their own words. Verbatim, including a refusal. */
  readonly note?: string | null;
  readonly occurredAt?: Date;
}

export interface ResolveDeletionRequestOutcome {
  readonly request: DeletionRequestRecord;
  /** True only when the owner granted it and the row is actually gone. */
  readonly deleted: boolean;
  readonly audit: DeletionAuditRecord;
}

/**
 * The other party's answer to a request — and it is genuinely his to give.
 *
 * `refused` is a first-class outcome: the product promised her a recorded
 * request, not an erasure, and a resolution path that could only ever end in
 * `granted` would have been the promise it refused to make. Either way the
 * request row stays, so "I asked and was told no" remains on the record.
 */
export function resolveDeletionRequest(
  db: Db,
  input: ResolveDeletionRequestInput,
): ResolveDeletionRequestOutcome {
  const actor = requireParty(db, input.caseId, input.actorParticipantId);

  const request = db
    .select()
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.id, input.requestId),
        eq(deletionRequests.caseId, input.caseId),
      ),
    )
    .get();
  if (request === undefined) {
    throw new DeletionError(
      "request_not_found",
      `No deletion request ${input.requestId} on case ${input.caseId}.`,
    );
  }
  if (request.status !== "open") {
    throw new DeletionError(
      "request_not_open",
      `Deletion request ${input.requestId} was already answered ` +
        `(${request.status}). An answer is superseded by a new request, never ` +
        `edited.`,
    );
  }

  const target = resolveTarget(
    db,
    input.caseId,
    request.targetKind,
    request.targetId,
  );
  if (target === null) {
    throw new DeletionError(
      "target_not_found",
      `The ${request.targetKind} this request names is no longer on case ` +
        `${input.caseId}.`,
    );
  }
  if (target.ownerParticipantId !== actor.id) {
    throw new DeletionError(
      "not_yours_to_answer",
      `The ${request.targetKind} ${request.targetId} was not submitted by ` +
        `${actor.pseudonym}, so answering for it is not theirs to do.`,
    );
  }

  const now = input.occurredAt ?? new Date();

  const outcome = db.transaction((tx) => {
    const handle = tx as unknown as Db;
    if (input.decision === "granted") removeRow(handle, target);

    const [updated] = handle
      .update(deletionRequests)
      .set({
        status: input.decision,
        resolutionNote: input.note ?? null,
        resolvedAt: now,
        resolvedByParticipantId: actor.id,
      })
      .where(eq(deletionRequests.id, request.id))
      .returning()
      .all();

    const audit = writeAudit(handle, {
      caseId: input.caseId,
      actorParticipantId: actor.id,
      actorPseudonym: actor.pseudonym,
      act: input.decision,
      target,
      targetOwnerPseudonym: actor.pseudonym,
      requestId: request.id,
      note: input.note ?? null,
      occurredAt: now,
    });

    return {
      request: {
        ...toRequestRecord(updated),
        deleted: input.decision === "granted",
      },
      deleted: input.decision === "granted",
      audit,
    };
  });

  if (outcome.deleted && target.sha256 !== null) purgeBlob(db, target.sha256);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface ListDeletionRequestOptions {
  /** Only requests in this state. Default: all of them. */
  readonly status?: DeletionRequestStatus;
  /** Only requests about material this participant submitted — his inbox. */
  readonly aboutMaterialOwnedBy?: string;
  /** Only requests this participant made — her outbox. */
  readonly requestedBy?: string;
}

/**
 * Deletion requests on one case, oldest first.
 *
 * This is how a request is "surfaced to the client": his screen lists the ones
 * about material he submitted. The owner filter is applied by resolving each
 * target, because the owning column lives on the material and not on the
 * request — and when the target is gone (he granted it) the audit row is what
 * still remembers whose it was, so a granted request does not fall out of the
 * history the moment it succeeds.
 */
export function listDeletionRequests(
  db: Reader,
  caseId: string,
  options: ListDeletionRequestOptions = {},
): DeletionRequestRecord[] {
  return db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.caseId, caseId))
    .all()
    .filter((row) => options.status === undefined || row.status === options.status)
    .filter(
      (row) =>
        options.requestedBy === undefined ||
        row.requesterParticipantId === options.requestedBy,
    )
    .filter((row) => {
      if (options.aboutMaterialOwnedBy === undefined) return true;
      const target = resolveTarget(db, caseId, row.targetKind, row.targetId);
      const owner =
        target === null
          ? rememberedOwnerOf(db, caseId, row.targetKind, row.targetId)
          : target.ownerParticipantId;
      return owner === options.aboutMaterialOwnedBy;
    })
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(toRequestRecord);
}

/**
 * Who owned a row that no longer exists, according to the audit.
 *
 * The one thing that outlives deleted material is the log of its deletion, and
 * it carries the owner on purpose. Without this, filtering the request history
 * by owner would silently drop every request that was granted — the successful
 * ones — which is the opposite of what a history is for.
 */
function rememberedOwnerOf(
  db: Reader,
  caseId: string,
  targetKind: DeletionTargetKind,
  targetId: string,
): string | null {
  const row = db
    .select({ owner: deletionAudit.targetOwnerParticipantId })
    .from(deletionAudit)
    .where(
      and(
        eq(deletionAudit.caseId, caseId),
        eq(deletionAudit.targetKind, targetKind),
        eq(deletionAudit.targetId, targetId),
      ),
    )
    .get();
  return row?.owner ?? null;
}

/** Every audited act on one case, oldest first. Optionally one actor's. */
export function listDeletionAudit(
  db: Reader,
  caseId: string,
  actorParticipantId?: string,
): DeletionAuditRecord[] {
  return db
    .select()
    .from(deletionAudit)
    .where(
      actorParticipantId === undefined
        ? eq(deletionAudit.caseId, caseId)
        : and(
            eq(deletionAudit.caseId, caseId),
            eq(deletionAudit.actorParticipantId, actorParticipantId),
          ),
    )
    .all()
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((row) => ({
      id: row.id,
      caseId: row.caseId,
      actorParticipantId: row.actorParticipantId,
      actorPseudonym: row.actorPseudonym,
      act: row.act,
      targetKind: row.targetKind,
      targetId: row.targetId,
      targetSummary: row.targetSummary,
      targetOwnerParticipantId: row.targetOwnerParticipantId,
      targetOwnerPseudonym: row.targetOwnerPseudonym,
      requestId: row.requestId,
      note: row.note,
      occurredAt: row.occurredAt,
    }));
}

/* -------------------------------------------------------------------------- */
/* What she controls, in one answer                                           */
/* -------------------------------------------------------------------------- */

export interface DeletionRights {
  /** Rows she submitted and may remove outright, by kind. */
  readonly ownMaterial: Readonly<Record<DeletionTargetKind, number>>;
  /** Requests she has open against the other party's material. */
  readonly openRequests: number;
  /**
   * Where the consent scopes stand — read from `./consent.ts`, never decided
   * here. Revoking `named_rendition` is the one thing she controls outright:
   * it blocks export and every share link for a document naming her.
   */
  readonly consent: Readonly<Record<
    "case_record" | "counterparty_read" | "named_rendition",
    ConsentStanding
  >>;
  /** The sentence the product must not soften. */
  readonly statement: string;
}

/**
 * Everything one party may do about their own record, in one read.
 *
 * The consent half is delegated: `consentStandingFor` owns what a grant means,
 * and duplicating that judgement here is exactly how two screens end up
 * disagreeing about whether somebody said yes.
 */
export function deletionRightsFor(
  db: Reader,
  caseId: string,
  participantId: string,
): DeletionRights {
  const countOwned = (kind: DeletionTargetKind): number => {
    switch (kind) {
      case "file":
        return db
          .select({ id: filesTable.id })
          .from(filesTable)
          .where(
            and(
              eq(filesTable.caseId, caseId),
              eq(filesTable.ownerParticipantId, participantId),
            ),
          )
          .all().length;
      case "evidence":
        return db
          .select({ id: evidenceTable.id })
          .from(evidenceTable)
          .where(
            and(
              eq(evidenceTable.caseId, caseId),
              eq(evidenceTable.ownerParticipantId, participantId),
            ),
          )
          .all().length;
      case "utterance":
        return db
          .select({ id: utterancesTable.id })
          .from(utterancesTable)
          .where(
            and(
              eq(utterancesTable.caseId, caseId),
              eq(utterancesTable.ownerParticipantId, participantId),
            ),
          )
          .all().length;
      case "event":
        return db
          .select({ id: eventsTable.id })
          .from(eventsTable)
          .where(
            and(
              eq(eventsTable.caseId, caseId),
              eq(eventsTable.ownerParticipantId, participantId),
            ),
          )
          .all().length;
    }
  };

  return {
    ownMaterial: {
      file: countOwned("file"),
      evidence: countOwned("evidence"),
      utterance: countOwned("utterance"),
      event: countOwned("event"),
    },
    openRequests: listDeletionRequests(db, caseId, {
      status: "open",
      requestedBy: participantId,
    }).length,
    consent: {
      case_record: consentStandingFor(db, caseId, participantId, "case_record"),
      counterparty_read: consentStandingFor(
        db,
        caseId,
        participantId,
        "counterparty_read",
      ),
      named_rendition: consentStandingFor(
        db,
        caseId,
        participantId,
        "named_rendition",
      ),
    },
    statement:
      "What you submitted, you can delete. What the other party submitted is " +
      "not yours to erase and this system will not do it for you — you can ask, " +
      "the request is recorded and shown to him, and his answer, including a " +
      "refusal, is recorded too. Whether any document naming you may leave this " +
      "machine is yours alone: withdraw that consent and every export and share " +
      "link for such a document stops working.",
  };
}
