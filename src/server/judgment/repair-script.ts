/**
 * The repair-conversation script — SPEC M4 ③.
 *
 * Two things a judgment cannot do for anyone: say the first sentence, and be in
 * the room when it goes wrong. This module derives both from the frozen fact
 * layer — an opening line the client could actually say out loud, and the block
 * for the moment the conversation stops working (a pause signal, a flooding
 * self-check, an agreed return time).
 *
 * ## From the fact layer, never from the narrative
 *
 * `runRepairScript` takes a `FactLayer`. Not a case id, not the judgment's
 * prose — a signature rather than a convention, the same discipline
 * `runJudgmentNarrative` uses one step earlier. The narrative is a *reading* of
 * the claims, written to be persuasive to the person it addresses; a script
 * generated from it would inherit that rhetoric and hand it to the client as
 * their own words. The claims were checked against evidence. The prose was
 * checked against the claims. Only the first of those is a thing to put in
 * somebody's mouth.
 *
 * ## What is checked, and why each check is not a style note
 *
 *   1. **Provenance** — every cited `claim_id` exists in the frozen fact layer.
 *      A script that cannot point at a claim is generic advice; this couple can
 *      get that anywhere, and it should not arrive under a judgment's authority.
 *   2. **The opening line is sayable** — first person, no "you always" / "you
 *      never" / "you made me", no verdict quoted as leverage, short enough to
 *      get out in one breath. A "softened start-up" that opens with the other
 *      person's failings is the hard start-up with a longer preamble, and it is
 *      the single most reliable way to lose the conversation in its first
 *      fifteen seconds.
 *   3. **The flooding self-check names a sign, not a feeling** — pulse, breath,
 *      voice, jaw, pacing, rehearsing the reply. By the time somebody is
 *      flooded, "am I upset?" is not a question they can answer; "is my voice
 *      doing that thing?" is.
 *   4. **The return time names a time.** A pause with no return is a walk-out,
 *      and it is what the other person will remember about the evening.
 *
 * The lexical checks are partial by construction, like every lexical check in
 * this repo: they recognize known-empty shapes and cannot recognize an original
 * one. What makes the script sayable is that it was generated to be; the checks
 * are what prove the generation did what it said.
 *
 * Nothing here writes to `judgments`. The script is derived from the frozen
 * judgment and stored on `repair_scripts` (HARD RULE #6).
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db";
import {
  repairScripts,
  type ConfirmStatus,
  type LlmEffort,
  type OutputLevel,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { runStage, type RunStageOptions, type StageMeta } from "../llm";
import { repairScriptStage } from "../llm/stages";
import {
  MAX_OPENING_LINE_CHARS,
  type RepairScriptOutput,
} from "../llm/stages/repair-script";
import { stableStringify, type JsonValue } from "../pipeline/case-file";
import { readJudgment, type FactLayer } from "./contract";
import {
  runChecked,
  type JudgmentRejection,
  type JudgmentStepResult,
} from "./generation";
import {
  contractProvenanceSchema,
  resolveClaimProvenance,
  type ClaimProvenance,
  type ContractFault,
  type ContractProvenanceRecord,
} from "./improvement-contract";
import { levelConstraints } from "./levels";

/* -------------------------------------------------------------------------- */
/* What is stored                                                             */
/* -------------------------------------------------------------------------- */

export const REPAIR_SCRIPT_CONTENT_VERSION = 1;

export const repairScriptContentSchema = z.object({
  version: z.number().int(),
  judgment_id: z.string().min(1),
  opening_line: z.string().min(1),
  when_it_goes_wrong: z.object({
    pause_signal: z.string().min(1),
    flooding_self_check: z.string().min(1),
    return_time: z.string().min(1),
  }),
  claim_ids: z.array(z.string().min(1)),
  /** See `contractProvenanceSchema`: `repair_scripts` has no model column. */
  generated_by: contractProvenanceSchema.nullish(),
});

export type RepairScriptContent = z.infer<typeof repairScriptContentSchema>;

/* -------------------------------------------------------------------------- */
/* The checks                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Openings that are accusations.
 *
 * Short and specific on purpose. Each of these turns the first sentence into a
 * charge the other person has to answer, which is the one thing a repair
 * conversation cannot survive at the start. This is not a politeness filter:
 * "what you did on Wednesday" is allowed and should be, because naming the event
 * is what makes the line about something.
 */
const HARD_START: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\byou\s+(always|never|constantly|keep)\b/i,
    why:
      "an absolute about the other person. It invites the one counterexample " +
      "that ends the conversation and settles nothing",
  },
  {
    pattern: /\byou\s+(made|make)\s+me\b/i,
    why:
      "this hands the other person authorship of the speaker's own reaction, " +
      "and it is the sentence people remember being told",
  },
  {
    pattern: /\b(your|it('s| is) your)\s+fault\b/i,
    why: "a verdict is not an opening",
  },
  {
    pattern: /\b(the judgment|this judgment|the verdict|the ruling|the analysis)\b/i,
    why:
      "quoting the hearing as authority turns an opening line into a summons. " +
      "The client is opening a conversation, not serving a document",
  },
  {
    pattern: /\byou\s+(need|have)\s+to\b/i,
    why: "an instruction in the first sentence is a demand, not an opening",
  },
];

/** First person: the mark of a line about the speaker's own part. */
const FIRST_PERSON = /\b(I|I'm|I've|I'll|I'd|me|my|mine|myself)\b/;

/**
 * Physical and behavioural signs of flooding.
 *
 * The list is generous — any of these makes the self-check a thing that can be
 * noticed from outside one's own opinion of oneself. What it excludes is the
 * self-check made entirely of emotion words, which is the one that fails exactly
 * when it is needed.
 */
const BODY_SIGN = new RegExp(
  "\\b(" +
    "puls\\w*|heart\\w*|chest|breath\\w*|jaw|teeth|hands?|fists?|shoulders?|" +
    "throat|stomach|face|ears|neck|" +
    "voice|volume|tone|loud\\w*|fast\\w*|shak\\w*|trembl\\w*|sweat\\w*|hot|" +
    "flush\\w*|tight\\w*|clench\\w*|" +
    "pac\\w*|stand\\w*|walk\\w*|typ\\w*|phone|scroll\\w*|" +
    "rehears\\w*|interrupt\\w*|talking over|repeat\\w*|score|scoring|" +
    "win\\w*|prov\\w*|argu\\w*|" +
    "stopped (listening|hearing)|not listening" +
    ")\\b",
  "i",
);

/** What a time looks like. A return time without one is not a return time. */
const TIME_MARKER = new RegExp(
  "(" +
    "\\b\\d+\\s*(minutes?|mins?|hours?|hrs?|days?)\\b|" +
    "\\b(half an hour|an hour|tonight|tomorrow|later today)\\b|" +
    "\\bthis (evening|morning|afternoon|weekend)\\b|" +
    "\\bafter (dinner|lunch|work|the kids|breakfast)\\b|" +
    "\\bbefore (bed|dinner|work)\\b|" +
    "\\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b|" +
    "\\bat \\d{1,2}(:\\d{2})?\\s*(am|pm)?\\b" +
    ")",
  "i",
);

export interface RepairScriptContext {
  /** The frozen fact layer every cited id must come from. */
  readonly factLayer: FactLayer;
}

/**
 * Everything that must hold before a script is stored.
 *
 * Returns a `JudgmentRejection`, so the retry loop hands the model its own
 * faults verbatim — the same shape every other checked step in this layer uses.
 */
export function checkRepairScript(
  context: RepairScriptContext,
  content: RepairScriptContent,
): JudgmentRejection | null {
  const faults: ContractFault[] = [];
  const known = new Set(context.factLayer.claims.map((claim) => claim.claim_id));

  // --- provenance -----------------------------------------------------------
  if (content.claim_ids.length === 0) {
    faults.push({
      path: "claim_ids",
      detail:
        "This script rests on no claim. A repair script that cannot point at " +
        "something this hearing established is general advice wearing the " +
        "judgment's authority.",
    });
  }
  content.claim_ids.forEach((id, index) => {
    if (known.has(id)) return;
    faults.push({
      path: `claim_ids[${index}]`,
      detail:
        `The script cites claim_id "${id}", which the frozen fact layer does ` +
        `not define. It is written from the skeleton and may not out-run it.`,
    });
  });

  // --- the opening line -----------------------------------------------------
  const opening = content.opening_line.trim();
  if (opening.length > MAX_OPENING_LINE_CHARS) {
    faults.push({
      path: "opening_line",
      detail:
        `The opening line is ${opening.length} characters. An opening line is ` +
        `a line: at most ${MAX_OPENING_LINE_CHARS}, the length of something a ` +
        `person can get out before their nerve goes.`,
    });
  }
  if (!FIRST_PERSON.test(opening)) {
    faults.push({
      path: "opening_line",
      detail:
        "The opening line is not in the first person. It is written to be " +
        "said by the client, about their own part — a line with no \"I\" in " +
        "it is a description of what they should say, or it is about the " +
        "other person.",
    });
  }
  for (const rule of HARD_START) {
    const hit = rule.pattern.exec(opening);
    if (hit === null) continue;
    faults.push({
      path: "opening_line",
      detail: `"${hit[0]}" — ${rule.why}.`,
    });
  }

  // --- when it goes wrong ---------------------------------------------------
  const block = content.when_it_goes_wrong;

  if (!BODY_SIGN.test(block.flooding_self_check)) {
    faults.push({
      path: "when_it_goes_wrong.flooding_self_check",
      detail:
        "The self-check names no physical or behavioural sign. Pulse, breath, " +
        "heat in the face, voice getting faster, jaw, pacing, rehearsing the " +
        "reply instead of listening. An emotion word is not a self-check: by " +
        "the time somebody is flooded, \"am I upset?\" is not a question they " +
        "can answer.",
    });
  }

  if (!TIME_MARKER.test(block.return_time)) {
    faults.push({
      path: "when_it_goes_wrong.return_time",
      detail:
        "The return time names no time. \"In 30 minutes\", \"after dinner " +
        "tonight\", \"tomorrow morning\" — a pause with no return time is a " +
        "walk-out, and that is what the other person will remember.",
    });
  }

  if (faults.length === 0) return null;
  return {
    code: "repair_script_violation",
    message:
      `The repair script does not hold up:\n` +
      faults.map((fault) => `  - ${fault.path}: ${fault.detail}`).join("\n"),
    plan: faults,
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization and rendering                                                */
/* -------------------------------------------------------------------------- */

/** What the model returned, in the shape that is stored. Pure. */
export function normalizeRepairScript(
  judgmentId: string,
  output: RepairScriptOutput,
): RepairScriptContent {
  return {
    version: REPAIR_SCRIPT_CONTENT_VERSION,
    judgment_id: judgmentId,
    opening_line: output.opening_line,
    when_it_goes_wrong: { ...output.when_it_goes_wrong },
    claim_ids: [...output.claim_ids],
  };
}

/**
 * The script as text. Deterministic and timestamp-free.
 *
 * The claim ids are deliberately NOT in it: this is the half a person reads
 * before they speak, and a citation in the middle of a sentence they are about
 * to say out loud is the judgment intruding on the conversation. Provenance is
 * shown next to the script on the screen, where it belongs.
 */
export function renderRepairScript(content: RepairScriptContent): string {
  const block = content.when_it_goes_wrong;
  return (
    `## What you could open with\n\n` +
    `${content.opening_line.trim()}\n\n` +
    `## When it goes wrong\n\n` +
    `Pause signal — ${block.pause_signal.trim()}\n\n` +
    `How you will know you are flooded — ${block.flooding_self_check.trim()}\n\n` +
    `When you come back — ${block.return_time.trim()}`
  );
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The task turn: the level's constraints, who is speaking, and the frozen
 * skeleton. Byte-stable, for the same reason every other prompt here is.
 */
export function renderRepairScriptPrompt(
  level: OutputLevel,
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
    })}\n\n` +
    `## Who is speaking\n` +
    `The client — "${client}" in the skeleton below — brought this case and ` +
    `would be the one saying the opening line. Write it in their voice, in the ` +
    `first person. The other party is not "you" here and does not get lines: ` +
    `you do not know what she will say.\n\n` +
    `## Judgment skeleton (frozen — this is the entire factual basis you have)\n` +
    // Plain JSON by construction; `stableStringify` sorts the keys.
    `${stableStringify(factLayer as unknown as JsonValue)}\n\n` +
    `Write the repair script from the skeleton above. The opening line is at ` +
    `most ${MAX_OPENING_LINE_CHARS} characters and in the first person; the ` +
    `flooding self-check names a physical or behavioural sign; the return time ` +
    `names an actual time; every claim_id is one the skeleton defines. The ` +
    `server checks all four and rejects the whole script on any of them.`
  );
}

/* -------------------------------------------------------------------------- */
/* The model call                                                             */
/* -------------------------------------------------------------------------- */

export interface RepairScriptOptions {
  readonly llm?: RunStageOptions;
}

/**
 * Generate a repair script from a frozen fact layer.
 *
 * The fact layer is the whole input; the database is here for the audit rows and
 * the pseudonym dictionary. See the header for why the narrative is not passed.
 */
export async function runRepairScript(
  db: Db,
  caseId: string,
  judgmentId: string,
  level: OutputLevel,
  factLayer: FactLayer,
  options: RepairScriptOptions = {},
): Promise<JudgmentStepResult<RepairScriptContent>> {
  const basePrompt = renderRepairScriptPrompt(level, factLayer);
  const dict = buildCaseDict(db, caseId);

  const result = await runChecked<RepairScriptOutput>(
    basePrompt,
    (prompt) =>
      runStage(repairScriptStage, { prompt, dict, caseId }, { db, ...options.llm }),
    (data) =>
      checkRepairScript({ factLayer }, normalizeRepairScript(judgmentId, data)),
  );

  if (result.kind !== "ok") return result;
  return {
    kind: "ok",
    data: normalizeRepairScript(judgmentId, result.data),
    meta: result.meta,
    attempts: result.attempts,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export type RepairScriptErrorCode =
  | "judgment_not_found"
  | "not_final"
  /** A human has confirmed or edited the stored script. */
  | "script_confirmed"
  | "script_invalid";

export class RepairScriptError extends Error {
  readonly code: RepairScriptErrorCode;
  readonly faults: readonly ContractFault[];

  constructor(
    code: RepairScriptErrorCode,
    message: string,
    faults: readonly ContractFault[] = [],
  ) {
    super(message);
    this.name = "RepairScriptError";
    this.code = code;
    this.faults = faults;
  }
}

export interface RepairScriptProvenance {
  readonly model: string;
  readonly effort?: LlmEffort;
  readonly promptVersion?: string;
  readonly fallbackUsed?: boolean;
}

export interface RepairScriptRecord {
  readonly id: string;
  readonly caseId: string;
  readonly judgmentId: string;
  readonly confirmStatus: ConfirmStatus;
  readonly content: RepairScriptContent;
  /** What a person reads: the human's edit if there is one, else the render. */
  readonly text: string;
  readonly provenance: ContractProvenanceRecord | null;
  readonly updatedAt: Date;
}

function toRecord(row: typeof repairScripts.$inferSelect): RepairScriptRecord {
  // `ai_draft` is the structured script; `content` is the rendered text. The
  // structure is the authority and the text is re-derived from it on read, for
  // the same reason a rendition is: one of them is checked, the other is a
  // record of what the checked one looked like.
  let raw: unknown = null;
  try {
    raw = row.aiDraft === null ? null : (JSON.parse(row.aiDraft) as unknown);
  } catch {
    raw = null;
  }
  const parsed = repairScriptContentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepairScriptError(
      "script_invalid",
      `repair_scripts[${row.id}].ai_draft does not parse: ` +
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
    confirmStatus: row.confirmStatus,
    content,
    text: row.humanFinal ?? renderRepairScript(content),
    provenance: content.generated_by ?? null,
    updatedAt: row.updatedAt,
  };
}

/** The stored script for a judgment, or null. */
export function readRepairScript(
  db: Db,
  judgmentId: string,
): RepairScriptRecord | null {
  const row = db
    .select()
    .from(repairScripts)
    .where(eq(repairScripts.judgmentId, judgmentId))
    .get();
  return row === undefined || row.aiDraft === null ? null : toRecord(row);
}

/**
 * Store a script against a frozen judgment.
 *
 * Re-validates before writing, like every other write door in this layer: the
 * checks that authorize a write are the ones run at the moment of the write.
 *
 * A script a human has confirmed or edited is not overwritten. At that point it
 * is the sentence they decided to say, and regenerating over it would replace
 * their words with a model's without anybody being told.
 */
export function persistRepairScript(
  db: Db,
  judgmentId: string,
  content: RepairScriptContent,
  provenance: RepairScriptProvenance,
): RepairScriptRecord {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    throw new RepairScriptError(
      "judgment_not_found",
      `No judgment with id ${judgmentId}.`,
    );
  }
  if (judgment.status === "draft") {
    throw new RepairScriptError(
      "not_final",
      `Judgment ${judgmentId} is still a draft. The repair script is derived ` +
        `from a frozen judgment; a draft is still being written.`,
    );
  }

  const rejection = checkRepairScript({ factLayer: judgment.factLayer }, content);
  if (rejection !== null) {
    throw new RepairScriptError(
      "script_invalid",
      rejection.message,
      rejection.plan ?? [],
    );
  }

  const stored: RepairScriptContent = {
    ...content,
    judgment_id: judgmentId,
    generated_by: {
      model: provenance.model,
      effort: provenance.effort ?? null,
      prompt_version: provenance.promptVersion ?? null,
      fallback_used: provenance.fallbackUsed ?? false,
    },
  };

  const existing = db
    .select()
    .from(repairScripts)
    .where(
      and(
        eq(repairScripts.judgmentId, judgmentId),
        eq(repairScripts.caseId, judgment.caseId),
      ),
    )
    .get();

  if (existing !== undefined && existing.confirmStatus !== "pending") {
    throw new RepairScriptError(
      "script_confirmed",
      `The repair script for judgment ${judgmentId} is "${existing.confirmStatus}". ` +
        `A human has already decided what they are going to say; a ` +
        `regeneration does not write over it.`,
    );
  }

  const [row] =
    existing === undefined
      ? db
          .insert(repairScripts)
          .values({
            caseId: judgment.caseId,
            judgmentId,
            content: renderRepairScript(stored),
            aiDraft: JSON.stringify(stored),
          })
          .returning()
          .all()
      : db
          .update(repairScripts)
          .set({
            content: renderRepairScript(stored),
            aiDraft: JSON.stringify(stored),
          })
          // The guard is on the statement, not on the read above it.
          .where(
            and(
              eq(repairScripts.id, existing.id),
              eq(repairScripts.confirmStatus, "pending"),
            ),
          )
          .returning()
          .all();

  if (row === undefined) {
    /* c8 ignore next 5 -- only reachable if the row is confirmed mid-write. */
    throw new RepairScriptError(
      "script_confirmed",
      `The repair script for judgment ${judgmentId} was confirmed while this ` +
        `one was being written. Nothing was stored.`,
    );
  }

  return toRecord(row);
}

/* -------------------------------------------------------------------------- */
/* The whole act                                                              */
/* -------------------------------------------------------------------------- */

export type RepairScriptOutcome =
  | {
      readonly kind: "generated";
      readonly record: RepairScriptRecord;
      readonly meta: StageMeta;
      readonly attempts: number;
    }
  | {
      readonly kind: "rejected";
      readonly rejection: JudgmentRejection;
      readonly attempts: number;
    }
  | { readonly kind: "refused"; readonly category?: string }
  | { readonly kind: "error"; readonly retryable: boolean; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string };

/** Generate and store the repair script for a frozen judgment. */
export async function generateRepairScript(
  db: Db,
  judgmentId: string,
  options: RepairScriptOptions = {},
): Promise<RepairScriptOutcome> {
  const judgment = readJudgment(db, judgmentId);
  if (judgment === null) {
    return { kind: "blocked", message: `No judgment with id ${judgmentId}.` };
  }
  if (judgment.status === "draft") {
    return {
      kind: "blocked",
      message:
        `Judgment ${judgmentId} is a draft. The repair script is derived from ` +
        `a frozen judgment; a draft is still being written.`,
    };
  }

  const result = await runRepairScript(
    db,
    judgment.caseId,
    judgmentId,
    judgment.outputLevel,
    judgment.factLayer,
    options,
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
    const record = persistRepairScript(db, judgmentId, result.data, {
      model: result.meta.model,
      effort: repairScriptStage.effort,
      promptVersion: repairScriptStage.promptVersion,
      fallbackUsed: result.meta.fallbackUsed,
    });
    return {
      kind: "generated",
      record,
      meta: result.meta,
      attempts: result.attempts,
    };
  } catch (error) {
    if (error instanceof RepairScriptError && error.code === "script_confirmed") {
      return { kind: "blocked", message: error.message };
    }
    /* c8 ignore next -- any other failure here is a bug, not an outcome. */
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Provenance, for the screen                                                 */
/* -------------------------------------------------------------------------- */

/** The claims this script was built from, resolved for display. */
export function repairScriptProvenance(
  factLayer: FactLayer,
  content: RepairScriptContent,
): readonly ClaimProvenance[] {
  return resolveClaimProvenance(factLayer, content.claim_ids);
}
