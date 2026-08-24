// The asymmetric-wait surface (doc 05 §A.2) — what the client sees while the
// other party has not answered.
//
// The hardest screen in the product to get right, and the only one with no
// prior art worth copying: the survey found exactly one designed instance of a
// waiting-for-your-partner state, and it is a quiz app that shows you your
// partner is on question 7 of 15. This screen is the opposite of that, on
// purpose, and the opposite is not "show less" — it is a different object.
//
// **The product in this state is a standing record with a named unblocking
// condition.** Not a countdown, not a pending request, not an inbox waiting to
// fill. So the four sections, in this order:
//
//   1. The frozen judgment and its level, with the level's reason as the key.
//      Doc 04 principle 2: a locked door with no key is a bug report, and the
//      key here is one sentence — "because only one person has spoken here,
//      and that changes if she answers".
//   2. The acts, as discrete completed facts with timestamps, including the
//      literal gap where §A.2's sequence says "(nothing)".
//   3. What the client can still do that improves the record regardless of her,
//      each linked to the surface where the act actually happens.
//   4. **What this screen refuses to show, and why.** That section is content,
//      not a footer: each absence is a decision, and a person who cannot say
//      what is being withheld from them has not been told the truth about the
//      page they are reading.
//
// A recorded decline renders inside section 2 like every other fact — same
// words, same weight, same colour. There is no rose, no amber and no warning
// iconography anywhere in this file for a reason: styling a refusal as an alarm
// is an adverse inference drawn in CSS.

import Link from "next/link";

import type {
  WaitAct,
  WaitOwnWork,
  WaitView,
} from "../../../server/cases/wait-view";
import { InviteControl } from "./invite-control";
import {
  ACT_COPY,
  ANSWER_COPY,
  DECLINE_CONSEQUENCE,
  DOOR_EXPIRED_NOTE,
  DOOR_HEADINGS,
  DOOR_LIVE_NOTE,
  DOOR_STANDING_NOTE,
  LEVEL_MEANING,
  REFUSALS,
  THE_GAP,
  UNBLOCKING_CONDITION,
  utc,
} from "./wait-labels";

export function WaitPanel({ view }: { view: WaitView }) {
  return (
    <>
      <StandingRecord view={view} />
      <TheActs view={view} />
      <TheInvitation view={view} />
      <YourOwnWork caseId={view.caseId} work={view.ownWork} />
      <WhatIsNotShown />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. The standing record, and the key to its level                           */
/* -------------------------------------------------------------------------- */

function StandingRecord({ view }: { view: WaitView }) {
  const { judgment, level, caseId } = view;
  const shown = judgment?.level ?? level.locked ?? level.derivesNow;

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          While only one person has spoken
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          {judgment === null
            ? "This case is a record with one side in it"
            : `Version ${judgment.version} stands, at ${judgment.level}`}
        </h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
          {judgment === null
            ? "No judgment has been frozen here yet. What follows is what the record would support today, and what would move it."
            : `Frozen ${utc(judgment.frozenAt)}. It is not provisional and it is not waiting to be replaced: a re-hearing writes version ${judgment.version + 1} and leaves this one exactly as it is.`}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
        <h3 className="text-sm font-medium text-neutral-900">
          What that level means
        </h3>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
          <span className="font-mono text-xs text-neutral-500">{shown}</span> —{" "}
          {LEVEL_MEANING[shown] ?? shown}.
        </p>

        {/* The derivation's own reasoning, verbatim. HARD RULE #2 puts the
            decision in code, so the reason shown is the code's reason and not a
            screen's paraphrase of it. */}
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
          {level.rationale}
        </p>

        {level.findings.length > 0 && (
          <ul className="flex max-w-[68ch] flex-col gap-1 pt-1">
            {level.findings.map((finding) => (
              <li
                key={finding.code}
                className="text-xs leading-relaxed text-neutral-600"
              >
                <span aria-hidden className="mr-1 text-neutral-400">
                  •
                </span>
                {finding.statement}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The key. Doc 04 principle 2 — every refusal names it, and it is the
          one sentence this whole surface exists to be able to say. */}
      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
        <h3 className="text-sm font-medium text-neutral-900">
          What would change it
        </h3>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-800">
          {UNBLOCKING_CONDITION[level.reason]}
        </p>
        {level.stale && level.locked !== null && (
          <p className="max-w-[68ch] text-xs leading-relaxed text-neutral-600">
            The record has moved since the level was locked: it would derive{" "}
            <span className="font-mono">{level.derivesNow}</span> today. Nothing
            has been rewritten — a judgment is written inside the level it names,
            and a record that has changed since is an argument for a new version
            rather than for editing the old one.
          </p>
        )}
      </div>

      {judgment !== null && (
        <div className="flex flex-wrap gap-3 border-t border-neutral-100 pt-4">
          <Link
            href={`/case/${caseId}/judgment`}
            className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100"
          >
            Read the judgment that stands
          </Link>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. The acts                                                                */
/* -------------------------------------------------------------------------- */

function TheActs({ view }: { view: WaitView }) {
  const declined = view.acts.some(
    (a) => a.code === "answered" && a.answer === "declined",
  );

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          The record of acts
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          What has happened, and when
        </h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
          Completed acts only, each with the moment it was recorded. Between them
          this screen shows nothing, because between them nothing happened that
          the record may report.
        </p>
      </div>

      <ol className="flex flex-col">
        {view.acts.map((item, index) => (
          <ActRow
            key={item.code}
            act={item}
            pseudonym={view.counterparty.pseudonym}
            last={index === view.acts.length - 1}
            gapAfter={item.code === "invitation_created"}
          />
        ))}
      </ol>

      {declined && (
        <p className="max-w-[68ch] border-t border-neutral-100 pt-4 text-sm leading-relaxed text-neutral-700">
          {DECLINE_CONSEQUENCE}
        </p>
      )}
    </section>
  );
}

/**
 * One act.
 *
 * The marker is a dot either way — filled when the act is on the record, hollow
 * when it is not. Deliberately not a tick and a cross: a cross next to "she has
 * not answered" would be the product having an opinion about a person who owes
 * it nothing.
 */
function ActRow({
  act,
  pseudonym,
  last,
  gapAfter,
}: {
  act: WaitAct;
  pseudonym: string;
  last: boolean;
  gapAfter: boolean;
}) {
  const copy = ACT_COPY[act.code];

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center pt-1.5">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full border ${
            act.recorded
              ? "border-neutral-700 bg-neutral-700"
              : "border-neutral-300 bg-white"
          }`}
        />
        {!last && <span aria-hidden className="w-px grow bg-neutral-200" />}
      </div>

      <div className={`flex flex-col gap-1 ${last ? "" : "pb-5"}`}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p
            className={`text-sm ${
              act.recorded ? "text-neutral-900" : "text-neutral-500"
            }`}
          >
            {act.recorded ? copy.recorded : copy.absent}
            {act.answer !== null && ` — she ${ANSWER_COPY[act.answer]}`}
          </p>
          <span className="font-mono text-xs text-neutral-500">
            {act.recorded ? utc(act.at) : "—"}
          </span>
        </div>

        <p className="max-w-[64ch] text-xs leading-relaxed text-neutral-600">
          {act.recorded ? copy.noteRecorded : copy.noteAbsent}
        </p>

        {act.credentialExpiresAt !== null && (
          <p className="max-w-[64ch] text-xs leading-relaxed text-neutral-500">
            The link stops working {utc(act.credentialExpiresAt)}. That is the
            link&apos;s lifetime, not the case&apos;s: when it lapses the record
            is unchanged, and {pseudonym} may be sent a new one unless she has
            declined.
          </p>
        )}

        {gapAfter && (
          <p className="mt-2 max-w-[64ch] rounded-lg border border-dashed border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-500">
            {THE_GAP}
          </p>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* 2b. The invitation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The one act on this side of the wait: creating a link.
 *
 * It sits under the acts rather than at the top, and it is the only control on
 * this whole surface. That ordering is the argument: the record and what would
 * change it come first, and the thing the client can *do about her* comes after
 * — a screen that led with a button would be a screen about getting her to
 * answer.
 *
 * Every state renders the same way, in the same colours, including the closed
 * one. A decline that shut minting is not an error condition and is not styled
 * as one; the sentence explaining it comes from the rule that enforces it
 * (`access/invite.ts`), rendered verbatim so the screen cannot say something
 * softer or harder than the mint path applies.
 */
function TheInvitation({ view }: { view: WaitView }) {
  const { door, caseId, counterparty } = view;

  const heading = door.mintingClosedReason !== null
    ? DOOR_HEADINGS.closed
    : door.standing
      ? DOOR_HEADINGS.standing
      : door.liveCredential
        ? DOOR_HEADINGS.live
        : door.expired
          ? DOOR_HEADINGS.expired
          : DOOR_HEADINGS.never_minted;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          The invitation
        </p>
        <h2 className="text-lg font-medium text-neutral-900">{heading}</h2>
        {door.mintedAt !== null && (
          <p className="text-sm text-neutral-600">
            Created {utc(door.mintedAt)}
            {door.expiresAt === null
              ? " · no deadline on it"
              : ` · ${door.expired ? "stopped working" : "stops working"} ${utc(door.expiresAt)}`}
          </p>
        )}
      </div>

      {door.mintingClosedReason !== null ? (
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
          {door.mintingClosedReason}
        </p>
      ) : door.standing ? (
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
          {DOOR_STANDING_NOTE}
        </p>
      ) : door.liveCredential ? (
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
          {DOOR_LIVE_NOTE}
        </p>
      ) : (
        <>
          {door.expired && (
            <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-700">
              {DOOR_EXPIRED_NOTE}
            </p>
          )}
          <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
            A link is created here and handed over by you. What it opens for{" "}
            {counterparty.pseudonym} is her own position stated at its strongest
            first, then what this case holds about her, then three exits of equal
            weight — take part, decline, or read everything first. The judgment is
            named there and linked, never inlined.
          </p>
          <InviteControl caseId={caseId} />
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. What does not wait on her                                               */
/* -------------------------------------------------------------------------- */

function YourOwnWork({
  caseId,
  work,
}: {
  caseId: string;
  work: WaitOwnWork;
}) {
  const nothingOpen =
    work.unconfirmedLines === 0 && work.openClarificationQuestions === 0;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Does not wait on her
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          What you can do that improves the record either way
        </h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
          None of this is a way to move her, and none of it is a substitute for
          her answer. It is the part of the record that is yours, and it is worth
          the same whether she ever answers or not.
        </p>
      </div>

      {nothingOpen ? (
        <p className="max-w-[68ch] rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-600">
          Nothing of yours is outstanding: no line of your own material is
          waiting on a confirmation, and no clarification question is open.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {work.unconfirmedLines > 0 && (
            <WorkItem
              href="/evidence"
              action="Confirm the rest of your own material"
              count={`${work.unconfirmedLines} line${work.unconfirmedLines === 1 ? "" : "s"} of yours still unconfirmed`}
              why="An unconfirmed line cannot be cited by anything — not by this judgment and not by the next one. Confirming yours is the one piece of the citable record entirely in your hands."
            />
          )}
          {work.openClarificationQuestions > 0 && (
            <WorkItem
              href={`/case/${caseId}/clarification`}
              action="Answer the open clarification questions"
              count={`${work.openClarificationQuestions} question${work.openClarificationQuestions === 1 ? "" : "s"} put to you and not yet answered`}
              why="These are the questions the analysis could not settle from the record. Your answers are yours alone — she never reads them; what they establish enters as a claim she can see and check."
            />
          )}
        </ul>
      )}
    </section>
  );
}

function WorkItem({
  href,
  action,
  count,
  why,
}: {
  href: string;
  action: string;
  count: string;
  why: string;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <Link
          href={href}
          className="text-sm text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
        >
          {action}
        </Link>
        <span className="text-xs tabular-nums text-neutral-500">{count}</span>
      </div>
      <p className="max-w-[64ch] text-xs leading-relaxed text-neutral-600">
        {why}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. The refusals                                                            */
/* -------------------------------------------------------------------------- */

function WhatIsNotShown() {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Withheld on purpose
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          What this screen will not show you, and why
        </h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
          Three things a waiting screen normally shows are missing here. None of
          them is unbuilt.
        </p>
      </div>

      <dl className="flex flex-col gap-4">
        {REFUSALS.map((refusal) => (
          <div key={refusal.id} className="flex flex-col gap-1">
            <dt className="text-sm font-medium text-neutral-900">
              {refusal.withheld}
            </dt>
            <dd className="max-w-[68ch] text-sm leading-relaxed text-neutral-600">
              {refusal.reason}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default WaitPanel;
