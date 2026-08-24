// /case — every case on this machine.
//
// This used to resolve "the case" and forward to it, because there was only ever
// one and no way to make a second. Now that `/case/new` exists, forwarding would
// hide the thing it was standing in for.
//
// What this list deliberately does not have: progress bars, stage counts,
// completeness percentages, anything sortable by size. Doc 04 §7 rules out
// dashboards, and a list of conflicts is where one appears by accident — a
// column that looks like completeness invites the reading that a fuller case is
// a stronger one, and in this product the gaps in a record are findings about it.
//
// The fixture label is product content, not a debug flag: a demonstration case
// says so wherever it is named, because a page that shows an invented conflict
// without saying it is invented is the one lie this product cannot afford.

import Link from "next/link";

import { listCases, type CaseListItem } from "../../server/cases";
import { getDb } from "../../server/db";
import { STAGE_META } from "../../server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Badge copy for the derived level. Matches the case shell's wording. */
const LEVEL_LABEL: Readonly<Record<string, string>> = {
  L1: "L1 · full judgment",
  L2: "L2 · one-sided perspective analysis",
  L3: "L3 · narrative analysis only",
  refused: "Refused",
};

const STATUS_LABEL: Readonly<Record<string, string>> = {
  open: "Open",
  closed: "Closed",
  archived: "Archived",
};

/** A stored date, rendered as a date. No locale, no clock, no relative time. */
function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function CaseRow({ item }: { item: CaseListItem }) {
  const stage = STAGE_META[item.stage];
  return (
    <li className="rounded-xl border border-neutral-200 bg-white">
      <Link
        href={`/case/${item.id}`}
        className="flex flex-col gap-2 p-5 hover:bg-neutral-50"
      >
        {item.isFixture && (
          <p className="w-fit rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
            Fictional demonstration case — every person in it is invented
          </p>
        )}
        <h2 className="text-base font-medium text-neutral-900">
          {item.title ?? "Untitled case"}
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600">
          <span>
            Stage {stage.index} · {stage.title}
          </span>
          <span aria-hidden className="text-neutral-300">
            |
          </span>
          <span>
            {item.outputLevel === null
              ? "No level locked yet"
              : (LEVEL_LABEL[item.outputLevel] ?? item.outputLevel)}
          </span>
          <span aria-hidden className="text-neutral-300">
            |
          </span>
          <span>{STATUS_LABEL[item.status] ?? item.status}</span>
          <span aria-hidden className="text-neutral-300">
            |
          </span>
          <span>Filed {day(item.createdAt)}</span>
        </div>
      </Link>
    </li>
  );
}

/**
 * What a case is, for somebody looking at nothing.
 *
 * An empty list is the only place this can be explained before a person has
 * committed anything, so it says what filing produces and what it costs rather
 * than inviting them to start and find out.
 */
function EmptyState() {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-300 bg-neutral-50 p-6">
      <h2 className="text-base font-medium text-neutral-900">
        There are no cases on this machine.
      </h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-neutral-700">
        <p>
          A case is one conflict, held as a record: your account of it, the
          messages and screenshots behind that account, and a written document
          produced from what the record will actually support.
        </p>
        <p>
          What it supports is computed before the document is written. One
          person&apos;s account gets the record laid out with its gaps named,
          and an evaluation of that person&apos;s own conduct. It does not get
          an allocation of fault — that needs the other person to answer, and
          nothing but their answering changes it.
        </p>
        <p>
          Nothing is quoted anywhere until you confirm it line by line, and both
          names are replaced with placeholders before any text leaves this
          machine.
        </p>
      </div>
      <Link
        href="/case/new"
        className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
      >
        File the first case
      </Link>
    </section>
  );
}

export default function CaseIndexPage() {
  let items: CaseListItem[] = [];
  let failure: string | null = null;
  try {
    items = listCases(getDb());
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
        <Link
          href="/"
          className="w-fit text-sm text-neutral-500 hover:text-neutral-800"
        >
          ← Home
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold">Cases</h1>
          {failure === null && items.length > 0 && (
            <Link
              href="/case/new"
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              File a case
            </Link>
          )}
        </div>

        {failure !== null ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4"
          >
            <p className="text-sm font-medium text-rose-900">
              Cannot open the local database, so this list is not a statement
              about how many cases exist. Check FAIRJUDGE_DB_KEY in .env.local.
            </p>
            <p className="font-mono text-xs break-all text-rose-700">
              {failure}
            </p>
          </div>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <CaseRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
