// /respond/[token] — the door for the person who did not ask to be here.
//
// The reader is in conflict with the sender and is holding a link she did not
// ask for. Doc 05 §A.5 fixes what this screen answers and the ORDER it answers
// in, before it asks her for anything at all:
//
//   1. What this is — the positive scope claim first, then the limits, then the
//      procedure stated in advance. Say what it is, then what it is not.
//   2. Who made it and what it already says about you — the steelman of HER
//      position first (the one artifact proving the machine argued her side
//      before she arrived), then the data-about-her summary with provenance,
//      then the shareable document, LINKED and not inlined.
//   3. What happens if you close this tab — nothing. Said in as many words,
//      because a reader who suspects open-tracking cannot read freely, and free
//      reading is the precondition for the decision below it.
//   4. What each exit does — three doors of equal visual weight.
//
// Two things changed here from the M5 build. The order: the steelman used to sit
// *below* the holdings summary, so the first substantive thing she read was a
// count of how much of her speech the other party had filed. And the write: this
// page called `markInviteOpened` on render, which moved `respond_state` invited
// → opened. That write is gone, and so is the function — question 3 is a claim
// about the code, and the code now backs it (`server/participation/door.ts`).
//
// **The judgment does not render on this page.** It is named, dated and linked;
// its text is not on the screen and is not in the read model
// (`server/participation/entry.ts` never selects the column). Leading with the
// document written without her would turn everything above into a reply to it.

import type { InviteRefusalReason } from "../../../server/access";
import { getDb } from "../../../server/db";
import type {
  EvidenceGrade,
  EvidenceSourceType,
  OutputLevel,
} from "../../../server/db/schema";
import {
  buildCounterpartyEntry,
  entryHrefs,
  type CounterpartyEntryView,
  type DoorNote,
  type HoldingItem,
  type Holdings,
  type JudgmentNote,
  type SteelmanNote,
} from "../../../server/participation/entry";
import { GRADE_LABELS } from "../../evidence/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** What each kind of material is, said to somebody who did not submit it. */
const KIND_LABEL: Readonly<Record<EvidenceSourceType, string>> = {
  firsthand: "First-hand record",
  recollection: "Recalled from memory",
  ai_processed: "AI-processed",
  public_sentiment: "Public post",
};

/**
 * What the machine was allowed to write, in her words rather than the column's.
 *
 * The level is derived in code from the state of the record (HARD RULE #2), and
 * every one of these sentences is about the record rather than about her.
 */
const LEVEL_LABEL: Readonly<Record<OutputLevel, string>> = {
  L1: "a full judgment, written with both accounts in it",
  L2: "a one-sided analysis, written from one account only",
  L3: "a narrative analysis only — no finding about anybody",
  refused: "a refusal: the machine declined to analyse this case",
};

/** A stored date, rendered as a date. No locale, no clock, no relative time. */
function day(value: Date | null): string {
  return value === null ? "no date on file" : value.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export default async function RespondEntryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const outcome = buildCounterpartyEntry(getDb(), token);

  // No write here, conditional or otherwise. Rendering this page leaves the
  // database byte-identical, which is what question 3 below claims and what
  // `tests/respond-door.test.ts` checks by hashing every row around a render.
  return outcome.ok ? (
    <Entry view={outcome.view} token={token} />
  ) : (
    <Refused reason={outcome.reason} message={outcome.message} />
  );
}

/* -------------------------------------------------------------------------- */
/* The refusal                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A link that did not work, explained without saying what it would have opened.
 *
 * Nothing about the case is read before the token verifies, so there is nothing
 * here to leak: no title, no pseudonym, no case id, no judgment, no link onward.
 * The three reasons stay apart, because a replayed invitation and an invented
 * one happened to different people — the person holding a spent link did nothing
 * wrong and may already have an account.
 */
function Refused({
  reason,
  message,
}: {
  reason: InviteRefusalReason;
  message: string;
}) {
  return (
    <section
      aria-labelledby="respond-refused"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5"
    >
      <h1 id="respond-refused" className="text-xl font-medium text-neutral-900">
        This link did not open anything.
      </h1>
      <p className="text-sm leading-relaxed text-neutral-700">{message}</p>
      <p className="text-sm leading-relaxed text-neutral-600">
        There is nothing on this page about whatever the link referred to. That
        is deliberate: a link that cannot be verified is not shown anything, so a
        wrong or expired one cannot become a way to read about somebody.
      </p>
      <p className="text-xs text-neutral-500">
        {reason === "already_redeemed"
          ? "Nothing has gone wrong on your side. This kind of link only works once."
          : "Whoever gave you this link can produce a new one."}
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The entry screen                                                           */
/* -------------------------------------------------------------------------- */

function Entry({
  view,
  token,
}: {
  view: CounterpartyEntryView;
  token: string;
}) {
  const hrefs = entryHrefs(token);
  const { intro } = view;

  return (
    <>
      {/* (1) What this is. Scope claim, then limits, then the procedure. */}
      <WhatThisIsSection
        filedAt={intro.filedAt}
        filedByPseudonym={intro.filedByPseudonym}
        title={intro.title}
        you={intro.yourPseudonym}
        hasAccount={intro.hasAccount}
      />

      {/* (2) Who made it and what it already says about you — steelman first,
          then the holdings summary, then the document, linked. */}
      <SteelmanSection
        note={view.steelman}
        you={intro.yourPseudonym}
        transparencyHref={hrefs.transparency}
      />

      <HoldingsSection
        holdings={view.holdings}
        you={intro.yourPseudonym}
        transparencyHref={hrefs.transparency}
      />

      <JudgmentSection note={view.judgment} documentHref={hrefs.document} />

      {/* (3) What happens if you close this tab. */}
      <ClosingTheTabSection door={view.door} />

      {/* (4) Three exits, rendered identically. */}
      <ExitsSection hrefs={hrefs} door={view.door} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* (1) What this is                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Say what it is before saying what it is not.
 *
 * The order is the survey's (doc 05 §A.5 question 1, TheMediator.AI's register):
 * a product that opens with its disclaimers has told a stranger what it is
 * afraid of before telling her what it does. So: one sentence of positive scope,
 * then the limits as a list, then the procedure — what happens next, stated in
 * advance, which is the ICODR transparency requirement and also the only way she
 * can weigh the three exits at the bottom.
 */
function WhatThisIsSection({
  filedAt,
  filedByPseudonym,
  title,
  you,
  hasAccount,
}: {
  filedAt: Date | null;
  filedByPseudonym: string | null;
  title: string | null;
  you: string;
  hasAccount: boolean;
}) {
  const filer =
    filedByPseudonym === null
      ? "someone"
      : `the person this record calls ${filedByPseudonym}`;

  return (
    <section aria-labelledby="respond-what" className="flex flex-col gap-3">
      <h1 id="respond-what" className="text-2xl font-semibold text-neutral-900">
        Someone has asked a machine to look at a disagreement you are part of.
      </h1>

      <p className="text-sm leading-relaxed text-neutral-700">
        The machine is a program called fairjudge. It reads what each person gives it,
        writes down what the record can and cannot support, and produces a
        document about the disagreement. On{" "}
        <span className="font-medium">{day(filedAt)}</span> {filer} gave it an
        account of a disagreement with you, along with material to read, and it
        has been working from that account — only that account — ever since. You
        are the person that account is about. This record calls you{" "}
        <span className="font-medium">{you}</span>.
      </p>

      {title !== null && (
        <p className="text-sm leading-relaxed text-neutral-700">
          The one line it was filed under, in their words:{" "}
          {/* Verbatim, untranslated, and marked as a quotation rather than as
              the machine's own description of the disagreement. */}
          <q className="text-neutral-900">{title}</q>
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          What it is not
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-neutral-700">
          <li>
            It is not a court, a lawyer or a mediator, and it has no authority
            over you or over anyone else. Nothing it writes obliges you to do
            anything.
          </li>
          <li>
            It is not the other person. What it has written so far is its own
            reading of what it was given, and it says on its face that it was
            given one side.
          </li>
          <li>
            It has no address for you and cannot contact you. The link that
            brought you here was handed over by a person.
          </li>
        </ul>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          What happens from here, in order
        </h2>
        <ol className="flex list-decimal flex-col gap-1 pl-4 text-sm leading-relaxed text-neutral-700">
          <li>
            This page shows you what the record already says about you, and
            where each piece of it came from.
          </li>
          <li>
            You choose one of three things at the bottom: add your account,
            record that you are not taking part, or read everything held about
            you first. There is no fourth thing this page needs from you.
          </li>
          <li>
            If you add your account, you write it in your own words, then
            confirm it line by line — nothing you write can be quoted by any
            analysis until you do.
          </li>
          <li>
            If both accounts are on file, either of you can ask for the case to
            be heard again. A new version is written and released to both of you
            at the same moment; neither of you reads it first.
          </li>
        </ol>
      </div>

      <p className="text-sm leading-relaxed text-neutral-700">
        Real names are not used inside these records; both of you are referred to
        by a marker. Nothing on this screen is a finding about you, and nothing
        here asks you to agree with anything. It is a disclosure: what exists,
        where it came from, and what the machine wrote about your side before it
        had heard from you.
      </p>

      {hasAccount && (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
          You have already set up your side of this. This page is the same
          summary you saw then, brought up to date.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* (2a) The steelman — first, because it is the only thing written FOR her     */
/* -------------------------------------------------------------------------- */

/** What the client answered when he was shown the machine's version of her case. */
function verdictSentence(note: SteelmanNote): string | null {
  switch (note.clientVerdict) {
    case "accepted":
      return (
        "The person who filed the case was shown this and said it was a fair " +
        "statement of your position."
      );
    case "rebutted":
      return (
        "The person who filed the case was shown this and said it is not what " +
        "you would say. Their own version of your position is on file, and it " +
        "is in the transparency view."
      );
    case "unable":
      return null;
    case "pending":
      return (
        "The person who filed the case has not said whether this is a fair " +
        "statement of your position."
      );
  }
}

function SteelmanSection({
  note,
  you,
  transparencyHref,
}: {
  note: SteelmanNote;
  you: string;
  transparencyHref: string;
}) {
  const verdict = verdictSentence(note);

  return (
    <section
      aria-labelledby="respond-steelman"
      className="flex flex-col gap-3 rounded-xl border border-neutral-300 bg-neutral-50 p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="respond-steelman" className="text-lg font-medium text-neutral-900">
          The strongest version of your side that this machine could write
          without you
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          Before you were asked anything, the machine was made to argue your case
          from the other person&rsquo;s material — to write what {you} would say
          if {you} were here, as well as it could be put. It is first on this
          page because it is the only thing here that was written for you.
        </p>
      </div>

      {note.present && note.text !== null ? (
        <>
          {/* The draft is a record of what the machine produced. It is rendered
              as written — no trimming, no summarizing, no paraphrase. */}
          <blockquote className="border-l-2 border-neutral-400 pl-4 text-sm leading-relaxed whitespace-pre-wrap text-neutral-900">
            {note.text}
          </blockquote>

          <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3">
            <p className="text-xs text-neutral-600">
              {note.isMachineDraft
                ? "Written by the machine, from the material described below, before you arrived"
                : "Written by hand on this case rather than by the machine"}
              {note.version === null ? "" : ` (version ${note.version})`}. It is a
              guess about somebody it has never heard from. If it is wrong, that
              is information — and correcting it is one of the things you can do
              below.
            </p>
            {verdict !== null && (
              <p className="text-xs text-neutral-600">{verdict}</p>
            )}
            {note.clientEdited && (
              <p className="text-xs text-neutral-600">
                They also rewrote it. What you are reading is the machine&rsquo;s
                own draft; their rewrite is on file and is in{" "}
                <a
                  href={transparencyHref}
                  className="underline underline-offset-2"
                >
                  the transparency view
                </a>
                .
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-relaxed text-neutral-900">
            {note.unable
              ? "The machine was asked to write the strongest version of your side and reported that it could not do it from what it has."
              : "No version of your side has been written yet."}
          </p>
          <p className="text-sm leading-relaxed text-neutral-600">
            That is recorded as a gap in what this case can support — a fact
            about the record, not a finding about you.
            {note.downgradeReason === null ? "" : ` ${note.downgradeReason}`}
          </p>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* (2b) What is on file about her                                             */
/* -------------------------------------------------------------------------- */

function HoldingsSection({
  holdings,
  you,
  transparencyHref,
}: {
  holdings: Holdings;
  you: string;
  transparencyHref: string;
}) {
  const submitters = holdings.submittedByPseudonyms;
  // Said only while it is true. Once she has put material of her own into the
  // case record, "none of it came from you" would be the page telling her
  // something about her own record that she can see is wrong.
  const noneFromHer = !submitters.includes(you);

  return (
    <section
      aria-labelledby="respond-holdings"
      className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="respond-holdings" className="text-lg font-medium text-neutral-900">
          What is already on file about you
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          {holdings.totalItems === 0
            ? "No material has been put on this machine yet."
            : `${holdings.totalItems} ${
                holdings.totalItems === 1 ? "item" : "items"
              } of material, submitted between ${day(holdings.firstSubmittedAt)} and ${day(
                holdings.lastSubmittedAt,
              )}${
                submitters.length === 0
                  ? ", with no submitter recorded"
                  : ` by ${submitters.join(" and ")}`
              }.${noneFromHer ? " None of it came from you." : ""}`}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Items of material" value={holdings.totalItems} />
        <Stat label="Lines quoted as yours" value={holdings.linesAttributedToYou} />
        <Stat
          label="Of those, confirmed"
          value={holdings.citableLinesAttributedToYou}
          hint="Only confirmed lines may be quoted in anything the machine writes."
        />
        <Stat
          label="Of those, recalled"
          value={holdings.retoldLinesAttributedToYou}
          hint="Stored as somebody remembering what you said, not as a record of you saying it."
        />
      </dl>

      {holdings.items.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Where it came from
          </h3>
          <ul className="flex flex-col gap-2">
            {holdings.items.map((item) => (
              <HoldingRow key={item.evidenceId} item={item} />
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-neutral-500">
            A grade is how much weight a piece of material is allowed to carry:
            A a first-hand record, B recalled from memory, C processed by an AI,
            D public content. An unconfirmed grade is the machine&rsquo;s
            suggestion and has not been signed off by a person.
          </p>
        </div>
      )}

      <p className="text-sm leading-relaxed text-neutral-700">
        This is a summary on purpose — it says what exists, not what it says. The
        material itself, item by item, with what you can do about each one, is in{" "}
        <a
          href={transparencyHref}
          className="text-neutral-900 underline underline-offset-2"
        >
          the transparency view
        </a>
        .
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 p-3">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-xl font-semibold text-neutral-900">{value}</dd>
      {hint !== undefined && <p className="text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

function HoldingRow({ item }: { item: HoldingItem }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-neutral-200 p-3 text-sm">
      <span className="font-medium text-neutral-900">{KIND_LABEL[item.kind]}</span>
      <GradeBadge grade={item.grade} confirmed={item.gradeConfirmed} />
      <span className="text-neutral-600">
        submitted by{" "}
        {item.submittedByPseudonym ?? "nobody on record"} on {day(item.submittedAt)}
      </span>
      <span className="text-neutral-600">
        {item.lines === 0
          ? "no transcribed lines"
          : `${item.lines} ${item.lines === 1 ? "line" : "lines"}, ${
              item.linesAttributedToYou
            } quoted as yours`}
      </span>
    </li>
  );
}

function GradeBadge({
  grade,
  confirmed,
}: {
  grade: EvidenceGrade | null;
  confirmed: boolean;
}) {
  if (grade === null) {
    return (
      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600">
        no grade yet
      </span>
    );
  }
  // The letter, not the long name: the item's own kind is already on the row
  // beside it, and "AI-processed · C AI-processed" reads like a stutter. What
  // each letter means is spelled out once, under the list.
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${GRADE_LABELS[grade].badge}`}
    >
      grade {grade}
      {confirmed ? "" : " (suggested)"}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* (2c) The document: named and linked, never inlined                         */
/* -------------------------------------------------------------------------- */

function JudgmentSection({
  note,
  documentHref,
}: {
  note: JudgmentNote;
  documentHref: string;
}) {
  return (
    <section
      aria-labelledby="respond-judgment"
      className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5"
    >
      <h2 id="respond-judgment" className="text-lg font-medium text-neutral-900">
        The document that was written without you
      </h2>

      {note.exists ? (
        <>
          <p className="text-sm leading-relaxed text-neutral-600">
            A document about this case was written and frozen on{" "}
            {day(note.frozenAt)} (version {note.version}
            {note.outputLevel === null
              ? ""
              : `, ${LEVEL_LABEL[note.outputLevel]}`}
            ). It is not on this screen on purpose: it was written from one side,
            and putting it in front of you would make everything above look like
            a reply to it.
          </p>
          <p className="text-sm leading-relaxed text-neutral-600">
            It is a link rather than a page you have been dropped into, so
            reading it is your decision and not the consequence of opening this
            one.
          </p>
          <p className="text-sm leading-relaxed">
            <a
              href={documentHref}
              className="font-medium text-neutral-900 underline underline-offset-2"
            >
              Read the document written about this case
            </a>
          </p>
          <p className="text-xs leading-relaxed text-neutral-500">
            If the message that brought you here carried a document, that is the
            same one. Opening it does not commit you to anything and is not
            reported to anyone.
          </p>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-600">
          Nothing has been written about this case yet — no analysis, no finding,
          no document. What exists is the material described above.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* (3) What happens if you close this tab                                     */
/* -------------------------------------------------------------------------- */

/**
 * The answer is "nothing", and the sentence that says so is load-bearing.
 *
 * Doc 05 §A.5 question 3: a reader who suspects the sender is notified when she
 * opens the link cannot read before deciding, and reading before deciding is the
 * whole point of the four sections above. So the claim is made explicitly rather
 * than left to be inferred from the absence of a notice.
 *
 * It is a claim about the code, and the code was changed to make it true: the
 * render performs no write, and `markInviteOpened` — which used to run here —
 * was deleted rather than left uncalled. `tests/respond-door.test.ts` hashes
 * every row before and after a render.
 */
function ClosingTheTabSection({ door }: { door: DoorNote }) {
  return (
    <section
      aria-labelledby="respond-close"
      className="flex flex-col gap-3 rounded-xl border border-neutral-300 bg-neutral-50 p-5"
    >
      <h2 id="respond-close" className="text-lg font-medium text-neutral-900">
        What happens if you close this tab
      </h2>

      <p className="text-sm leading-relaxed text-neutral-900">
        Nothing. Opening this page is not reported to anyone and reading is not
        recorded as an act.
      </p>

      <ul className="flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-neutral-700">
        <li>
          The person who sent you the link is not told that you opened it, how
          long you stayed, or how far you read. There is no page in this product
          that could show them that, because nothing writes it down.
        </li>
        <li>
          Not answering is not an answer this system reads anything into. It does
          not count as agreement, as fault, or as avoidance, and no document may
          infer anything from it.
        </li>
        <li>
          The analysis that exists does not change on its own and does not change
          on a schedule. Nothing about it moves because time passed.
        </li>
        <li>
          {door.standing
            ? "Your link has no deadline on it. It will keep working, and it is yours to close whenever you want."
            : door.expiresAt === null
              ? "The link you are holding has no deadline recorded on it."
              : `The link you are holding stops working on ${day(door.expiresAt)}. That is only about the link — a link left alive in a message thread is a risk to you, not to the case. Nothing is recorded when it expires, and nothing about the case changes.`}
        </li>
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* (4) The three exits                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Three doors, rendered identically.
 *
 * Same border, same size, same weight of type, in a grid that gives each an
 * equal third. Declining is not a grey link under a blue button: it is a
 * first-class recorded outcome (SPEC M5 ②), and the one person on this screen
 * never asked to be here. A layout that pushed her toward participating would be
 * the product putting its thumb on a decision that is hers.
 */
function ExitsSection({
  hrefs,
  door,
}: {
  hrefs: ReturnType<typeof entryHrefs>;
  door: DoorNote;
}) {
  const exits = [
    {
      href: hrefs.addYourAccount,
      title: door.declined ? "Change your answer and take part" : "Add your account",
      body:
        "Say what happened from where you were standing, in your own words. " +
        "You confirm it line by line, it stays yours, and the other party is " +
        "given no permission to read it by your writing it.",
    },
    {
      href: hrefs.decline,
      title: door.declined ? "Read what declining did" : "Decline",
      body: door.declined
        ? "You have already recorded that you are not taking part. This is what " +
          "that did to the record, and where you can take it back."
        : "Record that you are not taking part. The next screen states exactly " +
          "what that does to the record before you decide, and it is reversible " +
          "by you afterwards.",
    },
    {
      href: hrefs.transparency,
      title: "Read everything held about you first",
      body:
        "Every item, in full, with where it came from — and what you can " +
        "delete, what you can ask to have deleted, and what you can stop from " +
        "being shared. Deciding nothing today is a legitimate outcome of this.",
    },
  ];

  return (
    <section aria-labelledby="respond-exits" className="flex flex-col gap-3">
      <h2 id="respond-exits" className="text-lg font-medium text-neutral-900">
        What you can do from here
      </h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        {exits.map((exit) => (
          <li key={exit.href} className="flex">
            {/* A plain anchor, so every one of the three works with no
                JavaScript and none is faster or smoother than the others. */}
            <a
              href={exit.href}
              className="flex w-full flex-col gap-1 rounded-xl border border-neutral-300 p-4 hover:bg-neutral-50"
            >
              <span className="text-sm font-medium text-neutral-900">
                {exit.title}
              </span>
              <span className="text-xs leading-relaxed text-neutral-600">
                {exit.body}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">
        Doing nothing is also an answer, and it is the one this page assumes
        until you say otherwise.
        {door.mintingClosed
          ? " No further invitation will be created for you."
          : ""}
      </p>
    </section>
  );
}
