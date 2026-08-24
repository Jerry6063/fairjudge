// /respond/[token]/data — the transparency view (SPEC M5 ④).
//
// The entry screen tells her what exists as a shape: counts, dates, grades. This
// is the page where she reads the record itself, item by item, with provenance
// on every row and the control she actually has next to it. The two are
// deliberately different screens: being told that forty lines of her own speech
// are on file is what makes the choices real, and being shown them is a heavier
// act that should be one she chooses.
//
// Three things this page must never do, each of which it would be easy to do by
// accident:
//
//   1. **Imply it can erase the other party's records.** Every row he submitted
//      offers "ask", the button says so, and the outcome banner after the click
//      says `asked`. The system does not delete one person's records because
//      the other asked, and no copy on this page may suggest otherwise.
//   2. **Show what it is not entitled to show.** The view is built by
//      `access/transparency.ts`, which resolves that question against the
//      database. This file renders what it is given and reaches for nothing else.
//   3. **Hide its own gaps.** The limits are printed at the bottom, including
//      the category that is withheld on purpose, and empty sections are rendered
//      as empty rather than dropped — "nothing of this kind is on file" is
//      information, and a missing heading is not.
//
// Every act here is a POST through a server action. Nothing on this page
// performs a write by being looked at.

import {
  deleteOwnItem,
  requestDeletion,
  revokeNamedRendition,
} from "./actions";
import { loadTransparencyPage } from "./transparency";
import type {
  TransparencyItem,
  TransparencyRight,
  TransparencySection,
  TransparencyView,
} from "../../../../server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** What just happened, said in one line and never overstated. */
const OUTCOME_MESSAGE: Readonly<Record<string, string>> = {
  deleted:
    "Deleted. It is gone from this machine, and the deletion is written to a " +
    "log that cannot be edited afterwards.",
  asked:
    "Your request is recorded and will be shown to the person who submitted " +
    "that material. Nothing has been deleted: it is theirs, and this program " +
    "does not remove one person's records because the other asked. Their " +
    "answer, including a refusal, will appear on this page.",
  revoked:
    "Withdrawn. No document naming you can be exported or shared from here " +
    "while that stands.",
  refused_not_your_material:
    "That material was submitted by the other party, so it is not yours to " +
    "delete. You can ask for it to be removed instead.",
  refused_target_is_yours:
    "That one is yours — you can delete it outright rather than asking.",
  refused_target_not_found: "That item is no longer on file.",
  refused_bad_target: "That request did not name anything this page can act on.",
};

function outcomeLine(outcome: string | undefined): string | null {
  if (outcome === undefined) return null;
  if (outcome in OUTCOME_MESSAGE) return OUTCOME_MESSAGE[outcome];
  if (outcome.startsWith("refused_")) {
    return "That link is no longer valid, so nothing was done.";
  }
  return null;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  you: "you submitted it",
  "the other party": "the other party submitted it",
  "the system": "this program generated it",
  unattributed: "nobody is recorded as having submitted it",
};

/** A stored date, rendered as a date. No locale, no clock, no relative time. */
function day(value: Date | null): string {
  return value === null ? "no date on file" : value.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export default async function TransparencyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { token } = await params;
  const { outcome } = await searchParams;
  const result = loadTransparencyPage(token);

  if (!result.ok) {
    return (
      <section
        aria-labelledby="transparency-refused"
        className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5"
      >
        <h1
          id="transparency-refused"
          className="text-xl font-medium text-neutral-900"
        >
          This link did not open anything.
        </h1>
        <p className="text-sm leading-relaxed text-neutral-700">
          {result.message}
        </p>
        <p className="text-sm leading-relaxed text-neutral-600">
          Nothing about any case is on this page. A link that cannot be verified
          is shown nothing, so a wrong or expired one cannot become a way to read
          about somebody.
        </p>
      </section>
    );
  }

  const { view, rights } = result.data;
  const banner = outcomeLine(outcome);

  return (
    <>
      <section aria-labelledby="transparency-title" className="flex flex-col gap-3">
        <h1
          id="transparency-title"
          className="text-2xl font-semibold text-neutral-900"
        >
          Everything this machine holds about you on this case
        </h1>
        <p className="text-sm leading-relaxed text-neutral-700">
          {view.total} item{view.total === 1 ? "" : "s"}, listed in full below
          with where each one came from. This record calls you{" "}
          <span className="font-medium">{view.pseudonym}</span>. Your real name
          is not used inside it and is never sent anywhere.
        </p>
        <p className="text-xs text-neutral-500">
          Read on {day(view.generatedAt)}. Nothing on this page is sent anywhere
          by opening it.
        </p>
      </section>

      {banner !== null && (
        <p
          role="status"
          className="rounded-lg border border-neutral-300 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-800"
        >
          {banner}
        </p>
      )}

      <RightsSection
        rights={view.rights}
        token={token}
        canRevoke={rights.consent.named_rendition !== "revoked"}
      />

      {view.sections.map((section) => (
        <SectionBlock key={section.id} section={section} token={token} />
      ))}

      <LimitsSection view={view} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* What she controls                                                          */
/* -------------------------------------------------------------------------- */

const STANDING_LABEL: Readonly<Record<string, string>> = {
  granted: "you have granted this",
  revoked: "you have withdrawn this",
  unrecorded: "nobody has asked you about this",
};

function RightsSection({
  rights,
  token,
  canRevoke,
}: {
  rights: readonly TransparencyRight[];
  token: string;
  canRevoke: boolean;
}) {
  return (
    <section
      aria-labelledby="transparency-rights"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-5"
    >
      <h2
        id="transparency-rights"
        className="text-lg font-medium text-neutral-900"
      >
        What you can do about it
      </h2>

      <ul className="flex flex-col gap-3">
        {rights.map((right) => (
          <li key={right.id} className="text-sm leading-relaxed text-neutral-700">
            {right.statement}
            {right.standing !== null && (
              <span className="ml-1 text-neutral-500">
                Right now: {STANDING_LABEL[right.standing] ?? right.standing}.
              </span>
            )}
          </li>
        ))}
      </ul>

      {canRevoke && (
        <form action={revokeNamedRendition} className="flex flex-col gap-2 pt-1">
          <input type="hidden" name="token" value={token} />
          <label
            htmlFor="revoke-note"
            className="text-xs font-medium text-neutral-600"
          >
            If you want to say why, in your own words — it is stored exactly as
            you write it (optional)
          </label>
          <input
            id="revoke-note"
            name="note"
            type="text"
            className="rounded-lg border border-neutral-300 p-2 text-sm"
          />
          <button
            type="submit"
            className="self-start rounded-lg border border-neutral-400 px-3 py-2 text-sm font-medium text-neutral-900"
          >
            Withdraw consent for any document naming me to leave this machine
          </button>
        </form>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One section                                                                */
/* -------------------------------------------------------------------------- */

function SectionBlock({
  section,
  token,
}: {
  section: TransparencySection;
  token: string;
}) {
  return (
    <section
      aria-labelledby={`section-${section.id}`}
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5"
    >
      <div className="flex flex-col gap-1">
        <h2
          id={`section-${section.id}`}
          className="text-lg font-medium text-neutral-900"
        >
          {section.title}{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({section.items.length})
          </span>
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          {section.explanation}
        </p>
      </div>

      {section.items.length === 0 ? (
        // An empty section is rendered, not dropped: "nothing of this kind is on
        // file" is information, and a missing heading is not.
        <p className="text-sm text-neutral-500">Nothing of this kind is on file.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {section.items.map((item) => (
            <ItemRow key={`${item.table}:${item.id}`} item={item} token={token} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ item, token }: { item: TransparencyItem; token: string }) {
  return (
    <li className="flex flex-col gap-2 border-t border-neutral-100 pt-3 first:border-0 first:pt-0">
      {/* Evidence is quoted in the language it was said in, never translated. */}
      <p className="text-sm leading-relaxed break-words text-neutral-900">
        {item.summary}
      </p>

      <p className="text-xs text-neutral-500">
        {SOURCE_LABEL[item.provenance.source] ?? item.provenance.source}
        {item.provenance.submittedByPseudonym !== null &&
          ` (${item.provenance.submittedByPseudonym})`}
        {` · ${day(item.provenance.submittedAt)}`}
        {item.provenance.grade !== null && ` · grade ${item.provenance.grade}`}
        {item.provenance.grade === null &&
          item.provenance.gradeSuggested !== null &&
          ` · grade suggested ${item.provenance.gradeSuggested}, not confirmed`}
        {item.provenance.confirmStatus !== null &&
          ` · ${item.provenance.confirmStatus}`}
        {item.provenance.visibility !== null &&
          ` · ${item.provenance.visibility === "case" ? "in the shared case record" : "private to whoever submitted it"}`}
        {` · here because ${item.because}`}
      </p>

      {item.control === "delete" && item.targetKind !== null && (
        <form action={deleteOwnItem} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="kind" value={item.targetKind} />
          <input type="hidden" name="id" value={item.targetId ?? item.id} />
          <input
            name="reason"
            type="text"
            placeholder="Why, if you want to say (optional)"
            className="min-w-48 flex-1 rounded-lg border border-neutral-300 p-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg border border-neutral-400 px-3 py-2 text-sm font-medium text-neutral-900"
          >
            Delete this
          </button>
        </form>
      )}

      {item.control === "request_deletion" && item.targetKind !== null && (
        <form action={requestDeletion} className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-neutral-600">
            The other party submitted this, so it is not yours to delete and this
            program will not delete it for you. You can ask. Your request is
            recorded and shown to them, and their answer — including a refusal —
            is recorded and shown to you.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="kind" value={item.targetKind} />
            <input type="hidden" name="id" value={item.targetId ?? item.id} />
            <input
              name="reason"
              type="text"
              placeholder="Why you want it removed, in your own words (optional)"
              className="min-w-48 flex-1 rounded-lg border border-neutral-300 p-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-lg border border-neutral-400 px-3 py-2 text-sm font-medium text-neutral-900"
            >
              Ask for this to be deleted
            </button>
          </div>
        </form>
      )}

      {item.control === "revoke_consent" && (
        <p className="text-xs leading-relaxed text-neutral-600">
          This is a document, not material either of you submitted, so there is
          nothing here to delete. What you control is whether it may leave this
          machine — the consent above.
        </p>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The limits, printed rather than documented                                 */
/* -------------------------------------------------------------------------- */

function LimitsSection({ view }: { view: TransparencyView }) {
  return (
    <section
      aria-labelledby="transparency-limits"
      className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-5"
    >
      <h2
        id="transparency-limits"
        className="text-lg font-medium text-neutral-900"
      >
        What this page does not show you
      </h2>
      {view.limits.map((limit) => (
        <p
          key={limit.slice(0, 32)}
          className="text-sm leading-relaxed text-neutral-700"
        >
          {limit}
        </p>
      ))}
    </section>
  );
}
