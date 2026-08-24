"use client";

// The judgment itself, set as a document — plus the archived-wording control on
// the judgments that have one.
//
// This is a client component for exactly one reason: the toggle holds state.
// Nothing here fetches, nothing here writes, and no server action is imported —
// both versions of the text arrive as props, already read out of the frozen
// judgment and the archived polish run. A judgment is frozen (HARD RULE #6),
// and the screen that reads one owns no path that could edit it.
//
// ## When the control renders at all
//
// The GPT polish layer was removed on 2026-08-16 (doc 02 §1.1a), so for every
// judgment produced since, no polish run exists, there is no second wording, and
// **nothing renders here** — a disabled toggle labelled "the unpolished
// original" would advertise a capability the product no longer has, which is a
// worse lie than silence.
//
// A judgment that DOES carry a run still gets the control, because those runs
// happened and the reader of one of those judgments is entitled to both
// wordings. Only an `applied` run rewrote the frozen text, so on the other
// outcomes the control is present but inert and the note says which outcome it
// was: "attempted and discarded" and "attempted and applied" are different
// facts about the document being read.
//
// ## Typography — the document voice
//
// Everything here is set in `--font-document` (globals.css): a serif, at
// reading size, on a real measure, at 1.8 leading. It is the only voice on the
// product that is the judgment SPEAKING; every label around it is apparatus and
// is smaller and quieter by construction. The quoted Chinese inside these
// paragraphs is marked as an object rather than emphasized — see
// `splitVerbatim` in ./labels for why, and why it is never italicized.
//
// ## The three roles a section can play
//
// A judgment is not a flat list of paragraphs, and rendering it as one loses the
// argument's shape. `SectionView.kind` already distinguishes three things, and
// each one is given a different position on the page rather than a different
// colour:
//
//   - **finding** — the document proper. Nothing between the reader and it.
//   - **disclosure** — about this judgment, not about the case. Inset behind a
//     neutral lead rule, in the quieter ink: it is the document describing its
//     own conditions, and it should read as a step back from the prose.
//   - **limits** — what the judgment cannot decide. Bracketed by rules and set
//     apart, so it FRAMES the findings instead of trailing after them as an
//     apology. On this product the limits are load-bearing: they are the honest
//     half of a one-sided hearing.
//
// And one role comes from `audience` rather than `kind`: a `self_only` section
// is the one place on this page that gets a border. See below.

import { useState, type ReactNode } from "react";

import type { PolishView, SectionView } from "../../../../server/judgment/read-view";
import {
  AUDIENCE_LABELS,
  POLISH_OUTCOME_LABELS,
  SECTION_KIND_LABELS,
  splitVerbatim,
} from "./labels";

/** What the toggle is showing. */
type Reading = "as_issued" | "original";

export function JudgmentDocument({
  sections,
  polish,
}: {
  sections: readonly SectionView[];
  polish: PolishView;
}) {
  const [reading, setReading] = useState<Reading>("as_issued");

  // The original is only a different document when a polished draft was applied.
  // Anything else means the two are the same text, and offering to switch
  // between them would be theatre.
  const hasDistinctOriginal =
    polish.ran && polish.polishedTextIsWhatIsShown && polish.sections.length > 0;

  const originalById = new Map(
    polish.sections.map((section) => [section.sectionId, section]),
  );
  const showOriginal = hasDistinctOriginal && reading === "original";

  return (
    <div className="flex flex-col gap-block">
      {/* Nothing to choose between, and no feature that could have produced a
          second wording — so no control. See the header. */}
      {polish.ran && (
        <div className="fj-lead-rule fj-lead-rule-frozen flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="fj-eyebrow">Which wording</span>
            <div
              role="group"
              aria-label="Which wording of the judgment to show"
              className="flex overflow-hidden rounded-bounded border border-hairline-strong"
            >
              <button
                type="button"
                onClick={() => setReading("as_issued")}
                aria-pressed={!showOriginal}
                className={`px-3 py-1 text-app-sm ${
                  showOriginal
                    ? "text-ink-2 hover:text-ink-1"
                    : "bg-ink-1 text-paper-raised"
                }`}
              >
                As issued
              </button>
              <button
                type="button"
                onClick={() => setReading("original")}
                aria-pressed={showOriginal}
                disabled={!hasDistinctOriginal}
                className={`border-l border-hairline-strong px-3 py-1 text-app-sm ${
                  showOriginal
                    ? "bg-ink-1 text-paper-raised"
                    : hasDistinctOriginal
                      ? "text-ink-2 hover:text-ink-1"
                      : "cursor-not-allowed text-ink-3"
                }`}
              >
                The unpolished original
              </button>
            </div>
          </div>

          <p className="fj-app">
            {POLISH_OUTCOME_LABELS[polish.outcome ?? "skipped"] ??
              "A polish run is recorded for this judgment."}
            {!hasDistinctOriginal && polish.outcome === "applied" && (
              <>
                {" "}
                No per-section comparison was stored with that run, so the two
                wordings cannot be shown side by side here.
              </>
            )}{" "}
            The polish layer has since been removed from this product; this run
            is an archived record of it.
          </p>

          {showOriginal && (
            <p className="fj-app text-grade-ink">
              You are reading the wording before the polish pass. The findings,
              claims and quotes are identical — the polish layer could only
              change phrasing, and it never saw the fact layer.
            </p>
          )}
        </div>
      )}

      <article className="flex flex-col gap-block">
        {sections.map((section) => {
          const original = originalById.get(section.sectionId);
          const heading =
            showOriginal && original !== undefined
              ? original.originalHeading
              : section.heading;
          const text =
            showOriginal && original !== undefined
              ? original.originalText
              : section.text;

          return (
            <Section
              key={section.sectionId}
              section={section}
              heading={heading}
              text={text}
              polishNote={
                showOriginal && original !== undefined
                  ? original.changed
                    ? "the polish pass changed this section"
                    : "the polish pass left this section alone"
                  : null
              }
            />
          );
        })}
      </article>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One section, in the role its kind and audience give it                     */
/* -------------------------------------------------------------------------- */

function Section({
  section,
  heading,
  text,
  polishNote,
}: {
  section: SectionView;
  heading: string;
  text: string;
  polishNote: string | null;
}) {
  const isSelfOnly = section.storedAudience === "self_only";
  const isLimits = section.kind === "limits";
  const isDisclosure = section.kind === "disclosure";

  // `self_only` earns the page's only border. Everything else is separated by
  // whitespace and a rule, per the token layer's first rule.
  const frame = isSelfOnly
    ? "fj-bounded px-7 pt-6 pb-0 mt-4"
    : isLimits
      ? "fj-frame my-4 py-9"
      : isDisclosure
        ? "fj-lead-rule fj-lead-rule-frozen"
        : "";

  return (
    <section
      id={`section-${section.sectionId}`}
      className={`flex scroll-mt-8 flex-col gap-3 ${frame}`}
    >
      {/* `limits` and `disclosure` announce their role BEFORE the heading, in
          the vocabulary they already had: a reader arriving at the limits
          should know they are the frame before reading a word of them, and the
          kind label is exactly that sentence. It moves up here rather than
          being invented, and drops out of the footer below so it is said once.
          A `self_only` section names its own boundary the same way — with the
          phrase the page already uses for it two screens up. */}
      {(isLimits || isDisclosure) && (
        <p className={`fj-eyebrow ${isLimits ? "text-basis-ink" : ""}`}>
          {SECTION_KIND_LABELS[section.kind] ?? section.kind}
        </p>
      )}
      {isSelfOnly && <p className="fj-eyebrow">Written for you alone</p>}

      <h3 className={`fj-doc-head ${isDisclosure ? "text-ink-2" : ""}`}>
        {heading}
      </h3>

      {/* Verbatim evidence is quoted inside this prose in Chinese and is never
          translated (CLAUDE.md). It is marked as an object rather than
          italicized, and it carries no `lang` attribute: the paragraph really is
          mixed, and the CJK sizing is handled at the font layer instead (see
          the @font-face block in globals.css). */}
      <Prose
        text={text}
        className={`fj-doc whitespace-pre-wrap ${
          isDisclosure ? "text-doc-sm text-ink-2" : ""
        }`}
      />

      {/* A `self_only` section says where it stops on a line of its own, under
          a rule — a lock, not a badge. The wording is the stored marking and
          nothing more: `AUDIENCE_LABELS` is deliberately phrased as a field
          rather than a promise (see ./labels), and a lock line reading "this
          stays with you" would be the render layer asserting a guarantee the
          product does not make. The design says "bounded"; the words stay
          honest. Everything else keeps the marking in the apparatus footer with
          the rest of the section's metadata. */}
      {isSelfOnly ? (
        <>
          <SectionMeta
            section={section}
            polishNote={polishNote}
            includeAudience={false}
            includeKind
          />
          <p className="fj-lock-line -mx-7 mt-3 px-7 py-3">
            Audience {AUDIENCE_LABELS[section.storedAudience]}
          </p>
        </>
      ) : (
        <SectionMeta
          section={section}
          polishNote={polishNote}
          includeAudience
          includeKind={!isLimits && !isDisclosure}
        />
      )}

    </section>
  );
}

/** The apparatus line under a section: what it is, who it is for, what it rests on. */
function SectionMeta({
  section,
  polishNote,
  includeAudience,
  includeKind,
}: {
  section: SectionView;
  polishNote: string | null;
  includeAudience: boolean;
  includeKind: boolean;
}) {
  // Assembled as a list so the interpuncts fall between whatever is actually
  // present — a limits section drops its kind label into the eyebrow above and
  // must not be left with a leading separator.
  const parts: ReactNode[] = [];
  if (includeKind) {
    parts.push(SECTION_KIND_LABELS[section.kind] ?? section.kind);
  }
  if (includeAudience) {
    parts.push(`Audience ${AUDIENCE_LABELS[section.storedAudience]}`);
  }
  if (section.claimIds.length > 0) {
    parts.push(
      <>
        Rests on{" "}
        {section.claimIds.map((claimId, index) => (
          <span key={claimId}>
            {index > 0 && ", "}
            <a href={`#claim-${claimId}`} className="fj-ledger fj-link">
              {claimId}
            </a>
          </span>
        ))}
      </>,
    );
  }
  if (polishNote !== null) {
    parts.push(<span className="text-grade-ink">{polishNote}</span>);
  }

  return (
    <p className="fj-key flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
      {parts.map((part, index) => (
        <span key={index} className="contents">
          {index > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </span>
      ))}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Prose, with the record's own words marked as the record's                  */
/* -------------------------------------------------------------------------- */

/**
 * A paragraph of the judgment, with quoted evidence set as an object.
 *
 * Exported because the fact layer's claim statements quote the record in
 * exactly the same way and must be marked identically — the distinction between
 * the document's voice and the record's is a property of the product, not of
 * one component.
 */
export function Prose({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {splitVerbatim(text).map((run, index) =>
        run.verbatim ? (
          <span key={index} className="fj-verbatim">
            {run.text}
          </span>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </div>
  );
}
