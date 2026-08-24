/**
 * The judgment dossier — the document the two judgment stages are written from.
 *
 * Wave A's `pipeline/case-file.ts` assembles the record for the stages that
 * build the case. This assembles the record for the stage that decides it, and
 * the difference is what has accumulated in between: the three issue lists, the
 * steelman the client accepted, the adverse facts they answered, the
 * clarification questions and what became of each, the locked output level, and
 * the arithmetic of who is actually in the record (`asymmetry.ts`).
 *
 * Three properties, all of them properties of code rather than of a prompt:
 *
 *   1. **Confirmed material only (HARD RULE #1).** The evidence block is
 *      `renderBrief(buildCitableBrief(...))` — the same query
 *      `checkEvidenceRefs` validates against — so the ids a stage is shown are
 *      exactly the ids the validator will accept. A pending line is not
 *      "rejected when cited"; it is absent from the bytes the model receives.
 *   2. **Utterance ids, not per-assembly handles.** Wave A's case file mints
 *      short `U1`-style handles and resolves them immediately. The judgment path
 *      does not: its citations are persisted into `judgments.content` and have
 *      to survive there, and the issue items and adverse facts already carry raw
 *      utterance ids. One id space, one validator.
 *   3. **Byte-stable.** Every list is sorted by a stored value, keys are emitted
 *      sorted by `stableStringify`, and no `created_at`, `updated_at`,
 *      `acked_at` or "generated at" value appears anywhere. Two assemblies of an
 *      unchanged record produce identical bytes (CLAUDE.md prompt-cache
 *      discipline). Timestamps are the easy thing to leak here — an adverse
 *      fact's `ackedAt` is right there on the row — so none of them are read.
 *
 * Section order is fixed, with the level constraints last: the constraint block
 * is the part that differs between an L2 and an L3 hearing of the same case, so
 * everything above it stays a shared cache prefix.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import { cases, type OutputLevel } from "../db/schema";
import {
  stableStringify,
  type CaseFileRound,
  type JsonValue,
} from "../pipeline/case-file";
import { assembleCaseFile } from "../pipeline/case-file";
import { buildCitableBrief, renderBrief } from "../pipeline/evidence-refs";
import { listAdverseFacts } from "../pipeline/adverse-facts";
import { listIssues } from "../pipeline/issue-fixing";
import { readSteelman } from "../pipeline/steelman";
import {
  computeRecordAsymmetry,
  serializeRecordAsymmetry,
  type RecordAsymmetry,
} from "./asymmetry";
import { levelConstraints, type LevelConstraints } from "./levels";

/** Format marker, bumped when the dossier's shape changes. */
export const JUDGMENT_DOSSIER_FORMAT = "fairjudge.judgment_dossier.v1";

/** One titled section of the serialized dossier. */
export interface DossierSection {
  readonly title: string;
  readonly body: JsonValue;
}

export interface JudgmentDossier {
  readonly caseId: string;
  /** The level locked onto the case (HARD RULE #2). Never chosen here. */
  readonly outputLevel: OutputLevel;
  /** What that level forbids and requires, as code states it. */
  readonly constraints: LevelConstraints;
  /** The arithmetic of the record — numbers, never a sentence. */
  readonly asymmetry: RecordAsymmetry;
  /** The evidence block, verbatim and citable-only. */
  readonly evidenceBlock: string;
  readonly sections: readonly DossierSection[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The client's own words for an item, when they wrote some; otherwise the
 * machine's draft. Same precedence as everywhere else in the product
 * (`human_final` wins over `ai_draft`), and null when neither exists.
 */
function settledText(
  humanFinal: string | null,
  aiDraft: string | null,
): string | null {
  return humanFinal ?? aiDraft;
}

/**
 * Clarification, as the judgment must see it: every question that was put, and
 * whether an answer came back.
 *
 * `answered` / `declined` / `unanswered` are carried through unflattened. After
 * `npm run purge:operator` the seeded real case's three answers sit at
 * `declined` — a legitimate state meaning the client never answered, not an
 * error — and a judgment that has to disclose what it does not know needs to be
 * able to name which questions those were.
 */
function clarificationBody(rounds: readonly CaseFileRound[]): JsonValue {
  return rounds
    .slice()
    .sort((a, b) => a.roundNumber - b.roundNumber)
    .map((round) => ({
      round: round.roundNumber,
      questions: round.questions.map((item) => ({
        question: item.question,
        answer_status: item.status,
        // Null unless the client actually wrote something. Nothing downstream
        // may quote a sentence they did not write.
        answer: item.answer,
      })),
    }));
}

/**
 * Assemble one case's judgment dossier.
 *
 * Throws when no output level is locked: the level is the frame the judgment is
 * written inside (HARD RULE #2), and there is no such thing as assembling the
 * document without knowing which one applies.
 */
export function assembleJudgmentDossier(
  db: Db,
  caseId: string,
): JudgmentDossier {
  const caseRow = db
    .select({ id: cases.id, title: cases.title, outputLevel: cases.outputLevel })
    .from(cases)
    .where(eq(cases.id, caseId))
    .get();
  if (caseRow === undefined) {
    throw new Error(`No case with id ${caseId}.`);
  }
  if (caseRow.outputLevel === null) {
    throw new Error(
      `Case ${caseId} has no locked output level. The level is derived in code ` +
        `and locked before a judgment is assembled (lockOutputLevel).`,
    );
  }

  const outputLevel = caseRow.outputLevel;
  const constraints = levelConstraints(outputLevel);
  const asymmetry = computeRecordAsymmetry(db, caseId);
  const brief = buildCitableBrief(db, caseId);
  const caseFile = assembleCaseFile(db, caseId);
  const issues = listIssues(db, caseId);
  const steelman = readSteelman(db, caseId);
  const adverse = listAdverseFacts(db, caseId);

  const steelmanCurrent = steelman.current;
  const steelmanAccepted =
    steelmanCurrent !== null && steelmanCurrent.verdict === "accepted";

  const sections: DossierSection[] = [
    {
      title: "Case",
      body: {
        format: JUDGMENT_DOSSIER_FORMAT,
        title: caseRow.title,
        output_level: outputLevel,
      },
    },
    {
      title: "Parties",
      body: [...caseFile.parties]
        .sort((a, b) => compare(a.pseudonym, b.pseudonym))
        .map((party) => ({
          pseudonym: party.pseudonym,
          role: party.role,
          is_client: party.isSubmitter,
          participation_state: party.participationState,
        })),
    },
    {
      title:
        "Record basis (counted from the database — restate these numbers, do " +
        "not recompute or estimate them)",
      body: serializeRecordAsymmetry(asymmetry),
    },
    {
      title: "Issues as fixed with the client",
      body: issues.lists.map((list) => ({
        list: list.category,
        title: list.title,
        purpose: list.purpose,
        items: list.items
          // A rejected item is one the reviewer threw away; it is not part of
          // the case any more and must not reappear inside a judgment.
          .filter((item) => item.confirmStatus !== "rejected")
          .map((item) => ({
            id: item.id,
            statement: settledText(item.humanFinal, item.aiDraft),
            confirm_status: item.confirmStatus,
            evidence_refs: item.citations
              .map((citation) => citation.utteranceId)
              .sort(compare),
          }))
          .sort((a, b) => compare(a.id, b.id)),
      })),
    },
    {
      title: "Steelman of the other party (the client's verdict on it)",
      body:
        steelmanCurrent === null
          ? { present: false, verdict: null, text: null, rebuttal: null }
          : {
              present: true,
              verdict: steelmanCurrent.verdict,
              accepted: steelmanAccepted,
              // The client's own version wins over the machine's draft, as
              // everywhere else in the product.
              text: settledText(
                steelmanCurrent.humanFinal,
                steelmanCurrent.aiDraft,
              ),
              rebuttal: steelmanCurrent.rebuttal,
              downgrade_signal: steelman.downgradeSignal,
              downgrade_reason: steelman.downgradeReason,
            },
    },
    {
      title: "Adverse facts about the client, and what the client said back",
      body: [...adverse.items]
        .sort((a, b) => compare(a.id, b.id))
        .map((item) => ({
          id: item.id,
          statement: settledText(item.humanFinal, item.aiDraft),
          // `acknowledged` / `disputed` / `pending`. Contesting settles the
          // gate exactly as accepting does; the judgment sees which it was.
          ack_status: item.ackStatus,
          // Verbatim, in the client's own language. Never normalized.
          client_note: item.ackNote,
          evidence_refs: item.citations
            .map((citation) => citation.utteranceId)
            .sort(compare),
        })),
    },
    {
      title: "Clarification: what was asked, and what came back",
      body: clarificationBody(caseFile.clarification),
    },
    // Last on purpose: the constraint block is what differs between two levels
    // of the same case, so everything above it stays a stable cache prefix.
    {
      title: "Output level constraints (enforced in code — a violation is rejected)",
      body: {
        level: outputLevel,
        label: constraints.label,
        requires: [...constraints.requires],
        forbids: [...constraints.forbids],
        responsibility_split_allowed: constraints.allowsResponsibilitySplit,
      },
    },
  ];

  return {
    caseId,
    outputLevel,
    constraints,
    asymmetry,
    evidenceBlock: renderBrief(brief),
    sections,
  };
}

/**
 * Render the dossier as the text a stage is actually handed.
 *
 * Deterministic in the strong sense: same record in, same bytes out. The
 * evidence block leads, because it is the largest and most cacheable part and
 * because everything below it refers to ids defined in it.
 */
export function serializeJudgmentDossier(dossier: JudgmentDossier): string {
  const head = `## Evidence\n${dossier.evidenceBlock}`;
  const rest = dossier.sections.map(
    (section) => `## ${section.title}\n${stableStringify(section.body)}`,
  );
  return [head, ...rest].join("\n\n");
}
