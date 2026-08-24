/**
 * The case list's read side.
 *
 * Five columns and no sixth. What a list of conflicts must not do is rank them:
 * no progress bars, no "3 of 9 stages", no counts of anything a person could
 * read as a score. Doc 04 §7 rules out dashboards, and a case list is the
 * easiest place in the product to build one by accident — every column that
 * looks like completeness invites the reading that a fuller case is a stronger
 * one, which is exactly backwards for a record whose gaps are its findings.
 *
 * `isFixture` is carried because the label it drives is product content, not a
 * debug flag: a demonstration case must announce that every person in it is
 * invented, on every surface that names it (schema comment on `cases.is_fixture`).
 */

import { desc } from "drizzle-orm";

import type { Db } from "../db";
import {
  cases,
  type CaseStage,
  type CaseStatus,
  type OutputLevel,
} from "../db/schema";

export interface CaseListItem {
  readonly id: string;
  /** Null on a case filed before titles were asked for. */
  readonly title: string | null;
  readonly stage: CaseStage;
  /** Null until code locks a level onto the case (HARD RULE #2). */
  readonly outputLevel: OutputLevel | null;
  readonly outputLevelLockedAt: Date | null;
  readonly status: CaseStatus;
  readonly createdAt: Date;
  /** True on authored demonstration cases; every person in them is invented. */
  readonly isFixture: boolean;
}

/**
 * Every case on this machine, newest first.
 *
 * No audience filter: this database is one person's, and the visibility model
 * governs material inside a case rather than the existence of the case itself.
 * When multi-user login lands, this is the function that grows a viewer
 * argument — noted here so it is a decision rather than an omission.
 */
export function listCases(db: Db): CaseListItem[] {
  return db
    .select({
      id: cases.id,
      title: cases.title,
      stage: cases.stage,
      outputLevel: cases.outputLevel,
      outputLevelLockedAt: cases.outputLevelLockedAt,
      status: cases.status,
      createdAt: cases.createdAt,
      isFixture: cases.isFixture,
    })
    .from(cases)
    .orderBy(desc(cases.createdAt))
    .all();
}
