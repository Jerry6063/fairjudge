/**
 * The transparency view (SPEC M5 ④) — everything this machine holds that
 * concerns one party, with provenance, addressed to that party.
 *
 * This is the artifact that makes the rest of the privacy design checkable by
 * the person it most affects. Every other guarantee in M5 is a promise about a
 * query she cannot see; this is the one screen where she can count the rows
 * herself. So completeness is the requirement, and a missing table is a defect
 * of the same kind as a leak.
 *
 * ## Completeness is enforced, not intended
 *
 * `TRANSPARENCY_TABLE_COVERAGE` names **every table in the database** and says
 * either which section of this view shows its rows, or — in one line a person
 * can read — why it holds nothing about a participant. A test asserts that list
 * against `sqlite_master`, so a table added later fails a test instead of
 * silently going missing. There is exactly one table whose content is covered
 * and deliberately withheld (`safety_screens`), and it is disclosed by name in
 * `limits` rather than being quietly dropped.
 *
 * ## What she is shown, and the line this does not cross
 *
 * A subject-access right is a wider lens than a read audience, and the two must
 * not be confused:
 *
 *   - **Her own material** — always, in full. It is hers.
 *   - **Anything at `visibility = 'case'`** — the owner put it into the shared
 *     record, which is the grant; the visibility model already lets her read it.
 *   - **Lines the record attributes to her**, even when the other party
 *     submitted them and kept them private. This is the one deliberate widening
 *     beyond `visibility.ts`, and it is narrow on purpose: it is her own
 *     sentence, quoted about her, and a transparency view that hides what the
 *     record claims she said would be worthless for the only thing it is for.
 *   - **Derived artifacts** — issues, adverse facts, judgment claims, the
 *     steelman of her position, renditions, the aftermath documents, the egress
 *     ledger. The system authored these *about* her, and a system owes an
 *     account of what it asserts.
 *
 * What it does **not** show is raw material the other party submitted that does
 * not name her and that he has not put into the case record — not its content,
 * and not its count. That is the same sentence as the deletion rule, in the
 * other direction: this system does not hand one person's private records to
 * another unilaterally, and does not erase them unilaterally either. Both halves
 * are stated in `limits`, in plain speech, on the page.
 *
 * ## Provenance is on every row
 *
 * Who submitted it, when, at what confirmed grade, at what confirmation state,
 * and — the fact that decides what she can do about it — whether it is hers.
 * `control` is that answer per row: `delete` for her own material,
 * `request_deletion` for the other party's, `revoke_consent` for documents that
 * could leave this machine, `none` for the audit trails that are records of acts
 * and are not edited.
 *
 * Evidence is quoted verbatim, in the language it was said in (CLAUDE.md), and a
 * line marked `is_retold` renders as a recollection, never as a transcript
 * (HARD RULE #5).
 */

import { and, eq, inArray, or, type SQL } from "drizzle-orm";

import {
  adverseFacts,
  appeals,
  caseParticipants,
  cases,
  clarificationRounds,
  consentEvents,
  deletionAudit,
  deletionRequests,
  egressLedger,
  evidence as evidenceTable,
  events as eventsTable,
  files as filesTable,
  followups,
  improvementContracts,
  issues,
  judgmentExports,
  judgmentPolishRuns,
  judgmentRenditions,
  judgmentSwapTests,
  judgments,
  llmCalls,
  participantIdentities,
  repairScripts,
  steelmanVersions,
  utterances as utterancesTable,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type ConfirmStatus,
  type DeletionTargetKind,
  type EvidenceGrade,
  type VisibilityState,
} from "../db/schema";
import type { Reader } from "../pipeline/stage-machine";
import { consentStandingFor, type ConsentStanding } from "./consent";
import { SHARED_VISIBILITY, type OwnedTable } from "./visibility";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** Format marker, bumped when the document's shape changes. */
export const TRANSPARENCY_FORMAT = "fairjudge.transparency.v1";

/**
 * The sections, in the order she reads them: who she is here, then what came
 * off her own phone, then what the record says about her, then what the system
 * concluded, then what it did with it.
 */
export const TRANSPARENCY_SECTION_IDS = [
  "participant",
  "identity",
  "files",
  "evidence",
  "utterances",
  "events",
  "issues",
  "adverse_facts",
  "steelman",
  "clarification",
  "judgment_claims",
  "renditions",
  "aftermath",
  "consent",
  "deletion_requests",
  "deletion_audit",
  "appeals",
  "exports",
  "egress",
] as const;

export type TransparencySectionId = (typeof TRANSPARENCY_SECTION_IDS)[number];

/** Who put the item on this machine, said in the second person. */
export type ProvenanceSource =
  | "you"
  | "the other party"
  | "the system"
  | "unattributed";

/** What she can do about one item. The asymmetry, stated per row. */
export type TransparencyControl =
  /** Yours: deleting it removes it, and the deletion is audited. */
  | "delete"
  /** Someone else's: you can ask, it is recorded, and nothing is erased by asking. */
  | "request_deletion"
  /** A document that could leave this machine. Revoking consent blocks that. */
  | "revoke_consent"
  /** A record of an act. Append-only, by design — including your own acts. */
  | "none";

/* -------------------------------------------------------------------------- */
/* Coverage — the part that fails a test rather than going missing            */
/* -------------------------------------------------------------------------- */

export interface TableCoverage {
  /** SQL table name, as it appears in `sqlite_master`. */
  readonly table: string;
  /** The section that shows its rows, or null when it holds nothing about a person. */
  readonly section: TransparencySectionId | null;
  /** Why — one line, printed by the test when this list stops matching the schema. */
  readonly note: string;
}

/**
 * Every table in the database, and what this view does with it.
 *
 * `tests/transparency-and-deletion.test.ts` asserts this list against the live
 * `sqlite_master`, in both directions: a new table with no entry fails, and an
 * entry for a table that no longer exists fails too. That is the cheap version
 * of the guarantee this whole module is for — the failure mode of a transparency
 * view is not a crash, it is a quiet omission, and a quiet omission is exactly
 * what a person reading it cannot detect.
 */
export const TRANSPARENCY_TABLE_COVERAGE: readonly TableCoverage[] = [
  {
    table: "cases",
    section: "participant",
    note: "The case itself — its title, stage and output level — is the first thing shown.",
  },
  {
    table: "case_participants",
    section: "participant",
    note: "Her own row: role, pseudonym, participation state, and her decline reason in her own words.",
  },
  {
    table: "participant_identities",
    section: "identity",
    note: "The account a redeemed invitation created. Only hashes of the tokens are stored.",
  },
  {
    table: "files",
    section: "files",
    note: "Uploaded originals: hers, plus anything the other party put into the shared case record.",
  },
  {
    table: "evidence",
    section: "evidence",
    note: "Graded material, with the grade and who signed it off.",
  },
  {
    table: "utterances",
    section: "utterances",
    note: "Every line the record attributes to her, including lines the other party submitted.",
  },
  {
    table: "events",
    section: "events",
    note: "Timeline entries: hers, plus anything in the shared case record.",
  },
  {
    table: "event_evidence",
    section: null,
    note:
      "A join row saying which evidence belongs to which event. Both ends are " +
      "listed above; the link itself asserts nothing about a person.",
  },
  {
    table: "clarification_rounds",
    section: "clarification",
    note: "Questions the system asked about her, and the other party's answers, verbatim.",
  },
  {
    table: "steelman_versions",
    section: "steelman",
    note: "The system's attempt to argue her side before she arrived. About her by construction.",
  },
  {
    table: "issues",
    section: "issues",
    note: "Disputed and undisputed items that name her or rest on a line of hers.",
  },
  {
    table: "adverse_facts",
    section: "adverse_facts",
    note: "Facts held against one party that name her or rest on a line of hers.",
  },
  {
    table: "judgments",
    section: "judgment_claims",
    note: "Every claim in every version of the judgment that names her or cites her lines.",
  },
  {
    table: "judgment_swap_tests",
    section: "judgment_claims",
    note: "The bias audit of a hearing about her: both skeletons and what differed.",
  },
  {
    table: "judgment_renditions",
    section: "renditions",
    note: "Documents written from the judgment, including the one addressed to her.",
  },
  {
    table: "judgment_polish_runs",
    section: "renditions",
    note: "Drafts of the judgment narrative kept for audit. They name her, so they are listed.",
  },
  {
    table: "improvement_contracts",
    section: "aftermath",
    note: "Commitments made after the judgment about behaviour towards her.",
  },
  {
    table: "repair_scripts",
    section: "aftermath",
    note: "A suggested script for a conversation with her.",
  },
  {
    table: "followups",
    section: "aftermath",
    note: "Scheduled check-ins on whether those commitments held.",
  },
  {
    table: "appeals",
    section: "appeals",
    note: "Re-hearings, including any she filed herself.",
  },
  {
    table: "consent_events",
    section: "consent",
    note: "Every grant and revocation naming her as actor or subject. Append-only.",
  },
  {
    table: "deletion_requests",
    section: "deletion_requests",
    note: "Deletion she asked for, and the answer she was given, in his words.",
  },
  {
    table: "deletion_audit",
    section: "deletion_audit",
    note: "Every deletion and every request, as an immutable log.",
  },
  {
    table: "judgment_exports",
    section: "exports",
    note: "Every copy of a document naming her that left this machine.",
  },
  {
    table: "safety_screens",
    section: null,
    note:
      "COVERED AND WITHHELD, disclosed in `limits`: a safety questionnaire is " +
      "the one record whose disclosure to the other party can put somebody in " +
      "danger, and that is true whichever party is asking. Its existence is " +
      "stated on the page; its answers are not shown to anyone but their author.",
  },
  {
    table: "llm_calls",
    section: "egress",
    note: "That a model was asked about this case, which model, and how much of it.",
  },
  {
    table: "egress_ledger",
    section: "egress",
    note: "Every payload that left this machine, by hash and size. Pseudonymized before it left.",
  },
];

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface TransparencyProvenance {
  readonly source: ProvenanceSource;
  /** The submitter's egress token (甲 / 乙). Null for system-generated rows. */
  readonly submittedByPseudonym: string | null;
  readonly submittedByParticipantId: string | null;
  /** When the row was written. Null only where the table keeps no timestamp. */
  readonly submittedAt: Date | null;
  /** Human-confirmed grade. A suggestion is not a grade, and is reported apart. */
  readonly grade: EvidenceGrade | null;
  readonly gradeSuggested: EvidenceGrade | null;
  readonly confirmStatus: ConfirmStatus | null;
  readonly visibility: VisibilityState | null;
}

export interface TransparencyItem {
  readonly section: TransparencySectionId;
  /** SQL table the row lives in — the same name `TRANSPARENCY_TABLE_COVERAGE` uses. */
  readonly table: string;
  /** Row id, or `<rowId>#<part>` where one row holds several separable things. */
  readonly id: string;
  /** The handle a deletion names, when this row is one. Null when it is not deletable. */
  readonly targetKind: DeletionTargetKind | null;
  /** The row id a deletion names — the bare id, without any `#part` suffix. */
  readonly targetId: string | null;
  /** One line. Chinese evidence is quoted verbatim and never translated. */
  readonly summary: string;
  readonly provenance: TransparencyProvenance;
  readonly control: TransparencyControl;
  /** Which relation put it here — "you submitted it", "the record says you said it". */
  readonly because: string;
}

export interface TransparencySection {
  readonly id: TransparencySectionId;
  readonly title: string;
  /** What this section is, addressed to her, in plain speech. */
  readonly explanation: string;
  readonly items: readonly TransparencyItem[];
}

/** One thing she can do, and whether she can do it right now. */
export interface TransparencyRight {
  readonly id:
    | "delete_own_material"
    | "request_deletion"
    | "case_record"
    | "counterparty_read"
    | "named_rendition";
  readonly statement: string;
  /** Where the matching consent scope stands. Absent for the deletion rights. */
  readonly standing: ConsentStanding | null;
}

export interface TransparencyView {
  readonly format: string;
  readonly caseId: string;
  readonly participantId: string;
  readonly pseudonym: string;
  readonly generatedAt: Date;
  readonly sections: readonly TransparencySection[];
  /** Every item, flattened, in section order. */
  readonly items: readonly TransparencyItem[];
  readonly counts: Readonly<Record<TransparencySectionId, number>>;
  readonly total: number;
  readonly rights: readonly TransparencyRight[];
  /** What this page does not show, and why. Shown to her, not only documented. */
  readonly limits: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export class TransparencyError extends Error {
  readonly code: "participant_not_in_case";

  constructor(message: string) {
    super(message);
    this.name = "TransparencyError";
    this.code = "participant_not_in_case";
  }
}

/* -------------------------------------------------------------------------- */
/* Section copy                                                               */
/* -------------------------------------------------------------------------- */

const SECTION_TITLES: Readonly<Record<TransparencySectionId, string>> = {
  participant: "This case, and your place in it",
  identity: "Your account",
  files: "Files",
  evidence: "Graded material",
  utterances: "Lines the record attributes to you",
  events: "Timeline entries",
  issues: "Disputed and undisputed points",
  adverse_facts: "Facts held against a party",
  steelman: "The system's attempt to argue your side",
  clarification: "Questions asked about you, and the answers given",
  judgment_claims: "What the judgment claims",
  renditions: "Documents written about you",
  aftermath: "What was planned afterwards",
  consent: "What you have granted and withdrawn",
  deletion_requests: "Deletion you have asked for",
  deletion_audit: "The deletion log",
  appeals: "Re-hearings",
  exports: "Copies that left this machine",
  egress: "What was sent to a language model",
};

const SECTION_EXPLANATIONS: Readonly<Record<TransparencySectionId, string>> = {
  participant:
    "The case you were named in, and the row that records you as a party to it.",
  identity:
    "The account created when an invitation was redeemed. Only a hash of each " +
    "token is stored, so this file does not contain a working way in.",
  files:
    "Original uploads. Yours are listed in full; the other party's appear only " +
    "once he has put them into the shared case record.",
  evidence:
    "Material after grading. A grade is only a grade once a person confirmed " +
    "it — until then it is shown as a suggestion.",
  utterances:
    "Every line attributed to you, including lines the other party submitted " +
    "and kept private. Your own sentence, quoted about you, is yours to see. " +
    "A line marked as recalled is somebody's memory of what you said, not a " +
    "recording of it, and is labelled that way here.",
  events: "Dated entries on the timeline this case was built from.",
  issues:
    "How the case was framed: what both sides agree on, what is disputed as " +
    "fact, and what is disputed as a standard.",
  adverse_facts:
    "Facts recorded as weighing against a party. They are listed here when " +
    "they name you or rest on a line of yours.",
  steelman:
    "Before you arrived, the system wrote the strongest version of your side " +
    "it could from the record it had, and the other party was asked whether it " +
    "was fair. This is that text and his answer.",
  clarification:
    "The system asked follow-up questions and the other party answered them. " +
    "Answers are quoted exactly as written.",
  judgment_claims:
    "The judgment is a list of numbered claims, each with a confidence and a " +
    "tier, plus the lines it rests on. These are the ones that name you or " +
    "cite something you said.",
  renditions:
    "Documents generated from the judgment, listed by what they are rather " +
    "than reproduced here. The one addressed to you is the one you can be sent.",
  aftermath:
    "Commitments, repair scripts and scheduled check-ins written after a " +
    "judgment. They describe behaviour towards you.",
  consent:
    "Consent here is a list of events, not a switch: every grant and every " +
    "withdrawal stays readable, with who said it and when.",
  deletion_requests:
    "Deletion you have asked for on material somebody else submitted, and the " +
    "answer you were given, in their words.",
  deletion_audit:
    "One immutable line per act: every deletion performed and every deletion " +
    "requested, including the ones that were refused.",
  appeals: "Re-hearings of a judgment. You may file your own.",
  exports:
    "Every copy of a document naming you that was exported or shared, by hash " +
    "and size. A blocked export leaves no row, because nothing left.",
  egress:
    "This case is judged with the help of language models. Before anything is " +
    "sent, names are replaced by pseudonyms and the mapping stays on this " +
    "machine. These rows record that a request went out, to whom, and how big " +
    "it was — never its contents.",
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function compare(a: string | null, b: string | null): number {
  const left = a ?? "";
  const right = b ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function byTimeThenId(
  a: { submittedAt: Date | null; id: string },
  b: { submittedAt: Date | null; id: string },
): number {
  const at = a.submittedAt?.getTime() ?? 0;
  const bt = b.submittedAt?.getTime() ?? 0;
  return at - bt || compare(a.id, b.id);
}

/** One line of text out of the confirmation triple: what a human settled on wins. */
function settledText(row: {
  humanFinal: string | null;
  aiDraft: string | null;
}): string {
  return row.humanFinal ?? row.aiDraft ?? "";
}

/** Trim a long body to one readable line without cutting a quote in half silently. */
function oneLine(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the transparency view for one party to one case.
 *
 * A pure read: it writes nothing, takes a `Reader`, and can therefore be called
 * from a page render, from inside a transaction, or from a test without any of
 * the three differing.
 */
export function buildTransparencyView(
  db: Reader,
  caseId: string,
  participantId: string,
  options: { readonly now?: Date } = {},
): TransparencyView {
  const parties = db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const her = parties.find((party) => party.id === participantId);
  if (her === undefined) {
    throw new TransparencyError(
      `Participant ${participantId} is not a party to case ${caseId}, so there ` +
        `is no record of theirs on it to show.`,
    );
  }

  const pseudonymOf = new Map(parties.map((party) => [party.id, party.pseudonym]));
  const submitter = parties.find((party) => party.isSubmitter) ?? null;

  /** Second-person provenance: whose row is this, from where she is standing. */
  const sourceOf = (ownerId: string | null): ProvenanceSource =>
    ownerId === null
      ? "unattributed"
      : ownerId === her.id
        ? "you"
        : "the other party";

  const ownedBy = (
    ownerId: string | null,
    submittedAt: Date | null,
    extra: Partial<TransparencyProvenance> = {},
  ): TransparencyProvenance => ({
    source: sourceOf(ownerId),
    submittedByPseudonym: ownerId === null ? null : (pseudonymOf.get(ownerId) ?? null),
    submittedByParticipantId: ownerId,
    submittedAt,
    grade: null,
    gradeSuggested: null,
    confirmStatus: null,
    visibility: null,
    ...extra,
  });

  const bySystem = (at: Date | null): TransparencyProvenance => ({
    source: "the system",
    submittedByPseudonym: null,
    submittedByParticipantId: null,
    submittedAt: at,
    grade: null,
    gradeSuggested: null,
    confirmStatus: null,
    visibility: null,
  });

  /**
   * Does this text name her? Her pseudonym is what the models and the generated
   * documents use; her display name never leaves this machine but may appear in
   * locally written text. Matching is deliberately generous — an item wrongly
   * shown to the person it is about costs her a line to read, and an item
   * wrongly hidden defeats the page.
   */
  const namesHer = (text: string | null | undefined): boolean => {
    if (!text) return false;
    if (text.includes(her.pseudonym)) return true;
    return her.displayName !== null && her.displayName !== ""
      ? text.includes(her.displayName)
      : false;
  };

  const control = (ownerId: string | null): TransparencyControl =>
    ownerId === her.id ? "delete" : "request_deletion";

  const items: TransparencyItem[] = [];
  const push = (item: TransparencyItem): void => {
    items.push(item);
  };

  /* ---------------------------------------------------------------------- */
  /* participant + cases                                                    */
  /* ---------------------------------------------------------------------- */

  const caseRow = db.select().from(cases).where(eq(cases.id, caseId)).get();
  if (caseRow !== undefined) {
    push({
      section: "participant",
      table: "cases",
      id: caseRow.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `Case ${caseRow.title === null ? "(untitled)" : `“${caseRow.title}”`}, ` +
          `stage ${caseRow.stage}, output level ` +
          `${caseRow.outputLevel ?? "not yet locked"}, status ${caseRow.status}.`,
      ),
      provenance: ownedBy(submitter?.id ?? null, caseRow.createdAt),
      control: "none",
      because: "you are named as a party to this case",
    });
  }

  for (const party of parties) {
    if (party.id !== her.id) continue;
    push({
      section: "participant",
      table: "case_participants",
      id: party.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `You are recorded as the ${party.role}, under the pseudonym ` +
          `${party.pseudonym}. Participation as reported by the other party: ` +
          `${party.participationState}. Your own state in this flow: ` +
          `${party.respondState}.` +
          (party.declineReason === null
            ? ""
            : ` Your reason, as you wrote it: “${party.declineReason}”.`) +
          (party.displayName === null
            ? ""
            : ` A display name is stored locally and is never sent to any model.`),
      ),
      provenance: ownedBy(submitter?.id ?? null, party.createdAt),
      control: "none",
      because: "this row is you",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* identity                                                               */
  /* ---------------------------------------------------------------------- */

  const identityRow = db
    .select()
    .from(participantIdentities)
    .where(eq(participantIdentities.participantId, her.id))
    .get();

  if (identityRow !== undefined) {
    push({
      section: "identity",
      table: "participant_identities",
      id: identityRow.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `An account exists for you` +
          (identityRow.displayName === null
            ? " (no name given)"
            : `, under the name you gave: “${identityRow.displayName}”`) +
          `, created ${identityRow.createdAt.toISOString()}` +
          (identityRow.lastSeenAt === null
            ? ""
            : `, last used ${identityRow.lastSeenAt.toISOString()}`) +
          ". Only a hash of your return token is stored; the token itself is not " +
          "in this database.",
      ),
      provenance: ownedBy(her.id, identityRow.createdAt),
      control: "none",
      because: "you redeemed an invitation",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* files / evidence / utterances / events                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Hers, or in the shared case record. The predicate the four material lists
   * rest on — deliberately expressed against `OwnedTable`, the same shape
   * `visibility.ts` uses, so the two cannot describe different columns.
   */
  const hersOrShared = (table: OwnedTable): SQL =>
    or(
      eq(table.ownerParticipantId, her.id),
      eq(table.visibility, SHARED_VISIBILITY),
    ) as SQL;

  const fileRows = db
    .select()
    .from(filesTable)
    .where(and(eq(filesTable.caseId, caseId), hersOrShared(filesTable)))
    .all();

  for (const row of fileRows) {
    push({
      section: "files",
      table: "files",
      id: row.id,
      targetKind: "file",
      targetId: row.id,
      summary: oneLine(
        `${row.kind} ${row.originalFilename === null ? "(no filename recorded)" : `“${row.originalFilename}”`}` +
          `, ${row.byteSize ?? "unknown"} bytes, content hash ${row.sha256.slice(0, 12)}…`,
      ),
      provenance: ownedBy(row.ownerParticipantId, row.createdAt, {
        visibility: row.visibility,
      }),
      control: control(row.ownerParticipantId),
      because:
        row.ownerParticipantId === her.id
          ? "you uploaded it"
          : "it is in the shared case record",
    });
  }

  const evidenceRows = db
    .select()
    .from(evidenceTable)
    .where(and(eq(evidenceTable.caseId, caseId), hersOrShared(evidenceTable)))
    .all();

  for (const row of evidenceRows) {
    push({
      section: "evidence",
      table: "evidence",
      id: row.id,
      targetKind: "evidence",
      targetId: row.id,
      summary: oneLine(
        `${row.sourceType} material` +
          (row.contentSummary === null ? "" : `: “${row.contentSummary}”`) +
          `. Grade: ${
            row.gradeFinal === null
              ? `not confirmed${row.gradeSuggested === null ? "" : ` (suggested ${row.gradeSuggested})`}`
              : row.gradeFinal
          }.` +
          (row.gradeRationale === null ? "" : ` Reason: ${row.gradeRationale}`),
      ),
      provenance: ownedBy(row.ownerParticipantId, row.createdAt, {
        grade: row.gradeFinal,
        gradeSuggested: row.gradeSuggested,
        visibility: row.visibility,
      }),
      control: control(row.ownerParticipantId),
      because:
        row.ownerParticipantId === her.id
          ? "you submitted it"
          : "it is in the shared case record",
    });
  }

  /*
   * Utterances carry the one deliberate widening beyond `visibility.ts`: a line
   * the record attributes to her is shown to her even when the other party
   * submitted it and kept it private. See the module header.
   */
  const utteranceRows = db
    .select()
    .from(utterancesTable)
    .where(
      and(
        eq(utterancesTable.caseId, caseId),
        or(
          hersOrShared(utterancesTable),
          eq(utterancesTable.speakerParticipantId, her.id),
          eq(utterancesTable.speakerLabel, her.pseudonym),
        ),
      ),
    )
    .all();

  /** Her lines, by id — what a claim or an issue "resting on something of hers" means. */
  const herUtteranceIds = new Set(
    utteranceRows
      .filter(
        (row) =>
          row.ownerParticipantId === her.id ||
          row.speakerParticipantId === her.id ||
          row.speakerLabel === her.pseudonym,
      )
      .map((row) => row.id),
  );

  for (const row of utteranceRows) {
    const text = settledText(row);
    const who = row.speakerLabel ?? pseudonymOf.get(row.speakerParticipantId ?? "") ?? "unattributed";
    // HARD RULE #5 lives in the render layer, and this is a render layer. The
    // recollection is named as somebody's, because on this page the somebody is
    // not the reader.
    const recollector =
      row.ownerParticipantId === null
        ? "the record"
        : (pseudonymOf.get(row.ownerParticipantId) ?? "the record");
    push({
      section: "utterances",
      table: "utterances",
      id: row.id,
      targetKind: "utterance",
      targetId: row.id,
      summary: oneLine(
        row.isRetold
          ? `as ${recollector} recalls it, ${who} said: “${text}”`
          : `${who}: “${text}”`,
      ),
      provenance: ownedBy(row.ownerParticipantId, row.createdAt, {
        confirmStatus: row.confirmStatus,
        visibility: row.visibility,
      }),
      control: control(row.ownerParticipantId),
      because:
        row.ownerParticipantId === her.id
          ? "you submitted it"
          : row.speakerParticipantId === her.id || row.speakerLabel === her.pseudonym
            ? "the record attributes this line to you"
            : "it is in the shared case record",
    });
  }

  const eventRows = db
    .select()
    .from(eventsTable)
    .where(and(eq(eventsTable.caseId, caseId), hersOrShared(eventsTable)))
    .all();

  for (const row of eventRows) {
    push({
      section: "events",
      table: "events",
      id: row.id,
      targetKind: "event",
      targetId: row.id,
      summary: oneLine(
        `${row.label === null ? "" : `${row.label}: `}${row.title ?? "(untitled)"}` +
          (row.description === null ? "" : ` — ${row.description}`),
      ),
      provenance: ownedBy(row.ownerParticipantId, row.createdAt, {
        confirmStatus: row.confirmStatus,
        visibility: row.visibility,
      }),
      control: control(row.ownerParticipantId),
      because:
        row.ownerParticipantId === her.id
          ? "you logged it"
          : "it is in the shared case record",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* issues / adverse facts — derived, and matched to her by name or by ref */
  /* ---------------------------------------------------------------------- */

  const citesHer = (refs: readonly string[] | null | undefined): boolean =>
    (refs ?? []).some((ref) => herUtteranceIds.has(ref));

  for (const row of db
    .select()
    .from(issues)
    .where(eq(issues.caseId, caseId))
    .all()) {
    const text = settledText(row);
    if (!namesHer(text) && !citesHer(row.evidenceRefs)) continue;
    push({
      section: "issues",
      table: "issues",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(`${row.category}: ${text}`),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: citesHer(row.evidenceRefs)
        ? "it rests on a line attributed to you"
        : "it names you",
    });
  }

  for (const row of db
    .select()
    .from(adverseFacts)
    .where(eq(adverseFacts.caseId, caseId))
    .all()) {
    const text = settledText(row);
    if (!namesHer(text) && !citesHer(row.evidenceRefs)) continue;
    push({
      section: "adverse_facts",
      table: "adverse_facts",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `${text} (acknowledgement: ${row.ackStatus}` +
          (row.ackNote === null ? "" : `, note: “${row.ackNote}”`) +
          ")",
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: citesHer(row.evidenceRefs)
        ? "it rests on a line attributed to you"
        : "it names you",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* steelman — about her by construction, so no filter                     */
  /* ---------------------------------------------------------------------- */

  for (const row of db
    .select()
    .from(steelmanVersions)
    .where(eq(steelmanVersions.caseId, caseId))
    .all()) {
    push({
      section: "steelman",
      table: "steelman_versions",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `v${row.version} (${row.confirmStatus}, the other party's verdict: ` +
          `${row.verdict}): ${settledText(row)}` +
          (row.rebuttal === null ? "" : ` — his rebuttal: “${row.rebuttal}”`),
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "it is an account of your position",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* clarification — one item per question that names her                   */
  /* ---------------------------------------------------------------------- */

  for (const round of db
    .select()
    .from(clarificationRounds)
    .where(eq(clarificationRounds.caseId, caseId))
    .all()) {
    const questions: ClarificationQuestion[] = round.questions ?? [];
    const answers: ClarificationAnswer[] = round.answers ?? [];
    for (const question of questions) {
      const answer = answers.find((entry) => entry.questionId === question.id);
      const answerText = answer?.answer ?? "";
      if (!namesHer(question.question) && !namesHer(answerText)) continue;
      const state = answer?.state ?? (answer?.answer ? "answered" : undefined);
      push({
        section: "clarification",
        table: "clarification_rounds",
        id: `${round.id}#${question.id}`,
        targetKind: null,
        targetId: null,
        summary: oneLine(
          `Round ${round.roundNumber} — asked: “${question.question}” — ` +
            (state === "declined"
              ? `the other party declined to answer${answer?.declineNote ? ` (“${answer.declineNote}”)` : ""}`
              : answerText === ""
                ? "unanswered"
                : `answered: “${answerText}”`),
        ),
        provenance: ownedBy(submitter?.id ?? null, round.createdAt),
        control: "none",
        because: namesHer(question.question)
          ? "the question is about you"
          : "the answer is about you",
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* judgment claims + the bias audit                                       */
  /* ---------------------------------------------------------------------- */

  const judgmentRows = db
    .select()
    .from(judgments)
    .where(eq(judgments.caseId, caseId))
    .all();
  const judgmentIds = judgmentRows.map((row) => row.id);
  const judgmentVersionOf = new Map(judgmentRows.map((row) => [row.id, row.version]));

  for (const row of judgmentRows) {
    for (const claim of readClaims(row.content)) {
      if (!namesHer(claim.statement) && !citesHer(claim.evidenceRefs)) continue;
      push({
        section: "judgment_claims",
        table: "judgments",
        id: `${row.id}#${claim.claimId}`,
        targetKind: null,
        targetId: null,
        summary: oneLine(
          `judgment v${row.version} (${row.status}, ${row.outputLevel}, ` +
            `${row.model}) claim ${claim.claimId} [${claim.tier}, confidence ` +
            `${claim.confidence ?? "unstated"}]: ${claim.statement}`,
        ),
        provenance: bySystem(row.createdAt),
        control: "revoke_consent",
        because: citesHer(claim.evidenceRefs)
          ? "it rests on a line attributed to you"
          : "it names you",
      });
    }
  }

  for (const row of db
    .select()
    .from(judgmentSwapTests)
    .where(eq(judgmentSwapTests.caseId, caseId))
    .all()) {
    push({
      section: "judgment_claims",
      table: "judgment_swap_tests",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `bias audit (${row.arm})` +
          (row.degenerate
            ? `: the record could not support the comparison — ${row.degenerateReason ?? "no reason recorded"}`
            : `: flags ${(row.flags ?? []).join(", ") || "none"}`),
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "it re-ran a hearing about you with the parties exchanged",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* renditions + polish drafts                                             */
  /* ---------------------------------------------------------------------- */

  if (judgmentIds.length > 0) {
    for (const row of db
      .select()
      .from(judgmentRenditions)
      .where(inArray(judgmentRenditions.judgmentId, judgmentIds))
      .all()) {
      push({
        section: "renditions",
        table: "judgment_renditions",
        id: row.id,
        targetKind: null,
        targetId: null,
        summary: oneLine(
          `${row.kind} document for judgment v${judgmentVersionOf.get(row.judgmentId) ?? "?"}, ` +
            `revision ${row.revision}, ` +
            `${row.shareable ? "shareable" : "not shareable"}` +
            (row.shareTokenHash === null
              ? ""
              : `, a share link exists${row.shareExpiresAt === null ? "" : ` until ${row.shareExpiresAt.toISOString()}`}`) +
            `. Generated by ${row.model ?? "no model yet"}.`,
        ),
        provenance: bySystem(row.generatedAt ?? row.createdAt),
        control: "revoke_consent",
        because:
          row.kind === "shareable"
            ? "this is the document written to be given to you"
            : "it is written from a judgment that names you",
      });
    }

    for (const row of db
      .select()
      .from(judgmentPolishRuns)
      .where(inArray(judgmentPolishRuns.judgmentId, judgmentIds))
      .all()) {
      push({
        section: "renditions",
        table: "judgment_polish_runs",
        id: row.id,
        targetKind: null,
        targetId: null,
        summary: oneLine(
          `a draft of the judgment narrative for v${judgmentVersionOf.get(row.judgmentId) ?? "?"} ` +
            `was kept for audit (outcome: ${row.outcome}, model: ${row.model ?? "none"}).`,
        ),
        provenance: bySystem(row.createdAt),
        control: "revoke_consent",
        because: "it is a version of a document that names you",
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* aftermath                                                              */
  /* ---------------------------------------------------------------------- */

  for (const row of db
    .select()
    .from(improvementContracts)
    .where(eq(improvementContracts.caseId, caseId))
    .all()) {
    push({
      section: "aftermath",
      table: "improvement_contracts",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `improvement contract (${row.status}, ${row.confirmStatus}): ` +
          `${JSON.stringify(row.content ?? {})}`,
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "it records commitments about behaviour towards you",
    });
  }

  for (const row of db
    .select()
    .from(repairScripts)
    .where(eq(repairScripts.caseId, caseId))
    .all()) {
    push({
      section: "aftermath",
      table: "repair_scripts",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `repair script (${row.confirmStatus}): ${settledText(row) || (row.content ?? "")}`,
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "it is a script for a conversation with you",
    });
  }

  for (const row of db
    .select()
    .from(followups)
    .where(eq(followups.caseId, caseId))
    .all()) {
    push({
      section: "aftermath",
      table: "followups",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `${row.kind} check-in, ${row.status}, scheduled ${row.scheduledAt.toISOString()}` +
          (row.completedAt === null ? "" : `, completed ${row.completedAt.toISOString()}`),
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "it asks whether commitments about you were kept",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* consent / deletion requests / deletion audit / appeals / exports       */
  /* ---------------------------------------------------------------------- */

  for (const row of db
    .select()
    .from(consentEvents)
    .where(
      and(
        eq(consentEvents.caseId, caseId),
        or(
          eq(consentEvents.actorParticipantId, her.id),
          eq(consentEvents.subjectParticipantId, her.id),
        ),
      ),
    )
    .all()) {
    push({
      section: "consent",
      table: "consent_events",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `${row.actorPseudonym} ${row.kind} ${row.scope} on ` +
          `${row.occurredAt.toISOString()}` +
          (row.note === null ? "" : `: “${row.note}”`),
      ),
      provenance: ownedBy(row.actorParticipantId, row.occurredAt),
      control: "none",
      because:
        row.actorParticipantId === her.id
          ? "you said it"
          : "it is about you",
    });
  }

  for (const row of db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.caseId, caseId))
    .all()) {
    if (row.requesterParticipantId !== her.id) continue;
    push({
      section: "deletion_requests",
      table: "deletion_requests",
      id: row.id,
      targetKind: row.targetKind,
      targetId: row.targetId,
      summary: oneLine(
        `you asked for the ${row.targetKind} ` +
          `${row.targetSummary === null ? row.targetId : `“${row.targetSummary}”`} ` +
          `to be deleted — status: ${row.status}` +
          (row.resolutionNote === null ? "" : `, answer: “${row.resolutionNote}”`),
      ),
      provenance: ownedBy(row.requesterParticipantId, row.createdAt),
      control: "none",
      because: "you asked for it",
    });
  }

  for (const row of db
    .select()
    .from(deletionAudit)
    .where(
      and(
        eq(deletionAudit.caseId, caseId),
        or(
          eq(deletionAudit.actorParticipantId, her.id),
          eq(deletionAudit.targetOwnerParticipantId, her.id),
        ),
      ),
    )
    .all()) {
    push({
      section: "deletion_audit",
      table: "deletion_audit",
      id: row.id,
      targetKind: row.targetKind,
      targetId: row.targetId,
      summary: oneLine(
        `${row.actorPseudonym} ${row.act} — ${row.targetKind} ` +
          `${row.targetSummary === null ? row.targetId : `“${row.targetSummary}”`}` +
          (row.targetOwnerPseudonym === null
            ? ""
            : `, submitted by ${row.targetOwnerPseudonym}`) +
          ` on ${row.occurredAt.toISOString()}` +
          (row.note === null ? "" : `: “${row.note}”`),
      ),
      provenance: ownedBy(row.actorParticipantId, row.occurredAt),
      control: "none",
      because:
        row.actorParticipantId === her.id
          ? "you did it"
          : "it concerns material you submitted",
    });
  }

  for (const row of db
    .select()
    .from(appeals)
    .where(eq(appeals.caseId, caseId))
    .all()) {
    if (row.actorParticipantId !== her.id) continue;
    push({
      section: "appeals",
      table: "appeals",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `you filed an appeal against judgment ` +
          `v${judgmentVersionOf.get(row.originalJudgmentId) ?? "?"} (${row.status})` +
          (row.reason === null ? "" : `: “${row.reason}”`),
      ),
      provenance: ownedBy(row.actorParticipantId, row.createdAt),
      control: "none",
      because: "you filed it",
    });
  }

  for (const row of db
    .select()
    .from(judgmentExports)
    .where(eq(judgmentExports.caseId, caseId))
    .all()) {
    if (
      row.recipientParticipantId !== her.id &&
      row.recipientPseudonym !== her.pseudonym
    ) {
      continue;
    }
    push({
      section: "exports",
      table: "judgment_exports",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `a ${row.kind} copy of judgment v${row.judgmentVersion} went to ` +
          `${row.recipientPseudonym} over ${row.channel} on ` +
          `${row.exportedAt.toISOString()} (${row.byteSize} bytes, sha256 ` +
          `${row.contentSha256.slice(0, 12)}…, watermark ${row.watermark})`,
      ),
      provenance: bySystem(row.exportedAt),
      control: "revoke_consent",
      because: "it names you",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* egress                                                                 */
  /* ---------------------------------------------------------------------- */

  for (const row of db
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.caseId, caseId))
    .all()) {
    push({
      section: "egress",
      table: "llm_calls",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `${row.stage ?? "a stage"} was run on ${row.provider}/${row.model}` +
          (row.stopReason === null ? "" : ` (stop reason: ${row.stopReason})`) +
          `, ${row.inputTokens ?? "?"} tokens in, ${row.outputTokens ?? "?"} out`,
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "this case was reasoned about by a model",
    });
  }

  for (const row of db
    .select()
    .from(egressLedger)
    .where(eq(egressLedger.caseId, caseId))
    .all()) {
    push({
      section: "egress",
      table: "egress_ledger",
      id: row.id,
      targetKind: null,
      targetId: null,
      summary: oneLine(
        `${row.payloadBytes ?? "?"} bytes went to ${row.target}` +
          (row.model === null ? "" : ` (${row.model})`) +
          ` on ${row.createdAt.toISOString()}, payload sha256 ` +
          `${row.payloadSha256.slice(0, 12)}…`,
      ),
      provenance: bySystem(row.createdAt),
      control: "none",
      because: "material from this case left the machine in it",
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Assemble                                                               */
  /* ---------------------------------------------------------------------- */

  const sections: TransparencySection[] = TRANSPARENCY_SECTION_IDS.map((id) => ({
    id,
    title: SECTION_TITLES[id],
    explanation: SECTION_EXPLANATIONS[id],
    items: items
      .filter((item) => item.section === id)
      .sort((a, b) => byTimeThenId(
        { submittedAt: a.provenance.submittedAt, id: a.id },
        { submittedAt: b.provenance.submittedAt, id: b.id },
      )),
  }));

  const ordered = sections.flatMap((section) => section.items);

  const counts = Object.fromEntries(
    sections.map((section) => [section.id, section.items.length]),
  ) as Record<TransparencySectionId, number>;

  return {
    format: TRANSPARENCY_FORMAT,
    caseId,
    participantId: her.id,
    pseudonym: her.pseudonym,
    generatedAt: options.now ?? new Date(),
    sections,
    items: ordered,
    counts,
    total: ordered.length,
    rights: buildRights(db, caseId, her.id),
    limits: LIMITS,
  };
}

/* -------------------------------------------------------------------------- */
/* Rights                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The three things she controls, said plainly — including the one the system
 * will not do.
 *
 * Consent standing is read through `access/consent.ts` rather than restated
 * here: this module reports where consent stands, it does not decide it.
 */
function buildRights(
  db: Reader,
  caseId: string,
  participantId: string,
): TransparencyRight[] {
  const standingFor = (
    scope: "case_record" | "counterparty_read" | "named_rendition",
  ): ConsentStanding => consentStandingFor(db, caseId, participantId, scope);

  return [
    {
      id: "delete_own_material",
      statement:
        "Material you submitted is yours. Deleting it removes it from this " +
        "machine, and the deletion is written to a log that cannot be edited.",
      standing: null,
    },
    {
      id: "request_deletion",
      statement:
        "Material the other party submitted is not yours to erase, and this " +
        "system will not pretend otherwise: it does not delete one person's " +
        "records because the other person asked. What you can do is ask. The " +
        "request is recorded, it is shown to him, and his answer — including a " +
        "refusal — is recorded too and shown to you.",
      standing: null,
    },
    {
      id: "case_record",
      statement:
        "Whether your material forms part of the record this case is judged " +
        "on. Withdraw it and the next hearing does not stand on it. A judgment " +
        "already frozen is not rewritten — it is superseded by a new version.",
      standing: standingFor("case_record"),
    },
    {
      id: "counterparty_read",
      statement:
        "Whether the other party may read what you submitted. Without this, he " +
        "cannot — not on any screen, and not through any query.",
      standing: standingFor("counterparty_read"),
    },
    {
      id: "named_rendition",
      statement:
        "Whether any document naming you may be exported or shared. This one " +
        "you control outright: withdraw it and every export and share link for " +
        "a document naming you stops working immediately.",
      standing: standingFor("named_rendition"),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Limits — printed on the page, not just documented here                     */
/* -------------------------------------------------------------------------- */

const LIMITS: readonly string[] = [
  "This page lists what this machine holds about you on this case. It is not a " +
    "copy of the other party's case file: material he submitted that does not " +
    "name you and that he has not put into the shared record is not listed " +
    "here, and this page does not tell you how much of it there is. That is the " +
    "same rule as the one below, in the other direction — one person's private " +
    "records are neither handed over nor erased because the other person asked.",
  "Items are matched to you by your pseudonym on this case and by the lines " +
    "the record attributes to you. Something that refers to you only obliquely " +
    "may not appear.",
  "This machine also holds the safety questionnaire the party who filed the " +
    "case answered. Its answers are not shown here and are not shown to you: a " +
    "safety screen is the one record whose disclosure to the other party can " +
    "put somebody in danger, and that holds whichever of you is asking.",
  "Deleting material does not rewrite a judgment that has already been frozen. " +
    "A frozen judgment is never edited; a re-hearing produces a new version " +
    "that states what changed.",
];

/* -------------------------------------------------------------------------- */
/* Reading the fact layer                                                     */
/* -------------------------------------------------------------------------- */

interface JudgmentClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly tier: string;
  readonly confidence: number | null;
}

/**
 * Pull the claims out of a stored fact layer without re-validating it.
 *
 * The contract schema (`judgment/contract.ts`) is what guards a generation on
 * the way in. This is a read of a row that already passed it, and a row that
 * somehow did not must still be listable here — a transparency view that throws
 * on one malformed judgment would hide every other thing on the page.
 */
function readClaims(content: unknown): JudgmentClaim[] {
  if (content === null || typeof content !== "object") return [];
  const claims = (content as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return [];

  return claims.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const claim = raw as Record<string, unknown>;
    const statement = typeof claim.statement === "string" ? claim.statement : "";
    if (statement === "") return [];
    return [
      {
        claimId: typeof claim.claim_id === "string" ? claim.claim_id : "?",
        statement,
        evidenceRefs: Array.isArray(claim.evidence_refs)
          ? claim.evidence_refs.filter(
              (ref): ref is string => typeof ref === "string",
            )
          : [],
        tier: typeof claim.tier === "string" ? claim.tier : "unstated",
        confidence:
          typeof claim.confidence === "number" ? claim.confidence : null,
      },
    ];
  });
}
