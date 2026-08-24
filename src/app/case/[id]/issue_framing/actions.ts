"use server";

// Server actions for the issue-fixing screen (SPEC M3 wave A ⑤).
//
// The client may ask for four things: generate the three lists, and then
// confirm / rewrite / drop one item. None of them carries a fact the server
// trusts — the item id is looked up against the case it claims to belong to,
// and the generation validates every citation against the database before a row
// is written (HARD RULE #1, `server/pipeline/evidence-refs.ts`).
//
// A rejected generation comes back as a message, not as a shorter list. That is
// the whole point: if the model cited an utterance that does not exist, the user
// is told so, rather than shown a tidy list with the bad item quietly removed.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "../../../../lib/action-result";
import { getDb } from "../../../../server/db";
import {
  IssueError,
  confirmIssue,
  editIssue,
  generateIssues,
  rejectIssue,
  type IssueBoard,
  type IssueItem,
} from "../../../../server/pipeline";

const caseOnly = z.object({ caseId: z.string().min(1) });

const itemSchema = z.object({
  caseId: z.string().min(1),
  issueId: z.string().min(1),
});

const editSchema = itemSchema.extend({ text: z.string() });

const BAD_REQUEST = {
  ok: false as const,
  code: "bad_request",
  message: "That was not a valid request. Refresh the page.",
};

/** Turn an `IssueError` into wire data; anything else is a bug and rethrows. */
function asActionFailure(cause: unknown): ActionResult<never> {
  if (cause instanceof IssueError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  throw cause;
}

export interface IssueGenerationData {
  readonly board: IssueBoard;
  readonly created: number;
  readonly replaced: number;
  /** 2 when the first answer was rejected for a bad citation and re-asked. */
  readonly attempts: number;
}

/**
 * Generate the three lists.
 *
 * Every failure mode of the underlying stage is a message here, because each one
 * means something different to the person reading it: nothing citable yet, a
 * refusal, a transport failure, or — the one this milestone is about — a model
 * that cited material which does not hold, twice.
 */
export async function generateIssuesAction(
  input: unknown,
): Promise<ActionResult<IssueGenerationData>> {
  const parsed = caseOnly.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;

  const result = await generateIssues(getDb(), parsed.data.caseId);

  switch (result.kind) {
    case "ok":
      revalidatePath(`/case/${parsed.data.caseId}/issue_framing`);
      return {
        ok: true,
        data: {
          board: result.board,
          created: result.created,
          replaced: result.replaced,
          attempts: result.attempts,
        },
      };
    case "invalid_refs":
      return { ok: false, code: "invalid_refs", message: result.message };
    case "no_material":
      return { ok: false, code: "no_material", message: result.message };
    case "refused":
      return {
        ok: false,
        code: "refused",
        message:
          "The model declined to work on this material. Nothing was saved.",
      };
    case "error":
      return { ok: false, code: "error", message: result.message };
  }
}

/** Accept an item as drafted. */
export async function confirmIssueAction(
  input: unknown,
): Promise<ActionResult<IssueItem>> {
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const item = confirmIssue(getDb(), parsed.data);
    revalidatePath(`/case/${parsed.data.caseId}/issue_framing`);
    return { ok: true, data: item };
  } catch (cause) {
    return asActionFailure(cause);
  }
}

/** Replace the wording with the reviewer's own. Citations are untouched. */
export async function editIssueAction(
  input: unknown,
): Promise<ActionResult<IssueItem>> {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const item = editIssue(getDb(), parsed.data);
    revalidatePath(`/case/${parsed.data.caseId}/issue_framing`);
    return { ok: true, data: item };
  } catch (cause) {
    return asActionFailure(cause);
  }
}

/** Drop the item from the case's issues. Terminal. */
export async function rejectIssueAction(
  input: unknown,
): Promise<ActionResult<IssueItem>> {
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) return BAD_REQUEST;
  try {
    const item = rejectIssue(getDb(), parsed.data);
    revalidatePath(`/case/${parsed.data.caseId}/issue_framing`);
    return { ok: true, data: item };
  } catch (cause) {
    return asActionFailure(cause);
  }
}
