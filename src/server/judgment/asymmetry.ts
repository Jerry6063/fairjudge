/**
 * The record's asymmetry, computed as a fact — SPEC M3 wave B ⑦.
 *
 * A judgment on this product's real case has to say something specific and
 * uncomfortable: the client has never spoken inside the record. All five of
 * their own utterances are still `confirm_status = pending`, so under HARD RULE
 * #1 they are invisible to every fetch the pipeline makes, and every issue item
 * and every adverse fact cites one of the same two confirmed lines — both of
 * them the counterparty's (SPEC M3 decision record, 2026-08-09).
 *
 * The temptation is to hand the model that sentence. This module exists to
 * refuse that. What it produces is **counts**, read out of SQLite:
 *
 *   - how many confirmed, citable lines exist, and who spoke each;
 *   - how many lines each party submitted that are NOT citable, and under which
 *     `confirm_status` they are sitting;
 *   - how many issue items and adverse facts rest on each party's words.
 *
 * The prose is the model's job; the arithmetic is not. A canned sentence would
 * be a sentence that stays true after the record changes, which is the precise
 * failure mode — a disclaimer that survives its own facts. Numbers cannot do
 * that: confirm the client's five lines tomorrow and every figure below moves,
 * and the paragraph written from them moves with it.
 *
 * `verifyRecordBasis` closes the loop on the way back. The model is asked to
 * restate the counts inside `findings.record_basis`, and a restatement that does
 * not match this computation rejects the generation. A judgment is allowed to
 * choose its words about the hole in its evidence; it is not allowed to choose
 * the size of the hole.
 *
 * Everything here is synchronous, takes an explicit `Db`, reads only stored
 * values, and never touches a clock — the output is serialized into a prompt,
 * so the byte-stability discipline in CLAUDE.md applies to all of it.
 */

import { and, eq } from "drizzle-orm";

import {
  CASE_RECORD,
  resolveMaterialGrant,
  visibleMaterial,
  type MaterialAudience,
} from "../access/visibility";
import type { Db } from "../db";
import {
  adverseFacts as adverseFactsTable,
  caseParticipants,
  issues as issuesTable,
  utterances as utterancesTable,
  type ConfirmStatus,
} from "../db/schema";
import { resolveSpeaker } from "../../lib/utterance-speaker";
import type { JsonValue } from "../pipeline/case-file";
import { buildCitableBrief } from "../pipeline/evidence-refs";
import type { RecordBasis } from "./contract";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** How much of the record one party actually accounts for. */
export interface PartyRecordShare {
  readonly pseudonym: string;
  readonly isClient: boolean;
  /** Confirmed lines this party spoke — the only ones anything may cite. */
  readonly citableUtterances: number;
  /** Lines attributed to them in the record, whatever their confirm status. */
  readonly submittedUtterances: number;
  /**
   * Attributed to them but not citable, by status. Sorted by status name, so
   * the serialization is stable; statuses with a zero count are omitted.
   */
  readonly withheldByStatus: readonly {
    readonly status: ConfirmStatus;
    readonly count: number;
  }[];
  /** Issue items (any list) resting on at least one line this party spoke. */
  readonly issueItemsRestingOnTheirWords: number;
  /** Adverse facts about the client resting on at least one of their lines. */
  readonly adverseFactsRestingOnTheirWords: number;
}

export interface RecordAsymmetry {
  readonly caseId: string;
  /** Pseudonym of the party who brought the case; null if nobody is marked. */
  readonly clientPseudonym: string | null;
  /** Every party, sorted by pseudonym. */
  readonly parties: readonly PartyRecordShare[];
  readonly citableUtterances: {
    readonly total: number;
    readonly byClient: number;
    readonly byCounterparty: number;
    /**
     * Confirmed but attributed to nobody (an unassigned line, a clock reading).
     * Citable, and grounds nothing about either party — which is why it is
     * counted apart rather than folded into a party's share.
     */
    readonly unattributed: number;
  };
  /** Parties with no confirmed line of their own. Sorted; may be empty. */
  readonly partiesWithoutCitableUtterance: readonly string[];
  /** What is on file but cannot be cited, across the whole case. */
  readonly uncitableUtterances: {
    readonly total: number;
    readonly byStatus: readonly {
      readonly status: ConfirmStatus;
      readonly count: number;
    }[];
  };
  /** How much downstream work rests on words, and on whose. */
  readonly derivedWork: {
    readonly issueItems: number;
    readonly adverseFacts: number;
  };
  /**
   * True when exactly one party has confirmed speech in the record. Derived,
   * not asserted — and deliberately not a sentence.
   */
  readonly singleVoice: boolean;
}

/* -------------------------------------------------------------------------- */
/* Computation                                                                */
/* -------------------------------------------------------------------------- */

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read one case's asymmetry.
 *
 * The citable half comes from `buildCitableBrief` — the same query every citing
 * prompt is built from and the same one `checkEvidenceRefs` validates against —
 * so "what the model was shown", "what may be cited" and "what the numbers
 * describe" are one set by construction, not three that happen to agree.
 *
 * The uncitable half is read straight off `utterances`, because that is the
 * only place the fact lives: a pending line is absent from every other view in
 * the system, and a judgment that cannot see how much was withheld cannot say
 * how thin its record is.
 */
export function computeRecordAsymmetry(
  db: Db,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): RecordAsymmetry {
  const grant = resolveMaterialGrant(db, caseId, audience);
  const brief = buildCitableBrief(db, caseId, audience);
  const clientPseudonym = brief.client?.pseudonym ?? null;

  const participants = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const candidates = participants.map((p) => ({
    id: p.id,
    pseudonym: p.pseudonym,
  }));

  // Every line this audience may read, citable or not. `resolveSpeaker` is the
  // one reading of the two speaker columns (see `lib/utterance-speaker.ts`);
  // re-deriving it here with a second rule is how two layers start disagreeing
  // about who spoke.
  //
  // The visibility predicate matters more here than anywhere else: this is the
  // half of the module that counts what is NOT citable, and a count is a leak
  // like any other. "She has 40 lines you cannot see" is a fact about her
  // private material, and a judgment that printed it would be quoting her
  // withheld record by the number.
  const allRows = db
    .select({
      id: utterancesTable.id,
      confirmStatus: utterancesTable.confirmStatus,
      speakerParticipantId: utterancesTable.speakerParticipantId,
      speakerLabel: utterancesTable.speakerLabel,
    })
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        visibleMaterial(utterancesTable, grant),
      ),
    )
    .all();

  const citableIds = new Set(brief.utterances.map((u) => u.id));
  const speakerOf = new Map<string, string | null>();
  for (const row of allRows) {
    const speaker = resolveSpeaker(row, candidates);
    speakerOf.set(row.id, speaker.kind === "participant" ? speaker.pseudonym : null);
  }

  /** Utterance ids a set of items cites, per party, counted item-wise. */
  const restingOn = (
    refLists: readonly (readonly string[])[],
  ): ReadonlyMap<string, number> => {
    const tally = new Map<string, number>();
    for (const refs of refLists) {
      const parties = new Set<string>();
      for (const ref of refs) {
        // Only citable lines count. An item pointing at a line that has since
        // been un-confirmed rests on nothing, and inflating a party's share
        // with it would overstate exactly the thing being measured.
        if (!citableIds.has(ref)) continue;
        const speaker = speakerOf.get(ref) ?? null;
        if (speaker !== null) parties.add(speaker);
      }
      for (const party of parties) {
        tally.set(party, (tally.get(party) ?? 0) + 1);
      }
    }
    return tally;
  };

  const issueRefs = db
    .select({ refs: issuesTable.evidenceRefs })
    .from(issuesTable)
    .where(eq(issuesTable.caseId, caseId))
    .all()
    .map((row) => row.refs ?? []);

  const adverseRefs = db
    .select({ refs: adverseFactsTable.evidenceRefs })
    .from(adverseFactsTable)
    .where(eq(adverseFactsTable.caseId, caseId))
    .all()
    .map((row) => row.refs ?? []);

  const issueTally = restingOn(issueRefs);
  const adverseTally = restingOn(adverseRefs);

  const parties: PartyRecordShare[] = participants
    .map((party) => {
      const mine = allRows.filter(
        (row) => speakerOf.get(row.id) === party.pseudonym,
      );
      const withheld = new Map<ConfirmStatus, number>();
      for (const row of mine) {
        if (citableIds.has(row.id)) continue;
        withheld.set(row.confirmStatus, (withheld.get(row.confirmStatus) ?? 0) + 1);
      }
      return {
        pseudonym: party.pseudonym,
        isClient: party.isSubmitter,
        citableUtterances: mine.filter((row) => citableIds.has(row.id)).length,
        submittedUtterances: mine.length,
        withheldByStatus: [...withheld.entries()]
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => compare(a.status, b.status)),
        issueItemsRestingOnTheirWords: issueTally.get(party.pseudonym) ?? 0,
        adverseFactsRestingOnTheirWords: adverseTally.get(party.pseudonym) ?? 0,
      };
    })
    .sort((a, b) => compare(a.pseudonym, b.pseudonym));

  const byClient =
    clientPseudonym === null
      ? 0
      : brief.utterances.filter((u) => u.speaker === clientPseudonym).length;
  const attributedPseudonyms = new Set(participants.map((p) => p.pseudonym));
  const attributed = brief.utterances.filter((u) =>
    attributedPseudonyms.has(u.speaker),
  ).length;

  const caseWideWithheld = new Map<ConfirmStatus, number>();
  for (const row of allRows) {
    if (citableIds.has(row.id)) continue;
    caseWideWithheld.set(
      row.confirmStatus,
      (caseWideWithheld.get(row.confirmStatus) ?? 0) + 1,
    );
  }

  return {
    caseId,
    clientPseudonym,
    parties,
    citableUtterances: {
      total: brief.utterances.length,
      byClient,
      byCounterparty: attributed - byClient,
      unattributed: brief.utterances.length - attributed,
    },
    partiesWithoutCitableUtterance: parties
      .filter((party) => party.citableUtterances === 0)
      .map((party) => party.pseudonym)
      .sort(compare),
    uncitableUtterances: {
      total: allRows.length - citableIds.size,
      byStatus: [...caseWideWithheld.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => compare(a.status, b.status)),
    },
    derivedWork: {
      issueItems: issueRefs.length,
      adverseFacts: adverseRefs.length,
    },
    singleVoice: parties.filter((party) => party.citableUtterances > 0).length === 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The asymmetry as the prompt carries it: numbers and pseudonyms, no prose.
 *
 * Byte-stable — every list is already sorted by a stored value, keys are
 * emitted through `stableStringify` by the caller, and nothing here reads a
 * clock or a counter.
 */
export function serializeRecordAsymmetry(
  asymmetry: RecordAsymmetry,
): JsonValue {
  return {
    client_pseudonym: asymmetry.clientPseudonym,
    citable_utterances: {
      total: asymmetry.citableUtterances.total,
      by_client: asymmetry.citableUtterances.byClient,
      by_counterparty: asymmetry.citableUtterances.byCounterparty,
      unattributed: asymmetry.citableUtterances.unattributed,
    },
    parties_without_citable_utterance: [
      ...asymmetry.partiesWithoutCitableUtterance,
    ],
    uncitable_utterances: {
      total: asymmetry.uncitableUtterances.total,
      by_confirm_status: asymmetry.uncitableUtterances.byStatus.map((entry) => ({
        confirm_status: entry.status,
        count: entry.count,
      })),
    },
    parties: asymmetry.parties.map((party) => ({
      pseudonym: party.pseudonym,
      is_client: party.isClient,
      citable_utterances: party.citableUtterances,
      utterances_on_file: party.submittedUtterances,
      not_citable_by_confirm_status: party.withheldByStatus.map((entry) => ({
        confirm_status: entry.status,
        count: entry.count,
      })),
      issue_items_resting_on_their_words: party.issueItemsRestingOnTheirWords,
      adverse_facts_resting_on_their_words:
        party.adverseFactsRestingOnTheirWords,
    })),
    derived_work: {
      issue_items_total: asymmetry.derivedWork.issueItems,
      adverse_facts_total: asymmetry.derivedWork.adverseFacts,
    },
    single_voice: asymmetry.singleVoice,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/** One number the model restated wrongly. */
export interface RecordBasisMismatch {
  /** Field path inside `findings.record_basis`. */
  readonly path: string;
  /** What the database says. */
  readonly expected: string;
  /** What the generation claimed. */
  readonly actual: string;
}

/**
 * Check the model's restatement of the record against the record.
 *
 * `record_basis` is the one place a judgment states the size of its own
 * evidentiary hole, and the whole point of computing the numbers here is that
 * they are not the model's to choose. A mismatch is not rounded off or
 * corrected in place — the caller rejects the generation, because a fact layer
 * that miscounts its own foundation has already reasoned from the wrong record.
 *
 * The `statement` paragraph is deliberately NOT checked: the words are the
 * model's, the arithmetic is not.
 */
export function verifyRecordBasis(
  asymmetry: RecordAsymmetry,
  basis: RecordBasis,
): readonly RecordBasisMismatch[] {
  const mismatches: RecordBasisMismatch[] = [];

  const expectNumber = (path: string, expected: number, actual: number): void => {
    if (expected === actual) return;
    mismatches.push({ path, expected: String(expected), actual: String(actual) });
  };

  if (
    asymmetry.clientPseudonym !== null &&
    basis.client_pseudonym !== asymmetry.clientPseudonym
  ) {
    mismatches.push({
      path: "client_pseudonym",
      expected: asymmetry.clientPseudonym,
      actual: basis.client_pseudonym,
    });
  }

  expectNumber(
    "citable_utterances.total",
    asymmetry.citableUtterances.total,
    basis.citable_utterances.total,
  );
  expectNumber(
    "citable_utterances.by_client",
    asymmetry.citableUtterances.byClient,
    basis.citable_utterances.by_client,
  );
  expectNumber(
    "citable_utterances.by_counterparty",
    asymmetry.citableUtterances.byCounterparty,
    basis.citable_utterances.by_counterparty,
  );

  const claimed = [...basis.parties_without_citable_utterance].sort(compare);
  const actual = [...asymmetry.partiesWithoutCitableUtterance];
  if (claimed.length !== actual.length || claimed.some((p, i) => p !== actual[i])) {
    mismatches.push({
      path: "parties_without_citable_utterance",
      expected: actual.length === 0 ? "(none)" : actual.join(", "),
      actual: claimed.length === 0 ? "(none)" : claimed.join(", "),
    });
  }

  return mismatches;
}

/** The mismatch report, in one string — shown to a user, handed to the model. */
export function describeRecordBasisMismatches(
  mismatches: readonly RecordBasisMismatch[],
): string {
  if (mismatches.length === 0) return "";
  return (
    `findings.record_basis does not match the record it describes:\n` +
    mismatches
      .map(
        (m) =>
          `  - ${m.path}: the record says ${m.expected}, the judgment says ${m.actual}`,
      )
      .join("\n")
  );
}
