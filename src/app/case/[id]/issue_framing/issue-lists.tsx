"use client";

// The issue-fixing workspace: three lists, one ConfirmCard per item.
//
// The screen's job is to make two things impossible to miss. First, what each
// list is for — most arguments are disputes of standard wearing a dispute of
// fact's clothes, and separating them is the work. Second, what every item
// actually rests on: the cited lines are printed under the item, verbatim, in
// the language they were said in. An item whose citation stopped being
// confirmed says so rather than quietly showing nothing.
//
// No state is invented here. Each action returns the row the server wrote and
// that row replaces the local one, so a card only looks confirmed once the
// database says it is.

import { useState, useTransition } from "react";

import ConfirmCard, {
  type ConfirmCardLabels,
} from "../../../../components/ConfirmCard";
import type { ActionResult } from "../../../../lib/action-result";
import type { IssueBoard, IssueCitation, IssueItem } from "../../../../server/pipeline";
import {
  confirmIssueAction,
  editIssueAction,
  generateIssuesAction,
  rejectIssueAction,
} from "./actions";

const CARD_LABELS: Partial<ConfirmCardLabels> = {
  confirm: "This belongs on the list",
  edit: "Reword it",
  reject: "Not an issue",
  rejectArmed: "Confirm — drop it",
  draft: "Model's wording",
  emptyDraft: "(this item has no text)",
  rejectedNote:
    "Dropped. This is not one of the case's issues, and no judgment will be " +
    "written against it.",
};

/** Fail loudly inside the card: it shows the message and keeps typed text. */
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function Citation({ citation }: { citation: IssueCitation }) {
  if (citation.stale) {
    return (
      <li className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        The line this rests on is no longer confirmed material, so this item
        currently stands on nothing. Reword it or drop it.
      </li>
    );
  }
  return (
    <li className="rounded-lg bg-neutral-50 p-2 text-xs">
      <p className="mb-1 text-neutral-500">
        {/* HARD RULE #5 lives in the render layer, not in a prompt. */}
        {citation.isRetold
          ? `${citation.speaker} — as you recall it, they said…`
          : citation.speaker}
      </p>
      {/* Evidence is verbatim: never translated, never normalized. */}
      <p className="leading-relaxed whitespace-pre-wrap text-neutral-800">
        {citation.text}
      </p>
    </li>
  );
}

function IssueCard({
  caseId,
  item,
  onWritten,
}: {
  caseId: string;
  item: IssueItem;
  onWritten: (item: IssueItem) => void;
}) {
  return (
    <ConfirmCard
      status={item.confirmStatus}
      aiDraft={item.aiDraft}
      humanFinal={item.humanFinal}
      labels={CARD_LABELS}
      heading={
        <span className="text-xs text-neutral-500">
          {item.citations.length === 1
            ? "1 line cited"
            : `${item.citations.length} lines cited`}
        </span>
      }
      onConfirm={async () => {
        onWritten(unwrap(await confirmIssueAction({ caseId, issueId: item.id })));
      }}
      onSave={async (text) => {
        onWritten(
          unwrap(await editIssueAction({ caseId, issueId: item.id, text })),
        );
      }}
      onReject={async () => {
        onWritten(unwrap(await rejectIssueAction({ caseId, issueId: item.id })));
      }}
      footer={
        item.citations.length === 0 ? null : (
          <ul className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
            {item.citations.map((citation) => (
              <Citation key={citation.utteranceId} citation={citation} />
            ))}
          </ul>
        )
      }
    />
  );
}

export function IssueLists({
  caseId,
  initial,
}: {
  caseId: string;
  initial: IssueBoard;
}) {
  const [board, setBoard] = useState<IssueBoard>(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function replace(updated: IssueItem) {
    setBoard((current) => ({
      ...current,
      lists: current.lists.map((list) => ({
        ...list,
        items: list.items.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      })),
      pending: current.lists
        .flatMap((list) => list.items)
        .map((item) => (item.id === updated.id ? updated : item))
        .filter((item) => item.confirmStatus === "pending").length,
    }));
  }

  function generate() {
    setFailure(null);
    setNote(null);
    startTransition(async () => {
      const result = await generateIssuesAction({ caseId });
      if (!result.ok) {
        setFailure(result.message);
        return;
      }
      setBoard(result.data.board);
      setNote(
        `${result.data.created} item(s) drafted` +
          (result.data.replaced > 0
            ? `, replacing ${result.data.replaced} draft(s) you had not reviewed`
            : "") +
          (result.data.attempts > 1
            ? ". The first answer was rejected for citing something that does " +
              "not hold, and was re-asked."
            : "."),
      );
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={generate}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {pending
            ? "Reading the case…"
            : board.total === 0
              ? "Fix the issues"
              : "Draft the lists again"}
        </button>
        <p className="text-xs text-neutral-500">
          {board.total === 0
            ? "Nothing has been drafted yet."
            : `${board.total} item(s), ${board.pending} still waiting for you.`}
        </p>
      </div>

      {board.total > 0 && (
        <p className="text-xs text-neutral-500">
          Drafting again keeps everything you have already confirmed, reworded or
          dropped; only untouched drafts are replaced.
        </p>
      )}

      {failure !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-rose-200 bg-rose-50 p-3"
        >
          <p className="text-xs font-medium text-rose-900">
            Nothing was saved.
          </p>
          <p className="text-xs leading-relaxed whitespace-pre-wrap text-rose-800">
            {failure}
          </p>
        </div>
      )}

      {note !== null && (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
          {note}
        </p>
      )}

      {board.lists.map((list) => (
        <section key={list.category} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-neutral-900">
              {list.title}
              <span className="ml-2 text-xs font-normal text-neutral-500">
                {list.items.length}
              </span>
            </h3>
            <p className="text-xs leading-relaxed text-neutral-600">
              {list.purpose}
            </p>
          </div>

          {list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-300 p-3 text-xs text-neutral-500">
              Nothing on this list. An empty list is a real answer — it is not a
              gap to be filled.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {list.items.map((item) => (
                <IssueCard
                  key={item.id}
                  caseId={caseId}
                  item={item}
                  onWritten={replace}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export default IssueLists;
