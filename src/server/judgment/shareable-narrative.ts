/**
 * The counterparty-addressed shareable rendition — SPEC M4 ①.
 *
 * ## The defect this fixes
 *
 * M3 shipped one narrative and two audiences. The shareable copy was that
 * narrative with the `self_only` sections filtered out, and the first real
 * judgment showed what a filter cannot do: the document 甲 would have received
 * opened with "You, 乙, submitted this case and have 5 lines on file" and told
 * her that three clarification questions had been put to her. Every fact in it
 * was checked. Every one was addressed to her partner.
 *
 * ## Why this is a second generation and not a rewrite
 *
 * Two cheaper fixes were available and both are wrong:
 *
 *   - **Rewrite the pronouns at render time.** Then the shareable document is
 *     authored by the render layer — text nobody checked against the fact layer,
 *     produced by string surgery on prose that means what it means because of
 *     who it was written to. "You acknowledged this" does not become true of
 *     the other party by swapping the pronoun; it becomes false.
 *   - **Edit the frozen narrative.** A final judgment is frozen (HARD RULE #6).
 *     Not negotiable, and not the kind of rule that has an exception for a good
 *     reason.
 *
 * So the shareable copy is generated: the `shareable_narrative` stage writes a
 * second surface layer to the counterparty **from the same frozen fact layer**,
 * under the same one-way rule as the first narrative — every `claim_id` must
 * already exist in the skeleton and no claim may be introduced
 * (`validateJudgmentContract`, the same validator, on the same fact layer).
 *
 * ## Renditions have their own lifecycle
 *
 * The generated narrative is persisted on the `judgment_renditions` row, with
 * its own model, effort, prompt version and `revision`. Regenerating it bumps
 * that revision and writes nothing to `judgments` — the frozen row is not read
 * for update, not touched by the transaction, and a test asserts it is
 * byte-identical before and after. That is what "derived artifact" has to mean
 * to be worth saying: the judgment is the thing that was decided, the rendition
 * is a way of saying it, and a better way of saying it is not a new decision.
 *
 * ## What is checked before anything is stored
 *
 *   1. **The contract** — ids resolve, no claim introduced, no uncited finding.
 *   2. **Audience** — every section is `both`. A `self_only` section is the
 *      criticism written for the client; in a document addressed to the other
 *      party it is a category error, so it is rejected rather than filtered.
 *   3. **It addresses its reader** — the sections say "you" at least once.
 *      Checked on the sections alone, because the frame wrapped around them
 *      already speaks to the counterparty and would mask a narrative that never
 *      did. A third-person report about both parties is the client's copy with
 *      the names changed, not the document SPEC ① asks for.
 *   4. **Not a copy** — no section text is byte-identical to a section of the
 *      client's narrative. The old defect was a projection of that document;
 *      this is the check that a projection cannot be wired back in and pass.
 *   5. **The share gate** — the framed text goes through `assertShareable`,
 *      which is where the other half of the address rule lives
 *      (`checkCounterpartyAddress`: no second-person reference to the client),
 *      along with win/lose framing and the responsibility percentage. Run here
 *      so a document is refused when it is written, not when somebody tries to
 *      send it — and run again on every render, because that is the copy that
 *      actually leaves.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db";
import { judgmentRenditions, type LlmEffort } from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta } from "../llm";
import { shareableNarrativeStage } from "../llm/stages";
import { stableStringify, type JsonValue } from "../pipeline/case-file";
import {
  describeViolations,
  parseSurfaceLayer,
  readJudgment,
  validateJudgmentContract,
  type FactLayer,
  type JudgmentRecord,
  type SurfaceLayer,
} from "./contract";
import {
  runChecked,
  type JudgmentRejection,
  type JudgmentStepResult,
} from "./generation";
import { levelConstraints } from "./levels";
import {
  RenditionError,
  noticeBasisFrom,
  renderShareable,
  type RenditionView,
  type ShareableOptions,
} from "./rendition";

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The task turn: the level constraints, the frozen skeleton, and who is reading.
 *
 * Byte-stable, like the client narrative's prompt — `stableStringify` sorts keys
 * and the fact layer carries no timestamps, so two runs over the same judgment
 * send the same bytes and the prompt cache can do its job.
 *
 * The counterparty's own pseudonym is deliberately NOT passed in. The reader is
 * "you"; naming her is not needed to write to her, and the one name the document
 * must get right — the client's, who is a third person here — is already in the
 * skeleton's `record_basis`.
 */
export function renderShareableNarrativePrompt(
  level: JudgmentRecord["outputLevel"],
  factLayer: FactLayer,
): string {
  const rules = levelConstraints(level);
  const client = factLayer.findings.record_basis.client_pseudonym;

  return (
    `## Output level (locked on this case; enforced in code)\n` +
    `${stableStringify({
      level,
      label: rules.label,
      requires: [...rules.requires],
      forbids: [...rules.forbids],
      responsibility_split_allowed: rules.allowsResponsibilitySplit,
    })}\n\n` +
    `## Who reads this copy\n` +
    `The reader is the counterparty: the party who did not bring this case and ` +
    `was never asked for their account. Address them as "you".\n` +
    `The client — "${client}" in the skeleton below — brought this case, was ` +
    `asked the clarification questions and was shown the adverse facts. In this ` +
    `copy "${client}" is a third person, referred to by that pseudonym or as ` +
    `"they", and never as "you".\n\n` +
    `## Judgment skeleton (frozen — this is the entire factual basis you have)\n` +
    // Plain JSON by construction: it round-trips through a JSON column, so the
    // cast asserts nothing the schema does not already guarantee.
    `${stableStringify(factLayer as unknown as JsonValue)}\n\n` +
    `Write the counterparty's copy of this judgment from the skeleton above. ` +
    `Every section's claim_ids must be ids defined in it, every section is ` +
    `audience "both", and no sentence addresses "${client}" in the second ` +
    `person — the server checks all three and rejects the whole document on ` +
    `any of them. Do not invent a link or an address for the reader's reply; ` +
    `the way in is attached after you.`
  );
}

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

/** Second-person pronouns, for the "does this address anyone" check. */
const SECOND_PERSON = /\b(you|your|yours|yourself)\b/i;

export interface ShareableNarrativeContext {
  /** The frozen fact layer this narrative must not out-run. */
  readonly factLayer: FactLayer;
  /**
   * The level the judgment was issued at.
   *
   * The share gate below renders the document to check it, and the rendered
   * document carries the per-level provenance notice (doc 05 §C amendment 5)
   * and is projected under the per-level audience rule (§A.3). Checking a
   * document assembled under a different level from the one it will be served
   * at would be checking a different document.
   */
  readonly level: JudgmentRecord["outputLevel"];
  /**
   * The client's own narrative, when it is available — used only to prove this
   * document is not a copy of it. Optional so the check degrades to "not run"
   * rather than to "passed" if a caller has nothing to compare against.
   */
  readonly clientNarrative?: SurfaceLayer | null;
}

/**
 * Everything that must hold before a counterparty narrative is stored.
 *
 * Returns a `JudgmentRejection` so the retry loop can hand the model its own
 * faults verbatim, in the same shape the skeleton and narrative steps use.
 */
export function checkShareableNarrative(
  context: ShareableNarrativeContext,
  surfaceLayer: SurfaceLayer,
): JudgmentRejection | null {
  const { factLayer } = context;
  const client = factLayer.findings.record_basis.client_pseudonym;

  // 1. The one-way rule, from the same validator the client's narrative used.
  //    Reported on its own: a document that out-runs the skeleton has a
  //    different problem from one that is merely addressed to the wrong person,
  //    and the retry should be told which.
  const contract = validateJudgmentContract(factLayer, surfaceLayer);
  if (!contract.ok) {
    return {
      code: "contract_violation",
      message: describeViolations(
        contract.violations,
        "The counterparty narrative",
      ),
      contract: contract.violations,
    };
  }

  const violations: { path: string; detail: string }[] = [];

  // 2. Audience. A self_only section here is not something to filter out; it is
  //    a document that misunderstood who it is for.
  surfaceLayer.sections.forEach((section, index) => {
    if (section.audience === "both") return;
    violations.push({
      path: `surface_layer.sections[${index}].audience`,
      detail:
        `Section "${section.section_id}" is marked "${section.audience}". ` +
        `Every section of the counterparty's copy is "both": "self_only" is ` +
        `the criticism written for ${client} alone, and a document addressed ` +
        `to the other party has no place to put it.`,
    });
  });

  // 3. Does it address its reader at all?
  //
  //    Checked on the sections alone, deliberately: the frame this document is
  //    wrapped in already says "you" to the counterparty, so a check over the
  //    finished text would pass for a narrative that never once spoke to her.
  //    The other half of the address rule — that it does not speak to the
  //    CLIENT — is checked by the share gate below, over everything that leaves.
  const body = surfaceLayer.sections
    .map((section) => `${section.heading}\n\n${section.text}`)
    .join("\n\n");

  if (!SECOND_PERSON.test(body)) {
    violations.push({
      path: "surface_layer.sections[].text",
      detail:
        `This copy never addresses its reader. It is written TO the ` +
        `counterparty — she is "you" in it — and a third-person report about ` +
        `both parties is the client's copy with the names changed, not the ` +
        `document the other party is owed.`,
    });
  }

  // 4. Not a projection of the client's copy.
  const clientNarrative = context.clientNarrative ?? null;
  if (clientNarrative !== null) {
    const clientTexts = new Set(
      clientNarrative.sections.map((section) => section.text.trim()),
    );
    surfaceLayer.sections.forEach((section, index) => {
      if (!clientTexts.has(section.text.trim())) return;
      violations.push({
        path: `surface_layer.sections[${index}].text`,
        detail:
          `Section "${section.section_id}" reproduces a section of the ` +
          `client's copy word for word. This document is written to a ` +
          `different reader from the same facts; identical prose means it was ` +
          `copied, and copying is what produced the defect this stage replaced.`,
      });
    });
  }

  // 5. The share gate, on the framed text that would actually leave: the
  //    provenance-and-redistribution notice, the invitation, win/lose language,
  //    a responsibility percentage, and any sentence addressed to the client.
  try {
    renderShareable(surfaceLayer, {
      clientPseudonym: client,
      level: context.level,
      basis: noticeBasisFrom(context.level, factLayer),
    });
  } catch (error) {
    if (!(error instanceof RenditionError)) throw error;
    for (const violation of error.violations) {
      violations.push({
        path: `surface_layer (${violation.code})`,
        detail:
          violation.detail +
          (violation.excerpt === undefined ? "" : ` Found: …${violation.excerpt}…`),
      });
    }
  }

  if (violations.length === 0) return null;
  return {
    code: "shareable_violation",
    message:
      `The counterparty narrative broke the rules that exist for the copy the ` +
      `other party receives:\n` +
      violations.map((v) => `  - ${v.path}: ${v.detail}`).join("\n"),
    shareable: violations,
  };
}

/* -------------------------------------------------------------------------- */
/* The model call                                                             */
/* -------------------------------------------------------------------------- */

export interface ShareableNarrativeOptions {
  readonly llm?: RunStageOptions;
}

/**
 * Generate the counterparty's narrative from a frozen fact layer.
 *
 * Takes the fact layer, not a case id and not a dossier: like the client's
 * narrative stage, this one is given the skeleton and nothing else, so a claim
 * it did not receive is a claim it cannot ground. The database is here for the
 * audit rows and the pseudonym dictionary only.
 */
export async function runShareableNarrative(
  db: Db,
  caseId: string,
  level: JudgmentRecord["outputLevel"],
  factLayer: FactLayer,
  options: ShareableNarrativeOptions & {
    readonly clientNarrative?: SurfaceLayer | null;
  } = {},
): Promise<JudgmentStepResult<SurfaceLayer>> {
  const basePrompt = renderShareableNarrativePrompt(level, factLayer);
  const dict = buildCaseDict(db, caseId);

  return runChecked<SurfaceLayer>(
    basePrompt,
    (prompt) =>
      runStage(
        shareableNarrativeStage,
        { prompt, dict, caseId },
        { db, ...options.llm },
      ),
    (data) =>
      checkShareableNarrative(
        { factLayer, level, clientNarrative: options.clientNarrative ?? null },
        data,
      ),
  );
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface ShareableNarrativeProvenance {
  readonly model: string;
  readonly effort?: LlmEffort;
  readonly promptVersion?: string;
  readonly fallbackUsed?: boolean;
}

export interface StoredShareableNarrative {
  readonly judgmentId: string;
  /** 1 on the first generation, +1 on every regeneration. */
  readonly revision: number;
  readonly view: RenditionView;
}

/**
 * Store a counterparty narrative against a frozen judgment.
 *
 * Writes exactly one row of `judgment_renditions` and reads `judgments`. The
 * frozen judgment is never in an UPDATE here, which is the property `M4 ③` asks
 * to be asserted: renditions are derived artifacts, and re-deriving one is not
 * an edit to what was decided.
 *
 * Re-validates before writing rather than trusting the generation that produced
 * the value: this function is also the door a script, a fixture or a future
 * appeal path comes through, and the checks that authorize a write are the ones
 * run at the moment of the write.
 */
export function persistShareableNarrative(
  db: Db,
  judgmentId: string,
  surfaceLayer: SurfaceLayer,
  provenance: ShareableNarrativeProvenance,
  options: ShareableOptions = {},
): StoredShareableNarrative {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new RenditionError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  if (judgment.status === "draft") {
    throw new RenditionError(
      "not_final",
      `Judgment ${judgmentId} is still a draft. Renditions come into existence ` +
        `when a judgment is frozen; there is nothing to derive a shareable copy ` +
        `of yet.`,
    );
  }

  const narrative = parseSurfaceLayer(
    surfaceLayer,
    `judgment_renditions[${judgmentId}].surface_layer`,
  );

  const rejection = checkShareableNarrative(
    {
      factLayer: judgment.factLayer,
      level: judgment.outputLevel,
      clientNarrative: judgment.surfaceLayer,
    },
    narrative,
  );
  if (rejection !== null) {
    throw new RenditionError("narrative_invalid", rejection.message, []);
  }

  const client = judgment.factLayer.findings.record_basis.client_pseudonym;
  const view = renderShareable(narrative, {
    ...options,
    level: judgment.outputLevel,
    basis: noticeBasisFrom(judgment.outputLevel, judgment.factLayer),
    clientPseudonym: options.clientPseudonym ?? client,
  });

  const row = db
    .select()
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgmentId),
        eq(judgmentRenditions.kind, "shareable"),
      ),
    )
    .get();

  if (row === undefined) {
    throw new RenditionError(
      "rendition_missing",
      `Judgment ${judgmentId} has no shareable rendition row. Rows are minted ` +
        `when the judgment is finalized.`,
    );
  }

  const [written] = db
    .update(judgmentRenditions)
    .set({
      // Stored so a reader of the table sees the document; the text that is
      // actually served is re-derived and re-checked on every read, so this
      // column is a record, never the authority (see rendition.ts).
      content: view.text,
      surfaceLayer: narrative as unknown as Record<string, unknown>,
      shareable: true,
      model: provenance.model,
      effort: provenance.effort ?? null,
      promptVersion: provenance.promptVersion ?? null,
      fallbackUsed: provenance.fallbackUsed ?? false,
      // Counted in SQL rather than read-then-written, so two generations racing
      // cannot land on the same revision number.
      revision: sql`${judgmentRenditions.revision} + 1`,
      generatedAt: new Date(),
    })
    .where(eq(judgmentRenditions.id, row.id))
    .returning()
    .all();

  return { judgmentId, revision: written.revision, view };
}

/* -------------------------------------------------------------------------- */
/* The whole act                                                              */
/* -------------------------------------------------------------------------- */

export type ShareableRenditionOutcome =
  | {
      readonly kind: "generated";
      readonly revision: number;
      readonly view: RenditionView;
      readonly meta: StageMeta;
      readonly attempts: number;
    }
  /** The document was refused by a server-side check, twice. */
  | {
      readonly kind: "rejected";
      readonly rejection: JudgmentRejection;
      readonly attempts: number;
    }
  | { readonly kind: "refused"; readonly category?: string }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string }
  /** No such judgment, or it is not frozen yet. */
  | { readonly kind: "blocked"; readonly message: string };

/**
 * Generate and store the shareable copy of a frozen judgment.
 *
 * Never throws for an expected outcome, for the same reason `generateJudgment`
 * does not: a refusal, a rejected document and a transport failure are all
 * results a caller has to branch on.
 */
export async function generateShareableRendition(
  db: Db,
  judgmentId: string,
  options: ShareableNarrativeOptions = {},
): Promise<ShareableRenditionOutcome> {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    return { kind: "blocked", message: `No judgment with id ${judgmentId}.` };
  }
  if (judgment.status === "draft") {
    return {
      kind: "blocked",
      message:
        `Judgment ${judgmentId} is a draft. The shareable copy is derived from ` +
        `a frozen judgment; a draft is still being written.`,
    };
  }

  const result = await runShareableNarrative(
    db,
    judgment.caseId,
    judgment.outputLevel,
    judgment.factLayer,
    { llm: options.llm, clientNarrative: judgment.surfaceLayer },
  );

  if (result.kind === "refused") {
    return result.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: result.category };
  }
  if (result.kind === "error") {
    return { kind: "error", retryable: result.retryable, message: result.message };
  }
  /* c8 ignore next 6 -- `no_material` is unreachable: nothing here reads the record. */
  if (result.kind === "no_material") {
    return { kind: "blocked", message: result.message };
  }
  if (result.kind === "rejected") {
    return {
      kind: "rejected",
      rejection: result.rejection,
      attempts: result.attempts,
    };
  }

  const stored = persistShareableNarrative(db, judgmentId, result.data, {
    model: result.meta.model,
    effort: shareableNarrativeStage.effort,
    promptVersion: shareableNarrativeStage.promptVersion,
    fallbackUsed: result.meta.fallbackUsed,
  });

  return {
    kind: "generated",
    revision: stored.revision,
    view: stored.view,
    meta: result.meta,
    attempts: result.attempts,
  };
}
