/**
 * What the counterparty's entry screen is allowed to know (SPEC M5 ②).
 *
 * `/respond/[token]` is the first thing the other party ever sees of this
 * product. She arrives as the person being talked about, holding a link and
 * nothing else, and everything on that screen is a disclosure to somebody who
 * has not agreed to anything yet. So the screen gets a read model rather than a
 * database handle: what is not in this object cannot be rendered by accident.
 *
 * ## Three deliberate absences
 *
 *   1. **No judgment text.** `judgment` carries a version, a level and a date —
 *      never `content`, never `surface_layer`, never a rendition. Leading with
 *      the document written without her would make everything else on the page
 *      read as a reply to it, and the whole design of this screen is that it is
 *      not (SPEC M5 decision record, 2026-08-10). The columns are not selected,
 *      so there is no text here for a component to reach for.
 *   2. **No material content.** The holdings summary is counts, dates, grades
 *      and pseudonyms. Not one utterance, not one `content_summary`, not one
 *      filename. She is told what exists and where it came from; reading it is
 *      the transparency view's job, behind the query layer, after she is
 *      actually here.
 *   3. **No token.** The plaintext invite token stays in the route params. A
 *      view object that carried it would be one `JSON.stringify` away from a log
 *      line that is a working invitation into somebody's relationship.
 *
 * ## Why the holdings summary reads the case record and not her
 *
 * The obvious audience for a page rendered to her is `asParticipant(her)`. It
 * is the wrong one here, and the reason is worth stating: on the real case every
 * row is owned by the client and `private`, so a participant-audience read
 * returns nothing at all, and the screen would tell the person this case is
 * about that the machine holds nothing about her. That is not privacy; it is
 * concealment, and it is the exact failure `/respond` exists to fix.
 *
 * So the summary resolves `CASE_RECORD` — the audience meaning "what this case
 * may be judged on" — and reports its shape. It stays inside the query layer
 * (`scopedToCase`, the same predicate every other read path uses), and it
 * selects no column that carries content. Being told *that* forty lines of your
 * own speech are on file, submitted by him, graded C, is what makes the three
 * exits below it a real choice; being shown them is a different act, with a
 * different consent behind it, on a different screen.
 *
 * ## Nothing on this path writes. Nothing.
 *
 * Everything here is synchronous, takes an explicit `Db`, and writes no row of
 * any kind. That used to be true of this module and false of the page above it,
 * which called `markInviteOpened` on render and moved `respond_state` invited →
 * opened. Doc 05 §A.5 makes the entry screen state, in as many words, that
 * opening the page is not reported to anyone and that reading is not recorded as
 * an act; the sentence is only allowed on the screen because the write is gone
 * and the function that performed it was deleted (see `access/invite.ts`).
 *
 * The consequence for the read model is this: `EntryOutcome` is a pure function
 * of the database and the token, so rendering it twice is indistinguishable from
 * rendering it once, and `tests/respond-door.test.ts` asserts exactly that by
 * hashing every row before and after a render.
 */

import { eq } from "drizzle-orm";

import { resolveSpeaker } from "../../lib/utterance-speaker";
import {
  CASE_RECORD,
  resolveMaterialGrant,
  scopedToCase,
  type InviteRefusalReason,
} from "../access";
import { hasIdentity } from "../access/invite";
import {
  readDoorStanding,
  resolveArrival,
  type ArrivalCredential,
} from "./door";
import type { Db } from "../db";
import {
  caseParticipants,
  cases,
  evidence as evidenceTable,
  judgments as judgmentsTable,
  utterances as utterancesTable,
  type EvidenceGrade,
  type EvidenceSourceType,
  type OutputLevel,
  type RespondState,
  type SteelmanVerdict,
} from "../db/schema";
import { CITABLE_STATUSES } from "../evidence/workbench";
import type { Reader } from "../pipeline/stage-machine";
import {
  STEELMAN_DOWNGRADE_PREFIX,
  readSteelman,
} from "../pipeline/steelman";

/* -------------------------------------------------------------------------- */
/* Where the three exits go                                                   */
/* -------------------------------------------------------------------------- */

/** Route prefix the shareable document already prints (`judgment/rendition.ts`). */
export const RESPOND_ROUTE_PREFIX = "/respond";

/**
 * The three doors off the entry screen, resolved in one place.
 *
 * They are named here rather than inlined in the page because two of the three
 * are other people's routes, and one file that has to change when a route moves
 * is better than three anchors that quietly stop resolving — which is the exact
 * defect M4 handed to M5 (`/respond` printed in a document that 404'd).
 *
 * **The decline seam, stated out loud.** Declining is her act and it writes the
 * record (`respond_state = declined`, and her words in `decline_reason`), so it
 * belongs to the route that takes her answer, not to a read-only screen. It is
 * addressed here as a query on the answer route, so that if the wave puts
 * declining on its own path the link still lands on a page that exists and can
 * take the answer, instead of on a 404.
 */
export function entryHrefs(token: string): {
  /** The arrival screen itself — every other screen on this route links back. */
  readonly entry: string;
  readonly addYourAccount: string;
  readonly decline: string;
  readonly transparency: string;
  /** The shareable document, which had no route at all until this wave. */
  readonly document: string;
} {
  const base = `${RESPOND_ROUTE_PREFIX}/${encodeURIComponent(token)}`;
  return {
    entry: base,
    addYourAccount: `${base}/submit`,
    decline: `${base}/decline`,
    transparency: `${base}/data`,
    document: `${base}/document`,
  };
}

/* -------------------------------------------------------------------------- */
/* The read model                                                             */
/* -------------------------------------------------------------------------- */

/** (a) What this is and who brought it. */
export interface CaseIntro {
  readonly caseId: string;
  /**
   * Her participant row. Not a capability — the token is the capability, and it
   * is deliberately not in this object — but the page needs it to record that
   * she opened the invitation, and the transparency view needs it to know whose
   * material is whose.
   */
  readonly participantId: string;
  /** The one line the case was filed under, in the client's words. Often null. */
  readonly title: string | null;
  readonly filedAt: Date | null;
  /** The pseudonym of whoever filed it. Null if no party is marked as submitter. */
  readonly filedByPseudonym: string | null;
  /** Hers. The token she is holding resolved to this row. */
  readonly yourPseudonym: string;
  /** Where she is in her own entry flow — not the client's report of her. */
  readonly respondState: RespondState;
  /** True once she has redeemed the invitation and has an account. */
  readonly hasAccount: boolean;
}

/** One piece of material on file, described without being shown. */
export interface HoldingItem {
  readonly evidenceId: string;
  readonly kind: EvidenceSourceType;
  /** Who put it on the machine. Null for rows that predate two accounts. */
  readonly submittedByPseudonym: string | null;
  readonly submittedAt: Date;
  /** The human-confirmed grade, or the machine's suggestion when none is confirmed. */
  readonly grade: EvidenceGrade | null;
  /** True when a person signed off on the grade; false when it is a suggestion. */
  readonly gradeConfirmed: boolean;
  /** Lines transcribed from this item, whoever spoke them. */
  readonly lines: number;
  /** Of those, lines the record attributes to her. */
  readonly linesAttributedToYou: number;
  /** Of hers, lines that are confirmed and may therefore be cited. */
  readonly citableLinesAttributedToYou: number;
  /** Of hers, lines stored as somebody's recollection rather than a record (HARD RULE #5). */
  readonly retoldLinesAttributedToYou: number;
}

/** (b) What the machine holds, in numbers, with provenance. */
export interface Holdings {
  readonly items: readonly HoldingItem[];
  readonly totalItems: number;
  /** Every line in the case record, whoever spoke it. */
  readonly totalLines: number;
  readonly linesAttributedToYou: number;
  readonly citableLinesAttributedToYou: number;
  readonly retoldLinesAttributedToYou: number;
  /** Pseudonyms of everyone who put material on the machine. Sorted. */
  readonly submittedByPseudonyms: readonly string[];
  readonly firstSubmittedAt: Date | null;
  readonly lastSubmittedAt: Date | null;
}

/** (c) The steelman of her position, written before she arrived. */
export interface SteelmanNote {
  readonly present: boolean;
  /** The text to show her. Null when the stage never produced one. */
  readonly text: string | null;
  /** True when `text` is the machine's own draft rather than a human rewrite. */
  readonly isMachineDraft: boolean;
  /** True when the client rewrote it and his version differs from the draft. */
  readonly clientEdited: boolean;
  readonly version: number | null;
  /** What the client answered when shown it: pending / accepted / rebutted / unable. */
  readonly clientVerdict: SteelmanVerdict;
  /** True when the stage itself reported it could not write one. */
  readonly unable: boolean;
  /** Why the case records that it can support less than it otherwise would. */
  readonly downgradeReason: string | null;
}

/**
 * The judgment, as a fact and never as a text.
 *
 * Only `final` rows count. A draft is work in progress and nothing is handed to
 * anyone out of one — the same rule `mintShareToken` enforces on the export
 * side.
 */
export interface JudgmentNote {
  readonly exists: boolean;
  readonly version: number | null;
  readonly outputLevel: OutputLevel | null;
  readonly frozenAt: Date | null;
}

/**
 * What the door she is holding is currently doing (doc 05 §A.4).
 *
 * On the screen this answers question 3 — what happens if you close this tab —
 * with facts rather than reassurance: whether the link has a deadline on it,
 * whether it is now her standing door, and whether the client can create another
 * one. A page that only *said* "nothing happens" would be asking to be believed.
 */
export interface DoorNote {
  /** How the person reading proved which party she is. */
  readonly via: ArrivalCredential;
  /** Null means no deadline at all — a standing door. */
  readonly expiresAt: Date | null;
  /** True once the link has no deadline and still resolves. */
  readonly standing: boolean;
  /** True when the client may not create her another invitation. */
  readonly mintingClosed: boolean;
  /** True once she has answered by declining, so the screen offers the reversal. */
  readonly declined: boolean;
}

export interface CounterpartyEntryView {
  readonly intro: CaseIntro;
  readonly holdings: Holdings;
  readonly steelman: SteelmanNote;
  readonly judgment: JudgmentNote;
  readonly door: DoorNote;
}

export type EntryOutcome =
  | { readonly ok: true; readonly view: CounterpartyEntryView }
  | {
      readonly ok: false;
      readonly reason: InviteRefusalReason;
      /** One sentence, safe to show somebody holding a link that did not work. */
      readonly message: string;
    };

/* -------------------------------------------------------------------------- */
/* Building it                                                                */
/* -------------------------------------------------------------------------- */

export interface EntryOptions {
  /** Injected clock, so an expiry test does not have to wait fourteen days. */
  readonly now?: Date;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve a token to everything the entry screen may render, or to a refusal.
 *
 * **Both credentials, like every other screen on this path.** The invitation is
 * single-use, so a party who has taken up an account holds a spent link and an
 * identity token — and until the L1 run walked it, this function accepted only
 * the first of the two. The effect was that the entry screen became unreachable
 * at exactly the moment she joined: `/submit` and `/data` kept working (they
 * resolve through `resolveRespondingParty`, which accepts either), while the one
 * screen that explains what this is refused her with "this invitation has
 * already been used". The page even carries copy for the case — "You have
 * already set up your side of this" — that nothing could ever render.
 *
 * The refusal is `verifyInviteToken`'s, reason and wording alike: unknown,
 * expired and already-redeemed are three different things that happened to the
 * person holding the link, and this module has nothing to add to any of them. An
 * identity token that does not resolve falls through to exactly that refusal,
 * because a link that is neither is a link this machine did not issue.
 *
 * Nothing about the case is read before a token verifies, so a refusal cannot
 * carry case content — not through this function, and not through a page that
 * renders what this function returned.
 */
export function buildCounterpartyEntry(
  db: Db,
  token: string,
  options: EntryOptions = {},
): EntryOutcome {
  // Three credentials, no writes. `participation/door.ts` owns which ones and
  // why the third had to be added: the one link the client has a button for is
  // a share token, and until this wave it landed her on a refusal.
  const check = resolveArrival(db, token, options);

  if (!check.ok) {
    return { ok: false, reason: check.reason, message: check.message };
  }

  const { caseId, id: participantId } = check.arrival.participant;

  const caseRow = db
    .select({ title: cases.title, createdAt: cases.createdAt })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();

  const parties = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const intro: CaseIntro = {
    caseId,
    participantId,
    title: caseRow?.title ?? null,
    filedAt: caseRow?.createdAt ?? null,
    filedByPseudonym:
      parties.find((party) => party.isSubmitter)?.pseudonym ?? null,
    yourPseudonym: check.arrival.participant.pseudonym,
    respondState: check.arrival.participant.respondState,
    hasAccount: hasIdentity(db, participantId),
  };

  const standing = readDoorStanding(db, participantId, options);

  return {
    ok: true,
    view: {
      intro,
      holdings: summarizeHoldings(db, caseId, participantId, parties),
      steelman: readSteelmanNote(db, caseId),
      judgment: readJudgmentNote(db, caseId),
      door: {
        via: check.arrival.via,
        expiresAt: standing?.expiresAt ?? null,
        standing: standing?.standing ?? false,
        mintingClosed: standing?.mintingClosed ?? false,
        declined: check.arrival.participant.respondState === "declined",
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* (b) The holdings summary                                                   */
/* -------------------------------------------------------------------------- */

interface Party {
  readonly id: string;
  readonly pseudonym: string;
}

/**
 * Count what the case record holds, and where it came from.
 *
 * Every column selected here is a date, an enum, a count or a pseudonym. No
 * `content_summary`, no `ai_draft`, no `human_final`, no filename: the summary
 * is a shape, and a shape cannot quote anybody.
 */
function summarizeHoldings(
  db: Db,
  caseId: string,
  participantId: string,
  parties: readonly Party[],
): Holdings {
  const grant = resolveMaterialGrant(db, caseId, CASE_RECORD);
  const pseudonymOf = new Map(parties.map((party) => [party.id, party.pseudonym]));
  const candidates = parties.map((party) => ({
    id: party.id,
    pseudonym: party.pseudonym,
  }));

  const evidenceRows = db
    .select({
      id: evidenceTable.id,
      sourceType: evidenceTable.sourceType,
      gradeFinal: evidenceTable.gradeFinal,
      gradeSuggested: evidenceTable.gradeSuggested,
      createdAt: evidenceTable.createdAt,
      ownerParticipantId: evidenceTable.ownerParticipantId,
    })
    .from(evidenceTable)
    .where(scopedToCase(evidenceTable, grant))
    .all();

  const utteranceRows = db
    .select({
      id: utterancesTable.id,
      evidenceId: utterancesTable.evidenceId,
      speakerParticipantId: utterancesTable.speakerParticipantId,
      speakerLabel: utterancesTable.speakerLabel,
      confirmStatus: utterancesTable.confirmStatus,
      isRetold: utterancesTable.isRetold,
    })
    .from(utterancesTable)
    .where(scopedToCase(utterancesTable, grant))
    .all();

  const citable = new Set<string>(CITABLE_STATUSES);

  interface Tally {
    lines: number;
    yours: number;
    yoursCitable: number;
    yoursRetold: number;
  }
  const empty = (): Tally => ({
    lines: 0,
    yours: 0,
    yoursCitable: 0,
    yoursRetold: 0,
  });

  const perEvidence = new Map<string, Tally>();
  const overall = empty();

  /** The tally for one evidence id, created on first sight. */
  const bucketFor = (evidenceId: string): Tally => {
    const existing = perEvidence.get(evidenceId);
    if (existing !== undefined) return existing;
    const fresh = empty();
    perEvidence.set(evidenceId, fresh);
    return fresh;
  };

  for (const row of utteranceRows) {
    const speaker = resolveSpeaker(row, candidates);
    const isHers =
      speaker.kind === "participant" && speaker.participantId === participantId;
    // A line can sit on the case without an evidence row behind it; it still
    // counts in the totals, it just has no item to be listed under.
    const bucket = row.evidenceId === null ? null : bucketFor(row.evidenceId);

    overall.lines += 1;
    if (bucket !== null) bucket.lines += 1;
    if (!isHers) continue;

    overall.yours += 1;
    if (bucket !== null) bucket.yours += 1;
    if (citable.has(row.confirmStatus)) {
      overall.yoursCitable += 1;
      if (bucket !== null) bucket.yoursCitable += 1;
    }
    if (row.isRetold) {
      overall.yoursRetold += 1;
      if (bucket !== null) bucket.yoursRetold += 1;
    }
  }

  const items: HoldingItem[] = evidenceRows
    .map((row) => {
      const tally = perEvidence.get(row.id) ?? empty();
      return {
        evidenceId: row.id,
        kind: row.sourceType,
        submittedByPseudonym:
          row.ownerParticipantId === null
            ? null
            : (pseudonymOf.get(row.ownerParticipantId) ?? null),
        submittedAt: row.createdAt,
        grade: row.gradeFinal ?? row.gradeSuggested,
        gradeConfirmed: row.gradeFinal !== null,
        lines: tally.lines,
        linesAttributedToYou: tally.yours,
        citableLinesAttributedToYou: tally.yoursCitable,
        retoldLinesAttributedToYou: tally.yoursRetold,
      };
    })
    // Oldest first: the order she would ask about it in, and a stored value, so
    // two readers of one record always see the same page.
    .sort(
      (a, b) =>
        a.submittedAt.getTime() - b.submittedAt.getTime() ||
        compare(a.evidenceId, b.evidenceId),
    );

  const submitters = new Set<string>();
  for (const item of items) {
    if (item.submittedByPseudonym !== null) {
      submitters.add(item.submittedByPseudonym);
    }
  }

  return {
    items,
    totalItems: items.length,
    totalLines: overall.lines,
    linesAttributedToYou: overall.yours,
    citableLinesAttributedToYou: overall.yoursCitable,
    retoldLinesAttributedToYou: overall.yoursRetold,
    submittedByPseudonyms: [...submitters].sort(compare),
    firstSubmittedAt: items[0]?.submittedAt ?? null,
    lastSubmittedAt: items[items.length - 1]?.submittedAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* (c) The steelman                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The strongest version of her case that the machine wrote without her.
 *
 * `ai_draft` is preferred over `human_final` on purpose, and it is the only
 * place in this product where that preference is the right one: the artifact
 * this screen exists to show is *what the machine produced before she arrived*,
 * and a version the client rewrote is a different claim with a different author.
 * When he did rewrite it, the page says so and sends her to the transparency
 * view for his text rather than putting it in her mouth here.
 */
function readSteelmanNote(db: Reader, caseId: string): SteelmanNote {
  const board = readSteelman(db, caseId);
  const current = board.current;

  // `STEELMAN_DOWNGRADE_PREFIX` is a marker so the code can tell which stage
  // set the signal (see `pipeline/steelman.ts`); it is not part of the reason.
  // She gets the sentence, not the bookkeeping.
  const reason =
    board.downgradeSignal && board.downgradeReason !== null
      ? board.downgradeReason.startsWith(STEELMAN_DOWNGRADE_PREFIX)
        ? board.downgradeReason.slice(STEELMAN_DOWNGRADE_PREFIX.length)
        : board.downgradeReason
      : null;

  if (current === null) {
    return {
      present: false,
      text: null,
      isMachineDraft: false,
      clientEdited: false,
      version: null,
      clientVerdict: "pending",
      unable: false,
      downgradeReason: reason,
    };
  }

  const text = current.aiDraft ?? current.humanFinal;
  return {
    present: text !== null && text.trim() !== "" && !current.unable,
    text,
    isMachineDraft: current.aiDraft !== null,
    clientEdited:
      current.humanFinal !== null && current.humanFinal !== current.aiDraft,
    version: current.version,
    clientVerdict: current.verdict,
    unable: current.unable,
    downgradeReason: reason,
  };
}

/* -------------------------------------------------------------------------- */
/* The judgment, named and not rendered                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether a frozen judgment exists on this case, and nothing about what it says.
 *
 * The select lists five columns and `content` / `surface_layer` are not among
 * them. That is the enforcement: a component cannot render text this function
 * never read, and a later edit that wants to would have to add the column and
 * argue for it.
 */
/** Final rows only, oldest first. A draft is work in progress and is nobody's. */
function finalJudgments(
  db: Reader,
  caseId: string,
): readonly {
  readonly id: string;
  readonly version: number;
  readonly outputLevel: OutputLevel | null;
  readonly finalizedAt: Date | null;
}[] {
  return db
    .select({
      id: judgmentsTable.id,
      version: judgmentsTable.version,
      outputLevel: judgmentsTable.outputLevel,
      status: judgmentsTable.status,
      finalizedAt: judgmentsTable.finalizedAt,
    })
    .from(judgmentsTable)
    .where(eq(judgmentsTable.caseId, caseId))
    .all()
    .filter((row) => row.status === "final")
    .sort((a, b) => a.version - b.version);
}

/**
 * The id of the latest frozen judgment on a case, or null.
 *
 * Exported for `/respond/[token]/document`, which needs to name the document
 * before it may serve it. It returns an id and nothing else — the same
 * discipline `readJudgmentNote` keeps, one layer down: this module hands out
 * facts about the judgment and never its text.
 */
export function latestFinalJudgmentId(db: Reader, caseId: string): string | null {
  const rows = finalJudgments(db, caseId);
  return rows[rows.length - 1]?.id ?? null;
}

function readJudgmentNote(db: Reader, caseId: string): JudgmentNote {
  const rows = finalJudgments(db, caseId);

  const latest = rows[rows.length - 1];
  if (latest === undefined) {
    return { exists: false, version: null, outputLevel: null, frozenAt: null };
  }
  return {
    exists: true,
    version: latest.version,
    outputLevel: latest.outputLevel,
    frozenAt: latest.finalizedAt,
  };
}
