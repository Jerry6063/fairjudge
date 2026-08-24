/**
 * The improvement contract — SPEC M4 ②.
 *
 * The output of M3 is a document. A document that is read, agreed with and put
 * down changes nothing, and the whole point of this milestone is the week after
 * the judgment. So a frozen judgment gets one to three undertakings, derived
 * from its frozen fact layer, each tied to the claims that make it this case's
 * business rather than general advice.
 *
 * Three properties are enforced here, in code, because each of them is the
 * difference between a contract and a mood:
 *
 * ## 1. It cites the record
 *
 * Every item names `claim_ids`, and every one of those ids must already exist in
 * the frozen fact layer — the same one-way rule the narrative lives under
 * (`validateJudgmentContract`), for the same reason. An undertaking grounded in
 * a claim nobody checked is advice with a judgment's letterhead on it. A miss
 * rejects the whole contract; nothing is trimmed, because a contract that
 * quietly loses its second item still looks complete.
 *
 * ## 2. At L2 only the client can be bound (the rule this file exists for)
 *
 * L2 means one side was heard. The other party never spoke to this hearing,
 * never agreed to be judged by it, and certainly never agreed to do anything
 * about it. An item that says she will text before she leaves is not a
 * commitment — it is the client's wish, printed in a typeface that makes it look
 * like her word.
 *
 * So the level decides who may be bound (`boundPartiesAllowed`), and the rule
 * runs at two doors:
 *
 *   - **the generation boundary** (`normalizeImprovementContract`) *demotes*: an
 *     item bound to the counterparty below L1 is stored as an `invitation`, with
 *     `demoted_from_commitment` recording that the generation asked for more.
 *     Demotion rather than deletion because the content is usually worth saying
 *     — "she is invited to X" is a true sentence where "she will do X" is not —
 *     and because a silently dropped item is a contract that reads as complete
 *     with a piece missing.
 *   - **the storage door** (`persistImprovementContract`) *refuses*: content
 *     carrying a commitment bound to a party the level does not allow is
 *     rejected outright, whichever caller built it. That is the invariant. The
 *     demotion above is a courtesy to the generation path; this is the thing
 *     that cannot be got around, and it is why the check that authorizes the
 *     write is run by the statement that performs it.
 *
 * At least one item must bind the client. A list in which every line is
 * something the other person should do is not a contract, it is a complaint with
 * numbering — and at L2 it would be a complaint against someone who has not been
 * heard.
 *
 * ## 3. Vagueness is a rejection, not a style note
 *
 * "Communicate more" and "be more considerate" are the failure mode of every
 * product in this category. They cannot be kept and cannot be broken, so a
 * follow-up asking whether they happened has no answer, and the whole
 * post-judgment loop degrades into a mood check.
 *
 * The shape of the schema does most of the work — `trigger`, `action`,
 * `observable` and `within_days` are four separate required fields, and a
 * disposition cannot be split across them. `checkImprovementContract` adds the
 * lexical half: a trigger must name an occasion, an action may not wear a
 * comparative, an "observable" may not be somebody's inner state. That half is
 * partial by construction — it recognizes the shapes that are known to be empty,
 * and cannot recognize an original way of saying nothing. It is deliberately not
 * a tone filter: the checks fire on the grammar of vagueness, not on vocabulary
 * anyone dislikes, because a check that fires on good items is a check somebody
 * switches off.
 *
 * Nothing here writes to `judgments`. The contract is derived from the frozen
 * judgment and stored on `improvement_contracts` (HARD RULE #6).
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db";
import {
  improvementContracts,
  LLM_EFFORTS,
  OUTPUT_LEVELS,
  type ConfirmStatus,
  type ContractStatus,
  type LlmEffort,
  type OutputLevel,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta } from "../llm";
import { improvementContractStage } from "../llm/stages";
import {
  COMMITMENT_PARTIES,
  MAX_COMMITMENT_DAYS,
  type CommitmentParty,
  type ImprovementContractOutput,
} from "../llm/stages/improvement-contract";
import { stableStringify, type JsonValue } from "../pipeline/case-file";
import { readParticipation } from "../pipeline/participation";
import {
  readJudgment,
  type ClaimTier,
  type FactLayer,
  type JudgmentRecord,
} from "./contract";
import {
  runChecked,
  type JudgmentRejection,
  type JudgmentStepResult,
} from "./generation";
import { levelConstraints } from "./levels";

/* -------------------------------------------------------------------------- */
/* What is stored                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The two row types. An invitation is not a weaker commitment — it is a
 * different kind of statement, about somebody who has not agreed to anything,
 * and it is labelled as one everywhere it is shown.
 */
export const CONTRACT_ITEM_KINDS = ["commitment", "invitation"] as const;
export type ContractItemKind = (typeof CONTRACT_ITEM_KINDS)[number];

/** Bumped if the stored shape ever changes; read paths check it. */
export const CONTRACT_CONTENT_VERSION = 1;

/** A ceiling, not a target — see the stage prompt. */
export const MAX_CONTRACT_ITEMS = 3;

export const storedContractItemSchema = z.object({
  item_id: z.string().min(1),
  kind: z.enum(CONTRACT_ITEM_KINDS),
  /** Who would have to act. Whether that binds them is `kind`. */
  bound_party: z.enum(COMMITMENT_PARTIES),
  trigger: z.string().min(1),
  action: z.string().min(1),
  observable: z.string().min(1),
  within_days: z.number().int(),
  claim_ids: z.array(z.string().min(1)),
  /**
   * The generation wrote this as a commitment and the level did not allow it.
   * Kept so the demotion is visible in the data, not only in the label: a
   * product that silently rewrites what a model asked for owes the record of it.
   */
  demoted_from_commitment: z.boolean(),
});

export type StoredContractItem = z.infer<typeof storedContractItemSchema>;

/**
 * Which model wrote this, at what effort, under which prompt.
 *
 * Carried inside the JSON because `improvement_contracts` has no provenance
 * columns and M4 adds no migration for one: the `llm_calls` row is the audit
 * record, and this is the copy a reader of the contract can see without joining
 * to it. Disclosure of who wrote a derived document is the same obligation
 * HARD RULE #6 puts on a re-heard judgment.
 */
export const contractProvenanceSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(LLM_EFFORTS).nullable(),
  prompt_version: z.string().nullable(),
  fallback_used: z.boolean(),
});

export type ContractProvenanceRecord = z.infer<typeof contractProvenanceSchema>;

export const improvementContractContentSchema = z.object({
  version: z.number().int(),
  /** The level this was derived under — what "who may be bound" was decided by. */
  output_level: z.enum(OUTPUT_LEVELS),
  judgment_id: z.string().min(1),
  items: z.array(storedContractItemSchema),
  generated_by: contractProvenanceSchema.nullish(),
});

export type ImprovementContractContent = z.infer<
  typeof improvementContractContentSchema
>;

/* -------------------------------------------------------------------------- */
/* Who may be bound                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The parties a contract may bind at a given level.
 *
 * L1 is "both sides are represented in the record": both parties took part, so
 * an undertaking by either of them is a statement the hearing has standing to
 * record. Every other level heard one side, and the absent party's undertakings
 * are things she has not said.
 *
 * This lives here rather than in `levels.ts` because that table answers what a
 * level licenses the *judgment* to do, and this answers what it licenses a
 * *contract* to bind. Both follow from the same fact — whether she was heard —
 * and neither is a re-derivation of the level itself, which is decided once, in
 * code, and locked onto the case (HARD RULE #2).
 */
export function boundPartiesAllowed(
  level: OutputLevel,
): readonly CommitmentParty[] {
  return level === "L1" ? ["client", "counterparty"] : ["client"];
}

/** Whether an item bound to `party` may stand as a commitment at `level`. */
export function mayBind(level: OutputLevel, party: CommitmentParty): boolean {
  return boundPartiesAllowed(level).includes(party);
}

/* -------------------------------------------------------------------------- */
/* Vagueness                                                                  */
/* -------------------------------------------------------------------------- */

interface VaguePattern {
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * The shapes of saying nothing.
 *
 * Every entry is a *grammatical* shape rather than a word somebody dislikes: a
 * comparative standing where an act belongs ("be more considerate"), an
 * intention verb standing in for the thing intended ("try to answer"), an
 * abstraction with no occasion ("work on my defensiveness"), or a frequency
 * where a moment belongs ("whenever possible"). Each carries the sentence a
 * person is owed when their item is refused — and the model gets the same
 * sentence on the retry, which is the point of writing them properly.
 */
const VAGUE_PATTERNS: readonly VaguePattern[] = [
  {
    pattern: /\b(be|being|get|getting|become|becoming|stay|remain)\s+(more|less)\s+[a-z]+/i,
    why:
      "a comparative is standing where the act should be. Being 'more' or " +
      "'less' of something is not a thing anyone does on Tuesday; name what " +
      "is actually done",
  },
  {
    pattern: /\b(communicate|talk|listen|share|open up|engage|check in)\s+(more|better|openly|properly)\b/i,
    why:
      "this is the canonical empty commitment. There is no moment at which it " +
      "has been kept and none at which it has been broken",
  },
  {
    pattern: /\b(try|trying|attempt|aim|hope|intend|remember)\s+(to|and|harder)\b/i,
    why:
      "an intention verb is standing in for the act. Something that is tried " +
      "cannot be observed; the thing tried can",
  },
  {
    pattern: /\bwork\s+on\s+(my|his|her|our|their|the)\b/i,
    why: "'work on' names a project, not an act, and a project has no deadline",
  },
  {
    pattern: /\bmake\s+(an?\s+)?(more\s+)?effort\b/i,
    why: "effort is not observable; what the effort produces is",
  },
  {
    pattern: /\b(improve|strengthen|deepen|nurture|prioriti[sz]e|foster|cultivate|rebuild)\b/i,
    why:
      "this is an abstraction about the relationship rather than something " +
      "one person does at one moment",
  },
  {
    pattern: /\bbe\s+(there|present|supportive|patient|kind|considerate|mindful|open|honest|better|available)\b/i,
    why:
      "this describes a way of being, not an act. Nobody can tell from the " +
      "outside whether it happened",
  },
  {
    pattern: /\bshow\s+(more\s+)?(respect|love|care|empathy|appreciation|interest|affection)\b/i,
    why: "a feeling displayed is not a countable act; name what is done or said",
  },
  {
    pattern: /\b(spend|make)\s+more\s+time\b/i,
    why: "'more time' has no occasion and no amount",
  },
  {
    pattern: /\b(avoid|stop|quit)\s+(being|getting|acting)\b/i,
    why:
      "stopping a way of being is not an act either. Name what is done " +
      "instead, at the moment it would have happened",
  },
  {
    pattern: /\b(as\s+(much|often)\s+as\s+possible|when(ever)?\s+possible|where\s+possible)\b/i,
    why:
      "'as possible' is an escape hatch: it is satisfied by whatever happened " +
      "anyway",
  },
  {
    pattern: /\b(from\s+now\s+on|going\s+forward|at\s+all\s+times|in\s+general|generally|day\s+to\s+day)\b/i,
    why:
      "this is a standing disposition, not an occasion. A commitment needs a " +
      "moment at which it is due",
  },
  {
    pattern: /\b(regularly|consistently|more\s+often|frequently)\b/i,
    why: "a frequency is not a moment; say when",
  },
];

/**
 * Words that put the evidence inside somebody's head.
 *
 * An "observable" is what a second person could see or hear. "She feels heard"
 * is the shape this catches, and it is the most common one: it sounds like the
 * goal, and it is unfalsifiable — which means the 7-day follow-up asking whether
 * it happened has no answer.
 */
const INNER_STATE = new RegExp(
  "\\b(" +
    "feels?|feeling|felt|understands?|understood|realis(e|es|ed)|realiz(e|es|ed)|" +
    "appreciat(e|es|ed)|trusts?|believes?|senses?|" +
    "knows?\\s+that|thinks?\\s+that|is\\s+(happy|calm|reassured|satisfied|comfortable|" +
    "less\\s+\\w+|more\\s+\\w+)" +
    ")\\b",
  "i",
);

/**
 * What an occasion looks like in English.
 *
 * A trigger has to be a situation that either happens or does not, and in
 * practice a situation is introduced by one of these. This is the check that
 * keeps "I answer her questions" (a policy) apart from "when she asks me
 * something I do not want to answer, I answer it that evening" (an occasion).
 */
const OCCASION_MARKER = new RegExp(
  "\\b(" +
    "when|whenever|if|once|after|before|during|as soon as|the moment|" +
    "next time|each time|every time|any time|the first time|" +
    "tonight|tomorrow|this (evening|morning|afternoon|week|weekend)|" +
    "on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)" +
    ")\\b",
  "i",
);

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

export interface ContractFault {
  /** Where it sits, e.g. `items[1].action`. */
  readonly path: string;
  /** One sentence, readable by a person and by the model on the retry. */
  readonly detail: string;
}

export interface ImprovementContractContext {
  /** The level the case is locked at — decides who may be bound. */
  readonly level: OutputLevel;
  /** The frozen fact layer every item must cite from. */
  readonly factLayer: FactLayer;
}

/** Fields whose text is checked for vagueness, in the order they are reported. */
const CHECKED_FIELDS = ["trigger", "action", "observable"] as const;

/**
 * The first empty shape in a string, by position rather than by list order.
 *
 * One report per field: naming every pattern a sentence trips is a wall of
 * text, and the reader (a person, or the model on the retry) fixes the sentence
 * whichever one they are shown. Earliest-in-the-string is chosen because that is
 * where a reader's eye already is — and because it makes the message a function
 * of the sentence rather than of the order this file happens to list its rules.
 */
function firstVagueHit(
  text: string,
): { readonly match: string; readonly why: string } | null {
  let best: { index: number; match: string; why: string } | null = null;
  for (const vague of VAGUE_PATTERNS) {
    const hit = vague.pattern.exec(text);
    if (hit === null) continue;
    if (best !== null && hit.index >= best.index) continue;
    best = { index: hit.index, match: hit[0], why: vague.why };
  }
  return best === null ? null : { match: best.match, why: best.why };
}

/**
 * Everything that must hold before a contract is stored.
 *
 * Returns a `JudgmentRejection` so the retry loop can hand the model its own
 * faults verbatim, in the shape the skeleton, narrative and counterparty
 * narrative steps all use.
 */
export function checkImprovementContract(
  context: ImprovementContractContext,
  content: ImprovementContractContent,
): JudgmentRejection | null {
  const { level, factLayer } = context;
  const faults: ContractFault[] = [];
  const known = new Set(factLayer.claims.map((claim) => claim.claim_id));
  const seen = new Set<string>();

  if (content.items.length === 0) {
    faults.push({
      path: "items",
      detail:
        "A contract with no items is not a contract. Write one to three, or " +
        "the judgment ends where it started.",
    });
  }
  if (content.items.length > MAX_CONTRACT_ITEMS) {
    faults.push({
      path: "items",
      detail:
        `${content.items.length} items. The ceiling is ${MAX_CONTRACT_ITEMS}: ` +
        `a list nobody can hold in their head on a bad evening is dropped whole.`,
    });
  }

  content.items.forEach((item, index) => {
    const at = `items[${index}]`;

    if (seen.has(item.item_id)) {
      faults.push({
        path: `${at}.item_id`,
        detail: `Item id "${item.item_id}" is used more than once.`,
      });
    }
    seen.add(item.item_id);

    // --- provenance: the one-way rule, over the frozen fact layer ------------
    if (item.claim_ids.length === 0) {
      faults.push({
        path: `${at}.claim_ids`,
        detail:
          `Item "${item.item_id}" rests on no claim. An undertaking that ` +
          `cannot be tied to something this hearing established is general ` +
          `advice, and this case is not why anyone came here for it.`,
      });
    }
    item.claim_ids.forEach((id, refIndex) => {
      if (known.has(id)) return;
      faults.push({
        path: `${at}.claim_ids[${refIndex}]`,
        detail:
          `Item "${item.item_id}" cites claim_id "${id}", which the frozen ` +
          `fact layer does not define. A contract may not rest on a claim that ` +
          `was never made, and never checked against the evidence.`,
      });
    });

    // --- who is bound -------------------------------------------------------
    if (item.kind === "commitment" && !mayBind(level, item.bound_party)) {
      faults.push({
        path: `${at}.kind`,
        detail:
          `Item "${item.item_id}" is a commitment binding the ` +
          `${item.bound_party}, and this case is locked at ${level} ` +
          `(${levelConstraints(level).label}). She was never heard and has ` +
          `agreed to nothing; anything addressed to her is an invitation, and ` +
          `is stored and labelled as one.`,
      });
    }

    // --- executable inside the week ----------------------------------------
    if (
      !Number.isInteger(item.within_days) ||
      item.within_days < 1 ||
      item.within_days > MAX_COMMITMENT_DAYS
    ) {
      faults.push({
        path: `${at}.within_days`,
        detail:
          `Item "${item.item_id}" runs ${item.within_days} day(s). It has to ` +
          `fit in 1-${MAX_COMMITMENT_DAYS}: anything longer is a plan, and ` +
          `nothing follows a plan up.`,
      });
    }

    // --- vagueness ----------------------------------------------------------
    for (const field of CHECKED_FIELDS) {
      const hit = firstVagueHit(item[field]);
      if (hit === null) continue;
      faults.push({
        path: `${at}.${field}`,
        detail: `Item "${item.item_id}" — "${hit.match}" in the ${field}: ${hit.why}.`,
      });
    }

    if (OCCASION_MARKER.exec(item.trigger) === null) {
      faults.push({
        path: `${at}.trigger`,
        detail:
          `Item "${item.item_id}" has no occasion in its trigger. A trigger ` +
          `names a situation that either happens or does not — "when she …", ` +
          `"the next time …", "after …". Without one there is no moment at ` +
          `which this was kept, and none at which it was broken.`,
      });
    }

    const inner = INNER_STATE.exec(item.observable);
    if (inner !== null) {
      faults.push({
        path: `${at}.observable`,
        detail:
          `Item "${item.item_id}" — "${inner[0]}" puts the evidence inside ` +
          `somebody's head. What would another person SEE or HEAR that tells ` +
          `them this happened? If the answer is a state of mind, the follow-up ` +
          `in seven days has no question to ask.`,
      });
    }
  });

  // --- is anybody actually bound? -------------------------------------------
  const commitments = content.items.filter((item) => item.kind === "commitment");
  const clientBound = commitments.some((item) => item.bound_party === "client");
  if (content.items.length > 0 && !clientBound) {
    faults.push({
      path: "items",
      detail:
        `Not one item binds the client. A contract in which every line is ` +
        `something the other person should do is a complaint with numbering` +
        (mayBind(level, "counterparty")
          ? `.`
          : `, and at ${level} it is a complaint against someone who has not ` +
            `been heard.`) +
        ` Write at least one thing the client does.`,
    });
  }

  if (faults.length === 0) return null;
  return {
    code: "improvement_contract_violation",
    message:
      `The improvement contract does not hold up:\n` +
      faults.map((fault) => `  - ${fault.path}: ${fault.detail}`).join("\n"),
    plan: faults,
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization — the demotion                                               */
/* -------------------------------------------------------------------------- */

/**
 * Turn what the model returned into what is stored, applying the level's
 * binding rule.
 *
 * Pure. The only thing it decides is `kind`, and it decides it from the level
 * rather than from anything the generation said about itself — which is what
 * "enforced in code, not in the prompt" has to mean here. A model that labelled
 * every item a commitment gets the same result as one that labelled none.
 */
export function normalizeImprovementContract(
  judgmentId: string,
  level: OutputLevel,
  output: ImprovementContractOutput,
): ImprovementContractContent {
  return {
    version: CONTRACT_CONTENT_VERSION,
    output_level: level,
    judgment_id: judgmentId,
    items: output.items.map((item) => {
      const bindable = mayBind(level, item.bound_party);
      return {
        item_id: item.item_id,
        kind: bindable ? ("commitment" as const) : ("invitation" as const),
        bound_party: item.bound_party,
        trigger: item.trigger,
        action: item.action,
        observable: item.observable,
        within_days: item.within_days,
        claim_ids: [...item.claim_ids],
        demoted_from_commitment: !bindable,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface ContractRenderOptions {
  /** How the counterparty is named in an invitation heading. */
  readonly counterpartyPseudonym?: string;
}

/** One item, as the person reads it. */
function renderItem(item: StoredContractItem, index: number): string {
  return (
    `${index + 1}. When: ${item.trigger}\n` +
    `   Then: ${item.action}\n` +
    `   Anyone would see: ${item.observable}\n` +
    `   Within ${item.within_days} day${item.within_days === 1 ? "" : "s"}. ` +
    `Rests on ${item.claim_ids.join(", ")}.` +
    (item.demoted_from_commitment
      ? `\n   Recorded as an invitation, not a commitment: it was written as ` +
        `something she would do, and she has not been heard.`
      : "")
  );
}

/**
 * The contract as text.
 *
 * Deterministic and timestamp-free, so re-deriving it produces the same bytes —
 * the property that makes a stored copy checkable against the content it came
 * from.
 */
export function renderImprovementContract(
  content: ImprovementContractContent,
  options: ContractRenderOptions = {},
): string {
  const commitments = content.items.filter((item) => item.kind === "commitment");
  const invitations = content.items.filter((item) => item.kind === "invitation");
  const other = options.counterpartyPseudonym ?? "the other party";
  const blocks: string[] = [];

  blocks.push(
    `## What you are committing to\n\n` +
      (commitments.length === 0
        ? `Nothing — this contract binds no one.`
        : commitments.map(renderItem).join("\n\n")),
  );

  if (invitations.length > 0) {
    blocks.push(
      `## Invitations to ${other} — not commitments\n\n` +
        `${other} has not been heard by this hearing and has agreed to ` +
        `nothing. These are things she could be asked, not things she has ` +
        `undertaken to do.\n\n` +
        invitations.map(renderItem).join("\n\n"),
    );
  }

  return blocks.join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* Provenance, for the screen                                                 */
/* -------------------------------------------------------------------------- */

export interface ClaimProvenance {
  readonly claimId: string;
  /** The claim's own sentence, or null when the id is not in the fact layer. */
  readonly statement: string | null;
  /** How the claim stands to the record — shown, because it qualifies the item. */
  readonly tier: ClaimTier | null;
}

/**
 * Resolve cited claim ids against the frozen fact layer, for display.
 *
 * Returns a `null` statement rather than throwing on an unknown id: this runs on
 * a screen, and every write path already refuses content that cites one. If a
 * null ever appears there, it means a stored row is out of step with the
 * judgment it belongs to, and hiding that would be worse than showing it.
 */
export function resolveClaimProvenance(
  factLayer: FactLayer,
  claimIds: readonly string[],
): readonly ClaimProvenance[] {
  const byId = new Map(factLayer.claims.map((claim) => [claim.claim_id, claim]));
  return claimIds.map((claimId) => {
    const claim = byId.get(claimId);
    return {
      claimId,
      statement: claim === undefined ? null : claim.statement,
      tier: claim === undefined ? null : claim.tier,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The task turn: the level, who may be bound under it, and the frozen skeleton.
 *
 * Byte-stable (`stableStringify` sorts keys, the fact layer carries no
 * timestamps), so two runs over the same judgment send the same prefix and the
 * prompt cache can do its job.
 */
export function renderImprovementContractPrompt(
  level: JudgmentRecord["outputLevel"],
  factLayer: FactLayer,
): string {
  const rules = levelConstraints(level);
  const client = factLayer.findings.record_basis.client_pseudonym;
  const allowed = boundPartiesAllowed(level);

  return (
    `## Output level (locked on this case; enforced in code)\n` +
    `${stableStringify({
      level,
      label: rules.label,
      requires: [...rules.requires],
      forbids: [...rules.forbids],
      may_be_bound: [...allowed],
    })}\n\n` +
    `## Who this contract is for\n` +
    `The client — "${client}" in the skeleton below — brought this case and is ` +
    `"you" here.\n` +
    (allowed.includes("counterparty")
      ? `Both parties took part in this hearing, so either of them may be bound.\n\n`
      : `The other party was never heard. Only ${client} may be bound: an item ` +
        `marked bound_party "counterparty" is stored as an invitation and ` +
        `labelled as one, and at least one item must bind ${client}. The ` +
        `server decides which is which — say what is worth saying and mark ` +
        `honestly who would have to do it.\n\n`) +
    `## Judgment skeleton (frozen — this is the entire factual basis you have)\n` +
    // Plain JSON by construction: it round-trips through a JSON column, so the
    // cast asserts nothing the schema does not already guarantee.
    `${stableStringify(factLayer as unknown as JsonValue)}\n\n` +
    `Write the improvement contract from the skeleton above. One to ` +
    `${MAX_CONTRACT_ITEMS} items; every item names an occasion, an act, what ` +
    `another person would see, a number of days no greater than ` +
    `${MAX_COMMITMENT_DAYS}, and at least one claim_id defined in the skeleton. ` +
    `The server checks all of it and rejects the whole contract on any of them.`
  );
}

/* -------------------------------------------------------------------------- */
/* The model call                                                             */
/* -------------------------------------------------------------------------- */

export interface ImprovementContractOptions {
  readonly llm?: RunStageOptions;
}

/**
 * Generate a contract from a frozen fact layer.
 *
 * Takes the fact layer, not a case id and not the judgment's prose: the
 * narrative is a reading of the claims written to persuade its reader, and a
 * contract derived from it would inherit the persuasion. The database is here
 * for the audit rows and the pseudonym dictionary only.
 */
export async function runImprovementContract(
  db: Db,
  caseId: string,
  judgmentId: string,
  level: OutputLevel,
  factLayer: FactLayer,
  options: ImprovementContractOptions = {},
): Promise<JudgmentStepResult<ImprovementContractContent>> {
  const basePrompt = renderImprovementContractPrompt(level, factLayer);
  const dict = buildCaseDict(db, caseId);

  const result = await runChecked<ImprovementContractOutput>(
    basePrompt,
    (prompt) =>
      runStage(
        improvementContractStage,
        { prompt, dict, caseId },
        { db, ...options.llm },
      ),
    (data) =>
      checkImprovementContract(
        { level, factLayer },
        normalizeImprovementContract(judgmentId, level, data),
      ),
  );

  if (result.kind !== "ok") return result;
  return {
    kind: "ok",
    data: normalizeImprovementContract(judgmentId, level, result.data),
    meta: result.meta,
    attempts: result.attempts,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export type ImprovementContractErrorCode =
  | "judgment_not_found"
  /** Derived documents exist from `finalize` onwards; a draft has none. */
  | "not_final"
  /** The stored contract left `draft`: somebody is living by it. */
  | "contract_in_force"
  /** A check refused the content, or a stored row no longer parses. */
  | "contract_invalid";

export class ImprovementContractError extends Error {
  readonly code: ImprovementContractErrorCode;
  readonly faults: readonly ContractFault[];

  constructor(
    code: ImprovementContractErrorCode,
    message: string,
    faults: readonly ContractFault[] = [],
  ) {
    super(message);
    this.name = "ImprovementContractError";
    this.code = code;
    this.faults = faults;
  }
}

export interface ImprovementContractProvenance {
  readonly model: string;
  readonly effort?: LlmEffort;
  readonly promptVersion?: string;
  readonly fallbackUsed?: boolean;
}

export interface ImprovementContractRecord {
  readonly id: string;
  readonly caseId: string;
  readonly judgmentId: string;
  readonly status: ContractStatus;
  readonly confirmStatus: ConfirmStatus;
  readonly content: ImprovementContractContent;
  /** The items that bind somebody. */
  readonly commitments: readonly StoredContractItem[];
  /** The items about a party who has not been heard. Labelled, never binding. */
  readonly invitations: readonly StoredContractItem[];
  /** What a person reads: the human's edit if there is one, else the render. */
  readonly text: string;
  readonly updatedAt: Date;
}

function toRecord(
  row: typeof improvementContracts.$inferSelect,
): ImprovementContractRecord {
  // Strict on read, like the judgment's own layers: every write went through
  // the schema, so a row that no longer parses is corruption or an undeclared
  // change of shape, and both have to be loud.
  const parsed = improvementContractContentSchema.safeParse(row.content);
  if (!parsed.success) {
    throw new ImprovementContractError(
      "contract_invalid",
      `improvement_contracts[${row.id}].content does not parse: ` +
        parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
          .join("; "),
    );
  }
  const content = parsed.data;
  return {
    id: row.id,
    caseId: row.caseId,
    /* c8 ignore next -- judgment_id is set by every write path in this module. */
    judgmentId: row.judgmentId ?? content.judgment_id,
    status: row.status,
    confirmStatus: row.confirmStatus,
    content,
    commitments: content.items.filter((item) => item.kind === "commitment"),
    invitations: content.items.filter((item) => item.kind === "invitation"),
    text: row.humanFinal ?? row.aiDraft ?? renderImprovementContract(content),
    updatedAt: row.updatedAt,
  };
}

/** The stored contract for a judgment, or null. */
export function readImprovementContract(
  db: Db,
  judgmentId: string,
): ImprovementContractRecord | null {
  const row = db
    .select()
    .from(improvementContracts)
    .where(eq(improvementContracts.judgmentId, judgmentId))
    .get();
  return row === undefined || row.content === null ? null : toRecord(row);
}

/**
 * Store a contract against a frozen judgment.
 *
 * Re-validates before writing rather than trusting whatever produced the value:
 * this function is also the door a script, a fixture or a future appeal path
 * comes through, and the checks that authorize a write are the ones run at the
 * moment of the write. In particular this is where a commitment binding a party
 * the level does not allow is **refused** — the generation path demotes such an
 * item to an invitation before it ever gets here, and this is what makes that a
 * courtesy rather than the only thing standing between the counterparty and an
 * undertaking she never made.
 *
 * A contract that has left `draft` is not overwritten. Once somebody has
 * activated it, it is a thing they are living by; regenerating over it would
 * silently replace what they agreed to, which is the same failure freezing
 * exists to prevent one level up.
 */
export function persistImprovementContract(
  db: Db,
  judgmentId: string,
  content: ImprovementContractContent,
  provenance: ImprovementContractProvenance,
  options: ContractRenderOptions = {},
): ImprovementContractRecord {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new ImprovementContractError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  if (judgment.status === "draft") {
    throw new ImprovementContractError(
      "not_final",
      `Judgment ${judgmentId} is still a draft. An improvement contract is ` +
        `derived from a frozen judgment; a draft is still being written.`,
    );
  }

  const rejection = checkImprovementContract(
    { level: judgment.outputLevel, factLayer: judgment.factLayer },
    content,
  );
  if (rejection !== null) {
    throw new ImprovementContractError(
      "contract_invalid",
      rejection.message,
      rejection.plan ?? [],
    );
  }

  const existing = db
    .select()
    .from(improvementContracts)
    .where(
      and(
        eq(improvementContracts.judgmentId, judgmentId),
        eq(improvementContracts.caseId, judgment.caseId),
      ),
    )
    .get();

  if (existing !== undefined && existing.status !== "draft") {
    throw new ImprovementContractError(
      "contract_in_force",
      `The improvement contract for judgment ${judgmentId} is "${existing.status}", ` +
        `not a draft. Somebody is living by it; a regeneration does not write ` +
        `over what they agreed to.`,
    );
  }

  // Who the invitations are addressed to, named the way the rest of the
  // pipeline names her: `readParticipation` is the function the stage machine
  // uses, so the heading of this document and the gate that let the case
  // through cannot disagree about which party is the counterparty.
  const counterparty =
    options.counterpartyPseudonym ??
    readParticipation(db, judgment.caseId).counterparty?.pseudonym;

  const stored: ImprovementContractContent = {
    ...content,
    judgment_id: judgmentId,
    generated_by: {
      model: provenance.model,
      effort: provenance.effort ?? null,
      prompt_version: provenance.promptVersion ?? null,
      fallback_used: provenance.fallbackUsed ?? false,
    },
  };
  const text = renderImprovementContract(stored, {
    counterpartyPseudonym: counterparty,
  });
  const column = stored as unknown as Record<string, unknown>;

  const [row] =
    existing === undefined
      ? db
          .insert(improvementContracts)
          .values({
            caseId: judgment.caseId,
            judgmentId,
            content: column,
            status: "draft",
            aiDraft: text,
          })
          .returning()
          .all()
      : db
          .update(improvementContracts)
          .set({
            content: column,
            aiDraft: text,
            // Re-derivation resets the human half: the confirmation belonged to
            // the text that was replaced.
            humanFinal: null,
            confirmStatus: "pending",
          })
          // The guard is on the statement, not on the read above it: if the row
          // was activated between the two, nothing is written.
          .where(
            and(
              eq(improvementContracts.id, existing.id),
              eq(improvementContracts.status, "draft"),
            ),
          )
          .returning()
          .all();

  if (row === undefined) {
    /* c8 ignore next 5 -- only reachable if the row is activated mid-write. */
    throw new ImprovementContractError(
      "contract_in_force",
      `The improvement contract for judgment ${judgmentId} was activated while ` +
        `this one was being written. Nothing was stored.`,
    );
  }

  return toRecord(row);
}

/* -------------------------------------------------------------------------- */
/* The whole act                                                              */
/* -------------------------------------------------------------------------- */

export type ImprovementContractOutcome =
  | {
      readonly kind: "generated";
      readonly record: ImprovementContractRecord;
      readonly meta: StageMeta;
      readonly attempts: number;
    }
  /** Refused by a server-side check, twice. */
  | {
      readonly kind: "rejected";
      readonly rejection: JudgmentRejection;
      readonly attempts: number;
    }
  | { readonly kind: "refused"; readonly category?: string }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string }
  /** No such judgment, it is not frozen, or its contract is already in force. */
  | { readonly kind: "blocked"; readonly message: string };

/**
 * Generate and store the improvement contract for a frozen judgment.
 *
 * Never throws for an expected outcome, for the same reason `generateJudgment`
 * and `generateShareableRendition` do not: a refusal, a rejected document and a
 * transport failure are all results a caller has to branch on.
 */
export async function generateImprovementContract(
  db: Db,
  judgmentId: string,
  options: ImprovementContractOptions & ContractRenderOptions = {},
): Promise<ImprovementContractOutcome> {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    return { kind: "blocked", message: `No judgment with id ${judgmentId}.` };
  }
  if (judgment.status === "draft") {
    return {
      kind: "blocked",
      message:
        `Judgment ${judgmentId} is a draft. The improvement contract is ` +
        `derived from a frozen judgment; a draft is still being written.`,
    };
  }

  const result = await runImprovementContract(
    db,
    judgment.caseId,
    judgmentId,
    judgment.outputLevel,
    judgment.factLayer,
    { llm: options.llm },
  );

  if (result.kind === "refused") {
    return result.category === undefined
      ? { kind: "refused" }
      : { kind: "refused", category: result.category };
  }
  if (result.kind === "error") {
    return { kind: "error", retryable: result.retryable, message: result.message };
  }
  /* c8 ignore next 3 -- `no_material` is unreachable: nothing here reads the record. */
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

  try {
    const record = persistImprovementContract(
      db,
      judgmentId,
      result.data,
      {
        model: result.meta.model,
        effort: improvementContractStage.effort,
        promptVersion: improvementContractStage.promptVersion,
        fallbackUsed: result.meta.fallbackUsed,
      },
      { counterpartyPseudonym: options.counterpartyPseudonym },
    );
    return {
      kind: "generated",
      record,
      meta: result.meta,
      attempts: result.attempts,
    };
  } catch (error) {
    if (
      error instanceof ImprovementContractError &&
      error.code === "contract_in_force"
    ) {
      return { kind: "blocked", message: error.message };
    }
    /* c8 ignore next -- any other failure here is a bug, not an outcome. */
    throw error;
  }
}
