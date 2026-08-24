"use client";

// The pre-judgment confrontation screen (SPEC M3 wave A ⑥).
//
// This is the one screen in the product that is not on the reader's side, and
// the copy says so out loud. Everything here was read out of the material the
// client supplied themselves, and every item is about the client — not about
// the other person. A reader who mistakes this list for a list of the
// counterparty's failings will answer the wrong question, so the framing is
// repeated at the top, on the gate line, and in the actions.
//
// Two answers clear an item: acknowledge, or contest with a reason. They are
// treated identically by the gate on purpose. The client is not required to
// agree with any of it — only to have read it and said something. A gate that
// opened solely for agreement would be coercion, and the record the judgment is
// written from would be worth less for it.

import { useState, useTransition } from "react";

import type { ActionResult } from "../../../../lib/action-result";
import type {
  AdverseFactBoard,
  AdverseFactCitation,
  AdverseFactView,
} from "../../../../server/pipeline";
import {
  acknowledgeAdverseFactAction,
  contestAdverseFactAction,
  generateAdverseFactsAction,
} from "./actions";

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "That did not go through. Please try again.";
}

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

const STATUS_BADGE: Readonly<
  Record<AdverseFactView["ackStatus"], { label: string; className: string }>
> = {
  pending: {
    label: "Not answered yet",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  acknowledged: {
    label: "Acknowledged",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  disputed: {
    label: "Contested",
    className: "border-sky-200 bg-sky-50 text-sky-800",
  },
};

function Citation({ citation }: { citation: AdverseFactCitation }) {
  if (citation.stale) {
    return (
      <li className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        The line this rested on is no longer confirmed material.
      </li>
    );
  }
  return (
    <li className="rounded-lg bg-neutral-50 p-2 text-xs">
      <p className="mb-1 text-neutral-500">
        {/* HARD RULE #5 — the render layer frames a recollection as one. */}
        {citation.isRetold
          ? `${citation.speaker} — as you recall it, they said…`
          : citation.speaker}
      </p>
      {/* Verbatim evidence: never translated, never smoothed. */}
      <p className="leading-relaxed whitespace-pre-wrap text-neutral-800">
        {citation.text}
      </p>
    </li>
  );
}

function AdverseFactCard({
  caseId,
  item,
  onWritten,
}: {
  caseId: string;
  item: AdverseFactView;
  onWritten: (item: AdverseFactView) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"ack" | "contest" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badge = STATUS_BADGE[item.ackStatus];
  const answered = item.ackStatus !== "pending";
  const text = item.humanFinal ?? item.aiDraft ?? "";

  async function run(kind: "ack" | "contest") {
    setBusy(kind);
    setError(null);
    try {
      const written =
        kind === "ack"
          ? unwrap(
              await acknowledgeAdverseFactAction({
                caseId,
                adverseFactId: item.id,
                note,
              }),
            )
          : unwrap(
              await contestAdverseFactAction({
                caseId,
                adverseFactId: item.id,
                note,
              }),
            );
      setNote("");
      onWritten(written);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border p-4 ${
        item.ackStatus === "pending"
          ? "border-amber-200 bg-white"
          : "border-neutral-200 bg-white"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-neutral-500">
          Counts against you
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${badge.className}`}
        >
          {badge.label}
        </span>
      </header>

      <p className="text-sm leading-relaxed whitespace-pre-wrap text-neutral-900">
        {text}
      </p>

      {item.citations.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
          {item.citations.map((citation) => (
            <Citation key={citation.utteranceId} citation={citation} />
          ))}
        </ul>
      )}

      {answered ? (
        <div className="border-t border-neutral-100 pt-3">
          <p className="text-xs text-neutral-500">
            {item.ackStatus === "acknowledged"
              ? "You acknowledged this."
              : "You contested this. It still reaches the judgment, with your answer attached."}
          </p>
          {item.ackNote !== null && item.ackNote !== "" && (
            <p className="mt-1 rounded-lg bg-neutral-50 p-2 text-xs leading-relaxed whitespace-pre-wrap text-neutral-700">
              {item.ackNote}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
          <label
            htmlFor={`note-${item.id}`}
            className="text-xs text-neutral-500"
          >
            Your answer — optional if you acknowledge it, required if you
            contest it.
          </label>
          <textarea
            id={`note-${item.id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            disabled={busy !== null}
            className="w-full resize-y rounded-lg border border-neutral-300 p-2 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("ack")}
              className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {busy === "ack" ? "Saving…" : "I acknowledge this"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("contest")}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
            >
              {busy === "contest" ? "Saving…" : "I contest this"}
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
    </article>
  );
}

export function AdverseFactsPanel({
  caseId,
  initial,
}: {
  caseId: string;
  initial: AdverseFactBoard;
}) {
  const [board, setBoard] = useState<AdverseFactBoard>(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function replace(updated: AdverseFactView) {
    setBoard((current) => {
      const items = current.items.map((item) =>
        item.id === updated.id ? updated : item,
      );
      const stillPending = items.filter(
        (item) => item.ackStatus === "pending",
      ).length;
      return {
        ...current,
        items,
        counts: { total: items.length, pending: stillPending },
        acknowledged: items.filter((i) => i.ackStatus === "acknowledged").length,
        contested: items.filter((i) => i.ackStatus === "disputed").length,
        // The server owns the gate; this is the same predicate rendered
        // locally so the line does not lie between two round trips.
        gate:
          items.length === 0
            ? current.gate
            : stillPending === 0
              ? { open: true }
              : {
                  open: false,
                  code: "acknowledgement_pending",
                  reason:
                    `${stillPending} of ${items.length} adverse facts are ` +
                    "still pending. Each one has to be acknowledged or " +
                    "contested before judgment runs — this gate cannot be " +
                    "skipped.",
                },
      };
    });
  }

  function generate() {
    setFailure(null);
    startTransition(async () => {
      const result = await generateAdverseFactsAction({ caseId });
      if (!result.ok) {
        setFailure(result.message);
        return;
      }
      setBoard(result.data.board);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-4">
        <p className="text-sm leading-relaxed text-neutral-800">
          Everything below is about <strong>you</strong>, and all of it was read
          out of the material you supplied yourself. This is not a list of what
          the other person did — it is the part of your own record that a fair
          reader would hold against you.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-neutral-700">
          Acknowledge each one, or contest it and say why. Contesting is a real
          answer and counts the same as acknowledging: you are not being asked to
          agree, only to have read it. Nothing gets judged until every item here
          has an answer.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={generate}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {pending
            ? "Reading your material…"
            : board.items.length === 0
              ? "Show me what counts against me"
              : "Look again"}
        </button>
        <p className="text-xs text-neutral-500">
          {board.items.length === 0
            ? "Nothing has been surfaced yet."
            : `${board.counts.total} item(s) — ${board.acknowledged} acknowledged, ${board.contested} contested, ${board.counts.pending} unanswered.`}
        </p>
      </div>

      {board.items.length > 0 && (
        <p className="text-xs text-neutral-500">
          Looking again keeps every answer you have already given; only items you
          have not answered are replaced.
        </p>
      )}

      <p
        className={`rounded-lg border p-3 text-xs leading-relaxed ${
          board.gate.open
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : "border-amber-200 bg-amber-50 text-amber-900"
        }`}
      >
        {board.gate.open
          ? "Every adverse fact has an answer. Judgment can run."
          : board.gate.reason}
      </p>

      {failure !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-rose-200 bg-rose-50 p-3"
        >
          <p className="text-xs font-medium text-rose-900">Nothing was saved.</p>
          <p className="text-xs leading-relaxed whitespace-pre-wrap text-rose-800">
            {failure}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {board.items.map((item) => (
          <AdverseFactCard
            key={item.id}
            caseId={caseId}
            item={item}
            onWritten={replace}
          />
        ))}
      </div>
    </div>
  );
}

export default AdverseFactsPanel;
