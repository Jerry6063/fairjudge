// Evidence management — the /evidence list.
//
// A server component: it reads the encrypted local database directly, so the
// screenshots and their transcriptions never travel to the browser as data,
// only as rendered markup and one image request per thumbnail.
//
// The list is built around one honest distinction — what the machine suggested
// versus what a person has confirmed. A grade the human has not signed off on
// is rendered as a suggestion, in outline, and the per-item "n/m confirmed" is
// the transcription queue, not a quality score.

import Link from "next/link";

import { getDb } from "../../server/db";
import {
  listEvidence,
  resolveDefaultCaseId,
  summarizeEvidence,
  type EvidenceListItem,
} from "../../server/evidence";
import { UploadPanel } from "./upload-panel";
import { GRADE_LABELS } from "./labels";

// Reads a live database on every request; nothing here is prerenderable.
export const dynamic = "force-dynamic";

export default function EvidencePage() {
  let items: EvidenceListItem[];
  let caseId: string | null;
  try {
    const db = getDb();
    caseId = resolveDefaultCaseId(db);
    items = caseId === null ? [] : listEvidence(db, caseId);
  } catch (error) {
    return (
      <Shell>
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4"
        >
          <p className="text-sm font-medium text-rose-900">
            Cannot open the local database. Check FAIRJUDGE_DB_KEY in .env.local,
            or run npm run seed:import to create it.
          </p>
          <p className="font-mono text-xs break-all text-rose-700">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      </Shell>
    );
  }

  const summary = summarizeEvidence(items);

  return (
    <Shell>
      {caseId === null ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No case yet. Run <code className="font-mono">npm run seed:import</code>{" "}
          to create one, then come back and upload material.
        </p>
      ) : (
        <UploadPanel />
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium text-neutral-900">Material</h2>
          <p className="text-sm text-neutral-500">
            {summary.total} items · grade signed off {summary.gradeConfirmed}/
            {summary.total} · lines reviewed {summary.utteranceSettled}/
            {summary.utteranceTotal}
          </p>
        </div>

        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            No material yet. Upload your first screenshot to begin.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <EvidenceRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6 sm:p-10">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← Home
        </Link>
        <h1 className="text-2xl font-semibold text-neutral-900">Evidence</h1>
        <p className="text-sm text-neutral-600">
          Upload a screenshot → transcribe it locally with OCR → confirm it line
          by line. No analysis may cite a line you have not confirmed.
        </p>
      </header>

      {children}

      <footer className="mt-auto border-t border-neutral-200 pt-4">
        <p className="text-xs text-neutral-500">
          Images stay on this machine in data/blobs. Transcription and grading
          never upload the original.
        </p>
      </footer>
    </main>
  );
}

function EvidenceRow({ item }: { item: EvidenceListItem }) {
  const settled = item.utteranceTotal > 0 && item.utteranceSettled === item.utteranceTotal;

  return (
    <li className="flex gap-4 rounded-xl border border-neutral-200 bg-white p-4">
      <Link
        href={`/evidence/${item.id}`}
        className="shrink-0"
        aria-label="Open the confirmation workbench"
      >
        {item.hasImage ? (
          // Plain <img>: the bytes come from a private API route, which the
          // image optimizer has no business caching.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/evidence/${item.id}/blob`}
            alt=""
            className="h-28 w-20 rounded-lg border border-neutral-200 bg-neutral-100 object-cover object-top"
          />
        ) : (
          <span className="flex h-28 w-20 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-xs text-neutral-400">
            No image
          </span>
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <GradeBadge item={item} />
          <TranscriptionBadge item={item} />
          {item.utteranceTotal > 0 && (
            <span
              className={`text-xs ${settled ? "text-emerald-700" : "text-neutral-600"}`}
            >
              {item.utteranceSettled}/{item.utteranceTotal} lines confirmed
            </span>
          )}
        </div>

        <p className="line-clamp-2 text-sm text-neutral-700">
          {item.contentSummary ?? "(no transcription summary yet)"}
        </p>

        {item.anomaly !== null && (
          <p className="text-xs text-neutral-500">
            Anomaly check: {item.anomaly.rationale}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
          <span>{item.originalFilename ?? "(unnamed)"}</span>
          <span>{item.createdAt.toLocaleString("en-US")}</span>
          <Link
            href={`/evidence/${item.id}`}
            className="font-medium text-neutral-900 hover:underline"
          >
            {item.utteranceTotal > 0 && !settled
              ? "Review line by line →"
              : "Open workbench →"}
          </Link>
        </div>
      </div>
    </li>
  );
}

/**
 * Confirmed grades read as a solid badge; a suggestion reads as an outline with
 * the word "suggested" in front of it. Same information, but a glance down the
 * list shows which items still need a person.
 */
function GradeBadge({ item }: { item: EvidenceListItem }) {
  const grade = item.gradeFinal ?? item.gradeSuggested;
  if (grade === null) {
    return (
      <span className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500">
        Ungraded
      </span>
    );
  }

  const { name, hint, badge } = GRADE_LABELS[grade];
  const confirmed = item.gradeFinal !== null;

  return (
    <span
      title={hint}
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
        confirmed ? badge : "border-dashed border-neutral-300 text-neutral-600"
      }`}
    >
      {confirmed ? name : `suggested ${name}`}
    </span>
  );
}

function TranscriptionBadge({ item }: { item: EvidenceListItem }) {
  if (item.utteranceTotal === 0) {
    return (
      <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500">
        Not transcribed
      </span>
    );
  }
  return (
    <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700">
      {item.utteranceTotal} lines transcribed
    </span>
  );
}
