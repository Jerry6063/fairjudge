/**
 * Counting confirmation progress over a set of `confirm_status` values.
 *
 * Pure and dependency-free (the only import is a type, which compiles away), so
 * the server page and the client workbench can compute the same numbers from
 * the same code instead of drifting apart. Reused by any M3 screen that
 * confirms a list — the steelman versions and the three issue lists.
 */

import type { ConfirmStatus } from "../server/db/schema";

export interface ConfirmProgress {
  readonly total: number;
  readonly pending: number;
  readonly confirmed: number;
  readonly edited: number;
  readonly rejected: number;
  /** At least one row, and nothing left pending — the list is dealt with. */
  readonly settled: boolean;
}

export function summarizeConfirmProgress(
  statuses: readonly ConfirmStatus[],
): ConfirmProgress {
  const count = (status: ConfirmStatus): number =>
    statuses.filter((value) => value === status).length;

  const pending = count("pending");
  return {
    total: statuses.length,
    pending,
    confirmed: count("confirmed"),
    edited: count("edited"),
    rejected: count("rejected"),
    settled: statuses.length > 0 && pending === 0,
  };
}
