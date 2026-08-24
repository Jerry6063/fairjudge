/**
 * Read side of evidence management: what the `/evidence` list and the blob
 * route need, and nothing more.
 *
 * The confirmation counts here are pure progress reporting — "3 of 12 lines
 * confirmed". They are NOT the gate: whatever reads utterances for a model call does
 * its own `confirm_status IN ('confirmed','edited')` filtering at the query
 * level (HARD RULE #1). Counting is safe precisely because it never returns
 * text.
 */

import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  CASE_RECORD,
  isVisible,
  resolveMaterialGrant,
  visibleMaterial,
  type MaterialAudience,
  type MaterialGrant,
} from "../access/visibility";
import type { Db } from "../db";
import {
  cases,
  evidence as evidenceTable,
  files as filesTable,
  utterances as utterancesTable,
  type EvidenceGrade,
  type EvidenceSourceType,
} from "../db/schema";
import type { EvidenceAnomaly } from "../domain/grading";

/** Confirmation states that count as "the human has dealt with this line". */
const SETTLED_STATUSES = ["confirmed", "edited"] as const;

export interface EvidenceListItem {
  id: string;
  /** Human-confirmed grade, or null while only a suggestion exists. */
  gradeFinal: EvidenceGrade | null;
  gradeSuggested: EvidenceGrade | null;
  gradeConfirmedAt: Date | null;
  gradeRationale: string | null;
  anomaly: EvidenceAnomaly | null;
  sourceType: EvidenceSourceType;
  contentSummary: string | null;
  createdAt: Date;
  /** Null when the evidence has no stored image (seed rows may not). */
  fileId: string | null;
  originalFilename: string | null;
  hasImage: boolean;
  /** Utterances transcribed from this item. */
  utteranceTotal: number;
  /** Of those, how many the reviewer has confirmed or edited. */
  utteranceSettled: number;
}

/**
 * The single case this milestone works with.
 *
 * fairjudge is single-user and single-case until multi-case UI lands (M2
 * explicitly does not do it), so the pages resolve "the case" rather than
 * routing by id. Newest wins if a second one ever appears, which is the least
 * surprising answer for a UI that cannot yet switch between them.
 */
export function resolveDefaultCaseId(db: Db): string | null {
  const [row] = db
    .select({ id: cases.id })
    .from(cases)
    .orderBy(sql`${cases.createdAt} DESC`)
    .limit(1)
    .all();
  return row?.id ?? null;
}

/**
 * Evidence for one case, newest first, with per-item confirmation progress —
 * scoped to what the audience may read (SPEC M5 ①).
 */
export function listEvidence(
  db: Db,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): EvidenceListItem[] {
  const grant = resolveMaterialGrant(db, caseId, audience);
  const rows = db
    .select({
      id: evidenceTable.id,
      gradeFinal: evidenceTable.gradeFinal,
      gradeSuggested: evidenceTable.gradeSuggested,
      gradeConfirmedAt: evidenceTable.gradeConfirmedAt,
      gradeRationale: evidenceTable.gradeRationale,
      anomaly: evidenceTable.gradeAnomaly,
      sourceType: evidenceTable.sourceType,
      contentSummary: evidenceTable.contentSummary,
      createdAt: evidenceTable.createdAt,
      fileId: evidenceTable.fileId,
      originalFilename: filesTable.originalFilename,
      storagePath: filesTable.storagePath,
    })
    .from(evidenceTable)
    .leftJoin(filesTable, eq(evidenceTable.fileId, filesTable.id))
    .where(
      and(
        eq(evidenceTable.caseId, caseId),
        visibleMaterial(evidenceTable, grant),
      ),
    )
    .orderBy(sql`${evidenceTable.createdAt} DESC`)
    .all();

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const totals = countUtterances(db, ids, false, grant);
  const settled = countUtterances(db, ids, true, grant);

  return rows.map((row) => ({
    id: row.id,
    gradeFinal: row.gradeFinal,
    gradeSuggested: row.gradeSuggested,
    gradeConfirmedAt: row.gradeConfirmedAt,
    gradeRationale: row.gradeRationale,
    anomaly: (row.anomaly as EvidenceAnomaly | null) ?? null,
    sourceType: row.sourceType,
    contentSummary: row.contentSummary,
    createdAt: row.createdAt,
    fileId: row.fileId,
    originalFilename: row.originalFilename,
    hasImage: row.storagePath !== null && row.storagePath !== "",
    utteranceTotal: totals.get(row.id) ?? 0,
    utteranceSettled: settled.get(row.id) ?? 0,
  }));
}

/**
 * Utterances per evidence id, optionally restricted to settled ones — and only
 * ever the ones this audience may read. A count returns no text, but "she has
 * nine lines here you cannot see" is still something about her material.
 */
function countUtterances(
  db: Db,
  evidenceIds: readonly string[],
  onlySettled: boolean,
  grant: MaterialGrant,
): Map<string, number> {
  const scope = and(
    inArray(utterancesTable.evidenceId, [...evidenceIds]),
    visibleMaterial(utterancesTable, grant),
  );
  const rows = db
    .select({ evidenceId: utterancesTable.evidenceId, n: count() })
    .from(utterancesTable)
    .where(
      onlySettled
        ? and(scope, inArray(utterancesTable.confirmStatus, [...SETTLED_STATUSES]))
        : scope,
    )
    .groupBy(utterancesTable.evidenceId)
    .all();

  return new Map(
    rows.flatMap((row) => (row.evidenceId ? [[row.evidenceId, row.n] as const] : [])),
  );
}

export interface EvidenceImage {
  /** Path as recorded on the file row; resolve with `resolveStoragePath`. */
  storagePath: string;
  mimeType: string;
  originalFilename: string | null;
}

/**
 * Locate the stored image behind one evidence id.
 *
 * The path comes from the database, never from the request — the caller only
 * supplies an id — so there is no traversal surface here. The audience filter is
 * the other half: an id is guessable in a way a path is not, and a screenshot
 * out of somebody else's private material is the single worst thing this route
 * could serve.
 */
export function findEvidenceImage(
  db: Db,
  evidenceId: string,
  audience: MaterialAudience = CASE_RECORD,
): EvidenceImage | null {
  const owner = db
    .select({
      caseId: evidenceTable.caseId,
      ownerParticipantId: evidenceTable.ownerParticipantId,
      visibility: evidenceTable.visibility,
    })
    .from(evidenceTable)
    .where(eq(evidenceTable.id, evidenceId))
    .get();
  if (owner === undefined) return null;
  if (!isVisible(owner, resolveMaterialGrant(db, owner.caseId, audience))) {
    return null;
  }

  const [row] = db
    .select({
      storagePath: filesTable.storagePath,
      mimeType: filesTable.mimeType,
      originalFilename: filesTable.originalFilename,
    })
    .from(evidenceTable)
    .innerJoin(filesTable, eq(evidenceTable.fileId, filesTable.id))
    .where(and(eq(evidenceTable.id, evidenceId), isNotNull(filesTable.storagePath)))
    .all();

  if (!row?.storagePath) return null;
  return {
    storagePath: row.storagePath,
    mimeType: row.mimeType ?? "application/octet-stream",
    originalFilename: row.originalFilename,
  };
}

/** Case-level counters for the page header. */
export interface EvidenceSummary {
  total: number;
  gradeConfirmed: number;
  utteranceTotal: number;
  utteranceSettled: number;
}

export function summarizeEvidence(
  items: readonly EvidenceListItem[],
): EvidenceSummary {
  return {
    total: items.length,
    gradeConfirmed: items.filter((item) => item.gradeFinal !== null).length,
    utteranceTotal: items.reduce((sum, item) => sum + item.utteranceTotal, 0),
    utteranceSettled: items.reduce((sum, item) => sum + item.utteranceSettled, 0),
  };
}
