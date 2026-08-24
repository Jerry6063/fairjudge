/**
 * Evidence-reference validation — HARD RULE #1, enforced in code.
 *
 * Every model-emitted `evidence_ref` is an utterance id, and this module is the
 * only thing that decides whether one may stand. Two questions, both answered
 * from SQLite and never from the prompt:
 *
 *   1. Does that utterance exist, in THIS case?
 *   2. Is its `confirm_status` one a human has signed off (`confirmed` /
 *      `edited`)?
 *
 * A reference that fails either question rejects the whole generation. It is
 * never dropped, never repaired, never "kept without the citation" — and that
 * is the entire point. A hallucinated id that is quietly deleted looks exactly
 * like an item that was written carefully and cited nothing, so the failure
 * disappears into a plausible-looking list. Failing the generation is the only
 * outcome that stays visible: the caller retries once with the faults named,
 * and if the second attempt is still wrong the user sees an error instead of a
 * clean list resting on a citation that does not exist.
 *
 * The same module also builds the brief the prompt is written from
 * (`buildCitableBrief`). That co-location is deliberate: the set of ids the
 * model is *shown* and the set of ids the validator will *accept* are read from
 * one query with one predicate, so the two cannot drift apart. If they were in
 * separate modules, a filter changed on one side would silently widen or narrow
 * the other.
 *
 * Everything here is synchronous and takes an explicit `Db`, so the tests drive
 * exactly the code path the server action does.
 */

import { eq, inArray } from "drizzle-orm";

import {
  CASE_RECORD,
  isVisible,
  resolveMaterialGrant,
  type MaterialAudience,
} from "../access/visibility";
import type { Db } from "../db";
import {
  caseParticipants,
  utterances as utterancesTable,
  type ConfirmStatus,
  type ParticipantRole,
} from "../db/schema";
import { listCitableUtterances } from "../evidence/workbench";
import { resolveSpeaker } from "../../lib/utterance-speaker";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Confirm statuses a citation may point at. `edited` counts because the human
 * wrote that text themselves; `pending` is unreviewed machine output and
 * `rejected` was thrown away on purpose.
 */
export const CITABLE_CONFIRM_STATUSES: readonly ConfirmStatus[] = [
  "confirmed",
  "edited",
];

/** Why one reference cannot stand. */
export type EvidenceRefFault =
  /** Not a non-empty string — the model returned something that is not an id. */
  | "malformed"
  /** No utterance anywhere carries this id. The citation is invented. */
  | "unknown"
  /** The utterance exists but belongs to a different case. */
  | "foreign_case"
  /**
   * In this case, but outside what this audience may read (SPEC M5 ①). The line
   * was never in the bytes the model was given, so a citation to it is either a
   * hallucination that happened to land on a real id or a leak in the making.
   * Either way it cannot stand.
   */
  | "not_in_record"
  /** In this case, but `confirm_status` is not confirmed/edited. */
  | "unconfirmed";

export interface EvidenceRefRejection {
  /** The reference exactly as the model returned it (stringified if it was not). */
  readonly ref: string;
  readonly fault: EvidenceRefFault;
  /** Known only when the row was found; null otherwise. */
  readonly status: ConfirmStatus | null;
  /** One sentence naming what is wrong, safe to show a user and a model. */
  readonly detail: string;
}

export interface EvidenceRefCheck {
  readonly ok: boolean;
  /** References that exist in this case and are confirmed, de-duplicated. */
  readonly valid: readonly string[];
  readonly rejected: readonly EvidenceRefRejection[];
}

/* -------------------------------------------------------------------------- */
/* Reference checking                                                         */
/* -------------------------------------------------------------------------- */

const DETAIL: Readonly<Record<EvidenceRefFault, string>> = {
  malformed: "not an utterance id",
  unknown: "no utterance with this id exists",
  foreign_case: "that utterance belongs to a different case",
  not_in_record:
    "that utterance is not part of this case's record — its owner has not " +
    "consented to it being read here",
  unconfirmed: "that utterance has not been confirmed",
};

/** Render an arbitrary model value as a printable ref, for the fault report. */
function asRefLabel(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    /* c8 ignore next -- JSON.stringify only throws on cycles/BigInt. */
    return String(value);
  }
}

/**
 * Check one item's references against the database.
 *
 * Duplicates inside a single item collapse into one valid entry — repeating a
 * legal citation is untidy, not a hallucination, and nothing is hidden by it:
 * the id is still checked and still stored.
 */
export function checkEvidenceRefs(
  db: Db,
  caseId: string,
  refs: readonly unknown[],
  audience: MaterialAudience = CASE_RECORD,
): EvidenceRefCheck {
  const valid: string[] = [];
  const rejected: EvidenceRefRejection[] = [];
  const grant = resolveMaterialGrant(db, caseId, audience);

  const wanted: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.trim() === "") {
      rejected.push({
        ref: asRefLabel(ref),
        fault: "malformed",
        status: null,
        detail: DETAIL.malformed,
      });
      continue;
    }
    wanted.push(ref);
  }

  if (wanted.length > 0) {
    const rows = db
      .select({
        id: utterancesTable.id,
        caseId: utterancesTable.caseId,
        confirmStatus: utterancesTable.confirmStatus,
        ownerParticipantId: utterancesTable.ownerParticipantId,
        visibility: utterancesTable.visibility,
      })
      .from(utterancesTable)
      .where(inArray(utterancesTable.id, [...new Set(wanted)]))
      .all();
    const found = new Map(rows.map((row) => [row.id, row]));

    const seen = new Set<string>();
    for (const ref of wanted) {
      if (seen.has(ref)) continue;
      seen.add(ref);

      const row = found.get(ref);
      if (row === undefined) {
        rejected.push({
          ref,
          fault: "unknown",
          status: null,
          detail: DETAIL.unknown,
        });
        continue;
      }
      if (row.caseId !== caseId) {
        rejected.push({
          ref,
          fault: "foreign_case",
          status: row.confirmStatus,
          detail: DETAIL.foreign_case,
        });
        continue;
      }
      // Before the confirm check, because it is the stronger objection: an item
      // citing a line the audience was never shown is not a near-miss on a
      // pending row, it is a claim resting on material this hearing has no
      // consent to read.
      if (!isVisible(row, grant)) {
        rejected.push({
          ref,
          fault: "not_in_record",
          status: row.confirmStatus,
          detail: DETAIL.not_in_record,
        });
        continue;
      }
      if (!CITABLE_CONFIRM_STATUSES.includes(row.confirmStatus)) {
        rejected.push({
          ref,
          fault: "unconfirmed",
          status: row.confirmStatus,
          detail: `${DETAIL.unconfirmed} (confirm_status: ${row.confirmStatus})`,
        });
        continue;
      }
      valid.push(ref);
    }
  }

  return { ok: rejected.length === 0, valid, rejected };
}

/* -------------------------------------------------------------------------- */
/* Auditing a whole generation                                                */
/* -------------------------------------------------------------------------- */

/** One model-produced item, as the auditor needs to see it. */
export interface CitingItem {
  /** Where it sat in the output, for the fault report (e.g. "disputes_of_fact[1]"). */
  readonly label: string;
  /** The item's own words, quoted back so the report names something readable. */
  readonly statement: string;
  readonly evidenceRefs: readonly unknown[];
}

export interface ItemCitationFault {
  readonly label: string;
  readonly statement: string;
  /** True when the item cited nothing at all — every item must carry refs. */
  readonly uncited: boolean;
  readonly rejected: readonly EvidenceRefRejection[];
}

export interface CitationAudit {
  readonly ok: boolean;
  /** Per-item valid references, in item order — what may be persisted. */
  readonly accepted: readonly { readonly label: string; readonly refs: readonly string[] }[];
  readonly faults: readonly ItemCitationFault[];
}

/**
 * Audit every item of one generation.
 *
 * An item with an empty `evidence_refs` array is a fault of its own: "every
 * item carries evidence_refs" is the half of HARD RULE #1 that a schema
 * `minItems` alone would only ask nicely for.
 */
export function auditCitations(
  db: Db,
  caseId: string,
  items: readonly CitingItem[],
  audience: MaterialAudience = CASE_RECORD,
): CitationAudit {
  const accepted: { label: string; refs: string[] }[] = [];
  const faults: ItemCitationFault[] = [];

  for (const item of items) {
    const check = checkEvidenceRefs(db, caseId, item.evidenceRefs, audience);
    const uncited = item.evidenceRefs.length === 0 || check.valid.length === 0;

    if (check.ok && !uncited) {
      // Copied, not aliased: the audit hands these ids to a caller that writes
      // them to a JSON column, and the caller must not be able to mutate the
      // audit's own record of what it accepted.
      accepted.push({ label: item.label, refs: [...check.valid] });
      continue;
    }
    faults.push({
      label: item.label,
      statement: item.statement,
      // Only report "cited nothing" when there is nothing else to say; an item
      // whose single ref was invented already has its real fault named.
      uncited: item.evidenceRefs.length === 0,
      rejected: check.rejected,
    });
  }

  return { ok: faults.length === 0, accepted, faults };
}

/** Raised when a caller asks for citations to be enforced rather than reported. */
export class EvidenceRefError extends Error {
  readonly audit: CitationAudit;

  constructor(audit: CitationAudit) {
    super(describeCitationFaults(audit));
    this.name = "EvidenceRefError";
    this.audit = audit;
  }
}

/**
 * Enforce HARD RULE #1 at a boundary where a failure is a bug rather than an
 * expected model mistake — persistence, and the judgment path in wave B.
 */
export function assertCitations(
  db: Db,
  caseId: string,
  items: readonly CitingItem[],
  audience: MaterialAudience = CASE_RECORD,
): CitationAudit {
  const audit = auditCitations(db, caseId, items, audience);
  if (!audit.ok) throw new EvidenceRefError(audit);
  return audit;
}

/**
 * The fault report, in one string.
 *
 * Written to be readable by both audiences it has: the user, who is told which
 * claim rested on a citation that does not hold, and the model, which is handed
 * the same text on the retry. Saying it twice in two wordings is how the two
 * drift.
 */
export function describeCitationFaults(audit: CitationAudit): string {
  if (audit.ok) return "";
  const lines = audit.faults.map((fault) => {
    const reasons = fault.uncited
      ? ["it cites no evidence at all"]
      : fault.rejected.map((r) => `${r.ref} — ${r.detail}`);
    return `- ${fault.label} ("${fault.statement}"): ${reasons.join("; ")}`;
  });
  return (
    `${audit.faults.length} item(s) rest on a reference that cannot stand:\n` +
    lines.join("\n")
  );
}

/* -------------------------------------------------------------------------- */
/* The brief a stage is written from                                          */
/* -------------------------------------------------------------------------- */

/** A party of the case, as a stage prompt sees them. */
export interface BriefParticipant {
  readonly id: string;
  /** Egress token (甲 / 乙) — the real name never leaves the process. */
  readonly pseudonym: string;
  readonly role: ParticipantRole;
  /** True for the party who brought the case: the client. */
  readonly isSubmitter: boolean;
}

/** One citable line, as a stage prompt sees it. */
export interface BriefUtterance {
  /** The id a model must cite. Nothing else is a legal `evidence_ref`. */
  readonly id: string;
  /** Pseudonym, "timestamp" for chrome rows, or "unattributed". */
  readonly speaker: string;
  /** HARD RULE #5: a recollection, not a transcript line. */
  readonly isRetold: boolean;
  readonly tone: string | null;
  /** Verbatim. Evidence is never translated or normalized (CLAUDE.md). */
  readonly text: string;
}

export interface CitableBrief {
  readonly caseId: string;
  readonly participants: readonly BriefParticipant[];
  /** The party who brought the case, or null when nobody is marked. */
  readonly client: BriefParticipant | null;
  readonly utterances: readonly BriefUtterance[];
}

/** Speaker label for a row nobody has attributed yet. */
const UNATTRIBUTED = "unattributed";

/** Speaker label for chrome (a clock reading, a system notice). */
const TIMESTAMP = "timestamp";

/**
 * Everything a stage may reason over, and nothing else.
 *
 * The utterance list is exactly `listCitableUtterances` — the query-layer half
 * of HARD RULE #1 and, since M5, of the visibility model — so a line that is
 * unconfirmed, or that this audience has no consent to read, is not merely
 * rejected when cited: it is never shown to the model in the first place.
 */
export function buildCitableBrief(
  db: Db,
  caseId: string,
  audience: MaterialAudience = CASE_RECORD,
): CitableBrief {
  const participants: BriefParticipant[] = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      role: caseParticipants.role,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const candidates = participants.map((p) => ({
    id: p.id,
    pseudonym: p.pseudonym,
  }));

  const utterances: BriefUtterance[] = listCitableUtterances(
    db,
    caseId,
    audience,
  ).map((row) => {
    const speaker = resolveSpeaker(
      { speakerParticipantId: null, speakerLabel: row.speakerLabel },
      candidates,
    );
    return {
      id: row.id,
      speaker:
        speaker.kind === "participant"
          ? speaker.pseudonym
          : speaker.kind === "timestamp"
            ? TIMESTAMP
            : UNATTRIBUTED,
      isRetold: row.isRetold,
      tone: row.tone,
      text: row.text,
    };
  });

  return {
    caseId,
    participants,
    client: participants.find((p) => p.isSubmitter) ?? null,
    utterances,
  };
}

/**
 * Render the brief as the prompt's evidence block.
 *
 * Byte-stable by construction (CLAUDE.md prompt-cache discipline): rows sorted
 * by id, fixed key order, no timestamps, no counters, nothing random. The same
 * case with the same confirmed material produces the same bytes on every run.
 */
export function renderBrief(brief: CitableBrief): string {
  const parties = [...brief.participants]
    .sort((a, b) => (a.pseudonym < b.pseudonym ? -1 : 1))
    .map((p) => ({
      pseudonym: p.pseudonym,
      role: p.role,
      is_client: p.isSubmitter,
    }));

  const evidence = [...brief.utterances]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((u) => ({
      id: u.id,
      speaker: u.speaker,
      is_retold: u.isRetold,
      tone: u.tone,
      text: u.text,
    }));

  return (
    `PARTIES\n${JSON.stringify(parties, null, 2)}\n\n` +
    `EVIDENCE — every confirmed utterance in this case. The \`id\` of a row is ` +
    `the only thing that may appear in an \`evidence_refs\` array. Quote text ` +
    `verbatim in its original language; never translate or paraphrase it.\n` +
    `${JSON.stringify(evidence, null, 2)}`
  );
}
