"use client";

/**
 * ConfirmCard — the one card the whole product confirms things with.
 *
 * Every AI product in fairjudge is stored as the same triple (`ai_draft` /
 * `human_final` / `confirm_status`), so every human-in-the-loop step is the
 * same three decisions: accept the draft, rewrite it, or throw it away. This
 * component owns that interaction and nothing else — it holds no domain
 * knowledge, does no I/O, and never decides what a row means.
 *
 * Used by the M2 evidence workbench for OCR lines; the M3 steelman and the
 * three issue lists reuse it as-is. Everything page-specific goes into the
 * `children` slot (the workbench puts the retold / tone / speaker controls
 * there), and
 * the copy is overridable through `labels`.
 *
 * Handler contract: a handler that resolves succeeded and a handler that
 * rejects failed. The card shows the rejection message inline and keeps the
 * reviewer's text, so nothing typed is lost to a failed save.
 */

import { useState, type ReactNode } from "react";

import type { ConfirmStatus } from "../server/db/schema";

/** Overridable copy. Defaults are the confirmation-workbench wording. */
export interface ConfirmCardLabels {
  confirm: string;
  edit: string;
  reject: string;
  rejectArmed: string;
  save: string;
  cancel: string;
  draft: string;
  emptyDraft: string;
  rejectedNote: string;
}

const DEFAULT_LABELS: ConfirmCardLabels = {
  confirm: "Confirm",
  edit: "Rewrite",
  reject: "Delete",
  rejectArmed: "Confirm delete",
  save: "Save",
  cancel: "Cancel",
  draft: "Recognized text",
  emptyDraft: "(no text was recognized on this line)",
  rejectedNote:
    "Deleted. No later analysis can cite this line, and it can no longer be changed.",
};

const STATUS_META: Readonly<
  Record<ConfirmStatus, { readonly label: string; readonly badge: string }>
> = {
  pending: {
    label: "Needs review",
    badge: "border-amber-200 bg-amber-50 text-amber-800",
  },
  confirmed: {
    label: "Confirmed",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  edited: {
    label: "Rewritten",
    badge: "border-sky-200 bg-sky-50 text-sky-800",
  },
  rejected: {
    label: "Deleted",
    badge: "border-neutral-200 bg-neutral-100 text-neutral-500",
  },
};

/** Card frame per status — pending stays visually loud until it is dealt with. */
const CARD_FRAME: Readonly<Record<ConfirmStatus, string>> = {
  pending: "border-amber-200 bg-white",
  confirmed: "border-neutral-200 bg-white",
  edited: "border-neutral-200 bg-white",
  rejected: "border-neutral-200 bg-neutral-50",
};

export interface ConfirmCardProps {
  /** Row heading — an index badge, a speaker chip, whatever identifies it. */
  heading?: ReactNode;
  /** The machine's draft. Kept visible as provenance after a rewrite. */
  aiDraft: string | null;
  /** The human-owned text; null until the row is confirmed or rewritten. */
  humanFinal: string | null;
  status: ConfirmStatus;
  /** Extension slot under the text: page-specific metadata controls. */
  children?: ReactNode;
  /** Pinned to the card's bottom, below the actions. */
  footer?: ReactNode;
  /** Copy overrides. */
  labels?: Partial<ConfirmCardLabels>;
  /** Disables every action (parent-owned lock, e.g. an unrelated save). */
  disabled?: boolean;
  /** Externally-owned error (e.g. from a control in `children`). */
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onSave: (text: string) => void | Promise<void>;
  onReject: () => void | Promise<void>;
}

type Busy = "confirm" | "save" | "reject" | null;

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return "That did not go through. Please try again.";
}

export function ConfirmCard({
  heading,
  aiDraft,
  humanFinal,
  status,
  children,
  footer,
  labels,
  disabled = false,
  error = null,
  onConfirm,
  onSave,
  onReject,
}: ConfirmCardProps) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const text = humanFinal ?? aiDraft ?? "";

  // `null` means "not editing" — distinct from editing an empty textarea.
  const [draft, setDraft] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const rejected = status === "rejected";
  const locked = disabled || busy !== null;
  const editing = draft !== null;
  const showsDraft = aiDraft !== null && humanFinal !== null && humanFinal !== aiDraft;

  async function run(kind: Exclude<Busy, null>, action: () => void | Promise<void>) {
    setBusy(kind);
    setFailure(null);
    try {
      await action();
      if (kind === "save") setDraft(null);
      if (kind === "reject") setArmed(false);
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border p-4 ${CARD_FRAME[status]}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{heading}</div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_META[status].badge}`}
        >
          {STATUS_META[status].label}
        </span>
      </header>

      {editing ? (
        <textarea
          aria-label="Rewrite this line"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
          disabled={locked}
          className="w-full resize-y rounded-lg border border-neutral-300 p-2 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
        />
      ) : (
        <p
          className={
            rejected
              ? "text-sm leading-relaxed whitespace-pre-wrap text-neutral-400 line-through"
              : "text-sm leading-relaxed whitespace-pre-wrap text-neutral-900"
          }
        >
          {text === "" ? (
            <span className="text-neutral-400 italic">{copy.emptyDraft}</span>
          ) : (
            text
          )}
        </p>
      )}

      {showsDraft && !editing && (
        <p className="rounded-lg bg-neutral-50 p-2 text-xs leading-relaxed whitespace-pre-wrap text-neutral-500">
          <span className="mr-1 font-medium text-neutral-600">{copy.draft}:</span>
          {aiDraft}
        </p>
      )}

      {children !== undefined && !rejected && (
        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-100 pt-3">
          {children}
        </div>
      )}

      {rejected ? (
        <p className="text-xs text-neutral-500">{copy.rejectedNote}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                disabled={locked}
                onClick={() => void run("save", () => onSave(draft))}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
              >
                {busy === "save" ? "Saving…" : copy.save}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setDraft(null);
                  setFailure(null);
                }}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
              >
                {copy.cancel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={locked}
                onClick={() => void run("confirm", onConfirm)}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
              >
                {busy === "confirm" ? "Confirming…" : copy.confirm}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  setDraft(text);
                  setFailure(null);
                }}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
              >
                {copy.edit}
              </button>
              {armed ? (
                <>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void run("reject", onReject)}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
                  >
                    {busy === "reject" ? "Deleting…" : copy.rejectArmed}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setArmed(false)}
                    className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-neutral-800"
                  >
                    {copy.cancel}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setArmed(true)}
                  className="ml-auto rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-neutral-300"
                >
                  {copy.reject}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {(failure ?? error) !== null && (
        <p role="alert" className="text-xs text-rose-700">
          {failure ?? error}
        </p>
      )}

      {footer}
    </article>
  );
}

export default ConfirmCard;
