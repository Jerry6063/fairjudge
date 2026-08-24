/**
 * Adverse-fact pre-acknowledgment (SPEC M3 wave A ⑥) — the anti-"help me win"
 * gate.
 *
 * The client hands over material they believe supports them. This module reads
 * the same material for what a fair reader would hold against them, puts each
 * item in front of them, and refuses to let judgment start until every one has
 * been acknowledged or contested. It is a hard precondition, not a screen: a
 * product that lets you skip the part where you are told what you did wrong is
 * not a judge, it is a mirror.
 *
 * Two decisions worth reading before changing anything here:
 *
 *   1. **Contesting satisfies the gate exactly as acknowledging does.** The
 *      client is not required to agree — only to have faced the material and
 *      said something about it. A gate that only opened for agreement would be
 *      coercion dressed as diligence, and it would poison the record the
 *      judgment is written from.
 *   2. **`ack_status` and `confirm_status` are left as separate axes, and only
 *      `ack_status` is written here.** They ask different questions: "do you
 *      accept that this counts against you" versus "is this text an accurate
 *      statement of the record". Mapping contest → `rejected` would be actively
 *      wrong — a contested adverse fact still reaches the judge, along with the
 *      client's rebuttal. That is the point of contesting it rather than
 *      deleting it.
 */

import { and, asc, count, eq } from "drizzle-orm";

import type { Db } from "../db";
import {
  adverseFacts as adverseFactsTable,
  type AckStatus,
  type ConfirmStatus,
} from "../db/schema";
import type { RunStageOptions } from "../llm";
import { adverseFactsStage, type AdverseFactsOutput } from "../llm/stages";
import {
  buildCitedPrompt,
  runCitedStage,
  type CitedRunResult,
} from "./cited-generation";
import {
  auditCitations,
  buildCitableBrief,
  describeCitationFaults,
  type BriefUtterance,
  type CitationAudit,
  type CitingItem,
} from "./evidence-refs";
import {
  checkJudgmentGate,
  type AdverseFactCounts,
  type JudgmentGateVerdict,
} from "./judgment-gate";

/** The task turn appended after the evidence brief. */
const ADVERSE_FACTS_TASK =
  "Read this case's confirmed material for the facts that count against the " +
  "CLIENT — the party marked is_client: true. Ground every item in at least " +
  "one utterance id from the EVIDENCE block above.";

/* -------------------------------------------------------------------------- */
/* Read model                                                                 */
/* -------------------------------------------------------------------------- */

/** One cited line, resolved for rendering under the fact that cites it. */
export interface AdverseFactCitation {
  readonly utteranceId: string;
  readonly speaker: string;
  /** HARD RULE #5 — the render layer frames a recollection as a recollection. */
  readonly isRetold: boolean;
  /** Verbatim evidence; null when the line is no longer confirmed. */
  readonly text: string | null;
  readonly stale: boolean;
}

export interface AdverseFactView {
  readonly id: string;
  /** The machine's statement, addressed to the client. */
  readonly aiDraft: string | null;
  readonly humanFinal: string | null;
  readonly confirmStatus: ConfirmStatus;
  readonly ackStatus: AckStatus;
  readonly ackNote: string | null;
  readonly ackedAt: Date | null;
  readonly citations: readonly AdverseFactCitation[];
}

export interface AdverseFactBoard {
  readonly items: readonly AdverseFactView[];
  readonly counts: AdverseFactCounts;
  readonly acknowledged: number;
  readonly contested: number;
  /** Whether judgment may start — the same predicate the stage machine uses. */
  readonly gate: JudgmentGateVerdict;
}

/** Adverse-fact counts for one case, in the shape the gate reads. */
export function countAdverseFacts(db: Db, caseId: string): AdverseFactCounts {
  const [totals] = db
    .select({ n: count() })
    .from(adverseFactsTable)
    .where(eq(adverseFactsTable.caseId, caseId))
    .all();
  const [pending] = db
    .select({ n: count() })
    .from(adverseFactsTable)
    .where(
      and(
        eq(adverseFactsTable.caseId, caseId),
        eq(adverseFactsTable.ackStatus, "pending"),
      ),
    )
    .all();
  return { total: totals?.n ?? 0, pending: pending?.n ?? 0 };
}

/** Every adverse fact on one case, with its citations resolved. */
export function listAdverseFacts(db: Db, caseId: string): AdverseFactBoard {
  const rows = db
    .select()
    .from(adverseFactsTable)
    .where(eq(adverseFactsTable.caseId, caseId))
    .orderBy(asc(adverseFactsTable.createdAt), asc(adverseFactsTable.id))
    .all();

  const citable = new Map<string, BriefUtterance>(
    buildCitableBrief(db, caseId).utterances.map((u) => [u.id, u]),
  );

  const items: AdverseFactView[] = rows.map((row) => ({
    id: row.id,
    aiDraft: row.aiDraft,
    humanFinal: row.humanFinal,
    confirmStatus: row.confirmStatus,
    ackStatus: row.ackStatus,
    ackNote: row.ackNote,
    ackedAt: row.ackedAt,
    citations: (row.evidenceRefs ?? []).map((ref) => {
      const line = citable.get(ref);
      return {
        utteranceId: ref,
        speaker: line?.speaker ?? "unknown",
        isRetold: line?.isRetold ?? false,
        text: line?.text ?? null,
        stale: line === undefined,
      };
    }),
  }));

  const counts: AdverseFactCounts = {
    total: items.length,
    pending: items.filter((item) => item.ackStatus === "pending").length,
  };

  return {
    items,
    counts,
    acknowledged: items.filter((i) => i.ackStatus === "acknowledged").length,
    contested: items.filter((i) => i.ackStatus === "disputed").length,
    gate: checkJudgmentGate(counts),
  };
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

export type AdverseFactGenerationResult =
  | {
      readonly kind: "ok";
      readonly board: AdverseFactBoard;
      readonly created: number;
      /** Un-answered items replaced by this run. */
      readonly replaced: number;
      readonly attempts: number;
    }
  | Exclude<CitedRunResult<AdverseFactsOutput>, { kind: "ok" }>;

function citingItems(data: AdverseFactsOutput): CitingItem[] {
  return data.adverse_facts.map((item, at) => ({
    label: `adverse_facts[${at}]`,
    statement: item.statement,
    evidenceRefs: item.evidence_refs,
  }));
}

/**
 * Extract the facts that count against the client and persist them as
 * `ack_status = 'pending'` — which is what shuts the gate on judgment until the
 * client has been through them.
 *
 * Regeneration replaces only items the client has not answered yet. An
 * acknowledgement or a rebuttal already given is a piece of the record, and a
 * re-run must not be able to quietly delete it.
 */
export function buildAdverseFactsPrompt(
  db: Db,
  caseId: string,
): ReturnType<typeof buildCitedPrompt> {
  return buildCitedPrompt(db, caseId, ADVERSE_FACTS_TASK);
}

export type AdverseFactPersistResult =
  | {
      readonly kind: "ok";
      readonly board: AdverseFactBoard;
      readonly created: number;
      /** Un-answered items replaced by this run. */
      readonly replaced: number;
    }
  | {
      readonly kind: "invalid_refs";
      readonly audit: CitationAudit;
      readonly message: string;
    };

/**
 * Write one validated generation into the `adverse_facts` table, pending.
 *
 * Split out of `generateAdverseFacts` for the reason `persistIssues` is: the
 * external-session channel hands the same output over as a file, and the write
 * that shuts the judgment gate should have exactly one implementation. The
 * citations are re-audited at the moment of the write — an item put in front of
 * the client rests on a line that is confirmed now, not one that was.
 */
export function persistAdverseFacts(
  db: Db,
  caseId: string,
  data: AdverseFactsOutput,
): AdverseFactPersistResult {
  const audit = auditCitations(db, caseId, citingItems(data));
  if (!audit.ok) {
    return { kind: "invalid_refs", audit, message: describeCitationFaults(audit) };
  }

  // Persist the refs the audit accepted, not the model's raw array: those are
  // the exact ids that were checked.
  const accepted = new Map(audit.accepted.map((a) => [a.label, a.refs]));
  const drafts = data.adverse_facts.map((item, at) => ({
    statement: item.statement,
    refs: [...(accepted.get(`adverse_facts[${at}]`) ?? [])],
  }));

  const replaced = db.transaction((tx) => {
    const stale = tx
      .delete(adverseFactsTable)
      .where(
        and(
          eq(adverseFactsTable.caseId, caseId),
          eq(adverseFactsTable.ackStatus, "pending"),
        ),
      )
      .returning({ id: adverseFactsTable.id })
      .all().length;

    if (drafts.length > 0) {
      tx.insert(adverseFactsTable)
        .values(
          drafts.map((draft) => ({
            caseId,
            aiDraft: draft.statement,
            evidenceRefs: draft.refs,
            ackStatus: "pending" as const,
            confirmStatus: "pending" as const,
          })),
        )
        .run();
    }
    return stale;
  });

  return {
    kind: "ok",
    board: listAdverseFacts(db, caseId),
    created: drafts.length,
    replaced,
  };
}

export async function generateAdverseFacts(
  db: Db,
  caseId: string,
  options: { readonly llm?: RunStageOptions } = {},
): Promise<AdverseFactGenerationResult> {
  const run = await runCitedStage({
    db,
    caseId,
    stage: adverseFactsStage,
    task: ADVERSE_FACTS_TASK,
    extract: citingItems,
    llm: options.llm,
  });

  if (run.kind !== "ok") return run;

  return { ...persistAdverseFacts(db, caseId, run.data), attempts: run.attempts };
}

/* -------------------------------------------------------------------------- */
/* Acknowledging and contesting                                               */
/* -------------------------------------------------------------------------- */

export type AdverseFactErrorCode = "not_found" | "note_required";

export class AdverseFactError extends Error {
  readonly code: AdverseFactErrorCode;

  constructor(code: AdverseFactErrorCode, message: string) {
    super(message);
    this.name = "AdverseFactError";
    this.code = code;
  }
}

function answer(
  db: Db,
  caseId: string,
  adverseFactId: string,
  ackStatus: Exclude<AckStatus, "pending">,
  note: string | null,
): AdverseFactView {
  const row = db
    .select({ id: adverseFactsTable.id })
    .from(adverseFactsTable)
    .where(
      and(
        eq(adverseFactsTable.id, adverseFactId),
        eq(adverseFactsTable.caseId, caseId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new AdverseFactError(
      "not_found",
      "That item is not on this case any more. Refresh the page.",
    );
  }

  db.update(adverseFactsTable)
    .set({ ackStatus, ackNote: note, ackedAt: new Date() })
    .where(eq(adverseFactsTable.id, adverseFactId))
    .run();

  const updated = listAdverseFacts(db, caseId).items.find(
    (item) => item.id === adverseFactId,
  );
  /* c8 ignore next -- the row was just written; it is there. */
  if (updated === undefined) {
    throw new AdverseFactError("not_found", "Item vanished.");
  }
  return updated;
}

/**
 * "Yes, that happened and I can see how it lands." An optional note is the
 * client's own words, kept verbatim.
 */
export function acknowledgeAdverseFact(
  db: Db,
  input: { caseId: string; adverseFactId: string; note?: string | null },
): AdverseFactView {
  const note = (input.note ?? "").trim();
  return answer(
    db,
    input.caseId,
    input.adverseFactId,
    "acknowledged",
    note === "" ? null : note,
  );
}

/**
 * "That is not what happened, and here is why."
 *
 * A rebuttal must say something: contesting is a position, and an empty one
 * would be a way of clearing the gate without engaging with it — which is the
 * exact behaviour this stage exists to prevent.
 */
export function contestAdverseFact(
  db: Db,
  input: { caseId: string; adverseFactId: string; note: string },
): AdverseFactView {
  const note = input.note.trim();
  if (note === "") {
    throw new AdverseFactError(
      "note_required",
      "Say what is wrong with it. Contesting a fact without a reason is not " +
        "an answer, and the judgment will not see one.",
    );
  }
  return answer(db, input.caseId, input.adverseFactId, "disputed", note);
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

export class JudgmentBlockedError extends Error {
  readonly code: "adverse_facts_pending";

  constructor(reason: string) {
    super(reason);
    this.name = "JudgmentBlockedError";
    this.code = "adverse_facts_pending";
  }
}

/** May judgment run on this case, as far as adverse facts are concerned? */
export function judgmentGateFor(db: Db, caseId: string): JudgmentGateVerdict {
  return checkJudgmentGate(countAdverseFacts(db, caseId));
}

/**
 * The call every judgment entry point makes first.
 *
 * The stage machine already refuses the transition into `judgment` on the same
 * two predicates, so this is the second of two enforcement points rather than
 * the only one — deliberately. A case row can reach `judgment` and then have a
 * new adverse fact surfaced behind it (a regeneration, a late confirmation),
 * and "the case is at the judgment stage" would then be a stale answer to the
 * question "may judgment run right now". This one is read at the moment of use.
 */
export function assertJudgmentAllowed(db: Db, caseId: string): void {
  const verdict = judgmentGateFor(db, caseId);
  if (!verdict.open) throw new JudgmentBlockedError(verdict.reason);
}
