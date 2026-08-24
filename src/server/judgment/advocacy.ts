/**
 * The blind advocate pair's input assembly (doc 05 §B.3, approved 2026-08-17).
 *
 * Two agents, one brief per party, each arguing that party's strongest case from
 * the record; neither sees the other's output; both briefs are inputs to the
 * skeleton. This module decides **what each seat is handed**, which is the whole
 * of the blindness guarantee:
 *
 *   | seat        | receives                                        | withheld                                                   |
 *   |-------------|-------------------------------------------------|------------------------------------------------------------|
 *   | Advocate-A  | A's citable material, the case file, the issues  | Advocate-B's output, any draft skeleton, B's clarification |
 *   | Advocate-B  | B's citable material, the case file, the issues  | Advocate-A's output, any draft skeleton, A's clarification |
 *
 * The withheld column is not enforced by a sentence in the prompt asking the
 * model not to look. It is enforced by `buildAdvocateInput` never being given
 * the other brief, there being no draft skeleton in existence when the pair
 * runs, and `clarificationForParty` returning rounds only for the seat's own
 * party. A document that was never serialized cannot influence a call — that is
 * the same discipline `renderNarrativePrompt` uses to keep the record out of the
 * narrative call (HARD RULE #8's shape, applied to a different boundary).
 *
 * ## Why cross-party clarification is always withheld
 *
 * Clarification in this product is put to the submitter: the rounds carry no
 * per-party attribution because there has only ever been one party answering
 * them. So "only your own party's answers" resolves, today, to *the client's
 * advocate sees them and the counterparty's advocate does not* — which is the
 * rule, correctly applied to a record where one side did the answering, not a
 * degenerate case of it. When the counterparty starts answering questions of her
 * own, `clarificationForParty` is the one place that has to learn to split them.
 *
 * ## What this module does not decide
 *
 * Whether the pair runs at all. That is the locked output level's business (L1
 * only) and the cost ceiling's (`cost.ts` may collapse the pair into the single
 * combined steelman call), both of which are settled in `generation.ts` before
 * anything here is called.
 */

import type { Db } from "../db";
import { stableStringify, type JsonValue } from "../pipeline/case-file";
import { assembleCaseFile } from "../pipeline/case-file";
import {
  auditCitations,
  buildCitableBrief,
  describeCitationFaults,
  renderBrief,
  type CitationAudit,
  type CitingItem,
} from "../pipeline/evidence-refs";
import { listIssues } from "../pipeline/issue-fixing";
import type { AdvocateBriefOutput } from "../llm/stages";

/** Format marker, bumped when a seat's input shape changes. */
export const ADVOCATE_INPUT_FORMAT = "fairjudge.advocate_input.v1";

/* -------------------------------------------------------------------------- */
/* Seats                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which chair an advocate sits in. Not the party — the party is assigned to the
 * seat, and the assignment is what the swap pass re-seats.
 */
export const ADVOCATE_SEATS = ["a", "b"] as const;
export type AdvocateSeat = (typeof ADVOCATE_SEATS)[number];

export interface AdvocateAssignment {
  readonly seat: AdvocateSeat;
  /** Pseudonym of the party this seat argues for. */
  readonly party: string;
  /** True when this seat argues for the party who brought the case. */
  readonly isClient: boolean;
}

export class AdvocacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvocacyError";
  }
}

/**
 * Assign the two seats: A argues for the client, B for the counterparty.
 *
 * Deterministic, and deliberately keyed on the client marker rather than on
 * pseudonym order — this is the "A-first seating" doc 05 §B.2 names, and it is
 * what makes the swap pass's re-seating meaningful. Under the register exchange
 * the client marker moves to the other pseudonym, so the same rule applied to
 * the swapped dossier seats the other advocate first, without renaming anybody:
 * a brief for 甲 stays a brief for 甲 in both arms, because 甲's words are 甲's
 * in both arms (`swapJudgmentDossier`).
 *
 * Refuses anything but exactly two parties, for the same reason
 * `buildSwapDictionary` does: a pair needs two chairs.
 */
export function assignAdvocateSeats(
  db: Db,
  caseId: string,
): readonly AdvocateAssignment[] {
  const brief = buildCitableBrief(db, caseId);
  const parties = [...new Set(brief.participants.map((p) => p.pseudonym))].sort(
    compare,
  );

  if (parties.length !== 2) {
    throw new AdvocacyError(
      `An advocate pair needs exactly two parties to seat; case ${caseId} has ` +
        `${parties.length} (${parties.join(", ") || "none"}). Below two there ` +
        `is no opposed pair to write, and above two there is no pair at all — ` +
        `either way running one seat and calling it a pair would report an ` +
        `opposition that never happened.`,
    );
  }

  const client = brief.client?.pseudonym ?? null;
  if (client === null || !parties.includes(client)) {
    throw new AdvocacyError(
      `Case ${caseId} marks no party as the submitter, so there is no A-first ` +
        `seating to make. The seating is what the swap pass re-seats; guessing ` +
        `at it would make the swap comparison meaningless.`,
    );
  }

  const counterparty = parties.find((party) => party !== client) as string;

  return [
    { seat: "a", party: client, isClient: true },
    { seat: "b", party: counterparty, isClient: false },
  ];
}

/* -------------------------------------------------------------------------- */
/* What one seat is handed                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything withheld from one seat, named.
 *
 * Recorded rather than assumed: "the advocate could not see the other brief" is
 * a claim about bytes, and the honest form of it is a list the audit view and
 * the tests can both read.
 */
export const ADVOCATE_WITHHELD = [
  "the other advocate's brief (it does not exist yet for seat a, and is not " +
    "serialized for seat b)",
  "any draft judgment skeleton (the pair runs before the first skeleton call)",
  "the other party's clarification answers (cross-party, at every level)",
] as const;

export interface AdvocateInput {
  readonly seat: AdvocateSeat;
  readonly party: string;
  /** The exact bytes this seat is sent, after the task turn. */
  readonly text: string;
  /** What this seat did not receive. See `ADVOCATE_WITHHELD`. */
  readonly withheld: readonly string[];
  /** Ids of the utterances this party spoke, as shown to this seat. */
  readonly ownUtteranceIds: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The clarification history this seat may see: its own party's, and nothing
 * else.
 *
 * Returns an empty list for the counterparty's seat today (see the header).
 * `asked_of` is emitted so the advocate can tell the difference between "no
 * questions were put to my party" and "the questions were withheld from me" —
 * the second would be a reason to distrust the brief, and it is not what
 * happened.
 */
export function clarificationForParty(
  db: Db,
  caseId: string,
  party: string,
): JsonValue {
  const file = assembleCaseFile(db, caseId);
  const client = file.parties.find((p) => p.isSubmitter)?.pseudonym ?? null;

  if (client === null || client !== party) return [];

  return file.clarification
    .slice()
    .sort((a, b) => a.roundNumber - b.roundNumber)
    .map((round) => ({
      round: round.roundNumber,
      asked_of: party,
      questions: round.questions.map((item) => ({
        question: item.question,
        answer_status: item.status,
        answer: item.answer,
      })),
    }));
}

/**
 * Assemble one seat's prompt input.
 *
 * Byte-stable (CLAUDE.md prompt-cache discipline): every list sorted by a stored
 * value, keys emitted sorted by `stableStringify`, no timestamps anywhere. Two
 * assemblies of an unchanged record produce identical bytes, and the shared
 * evidence block leads so the two seats' prompts share a cache prefix.
 */
export function buildAdvocateInput(
  db: Db,
  caseId: string,
  assignment: AdvocateAssignment,
): AdvocateInput {
  const brief = buildCitableBrief(db, caseId);
  const own = brief.utterances
    .filter((utterance) => utterance.speaker === assignment.party)
    .slice()
    .sort((a, b) => compare(a.id, b.id));

  const issues = listIssues(db, caseId);

  const sections: readonly { readonly title: string; readonly body: JsonValue }[] =
    [
      {
        title: "Your seat",
        body: {
          format: ADVOCATE_INPUT_FORMAT,
          seat: assignment.seat,
          for_party: assignment.party,
          for_party_is_the_submitter: assignment.isClient,
          withheld_from_you: [...ADVOCATE_WITHHELD],
        },
      },
      {
        title:
          "Your party's own confirmed words (a subset of the EVIDENCE block " +
          "above — listed again because it is the material you are arguing from)",
        body: own.map((utterance) => ({
          id: utterance.id,
          is_retold: utterance.isRetold,
          text: utterance.text,
        })),
      },
      {
        title: "Issues as fixed with the client",
        body: issues.lists.map((list) => ({
          list: list.category,
          title: list.title,
          purpose: list.purpose,
          items: list.items
            .filter((item) => item.confirmStatus !== "rejected")
            .map((item) => ({
              id: item.id,
              statement: item.humanFinal ?? item.aiDraft,
              confirm_status: item.confirmStatus,
              evidence_refs: item.citations
                .map((citation) => citation.utteranceId)
                .sort(compare),
            }))
            .sort((a, b) => compare(a.id, b.id)),
        })),
      },
      {
        title: "Clarification put to your party, and what came back",
        body: clarificationForParty(db, caseId, assignment.party),
      },
    ];

  const text = [
    `## Case file\n${renderBrief(brief)}`,
    ...sections.map(
      (section) => `## ${section.title}\n${stableStringify(section.body)}`,
    ),
  ].join("\n\n");

  return {
    seat: assignment.seat,
    party: assignment.party,
    text,
    withheld: [...ADVOCATE_WITHHELD],
    ownUtteranceIds: own.map((utterance) => utterance.id),
  };
}

/** The task turn appended after a seat's input. */
export function advocateTask(assignment: AdvocateAssignment): string {
  return (
    `Write the brief for ${assignment.party}. Copy "${assignment.party}" into ` +
    `for_party exactly — the server checks it against the seat it gave you and ` +
    `rejects a brief written for the wrong party. Ground every point in at ` +
    `least one utterance id from the EVIDENCE block; the server resolves every ` +
    `id against the confirmed record and rejects the whole brief on one that ` +
    `does not hold.`
  );
}

/* -------------------------------------------------------------------------- */
/* Checking a returned brief                                                  */
/* -------------------------------------------------------------------------- */

export type AdvocateFaultCode =
  /** The brief was written for a party other than the seat's. */
  | "wrong_party"
  /** A `grounded_in` id does not exist, or is not confirmed (HARD RULE #1). */
  | "invalid_refs";

export interface AdvocateFault {
  readonly code: AdvocateFaultCode;
  readonly message: string;
  readonly citations?: CitationAudit;
}

/** Every grounded claim in a brief, flattened for the citation auditor. */
function citingItems(brief: AdvocateBriefOutput): CitingItem[] {
  const items: CitingItem[] = [];

  brief.strongest_case.forEach((point, at) => {
    items.push({
      label: `strongest_case[${at}]`,
      statement: point.point,
      evidenceRefs: point.grounded_in,
    });
  });
  brief.not_forced_by_the_record.forEach((item, at) => {
    // May legitimately cite nothing: "the record does not settle this" is an
    // argument about absence, and the auditor treats an empty list as a fault.
    if (item.grounded_in.length === 0) return;
    items.push({
      label: `not_forced_by_the_record[${at}]`,
      statement: item.reading,
      evidenceRefs: item.grounded_in,
    });
  });
  brief.must_concede.forEach((item, at) => {
    items.push({
      label: `must_concede[${at}]`,
      statement: item.concession,
      evidenceRefs: item.grounded_in,
    });
  });

  return items;
}

/**
 * Check one returned brief against the record and against its own seat.
 *
 * `can_produce: false` is a real answer and passes: it carries no grounded
 * points to audit, and the empty brief is what the skeleton is then told it has.
 */
export function checkAdvocateBrief(
  db: Db,
  caseId: string,
  assignment: AdvocateAssignment,
  brief: AdvocateBriefOutput,
): AdvocateFault | null {
  if (brief.for_party !== assignment.party) {
    return {
      code: "wrong_party",
      message:
        `Seat ${assignment.seat} argues for ${assignment.party}, and this ` +
        `brief names ${brief.for_party} as its party. A brief filed under the ` +
        `wrong name is not a brief for the other party either — the material ` +
        `it was given is this seat's — so it is rejected rather than re-labelled.`,
    };
  }

  if (!brief.can_produce) return null;

  const audit = auditCitations(db, caseId, citingItems(brief));
  if (!audit.ok) {
    return {
      code: "invalid_refs",
      message: describeCitationFaults(audit),
      citations: audit,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Handing the pair to the skeleton                                           */
/* -------------------------------------------------------------------------- */

/** One finished brief, with the seat that produced it. */
export interface AdvocateBriefRecord {
  readonly seat: AdvocateSeat;
  readonly party: string;
  readonly isClient: boolean;
  readonly brief: AdvocateBriefOutput;
}

/**
 * Seat the finished briefs for the hearing that reads them.
 *
 * The client's advocate goes first, which is doc 05 §B.2's "A-first seating".
 * `clientPseudonym` is read from the dossier being heard, so the swapped arm —
 * whose register calls the other party the client — seats the same two briefs in
 * the other order. Position therefore cannot carry the original assignment into
 * the swap pass, and nothing is renamed to achieve that.
 */
export function seatBriefs(
  briefs: readonly AdvocateBriefRecord[],
  clientPseudonym: string | null,
): readonly AdvocateBriefRecord[] {
  return briefs.slice().sort((x, y) => {
    const xFirst = x.party === clientPseudonym ? 0 : 1;
    const yFirst = y.party === clientPseudonym ? 0 : 1;
    return xFirst - yFirst || compare(x.party, y.party);
  });
}

/**
 * The dossier section the skeleton reads the pair from.
 *
 * Both briefs, whole, plus the statement of what each advocate could not see —
 * a hearing weighing two documents is entitled to know they were written
 * independently, and entitled to know it as a recorded property of the run
 * rather than as an assurance.
 */
export function serializeAdvocateBriefs(
  briefs: readonly AdvocateBriefRecord[],
  clientPseudonym: string | null,
): string {
  const seated = seatBriefs(briefs, clientPseudonym);

  const body: JsonValue = {
    independence:
      "Each brief was generated from the case file and its own party's " +
      "material. Neither advocate received the other's brief, any draft " +
      "skeleton, or the other party's clarification answers. They are two " +
      "independent readings of one record, not a negotiation.",
    briefs: seated.map((record) => ({
      seat: record.seat,
      for_party: record.party,
      for_party_is_the_submitter: record.isClient,
      can_produce: record.brief.can_produce,
      unable_reason: record.brief.unable_reason,
      headline: record.brief.headline,
      strongest_case: record.brief.strongest_case.map((point) => ({
        point: point.point,
        grounded_in: [...point.grounded_in].sort(compare),
      })),
      not_forced_by_the_record: record.brief.not_forced_by_the_record.map(
        (item) => ({
          reading: item.reading,
          why_not_forced: item.why_not_forced,
          grounded_in: [...item.grounded_in].sort(compare),
        }),
      ),
      must_concede: record.brief.must_concede.map((item) => ({
        concession: item.concession,
        grounded_in: [...item.grounded_in].sort(compare),
      })),
    })),
  } as JsonValue;

  return stableStringify(body);
}

/**
 * How the skeleton is told to use the pair.
 *
 * Two advocates arguing opposite sides of one record produce disagreements the
 * record cannot settle, and the instruction that matters is what to do with
 * those: report the spread, never split the difference (doc 05 §B.1.d). The
 * aggregation rule is also enforced in code — the render layer's disagreement
 * display is built deterministically, not asked for — so this text is the
 * request and `renderDisagreement` is the guarantee.
 */
export const ADVOCATE_TASK_NOTE =
  "Two advocate briefs are in the record above, written independently, one " +
  "per party. They are advocacy and not findings: a point is worth what the " +
  "utterances it cites are worth, and a brief's silence about something is not " +
  "evidence. Where the two briefs read the same lines differently and the " +
  "record cannot settle which reading is right, say so as a disagreement — " +
  "the contradictory readings are reported as a contradiction, never averaged " +
  'into a confident middle, and "the truth is somewhere in between" is not a ' +
  "finding this record supports. Use tier \"unknown\", citing nothing, for what " +
  "the record cannot settle.";
