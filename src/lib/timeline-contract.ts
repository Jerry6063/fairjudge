// Shared shapes for the /timeline page: the card the server renders, the input
// its server action accepts, and the date formatting both sides agree on.
//
// The page (a client component) imports this module, so nothing here may pull
// in `src/server/`. The only import is type-only and erased at compile time.

import type { OccurredPrecision } from "../server/db/schema";

export type { OccurredPrecision };

/** The two drop targets on the page. */
export const TIMELINE_CONTAINERS = ["mainline", "pending"] as const;
export type TimelineContainer = (typeof TIMELINE_CONTAINERS)[number];

/** One event, already flattened and formatted for rendering. */
export interface TimelineEventCard {
  id: string;
  /** External label from the referenced-events table (E1..E11), if any. */
  label: string | null;
  /** Event title; falls back to a placeholder when the source had none. */
  title: string;
  /** One-line summary (the seed's event summary), if any. */
  summary: string | null;
  precision: OccurredPrecision;
  /** Pre-formatted date text — see `formatOccurred`. */
  dateLabel: string;
  orderKey: string;
  /** True when the event sits on the mainline rather than the holding area. */
  inMainline: boolean;
  /**
   * Whether the event carries its own date anchor. Anchored events belong on
   * the mainline by their dating and cannot be dragged back to the holding
   * area; the server rejects it too.
   */
  anchored: boolean;
}

/** Badge caption per precision (UI copy). */
export const PRECISION_LABELS: Record<OccurredPrecision, string> = {
  exact: "Exact time",
  day: "To the day",
  month: "To the month",
  range: "Date range",
  unknown: "Date undecided",
};

/**
 * A move request: place `eventId` into `target`, between the two neighbours the
 * user dropped it between. Neighbour IDs rather than an index, because the
 * server re-reads the list and only needs to know what the row landed between —
 * an index computed against a stale client list would silently land elsewhere.
 * Both null means the target list is empty (or an explicit insert at the top).
 */
export interface MoveEventInput {
  eventId: string;
  target: TimelineContainer;
  beforeId: string | null;
  afterId: string | null;
}

/** Server action result. `error` is user-facing copy, safe to render. */
export type MoveEventResult =
  | { ok: true; event: { id: string; orderKey: string; inMainline: boolean } }
  | { ok: false; error: string };

/** Epoch-ms fields of an event, as stored. */
export interface OccurredInput {
  precision: OccurredPrecision;
  occurredAt: number | null;
  occurredStart: number | null;
  occurredEnd: number | null;
}

/**
 * Format an event's date for display.
 *
 * Deliberately UTC and hand-rolled: the seed writes UTC-midnight dates
 * (`Date.UTC(2026, 6, 13)`), and rendering those through a local-timezone or
 * `Intl` formatter would shift days depending on where the process runs. A
 * fixed calendar rendering keeps the label equal to the date that was recorded.
 */
export function formatOccurred(input: OccurredInput): string {
  const { precision, occurredAt, occurredStart, occurredEnd } = input;

  switch (precision) {
    case "exact":
      return occurredAt === null ? PRECISION_LABELS.unknown : minute(occurredAt);
    case "day":
      return occurredAt === null ? PRECISION_LABELS.unknown : day(occurredAt);
    case "month":
      return occurredAt === null ? PRECISION_LABELS.unknown : month(occurredAt);
    case "range": {
      const from = occurredStart === null ? null : day(occurredStart);
      const to = occurredEnd === null ? null : day(occurredEnd);
      if (from !== null && to !== null) return from === to ? from : `${from} ~ ${to}`;
      if (from !== null) return `from ${from}`;
      if (to !== null) return `until ${to}`;
      return PRECISION_LABELS.unknown;
    }
    case "unknown":
      return PRECISION_LABELS.unknown;
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function day(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function month(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function minute(epochMs: number): string {
  const d = new Date(epochMs);
  return `${day(epochMs)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
