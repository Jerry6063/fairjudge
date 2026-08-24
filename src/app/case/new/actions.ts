"use server";

/**
 * The one write the front door performs.
 *
 * A form post, not a fetch: the browser submits to this action, the action
 * creates the case and redirects to it. There is no client-side request layer
 * here on purpose — the thing being created is a record about somebody's
 * relationship, and the fewer places that can half-create one, the better.
 *
 * Refusals come back as data with copy the form renders next to the field that
 * caused them. Unexpected failures are left to throw: they are bugs, not
 * answers, and a form that reports "something went wrong" over a database
 * failure is a form that lies about whether a case exists.
 *
 * `is_fixture` is deliberately not readable from the form. A demonstration case
 * is authored by a script; a person filing at this screen is filing about real
 * people, and no request body may claim otherwise.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  CaseCreationError,
  createCase,
  validateCaseInput,
  type CaseCreationField,
} from "../../../server/cases";
import { getDb } from "../../../server/db";
import type { ClientIntent } from "../../../server/db/schema";

/** What the form shows when the filing was refused. Null before the first try. */
export interface FilingRefusal {
  readonly field: CaseCreationField;
  readonly code: string;
  readonly message: string;
}

export type FilingState = FilingRefusal | null;

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * File the case, then go to it.
 *
 * On success this never returns — `redirect` throws the control flow into
 * Next's router — so the only value the form ever receives back is a refusal.
 */
export async function fileCaseAction(
  _previous: FilingState,
  form: FormData,
): Promise<FilingState> {
  const raw = {
    title: text(form, "title"),
    intent: text(form, "intent"),
    clientName: text(form, "clientName"),
    counterpartyName: text(form, "counterpartyName"),
    account: text(form, "account"),
  };

  // Checked before the database is opened, so a blank form is refused without
  // touching anything — and this is where the untyped `intent` string off the
  // wire is narrowed. `createCase` runs the same check again inside its
  // transaction: this one is a courtesy to the browser, that one is the rule,
  // and the rule must not be bypassable by any other caller.
  let intent: ClientIntent;
  try {
    ({ intent } = validateCaseInput(raw));
  } catch (cause) {
    if (cause instanceof CaseCreationError) {
      return { field: cause.field, code: cause.code, message: cause.message };
    }
    throw cause;
  }

  let caseId: string;
  try {
    const created = createCase(getDb(), { ...raw, intent });
    caseId = created.caseId;
  } catch (cause) {
    if (cause instanceof CaseCreationError) {
      return { field: cause.field, code: cause.code, message: cause.message };
    }
    throw cause;
  }

  revalidatePath("/case");
  redirect(`/case/${caseId}`);
}
