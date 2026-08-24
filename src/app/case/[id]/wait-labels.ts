// UI vocabulary for the asymmetric-wait surface (doc 05 §A.2).
//
// The server returns facts — booleans, timestamps, and the level derivation's
// own words. This file is the only place those become sentences, the same split
// `judgment/labels.ts` makes. Nothing here re-words the derivation: the
// rationale and the findings are rendered verbatim from `wait-view.ts`, and what
// is named below is the vocabulary around them.
//
// Two rules govern every string in this file.
//
//   1. **An unrecorded act is an absence, never a delay.** "Nothing has been
//      recorded" is the honest sentence; "she has not replied yet", "still
//      waiting", "overdue" are not. Silence is not evidence, not acquiescence
//      and not a waiver (§A.4), and copy that sighs at her is the first place
//      that doctrine leaks.
//   2. **A decline reads like every other fact.** Same words, same weight, same
//      colour. No warning tone, no adverse wording, no "unfortunately". Her
//      refusal is a participation fact and the record is allowed to say only
//      that it happened and when.

import type { OutputLevelReason } from "../../../server/domain/output-level";
import type { WaitActCode, WaitAnswer } from "../../../server/cases/wait-view";

/* -------------------------------------------------------------------------- */
/* The acts                                                                   */
/* -------------------------------------------------------------------------- */

export interface ActCopy {
  /** What happened, in the past tense, when it is on the record. */
  readonly recorded: string;
  /** What the record holds instead. Never a countdown, never a complaint. */
  readonly absent: string;
  /** What the act means, once it has happened. */
  readonly noteRecorded: string;
  /**
   * What its absence means — which is never "not yet".
   *
   * Split from `noteRecorded` because one note for both states is how a
   * timeline ends up explaining an act next to a line saying it has not
   * happened. The first draft of this file did exactly that, and printed "every
   * line she wrote has been through her own confirmation" directly under "her
   * confirmation is not complete".
   */
  readonly noteAbsent: string;
}

export const ACT_COPY: Readonly<Record<WaitActCode, ActCopy>> = {
  invitation_created: {
    recorded: "An invitation was created",
    absent: "No invitation has been created",
    noteRecorded:
      "A link was minted for her on this machine. This product does not send it — handing it over is your act, in whatever channel you choose, and nothing here can tell whether you did.",
    noteAbsent:
      "Nothing on file records that she was asked. That is a fact about this case rather than about her: she cannot answer a case she has not been shown.",
  },
  answered: {
    recorded: "She answered",
    absent: "She has not answered",
    noteRecorded:
      "Her own act, on her own row. It supersedes whatever this case had recorded about her participation on somebody else's word.",
    noteAbsent:
      "The answer is hers to make and hers alone. Nothing is read out of its absence — not agreement, not avoidance, not anything.",
  },
  statement_submitted: {
    recorded: "She submitted a statement",
    absent: "No statement from her is on file",
    noteRecorded:
      "That a statement exists is a fact about the record. What it says is hers until a judgment quotes it, and you will read it there or not at all.",
    noteAbsent:
      "Nothing of hers is in this case. If that changes, this line will say so and say nothing else.",
  },
  confirmation_complete: {
    recorded: "Her confirmation is complete",
    absent: "Her confirmation is not complete",
    noteRecorded:
      "Every line she wrote has been through her own confirmation, the same step your own material goes through. Nothing about how much there was, or how long it took, is recorded here.",
    noteAbsent:
      "Her material has not been through her own confirmation step. Whether that is one line or a hundred is not something this screen reports.",
  },
  rehearing_available: {
    recorded: "A re-hearing is available",
    absent: "No re-hearing is available",
    noteRecorded:
      "The record now derives a different level from the one the judgment was written inside. A re-hearing is offered, never fired automatically — a new version is an act someone chooses, and the judgment stands unchanged either way.",
    noteAbsent:
      "The record still derives the level the judgment was written inside, so there is nothing to re-hear. This does not expire and nothing counts toward it.",
  },
};

/** Which answer she gave. Two facts, one register. */
export const ANSWER_COPY: Readonly<Record<WaitAnswer, string>> = {
  consented: "consented to her material being part of this record",
  declined: "declined to take part",
};

/**
 * What a recorded decline means for the case, stated once, next to the fact.
 *
 * This is the whole of it (§A.4): the level does not move, the judgment does not
 * move, no further invitation is minted, and nothing about the merits is read
 * out of her refusal. It is written here rather than left implied because the
 * reader of this screen is the person most likely to read a refusal as an answer
 * to the case.
 */
export const DECLINE_CONSEQUENCE =
  "Her refusal changes nothing about the merits. The level stays where the record " +
  "puts it, the judgment stands as written, and no version of this case may " +
  "infer anything from her declining — not agreement, not avoidance, not " +
  "anything. What it does change is procedural: this case mints no further " +
  "invitations for her, and her link stays open as her own door, to read what is " +
  "held about her or to change her answer.";

/* -------------------------------------------------------------------------- */
/* The invitation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a link is and what creating one commits this product to (doc 05 §A.4).
 *
 * Rendered as content next to the control rather than as a tooltip behind it,
 * for the same reason the refusals section exists: these are the anti-badgering
 * rules, and a rule nobody is told about is indistinguishable from a rule that
 * is not there. The last one is the load-bearing one — every ODR failure the
 * survey measured that punished a non-responder began with a system that could
 * contact her on its own schedule.
 */
export const INVITE_LINK_FACTS: readonly string[] = [
  "The link works once in the sense that matters: she may read what it opens as often as she likes, and it is spent the moment she takes up her own side of the case with it. After that she comes back through her own credential rather than this one.",
  "It stops working 14 days after it is created. That is the link's lifetime and not a deadline on anything: when it lapses, the level does not move, the judgment does not change, and nothing is recorded about her. A live secret sitting in a chat thread should die; that is the whole of the reason.",
  "One live link at a time. Creating a second would silently break the first, so this product waits until the current one has lapsed before offering to create another — a link you may already have sent is not something a button here should invalidate without telling you.",
  "If she declines, no further invitation is created for her on this case. Her answer is the record's answer, and a second link would be the same question asked again by a system she has already answered. Her own link stays open on her side; what closes is the asking.",
  "Nothing here contacts her. No mail, no reminder, no nudge, no read receipt — an automated cadence aimed at somebody who owes this system nothing is pressure, and a court's power to summon is exactly what this product does not have. Delivering the link is yours to do, in whatever channel you choose.",
];

/** The state of her link, said as a heading. */
export const DOOR_HEADINGS = {
  never_minted: "Nobody has been invited to this case",
  expired: "The invitation link has lapsed",
  live: "A live invitation exists",
  standing: "She holds a standing link of her own",
  closed: "No further invitation will be created",
} as const;

/**
 * The live-link state, including the cost of not storing the plaintext.
 *
 * Stated rather than smoothed over: the client who loses the link before
 * delivering it waits for the expiry. That is a real cost of the decision not to
 * keep a working way into somebody's case on disk, and a screen that hid it
 * would be hiding the price of its own best property.
 */
export const DOOR_LIVE_NOTE =
  "It was shown once, when it was created, and only its hash is stored — so it " +
  "cannot be shown again, by anyone, including you. If it was lost before you " +
  "passed it on, a replacement can be created once this one lapses.";

export const DOOR_EXPIRED_NOTE =
  "Nothing about the case moved when it lapsed. The level is where the record " +
  "puts it, the judgment stands as written, and nothing was recorded about her. " +
  "A new link may be created, and creating one is your act.";

export const DOOR_STANDING_NOTE =
  "Her link has no deadline on it any more: it is her own door to what this case " +
  "holds about her, and to changing the answer she gave. It is revocable by her " +
  "and by nobody else.";

/* -------------------------------------------------------------------------- */
/* The gap                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The second step of §A.2's sequence is literally "(nothing)".
 *
 * It is rendered rather than skipped, because the gap between creating an
 * invitation and hearing back is the whole of what this screen is about, and a
 * timeline that closed it up would imply the product was watching it.
 */
export const THE_GAP =
  "Between those two there is nothing. Nothing is measured in this space, " +
  "nothing accrues in it, and nothing about the case changes while it lasts.";

/* -------------------------------------------------------------------------- */
/* The key to the level                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What would change the case's level — the key doc 04 principle 2 requires next
 * to every locked door.
 *
 * Keyed by the derivation's own `reason` code, so the sentence shown is the
 * answer to the rule that actually bound, rather than a generic "invite her".
 */
export const UNBLOCKING_CONDITION: Readonly<Record<OutputLevelReason, string>> = {
  counterparty_absent:
    "Only one person has spoken here — that changes if she answers. A level that " +
    "allocates responsibility needs her own account in the record, confirmed by " +
    "her. Nothing else you can do moves it, and nothing moves it on its own.",
  one_sided_material:
    "She is here, and nothing of hers is in the record yet — that changes when she " +
    "confirms material of her own. The level rests on each side owning something " +
    "confirmed, not on who is quoted the most: on this record she is quoted " +
    "throughout, and every line of it arrived through you.",
  steelman_unavailable:
    "The strongest version of her case could not be written, or you could not " +
    "recognize her in the version that was. That is what caps this, and it is not " +
    "waiting on her: it changes when the steelman stage can produce a version of " +
    "her position you recognize as hers.",
  no_citable_record:
    "Nothing in this case can carry a factual claim yet — that changes when " +
    "material here is confirmed. Yours counts toward it, so this one does not wait " +
    "on her at all.",
  safety_refusal:
    "A safety screen refused this case. That is not a level she can move, and " +
    "nothing on this screen is asking her for anything.",
  bilateral:
    "Both sides own confirmed material in this record, so nothing about the level " +
    "is waiting on her.",
};

/* -------------------------------------------------------------------------- */
/* What this screen will not show                                             */
/* -------------------------------------------------------------------------- */

export interface Refusal {
  readonly id: string;
  /** The thing that is not on this screen. */
  readonly withheld: string;
  /** Why. The argument, not an apology for a missing feature. */
  readonly reason: string;
}

/**
 * The three refusals of §A.2, each with the reason it exists.
 *
 * These are content. A person who cannot say what is being withheld from them
 * and why is not being told the truth about the surface they are reading, and
 * every one of these absences is a decision somebody could otherwise mistake for
 * something unbuilt.
 */
export const REFUSALS: readonly Refusal[] = [
  {
    id: "no_progress",
    withheld: "How far she has got.",
    reason:
      "There is no progress bar here, no line count, no word count — not " +
      "“she is on line 7 of 40”, not “she has written 300 words”. Two reasons, and " +
      "either one would be enough. Watching the other party draft their account " +
      "of a conflict you are on the other side of is surveillance, whatever the " +
      "interface calls it. And a count is a volume signal: volume must never read " +
      "as strength, in the judgment or on the way to it.",
  },
  {
    id: "no_open_tracking",
    withheld: "Whether she has opened the page.",
    reason:
      "Opening a link is not an act and is not reported to you — not here, not " +
      "in a notification, not in any later document. A reader who knows the " +
      "sender is told the moment she opens it cannot read the thing before " +
      "deciding what to do about it, and reading before deciding is the " +
      "precondition for her answer meaning anything.",
  },
  {
    id: "no_deadline",
    withheld: "A deadline.",
    reason:
      "Nothing on this screen counts down toward a finding. The invitation link " +
      "has a lifetime, and that is credential hygiene — a live link sitting in a " +
      "chat thread should die — which is why it is printed on the link and " +
      "nowhere near the judgment. Nothing about the merits moves when it lapses: " +
      "the level does not decay, the judgment does not change, and you may mint " +
      "another link. A timer next to a judgment implies the timer decides " +
      "something. It never does.",
  },
];

/* -------------------------------------------------------------------------- */
/* Small furniture                                                            */
/* -------------------------------------------------------------------------- */

/** A stored instant, as UTC. No locale, no clock, no relative time. */
export function utc(value: Date | null): string {
  if (value === null) return "not recorded";
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The level, said as a consequence rather than as a code (doc 04 principle 4). */
export const LEVEL_MEANING: Readonly<Record<string, string>> = {
  L1: "a full judgment, written with both accounts in it",
  L2: "a one-sided analysis: what happened and what your own part in it was, and no allocation of responsibility",
  L3: "a narrative analysis only — no finding about anybody",
  refused: "a refusal: this case left the pipeline for the referral path",
};
