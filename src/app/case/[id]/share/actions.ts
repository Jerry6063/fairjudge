"use server";

// Server actions for the share screen.
//
// Two acts, and they are the only two this screen has: take a copy of the
// document (which is an export, and is audited as one), and mint a link.
// Everything else on the page is a read.
//
// ## Both go through the same pre-send step
//
// Doc 01 §post-judgment ③ puts a 24–48 hour pause and one question between
// writing something like this and sending it. It would be easy to hang that on
// the share link alone, and it would be worthless: the file is the door that
// actually produces an unrecallable copy on somebody else's machine, and a pause
// you can walk around with one click is not a pause. So `clearToSend` runs first
// in both actions — the same pause, read from the same stored timestamp, and the
// same question, read from the same words.
//
// Both actions re-decide everything from the database. The screen disables a
// control it knows the server will refuse, but that is a courtesy — a stale page,
// a second tab, or a hand-written POST gets exactly the same refusal, from the
// same code, because none of the facts a decision rests on travel in the
// request. The request carries an id, a channel and the sender's own sentence;
// the consent log, the cool-down anchor and every gate check are read here.
//
// There is deliberately no action that transmits anything. No mail-to, no social
// intent, no webhook, no upload. The ceiling is: bytes come back to the browser,
// and a person hands them over themselves.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { NamedRenditionRevokedError } from "../../../../server/access/consent";
import { getDb } from "../../../../server/db";
import { EXPORT_CHANNELS } from "../../../../server/db/schema";
import {
  ExportBlockedError,
  JudgmentStoreError,
  RenditionError,
  exportRendition,
  mintShareToken,
} from "../../../../server/judgment";
import {
  SEND_INTENT_QUESTION,
  readSendIntent,
  readSharePreview,
  type SendIntent,
  type SharePreview,
} from "../../../../server/judgment/share-view";

/* -------------------------------------------------------------------------- */
/* The pre-send step, shared by both doors                                    */
/* -------------------------------------------------------------------------- */

/** What both actions carry: which document, and the answer to doc 01's question. */
const sendSchema = z.object({
  caseId: z.string().min(1),
  judgmentId: z.string().min(1),
  /** The answer to the doc 01 question, in the sender's own words. */
  intent: z.string(),
  /**
   * True only after the sender has been shown doc 01's warning about their own
   * answer and has come back. It is a second act, not a checkbox on the first
   * one: the first submission is refused and returns the warning, and this flag
   * is what a second submission carries.
   */
  acknowledgedWarning: z.boolean().default(false),
});

type SendInput = z.infer<typeof sendSchema>;

type Cleared =
  | { readonly ok: true; readonly preview: SharePreview; readonly intent: SendIntent }
  | { readonly ok: false; readonly refusal: ActionResult<never> };

/**
 * Everything that has to be true before this document goes anywhere.
 *
 * The pause first, because it is the one that cannot be argued with; then the
 * question, because an answer given under time pressure is not the answer doc 01
 * is asking for. Neither writes anything.
 */
function clearToSend(input: SendInput): Cleared {
  const read = readSharePreview(getDb(), input.caseId, {
    judgmentId: input.judgmentId,
  });
  if (!read.ok) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: read.problem.code,
        message: read.problem.message,
      },
    };
  }

  // 1. The cool-down, re-read from the document's own timestamp. It cannot be
  //    started by clicking and it cannot be skipped by a stale page.
  const { coolingOff } = read.preview;
  if (!coolingOff.elapsed) {
    const hours = Math.ceil(coolingOff.remainingMs / (60 * 60 * 1000));
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "cooling_off",
        message:
          `This document was written ${describeElapsed(coolingOff.elapsedMs)} ago. ` +
          `Doc 01 puts a 24–48 hour pause between writing something like this ` +
          `and sending it, and the pause runs from when the document was ` +
          `written, not from when you opened this page. ${hours} hour` +
          `${hours === 1 ? "" : "s"} left. It is not a cooling-off period for her.`,
      },
    };
  }

  // 2. Doc 01's question. An answer is required, and an answer of the kind doc
  //    01 names gets the warning and no copy — on the first submission.
  const intent = readSendIntent(input.intent);
  if (!intent.answered) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "intent_unanswered",
        message: `${SEND_INTENT_QUESTION} Answer it in your own words before anything leaves.`,
      },
    };
  }
  if (intent.flagged && !input.acknowledgedWarning) {
    return {
      ok: false,
      refusal: { ok: false, code: "intent_flagged", message: intent.warning ?? "" },
    };
  }

  return { ok: true, preview: read.preview, intent };
}

/* -------------------------------------------------------------------------- */
/* Taking a copy                                                              */
/* -------------------------------------------------------------------------- */

const exportSchema = sendSchema.extend({
  /**
   * Only the channels that exist. A social channel is not missing from this
   * enum by oversight — `resolveChannel` in the gate refuses one by name, with
   * a reason, and this enum keeps a request for one from ever reaching it as
   * something that looks like a typo.
   */
  channel: z.enum(EXPORT_CHANNELS),
});

export interface ExportActionData {
  /** The audit row's id. Printed in the watermark on these exact bytes. */
  readonly exportId: string;
  /** What leaves: watermarked, metadata-stripped, gate-checked. */
  readonly text: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly watermark: string;
  readonly recipientPseudonym: string;
  readonly exportedAtIso: string;
  /** A filename for a download. Carries the export id, never a name. */
  readonly filename: string;
}

/**
 * Export one copy of the counterparty document.
 *
 * This IS the export, not a rehearsal of one: it runs the real gate and writes
 * the one audit row that gate writes. Calling it a simulation would be the lie —
 * the bytes reach a clipboard or a file on somebody's disk, and that is the
 * moment the log exists to record. A refusal writes nothing, because what the
 * table audits is egress and a refused document never left.
 */
export async function exportShareableCopyAction(
  input: unknown,
): Promise<ActionResult<ExportActionData>> {
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message:
        "That was not a valid export request. Refresh the page. (If you were " +
        "reaching for a share-to button: there is none, and its absence is a " +
        "decision — see the export gate's own refusal copy.)",
    };
  }

  const cleared = clearToSend(parsed.data);
  if (!cleared.ok) return cleared.refusal;

  try {
    const doc = exportRendition(getDb(), {
      judgmentId: parsed.data.judgmentId,
      channel: parsed.data.channel,
    });
    revalidatePath(`/case/${parsed.data.caseId}/share`);
    return {
      ok: true,
      data: {
        exportId: doc.exportId,
        text: doc.text,
        contentSha256: doc.contentSha256,
        byteSize: doc.byteSize,
        watermark: doc.watermark,
        recipientPseudonym: doc.recipientPseudonym,
        exportedAtIso: doc.exportedAt.toISOString(),
        filename: `fairjudge-v${doc.judgmentVersion}-${doc.exportId.slice(0, 8)}.md`,
      },
    };
  } catch (cause) {
    return refusal(cause, "Could not export this copy.");
  }
}

/* -------------------------------------------------------------------------- */
/* Minting a link                                                             */
/* -------------------------------------------------------------------------- */

export interface MintActionData {
  /** The token, returned exactly once. Only its hash is stored. */
  readonly token: string;
  readonly link: string;
  readonly expiresAtIso: string;
  /**
   * True: nothing on this build redeems a share token. Returned rather than
   * hidden — the minted document's last line points at this link, and a link
   * that does not open is the M4 defect (a document promising a route that is
   * not there) repeated in the same artifact.
   */
  readonly routeUnbuilt: true;
}

/**
 * The pre-send step, then the link.
 *
 * `mintShareToken` asks the consent log again on its own, re-reads the stored
 * row's `shareable` flag, and re-derives and re-validates the document the link
 * would expose. A refusal at any of those writes nothing.
 */
export async function mintShareLinkAction(
  input: unknown,
): Promise<ActionResult<MintActionData>> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message: "That was not a valid request. Refresh the page.",
    };
  }

  const cleared = clearToSend(parsed.data);
  if (!cleared.ok) return cleared.refusal;

  try {
    const minted = mintShareToken(getDb(), parsed.data.judgmentId, "shareable");
    revalidatePath(`/case/${parsed.data.caseId}/share`);
    return {
      ok: true,
      data: {
        token: minted.token,
        link: `/respond/${minted.token}`,
        expiresAtIso: minted.expiresAt.toISOString(),
        routeUnbuilt: true,
      },
    };
  } catch (cause) {
    return refusal(cause, "Could not mint a link for this document.");
  }
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

function describeElapsed(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60000))} minutes`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Turn a domain refusal into something the screen can print, keeping the
 * refusal's own words.
 *
 * The messages these errors carry were written to be read by the person doing
 * this — the consent refusal names who withdrew, when, in their own words, and
 * which copies had already left. Replacing that with "blocked" is how a product
 * ends up with a UI that knows less than its server.
 */
function refusal(cause: unknown, fallback: string): ActionResult<never> {
  if (cause instanceof NamedRenditionRevokedError) {
    return { ok: false, code: "consent_revoked", message: cause.message };
  }
  if (cause instanceof ExportBlockedError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  if (cause instanceof RenditionError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  if (cause instanceof JudgmentStoreError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  // eslint-disable-next-line no-console
  console.error("[share] action failed", cause);
  return {
    ok: false,
    code: "unexpected",
    message: `${fallback} Refresh the page and try again.`,
  };
}
