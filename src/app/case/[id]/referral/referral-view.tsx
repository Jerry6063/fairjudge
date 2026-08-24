// The crisis-referral page's rendering — HARD RULE #9.
//
// A pure, synchronous component over a plain object. It does no IO, awaits
// nothing, and imports nothing but constants: every string on this page is
// either in `server/safety/resources.ts` or came out of one SELECT the page
// already did. There is no loading state here because there is nothing to load.
//
// Two deliberate absences:
//
//   1. **No `next/link`.** Every navigation off this page is a plain `<a>`, so
//      it works before hydration, without JavaScript, and on a page the router
//      has never prefetched. A crisis page that needs a framework to be usable
//      is a crisis page with a failure mode.
//   2. **No quotes from the case.** The categories say what was found; the
//      sentence that tripped the screen is not read back to the person who
//      wrote it.
//
// The copy itself is bound by `FORBIDDEN_REFERRAL_PHRASES`: nothing on this path
// may tell a person that responsibility is shared. `tests/safety-referral.test.ts`
// renders this component and greps the output for every phrase on that list.

import {
  CRISIS_RESOURCES,
  REFERRAL_EXPLANATION,
  REFERRAL_HEADLINE,
  REFERRAL_NEXT_STEPS,
  REFERRAL_RESOURCE_NOTE,
  REGION_LABELS,
  RESOURCE_REGIONS,
  type ResourceRegion,
} from "../../../../server/safety/resources";
import type { ReferralView } from "../../../../server/safety/screen-record";

/** Which layer refused, in the user's words rather than the column's. */
const SCREEN_TYPE_LABEL: Readonly<Record<string, string>> = {
  keyword: "the local safety rules, at intake",
  llm: "the safety screening pass, at intake",
  pre_judgment: "the safety re-screen run before judgment",
};

export function ReferralPanel({ view }: { view: ReferralView }) {
  if (!view.referred) return <NotReferred caseId={view.caseId} />;

  return (
    <>
      <section
        // `alert` rather than `status`: this is the whole reason the page
        // exists, and a screen reader should not have to reach it in order.
        role="alert"
        aria-labelledby="referral-headline"
        className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-5"
      >
        <h2
          id="referral-headline"
          className="text-lg font-medium text-rose-900"
        >
          {REFERRAL_HEADLINE}
        </h2>

        {REFERRAL_EXPLANATION.map((paragraph) => (
          <p key={paragraph.slice(0, 32)} className="text-sm leading-relaxed text-rose-900">
            {paragraph}
          </p>
        ))}

        {view.categories.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-rose-200 pt-3">
            <p className="text-xs font-medium text-rose-800">
              What the screen found
            </p>
            <ul className="flex flex-wrap gap-2">
              {view.categories.map((item) => (
                <li
                  key={item.category}
                  className="rounded-full border border-rose-300 bg-white px-2 py-0.5 text-xs text-rose-900"
                >
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section
        aria-labelledby="crisis-resources"
        className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="crisis-resources"
            className="text-base font-medium text-neutral-900"
          >
            People who can help
          </h2>
          <p className="text-sm text-neutral-600">{REFERRAL_RESOURCE_NOTE}</p>
        </div>

        {RESOURCE_REGIONS.map((region) => (
          <ResourceGroup key={region} region={region} />
        ))}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          What happens to this case
        </h2>
        <ul className="flex flex-col gap-2">
          {REFERRAL_NEXT_STEPS.map((step) => (
            <li key={step.slice(0, 32)} className="text-sm text-neutral-600">
              {step}
            </li>
          ))}
        </ul>
        <p className="text-sm">
          <a
            href={`/case/${view.caseId}`}
            className="text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
          >
            Back to the case
          </a>
        </p>
      </section>

      <Provenance view={view} />
    </>
  );
}

/**
 * One region's resources.
 *
 * `resourcesForRegion` is deliberately not used: filtering the same constant
 * twice is cheaper to read here, and this component must stay a pure map over a
 * frozen list with no call that could ever grow a dependency.
 */
function ResourceGroup({ region }: { region: ResourceRegion }) {
  const resources = CRISIS_RESOURCES.filter((item) => item.region === region);
  if (resources.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        {REGION_LABELS[region]}
      </h3>
      <ul className="flex flex-col gap-2">
        {resources.map((resource) => (
          <li
            key={resource.id}
            className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3"
          >
            <p className="text-sm font-medium text-neutral-900">
              {resource.name}
              {resource.localName !== undefined && (
                // The official local name is evidence of a sort: it is what the
                // person will meet on the other end of the line, so it is never
                // translated away (CLAUDE.md language policy).
                <span className="ml-2 font-normal text-neutral-500">
                  {resource.localName}
                </span>
              )}
            </p>
            <p className="font-mono text-sm text-neutral-900">
              {resource.contact}
            </p>
            <p className="text-xs text-neutral-600">{resource.description}</p>
            <p className="text-xs text-neutral-500">{resource.hours}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The audit line: which layer stopped this, and when. */
function Provenance({ view }: { view: ReferralView }) {
  const label =
    view.screenType === null
      ? null
      : (SCREEN_TYPE_LABEL[view.screenType] ?? view.screenType);

  return (
    <section className="flex flex-col gap-1 border-t border-neutral-200 pt-4">
      <p className="text-xs text-neutral-500">
        {label === null
          ? "Recorded by the safety screen."
          : `Recorded by ${label}.`}
        {view.screenedAt !== null &&
          ` ${view.screenedAt.toISOString().slice(0, 10)}.`}
      </p>
      {view.rationale !== null && (
        <p className="text-xs text-neutral-500">{view.rationale}</p>
      )}
      <p className="text-xs text-neutral-500">
        This page is fixed text and one local database read. No model was called
        to produce it, and nothing about this case left the device.
      </p>
    </section>
  );
}

/**
 * The page reached on a case that was never referred.
 *
 * A 404 would be wrong twice: the case exists, and a person who has just typed
 * or bookmarked this URL is not helped by being told nothing is here.
 */
function NotReferred({ caseId }: { caseId: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
      <h2 className="text-base font-medium text-neutral-900">
        This case is not on the referral path.
      </h2>
      <p className="text-sm text-neutral-600">
        No safety screen has refused it, so the pipeline is still open. The
        crisis resources below are here anyway — they are a fixed list, and
        there is no reason to make anyone qualify for them.
      </p>
      {RESOURCE_REGIONS.map((region) => (
        <ResourceGroup key={region} region={region} />
      ))}
      <p className="text-sm">
        <a
          href={`/case/${caseId}`}
          className="text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
        >
          Back to the case
        </a>
      </p>
    </section>
  );
}
