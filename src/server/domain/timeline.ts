/**
 * Timeline reconstruction (pipeline stage ④, timeline).
 *
 * Two lists, one table. An event shows up on the mainline when it can be
 * placed in time — either it carries a date anchor (`occurred_precision !=
 * 'unknown'`) or the user has dragged it in (`in_timeline`) — and otherwise
 * waits in the undated holding area. Ordering inside a list is carried by
 * `order_key` alone, so the user's drag is the final authority on sequence
 * (02-engineering-architecture.md: the user's drag has the final say on order),
 * and one move writes
 * exactly one row.
 *
 * Everything here takes an explicit `Db`, so the unit tests drive the same code
 * path the server action does.
 */

import { and, eq } from "drizzle-orm";

import {
  CASE_RECORD,
  resolveMaterialGrant,
  visibleMaterial,
  type MaterialAudience,
} from "../access/visibility";
import type { Db } from "../db";
import {
  caseParticipants,
  cases,
  eventEvidence,
  events,
  evidence,
  type OccurredPrecision,
} from "../db/schema";
import {
  formatOccurred,
  type MoveEventInput,
  type TimelineContainer,
  type TimelineEventCard,
} from "../../lib/timeline-contract";
import { compareOrderKeys, orderKeyForIndex } from "./order-key";

/** Row shape as selected from `events`. */
type EventRow = typeof events.$inferSelect;

/** Failure modes a caller may want to distinguish (the action maps these to copy). */
export type TimelineErrorCode =
  | "event_not_found"
  | "anchored_event"
  | "stale_order";

export class TimelineError extends Error {
  readonly code: TimelineErrorCode;

  constructor(code: TimelineErrorCode, message: string) {
    super(message);
    this.name = "TimelineError";
    this.code = code;
  }
}

/**
 * Why an event could not be written.
 *
 * A separate vocabulary from `TimelineErrorCode`, and a separate class, because
 * they answer for separate acts: `TimelineError` is what a *drag* can fail with,
 * and `/timeline`'s server action maps its three codes to copy exhaustively.
 * Creating an event fails in ways a drag cannot (there is no case, there is no
 * title, the material named is somebody else's), and folding those into the move
 * vocabulary would hand that action four codes it has no sentence for.
 */
export type TimelineWriteErrorCode =
  | "case_not_found"
  | "empty_event"
  | "event_not_found"
  | "unknown_evidence";

export class TimelineWriteError extends Error {
  readonly code: TimelineWriteErrorCode;

  constructor(code: TimelineWriteErrorCode, message: string) {
    super(message);
    this.name = "TimelineWriteError";
    this.code = code;
  }
}

/** What the page renders. `caseId` is null when the database has no case yet. */
export interface TimelineSnapshot {
  caseId: string | null;
  caseTitle: string | null;
  mainline: TimelineEventCard[];
  pending: TimelineEventCard[];
}

/** Result of a successful move, for the client to reconcile against. */
export interface MoveEventOutcome {
  id: string;
  orderKey: string;
  inMainline: boolean;
}

/** An event belongs on the mainline if it is dated, or was dragged there. */
export function isMainlineEvent(row: EventRow): boolean {
  return row.occurredPrecision !== "unknown" || row.inTimeline;
}

/** Which list a row currently lives in. */
function containerOf(row: EventRow): TimelineContainer {
  return isMainlineEvent(row) ? "mainline" : "pending";
}

/**
 * Sort by `order_key`, breaking ties on `id`.
 *
 * Keys are unique within a list in practice (every generated key falls strictly
 * between two neighbours), but the mainline and the holding area share one key
 * space, so a row moving across can arrive holding a key that some row in the
 * other list also has. The `id` tiebreak keeps the rendered order stable and
 * total regardless.
 */
function sortRows(rows: EventRow[]): EventRow[] {
  return [...rows].sort(
    (a, b) => compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Flatten a row into the serializable card the client renders. */
function toCard(row: EventRow): TimelineEventCard {
  const anchored = row.occurredPrecision !== "unknown";
  return {
    id: row.id,
    label: row.label,
    title: row.title?.trim() || "Untitled event",
    summary: row.description?.trim() || null,
    precision: row.occurredPrecision,
    dateLabel: formatOccurred({
      precision: row.occurredPrecision,
      occurredAt: row.occurredAt?.getTime() ?? null,
      occurredStart: row.occurredStart?.getTime() ?? null,
      occurredEnd: row.occurredEnd?.getTime() ?? null,
    }),
    orderKey: row.orderKey,
    inMainline: isMainlineEvent(row),
    anchored,
  };
}

/**
 * The case the timeline is about. M2 is single-case, so "the case" is the
 * oldest one; an explicit id still wins for when multi-case lands.
 */
export function resolveTimelineCase(
  db: Db,
  caseId?: string,
): { id: string; title: string | null } | null {
  if (caseId !== undefined) {
    const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
    return row ? { id: row.id, title: row.title } : null;
  }
  const rows = db.select().from(cases).all();
  if (rows.length === 0) return null;
  const oldest = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  )[0];
  return { id: oldest.id, title: oldest.title };
}

/**
 * Read both lists for one case, each sorted by `order_key` — and only the events
 * this audience may read (SPEC M5 ①).
 *
 * The filter is here rather than on the screen for the reason every other read
 * path has it in its WHERE clause: an event card carries a title and a summary
 * of something that happened between two people, and "the page does not render
 * it" is a convention, while "the SELECT did not return it" is a guarantee. The
 * audience defaults to `CASE_RECORD`, so the client's own timeline reads exactly
 * what it read before M5.
 */
export function loadTimeline(
  db: Db,
  caseId?: string,
  audience: MaterialAudience = CASE_RECORD,
): TimelineSnapshot {
  const target = resolveTimelineCase(db, caseId);
  if (target === null) {
    return { caseId: null, caseTitle: null, mainline: [], pending: [] };
  }

  const grant = resolveMaterialGrant(db, target.id, audience);
  const rows = sortRows(
    db
      .select()
      .from(events)
      .where(and(eq(events.caseId, target.id), visibleMaterial(events, grant)))
      .all(),
  );

  return {
    caseId: target.id,
    caseTitle: target.title,
    mainline: rows.filter(isMainlineEvent).map(toCard),
    pending: rows.filter((r) => !isMainlineEvent(r)).map(toCard),
  };
}

/* -------------------------------------------------------------------------- */
/* Putting an event on the record                                             */
/* -------------------------------------------------------------------------- */

/**
 * Say that something happened — the act the whole stage is a rearrangement of.
 *
 * There was no such function until now, and the gap was invisible from the web
 * app because its timeline screen only ever *reorders* what the seed import put
 * in the table. On a surface where the record starts empty, that made stage ④ a
 * dead end: `clarification` needs one event on the mainline, and nothing outside
 * `scripts/seed-*.ts` could put one there.
 *
 * What it writes, and why each field is what it is:
 *
 *   - `confirm_status: "confirmed"`. An event created here is the client's own
 *     sentence about their own case, typed by them; there is no `ai_draft` to
 *     stand behind or reject. This is the confirm triple's degenerate case (a
 *     human wrote it, so it is confirmed), not a bypass of it — no model output
 *     reaches this function.
 *   - `owner_participant_id` is the client, `visibility: "private"`, matching
 *     every other piece of material the client registers.
 *   - `order_key` is minted after the case's existing keys, never renumbered.
 *   - The date is optional, and its absence is meaningful: an undated event
 *     waits in the holding area (`occurred_precision: "unknown"`) until somebody
 *     dates it or drags it in. That is the two-list rule this module already
 *     implements, entered from the other end.
 *
 * Evidence links are the reason to prefer this over an INSERT: an event that
 * rests on registered material says so in `event_evidence`, and an id belonging
 * to another case is refused rather than linked.
 */
export interface CreateEventInput {
  readonly caseId: string;
  readonly title: string;
  readonly description?: string | null;
  /** External label (E1, E2 …). Free-form; the seed import uses it as a key. */
  readonly label?: string | null;
  /** When it happened. Omit for an event whose date is not settled yet. */
  readonly occurred?: OccurredAnchor;
  /** Evidence rows this event rests on. Must belong to the same case. */
  readonly evidenceIds?: readonly string[];
}

/** A date anchor: the instant, and how precisely it is actually known. */
export interface OccurredAnchor {
  readonly at: Date;
  /** Anything but `unknown` — an unknown date is expressed by omitting this. */
  readonly precision: Exclude<OccurredPrecision, "unknown">;
}

export interface CreatedEvent {
  readonly id: string;
  readonly caseId: string;
  readonly orderKey: string;
  readonly inMainline: boolean;
  readonly card: TimelineEventCard;
}

export function createEvent(db: Db, input: CreateEventInput): CreatedEvent {
  const title = input.title.trim();
  if (title === "") {
    throw new TimelineWriteError(
      "empty_event",
      "An event needs a title: one line saying what happened. The timeline is " +
        "a list of things that happened, and an untitled one cannot be placed " +
        "against the others.",
    );
  }

  const caseRow = db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.id, input.caseId))
    .get();
  if (caseRow === undefined) {
    throw new TimelineWriteError("case_not_found", `No case with id ${input.caseId}.`);
  }

  const links = [...new Set(input.evidenceIds ?? [])];
  for (const evidenceId of links) {
    const owned = db
      .select({ id: evidence.id })
      .from(evidence)
      .where(and(eq(evidence.id, evidenceId), eq(evidence.caseId, input.caseId)))
      .get();
    if (owned === undefined) {
      throw new TimelineWriteError(
        "unknown_evidence",
        `Evidence ${evidenceId} is not registered on case ${input.caseId}. An ` +
          `event may only rest on material this case actually holds.`,
      );
    }
  }

  // The client — the party who submitted the case — owns what they register.
  const owner = db
    .select({ id: caseParticipants.id })
    .from(caseParticipants)
    .where(
      and(
        eq(caseParticipants.caseId, input.caseId),
        eq(caseParticipants.isSubmitter, true),
      ),
    )
    .get();

  const row = db.transaction((tx) => {
    const keys = tx
      .select({ orderKey: events.orderKey })
      .from(events)
      .where(eq(events.caseId, input.caseId))
      .all()
      .map((existing) => existing.orderKey)
      .sort(compareOrderKeys);

    const [written] = tx
      .insert(events)
      .values({
        caseId: input.caseId,
        label: input.label?.trim() || null,
        title,
        description: input.description?.trim() || null,
        occurredAt: input.occurred?.at ?? null,
        occurredPrecision: input.occurred?.precision ?? "unknown",
        orderKey: orderKeyForIndex(keys, keys.length),
        // Dated events are on the mainline by their own dating; an undated one
        // waits to be dragged in, which is the only thing this bit records.
        inTimeline: false,
        confirmStatus: "confirmed",
        ownerParticipantId: owner?.id ?? null,
        visibility: "private",
      })
      .returning()
      .all();

    for (const evidenceId of links) {
      tx.insert(eventEvidence)
        .values({ eventId: written.id, evidenceId, note: null })
        .onConflictDoNothing()
        .run();
    }

    return written;
  });

  return {
    id: row.id,
    caseId: row.caseId,
    orderKey: row.orderKey,
    inMainline: isMainlineEvent(row),
    card: toCard(row),
  };
}

/**
 * Give an event a date — the other way onto the mainline.
 *
 * `moveEvent` is the drag; this is the anchor. They are separate because they
 * are separate claims: dragging says "it goes here relative to the others",
 * dating says "it happened then", and only the second one survives somebody
 * else re-sorting the list. A dated event is on the mainline whatever the
 * placement bit says, which is why this needs no companion move.
 *
 * The reverse — taking a date off — is deliberately not offered here: it would
 * be the one write that can pull an event out of the mainline behind the back of
 * `moveEvent`'s `anchored_event` refusal.
 */
export function dateEvent(
  db: Db,
  input: { readonly eventId: string; readonly occurred: OccurredAnchor },
): MoveEventOutcome {
  const row = db.select().from(events).where(eq(events.id, input.eventId)).get();
  if (row === undefined) {
    throw new TimelineWriteError("event_not_found", `No event with id ${input.eventId}.`);
  }

  db.update(events)
    .set({
      occurredAt: input.occurred.at,
      occurredPrecision: input.occurred.precision,
    })
    .where(eq(events.id, row.id))
    .run();

  return { id: row.id, orderKey: row.orderKey, inMainline: true };
}

/**
 * Where the row lands, from the neighbours the client reports.
 *
 * `destination` is the target list WITHOUT the moved row, already sorted, so
 * "after `beforeId`" and "before `afterId`" describe the same slot. A neighbour
 * the server cannot find means the client is looking at a stale list.
 */
function resolveIndex(
  destination: EventRow[],
  beforeId: string | null,
  afterId: string | null,
): number {
  if (beforeId !== null) {
    const at = destination.findIndex((r) => r.id === beforeId);
    if (at === -1) {
      throw new TimelineError(
        "stale_order",
        `Neighbour ${beforeId} is not in the destination list any more.`,
      );
    }
    return at + 1;
  }
  if (afterId !== null) {
    const at = destination.findIndex((r) => r.id === afterId);
    if (at === -1) {
      throw new TimelineError(
        "stale_order",
        `Neighbour ${afterId} is not in the destination list any more.`,
      );
    }
    return at;
  }
  // No neighbours: the destination list is empty, or an explicit top insert.
  return 0;
}

/**
 * Move one event: into the mainline (reorder, or promote out of the holding
 * area) or back into the holding area. Writes ONE row — `order_key` plus the
 * placement bit — and never renumbers its neighbours.
 */
export function moveEvent(db: Db, input: MoveEventInput): MoveEventOutcome {
  const row = db.select().from(events).where(eq(events.id, input.eventId)).get();
  if (row === undefined) {
    throw new TimelineError("event_not_found", `No event with id ${input.eventId}.`);
  }

  if (input.target === "pending" && row.occurredPrecision !== "unknown") {
    throw new TimelineError(
      "anchored_event",
      `Event ${input.eventId} has a date anchor (${row.occurredPrecision}); ` +
        `a dated event cannot leave the mainline.`,
    );
  }

  const destination = sortRows(
    db
      .select()
      .from(events)
      .where(eq(events.caseId, row.caseId))
      .all()
      .filter((r) => r.id !== row.id && containerOf(r) === input.target),
  );

  const index = resolveIndex(destination, input.beforeId, input.afterId);
  const orderKey = orderKeyForIndex(
    destination.map((r) => r.orderKey),
    index,
  );
  const inTimeline = input.target === "mainline";

  db.update(events)
    .set({ orderKey, inTimeline })
    .where(eq(events.id, row.id))
    .run();

  return {
    id: row.id,
    orderKey,
    // A dated event stays on the mainline whatever the placement bit says.
    inMainline: inTimeline || row.occurredPrecision !== "unknown",
  };
}
