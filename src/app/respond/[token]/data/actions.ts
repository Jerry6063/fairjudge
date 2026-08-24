"use server";

/**
 * The three acts the transparency view offers (SPEC M5 ④).
 *
 * They are separate server actions rather than one "manage my data" endpoint,
 * because they are three different promises and the product must not blur them:
 *
 *   `deleteOwnItem`   — removes her material. Immediate, unilateral, audited.
 *   `requestDeletion` — records a request about somebody else's material and
 *                       deletes nothing. The redirect says `asked`, never
 *                       `deleted`, so even the URL after the click tells the
 *                       truth about what happened.
 *   `revokeNamedRendition` — withdraws consent for any document naming her to
 *                       leave this machine. It calls `recordConsent` and does
 *                       nothing else: consent is decided in `access/consent.ts`,
 *                       and a second place that decides it is a second answer.
 *
 * The token in the form is the capability, the same one that opened the page.
 * Every action re-resolves it server-side rather than trusting a participant id
 * from the browser — a hidden field is a thing anybody can edit, and the check
 * that matters is which participant the token resolves to *here*.
 */

import { redirect } from "next/navigation";

import {
  DeletionError,
  deleteOwnMaterial,
  recordConsent,
  requestMaterialDeletion,
} from "../../../../server/access";
import { getDb } from "../../../../server/db";
import { DELETION_TARGET_KINDS, type DeletionTargetKind } from "../../../../server/db/schema";
import { resolveRespondToken, type RespondSubject } from "./transparency";

/** Where to send the browser afterwards, with one word about what happened. */
function backTo(token: string, outcome: string): never {
  redirect(
    `/respond/${encodeURIComponent(token)}/data?outcome=${encodeURIComponent(outcome)}`,
  );
}

function readTarget(form: FormData): {
  readonly kind: DeletionTargetKind;
  readonly id: string;
} | null {
  const kind = String(form.get("kind") ?? "");
  const id = String(form.get("id") ?? "");
  if (!DELETION_TARGET_KINDS.includes(kind as DeletionTargetKind)) return null;
  if (id === "") return null;
  return { kind: kind as DeletionTargetKind, id };
}

/** Resolve the token to the party acting, or send them back with a refusal. */
function subjectFor(token: string): RespondSubject {
  const resolved = resolveRespondToken(getDb(), token);
  if (!resolved.ok) backTo(token, `refused_${resolved.reason}`);
  return resolved.subject;
}

/** Her own material: removed, and written to the audit in the same transaction. */
export async function deleteOwnItem(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const subject = subjectFor(token);
  const target = readTarget(form);
  if (target === null) backTo(token, "refused_bad_target");

  const reason = String(form.get("reason") ?? "").trim();

  try {
    deleteOwnMaterial(getDb(), {
      caseId: subject.caseId,
      actorParticipantId: subject.participantId,
      targetKind: target.kind,
      targetId: target.id,
      reason: reason === "" ? null : reason,
    });
  } catch (error) {
    if (error instanceof DeletionError) backTo(token, `refused_${error.code}`);
    throw error;
  }

  backTo(token, "deleted");
}

/**
 * Somebody else's material: the asking is recorded and nothing is removed.
 *
 * `asked` rather than `deleted` in the redirect is deliberate — the one word the
 * product must not get wrong here is the one describing what just happened.
 */
export async function requestDeletion(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const subject = subjectFor(token);
  const target = readTarget(form);
  if (target === null) backTo(token, "refused_bad_target");

  const reason = String(form.get("reason") ?? "").trim();

  try {
    requestMaterialDeletion(getDb(), {
      caseId: subject.caseId,
      requesterParticipantId: subject.participantId,
      targetKind: target.kind,
      targetId: target.id,
      reason: reason === "" ? null : reason,
    });
  } catch (error) {
    if (error instanceof DeletionError) backTo(token, `refused_${error.code}`);
    throw error;
  }

  backTo(token, "asked");
}

/**
 * Withdraw consent for any document naming her to leave this machine.
 *
 * A thin call into `access/consent.ts`. The export gate and the share tokens
 * read that same record, so this is the whole implementation of "she controls
 * it outright" — there is nothing else to switch off.
 */
export async function revokeNamedRendition(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const subject = subjectFor(token);
  const note = String(form.get("note") ?? "").trim();

  recordConsent(getDb(), {
    caseId: subject.caseId,
    actorParticipantId: subject.participantId,
    kind: "revoked",
    scope: "named_rendition",
    note: note === "" ? null : note,
  });

  backTo(token, "revoked");
}
