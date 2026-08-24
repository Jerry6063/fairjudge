// /case/[id]/judgment — the judgment, read by the person it is about.
//
// This is the product's core output, and until now it had no screen. The
// judgment was generated, validated against its contract, frozen, swap-tested
// and made exportable, and the only way anyone had ever read one was by
// running a script — because every milestone's acceptance was written as "runs /
// tests green / verified on the real case" and never once as "a person can read
// it on screen". This page is that missing half.
//
// ## The order is the argument
//
// A person about to read a judgment about their own relationship needs to know
// what kind of document it is BEFORE the findings, or the findings will be read
// as more than they are. So:
//
//   1. **What this is.** The level and what that level licenses, the derivation's
//      own reasoning for it, and the counted record basis — how many citable
//      lines there are and whose. On this case that means saying, before any
//      finding, that the person reading has not spoken inside the record at all.
//   2. **The judgment**, as a document, in its own sections. This is the
//      self-reflection copy: it carries the paragraphs that count against the
//      reader, and it is the reason the product bothers.
//   3. **The fact layer**, inspectable, every claim with its tier, confidence
//      and citations resolved to the line somebody actually said.
//   4. **Provenance.** Which model, at what effort, under which prompt version,
//      and whether the fallback answered instead.
//   5. **Frozen means frozen.**
//
// ## What this page may not do
//
// Nothing here writes. There is no edit control, no regeneration button, no
// server action imported. HARD RULE #6 makes a final judgment immutable, and a
// re-hearing is `version + 1` with a disclosed diff — which lives at
// `./versions`, already built, and is linked rather than duplicated here.
//
// Nothing here decides, either. Every value is read through
// `server/judgment/read-view.ts`, which fetches and joins and never computes a
// second opinion: the level's meaning comes from the same table the prompt is
// built from, the record basis is the judgment's own words, and the set of
// sections is the one the rendition layer defines.
//
// ## `audience` is shown, not trusted
//
// Each section's stored `audience` marking is printed, because it is what a
// filtered copy would act on and a reader is entitled to see it. It is printed
// as a stored value and nothing on this page branches on it: there is an open
// defect in how that rule behaves once both parties are in the record, and a
// screen that rendered `self_only` as a guarantee would be asserting something
// the field does not currently support.
//
// ## How it is set
//
// The page has one argument and the typography carries it: **a verdict is a
// document served by apparatus.** The judgment's own prose — the narrative, the
// record-basis statement, the level rationale, the claim statements — is set in
// the document voice, a serif at reading size on a real measure. Everything
// that describes the document rather than being it — counts, labels,
// provenance, chrome — is apparatus: system sans, smaller, quieter, never
// competing. Voice is legible from size alone, because the two ramps do not
// overlap (globals.css).
//
// Blocks are separated by whitespace and hairlines, not by cards. The bordered
// white card this page used to be built from said "these are seven separate
// things", and they are not: they are five movements of one document. One
// border survives, on the `self_only` section, because there the boundary is
// the content.
//
// The opening movement is the product's refusal surface. What it has to land is
// a number — that the person reading has not spoken inside this record — so the
// counts are set as figures, the zero in the record-basis colour at the size of
// a headline, and the level's reasoning follows it in the document's own voice.
// The rest of the movement is apparatus and may be skimmed.
//
// Evidence quoted below is Chinese, verbatim, untranslated (CLAUDE.md).

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { StageMachineError, collectCaseFacts } from "../../../../server/pipeline";
import {
  buildJudgmentReadView,
  type CitationView,
  type ClaimView,
  type JudgmentReadView,
} from "../../../../server/judgment/read-view";
import { GRADE_LABELS } from "../../../evidence/labels";
import { JudgmentDocument, Prose } from "./judgment-document";
import {
  ALLOCATION_LABELS,
  POLISH_ARCHIVE_PREAMBLE,
  POLISH_ARCHIVE_UNKNOWN,
  POLISH_ARCHIVE_WHAT_HAPPENED,
  TIER_LABELS,
  UNRESOLVED_REASON_LABELS,
} from "./labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function JudgmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let view: JudgmentReadView | null;
  try {
    const db = getDb();
    collectCaseFacts(db, id);
    view = buildJudgmentReadView(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  if (view === null) return <NoJudgmentYet caseId={id} />;

  return (
    <div className="flex flex-col gap-movement pb-16">
      <WhatThisIs view={view} />
      <TheJudgment view={view} />
      <TheFactLayer view={view} />
      <Provenance view={view} />
      <Frozen view={view} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The apparatus that introduces a movement                                   */
/* -------------------------------------------------------------------------- */

/**
 * A movement's opening: what this stretch of page is, and what it is called.
 *
 * Both lines are apparatus, and both are smaller than any document text — the
 * eyebrow is the smallest type on the product and the title is the largest
 * apparatus size, which is still under the document's body size. A label that
 * announces the judgment must not outweigh the judgment.
 */
function Movement({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="fj-eyebrow">{eyebrow}</p>
      <h2 className="fj-title">{title}</h2>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * No judgment stands on this case.
 *
 * A draft is deliberately not shown. `readCurrentJudgment` returns the highest
 * FINAL version and nothing else, and doc 02 §1.7 is explicit about why: the
 * judgment body is buffered, validated and published in one shot, because
 * live-broadcasting an unvalidated verdict to a person in a bad week is the one
 * failure this pipeline is built to avoid.
 */
function NoJudgmentYet({ caseId }: { caseId: string }) {
  return (
    <section className="flex flex-col gap-gutter">
      <Movement
        eyebrow="The judgment"
        title="No judgment has been issued on this case yet"
      />
      <p className="fj-doc fj-lead-rule fj-lead-rule-frozen">
        A judgment appears here once it has been written, checked against its
        contract and frozen — never before. A hearing in progress is not shown
        as a partial verdict.
      </p>
      <Link href={`/case/${caseId}`} className="fj-key fj-link w-fit">
        Back to the case overview
      </Link>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. What this is, before the verdict                                        */
/* -------------------------------------------------------------------------- */

function WhatThisIs({ view }: { view: JudgmentReadView }) {
  const { level, findings } = view;
  const basis = findings.record_basis;
  const counts = basis.citable_utterances;
  const silentParties = basis.parties_without_citable_utterance;
  const readerIsSilent = silentParties.includes(basis.client_pseudonym);

  return (
    <section id="before-you-read-it" className="flex flex-col gap-block">
      {/* The opening statement, in the document's voice. This is not a metadata
          header: it is the sentence that tells a person what kind of document
          they are holding, and it gets the page's largest type. */}
      <div className="flex flex-col gap-3">
        <p className="fj-eyebrow">Before you read it</p>
        <h2 className="fj-doc-lead">{level.constraints.label}</h2>
        <p className="fj-key">
          Issued at <span className="fj-ledger">{level.level}</span>
          {level.lockedAt !== null && (
            <> · level locked {level.lockedAt.toISOString().slice(0, 10)}</>
          )}
        </p>
      </div>

      {level.stale && level.derivesNow !== null && (
        <p className="fj-app fj-lead-rule fj-lead-rule-grade text-grade-ink">
          The record has moved since this judgment was written: it would derive{" "}
          <span className="fj-ledger">{level.derivesNow}</span> today. That is
          not an error and nothing has been rewritten — this judgment was written
          inside the level it names, and a record that has changed since is an
          argument for a new version, not for editing this one.
        </p>
      )}

      {/* The counted basis. Numbers first, and set as numbers: naming the level
          describes the verdict's frame, while these describe the actual hole in
          the record. The zero is the whole opening — a person is about to read
          several pages about their own relationship, and the honest headline is
          that not one line of it is theirs. So the count that is zero is set at
          headline size in the record-basis colour and the other two are context
          around it, at a size that says "context". */}
      <div className="fj-rule-top flex flex-col gap-gutter pt-8">
        <h3 className="fj-key">What this judgment could read</h3>

        <dl className="flex flex-wrap items-end gap-x-12 gap-y-6">
          <Stat label="Citable lines in total" value={String(counts.total)} />
          <Stat
            label={`Spoken by you (${basis.client_pseudonym})`}
            value={String(counts.by_client)}
            emphatic={counts.by_client === 0}
          />
          <Stat
            label="Spoken by the other party"
            value={String(counts.by_counterparty)}
          />
        </dl>

        {readerIsSilent && (
          <p className="fj-doc fj-lead-rule fj-lead-rule-basis">
            You have no citable line in this record. Everything below was written
            without a single confirmed sentence of your own in front of it.
          </p>
        )}

        {silentParties.length > 0 && !readerIsSilent && (
          <p className="fj-app">
            Parties with no citable line in the record:{" "}
            {silentParties.join(", ")}.
          </p>
        )}

        {/* The judgment's own account of its basis, verbatim. Not summarized:
            this paragraph is a finding, validated by the contract, and rewriting
            it on screen would put a second version of it in the world. It is the
            judgment speaking, so it is set in the document's voice. */}
        <Prose
          text={basis.statement}
          className="fj-doc text-doc-sm whitespace-pre-wrap"
        />
      </div>

      {/* Why this level, in the derivation's own words — HARD RULE #2 says the
          level is decided in code, so the reasoning shown here is the code's.
          It reads as the key to the whole page: the constraint is not a footnote
          on the verdict, it is the reason the verdict has the shape it has. */}
      {level.rationale !== null && (
        <div className="fj-rule-top flex flex-col gap-3 pt-8">
          <h3 className="fj-key">Why this level and not another</h3>
          <p className="fj-doc text-doc-sm">{level.rationale}</p>
          {level.findings.length > 0 && <Hanging items={level.findings.map((f) => f.statement)} />}
        </div>
      )}

      <div className="fj-rule-top flex flex-col gap-3 pt-8">
        <h3 className="fj-key">What a judgment at this level may not do</h3>
        <Hanging items={level.constraints.forbids} />
      </div>
    </section>
  );
}

/**
 * A list of constraints, hung off an em dash rather than bulleted.
 *
 * Apparatus voice: these are the rules the judgment was written under, and a
 * reader should be able to check them without being asked to read them.
 */
function Hanging({ items }: { items: readonly string[] }) {
  return (
    <ul className="fj-app flex flex-col gap-2">
      {items.map((item) => (
        <li key={item} className="grid grid-cols-[0.9rem_minmax(0,1fr)]">
          <span aria-hidden className="text-ink-3">
            —
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One counted number from the record basis.
 *
 * `emphatic` is not decoration. It fires when a count is the finding — on this
 * case, that the reader has zero citable lines — and it is the only place on
 * the page where a number is given headline weight.
 */
function Stat({
  label,
  value,
  emphatic = false,
}: {
  label: string;
  value: string;
  emphatic?: boolean;
}) {
  return (
    // `dt` leads in the DOM (the order `dl` requires, and the order a screen
    // reader wants); `flex-col-reverse` puts the figure on top on screen.
    <div className="flex flex-col-reverse gap-1">
      <dt className={`fj-key ${emphatic ? "text-basis-ink" : ""}`}>{label}</dt>
      <dd className={emphatic ? "fj-figure fj-figure-zero" : "fj-figure-quiet"}>
        {value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. The judgment itself                                                     */
/* -------------------------------------------------------------------------- */

function TheJudgment({ view }: { view: JudgmentReadView }) {
  const criticism = view.criticismSectionIds.length;

  return (
    <section className="flex flex-col gap-block">
      <Movement eyebrow="Your copy" title="The judgment">
        <p className="fj-app pt-1">
          This is the self-reflection copy. It carries every section of the
          judgment, including{" "}
          {criticism === 0
            ? "any part written for you alone"
            : `the ${criticism} ${criticism === 1 ? "section" : "sections"} written for you alone`}{" "}
          — the parts that count against you. Nothing is filtered out of it, and
          it is never the document anyone else is handed.
        </p>
      </Movement>

      <JudgmentDocument sections={view.sections} polish={view.polish} />

      <p className="fj-app fj-rule-top pt-5">
        Each section carries a stored <span className="fj-ledger">audience</span>{" "}
        marking. It is the field a filtered copy acts on, printed here so it can
        be inspected — this screen does not verify that a section is marked
        correctly, and it does not use the marking for anything: your copy
        carries every section either way.{" "}
        {view.hasShareableNarrative
          ? "The copy the other party would receive is a separate document, written to her from the same frozen fact layer rather than produced by filtering this one."
          : "No document addressed to the other party has been generated for this judgment."}
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. The fact layer                                                          */
/* -------------------------------------------------------------------------- */

function TheFactLayer({ view }: { view: JudgmentReadView }) {
  const { claims, findings } = view;
  const cited = claims.filter((claim) => !claim.uncitedByContract);
  const uncited = claims.filter((claim) => claim.uncitedByContract);

  return (
    <section className="flex flex-col gap-block">
      <Movement
        eyebrow="Underneath the prose"
        title={`The ${claims.length} claims this rests on`}
      >
        <p className="fj-app pt-1">
          Every sentence above is bound to one of these, and every one of these
          is either grounded in a line somebody actually said or says out loud
          that it is not. {cited.length} cite the record; {uncited.length} state
          what the record cannot settle and cite nothing.
        </p>
      </Movement>

      {/* Hairline-separated rows, not cards. Twenty bordered boxes in a column
          is twenty assertions that these are twenty separate objects; they are
          one ledger. */}
      <ol className="flex flex-col">
        {claims.map((claim) => (
          <ClaimRow key={claim.claimId} claim={claim} />
        ))}
      </ol>

      {findings.unresolved.length > 0 && (
        <div className="fj-rule-top flex flex-col gap-4 pt-8">
          <h3 className="fj-key">Questions this hearing left open</h3>
          <ul className="flex flex-col gap-5">
            {findings.unresolved.map((item) => (
              <li key={item.question} className="flex flex-col gap-1">
                <Prose text={item.question} className="fj-doc text-doc-sm" />
                <p className="fj-key">
                  {UNRESOLVED_REASON_LABELS[item.reason] ?? item.reason}
                  {item.claim_ids.length > 0 && (
                    <>
                      {" · "}
                      {item.claim_ids.map((claimId, index) => (
                        <span key={claimId}>
                          {index > 0 && ", "}
                          <a
                            href={`#claim-${claimId}`}
                            className="fj-ledger fj-link"
                          >
                            {claimId}
                          </a>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="fj-rule-top flex flex-col gap-3 pt-8">
        <h3 className="fj-key">Responsibility</h3>
        {findings.responsibility.length === 0 ? (
          <p className="fj-doc text-doc-sm">
            This judgment allocates responsibility to nobody. At this level that
            is not an omission and not a tie — it is the honest encoding of a
            hearing that was not in a position to allocate any. There is no
            percentage anywhere in this product, and no field one could be
            written into.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {findings.responsibility.map((item) => (
              <li key={item.party} className="flex flex-col gap-1">
                <p className="fj-doc text-doc-sm">
                  <span className="font-semibold">{item.party}</span> —{" "}
                  {ALLOCATION_LABELS[item.allocation] ?? item.allocation}
                </p>
                <p className="fj-key">
                  Rests on{" "}
                  {item.claim_ids.map((claimId, index) => (
                    <span key={claimId}>
                      {index > 0 && ", "}
                      <a href={`#claim-${claimId}`} className="fj-ledger fj-link">
                        {claimId}
                      </a>
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One claim, as a ledger row.
 *
 * The tier used to be a coloured pill. It is not a quality score — the three
 * tiers are three different relationships to the record — so it is set as
 * apparatus text and nothing else, and the only tier that gets a mark is
 * `unknown`, on the note that explains why it is empty.
 */
function ClaimRow({ claim }: { claim: ClaimView }) {
  const tier = TIER_LABELS[claim.tier];

  return (
    <li
      id={`claim-${claim.claimId}`}
      className="fj-record-row flex scroll-mt-8 flex-col gap-3 py-6"
    >
      <div className="fj-key flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="fj-ledger text-ink-2">{claim.claimId}</span>
        <span title={tier.hint}>{tier.name}</span>
        <span aria-hidden>·</span>
        <span className="fj-ledger">
          confidence {claim.confidence.toFixed(2)}
        </span>
        {claim.citedBySectionIds.length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>
              cited by{" "}
              {claim.citedBySectionIds.map((sectionId, index) => (
                <span key={sectionId}>
                  {index > 0 && ", "}
                  <a href={`#section-${sectionId}`} className="fj-link">
                    {sectionId}
                  </a>
                </span>
              ))}
            </span>
          </>
        )}
      </div>

      <Prose text={claim.statement} className="fj-doc text-doc-sm" />

      {claim.uncitedByContract ? (
        <p className="fj-app fj-lead-rule fj-lead-rule-basis">
          Cites nothing, and that is the finding. A claim the record cannot
          settle must cite nothing: if the record showed it, it would not be
          unknown. This is a gap stated on purpose, not evidence that went
          missing.
        </p>
      ) : (
        <ul className="flex max-w-[var(--measure-document)] flex-col gap-3">
          {claim.citations.map((citation) => (
            <Citation key={citation.utteranceId} citation={citation} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One cited line, resolved to the words somebody actually said.
 *
 * This is the whole point of the fact layer being on screen: a reader has to be
 * able to go from a sentence in the narrative to the line underneath it. So the
 * text is the stored utterance, verbatim and untranslated, with no excerpting.
 */
function Citation({ citation }: { citation: CitationView }) {
  if (citation.stale || citation.text === null) {
    return (
      <li className="fj-app fj-lead-rule fj-lead-rule-grade text-grade-ink">
        <span className="fj-ledger">{citation.utteranceId}</span> — the line this
        claim rests on is no longer confirmed material in this case. The judgment
        is frozen and still cites it; it can no longer be shown.
      </li>
    );
  }

  const grade = citation.evidenceGrade;

  return (
    <li className="fj-verbatim-block">
      <p className="fj-key mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* HARD RULE #5 — the render layer frames a recollection as one. */}
        <span>
          {citation.isRetold
            ? `${citation.speaker} — as you recall it, they said…`
            : citation.speaker}
        </span>
        <span aria-hidden>·</span>
        {/* The grade is a fact about the evidence, not a rating of it. The
            colour-coded pill it used to wear came from the evidence workbench,
            where a grader is choosing between grades; here nobody is choosing,
            so it is set as apparatus text like every other stored value. */}
        {grade !== null && (
          <span title={GRADE_LABELS[grade].hint}>
            {GRADE_LABELS[grade].name}
          </span>
        )}
        {grade === null && <span>grade not signed off</span>}
      </p>
      {/* Verbatim evidence: never translated, never smoothed, never italicized —
          slanted CJK is a distortion of the glyphs rather than emphasis. Set in
          the document voice at document size, because a cited line is the one
          thing on this page that is neither the judgment nor apparatus: it is
          the record itself, and it gets a ground of its own to say so. */}
      <p
        lang="zh"
        className="fj-doc text-doc-sm whitespace-pre-wrap not-italic"
      >
        {citation.text}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Provenance                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Who decided this and how.
 *
 * On a product whose whole claim is procedural honesty this is not a footnote.
 * `fallback_used` in particular is the sticky-routing disclosure HARD RULE #7
 * exists for: a request can be silently routed away from the model that was
 * asked for, and the reader of a judgment is entitled to know a different model
 * wrote it.
 */
function Provenance({ view }: { view: JudgmentReadView }) {
  const p = view.provenance;
  const polish = view.polish;

  return (
    <section className="flex flex-col gap-block">
      <Movement eyebrow="Provenance" title="Who decided this, and how" />

      {/* Apparatus at its most literal: a table of stored values, tabular and
          skippable. Nothing here is prose and nothing here is styled to look
          like prose. */}
      <dl className="grid gap-x-12 sm:grid-cols-2">
        <Field label="Written by" value={p.model} mono />
        <Field
          label="Reasoning effort"
          value={p.effort ?? "not recorded"}
          mono={p.effort !== null}
        />
        <Field
          label="Prompt version"
          value={p.promptVersion ?? "not recorded"}
          mono={p.promptVersion !== null}
        />
        <Field
          label="Served by the fallback model"
          value={p.fallbackUsed ? "yes" : "no"}
        />
        <Field label="Version" value={String(p.version)} />
        <Field label="Status" value={p.status} />
        <Field
          label="Frozen at"
          value={
            p.frozenAt === null
              ? "not frozen"
              : p.frozenAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"
          }
        />
        <Field label="Judgment id" value={p.judgmentId} mono />
      </dl>

      {p.fallbackUsed && (
        <p className="fj-app fj-lead-rule fj-lead-rule-grade text-grade-ink">
          This request was routed away from the model it was addressed to and
          answered by the fallback. A different model wrote this text than the
          one the pipeline asked for.
        </p>
      )}

      {/* Only for the judgments that were produced while the GPT polish layer
          existed. The layer is gone (doc 02 §1.1a), so on a judgment with no
          archived run there is no second model in this judgment's provenance
          and nothing to disclose — the block does not render at all rather than
          explaining an absent feature. */}
      {polish.ran && (
        <div className="fj-rule-top flex flex-col gap-3 pt-8">
          <h3 className="fj-key">Language polish (removed layer)</h3>
          {/* Never asserts a rewrite unless the row says `applied`. The sentence
              is selected by the outcome rather than written over it — see
              `POLISH_ARCHIVE_PREAMBLE` in ./labels for the defect this closes. */}
          <p className="fj-app">
            {POLISH_ARCHIVE_PREAMBLE}{" "}
            {polish.outcome === null
              ? POLISH_ARCHIVE_UNKNOWN
              : POLISH_ARCHIVE_WHAT_HAPPENED[polish.outcome]}
          </p>
          <dl className="grid gap-x-12 sm:grid-cols-2">
            <Field label="Outcome" value={polish.outcome ?? "unknown"} />
            <Field
              label="Polished by"
              value={polish.model ?? "no model was reached"}
              mono={polish.model !== null}
            />
            <Field
              label="Prompt version"
              value={polish.promptVersion ?? "not recorded"}
              mono={polish.promptVersion !== null}
            />
            <Field
              label="Ran at"
              value={
                polish.ranAt === null
                  ? "not recorded"
                  : polish.ranAt.toISOString().replace("T", " ").slice(0, 19) +
                    " UTC"
              }
            />
          </dl>
          {polish.reason !== null && (
            <p className="fj-app">
              Recorded reason: {polish.reason}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="fj-record-row flex flex-col gap-0.5 py-3">
      <dt className="fj-key">{label}</dt>
      <dd
        className={`text-app break-all text-ink-1 ${mono ? "fj-ledger" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. Frozen means frozen                                                     */
/* -------------------------------------------------------------------------- */

function Frozen({ view }: { view: JudgmentReadView }) {
  const { versionsInChain, version } = view.provenance;

  return (
    <section className="fj-lead-rule fj-lead-rule-frozen flex flex-col gap-4">
      <h2 className="fj-key">This judgment cannot be edited</h2>
      <p className="fj-app">
        Nothing on this screen changes it. A judgment that has been issued is
        never rewritten — re-hearing the case writes version {version + 1} and
        leaves this one exactly as it is, so the text you read today is the text
        that will still be here afterwards. A new version has to disclose what
        changed and which model produced it.
      </p>
      <p className="fj-app">
        {versionsInChain > 1
          ? `This case has ${versionsInChain} versions.`
          : "This case has one version, so there is nothing to compare it against yet."}
      </p>
      <div className="flex flex-wrap items-center gap-4 pt-1">
        <Link
          href={`/case/${view.caseId}/judgment/versions`}
          className="fj-control w-fit"
        >
          {versionsInChain > 1
            ? "Compare the versions"
            : "Open the version history"}
        </Link>
        {/*
         * The only inbound link to the share screen. That screen holds the one
         * artifact that ever leaves this machine, so it is reached from here —
         * after the judgment has been read — rather than from the stage list,
         * where it would be a button you could press without reading anything.
         */}
        <Link href={`/case/${view.caseId}/share`} className="fj-control w-fit">
          See what the other person would receive
        </Link>
        <Link href={`/case/${view.caseId}`} className="fj-key fj-link w-fit">
          Back to the case overview
        </Link>
      </div>
    </section>
  );
}
