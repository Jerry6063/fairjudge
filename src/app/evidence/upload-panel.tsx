"use client";

// The upload control on /evidence: a drop zone, a file picker, and a readout of
// what happened to each file.
//
// The readout matters more than it looks. Three outcomes are genuinely
// different and a spinner that just disappears would hide all three: the file
// was already in the case (nothing changed), the file landed but OCR failed
// (evidence stored, no lines to confirm), or the file was rejected outright.

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  EVIDENCE_ACCEPT,
  EVIDENCE_KIND_FIELD,
  EVIDENCE_MAX_FILES,
  EVIDENCE_UPLOAD_FIELD,
  type EvidenceUploadResponseBody,
  type EvidenceUploadItem,
  type EvidenceUploadRejection,
  type RegistrationKind,
} from "../../lib/evidence-contract";
import { GRADE_LABELS, KIND_LABELS, REASON_LABELS } from "./labels";

interface Outcome {
  items: EvidenceUploadItem[];
  rejected: EvidenceUploadRejection[];
}

const KIND_OPTIONS = Object.keys(KIND_LABELS) as RegistrationKind[];

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<RegistrationKind>("screenshot");
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function upload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || pending > 0) return;

    const files = Array.from(fileList).slice(0, EVIDENCE_MAX_FILES);
    const body = new FormData();
    for (const file of files) body.append(EVIDENCE_UPLOAD_FIELD, file);
    body.append(EVIDENCE_KIND_FIELD, kind);

    setPending(files.length);
    setFailure(null);
    setOutcome(null);

    try {
      const response = await fetch("/api/evidence/upload", {
        method: "POST",
        body,
      });
      const result = (await response.json()) as EvidenceUploadResponseBody;

      if (result.ok) {
        setOutcome({ items: result.items, rejected: result.rejected });
        // The list is a server component; re-render it with the new rows.
        router.refresh();
      } else {
        setFailure(
          result.detail ? `${result.error} (${result.detail})` : result.error,
        );
      }
    } catch {
      setFailure(
        "The upload did not go through. The local server may have stopped, or it returned something unexpected.",
      );
    } finally {
      setPending(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="evidence-kind" className="text-sm text-neutral-700">
          Material type
        </label>
        <select
          id="evidence-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RegistrationKind)}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {KIND_LABELS[option]}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-500">
          The grade is derived from the type and an anomaly check; you still sign
          off on the final one.
        </span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging
            ? "border-neutral-900 bg-neutral-100"
            : "border-neutral-300 bg-neutral-50"
        }`}
      >
        <p className="text-sm text-neutral-700">
          Drop screenshots here, or
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={pending > 0}
            className="mx-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            choose files
          </button>
          {EVIDENCE_MAX_FILES} at a time, at most.
        </p>
        <p className="text-xs text-neutral-500">
          Each upload is re-encoded locally (which strips EXIF capture data),
          transcribed locally with OCR, and its lines go to the confirmation
          workbench.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={EVIDENCE_ACCEPT}
          onChange={(event) => void upload(event.target.files)}
          className="hidden"
        />
      </div>

      {pending > 0 && (
        <p className="text-sm text-neutral-500">
          Processing {pending} screenshot(s): re-encoding, OCR, grading. Usually
          a few seconds each…
        </p>
      )}

      {failure !== null && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          {failure}
        </div>
      )}

      {outcome !== null && <OutcomeList outcome={outcome} />}
    </section>
  );
}

function OutcomeList({ outcome }: { outcome: Outcome }) {
  const stored = outcome.items.filter((item) => !item.duplicate);
  const duplicates = outcome.items.filter((item) => item.duplicate);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-sm font-medium text-neutral-900">
        This upload: {stored.length} added
        {duplicates.length > 0 && ` · ${duplicates.length} skipped as duplicates`}
        {outcome.rejected.length > 0 && ` · ${outcome.rejected.length} not accepted`}
      </p>

      <ul className="flex flex-col gap-1 text-xs text-neutral-600">
        {outcome.items.map((item) => (
          <li key={item.evidenceId + item.sha256}>
            <span className="text-neutral-800">
              {item.filename ?? "(unnamed)"}
            </span>
            {item.duplicate ? (
              <> · already in the case, not stored again</>
            ) : (
              <>
                {" · suggested "}
                {item.gradeSuggested
                  ? GRADE_LABELS[item.gradeSuggested].name
                  : "ungraded"}
                {item.gradeReasons.length > 0 &&
                  ` (${item.gradeReasons
                    .map((reason) => REASON_LABELS[reason])
                    .join("; ")})`}
                {` · ${item.utteranceCount} lines transcribed`}
              </>
            )}
            {item.ocrError !== undefined && (
              <span className="text-amber-700">
                {" "}
                · OCR failed; you can retry transcription later
              </span>
            )}
          </li>
        ))}
        {outcome.rejected.map((rejection, index) => (
          <li key={`${rejection.filename ?? "?"}-${index}`} className="text-rose-700">
            {rejection.filename ?? "(unnamed)"} · {rejection.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
