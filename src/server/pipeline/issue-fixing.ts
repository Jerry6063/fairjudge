/**
 * Issue fixing — the three lists (SPEC M3 wave A ⑤).
 *
 * Server-side half of stage ⑦: generate the lists, validate every citation,
 * persist, read them back for the screen, and take the reviewer's confirm /
 * rewrite / drop on each item.
 *
 * The one thing worth stating plainly, because it is the difference between
 * this module and a wrapper around a model call: nothing reaches the `issues`
 * table until every `evidence_ref` in the whole generation has been checked
 * against the database (`runCitedStage` → `auditCitations`). A generation with
 * one invented id is discarded entire. There is no partial save and no
 * "drop the bad reference and keep the item", because either of those would put
 * a clean-looking list on screen with the failure quietly deleted from it.
 *
 * Regeneration keeps human work: rows the reviewer has already confirmed,
 * rewritten or dropped survive, and only untouched drafts (`pending`) are
 * replaced. A second opinion should not be able to erase a first decision.
 */

import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  ISSUE_CATEGORIES,
  issues as issuesTable,
  type ConfirmStatus,
  type IssueCategory,
} from "../db/schema";
import type { RunStageOptions } from "../llm";
import { issueFixingStage, type IssueFixingOutput } from "../llm/stages";
import { orderKeysBetween } from "../domain/order-key";
import {
  buildCitedPrompt,
  runCitedStage,
  type CitedRunResult,
} from "./cited-generation";
import {
  auditCitations,
  buildCitableBrief,
  describeCitationFaults,
  type BriefUtterance,
  type CitationAudit,
  type CitingItem,
} from "./evidence-refs";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The stage's output keys, in the order the screen shows them. */
const LIST_KEYS = [
  "undisputed_facts",
  "disputes_of_fact",
  "disputes_of_standard",
] as const;

type ListKey = (typeof LIST_KEYS)[number];

/** Output key → the `issues.category` column value. */
const CATEGORY_OF: Readonly<Record<ListKey, IssueCategory>> = {
  undisputed_facts: "undisputed",
  disputes_of_fact: "fact_dispute",
  disputes_of_standard: "standard_dispute",
};

/** Per-list copy for the screen. Product voice, not schema names. */
export const ISSUE_LIST_META: Readonly<
  Record<IssueCategory, { readonly title: string; readonly purpose: string }>
> = {
  undisputed: {
    title: "Undisputed facts",
    purpose:
      "What the material shows and nobody is contesting. These are the ground " +
      "the rest of the case is argued on.",
  },
  fact_dispute: {
    title: "Disputes of fact",
    purpose:
      "Where the two accounts disagree about what actually happened or was " +
      "actually said.",
  },
  standard_dispute: {
    title: "Disputes of standard",
    purpose:
      "Where you agree on what happened and disagree about what it should " +
      "mean — what counts as enough care, a fair ask, a real apology. Most " +
      "arguments live here.",
  },
};

/** The task turn appended after the evidence brief. */
const ISSUE_FIXING_TASK =
  "Fix the issues in this case: sort what is at stake into the three lists. " +
  "Ground every item in at least one utterance id from the EVIDENCE block " +
  "above, and leave out anything you cannot point at.";

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

/** One cited line, resolved for rendering next to the item that cites it. */
export interface IssueCitation {
  readonly utteranceId: string;
  /** Pseudonym, "timestamp", or "unattributed". */
  readonly speaker: string;
  /** HARD RULE #5: the render layer frames a recollection as a recollection. */
  readonly isRetold: boolean;
  /** Verbatim evidence — Chinese stays Chinese. Null when no longer citable. */
  readonly text: string | null;
  /**
   * True when the cited line is no longer confirmed (the reviewer went back and
   * rejected it after this item was written). Surfaced rather than hidden: the
   * item now rests on nothing, and that is the reviewer's decision to make.
   */
  readonly stale: boolean;
}

export interface IssueItem {
  readonly id: string;
  readonly category: IssueCategory;
  readonly aiDraft: string | null;
  readonly humanFinal: string | null;
  readonly confirmStatus: ConfirmStatus;
  readonly citations: readonly IssueCitation[];
}

export interface IssueList {
  readonly category: IssueCategory;
  readonly title: string;
  readonly purpose: string;
  readonly items: readonly IssueItem[];
}

export interface IssueBoard {
  readonly lists: readonly IssueList[];
  readonly total: number;
  /** Items still waiting for the reviewer — the `pre_judgment` precondition. */
  readonly pending: number;
}

/** Read the three lists, with every citation resolved to its confirmed text. */
export function listIssues(db: Db, caseId: string): IssueBoard {
  const rows = db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.caseId, caseId))
    .orderBy(asc(issuesTable.orderKey), asc(issuesTable.createdAt), asc(issuesTable.id))
    .all();

  const citable = new Map<string, BriefUtterance>(
    buildCitableBrief(db, caseId).utterances.map((u) => [u.id, u]),
  );

  const items: IssueItem[] = rows.map((row) => ({
    id: row.id,
    category: row.category,
    aiDraft: row.aiDraft,
    humanFinal: row.humanFinal,
    confirmStatus: row.confirmStatus,
    citations: (row.evidenceRefs ?? []).map((ref) => {
      const line = citable.get(ref);
      return {
        utteranceId: ref,
        speaker: line?.speaker ?? "unknown",
        isRetold: line?.isRetold ?? false,
        text: line?.text ?? null,
        stale: line === undefined,
      };
    }),
  }));

  return {
    lists: ISSUE_CATEGORIES.map((category) => ({
      category,
      title: ISSUE_LIST_META[category].title,
      purpose: ISSUE_LIST_META[category].purpose,
      items: items.filter((item) => item.category === category),
    })),
    total: items.length,
    pending: items.filter((item) => item.confirmStatus === "pending").length,
  };
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

export type IssueGenerationResult =
  | {
      readonly kind: "ok";
      readonly board: IssueBoard;
      readonly created: number;
      /** Untouched drafts replaced by this run. */
      readonly replaced: number;
      readonly attempts: number;
    }
  | Exclude<CitedRunResult<IssueFixingOutput>, { kind: "ok" }>;

/** Flatten the three lists into the items whose citations get checked. */
function citingItems(data: IssueFixingOutput): CitingItem[] {
  return LIST_KEYS.flatMap((key) =>
    data[key].map((item, at) => ({
      label: `${key}[${at}]`,
      statement: item.statement,
      evidenceRefs: item.evidence_refs,
    })),
  );
}

/**
 * The exact bytes this stage is handed, for one case. See `buildCitedPrompt`.
 */
export function buildIssueFixingPrompt(
  db: Db,
  caseId: string,
): ReturnType<typeof buildCitedPrompt> {
  return buildCitedPrompt(db, caseId, ISSUE_FIXING_TASK);
}

export type IssuePersistResult =
  | {
      readonly kind: "ok";
      readonly board: IssueBoard;
      readonly created: number;
      /** Untouched drafts replaced by this run. */
      readonly replaced: number;
    }
  | {
      readonly kind: "invalid_refs";
      readonly audit: CitationAudit;
      readonly message: string;
    };

/**
 * Write one validated generation into the `issues` table.
 *
 * Split out of `generateIssues` because the API path is no longer the only way a
 * generation arrives: the external-session channel is handed the same output as
 * a file, and a second persist written next to it would become a second answer
 * to "what does a generation do to this table" — including, sooner or later, a
 * second answer about which refs get stored.
 *
 * The citation audit is re-run here rather than passed in, and that is the point
 * of the split rather than an accident of it. On the external channel, time
 * passes between the answer being validated and this call; on both channels the
 * ids that go into the column have to be the ones that hold at the moment of the
 * write. A generation carrying one reference that no longer stands is refused
 * whole (HARD RULE #1) — never persisted with the offending item stripped.
 */
export function persistIssues(
  db: Db,
  caseId: string,
  data: IssueFixingOutput,
): IssuePersistResult {
  const audit = auditCitations(db, caseId, citingItems(data));
  if (!audit.ok) {
    return { kind: "invalid_refs", audit, message: describeCitationFaults(audit) };
  }

  // The audit accepted these refs, in this exact order — persist the validated
  // ids rather than the model's array, so a duplicate or a re-ordering cannot
  // slip a second, unchecked value into the column.
  const accepted = new Map(audit.accepted.map((a) => [a.label, a.refs]));

  const drafts = LIST_KEYS.flatMap((key) =>
    data[key].map((item, at) => ({
      category: CATEGORY_OF[key],
      statement: item.statement,
      refs: [...(accepted.get(`${key}[${at}]`) ?? [])],
    })),
  );

  const replaced = db.transaction((tx) => {
    const stale = tx
      .delete(issuesTable)
      .where(
        and(
          eq(issuesTable.caseId, caseId),
          eq(issuesTable.confirmStatus, "pending"),
        ),
      )
      .returning({ id: issuesTable.id })
      .all().length;

    if (drafts.length > 0) {
      const keys = orderKeysBetween(null, null, drafts.length);
      tx.insert(issuesTable)
        .values(
          drafts.map((draft, at) => ({
            caseId,
            category: draft.category,
            aiDraft: draft.statement,
            evidenceRefs: draft.refs,
            orderKey: keys[at],
            confirmStatus: "pending" as const,
          })),
        )
        .run();
    }
    return stale;
  });

  return {
    kind: "ok",
    board: listIssues(db, caseId),
    created: drafts.length,
    replaced,
  };
}

/**
 * Generate the three lists for one case and persist them.
 *
 * Returns the refusal / error / invalid-citation cases as values; only
 * `kind: "ok"` has written anything.
 */
export async function generateIssues(
  db: Db,
  caseId: string,
  options: { readonly llm?: RunStageOptions } = {},
): Promise<IssueGenerationResult> {
  const run = await runCitedStage({
    db,
    caseId,
    stage: issueFixingStage,
    task: ISSUE_FIXING_TASK,
    extract: citingItems,
    llm: options.llm,
  });

  if (run.kind !== "ok") return run;

  return { ...persistIssues(db, caseId, run.data), attempts: run.attempts };
}

/* -------------------------------------------------------------------------- */
/* Review mutations                                                           */
/* -------------------------------------------------------------------------- */

export type IssueErrorCode = "not_found" | "terminal";

export class IssueError extends Error {
  readonly code: IssueErrorCode;

  constructor(code: IssueErrorCode, message: string) {
    super(message);
    this.name = "IssueError";
    this.code = code;
  }
}

/** Load one issue, proving it belongs to the case the caller named. */
function load(db: Db, caseId: string, issueId: string) {
  const row = db
    .select()
    .from(issuesTable)
    .where(and(eq(issuesTable.id, issueId), eq(issuesTable.caseId, caseId)))
    .get();
  if (row === undefined) {
    throw new IssueError(
      "not_found",
      "That item is not on this case's list any more. Refresh the page.",
    );
  }
  // `rejected` is terminal here for the same reason it is in the transcription
  // workbench: a dropped item must not be able to walk back into the pipeline
  // through a later click.
  if (row.confirmStatus === "rejected") {
    throw new IssueError(
      "terminal",
      "This item was dropped. Dropped items cannot be brought back.",
    );
  }
  return row;
}

function write(
  db: Db,
  caseId: string,
  issueId: string,
  patch: { confirmStatus: ConfirmStatus; humanFinal?: string | null },
): IssueItem {
  load(db, caseId, issueId);
  db.update(issuesTable)
    .set(patch)
    .where(and(eq(issuesTable.id, issueId), eq(issuesTable.caseId, caseId)))
    .run();

  const board = listIssues(db, caseId);
  const updated = board.lists
    .flatMap((list) => list.items)
    .find((item) => item.id === issueId);
  /* c8 ignore next -- the row was just written; it is there. */
  if (updated === undefined) throw new IssueError("not_found", "Item vanished.");
  return updated;
}

/** Accept the item as drafted. */
export function confirmIssue(
  db: Db,
  input: { caseId: string; issueId: string },
): IssueItem {
  return write(db, input.caseId, input.issueId, { confirmStatus: "confirmed" });
}

/** Replace the wording with the reviewer's own. Citations are unaffected. */
export function editIssue(
  db: Db,
  input: { caseId: string; issueId: string; text: string },
): IssueItem {
  const text = input.text.trim();
  if (text === "") {
    throw new IssueError(
      "not_found",
      "An issue cannot be blank. Rewrite it, or drop it instead.",
    );
  }
  return write(db, input.caseId, input.issueId, {
    confirmStatus: "edited",
    humanFinal: text,
  });
}

/** Drop the item: it is not part of the case's issues. Terminal. */
export function rejectIssue(
  db: Db,
  input: { caseId: string; issueId: string },
): IssueItem {
  return write(db, input.caseId, input.issueId, { confirmStatus: "rejected" });
}
