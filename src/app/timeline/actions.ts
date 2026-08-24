"use server";

// Server actions for /timeline.
//
// The client sends what the drop looked like (an event and its two new
// neighbours); the server re-reads the list, computes the single order key that
// lands the row between them, and writes that one row. Nothing about the
// ordering is trusted from the client — a stale board is rejected rather than
// applied to whatever the ids happen to point at now.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  TIMELINE_CONTAINERS,
  type MoveEventResult,
} from "../../lib/timeline-contract";
import { getDb } from "../../server/db";
import { TimelineError, moveEvent } from "../../server/domain/timeline";

const moveEventSchema = z.object({
  eventId: z.string().min(1),
  target: z.enum(TIMELINE_CONTAINERS),
  beforeId: z.string().min(1).nullable(),
  afterId: z.string().min(1).nullable(),
});

/** User-facing copy per domain failure, rendered as-is. */
const ERROR_COPY: Record<TimelineError["code"], string> = {
  event_not_found: "This event is no longer in the database. Refresh the page.",
  anchored_event:
    "This event has a date anchor, so it cannot go back to the undated column.",
  stale_order: "The order on this page is out of date. Refresh and try again.",
};

/**
 * Place an event into the mainline or the holding area, between `beforeId` and
 * `afterId`. Returns the persisted placement so the client can reconcile its
 * optimistic state; on failure the client reverts to the server's board.
 */
export async function moveEventAction(input: unknown): Promise<MoveEventResult> {
  const parsed = moveEventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That drag was not a valid request. Refresh the page and try again.",
    };
  }

  try {
    const outcome = moveEvent(getDb(), parsed.data);
    revalidatePath("/timeline");
    return { ok: true, event: outcome };
  } catch (cause) {
    if (cause instanceof TimelineError) {
      return { ok: false, error: ERROR_COPY[cause.code] };
    }
    // Unexpected: keep the detail server-side, hand the user something actionable.
    console.error("[timeline] moveEventAction failed", cause);
    return {
      ok: false,
      error: "Could not save the order. Refresh the page and try again.",
    };
  }
}
