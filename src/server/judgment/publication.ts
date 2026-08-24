/**
 * Gated publication — SPEC M3 wave B ⑧.
 *
 * One function, one sequence, and the sequence is the guarantee:
 *
 *     buffer -> persist as draft -> validate -> publish in one piece
 *
 * Nothing the model produces is visible to a user until every check has run
 * against the persisted copy. The progress channel that runs alongside carries
 * phase markers, summarized thinking and heartbeats — and, by the shape of its
 * event type, cannot carry a sentence of the judgment (`judgment/progress.ts`).
 *
 * ## Why "persist as draft" comes before "validate", not after
 *
 * It looks backwards, and it is on purpose. A draft row is not visible to a
 * reader: `readCurrentJudgment` returns the highest **final** version and
 * renditions are only minted at `finalize`, so a draft is a working copy the
 * product does not render. Writing it before the final checks means a
 * generation that fails validation leaves evidence of what was produced and why
 * it was refused, instead of vanishing into a log line. And every write path in
 * `contract.ts` validates on the way in regardless, so a draft that persisted is
 * already schema-clean and internally coherent — what the second pass adds is
 * the checks that need the database and the locked level.
 *
 * The publish step is where "in one piece" is literal: `finalize` freezes the
 * row and mints both renditions inside one transaction, so there is no moment
 * at which a judgment is half-published.
 *
 * ## "In one piece" now means "to both parties at once"
 *
 * Minting both rendition ROWS in one transaction was never the same as
 * publishing to both people at once, because the counterparty's row was minted
 * empty. `publishToBothParties` closes that: for a two-party (L1) version the
 * caller hands over her finished narrative and both documents are written with
 * the freeze. `describeRelease` reports which of the two paths a given version
 * took. Both are at the bottom of this file, with the reasoning.
 *
 * ## Re-checking what was already checked
 *
 * `generation.ts` checks the skeleton before the narrative is requested, and
 * this module checks the persisted draft again before it publishes. That is not
 * redundancy for its own sake: between the two, a model call happened, and a
 * reviewer may have un-confirmed an utterance while it did. The check that
 * authorizes publication is the one run at the moment of publication, against
 * the row that is about to be frozen — never a result inherited from earlier in
 * the request.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import { judgmentRenditions, type LlmEffort } from "../db/schema";
import { scheduleFollowupsForJudgment } from "../followups/schedule";
import type { RunStageOptions } from "../llm";
import { assertJudgmentAllowed, JudgmentBlockedError } from "../pipeline/adverse-facts";
import {
  createDraft,
  finalize,
  readJudgment,
  updateDraft,
  JudgmentContractError,
  JudgmentStoreError,
  type FactLayer,
  type JudgmentRecord,
  type JudgmentSection,
  type SurfaceLayer,
} from "./contract";
import { assembleJudgmentDossier } from "./dossier";
import {
  checkFactLayer,
  checkSurfaceLayer,
  runGatedHearing,
  runJudgmentNarrative,
  skeletonProvenance,
  type JudgmentRejection,
} from "./generation";
import { SWAP_LIMITS_HEADING, type SwapGateOutcome } from "./swap-gate";
import {
  doneEvent,
  failedEvent,
  heartbeatEvent,
  judgmentProgress,
  phaseEvent,
  thinkingEvent,
  type JudgmentFailureCode,
  type JudgmentPhase,
  type JudgmentProgressEvent,
} from "./progress";
import { RenditionError, noticeBasisFrom, renderShareable } from "./rendition";
import { checkShareableNarrative } from "./shareable-narrative";

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export type JudgmentRunOutcome =
  | {
      readonly kind: "published";
      readonly judgment: JudgmentRecord;
      /** Model calls made, per step. Useful in the walk log and the tests. */
      readonly attempts: { readonly skeleton: number; readonly narrative: number };
      /**
       * What the swap gate decided about this version (doc 05 §B.2). A
       * published judgment whose `disposition` is `allocation_withheld` shipped
       * at its level with no allocation and the two readings shown instead —
       * the level is untouched either way.
       */
      readonly gate: SwapGateOutcome;
    }
  /** A precondition is not met — the adverse-fact gate, or no locked level. */
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "no_material"; readonly message: string }
  /** A server-side check refused the generation twice. */
  | {
      readonly kind: "rejected";
      readonly step: "skeleton" | "narrative";
      readonly rejection: JudgmentRejection;
      /** The draft that was written and never published, when there is one. */
      readonly draftId: string | null;
    }
  | { readonly kind: "refused"; readonly category?: string }
  | {
      readonly kind: "error";
      readonly retryable: boolean;
      readonly message: string;
    };

export interface GenerateJudgmentOptions {
  /** Infrastructure overrides forwarded to `runStage` (tests inject a mock). */
  readonly llm?: RunStageOptions;
  /**
   * Where progress goes. Defaults to the in-process hub; a test passes its own
   * collector so it can assert on every byte that would have reached a viewer.
   */
  readonly onProgress?: (event: JudgmentProgressEvent) => void;
  /** Skip the adverse-fact gate. Tests only; never in a server path. */
  readonly skipGate?: boolean;
  /** Injected clock for the heartbeat, so tests stay deterministic. */
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Produce and publish one case's judgment.
 *
 * Never throws for an expected outcome: a blocked gate, a refusal, a rejected
 * generation and a transport failure are all variants of `JudgmentRunOutcome`,
 * so a route branches on the result instead of catching. Genuine programming
 * errors still propagate.
 */
export async function generateJudgment(
  db: Db,
  caseId: string,
  options: GenerateJudgmentOptions = {},
): Promise<JudgmentRunOutcome> {
  const clock = options.now ?? Date.now;
  const startedAt = clock();

  const emit = (event: JudgmentProgressEvent): void => {
    if (options.onProgress === undefined) judgmentProgress.publish(caseId, event);
    else options.onProgress(event);
  };
  const enter = (phase: JudgmentPhase): void => {
    emit(phaseEvent(phase, "started"));
    emit(thinkingEvent(phase));
    emit(heartbeatEvent(clock() - startedAt));
  };
  const leave = (phase: JudgmentPhase): void => {
    emit(phaseEvent(phase, "finished"));
  };
  const fail = (code: JudgmentFailureCode): void => {
    emit(failedEvent(code));
  };

  if (options.onProgress === undefined) judgmentProgress.start(caseId);

  // --- preconditions -------------------------------------------------------
  if (options.skipGate !== true) {
    try {
      assertJudgmentAllowed(db, caseId);
    } catch (error) {
      if (!(error instanceof JudgmentBlockedError)) throw error;
      fail("blocked");
      return { kind: "blocked", message: error.message };
    }
  }

  enter("assembling");
  let dossier;
  try {
    dossier = assembleJudgmentDossier(db, caseId);
  } catch (error) {
    fail("blocked");
    return {
      kind: "blocked",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  leave("assembling");

  // --- step one: the hearing, its swap pass, and the gate -------------------
  //
  // `runGatedHearing` runs the advocate pair (L1), the skeleton, the swap pass
  // and — if the allocation moved with the names — one re-hearing at effort
  // `max` and a second swap pass. What comes back is the surviving fact layer
  // with its allocation already withheld in code if it did not survive, so the
  // narrative below is written from a document that has no allocation in it to
  // narrate (doc 05 §B.2 step 4).
  enter("fact_finding");
  const skeleton = await runGatedHearing(db, caseId, {
    llm: options.llm,
    // Already checked above; running it twice would be the same answer.
    skipGate: true,
  });
  leave("fact_finding");

  if (skeleton.kind === "no_material") {
    fail("no_material");
    return { kind: "no_material", message: skeleton.message };
  }
  if (skeleton.kind === "refused") {
    fail("refused");
    return skeleton.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: skeleton.category };
  }
  if (skeleton.kind === "error") {
    fail("error");
    return {
      kind: "error",
      retryable: skeleton.retryable,
      message: skeleton.message,
    };
  }
  if (skeleton.kind === "rejected") {
    fail("rejected");
    return {
      kind: "rejected",
      step: "skeleton",
      rejection: skeleton.rejection,
      draftId: null,
    };
  }

  const hearing = skeleton.data;
  const gate = hearing.gate;
  const factLayer: FactLayer = hearing.factLayer;

  // --- persist the skeleton as a draft -------------------------------------
  //
  // Before the narrative call, so the fact layer that the narrative is written
  // against is the one on disk. A draft is not readable as "the judgment"
  // (`readCurrentJudgment` returns only final rows), so nothing is published by
  // this write.
  let draft: JudgmentRecord;
  try {
    draft = createDraft(db, caseId, {
      ...skeletonProvenance(skeleton.meta),
      factLayer,
    });
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      fail("error");
      return { kind: "error", retryable: false, message: error.message };
    }
    throw error;
  }

  // --- step two: the narrative ---------------------------------------------
  enter("drafting");
  const narrative = await runJudgmentNarrative(
    db,
    caseId,
    dossier.outputLevel,
    factLayer,
    { llm: options.llm },
  );
  leave("drafting");

  if (narrative.kind === "refused") {
    fail("refused");
    return narrative.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: narrative.category };
  }
  if (narrative.kind === "error") {
    fail("error");
    return {
      kind: "error",
      retryable: narrative.retryable,
      message: narrative.message,
    };
  }
  /* c8 ignore next 4 -- `no_material` is unreachable from the narrative step. */
  if (narrative.kind === "no_material") {
    fail("no_material");
    return { kind: "no_material", message: narrative.message };
  }
  if (narrative.kind === "rejected") {
    fail("rejected");
    return {
      kind: "rejected",
      step: "narrative",
      rejection: narrative.rejection,
      draftId: draft.id,
    };
  }

  // What the hearing has to disclose about itself — the swap result, the
  // disagreement display where the two seatings diverged, and one sentence per
  // cut the cost ceiling made — written into the document in code rather than
  // requested from the model, so a disclosure cannot be forgotten by a
  // generation that had other things on its mind.
  const surfaceLayer: SurfaceLayer = withServerLimits(
    narrative.data,
    hearing.limits,
  );

  // --- validate, against the persisted draft -------------------------------
  enter("validating");
  try {
    draft = updateDraft(db, draft.id, {
      surfaceLayer,
      fallbackUsed: skeleton.meta.fallbackUsed || narrative.meta.fallbackUsed,
    });
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      fail("error");
      return { kind: "error", retryable: false, message: error.message };
    }
    throw error;
  }

  // Re-read the record rather than trusting the dossier assembled minutes ago:
  // a reviewer may have un-confirmed a line while the two calls ran, and the
  // citation that authorizes publication has to be the one that holds now.
  const fresh = assembleJudgmentDossier(db, caseId);
  const factFault = checkFactLayer(
    db,
    caseId,
    fresh.outputLevel,
    fresh,
    draft.factLayer,
    // The gate, re-checked at the moment of publication like everything else
    // here: an allocation the swap pass withheld is invalid in the row about to
    // be frozen, not merely absent from the value this function was handed.
    gate,
  );
  if (factFault !== null) {
    leave("validating");
    fail("rejected");
    return {
      kind: "rejected",
      step: "skeleton",
      rejection: factFault,
      draftId: draft.id,
    };
  }

  // `draft.surfaceLayer`, not the local `surfaceLayer`: the check that
  // authorizes publication reads the row about to be frozen, never the value
  // this function happens to be holding. They are the same document today —
  // the polish stage that used to rewrite one between the two is gone — and the
  // read stays because "validate the row on disk" is the property, not a
  // workaround for the stage that made it visible.
  /* c8 ignore next 10 -- `updateDraft` already asserts the same contract. */
  const surfaceFault = checkSurfaceLayer(
    draft.factLayer,
    draft.surfaceLayer ?? surfaceLayer,
  );
  if (surfaceFault !== null) {
    leave("validating");
    fail("rejected");
    return {
      kind: "rejected",
      step: "narrative",
      rejection: surfaceFault,
      draftId: draft.id,
    };
  }
  leave("validating");

  // --- publish, in one piece -----------------------------------------------
  enter("publishing");
  let published: JudgmentRecord;
  try {
    published = finalize(db, draft.id);
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      leave("publishing");
      fail("error");
      return { kind: "error", retryable: false, message: error.message };
    }
    throw error;
  }
  leave("publishing");

  // The 7 / 30-day check-ins are scheduled from the freeze (SPEC M4 ④): the
  // windows are measured from `finalized_at`, so this is the moment they are
  // knowable. Deliberately outside the publish transaction and deliberately
  // swallowed — a judgment that was published is published, and losing it over
  // a scheduling row would be a much worse trade. The catch-up sweep
  // (`catchUpSchedule`, run at application start and by the timer) exists
  // exactly so this call site is a convenience and not a single point of
  // silence: a case whose freeze failed to schedule is found and scheduled
  // there, still anchored to `finalized_at`.
  try {
    scheduleFollowupsForJudgment(db, published.id, { now: clock() });
  } catch (error) {
    console.error(
      `[followups] judgment ${published.id} was published but its check-ins ` +
        `were not scheduled; the catch-up sweep will schedule them: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  emit(heartbeatEvent(clock() - startedAt));
  emit(doneEvent(published.id, published.version));

  return {
    kind: "published",
    judgment: published,
    attempts: {
      skeleton: skeleton.attempts,
      narrative: narrative.attempts,
    },
    gate,
  };
}

/* -------------------------------------------------------------------------- */
/* The server's own section                                                   */
/* -------------------------------------------------------------------------- */

/** Section id the server writes its disclosures under. Stable, and reserved. */
export const SERVER_LIMITS_SECTION_ID = "server_limits";

/** The schema's ceiling on how many sections a surface layer may carry. */
const MAX_SECTIONS = 24;

/**
 * Add the server's own limits section to a narrative.
 *
 * `audience: "both"` and `kind: "limits"` — the two parties are owed the same
 * account of how the document was tested and what it is withholding, and a
 * disclosure marked as one party's alone would be the defect doc 05 §A.3 closed:
 * a reader receiving an assertion about a finding they cannot see.
 *
 * Appended rather than merged, except at the one boundary where appending is
 * not available: a narrative that already fills the schema's section budget has
 * this text folded into its last section instead. That is a worse-looking
 * document and a better one — the alternative is a judgment that fails
 * validation because it had too much to say, and disclosures that exist only
 * when there was room for them are not disclosures.
 */
export function withServerLimits(
  surfaceLayer: SurfaceLayer,
  limits: string,
): SurfaceLayer {
  if (limits === "") return surfaceLayer;

  const section: JudgmentSection = {
    section_id: SERVER_LIMITS_SECTION_ID,
    kind: "limits",
    audience: "both",
    heading: SWAP_LIMITS_HEADING,
    text: limits,
    claim_ids: [],
  };

  const clash = surfaceLayer.sections.some(
    (existing) => existing.section_id === SERVER_LIMITS_SECTION_ID,
  );
  const sections = clash
    ? surfaceLayer.sections.filter(
        (existing) => existing.section_id !== SERVER_LIMITS_SECTION_ID,
      )
    : surfaceLayer.sections;

  if (sections.length < MAX_SECTIONS) {
    return { ...surfaceLayer, sections: [...sections, section] };
  }

  const head = sections.slice(0, sections.length - 1);
  const last = sections[sections.length - 1];
  return {
    ...surfaceLayer,
    sections: [
      ...head,
      { ...last, text: `${last.text}\n\n## ${section.heading}\n\n${limits}` },
    ],
  };
}

/** The judgment a draft became, for a caller holding only its id. */
export function readPublished(db: Db, judgmentId: string): JudgmentRecord | null {
  const record = readJudgment(db, judgmentId);
  return record === null || record.status === "draft" ? null : record;
}

/* -------------------------------------------------------------------------- */
/* Simultaneous release (doc 05 §A.1 state 6, §C amendment 7)                  */
/* -------------------------------------------------------------------------- */

/**
 * Where a version stands between "frozen" and "both parties can read it".
 *
 * `single_party` is not a degraded `pending`. Below L1 there is one participant
 * and one document that is his; the counterparty's copy is written when he
 * chooses to send one, and calling that state "pending" would describe a
 * one-sided case as a two-sided one that has not finished.
 */
export type ReleaseState = "single_party" | "pending" | "released";

export interface ReleaseView {
  readonly judgmentId: string;
  readonly level: JudgmentRecord["outputLevel"];
  readonly state: ReleaseState;
  /** Both parties are participants in this version, i.e. it was issued at L1. */
  readonly twoParty: boolean;
  readonly clientCopyExists: boolean;
  readonly counterpartyCopyExists: boolean;
  /**
   * The instant both copies came into existence, when they came into existence
   * together. Null while one is missing, and null for a two-party version whose
   * copies were written by two separate acts — which is the sequencing this
   * exists to make visible rather than to guess about.
   */
  readonly releasedAt: Date | null;
  /** What is missing, named. Empty when nothing is. */
  readonly missing: readonly string[];
}

/**
 * Report a version's release state — a pure read, no writes, no model.
 *
 * ## The sequencing this was written to find
 *
 * `finalize` used to mint the counterparty's rendition row **empty** and leave
 * it that way: the `shareable_narrative` stage filled it later, in a separate
 * act, costing a separate model call. So a re-heard L1 version was readable by
 * the client the instant it was frozen and readable by the counterparty
 * whenever somebody next ran that stage. That is sequential unlock, and doc 05
 * §A.1 rules it out for exactly the reason SyncWithLove designed it out
 * (survey §2.2: *"nobody got to read first and prepare a rebuttal"*) — for a
 * conflict product, reading first IS the advantage, and a judgment that hands
 * one party a head start manufactures the grievance it exists to retire.
 *
 * The fix is `publishToBothParties` below: one transaction, both documents. This
 * function is how a caller (and a test, and a screen) can tell which of the two
 * happened, on any version, after the fact.
 *
 * ## Neither party's read state appears here
 *
 * Deliberately: release is a property of the documents, not of who has opened
 * them. Nothing in this function reads `respond_state`, a redemption timestamp
 * or any other trace of somebody having looked, so there is no value a reader
 * could produce by reading — or withhold by not reading — that changes the
 * other party's access. Rendering is not an act (doc 05 §A.2), and it is not an
 * unlock either.
 */
export function describeRelease(db: Db, judgmentId: string): ReleaseView | null {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) return null;

  const rows = db
    .select({
      kind: judgmentRenditions.kind,
      surfaceLayer: judgmentRenditions.surfaceLayer,
      content: judgmentRenditions.content,
      generatedAt: judgmentRenditions.generatedAt,
    })
    .from(judgmentRenditions)
    .where(eq(judgmentRenditions.judgmentId, judgmentId))
    .all();
  const own = rows.find((row) => row.kind === "self_reflection");
  const shared = rows.find((row) => row.kind === "shareable");

  const clientCopyExists = own !== undefined && (own.content ?? "").length > 0;
  // Her copy exists when it has a narrative of its own — the same question
  // `renderJudgmentRendition` asks before it will render one, so this cannot
  // disagree with the door she actually reads through.
  const counterpartyCopyExists =
    shared !== undefined &&
    shared.surfaceLayer !== null &&
    (shared.content ?? "").length > 0;

  // L1 is the level that means both parties were heard, so it is also the level
  // at which "both may read" is a rule rather than a courtesy. Read off the
  // frozen judgment, never off the case, which may have moved since.
  const twoParty = judgment.outputLevel === "L1";

  const missing: string[] = [];
  if (!clientCopyExists) missing.push("self_reflection");
  if (twoParty && !counterpartyCopyExists) missing.push("shareable");

  const state: ReleaseState = !twoParty
    ? "single_party"
    : missing.length === 0
      ? "released"
      : "pending";

  // The two copies were released together only if they say the same instant.
  // `publishToBothParties` writes `finalizedAt` to both; two separate acts
  // cannot produce equal millisecond timestamps by accident.
  const ownAt = own?.generatedAt ?? null;
  const sharedAt = shared?.generatedAt ?? null;
  const releasedAt =
    state === "released" &&
    ownAt !== null &&
    sharedAt !== null &&
    ownAt.getTime() === sharedAt.getTime()
      ? ownAt
      : null;

  return {
    judgmentId,
    level: judgment.outputLevel,
    state,
    twoParty,
    clientCopyExists,
    counterpartyCopyExists,
    releasedAt,
    missing,
  };
}

/** The counterparty narrative a simultaneous publication needs in hand. */
export interface CounterpartyNarrative {
  readonly surfaceLayer: SurfaceLayer;
  readonly model: string;
  readonly effort?: LlmEffort | null;
  readonly promptVersion?: string | null;
  readonly fallbackUsed?: boolean;
}

export type SimultaneousReleaseOutcome =
  | {
      readonly kind: "released";
      readonly judgment: JudgmentRecord;
      readonly release: ReleaseView;
    }
  /** The counterparty's copy did not hold up. Nothing was published. */
  | { readonly kind: "rejected"; readonly rejection: JudgmentRejection }
  | { readonly kind: "error"; readonly message: string };

/**
 * Publish a draft to both parties at the same instant.
 *
 * The whole of the guarantee is the transaction boundary: `finalize` flips the
 * judgment to `final` and writes **both** renditions in one statement group, so
 * there is no moment at which the client's copy is readable and hers does not
 * exist. If any part fails, the draft is still a draft and nobody has read
 * anything.
 *
 * The counterparty narrative is validated and rendered BEFORE the transaction
 * opens, for two reasons. It is where the expensive, fallible checks live
 * (`checkShareableNarrative`, then the share gate inside `renderShareable`), and
 * a transaction is the wrong place to discover that a document is unshareable.
 * And it keeps `contract.ts` free of the rules it does not own: what it is
 * handed is finished bytes plus their provenance, and what it adds is that they
 * land with the freeze.
 *
 * Refuses to publish a two-party version without her copy, rather than falling
 * back to the sequential path. A caller that has no narrative to hand over has
 * not finished producing this version — publishing it anyway is the defect.
 */
export function publishToBothParties(
  db: Db,
  draftId: string,
  narrative: CounterpartyNarrative,
): SimultaneousReleaseOutcome {
  const draft = readJudgment(db, draftId);
  if (draft === null) {
    return { kind: "error", message: `No judgment with id ${draftId}.` };
  }
  if (draft.surfaceLayer === null) {
    return {
      kind: "error",
      message:
        `Judgment ${draftId} has a fact layer but no narrative of its own, so ` +
        `there is no client copy to release beside hers.`,
    };
  }

  const rejection = checkShareableNarrative(
    {
      factLayer: draft.factLayer,
      level: draft.outputLevel,
      clientNarrative: draft.surfaceLayer,
    },
    narrative.surfaceLayer,
  );
  if (rejection !== null) return { kind: "rejected", rejection };

  let text: string;
  try {
    text = renderShareable(narrative.surfaceLayer, {
      level: draft.outputLevel,
      basis: noticeBasisFrom(draft.outputLevel, draft.factLayer),
      clientPseudonym: draft.factLayer.findings.record_basis.client_pseudonym,
    }).text;
  } catch (error) {
    /* c8 ignore next 2 -- `checkShareableNarrative` ran the same gate above. */
    if (!(error instanceof RenditionError)) throw error;
    return { kind: "error", message: error.message };
  }

  let published: JudgmentRecord;
  try {
    published = finalize(db, draftId, {
      surfaceLayer: narrative.surfaceLayer,
      text,
      model: narrative.model,
      effort: narrative.effort ?? null,
      promptVersion: narrative.promptVersion ?? null,
      fallbackUsed: narrative.fallbackUsed ?? false,
    });
  } catch (error) {
    if (
      error instanceof JudgmentStoreError ||
      error instanceof JudgmentContractError
    ) {
      return { kind: "error", message: error.message };
    }
    throw error;
  }

  const release = describeRelease(db, published.id);
  /* c8 ignore next -- the judgment was written by the line above. */
  if (release === null) {
    return { kind: "error", message: `Judgment ${published.id} vanished.` };
  }
  return { kind: "released", judgment: published, release };
}
