// /case/[id]/share — the copy that leaves this machine.
//
// Everything else in this product is a person looking at their own case. This
// screen is a person deciding whether to hand a document about somebody else to
// that somebody, and it cannot be taken back. Four things follow from that, and
// they are the whole layout:
//
//   1. **The document is shown in full, exactly as she receives it.** Not a
//      summary, not the client's copy, not an excerpt behind a "preview" link —
//      the counterparty-addressed narrative, framed, with the label she reads
//      first and the way in she reads last. Anyone about to send this has to
//      have read every word of it, and a screen that made that optional would be
//      the product's most consequential omission.
//   2. **The export gate is reported check by check, not as a tick.** What each
//      check examined and what it concluded, including the quote it exempted and
//      why. The exemption is a ruling (SPEC M4 decision record) and a reader is
//      entitled to audit it rather than trust it.
//   3. **Consent is a state with a history, not an error at click time.** If it
//      has been withdrawn this page says so before anything else is offered, and
//      it says the honest part too: a copy already exported cannot be recalled.
//   4. **There is no one-click distribution.** A file and a clipboard, and that
//      is the ceiling. Every copy taken writes one row in the log at the bottom.
//
// And when the judgment being previewed is L1, the page says — above the
// document — that the known audience defect applies to what is on screen. A
// screen that renders a document with a known unfairness in it and stays quiet
// has picked the document's side.
//
// Nothing is computed here. Everything comes from `server/judgment/share-view`,
// which runs the real modules' own checks, so this page cannot drift into a
// second opinion about what the gate would do.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { getDb } from "../../../../server/db";
import type { ConsentRecord } from "../../../../server/access/consent";
import { StageMachineError, collectCaseFacts } from "../../../../server/pipeline";
import type { ExportAuditRecord } from "../../../../server/judgment";
import {
  SEND_INTENT_QUESTION,
  readSharePreview,
  type GateCheck,
  type L1AudienceDefect,
  type PreSendDisclosure,
  type QuoteRuleEntry,
  type SharePreview,
} from "../../../../server/judgment/share-view";
import { SendPanel } from "./send-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let read: ReturnType<typeof readSharePreview>;
  try {
    const db = getDb();
    collectCaseFacts(db, id);
    read = readSharePreview(db, id);
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  if (!read.ok) {
    return (
      <Panel>
        <Heading
          eyebrow="The copy that leaves this machine"
          title="There is no document to show"
          lede="This screen only ever shows the counterparty's copy of a frozen judgment. Until one exists there is nothing to read, and nothing to send."
        />
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm leading-relaxed whitespace-pre-wrap text-neutral-700">
          {read.problem.message}
        </p>
        {read.problem.hint !== null && (
          <p className="text-xs text-neutral-500">
            Generate it with{" "}
            <span className="font-mono">{read.problem.hint}</span>.
          </p>
        )}
        <BackLinks caseId={id} />
      </Panel>
    );
  }

  const preview = read.preview;
  const consentBlocked = preview.consent.exportBlocked;

  return (
    <>
      {preview.l1Defect !== null && (
        <L1DefectNotice defect={preview.l1Defect} preview={preview} />
      )}

      <DocumentPanel preview={preview} />
      <GatePanel preview={preview} />
      <ConsentPanel preview={preview} />
      <BeforeYouSendPanel preview={preview} consentBlocked={consentBlocked} />
      <ExportLogPanel exports={preview.exports} />

      <Panel>
        <BackLinks caseId={preview.caseId} />
      </Panel>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The known defect (SPEC M5 decision record, 2026-08-14 — OPEN)              */
/* -------------------------------------------------------------------------- */

/**
 * The one thing on this screen that is not about the export.
 *
 * It renders above the document because it is about the document, and because
 * the alternative — a note at the bottom, after somebody has already read and
 * accepted the thing — is how a disclosure becomes decoration.
 */
function L1DefectNotice({
  defect,
  preview,
}: {
  defect: L1AudienceDefect;
  preview: SharePreview;
}) {
  return (
    <section
      role="alert"
      className="flex flex-col gap-3 rounded-xl border-2 border-rose-300 bg-rose-50 p-5"
    >
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-rose-800 uppercase">
          Known open defect — it applies to the document below
        </p>
        <h2 className="text-lg font-medium text-rose-950">
          At L1 the audience rule inverts, and this judgment is{" "}
          {defect.judgmentLevel}
        </h2>
      </div>

      <p className="text-sm leading-relaxed text-rose-950">
        <span className="font-medium">
          What is on this screen is not fair to {preview.recipient.pseudonym}, and
          the fault is the rule rather than the document.
        </span>{" "}
        <code className="font-mono text-xs">audience: self_only</code> is a fixed
        property of a section. At L2 it does the right thing: it keeps criticism of
        the client out of a copy going to someone who was never asked. At L1 both
        parties are participants and the same rule produces the opposite of
        fairness — the half of the responsibility finding that is against her is
        marked for everyone, and the half against him is marked for him alone. She
        receives the finding against herself and not the one against him. Recorded
        in the SPEC M5 decision record on 2026-08-14, with a recommended answer
        (make <code className="font-mono text-xs">audience</code> level-aware), and
        not yet implemented.
      </p>

      {defect.responsibility.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-rose-800">
            What the frozen fact layer allocates
          </p>
          <ul className="flex flex-col gap-0.5">
            {defect.responsibility.map((finding) => (
              <li key={finding.party} className="text-xs text-rose-900">
                <span className="font-medium">{`${finding.party}: ${finding.allocation}`}</span>
                {` — resting on ${finding.claim_ids.length} claim`}
                {finding.claim_ids.length === 1 ? "" : "s"} (
                <span className="font-mono">{finding.claim_ids.join(", ")}</span>)
              </li>
            ))}
          </ul>
        </div>
      )}

      {defect.withheldFromRecipient.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-rose-800">
            Sections {preview.recipient.pseudonym} does not receive — headings
            only, because naming them is the disclosure and printing them would be
            the leak
          </p>
          <ul className="flex flex-col gap-0.5">
            {defect.withheldFromRecipient.map((section) => (
              <li key={section.sectionId} className="text-xs text-rose-900">
                <span className="font-mono text-rose-700">
                  {section.sectionId}
                </span>{" "}
                [{section.kind}] {section.heading}
              </li>
            ))}
          </ul>
        </div>
      )}

      {defect.assertedToRecipient.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-rose-800">
            And the copy she does receive asserts an allocation she cannot see
          </p>
          {defect.assertedToRecipient.map((assertion, index) => (
            <div
              key={`${assertion.sectionId}-${index}`}
              className="rounded-lg border border-rose-200 bg-white p-3"
            >
              <p className="text-xs text-rose-700">
                {assertion.heading} — {assertion.label}
              </p>
              <p className="text-sm leading-relaxed text-rose-950">
                …{assertion.excerpt}…
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs leading-relaxed text-rose-900">
        The export gate will not catch this. Every check below can pass on a
        document that is unfair in exactly this way, because none of them is about
        which finding reached which reader.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

function DocumentPanel({ preview }: { preview: SharePreview }) {
  const { judgment, rendition } = preview;

  return (
    <Panel>
      <Heading
        eyebrow="The copy that leaves this machine"
        title={`What ${preview.recipient.pseudonym} receives, in full`}
        lede="Read it before deciding anything else on this page. This is the counterparty-addressed narrative — a second document written to her from the same frozen fact layer, not the client's copy with sections removed — rendered by the same function the export uses, so these are the bytes."
      />

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600">
        <Fact label="Judgment">
          v{judgment.version} · {judgment.outputLevel} · {judgment.status}
        </Fact>
        <Fact label="Rendition">
          revision {rendition.revision}
          {rendition.model === null ? "" : ` · ${rendition.model}`}
          {rendition.effort === null ? "" : ` at ${rendition.effort}`}
          {rendition.fallbackUsed ? " · SERVED BY FALLBACK" : ""}
        </Fact>
        <Fact label="Written">{utc(rendition.generatedAt)}</Fact>
        <Fact label="Size">{preview.documentBytes} bytes</Fact>
        <Fact label="Recipient">
          {preview.recipient.pseudonym} — {preview.recipient.basis}
        </Fact>
      </dl>

      <article className="rounded-lg border border-neutral-300 bg-white p-5 sm:p-6">
        <pre className="font-sans text-[0.9rem] leading-7 whitespace-pre-wrap text-neutral-900">
          {preview.document}
        </pre>
      </article>

      <p className="text-xs leading-relaxed text-neutral-500">
        sha256 <span className="font-mono">{preview.documentSha256}</span> — of the
        document as shown. An exported copy hashes differently: it carries a
        watermark line on top, stamped with the id of its own audit row.
      </p>

      {/* How the document ends depends on whether the caller holds a door. A
          file or clipboard copy holds none, so it ends on words rather than on
          a link — and the gate refuses any rendition carrying a `/respond`
          pointer that does not resolve. */}
      <p className="text-xs leading-relaxed text-neutral-600">
        This copy ends without a link. A file or a clipboard copy is handed over
        outside this machine and carries no token, so rather than printing a{" "}
        <span className="font-mono">/respond</span> address that would fail when
        she followed it, the last line names who holds the invitation and tells
        her to ask for one. The gate refuses any copy that carries an
        unresolvable pointer, so this cannot drift back. A minted link is the
        other case: the document behind it ends on the link she is already
        holding.
      </p>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

function GatePanel({ preview }: { preview: SharePreview }) {
  const { gate } = preview;
  const blockedCount = gate.checks.filter(
    (check) => check.verdict === "blocked",
  ).length;

  return (
    <Panel>
      <Heading
        eyebrow="The export gate"
        title={
          gate.blocked
            ? `${blockedCount} check${blockedCount === 1 ? "" : "s"} would refuse this export`
            : "Every check, and what each one looked at"
        }
        lede="These are the gate's own checks, run over the document above in the order the export runs them. This report writes nothing — an audit row means a copy left, and nothing has. The export re-runs all of it for real."
      />

      <ol className="flex flex-col gap-3">
        {gate.checks.map((check) => (
          <GateCheckCard key={check.id} check={check} />
        ))}
      </ol>

      <QuoteTable
        quotes={gate.quotes}
        recipientPseudonym={preview.recipient.pseudonym}
      />

      <p className="text-xs leading-relaxed text-neutral-500">
        The watermark the export will stamp on top:{" "}
        <span className="font-mono">{gate.previewWatermark}</span> — the zeroes are
        where the audit row&apos;s id goes. It names no one: the id resolves to a
        row on this machine that knows who received the copy, so a leaked copy is
        traceable without the copy itself identifying anybody.
      </p>
    </Panel>
  );
}

function GateCheckCard({ check }: { check: GateCheck }) {
  const frame =
    check.verdict === "blocked"
      ? "border-rose-300 bg-rose-50"
      : "border-neutral-200 bg-white";

  return (
    <li className={`flex flex-col gap-2 rounded-lg border p-4 ${frame}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase ${
            check.verdict === "blocked"
              ? "border-rose-400 text-rose-800"
              : "border-neutral-300 text-neutral-600"
          }`}
        >
          {check.verdict === "blocked" ? "Would refuse" : "Passed"}
        </span>
        <h3 className="text-sm font-medium text-neutral-900">{check.title}</h3>
      </div>

      <p className="text-xs leading-relaxed text-neutral-600">{check.rule}</p>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-500">What it examined</p>
        <ul className="flex flex-col gap-0.5">
          {check.examined.map((item, index) => (
            <li
              key={index}
              className="text-xs leading-relaxed text-neutral-700 before:mr-1.5 before:text-neutral-400 before:content-['·']"
            >
              {item}
            </li>
          ))}
        </ul>
      </div>

      <p
        className={`text-sm leading-relaxed ${
          check.verdict === "blocked" ? "text-rose-900" : "text-neutral-900"
        }`}
      >
        {check.conclusion}
      </p>

      {check.findings.map((finding, index) => (
        <div
          key={index}
          className="flex flex-col gap-1 rounded border border-rose-200 bg-white p-3"
        >
          <p className="text-xs leading-relaxed text-rose-900">
            {finding.detail}
          </p>
          {finding.excerpt !== undefined && (
            <p className="border-l-2 border-rose-300 pl-2 text-xs leading-relaxed text-neutral-800">
              {finding.excerpt}
            </p>
          )}
        </div>
      ))}
    </li>
  );
}

/**
 * Every verbatim span the gate found, and what the rule decided about each.
 *
 * The exemption is the reason this table exists. "A long quote passed because it
 * is the recipient's own words" is a ruling, and the only way to audit a ruling
 * is to see what it was applied to — the quote, its length, and the run-up the
 * attribution test read the speaker off. Quotes are Chinese, verbatim, never
 * trimmed and never translated (CLAUDE.md).
 */
function QuoteTable({
  quotes,
  recipientPseudonym,
}: {
  quotes: readonly QuoteRuleEntry[];
  recipientPseudonym: string;
}) {
  if (quotes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
      <h3 className="text-sm font-medium text-neutral-900">
        Every quote in the document, and what the rule did with it
      </h3>
      <div className="flex flex-col gap-2">
        {quotes.map((quote, index) => (
          <div
            key={index}
            className={`flex flex-col gap-1 rounded-lg border p-3 ${
              quote.outcome === "blocked"
                ? "border-rose-300 bg-rose-50"
                : quote.outcome === "exempt_recipient_own_words"
                  ? "border-sky-200 bg-sky-50"
                  : "border-neutral-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] tracking-wide text-neutral-600 uppercase">
                {quote.outcome === "blocked"
                  ? "Refused"
                  : quote.outcome === "exempt_recipient_own_words"
                    ? "Exempt"
                    : "Under the cap"}
              </span>
              <span className="text-xs text-neutral-500">
                {quote.length} characters
              </span>
            </div>

            <blockquote className="border-l-2 border-neutral-300 pl-2 text-sm leading-relaxed text-neutral-900">
              {quote.quote}
            </blockquote>

            {quote.outcome === "exempt_recipient_own_words" && (
              <p className="text-xs leading-relaxed text-sky-900">
                Over the cap, and exempt: the attribution test reads{" "}
                {recipientPseudonym} as the speaker, so these are her own words
                being quoted back to her. That is the evidence this document rests
                on, and she already knows she wrote it. Stripping it would remove
                exactly what she is entitled to check (SPEC M4 decision record,
                2026-08-10).
              </p>
            )}

            {quote.outcome === "blocked" && (
              <p className="text-xs leading-relaxed text-rose-900">
                Over the cap, and the attribution test does not read{" "}
                {recipientPseudonym} as the speaker. Somebody else&apos;s exact
                words at this length identify them to whoever reads this. It is
                not shortened to pass — a trimmed quote is an edited record.
              </p>
            )}

            {quote.attributionContext !== "" && (
              <p className="text-xs leading-relaxed text-neutral-600">
                <span className="text-neutral-500">
                  The run-up the attribution test read:{" "}
                </span>
                {quote.attributionContext}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Consent                                                                    */
/* -------------------------------------------------------------------------- */

function ConsentPanel({ preview }: { preview: SharePreview }) {
  const { consent } = preview;
  const revoked = consent.exportBlocked;
  const gone = consent.unrecallableCopies;

  return (
    <Panel tone={revoked ? "alert" : "default"}>
      <Heading
        eyebrow="Consent"
        title={revoked ? "Withdrawn — both doors are shut" : "Where consent stands"}
        lede="Consent here is a log, not a flag. A revocation does not delete the grant before it; it supersedes it, so the case can still show what was true while it was true."
      />

      <p
        className={`rounded-lg border p-4 text-sm leading-relaxed whitespace-pre-wrap ${
          revoked
            ? "border-rose-300 bg-white text-rose-950"
            : "border-neutral-200 bg-neutral-50 text-neutral-800"
        }`}
      >
        {consent.summary}
      </p>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-500">
          Where each party stands on documents naming them
        </p>
        <ul className="flex flex-col gap-1">
          {consent.namedRendition.parties.map((party) => (
            <li key={party.pseudonym} className="text-xs text-neutral-700">
              <span className="font-medium text-neutral-900">
                {party.pseudonym}
              </span>
              {party.isSubmitter ? " (brought this case)" : ""} —{" "}
              {party.standing === "unrecorded"
                ? "never asked, which is not the same as having said no"
                : party.standing}
              {party.decidedBy === null
                ? ""
                : ` since ${utc(party.decidedBy.occurredAt)}`}
            </li>
          ))}
        </ul>
      </div>

      {gone.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-950">
            {gone.length} cop{gone.length === 1 ? "y has" : "ies have"} already
            left, and cannot be recalled
          </p>
          <p className="text-xs leading-relaxed text-amber-900">
            This product has no way to reach a file it already handed over, and
            will not pretend it has. Withdrawing consent stops the next copy, not
            the last one. A minted link is the one genuinely different case: the
            document behind a share token is served by this machine, on a route
            that asks the consent log on every single open, so a live link does
            stop working while a revocation stands and works again if consent is
            granted again. That is the one promise about a copy already handed
            over that this product can actually keep.
          </p>
          <ul className="flex flex-col gap-1">
            {gone.map((copy) => (
              <li key={copy.exportId} className="text-xs text-amber-900">
                <span className="font-mono">{copy.exportId.slice(0, 8)}</span> —{" "}
                {copy.kind} of v{copy.judgmentVersion} to {copy.recipientPseudonym}{" "}
                via {copy.channel} on {utc(copy.exportedAt)}
                {copy.beforeRevocation
                  ? " · left before the revocation"
                  : ""} · not recallable
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConsentHistory events={consent.events} />
    </Panel>
  );
}

function ConsentHistory({ events }: { events: readonly ConsentRecord[] }) {
  if (events.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-neutral-500">
        The consent log is empty. Nobody has been asked anything, and the export
        path treats that as not-revoked — the policy M4 shipped with, left alone
        on purpose rather than quietly changed when the log was built.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 border-t border-neutral-100 pt-4">
      <p className="text-xs font-medium text-neutral-500">
        The log, oldest first. Nothing in it was ever edited or removed.
      </p>
      <ol className="flex flex-col gap-1">
        {events.map((event) => (
          <li key={event.id} className="text-xs leading-relaxed text-neutral-700">
            <span className="text-neutral-500">{utc(event.occurredAt)}</span> —{" "}
            <span className="font-medium text-neutral-900">
              {event.actorPseudonym}
            </span>{" "}
            {event.kind} <span className="font-mono">{event.scope}</span>
            {event.subjectParticipantId === null ? " (everyone)" : " (one recipient)"}
            {event.note === null || event.note.trim() === "" ? (
              ""
            ) : (
              <>
                {" "}
                — in their words:{" "}
                <span className="text-neutral-900">“{event.note}”</span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Before you send                                                            */
/* -------------------------------------------------------------------------- */

function BeforeYouSendPanel({
  preview,
  consentBlocked,
}: {
  preview: SharePreview;
  consentBlocked: boolean;
}) {
  const { coolingOff } = preview;

  return (
    <Panel>
      <Heading
        eyebrow="Before you send it"
        title="What this document does to the person receiving it"
        lede="Not a checklist of things you promise. A reading of what the bytes above actually say to her, each one checked against the document rather than asserted about it."
      />

      <ul className="flex flex-col gap-3">
        {preview.disclosures.map((disclosure) => (
          <DisclosureCard key={disclosure.id} disclosure={disclosure} />
        ))}
      </ul>

      <WhatSheMeets recipientPseudonym={preview.recipient.pseudonym} />

      <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
        <h3 className="text-sm font-medium text-neutral-900">
          The pause, the question, and the doors
        </h3>
        <p className="text-xs leading-relaxed text-neutral-600">
          Doc 01 puts a 24–48 hour pause and one question between writing
          something like this and sending it. Both sit in front of every way out —
          the file, the clipboard and the minted link — because the file is the
          door that actually leaves a copy on somebody else&apos;s machine, and a
          pause you can walk around with one click is not a pause.
        </p>
        <SendPanel
          caseId={preview.caseId}
          judgmentId={preview.judgment.id}
          question={SEND_INTENT_QUESTION}
          coolingOff={{
            state: coolingOff.state,
            anchorIso: coolingOff.anchor?.toISOString() ?? null,
            anchorLabel: coolingOff.anchorLabel,
            remainingHours: Math.ceil(coolingOff.remainingMs / (60 * 60 * 1000)),
            elapsed: coolingOff.elapsed,
          }}
          gateBlocked={preview.gate.blocked}
          consentBlocked={consentBlocked}
          alreadyMinted={preview.shareToken.minted}
        />
      </div>
    </Panel>
  );
}

/**
 * What an invitation to this case actually opens on (doc 05 §A.5).
 *
 * This block exists because the two links a case can produce are different
 * artifacts and were being described as one. A **share token** minted below
 * points at a document; nothing on this build opens one. An **invitation**
 * points at `/respond/[token]`, which is built, and what it opens on is fixed by
 * §A.5 — so the sender is told, before deciding anything, what the person on the
 * other end meets first. It is here rather than under the buttons because it is
 * the part of the decision that is about her.
 *
 * Every sentence below is a claim about the entry route as it exists. The exits
 * are `entryHrefs`; the steelman is what that page renders above them; the
 * judgment is named there and never inlined, and the read model does not select
 * the column that would let it be.
 */
function WhatSheMeets({ recipientPseudonym }: { recipientPseudonym: string }) {
  return (
    <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
      <h3 className="text-sm font-medium text-neutral-900">
        What a link from this case opens on, before {recipientPseudonym} decides
        anything
      </h3>
      <p className="text-xs leading-relaxed text-neutral-600">
        Neither kind of link — the one minted below, or an invitation created on
        the case overview — lands on this text. Both land on the same entry
        screen, and the order of that screen is a decision rather than a layout:
      </p>
      <ul className="flex flex-col gap-2">
        <li className="text-xs leading-relaxed text-neutral-700">
          <span className="font-medium text-neutral-900">
            The strongest version of her own position, first.
          </span>{" "}
          Before the holdings, before the exits, and before any ask: the steelman
          this case wrote of {recipientPseudonym}&apos;s side while she was not
          here. It is the one artifact proving the machine argued her case before
          she arrived, and it is the machine&apos;s own draft — where that was
          rewritten afterwards, the screen says so rather than putting the
          rewrite in her mouth.
        </li>
        <li className="text-xs leading-relaxed text-neutral-700">
          <span className="font-medium text-neutral-900">
            The judgment named, dated and linked — never inlined.
          </span>{" "}
          Leading with the document written without her would make everything
          else on that screen read as a reply to it. She is told a version exists
          and at what level, and she opens it if she wants it.
        </li>
        <li className="text-xs leading-relaxed text-neutral-700">
          <span className="font-medium text-neutral-900">
            Opening it is not reported to you.
          </span>{" "}
          Reading the page is not an act: nothing is sent to you when she opens
          it, nothing about it appears on your case screen, and no later document
          mentions it. That sentence is on her screen too, because a reader who
          suspects the sender is watching cannot read the thing before deciding
          what to do about it.
        </li>
        <li className="text-xs leading-relaxed text-neutral-700">
          <span className="font-medium text-neutral-900">
            Three exits, of equal weight.
          </span>{" "}
          Add her side; decline; or read everything held about her first and
          decide afterwards. Declining is recorded as her own act and carries no
          consequence on the merits — the judgment stands exactly as it is, later
          versions may state &ldquo;invited, declined&rdquo; as a participation
          fact, and nothing may be inferred from it.
        </li>
      </ul>
      <p className="text-xs leading-relaxed text-neutral-500">
        What this page mints is a share token for the document above: it opens
        that screen and serves the text behind it, and it is checked against the
        consent log every time she opens it. What it is not is her own standing
        credential — that is an invitation, created on the case overview.
      </p>
    </div>
  );
}

function DisclosureCard({ disclosure }: { disclosure: PreSendDisclosure }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase ${
            disclosure.source === "record"
              ? "border-neutral-300 text-neutral-600"
              : disclosure.present
                ? "border-neutral-300 text-neutral-600"
                : "border-amber-400 text-amber-800"
          }`}
        >
          {disclosure.source === "record"
            ? "From the record"
            : disclosure.present
              ? "In the document"
              : "Not in the document"}
        </span>
        <p className="text-sm text-neutral-900">{disclosure.claim}</p>
      </div>

      {disclosure.evidence !== null && (
        <blockquote className="border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-700">
          {disclosure.evidence}
        </blockquote>
      )}

      <p className="text-xs leading-relaxed text-neutral-600">
        {disclosure.consequence}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The log                                                                    */
/* -------------------------------------------------------------------------- */

function ExportLogPanel({
  exports,
}: {
  exports: readonly ExportAuditRecord[];
}) {
  return (
    <Panel>
      <Heading
        eyebrow="The export log"
        title={
          exports.length === 0
            ? "No copy of this case has left the machine"
            : `${exports.length} cop${exports.length === 1 ? "y has" : "ies have"} left the machine`
        }
        lede="One row per copy, written at the moment the gate released the bytes. A refused export writes nothing, because what this table audits is egress and a refused document never left."
      />

      {exports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          Nothing has been exported from this case.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {exports.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
            >
              <p className="text-sm text-neutral-900">
                {utc(row.exportedAt)} — {row.kind} of judgment v
                {row.judgmentVersion} (rendition revision {row.renditionRevision})
                to {row.recipientPseudonym} via {row.channel}
              </p>
              <p className="font-mono text-xs break-all text-neutral-500">
                {row.id} · {row.byteSize} bytes · sha256 {row.contentSha256}
              </p>
              <p className="text-xs leading-relaxed text-neutral-600">
                {row.watermark}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Furniture                                                                  */
/* -------------------------------------------------------------------------- */

function Panel({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "alert";
}) {
  return (
    <section
      className={`flex flex-col gap-4 rounded-xl border p-5 ${
        tone === "alert"
          ? "border-rose-300 bg-rose-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      {children}
    </section>
  );
}

function Heading({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs tracking-wide text-neutral-500 uppercase">{eyebrow}</p>
      <h2 className="text-lg font-medium text-neutral-900">{title}</h2>
      <p className="text-sm leading-relaxed text-neutral-600">{lede}</p>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] tracking-wide text-neutral-400 uppercase">
        {label}
      </dt>
      <dd className="text-neutral-700">{children}</dd>
    </div>
  );
}

function BackLinks({ caseId }: { caseId: string }) {
  return (
    <div className="flex flex-wrap gap-4">
      <Link
        href={`/case/${caseId}`}
        className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        Back to the case overview
      </Link>
      <Link
        href={`/case/${caseId}/judgment/versions`}
        className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        The judgment and its versions
      </Link>
      <Link
        href={`/case/${caseId}/post_judgment`}
        className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        What this is supposed to change
      </Link>
    </div>
  );
}

/** A stored instant, as UTC. No locale, no clock, no relative time. */
function utc(value: Date | null): string {
  if (value === null) return "not recorded";
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
