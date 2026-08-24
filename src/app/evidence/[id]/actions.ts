"use server";

// Server actions for the evidence confirmation workbench.
//
// Every action is a two-line shell: hand the request to the workbench data
// layer (which owns ownership checks and transition legality — the client's
// claims are re-derived there, never trusted) and turn a `WorkbenchError` into
// data the UI can render. Anything else propagates: a bug should reach the
// error boundary, not be dressed up as a polite sentence.

import { revalidatePath } from "next/cache";

import type { ActionResult } from "../../../lib/action-result";
import { getDb } from "../../../server/db";
import type { EvidenceGrade, UtteranceTone } from "../../../server/db/schema";
import {
  WorkbenchError,
  confirmEvidenceGrade,
  confirmUtterance,
  editUtterance,
  rejectUtterance,
  updateUtteranceAttributes,
  type SpeakerAssignment,
  type WorkbenchEvidence,
  type WorkbenchUtterance,
} from "../../../server/evidence/workbench";

/** Run one mutation, refresh the page's cache entry, normalize failures. */
function run<T>(evidenceId: string, work: () => T): ActionResult<T> {
  try {
    const data = work();
    revalidatePath(`/evidence/${evidenceId}`);
    return { ok: true, data };
  } catch (cause) {
    if (cause instanceof WorkbenchError) {
      return { ok: false, code: cause.code, message: cause.message };
    }
    throw cause;
  }
}

/** Accept the recognized text as-is. */
export async function confirmUtteranceAction(
  evidenceId: string,
  utteranceId: string,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    confirmUtterance(getDb(), { evidenceId, utteranceId }),
  );
}

/** Save the reviewer's own wording. */
export async function saveUtteranceAction(
  evidenceId: string,
  utteranceId: string,
  text: string,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    editUtterance(getDb(), { evidenceId, utteranceId, text }),
  );
}

/** Drop the line for good (terminal). */
export async function rejectUtteranceAction(
  evidenceId: string,
  utteranceId: string,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    rejectUtterance(getDb(), { evidenceId, utteranceId }),
  );
}

/** Mark the quote as a recollection ("as you recall it, they said…") or clear it. */
export async function setUtteranceRetoldAction(
  evidenceId: string,
  utteranceId: string,
  isRetold: boolean,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    updateUtteranceAttributes(getDb(), { evidenceId, utteranceId, isRetold }),
  );
}

/** Set or clear the tone label. */
export async function setUtteranceToneAction(
  evidenceId: string,
  utteranceId: string,
  tone: UtteranceTone | null,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    updateUtteranceAttributes(getDb(), { evidenceId, utteranceId, tone }),
  );
}

/** Fix speaker attribution: one of the parties, or "not speech at all". */
export async function setUtteranceSpeakerAction(
  evidenceId: string,
  utteranceId: string,
  speaker: SpeakerAssignment,
): Promise<ActionResult<WorkbenchUtterance>> {
  return run(evidenceId, () =>
    updateUtteranceAttributes(getDb(), { evidenceId, utteranceId, speaker }),
  );
}

/** Human sign-off on the evidence grade (may override the rule's suggestion). */
export async function confirmEvidenceGradeAction(
  evidenceId: string,
  grade: EvidenceGrade,
): Promise<ActionResult<WorkbenchEvidence>> {
  return run(evidenceId, () => confirmEvidenceGrade(getDb(), { evidenceId, grade }));
}
