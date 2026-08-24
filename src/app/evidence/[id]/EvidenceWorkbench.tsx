"use client";

// The confirmation workbench — the interactive half of /evidence/[id].
//
// Left: the screenshot, scaled with CSS and scrolled, so the reviewer can read
// the original while judging a line. Right: one ConfirmCard per recognized
// utterance, in `order_key` order.
//
// The component owns the post-mount truth: each action returns the row the
// server wrote, and that row replaces the local one. Nothing is optimistic —
// a line only looks confirmed once the database says it is, because "did this
// actually get saved" is precisely the question this screen exists to answer.

import { useState } from "react";

import ConfirmCard from "../../../components/ConfirmCard";
import type { ActionResult } from "../../../lib/action-result";
import { summarizeConfirmProgress } from "../../../lib/confirm-progress";
import { resolveSpeaker } from "../../../lib/utterance-speaker";
import type {
  EvidenceGrade,
  EvidenceSourceType,
  UtteranceTone,
} from "../../../server/db/schema";
import type {
  WorkbenchData,
  WorkbenchEvidence,
  WorkbenchParticipant,
  WorkbenchUtterance,
} from "../../../server/evidence/workbench";
import { SPEAKER_SIDE_LABELS } from "../labels";
import {
  confirmEvidenceGradeAction,
  confirmUtteranceAction,
  rejectUtteranceAction,
  saveUtteranceAction,
  setUtteranceRetoldAction,
  setUtteranceSpeakerAction,
  setUtteranceToneAction,
} from "./actions";

/* -------------------------------------------------------------------------- */
/* Vocabulary (UI copy)                                                       */
/* -------------------------------------------------------------------------- */

const SOURCE_TYPE_LABELS: Readonly<Record<EvidenceSourceType, string>> = {
  firsthand: "First-hand original record",
  recollection: "Recollection / retelling",
  ai_processed: "AI-processed material",
  public_sentiment: "Public sentiment content",
};

const GRADES: readonly { grade: EvidenceGrade; label: string }[] = [
  { grade: "A", label: "A first-hand" },
  { grade: "B", label: "B recollection" },
  { grade: "C", label: "C AI-processed" },
  { grade: "D", label: "D public sentiment" },
];

const TONES: readonly { value: UtteranceTone | ""; label: string }[] = [
  { value: "", label: "Unlabelled" },
  { value: "serious", label: "Serious" },
  { value: "tired", label: "Worn out" },
  { value: "joking", label: "Joking" },
  { value: "sarcastic", label: "Passive-aggressive" },
];

/** Select value marking a line as a timestamp / system row (not speech). */
const TIMESTAMP_OPTION = "ts";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn a failed action into a thrown error so ConfirmCard shows it inline and
 * keeps the reviewer's text. Successes hand back the row the server wrote.
 */
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "That did not go through. Please try again.";
}

function participantName(participant: WorkbenchParticipant): string {
  return participant.displayName === null
    ? participant.pseudonym
    : `${participant.pseudonym} (${participant.displayName})`;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function EvidenceWorkbench({ data }: { data: WorkbenchData }) {
  const { participants, image } = data;

  const [evidence, setEvidence] = useState<WorkbenchEvidence>(data.evidence);
  const [rows, setRows] = useState<WorkbenchUtterance[]>([...data.utterances]);
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});

  // Before sign-off there is no final grade, so the rule's suggestion is what
  // the radio row starts on: confirming without touching it accepts the rule.
  const [gradeChoice, setGradeChoice] = useState<EvidenceGrade>(
    data.evidence.gradeFinal ?? data.evidence.gradeSuggested,
  );
  const [gradeBusy, setGradeBusy] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);

  const [zoom, setZoom] = useState(1);
  // M0 seed rows name a file that was never copied into the blob store, so the
  // image 404s. Say so, rather than showing a broken-image icon next to lines
  // the reviewer is being asked to trust.
  const [imageMissing, setImageMissing] = useState(false);

  const progress = summarizeConfirmProgress(rows.map((row) => row.confirmStatus));
  const gradeConfirmed = evidence.gradeConfirmedAt !== null;
  const complete = progress.settled && gradeConfirmed;
  // Compared against the *pending* choice, not the stored grade, so an override
  // is visible as one before it is saved as well as after.
  const gradeMovedOffRule = gradeChoice !== evidence.gradeSuggested;

  function replaceRow(next: WorkbenchUtterance): void {
    setRows((current) =>
      current.map((row) => (row.id === next.id ? next : row)),
    );
  }

  /** For controls inside the card's extension slot, which report errors here. */
  async function mutate(
    id: string,
    work: () => Promise<ActionResult<WorkbenchUtterance>>,
  ): Promise<void> {
    setRowErrors((current) => ({ ...current, [id]: null }));
    try {
      replaceRow(unwrap(await work()));
    } catch (cause) {
      setRowErrors((current) => ({ ...current, [id]: messageOf(cause) }));
    }
  }

  async function submitGrade(): Promise<void> {
    setGradeBusy(true);
    setGradeError(null);
    try {
      const next = unwrap(
        await confirmEvidenceGradeAction(evidence.id, gradeChoice),
      );
      setEvidence(next);
      // The action always writes a grade, but the type allows null (a row that
      // was never signed off); fall back rather than assert.
      setGradeChoice(next.gradeFinal ?? next.gradeSuggested);
    } catch (cause) {
      setGradeError(messageOf(cause));
    } finally {
      setGradeBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ---------------------------------------------------------------- */}
      {/* Evidence meta + grade sign-off                                    */}
      {/* ---------------------------------------------------------------- */}
      <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-600">
                Source: {SOURCE_TYPE_LABELS[evidence.sourceType]}
              </span>
              <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-600">
                Rule suggests: grade {evidence.gradeSuggested}
              </span>
              {image !== null && (
                <span className="truncate font-mono text-xs text-neutral-400">
                  {image.originalFilename ?? image.sha256.slice(0, 12)}
                </span>
              )}
            </div>
            {evidence.contentSummary !== null && (
              <p className="text-sm text-neutral-700">{evidence.contentSummary}</p>
            )}
            {evidence.gradeRationale !== null && (
              <p className="text-xs leading-relaxed text-neutral-500">
                Grading note: {evidence.gradeRationale}
              </p>
            )}
          </div>

          <span
            className={
              gradeConfirmed
                ? "shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800"
                : "shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
            }
          >
            {gradeConfirmed ? "Grade signed off" : "Grade needs sign-off"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
          <span className="text-sm text-neutral-700">Evidence grade</span>
          {GRADES.map((option) => (
            <button
              key={option.grade}
              type="button"
              disabled={gradeBusy}
              onClick={() => setGradeChoice(option.grade)}
              className={
                gradeChoice === option.grade
                  ? "rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed"
              }
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            disabled={gradeBusy}
            onClick={() => void submitGrade()}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {gradeBusy
              ? "Saving…"
              : gradeConfirmed
                ? "Update grade"
                : "Confirm grade"}
          </button>
          {gradeMovedOffRule && (
            <span className="text-xs text-amber-700">
              This differs from what the rule suggested (grade{" "}
              {evidence.gradeSuggested})
            </span>
          )}
        </div>

        {gradeError !== null && (
          <p role="alert" className="text-xs text-rose-700">
            {gradeError}
          </p>
        )}

        {/* Completion state — deliberately loud once everything is settled. */}
        {complete ? (
          <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
            ✓ This evidence is fully reviewed: all {progress.total} lines dealt
            with ({progress.confirmed} confirmed · {progress.edited} rewritten ·{" "}
            {progress.rejected} deleted), grade {evidence.gradeFinal} signed off.
          </p>
        ) : (
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
            {progress.total === 0
              ? "Nothing recognized yet: OCR has not run on this evidence, or it came back empty."
              : `${progress.pending} of ${progress.total} lines still need review`}
            {!gradeConfirmed && "; the evidence grade still needs sign-off."}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Two columns: screenshot | utterance list                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-2 lg:sticky lg:top-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-800">
              Original screenshot
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                className="rounded border border-neutral-300 px-2 py-0.5 text-sm text-neutral-700 hover:bg-neutral-100"
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="w-12 text-center font-mono text-xs text-neutral-500">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                className="rounded border border-neutral-300 px-2 py-0.5 text-sm text-neutral-700 hover:bg-neutral-100"
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
              >
                Fit width
              </button>
            </div>
          </div>

          <div className="h-[70vh] overflow-auto rounded-xl border border-neutral-200 bg-neutral-100">
            {image === null ? (
              <p className="p-6 text-sm text-neutral-500">
                This evidence has no image attached (it may be imported text
                material).
              </p>
            ) : imageMissing ? (
              <div className="flex flex-col gap-1 p-6 text-sm text-neutral-500">
                <span>
                  The original is not in this machine’s store, so it cannot be
                  shown.
                </span>
                <span className="text-xs text-neutral-400">
                  This row came from an early import that registered only the
                  filename and hash. Re-upload the same screenshot to restore the
                  image; the line-by-line review on the right is unaffected.
                </span>
                <span className="mt-1 font-mono text-xs text-neutral-400">
                  {image.originalFilename ?? image.sha256}
                </span>
              </div>
            ) : (
              // Plain <img>: the blob route already serves the exact bytes, and
              // next/image would only add a resizing hop over local files.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/blob/${image.sha256}`}
                alt="Evidence screenshot"
                onError={() => setImageMissing(true)}
                style={{ width: `${zoom * 100}%` }}
                className="block max-w-none"
              />
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-neutral-800">
              Line-by-line review ({progress.total} lines)
            </h2>
            <span className="text-xs text-neutral-500">
              {progress.pending} to review · {progress.confirmed} confirmed ·{" "}
              {progress.edited} rewritten · {progress.rejected} deleted
            </span>
          </div>

          {rows.length === 0 && (
            <p className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-500">
              Nothing has been recognized on this screenshot yet.
            </p>
          )}

          {rows.map((row, index) => {
            const speaker = resolveSpeaker(row, participants);
            // An unattributed line leaves the select on its empty option, even
            // when OCR guessed a side: the guess is shown as a chip, never
            // pre-selected as if a human had decided it.
            const speakerValue =
              speaker.kind === "participant"
                ? `p:${speaker.participantId}`
                : speaker.kind === "timestamp"
                  ? TIMESTAMP_OPTION
                  : "";
            const sideGuess =
              speaker.kind === "unassigned" && speaker.hint !== null
                ? (SPEAKER_SIDE_LABELS[speaker.hint] ?? speaker.hint)
                : null;
            const party =
              speaker.kind === "participant"
                ? participants.find((p) => p.id === speaker.participantId)
                : undefined;

            return (
              <ConfirmCard
                key={row.id}
                status={row.confirmStatus}
                aiDraft={row.aiDraft}
                humanFinal={row.humanFinal}
                error={rowErrors[row.id] ?? null}
                heading={
                  <>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-500">
                      #{index + 1}
                    </span>
                    {speaker.kind === "participant" && (
                      <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600">
                        {party === undefined
                          ? speaker.pseudonym
                          : participantName(party)}
                      </span>
                    )}
                    {speaker.kind === "timestamp" && (
                      <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500">
                        Timestamp / system row
                      </span>
                    )}
                    {sideGuess !== null && (
                      <span className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-400">
                        Unattributed · recognized position: {sideGuess}
                      </span>
                    )}
                    {/* HARD RULE #5: a recollection is framed as one, in the
                        rendering layer, wherever the quote is shown. */}
                    {row.isRetold && (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                        as you recall it, they said…
                      </span>
                    )}
                  </>
                }
                onConfirm={async () => {
                  replaceRow(
                    unwrap(await confirmUtteranceAction(evidence.id, row.id)),
                  );
                }}
                onSave={async (text) => {
                  replaceRow(
                    unwrap(await saveUtteranceAction(evidence.id, row.id, text)),
                  );
                }}
                onReject={async () => {
                  replaceRow(
                    unwrap(await rejectUtteranceAction(evidence.id, row.id)),
                  );
                }}
              >
                <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                  <input
                    type="checkbox"
                    checked={row.isRetold}
                    onChange={(event) =>
                      void mutate(row.id, () =>
                        setUtteranceRetoldAction(
                          evidence.id,
                          row.id,
                          event.target.checked,
                        ),
                      )
                    }
                    className="h-3.5 w-3.5"
                  />
                  Recollection (recalled, not recorded)
                </label>

                <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                  Tone
                  <select
                    value={row.tone ?? ""}
                    onChange={(event) =>
                      void mutate(row.id, () =>
                        setUtteranceToneAction(
                          evidence.id,
                          row.id,
                          event.target.value === ""
                            ? null
                            : (event.target.value as UtteranceTone),
                        ),
                      )
                    }
                    className="rounded border border-neutral-300 px-1.5 py-1 text-xs text-neutral-800"
                  >
                    {TONES.map((tone) => (
                      <option key={tone.value} value={tone.value}>
                        {tone.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                  Speaker
                  <select
                    value={speakerValue}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "") return;
                      void mutate(row.id, () =>
                        setUtteranceSpeakerAction(
                          evidence.id,
                          row.id,
                          value === TIMESTAMP_OPTION
                            ? { kind: "timestamp" }
                            : {
                                kind: "participant",
                                participantId: value.slice(2),
                              },
                        ),
                      );
                    }}
                    className="rounded border border-neutral-300 px-1.5 py-1 text-xs text-neutral-800"
                  >
                    <option value="" disabled>
                      Unattributed
                    </option>
                    {participants.map((participant) => (
                      <option key={participant.id} value={`p:${participant.id}`}>
                        {participantName(participant)}
                      </option>
                    ))}
                    <option value={TIMESTAMP_OPTION}>Timestamp / system row</option>
                  </select>
                </label>
              </ConfirmCard>
            );
          })}
        </section>
      </div>
    </div>
  );
}

export default EvidenceWorkbench;
