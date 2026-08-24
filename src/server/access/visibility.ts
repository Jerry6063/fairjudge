/**
 * The visibility model (SPEC M5 ①) — enforced in the query layer, because there
 * is nowhere else it can be enforced.
 *
 * Every row a party submits carries an owner and a visibility state, and the
 * default is `private`. This module turns "who is reading" into a SQL predicate
 * that the existing read paths — `listCitableUtterances`, `buildCitableBrief`,
 * `assembleCaseFile`, `computeRecordAsymmetry`, the evidence lists — put in
 * their WHERE clause. That placement is the whole guarantee: a prompt cannot
 * widen what a SELECT did not return, and no caller can forget a filter that is
 * inside the function they are already calling.
 *
 * ## Two audiences
 *
 *   - **`CASE_RECORD`** — the case as a document: what a judgment may be made
 *     from, what the dossier assembles, what the numbers describe. Not a person.
 *   - **a participant** — one human reading through the product. What the
 *     transparency view shows her, and the audience that must not be able to
 *     reach across.
 *
 * ## What each may read
 *
 * Both may read anything at `visibility = 'case'`: that state means the owner
 * put it into the case, which is the explicit grant, recorded alongside as a
 * consent event.
 *
 * Beyond that they differ, and the asymmetry is the product's, not an accident:
 *
 *   - The **submitter's** private material is in the case record. Submitting a
 *     case *is* putting your material into it — that is what filing means — so
 *     `private` on his rows means "not shared with the other party", not
 *     "withheld from the case he brought". This is also what keeps the real
 *     seeded case assembling exactly as it did before M5.
 *   - A **non-submitter's** private material is not in the case record until she
 *     grants `case_record`. She did not bring this case; her material arriving on
 *     the machine is not her agreeing to be judged on it.
 *   - A participant reads her own material, plus whatever another owner has
 *     granted `counterparty_read` for. Never anything else.
 *
 * ## Rows with no owner
 *
 * NULL is the pre-M5 record: material from when there was one party and nothing
 * to protect. Migration 0011 backfills it to the case's submitter wherever a
 * submitter is on file; what remains belongs to the case rather than to a
 * person, so the case record reads it and a participant audience does not —
 * except the submitter, whose case it is. Treating unowned rows as readable by
 * everyone would turn a forgotten `owner` on a write path into a silent leak,
 * which is exactly the failure the default-private column exists to prevent.
 *
 * ## A stranger reads nothing
 *
 * An audience naming a participant who is not a party to the case resolves to a
 * grant that matches no row at all — not even `visibility = 'case'`. Sharing
 * into a case shares with the case's parties.
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { caseParticipants, type VisibilityState } from "../db/schema";
import type { Reader } from "../pipeline/stage-machine";
import { actorsWithActiveConsent } from "./consent";

/* -------------------------------------------------------------------------- */
/* Audiences                                                                  */
/* -------------------------------------------------------------------------- */

export type MaterialAudience =
  | { readonly kind: "case_record" }
  | { readonly kind: "participant"; readonly participantId: string };

/**
 * The case as a document. The default audience of every read path that existed
 * before M5, so adding the parameter changed no behaviour anywhere.
 */
export const CASE_RECORD: MaterialAudience = { kind: "case_record" };

/** One human, reading through the product. */
export function asParticipant(participantId: string): MaterialAudience {
  return { kind: "participant", participantId };
}

/** Whether an audience is one person rather than the case itself. */
export function isParticipantAudience(
  audience: MaterialAudience,
): audience is { kind: "participant"; participantId: string } {
  return audience.kind === "participant";
}

/** One line naming the audience, for an error or an audit note. */
export function describeAudience(audience: MaterialAudience): string {
  return audience.kind === "case_record"
    ? "the case record"
    : `participant ${audience.participantId}`;
}

/* -------------------------------------------------------------------------- */
/* The resolved grant                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What one audience may read on one case, resolved once and then applied to
 * every table. Computing it per query would run the consent read once per table
 * and — worse — let two tables disagree inside a single assembly.
 */
export interface MaterialGrant {
  readonly caseId: string;
  readonly audience: MaterialAudience;
  /** Owners whose PRIVATE material this audience may read. Sorted, de-duplicated. */
  readonly ownerIds: readonly string[];
  /** Whether rows with no owner are readable. */
  readonly includeUnowned: boolean;
  /**
   * True when the audience is not a party to this case. Such a grant matches
   * nothing at all, `visibility = 'case'` included.
   */
  readonly stranger: boolean;
}

/** The visibility state that means "the owner put this into the case". */
export const SHARED_VISIBILITY: VisibilityState = "case";

/** Resolve what an audience may read on one case. */
export function resolveMaterialGrant(
  db: Reader,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): MaterialGrant {
  const parties = db
    .select({
      id: caseParticipants.id,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const submitterId = parties.find((party) => party.isSubmitter)?.id ?? null;

  if (audience.kind === "case_record") {
    const owners = new Set<string>(actorsWithActiveConsent(db, caseId, "case_record"));
    if (submitterId !== null) owners.add(submitterId);
    return {
      caseId,
      audience,
      ownerIds: [...owners].sort(),
      includeUnowned: true,
      stranger: false,
    };
  }

  const viewer = parties.find((party) => party.id === audience.participantId);
  if (viewer === undefined) {
    return {
      caseId,
      audience,
      ownerIds: [],
      includeUnowned: false,
      stranger: true,
    };
  }

  const owners = new Set<string>(
    actorsWithActiveConsent(db, caseId, "counterparty_read", viewer.id),
  );
  // Always your own material, whatever anybody has or has not consented to.
  owners.add(viewer.id);

  return {
    caseId,
    audience,
    ownerIds: [...owners].sort(),
    includeUnowned: viewer.isSubmitter,
    stranger: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The predicate                                                              */
/* -------------------------------------------------------------------------- */

/** The two columns `ownership()` puts on every material table. */
export interface OwnedTable {
  readonly ownerParticipantId: AnySQLiteColumn;
  readonly visibility: AnySQLiteColumn;
}

/** A row as the JS-side check needs to see it. */
export interface OwnedRow {
  readonly ownerParticipantId: string | null;
  readonly visibility: VisibilityState;
}

/** Matches no row. Used rather than omitting the clause: a missing predicate reads everything. */
const MATCH_NOTHING = sql`0 = 1`;

/**
 * The WHERE fragment for one table and one grant.
 *
 * Always returns a predicate — never `undefined`. A helper that can return
 * nothing is a helper that silently disables itself the moment a grant is empty,
 * and the failure would be invisible: the query still runs, and returns more
 * than it should.
 */
export function visibleMaterial(table: OwnedTable, grant: MaterialGrant): SQL {
  if (grant.stranger) return MATCH_NOTHING;

  const clauses: SQL[] = [eq(table.visibility, SHARED_VISIBILITY)];
  if (grant.ownerIds.length > 0) {
    clauses.push(inArray(table.ownerParticipantId, [...grant.ownerIds]));
  }
  if (grant.includeUnowned) {
    clauses.push(isNull(table.ownerParticipantId));
  }

  // `or` of a non-empty list is always defined; the fallback is for the type,
  // and it fails closed rather than open.
  return or(...clauses) ?? MATCH_NOTHING;
}

/**
 * The same rule, on a row already in hand.
 *
 * Used where a query cannot express it — checking one model-emitted citation
 * against the record (`checkEvidenceRefs`). It must stay the same rule, so it is
 * written once here rather than twice in two layers.
 */
export function isVisible(row: OwnedRow, grant: MaterialGrant): boolean {
  if (grant.stranger) return false;
  if (row.visibility === SHARED_VISIBILITY) return true;
  if (row.ownerParticipantId === null) return grant.includeUnowned;
  return grant.ownerIds.includes(row.ownerParticipantId);
}

/**
 * Scope a query to one case AND one audience.
 *
 * The convenience the read paths actually use: passing the case filter and the
 * visibility filter separately is how one of them eventually goes missing.
 */
export function scopedToCase(
  table: OwnedTable & { readonly caseId: AnySQLiteColumn },
  grant: MaterialGrant,
): SQL {
  return (
    and(eq(table.caseId, grant.caseId), visibleMaterial(table, grant)) ??
    /* c8 ignore next -- `and` of two defined clauses is always defined. */
    MATCH_NOTHING
  );
}
