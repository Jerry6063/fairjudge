/**
 * `npm run fairjudge` — the kernel from a terminal.
 *
 * The product is growing a second runtime (doc 05 §B): a Claude Code skill that
 * drives the same pipeline, where the model already running the surrounding
 * session replaces the API transport. A skill drives things by running commands,
 * so the pipeline needs a command surface — this file.
 *
 * ## It is a surface, not a second implementation
 *
 * Every subcommand below is a thin wrapper over a server function the web app
 * already calls. Nothing here decides anything: it does not derive an output
 * level, does not choose whether a stage may advance, does not judge whether a
 * citation holds. Those live in `src/server/` and they are the same code the app
 * runs. When one of them refuses, the refusal is printed as the server phrased
 * it — the state machine already writes precise, user-facing blockers, and
 * rewording them here would produce a second, worse vocabulary for the same
 * facts and hide which precondition actually failed.
 *
 * ## What it does decide: which server functions belong on a one-person surface
 *
 * Being a thin wrapper is not the same as wrapping everything. This is a
 * single-party instrument — one operator, one terminal, nobody else in the room
 * — and a function whose meaning depends on WHO called it does not survive
 * being put on it. `submitStatement` is the case in point and it was here once:
 * in the app it is reachable only through the consent-gated `/respond` flow, and
 * exposed bare it let one person file the other party's statement, her consent
 * and her participation state in a single command (see `evidence:add-transcript`
 * below). The counterparty's own acts stay in the app, behind the door she
 * opens. What this surface offers instead is the client's own material and the
 * human judgements the workbench asks for, one command per act.
 *
 * ## The guards, and why they are the first thing in the file
 *
 * On 2026-08-12 an agent following a task book wrote fabricated *confirmed*
 * utterances into the live record of a real person's relationship, recorded
 * consent events for someone who has never consented, and relocked the case on
 * that basis (CLAUDE.md, Verification rule). This CLI is exactly the kind of
 * tool that incident was carried out with, so it refuses to pick its own
 * database and refuses to touch the live one — by path, by symlink, by inode,
 * and by way of `DATABASE_URL` quietly outranking the variable you set. Same
 * guards as `scripts/seed-fixture.ts`, for the same reason.
 *
 * ## Output
 *
 * Plain text, no colour, no spinners, nothing that needs a terminal. Records
 * print one `field<TAB>value` per line; lists print one row per line with
 * tab-separated columns. Errors go to stderr and the exit code is 1.
 */

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";

import { createDb, runMigrations, DEFAULT_DB_PATH, type Db } from "../src/server/db";
import {
  CLIENT_INTENTS,
  OCCURRED_PRECISIONS,
  caseParticipants,
  events,
  utterances,
  type CaseStage,
  type OccurredPrecision,
} from "../src/server/db/schema";
import { loadEnvLocal, PROJECT_ROOT } from "../src/server/env";
// Concrete modules rather than the barrels, as the other scripts do: a CLI
// should not stop working because an unrelated re-export is mid-edit.
import {
  CaseCreationError,
  createCase,
  validateCaseInput,
} from "../src/server/cases/create";
import { listCases } from "../src/server/cases/list";
import { buildCaseDict } from "../src/server/evidence/anomaly";
import { ingestEvidenceUpload } from "../src/server/evidence/intake";
import { listEvidence, resolveDefaultCaseId } from "../src/server/evidence/queries";
import {
  TRANSCRIPT_SOURCES,
  addTranscriptEvidence,
  isTranscriptSource,
} from "../src/server/evidence/transcript";
import {
  confirmUtterance,
  listEvidenceUtterances,
  updateUtteranceAttributes,
  type SpeakerAssignment,
} from "../src/server/evidence/workbench";
import {
  assembleJudgmentDossier,
  serializeJudgmentDossier,
} from "../src/server/judgment/dossier";
import {
  SKELETON_TASK,
  checkFactLayer,
  checkSurfaceLayer,
  renderLevelTask,
  renderNarrativePrompt,
} from "../src/server/judgment/generation";
import {
  createDraft,
  finalize,
  parseFactLayer,
  parseSurfaceLayer,
  readJudgmentChain,
  updateDraft,
} from "../src/server/judgment/contract";
import { buildJudgmentReadView } from "../src/server/judgment/read-view";
import {
  EXTERNAL_SESSION,
  ingestStage,
  prepareStage,
} from "../src/server/llm/external";
import type { StageDescriptor } from "../src/server/llm/types";
import {
  adverseFactsSchema,
  adverseFactsStage,
  clarificationQuestionsSchema,
  clarificationQuestionsStage,
  issueFixingSchema,
  issueFixingStage,
  judgmentNarrativeStage,
  judgmentSkeletonStage,
  steelmanSchema,
  steelmanStage,
} from "../src/server/llm/stages";
import {
  acknowledgeAdverseFact,
  assertJudgmentAllowed,
  buildAdverseFactsPrompt,
  contestAdverseFact,
  listAdverseFacts,
  persistAdverseFacts,
} from "../src/server/pipeline/adverse-facts";
import {
  answerClarificationQuestion,
  buildClarificationPrompt,
  declineClarificationQuestion,
  markClarificationSaturated,
  readClarification,
  recordClarificationRound,
} from "../src/server/pipeline/clarification";
import { NO_CITABLE_MATERIAL } from "../src/server/pipeline/cited-generation";
import {
  buildIssueFixingPrompt,
  confirmIssue,
  editIssue,
  listIssues,
  persistIssues,
  rejectIssue,
} from "../src/server/pipeline/issue-fixing";
import {
  PARTICIPATION_ANSWERS,
  PARTICIPATION_META,
  readParticipation,
  setCounterpartyParticipation,
  type ParticipationAnswer,
} from "../src/server/pipeline/participation";
import {
  NO_STEELMAN_MATERIAL,
  buildSteelmanPrompt,
  persistSteelman,
  readSteelman,
  recordSteelmanVerdict,
  type SteelmanAnswer,
} from "../src/server/pipeline/steelman";
import {
  createEvent,
  dateEvent,
  loadTimeline,
  moveEvent,
} from "../src/server/domain/timeline";
import {
  blockersForNextStage,
  collectCaseFacts,
  nextStage,
} from "../src/server/pipeline/stage-machine";
import { advanceStage } from "../src/server/pipeline/stage-machine";
import {
  lockOutputLevel,
  readOutputLevel,
} from "../src/server/pipeline/output-level";
import { runIntakeSafetyGate } from "../src/server/safety/gate";
import { SAFETY_CHOICES, SAFETY_QUESTIONS } from "../src/server/safety/questionnaire";
import {
  CRISIS_RESOURCES,
  REFERRAL_EXPLANATION,
  REFERRAL_HEADLINE,
  REFERRAL_NEXT_STEPS,
  REFERRAL_RESOURCE_NOTE,
  REGION_LABELS,
} from "../src/server/safety/resources";

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

class CliError extends Error {}

/** Every refusal in this file goes through here, so none of them can `return`. */
function die(message: string): never {
  throw new CliError(message);
}

/** Same file on disk, through any number of links. */
function isSameFile(a: string, b: string): boolean {
  try {
    if (realpathSync(a) === realpathSync(b)) return true;
  } catch {
    // One of them does not exist yet — fall through to the inode check.
  }
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Resolve the target database, or refuse.
 *
 * `DATABASE_URL` is checked because `resolveDbPath` prefers it over
 * `FAIRJUDGE_DB_PATH`: a guard that validates one variable while the connection
 * factory reads another is not a guard.
 *
 * Exported for the test that proves each refusal fires. Pure apart from the two
 * filesystem lookups, and it never opens anything.
 */
export function resolveSandboxTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env.FAIRJUDGE_DB_PATH;
  if (raw === undefined || raw.trim() === "") {
    die(
      "FAIRJUDGE_DB_PATH is not set.\n" +
        "  This tool never picks its own database. Point it at a working file:\n" +
        "    FAIRJUDGE_DB_PATH=data/fairjudge-demo.db npm run fairjudge -- case:status",
    );
  }

  if (env.DATABASE_URL !== undefined) {
    die(
      "DATABASE_URL is set, and it outranks FAIRJUDGE_DB_PATH in resolveDbPath().\n" +
        "  Unset it so the path you asked for is the path that gets written.",
    );
  }

  const target = resolve(raw.trim());
  const live = resolve(PROJECT_ROOT, DEFAULT_DB_PATH);

  if (target === live || isSameFile(target, live)) {
    die(
      `refusing to run against the live database (${live}).\n` +
        "  End-to-end verification never runs there (CLAUDE.md, Verification rule).\n" +
        "  Copy it to a temp path and point FAIRJUDGE_DB_PATH at the copy.",
    );
  }

  return target;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

function out(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** One `field<TAB>value` line per entry. Null and undefined print empty. */
function printRecord(fields: readonly (readonly [string, unknown])[]): void {
  for (const [key, value] of fields) {
    out(`${key}\t${value === null || value === undefined ? "" : String(value)}`);
  }
}

/** One row per line, tab-separated. No header — the help text names the columns. */
function printRow(cells: readonly unknown[]): void {
  out(cells.map((cell) => (cell === null || cell === undefined ? "" : String(cell))).join("\t"));
}

/** Collapse a verbatim record to one line so a list stays one row per item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Args {
  /** Bare arguments, in order. */
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(body, true);
    } else {
      flags.set(body, next);
      i += 1;
    }
  }

  return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(args: Args, name: string): boolean {
  return args.flags.has(name);
}

function requireFlag(args: Args, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.trim() === "") {
    die(`--${name} is required.`);
  }
  return value;
}

/** `--x TEXT` or `--x-file PATH`, whichever was given. Exactly one is required. */
function textOrFile(args: Args, name: string): string {
  const inline = flag(args, name);
  const file = flag(args, `${name}-file`);
  if (inline !== undefined && file !== undefined) {
    die(`--${name} and --${name}-file are mutually exclusive.`);
  }
  if (inline !== undefined) return inline;
  if (file !== undefined) return readFileSync(resolve(file), "utf8");
  die(`--${name} or --${name}-file is required.`);
}

/** The case to act on: `--case`, else the newest one in this database. */
function resolveCaseId(db: Db, args: Args): string {
  const explicit = flag(args, "case");
  if (explicit !== undefined) return explicit;
  const fallback = resolveDefaultCaseId(db);
  if (fallback === null) {
    die("this database holds no cases, and no --case was given.");
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Commands — cases                                                           */
/* -------------------------------------------------------------------------- */

function caseCreate(db: Db, args: Args): void {
  // `validateCaseInput` is the app's own validator and its copy is written for
  // the person who hit it — on a form, where the three answers are radio
  // buttons they can see. On a command line nothing shows them, so "Choose one
  // of the three answers" is a refusal that cannot be complied with. The
  // server's sentence is kept and the answers are added after it, read from
  // `CLIENT_INTENTS` so the list cannot drift from the column's vocabulary.
  let validated;
  try {
    validated = validateCaseInput({
      title: requireFlag(args, "title"),
      intent: requireFlag(args, "intent"),
      clientName: requireFlag(args, "client"),
      counterpartyName: requireFlag(args, "counterparty"),
      account: textOrFile(args, "account"),
    });
  } catch (error) {
    if (error instanceof CaseCreationError && error.code === "unknown_intent") {
      die(`${error.message} --intent is one of: ${CLIENT_INTENTS.join(", ")}.`);
    }
    throw error;
  }

  const created = createCase(db, {
    title: validated.title,
    intent: validated.intent,
    clientName: validated.clientName,
    counterpartyName: validated.counterpartyName,
    account: validated.lines.join("\n"),
    isFixture: boolFlag(args, "fixture"),
  });

  printRecord([
    ["case_id", created.caseId],
    ["client_participant_id", created.clientParticipantId],
    ["counterparty_participant_id", created.counterpartyParticipantId],
    ["evidence_id", created.evidenceId],
    ["utterances", created.utteranceIds.length],
  ]);
}

function caseStatus(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const row = listCases(db).find((item) => item.id === caseId);
  if (row === undefined) die(`No case with id ${caseId}.`);

  const facts = collectCaseFacts(db, caseId);
  const level = readOutputLevel(db, caseId);
  const upcoming = nextStage(row.stage);

  printRecord([
    ["case_id", row.id],
    ["title", row.title === null ? "" : oneLine(row.title)],
    ["stage", row.stage],
    ["next_stage", upcoming ?? ""],
    ["status", row.status],
    ["is_fixture", row.isFixture],
    ["output_level_locked", row.outputLevel ?? ""],
    ["output_level_derives_now", level.decision.level],
    ["output_level_stale", level.stale],
    ["utterances_total", facts.utterances.total],
    ["utterances_confirmed", facts.utterances.confirmed],
    ["evidence_total", facts.evidence.total],
    ["evidence_graded", facts.evidence.graded],
    ["clarification_rounds", facts.clarification.rounds],
    ["issues_pending", facts.issues.pending],
    ["adverse_facts_pending", facts.adverseFacts.pending],
    ["judgments_final", facts.judgments.final],
  ]);

  // Columns: blocker_requirement_id, satisfied, blocker text.
  for (const requirement of blockersForNextStage(facts)) {
    printRow(["blocker", requirement.id, oneLine(requirement.blocker)]);
  }
}

/* -------------------------------------------------------------------------- */
/* Commands — evidence and utterances                                         */
/* -------------------------------------------------------------------------- */

/**
 * Register a pasted transcript as the client's own material.
 *
 * There used to be an `evidence:add-text` here, and it was `submitStatement` —
 * the counterparty's written statement — because that was the only server
 * function turning free text into evidence plus pending utterances. It was the
 * wrong one, and the acceptance walkthrough showed how wrong: a two-sided chat
 * log pasted by one operator was attributed wholly to the other party, wrote a
 * consent event in her name, flipped `participation_state` to
 * `written_response`, and `level:derive --lock` then locked **L1** — the
 * fault-allocating level — on a case where nobody had asked her anything. In the
 * web app that function is reachable only through the consent-gated respond
 * flow; the CLI had it bare.
 *
 * So the counterparty's statement is not on this surface at all. This command is
 * `addTranscriptEvidence`, which owns the material to the client, attributes
 * nothing to anybody, and does not touch `participation_state` — see that
 * module's header. Attribution is a separate, human act: `utterance:set`.
 */
function evidenceAddTranscript(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const file = flag(args, "file");
  if (file === undefined) {
    die(
      "usage: evidence:add-transcript --file <txt> [--case ID] " +
        `[--source ${TRANSCRIPT_SOURCES.join("|")}]`,
    );
  }

  const source = flag(args, "source");
  if (source !== undefined && !isTranscriptSource(source)) {
    die(
      `--source ${source} is not one of the two answers: ` +
        `${TRANSCRIPT_SOURCES.join(", ")}. "typed" is a transcript somebody ` +
        `wrote out (a recollection); "export" is one the app produced (an ` +
        `original record). The grade follows from which it is.`,
    );
  }

  const added = addTranscriptEvidence(db, {
    caseId,
    text: readFileSync(resolve(file), "utf8"),
    ...(source === undefined ? {} : { source }),
  });

  printRecord([
    ["evidence_id", added.evidenceId],
    ["source_type", added.sourceType],
    ["grade_suggested", added.gradeSuggested],
    // NULL by design — a human signs the grade off in the workbench.
    ["grade_final", ""],
    ["grade_rationale", added.gradeRationale],
    ["utterances", added.lines.length],
    ["client_attributed_lines", added.unattributedLines],
  ]);
  // Columns: speaker, slot, the prefix as pasted, how many lines carried it.
  // The slot is what went into the row; the prefix is reported here and stored
  // nowhere, because `speaker_label` egresses (HARD RULE #3).
  for (const speaker of added.speakers) {
    printRow(["speaker", speaker.slot, speaker.parsed, speaker.lines]);
  }
  for (const line of added.lines) printRow(["utterance", line.utteranceId]);
}

/**
 * Register a screenshot: the same intake the upload route runs, so the same
 * local Swift Vision OCR (`tools/ocr/fairjudge-ocr`, built by `npm run
 * build:ocr`) clusters the bubbles and seeds one pending utterance per block.
 *
 * The anomaly check is off. It is the one part of intake that calls a model, and
 * a CLI subcommand that silently spent money and put a case on the wire would be
 * a surprise; `--anomaly-check` asks for it explicitly.
 */
async function evidenceOcr(db: Db, args: Args): Promise<void> {
  const caseId = resolveCaseId(db, args);
  const image = args.positional[0];
  if (image === undefined) die("usage: evidence:ocr <image> [--case ID]");

  const path = resolve(image);
  const result = await ingestEvidenceUpload(
    { caseId, bytes: readFileSync(path), filename: path.split("/").pop() ?? null },
    { db, checkAnomaly: boolFlag(args, "anomaly-check") },
  );

  printRecord([
    ["evidence_id", result.evidenceId],
    ["file_id", result.fileId],
    ["sha256", result.sha256],
    ["duplicate", result.duplicate],
    ["source_type", result.sourceType],
    ["grade_suggested", result.gradeSuggested ?? ""],
    ["grade_final", result.gradeFinal ?? ""],
    ["utterances", result.utteranceCount],
    ["ocr_error", result.ocrError ?? ""],
  ]);
}

/** Columns: utterance_id, evidence_id, confirm_status, speaker, text. */
function utteranceList(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const pendingOnly = boolFlag(args, "pending");

  for (const item of listEvidence(db, caseId)) {
    for (const utterance of listEvidenceUtterances(db, item.id)) {
      if (pendingOnly && utterance.confirmStatus !== "pending") continue;
      printRow([
        utterance.id,
        utterance.evidenceId,
        utterance.confirmStatus,
        utterance.speakerLabel ?? "",
        // Verbatim evidence, only rewrapped onto one line so the row stays a
        // row. Never translated, never normalized (CLAUDE.md).
        oneLine(utterance.text),
      ]);
    }
  }
}

/**
 * The workbench is keyed by (evidenceId, utteranceId) — it re-reads the parent
 * to prove ownership. The CLI is given one id, so it looks up the other rather
 * than asking the operator to know it.
 */
function requireUtteranceRef(
  db: Db,
  utteranceId: string,
): { evidenceId: string; utteranceId: string } {
  const row = db
    .select({ evidenceId: utterances.evidenceId })
    .from(utterances)
    .where(eq(utterances.id, utteranceId))
    .get();
  if (row === undefined) die(`No utterance with id ${utteranceId}.`);
  if (row.evidenceId === null) {
    die(`Utterance ${utteranceId} is not attached to any evidence row.`);
  }
  return { evidenceId: row.evidenceId, utteranceId };
}

function utteranceConfirm(db: Db, args: Args): void {
  const utteranceId = args.positional[0];
  if (utteranceId === undefined) die("usage: utterance:confirm <utterance-id>");

  const confirmed = confirmUtterance(db, requireUtteranceRef(db, utteranceId));
  printRecord([
    ["utterance_id", confirmed.id],
    ["confirm_status", confirmed.confirmStatus],
    ["text", oneLine(confirmed.text)],
  ]);
}

/**
 * Say who spoke a line, and whether it is a retelling.
 *
 * `updateUtteranceAttributes` is the workbench function the transcription screen
 * calls, and its rules come with it: a `rejected` row takes no writes, and an
 * attribution names a party to THIS case or it is refused. Crucially it leaves
 * `confirm_status` where it is — labelling a line and standing behind its text
 * are two different acts, and this command performs only the first. That is why
 * the confirm status is printed back: an edit here does not launder a pending
 * line into a citable one (HARD RULE #1), and the output says so.
 *
 * `--speaker` takes whatever names a party: their participant id, their
 * pseudonym, their role, or their display name. `timestamp` marks the line as
 * "not speech" — a clock reading rather than something somebody said.
 */
function utteranceSet(db: Db, args: Args): void {
  const utteranceId = args.positional[0];
  if (utteranceId === undefined) {
    die(
      "usage: utterance:set <utterance-id> [--speaker ID|PSEUDONYM|ROLE|timestamp] " +
        "[--retold true|false]",
    );
  }

  const ref = requireUtteranceRef(db, utteranceId);
  const speakerArg = flag(args, "speaker");
  const retoldArg = flag(args, "retold");
  if (speakerArg === undefined && retoldArg === undefined) {
    die("utterance:set needs --speaker, --retold, or both.");
  }

  let isRetold: boolean | undefined;
  if (retoldArg !== undefined) {
    if (retoldArg !== "true" && retoldArg !== "false") {
      die(`--retold takes true or false, not "${retoldArg}".`);
    }
    isRetold = retoldArg === "true";
  }

  const updated = updateUtteranceAttributes(db, {
    ...ref,
    ...(isRetold === undefined ? {} : { isRetold }),
    ...(speakerArg === undefined
      ? {}
      : { speaker: resolveSpeakerArg(db, ref.utteranceId, speakerArg) }),
  });

  printRecord([
    ["utterance_id", updated.id],
    ["speaker_label", updated.speakerLabel ?? ""],
    ["is_retold", updated.isRetold],
    // Unchanged by this command, and printed so that is visible.
    ["confirm_status", updated.confirmStatus],
    ["text", oneLine(updated.text)],
  ]);
}

/** Turn whatever the operator typed into the attribution the workbench takes. */
function resolveSpeakerArg(
  db: Db,
  utteranceId: string,
  value: string,
): SpeakerAssignment {
  if (value === "timestamp") return { kind: "timestamp" };

  const row = db
    .select({ caseId: utterances.caseId })
    .from(utterances)
    .where(eq(utterances.id, utteranceId))
    .get()!;

  const parties = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      role: caseParticipants.role,
      displayName: caseParticipants.displayName,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, row.caseId))
    .all();

  const match = parties.find(
    (party) =>
      party.id === value ||
      party.pseudonym === value ||
      party.role === value ||
      party.displayName === value,
  );
  if (match === undefined) {
    die(
      `--speaker ${value} names nobody on this case. Parties: ` +
        `${parties
          .map((party) => `${party.role}=${party.id} (${party.pseudonym})`)
          .join(", ")}. "timestamp" marks a line as not speech.`,
    );
  }
  return { kind: "participant", participantId: match.id };
}

/* -------------------------------------------------------------------------- */
/* Commands — pipeline                                                        */
/* -------------------------------------------------------------------------- */

function stageAdvance(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const facts = collectCaseFacts(db, caseId);
  const target = (flag(args, "to") ?? nextStage(facts.stage)) as CaseStage | null;
  if (target === null) {
    die(`Case ${caseId} is at ${facts.stage}; there is no stage after it.`);
  }

  // `advanceStage` throws `StageMachineError` with the unmet requirements on it.
  // The message and each blocker are already written for a person to read, so
  // they are printed as-is — see the module note on not rewording refusals.
  const outcome = advanceStage(db, caseId, target);
  printRecord([
    ["case_id", outcome.caseId],
    ["from", outcome.from],
    ["to", outcome.to],
    ["entered_at", outcome.enteredAt.toISOString()],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Commands — stage ④, the timeline                                           */
/* -------------------------------------------------------------------------- */

/**
 * A date, and how precisely it is actually known.
 *
 * `--date 2026-08-14` is a day, `--date 2026-08` a month, and a full ISO
 * timestamp is exact. The precision is read off the shape of what was typed
 * rather than asked for separately, because the two can then never disagree —
 * and `occurred_precision` is not decoration: it is what `formatOccurred`
 * renders and what tells a reader how much weight the ordering carries.
 */
function parseOccurred(value: string): { at: Date; precision: Exclude<OccurredPrecision, "unknown"> } {
  const text = value.trim();
  const shapes: readonly [RegExp, Exclude<OccurredPrecision, "unknown">, string][] = [
    [/^\d{4}-\d{2}$/, "month", `${text}-01T00:00:00Z`],
    [/^\d{4}-\d{2}-\d{2}$/, "day", `${text}T00:00:00Z`],
    [/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, "exact", text.replace(" ", "T")],
  ];

  for (const [shape, precision, iso] of shapes) {
    if (!shape.test(text)) continue;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) break;
    return { at, precision };
  }

  die(
    `--date ${value} is not a date this can place. Give a month ` +
      `(2026-08), a day (2026-08-14) or an exact time ` +
      `(2026-08-14T19:00:00Z) — the shape is how precisely it is known, and ` +
      `that precision is stored (${OCCURRED_PRECISIONS.join(", ")}).`,
  );
}

/** The case an event belongs to, so a placement reads back off the right board. */
function requireEventCase(db: Db, eventId: string): string {
  const row = db
    .select({ caseId: events.caseId })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (row === undefined) die(`No event with id ${eventId}.`);
  return row.caseId;
}

/**
 * Both lists: what is on the mainline, and what is still waiting for a date.
 *
 * Columns: list, event_id, precision, date, title. The two lists are printed
 * under one command because the stage IS the two of them — an event that is
 * "missing" from the timeline is normally sitting in the undated column, and a
 * surface that showed only the mainline would make that look like data loss.
 */
function timelineList(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const snapshot = loadTimeline(db, caseId);

  printRecord([
    ["case_id", snapshot.caseId ?? ""],
    ["mainline", snapshot.mainline.length],
    ["undated", snapshot.pending.length],
  ]);
  for (const card of snapshot.mainline) {
    printRow(["mainline", card.id, card.precision, card.dateLabel, oneLine(card.title)]);
  }
  for (const card of snapshot.pending) {
    printRow(["undated", card.id, card.precision, card.dateLabel, oneLine(card.title)]);
  }
}

/**
 * Say that something happened.
 *
 * The client's own act, and the one thing stage ④ had no way to perform: the
 * web app's timeline screen reorders events, and until now only the seed
 * scripts could create one. Without a date the event lands in the undated
 * column — which is a real state, not a failure — and `timeline:place` is how it
 * gets out of there.
 */
function timelineAdd(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const title = flag(args, "title");
  if (title === undefined) {
    die(
      "usage: timeline:add --title TEXT [--description TEXT] [--date DATE] " +
        "[--label E1] [--evidence ID[,ID]] [--case ID]\n" +
        "  Without --date the event waits in the undated column until " +
        "timeline:place dates it or drags it in.",
    );
  }

  const date = flag(args, "date");
  const evidence = flag(args, "evidence");
  const created = createEvent(db, {
    caseId,
    title,
    description: flag(args, "description") ?? null,
    label: flag(args, "label") ?? null,
    ...(date === undefined ? {} : { occurred: parseOccurred(date) }),
    ...(evidence === undefined
      ? {}
      : {
          evidenceIds: evidence
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id !== ""),
        }),
  });

  printRecord([
    ["event_id", created.id],
    ["case_id", created.caseId],
    ["order_key", created.orderKey],
    ["precision", created.card.precision],
    ["date", created.card.dateLabel],
    ["in_mainline", created.inMainline],
    ["title", oneLine(created.card.title)],
  ]);
}

/**
 * The two ways onto the mainline, as the state machine's own blocker names
 * them: "either give one a date or drag it in from the undated column".
 *
 * `--date` is the anchor (it happened then) and `--mainline` is the drag (it
 * goes here relative to the others). They are different claims and only the
 * first survives somebody re-sorting the list, so both are offered and neither
 * is implied by the other. `--after` / `--before` name the neighbours a drag
 * lands between, exactly as the dnd-kit board reports them.
 */
function timelinePlace(db: Db, args: Args): void {
  const eventId = args.positional[0];
  if (eventId === undefined) {
    die(
      "usage: timeline:place <event-id> [--date DATE] " +
        "[--mainline | --undated] [--after ID] [--before ID]",
    );
  }

  const date = flag(args, "date");
  const toMainline = boolFlag(args, "mainline");
  const toPending = boolFlag(args, "undated");
  if (date === undefined && !toMainline && !toPending) {
    die(
      "timeline:place needs --date, --mainline or --undated. Nothing else " +
        "moves an event between the two lists: an event is on the mainline " +
        "because it is dated or because you put it there.",
    );
  }
  if (toMainline && toPending) {
    die("--mainline and --undated are opposite answers; give one.");
  }
  if (date !== undefined && toPending) {
    die(
      "--date and --undated contradict each other: a dated event is on the " +
        "mainline by its own dating, and the undated column is where events " +
        "wait precisely because nobody has settled when they happened.",
    );
  }
  // Refused rather than ignored, and refused before anything is written: a
  // neighbour only means something to a drag.
  if (!toMainline && !toPending) {
    for (const name of ["after", "before"]) {
      if (args.flags.has(name)) {
        die(
          `--${name} places an event next to another one, which only happens ` +
            `on a drag. Give --mainline (or --undated) as well, or leave it out.`,
        );
      }
    }
  }

  if (date !== undefined) dateEvent(db, { eventId, occurred: parseOccurred(date) });

  // `moveEvent` refuses to pull a dated event back into the holding area, in
  // its own words — that refusal is the point and is not softened here.
  const outcome =
    toMainline || toPending
      ? moveEvent(db, {
          eventId,
          target: toMainline ? "mainline" : "pending",
          // `MoveEventInput` names the neighbours from the slot's point of
          // view: `beforeId` is the row that comes before this one. So the
          // event the operator asked to land AFTER is that row, and vice versa.
          beforeId: flag(args, "after") ?? null,
          afterId: flag(args, "before") ?? null,
        })
      : null;

  // Read the placement back off the board the page would render, for the case
  // the event actually belongs to — the same lookup `utterance:set` does rather
  // than making the operator know an id they were not given.
  const board = loadTimeline(db, requireEventCase(db, eventId));
  const card = [...board.mainline, ...board.pending].find(
    (item) => item.id === eventId,
  );

  printRecord([
    ["event_id", eventId],
    ["order_key", outcome?.orderKey ?? card?.orderKey ?? ""],
    ["precision", card?.precision ?? ""],
    ["date", card?.dateLabel ?? ""],
    ["in_mainline", outcome?.inMainline ?? card?.inMainline ?? ""],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Commands — the safety screen                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stage ①'s questionnaire: print it blank, or record the answers.
 *
 * Without this command `stage:advance` could never leave `intake` — entering
 * `evidence_intake` requires `safety_screen_recorded`, and nothing on the CLI
 * wrote a screen row. The whole pipeline was gated behind a questionnaire with
 * no way to answer it.
 *
 * `--answers` runs `runIntakeSafetyGate` with `localOnly`, which is the
 * deterministic half: the questions the user answered plus the phrase list over
 * whatever is already confirmed. No model is called, so this command costs
 * nothing and works with no API key — and the screen row it writes is recorded
 * as incomplete (`flagged`) rather than `clear`, in the gate's own words,
 * because half a screen is not a clean screen.
 *
 * When it refuses, HARD RULE #9 takes over: the referral is printed here, from
 * the constants in `safety/resources.ts`, with no model in the loop and nothing
 * to wait for.
 */
async function safetyScreen(db: Db, args: Args): Promise<void> {
  if (boolFlag(args, "template")) {
    printQuestionnaireTemplate();
    return;
  }

  const file = flag(args, "answers");
  if (file === undefined) {
    die(
      "usage: safety:screen --template | safety:screen --answers <file> [--case ID]\n" +
        "  --template prints the blank questionnaire as JSON; fill in each " +
        "question id and pass it back with --answers.",
    );
  }

  const caseId = resolveCaseId(db, args);
  const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    die(`${file} is not a JSON object of question id -> answer.`);
  }

  // Only the ids the questionnaire actually has, and only string answers.
  // Anything else in the file is ignored rather than guessed at — a stale form
  // must not be able to invent a category (`answersToSignals` says the same).
  const raw: Record<string, string> = {};
  const source = parsed as Record<string, unknown>;
  for (const question of SAFETY_QUESTIONS) {
    const value = source[question.id];
    if (typeof value === "string" && value.trim() !== "") {
      raw[question.id] = value;
    }
  }
  if (Object.keys(raw).length === 0) {
    die(
      `${file} answers none of the questionnaire's questions. Keys must be ` +
        `question ids: ${SAFETY_QUESTIONS.map((q) => q.id).join(", ")}.`,
    );
  }

  const result = await runIntakeSafetyGate(db, caseId, buildAnswers(raw), {
    localOnly: true,
  });

  printRecord([
    ["case_id", result.caseId],
    ["decision", result.decision],
    ["outcome", result.outcome],
    ["risk_level", result.riskLevel],
    ["screens_written", result.screens.length],
    ["rationale", oneLine(result.rationale)],
  ]);
  for (const category of result.categories) printRow(["red_flag", category]);

  if (result.decision === "refer") printReferral(db, caseId);
}

/** The questionnaire as a file the operator can fill in and hand back. */
function printQuestionnaireTemplate(): void {
  const template: Record<string, unknown> = {
    _questions: SAFETY_QUESTIONS.map((question) => ({
      id: question.id,
      text: question.text,
      why: question.why,
      answer_with:
        question.kind === "choice"
          ? SAFETY_CHOICES.join(" | ")
          : "free text, in whatever language you like — kept exactly as written",
    })),
  };
  // The answer slots, after the documentation block, so the file reads in the
  // order it is filled. `_questions` is ignored on the way back in.
  for (const question of SAFETY_QUESTIONS) template[question.id] = "";
  out(JSON.stringify(template, null, 2));
}

/**
 * The submitted form as `SafetyAnswer[]`, storing the question text as it was
 * actually asked — the audit value of the row depends on that.
 *
 * `buildSafetyAnswers` does exactly this; it is inlined here only because its
 * signature takes the form's raw record, which is what `raw` already is.
 */
function buildAnswers(raw: Readonly<Record<string, string>>) {
  return SAFETY_QUESTIONS.flatMap((question) => {
    const value = raw[question.id];
    return value === undefined
      ? []
      : [{ id: question.id, question: question.text, answer: value }];
  });
}

/**
 * HARD RULE #9, on this surface: the crisis referral, verbatim from the
 * constants, with zero latency and no model in the loop.
 *
 * Printed rather than summarized. Every line here is copy somebody wrote for
 * exactly this moment, and the hotline numbers are curated by hand — a CLI that
 * abbreviated them would be the one place in the product where the referral is
 * paraphrased.
 */
function printReferral(db: Db, caseId: string): void {
  const level = readOutputLevel(db, caseId);
  out("");
  out(REFERRAL_HEADLINE);
  for (const paragraph of REFERRAL_EXPLANATION) out(paragraph);
  out("");
  out(REFERRAL_RESOURCE_NOTE);
  for (const resource of CRISIS_RESOURCES) {
    printRow([
      "resource",
      REGION_LABELS[resource.region],
      resource.localName === undefined
        ? resource.name
        : `${resource.name} (${resource.localName})`,
      resource.contact,
      resource.hours,
      resource.description,
    ]);
  }
  out("");
  for (const step of REFERRAL_NEXT_STEPS) out(step);
  out("");
  printRecord([
    ["referred", true],
    ["output_level_locked", level.locked ?? ""],
    ["output_level_derives_now", level.decision.level],
  ]);
}

function levelDerive(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const view = boolFlag(args, "lock")
    ? lockOutputLevel(db, caseId)
    : readOutputLevel(db, caseId);

  printRecord([
    ["case_id", caseId],
    ["derives_now", view.decision.level],
    ["reason", view.decision.reason],
    ["locked", view.locked ?? ""],
    ["locked_at", view.lockedAt === null ? "" : view.lockedAt.toISOString()],
    ["stale", view.stale],
    ["rationale", oneLine(view.decision.rationale)],
  ]);
  for (const finding of view.decision.findings) {
    printRow(["finding", finding.code, oneLine(finding.statement)]);
  }
}

/**
 * Publish the two validated layers as the case's judgment.
 *
 * `stage:ingest` validates a layer and persists the CALL — `llm_calls` plus the
 * egress row it answers. It does not persist a judgment, and nothing else on
 * this surface did either, so a case could be driven through both judgment
 * stages and `judgment:show` would still say there is no final judgment. This is
 * the missing step, and it is the same publication path `generateJudgment`
 * takes once its two model calls have returned:
 *
 *   gate → fresh dossier → checkFactLayer → checkSurfaceLayer → draft → freeze.
 *
 * Every one of those is the app's own function. In particular the two checks are
 * re-run here against a dossier assembled NOW, not against whatever the record
 * looked like when the bundle was prepared: a reviewer may have un-confirmed a
 * line in between, and the citation that authorizes publication has to be the
 * one that holds at the moment of the freeze.
 *
 * HARD RULE #6 is `finalize`'s, not this function's: a case whose judgment is
 * already final refuses here with the store's own frozen message, which names
 * the version and points at `createNextVersion`.
 */
function judgmentFinalize(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const factLayer = parseFactLayer(
    JSON.parse(readFileSync(resolve(requireFactLayer(args)), "utf8")),
  );
  const surfaceLayer = parseSurfaceLayer(
    JSON.parse(
      readFileSync(
        resolve(
          flag(args, "surface-layer") ??
            die(
              "--surface-layer is required: the file `stage:ingest --stage " +
                "judgment_narrative --out <file>` wrote. It is the narrative " +
                "half of the judgment, and a judgment is published whole or " +
                "not at all.",
            ),
        ),
        "utf8",
      ),
    ),
  );

  // The gate every judgment entry point calls first, read at the moment of use.
  assertJudgmentAllowed(db, caseId);

  const dossier = assembleJudgmentDossier(db, caseId);
  const factFault = checkFactLayer(
    db,
    caseId,
    dossier.outputLevel,
    dossier,
    factLayer,
  );
  if (factFault !== null) die(`rejected (skeleton): ${factFault.message}`);

  const surfaceFault = checkSurfaceLayer(factLayer, surfaceLayer);
  if (surfaceFault !== null) die(`rejected (narrative): ${surfaceFault.message}`);

  // The provenance this channel can honestly state: no vendor was paid and the
  // surrounding session's model is not this process's to name, which is exactly
  // what `llm_calls` already records for these stages.
  const chain = readJudgmentChain(db, caseId);
  const latest = chain[chain.length - 1];
  const draft =
    latest === undefined
      ? createDraft(db, caseId, {
          model: EXTERNAL_SESSION,
          promptVersion: judgmentNarrativeStage.promptVersion,
          fallbackUsed: false,
          factLayer,
          surfaceLayer,
        })
      : latest.status === "draft"
        ? updateDraft(db, latest.id, { factLayer, surfaceLayer })
        : latest;

  // On a final row this throws `frozen` — the refusal HARD RULE #6 exists for,
  // in the store's own words rather than a second opinion about them.
  const published = finalize(db, draft.id);

  printRecord([
    ["case_id", published.caseId],
    ["judgment_id", published.id],
    ["version", published.version],
    ["status", published.status],
    ["output_level", published.outputLevel],
    ["model", published.model],
    ["prompt_version", published.promptVersion ?? ""],
    ["finalized_at", published.finalizedAt?.toISOString() ?? ""],
  ]);
}

function judgmentShow(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const view = buildJudgmentReadView(db, caseId);
  if (view === null) {
    die(`Case ${caseId} has no final judgment.`);
  }

  printRecord([
    ["case_id", view.caseId],
    ["judgment_id", view.judgmentId],
    ["version", view.provenance.version],
    ["status", view.provenance.status],
    ["level", view.level.level],
    ["model", view.provenance.model],
    ["prompt_version", view.provenance.promptVersion ?? ""],
    ["fallback_used", view.provenance.fallbackUsed],
    ["frozen_at", view.provenance.frozenAt?.toISOString() ?? ""],
  ]);
  // Columns: claim, claim_id, tier, confidence, statement.
  for (const claim of view.claims) {
    printRow(["claim", claim.claimId, claim.tier, claim.confidence, oneLine(claim.statement)]);
  }
  // Columns: section, section_id, kind, audience, heading, text.
  for (const section of view.sections) {
    printRow([
      "section",
      section.sectionId,
      section.kind,
      section.storedAudience,
      oneLine(section.heading),
      oneLine(section.text),
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/* Commands — stage ⑤, clarification and the steelman                         */
/* -------------------------------------------------------------------------- */

/** Read a `--file` written by `stage:ingest --out`, through the stage's schema. */
function readStageOutput<T>(args: Args, parse: (value: unknown) => T, stage: string): T {
  const file = flag(args, "file");
  if (file === undefined) {
    die(
      `--file is required: the file \`stage:ingest --stage ${stage} --out ` +
        `<file>\` wrote. It arrives as a file rather than being re-derived so ` +
        `that what is recorded is the answer the server already validated.`,
    );
  }
  return parse(JSON.parse(readFileSync(resolve(file), "utf8")));
}

/**
 * Every round, its questions and what has been said to each.
 *
 * Columns: question, round_number, question_id, state, question, answer. The
 * question ids (`r1q2`) are what `clarification:answer` takes, and they are
 * minted by the server when the round is opened — printing them is the only way
 * to answer one from here.
 */
function clarificationList(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = readClarification(db, caseId);

  printRecord([
    ["case_id", board.caseId],
    ["rounds_used", board.roundsUsed],
    ["rounds_remaining", board.roundsRemaining],
    ["open_round", board.openRound?.id ?? ""],
    ["can_ask_another", board.canAskAnother],
    // The same predicate the stage machine gates `participation` on.
    ["settled", board.settled],
  ]);
  for (const round of board.rounds) {
    printRow([
      "round",
      round.id,
      round.roundNumber,
      round.open ? "open" : "closed",
      `answered=${round.answered}`,
      `declined=${round.declined}`,
      `saturated=${round.saturated}`,
      `can_proceed=${round.canProceed}`,
    ]);
    for (const question of round.questions) {
      printRow([
        "question",
        round.roundNumber,
        question.id,
        question.declined
          ? "declined"
          : question.answer === null
            ? "open"
            : "answered",
        oneLine(question.question),
        // Verbatim: the client's own words about their own case (CLAUDE.md).
        question.answer === null ? "" : oneLine(question.answer),
      ]);
    }
  }
}

/**
 * Open a round from an ingested `clarification_questions` output.
 *
 * The budget is not this command's: `recordClarificationRound` counts the rounds
 * inside its own write transaction and refuses a fourth, and drops a fourth
 * question, whatever arrives here (HARD RULE #4). `dropped` is printed because
 * a question the cap refused was never written, and an operator who cannot see
 * that would go looking for a question id that does not exist.
 */
function clarificationOpen(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const data = readStageOutput(
    args,
    (value) => clarificationQuestionsSchema.parse(value),
    "clarification_questions",
  );

  const recorded = recordClarificationRound(db, {
    caseId,
    questions: data.questions.map((question) => ({
      question: question.question,
      targetsClaim: question.targets_claim,
      whyNeeded: question.why_needed,
    })),
    canProceed: data.can_proceed,
  });

  printRecord([
    ["round_id", recorded.round.id],
    ["round_number", recorded.round.roundNumber],
    ["asked", recorded.asked],
    ["dropped", recorded.dropped],
    ["can_proceed", recorded.round.canProceed],
    ["open", recorded.round.open],
  ]);
  for (const question of recorded.round.questions) {
    printRow(["question", question.id, oneLine(question.question)]);
  }
}

/**
 * Answer one question, or say you are not answering it.
 *
 * Declining is a first-class answer, not a blank: it settles the question and
 * spends the round, and `ClarificationQuestionView.answer` stays null so that
 * nothing downstream can quote a placeholder as if the client had spoken. That
 * is why `--decline` exists rather than letting an empty `--answer` through —
 * the server refuses an empty answer, in those words.
 */
function clarificationAnswer(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const questionId = args.positional[0];
  if (questionId === undefined) {
    die(
      "usage: clarification:answer <question-id> " +
        "(--answer TEXT | --answer-file FILE | --decline [--note TEXT])\n" +
        "  Question ids come from clarification:list (r1q2 and so on).",
    );
  }

  const board = readClarification(db, caseId);
  const round = board.rounds.find((item) =>
    item.questions.some((question) => question.id === questionId),
  );
  if (round === undefined) {
    die(
      `No question ${questionId} on case ${caseId}. clarification:list prints ` +
        `the ids of every question that has actually been asked.`,
    );
  }

  const declining = boolFlag(args, "decline");
  const view = declining
    ? declineClarificationQuestion(db, {
        caseId,
        roundId: round.id,
        questionId,
        note: flag(args, "note") ?? null,
      })
    : answerClarificationQuestion(db, {
        caseId,
        roundId: round.id,
        questionId,
        answer: textOrFile(args, "answer"),
      });

  const question = view.questions.find((item) => item.id === questionId)!;
  printRecord([
    ["round_id", view.id],
    ["question_id", question.id],
    ["state", question.declined ? "declined" : "answered"],
    ["decline_note", question.declineNote ?? ""],
    ["round_open", view.open],
    ["round_closed_at", view.closedAt?.toISOString() ?? ""],
  ]);
}

/**
 * "This round added nothing new" — the user's call, and the thing that ends the
 * loop before the budget is spent.
 *
 * Without it a case whose round came back `can_proceed: false` would owe two
 * more rounds before `participation` opened, with no way to say that there is
 * nothing left worth asking.
 */
function clarificationSaturate(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = readClarification(db, caseId);
  const roundId = flag(args, "round") ?? board.rounds[board.rounds.length - 1]?.id;
  if (roundId === undefined) {
    die(
      `Case ${caseId} has no clarification round to mark. A round is opened ` +
        `from an ingested clarification_questions answer: clarification:open.`,
    );
  }

  const view = markClarificationSaturated(db, { caseId, roundId });
  printRecord([
    ["round_id", view.id],
    ["round_number", view.roundNumber],
    ["saturated", view.saturated],
    ["round_open", view.open],
    ["clarification_settled", readClarification(db, caseId).settled],
  ]);
}

/** The steelman on file, and whether it has been answered. */
function steelmanShow(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = readSteelman(db, caseId);

  printRecord([
    ["case_id", board.caseId],
    ["steelman_id", board.current?.id ?? ""],
    ["version", board.current?.version ?? ""],
    ["verdict", board.current?.verdict ?? ""],
    ["answered", board.answered],
    ["downgrade_signal", board.downgradeSignal],
    ["downgrade_reason", board.downgradeReason ?? ""],
  ]);
  if (board.current !== null) {
    for (const line of (board.current.humanFinal ?? board.current.aiDraft ?? "").split("\n")) {
      printRow(["text", line]);
    }
  }
}

/** Persist an ingested `steelman` output as the next version on the case. */
function steelmanRecord(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const data = readStageOutput(args, (value) => steelmanSchema.parse(value), "steelman");

  const written = persistSteelman(db, caseId, data);
  if (written.kind === "invalid_refs") die(written.message);

  printRecord([
    ["steelman_id", written.steelman.id],
    ["version", written.steelman.version],
    ["verdict", written.steelman.verdict],
    // `can_produce: false` is a real answer: it is recorded, and it sets the
    // downgrade signal rather than being treated as agreement.
    ["unable", written.kind === "unable"],
    ["unable_reason", written.kind === "unable" ? oneLine(written.reason) : ""],
    ["downgrade_signal", written.board.downgradeSignal],
  ]);
}

/**
 * Answer the steelman: they would recognize themselves in it, they would
 * actually say something else, or you cannot recognize them in any version of
 * it that this record supports.
 *
 * The third answer is not a failure to answer — it is recorded as a downgrade
 * signal, in the machine's own words, which is exactly why the state machine
 * accepts it as a settled verdict.
 */
function steelmanVerdict(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const answers: readonly SteelmanAnswer[] = ["accepted", "rebutted", "unable"];
  const answer = requireFlag(args, "answer");
  if (!(answers as readonly string[]).includes(answer)) {
    die(
      `--answer ${answer} is not one of the three: ${answers.join(", ")}. ` +
        `"unable" says you cannot recognize the other party in any version ` +
        `this record supports — a real answer, recorded as a downgrade signal.`,
    );
  }

  const board = readSteelman(db, caseId);
  if (board.current === null) {
    die(
      `Case ${caseId} has no steelman to answer. It is written by the stage: ` +
        `stage:prepare --stage steelman, then stage:ingest, then ` +
        `steelman:record.`,
    );
  }

  // Required for `rebutted` — the user's own version of what the other party
  // would say — and refused as empty by the server when it is missing.
  const hasText = args.flags.has("text") || args.flags.has("text-file");
  const text = hasText ? textOrFile(args, "text") : undefined;
  const view = recordSteelmanVerdict(db, {
    caseId,
    steelmanId: board.current.id,
    answer: answer as SteelmanAnswer,
    ...(text === undefined ? {} : { text }),
  });

  printRecord([
    ["steelman_id", view.id],
    ["version", view.version],
    ["verdict", view.verdict],
    ["confirm_status", view.confirmStatus],
    ["verdict_at", view.verdictAt?.toISOString() ?? ""],
    ["downgrade_signal", readSteelman(db, caseId).downgradeSignal],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Commands — stage ⑥, participation                                          */
/* -------------------------------------------------------------------------- */

/**
 * Record what happened when the other party was asked.
 *
 * This is the client's report about the other person, which is what the app's
 * participation screen records too — and it is on this surface for the same
 * reason the counterparty's own statement is NOT: this says what the client
 * knows about whether she was reached, while `submitStatement` would speak in
 * her name. `pending` is not offered, because un-answering is not an answer;
 * `scripts/purge-operator-answers.ts` is the repair for a state somebody without
 * standing entered.
 */
function participationSet(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const state = requireFlag(args, "state");
  if (!(PARTICIPATION_ANSWERS as readonly string[]).includes(state)) {
    die(
      `--state ${state} is not one of the five answers.\n` +
        PARTICIPATION_ANSWERS.map(
          (answer) => `  ${answer}: ${PARTICIPATION_META[answer].meaning}`,
        ).join("\n"),
    );
  }

  const board = setCounterpartyParticipation(db, caseId, state as ParticipationAnswer);
  printRecord([
    ["case_id", board.caseId],
    ["counterparty_participant_id", board.counterparty?.id ?? ""],
    ["participation_state", board.counterparty?.participationState ?? ""],
    ["invited", board.counterparty?.invited ?? ""],
    ["settled", board.settled],
  ]);
}

/** Both parties, and whether the participation question is settled. */
function participationShow(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = readParticipation(db, caseId);

  printRecord([
    ["case_id", board.caseId],
    ["settled", board.settled],
  ]);
  for (const party of [board.submitter, board.counterparty]) {
    if (party === null) continue;
    printRow([
      "party",
      party.id,
      party.role,
      party.pseudonym,
      party.isSubmitter ? "submitter" : "counterparty",
      party.participationState,
      `invited=${party.invited}`,
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/* Commands — stage ⑦, the three issue lists                                  */
/* -------------------------------------------------------------------------- */

/** Columns: issue, issue_id, category, confirm_status, statement. */
function issueList(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = listIssues(db, caseId);

  printRecord([
    ["case_id", caseId],
    ["total", board.total],
    ["pending", board.pending],
  ]);
  for (const list of board.lists) {
    for (const item of list.items) {
      printRow([
        "issue",
        item.id,
        item.category,
        item.confirmStatus,
        oneLine(item.humanFinal ?? item.aiDraft ?? ""),
      ]);
    }
  }
}

/** Persist an ingested `issue_fixing` output as this case's three lists. */
function issueRecord(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const data = readStageOutput(
    args,
    (value) => issueFixingSchema.parse(value),
    "issue_fixing",
  );

  const written = persistIssues(db, caseId, data);
  if (written.kind === "invalid_refs") die(written.message);

  printRecord([
    ["case_id", caseId],
    ["created", written.created],
    // Rows a reviewer had already confirmed, rewritten or dropped are kept: a
    // second opinion does not erase a first decision.
    ["replaced_pending_drafts", written.replaced],
    ["total", written.board.total],
    ["pending", written.board.pending],
  ]);
  for (const list of written.board.lists) {
    for (const item of list.items) {
      printRow(["issue", item.id, item.category, oneLine(item.aiDraft ?? "")]);
    }
  }
}

/**
 * The reviewer's three answers to one item, as the screen offers them: accept
 * it as drafted, rewrite it in your own words, or drop it.
 *
 * Dropping is terminal in the server, and that refusal is left where it is.
 */
function issueReview(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const issueId = args.positional[0];
  if (issueId === undefined) {
    die("usage: issue:review <issue-id> (--confirm | --edit TEXT | --drop)");
  }

  const edit = flag(args, "edit");
  const chosen = [boolFlag(args, "confirm"), edit !== undefined, boolFlag(args, "drop")]
    .filter(Boolean).length;
  if (chosen !== 1) {
    die(
      "issue:review takes exactly one of --confirm, --edit TEXT or --drop. " +
        "Accepting an item, rewriting it and dropping it are three different " +
        "decisions about it.",
    );
  }

  const item = boolFlag(args, "confirm")
    ? confirmIssue(db, { caseId, issueId })
    : edit !== undefined
      ? editIssue(db, { caseId, issueId, text: edit })
      : rejectIssue(db, { caseId, issueId });

  printRecord([
    ["issue_id", item.id],
    ["category", item.category],
    ["confirm_status", item.confirmStatus],
    ["statement", oneLine(item.humanFinal ?? item.aiDraft ?? "")],
    ["pending", listIssues(db, caseId).pending],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Commands — stage ⑧, the pre-judgment confrontation                         */
/* -------------------------------------------------------------------------- */

/** Columns: fact, adverse_fact_id, ack_status, note, statement. */
function adverseList(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const board = listAdverseFacts(db, caseId);

  printRecord([
    ["case_id", caseId],
    ["total", board.counts.total],
    ["pending", board.counts.pending],
    ["acknowledged", board.acknowledged],
    ["contested", board.contested],
    ["judgment_allowed", board.gate.open],
    ["gate_reason", board.gate.open ? "" : oneLine(board.gate.reason)],
  ]);
  for (const item of board.items) {
    printRow([
      "fact",
      item.id,
      item.ackStatus,
      item.ackNote === null ? "" : oneLine(item.ackNote),
      oneLine(item.humanFinal ?? item.aiDraft ?? ""),
    ]);
  }
}

/**
 * Put an ingested `adverse_facts` output in front of the client, pending.
 *
 * Every item lands `ack_status = 'pending'`, which is what shuts the judgment
 * gate until each one has been answered. Items the client has already answered
 * survive a re-run — an acknowledgement is part of the record.
 */
function adverseRecord(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const data = readStageOutput(
    args,
    (value) => adverseFactsSchema.parse(value),
    "adverse_facts",
  );

  const written = persistAdverseFacts(db, caseId, data);
  if (written.kind === "invalid_refs") die(written.message);

  printRecord([
    ["case_id", caseId],
    ["created", written.created],
    ["replaced_unanswered", written.replaced],
    ["total", written.board.counts.total],
    ["pending", written.board.counts.pending],
    ["judgment_allowed", written.board.gate.open],
  ]);
  for (const item of written.board.items) {
    printRow(["fact", item.id, item.ackStatus, oneLine(item.aiDraft ?? "")]);
  }
}

/**
 * The client's answer to one adverse fact: acknowledge it, or contest it and
 * say why.
 *
 * A contest without a reason is refused by the server, in its own words —
 * contesting is a position, and an empty one would clear the gate without
 * engaging with it, which is the exact thing this stage exists to prevent.
 */
function adverseAnswer(db: Db, args: Args): void {
  const caseId = resolveCaseId(db, args);
  const adverseFactId = args.positional[0];
  if (adverseFactId === undefined) {
    die(
      "usage: adverse:answer <adverse-fact-id> " +
        "(--acknowledge [--note TEXT] | --contest --note TEXT)",
    );
  }

  const acknowledging = boolFlag(args, "acknowledge");
  const contesting = boolFlag(args, "contest");
  if (acknowledging === contesting) {
    die(
      "adverse:answer takes --acknowledge or --contest, not both and not " +
        "neither. Each fact is answered one way or the other before judgment " +
        "runs.",
    );
  }

  const note = flag(args, "note");
  const item = acknowledging
    ? acknowledgeAdverseFact(db, { caseId, adverseFactId, note: note ?? null })
    : contestAdverseFact(db, { caseId, adverseFactId, note: note ?? "" });

  const board = listAdverseFacts(db, caseId);
  printRecord([
    ["adverse_fact_id", item.id],
    ["ack_status", item.ackStatus],
    // The client's own words, verbatim.
    ["ack_note", item.ackNote === null ? "" : oneLine(item.ackNote)],
    ["acked_at", item.ackedAt?.toISOString() ?? ""],
    ["pending", board.counts.pending],
    ["judgment_allowed", board.gate.open],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Commands — the external-session channel                                    */
/* -------------------------------------------------------------------------- */

/** Which stages this channel can drive, and what each needs to be given. */
const EXTERNAL_STAGES = [
  "translate_default",
  "translate_deep",
  "clarification_questions",
  "steelman",
  "issue_fixing",
  "adverse_facts",
  "judgment_skeleton",
  "judgment_narrative",
] as const;
type ExternalStageName = (typeof EXTERNAL_STAGES)[number];

/**
 * Flags that mean something for one stage and nothing for another.
 *
 * `stage:prepare --stage translate_default --fact-layer x` used to be accepted
 * and ignored, which is the shape of bug the walkthrough found with `--case`: a
 * flag that is read by the command but not by the stage looks obeyed and is
 * not. Every stage's inputs are listed here, and anything a stage does not read
 * is refused by name.
 */
const STAGE_INPUT_FLAGS: Readonly<Record<ExternalStageName, readonly string[]>> = {
  translate_default: ["text", "text-file"],
  translate_deep: ["text", "text-file"],
  clarification_questions: [],
  steelman: [],
  issue_fixing: [],
  adverse_facts: [],
  judgment_skeleton: [],
  judgment_narrative: ["fact-layer"],
};

/** Every stage input flag, whichever stage owns it. */
const ALL_STAGE_INPUT_FLAGS = [
  ...new Set(Object.values(STAGE_INPUT_FLAGS).flat()),
];

function assertStageFlags(args: Args, stage: ExternalStageName): void {
  const applicable = STAGE_INPUT_FLAGS[stage];
  const inapplicable = ALL_STAGE_INPUT_FLAGS.filter(
    (name) => args.flags.has(name) && !applicable.includes(name),
  );
  if (inapplicable.length > 0) {
    die(
      `--${inapplicable[0]} means nothing to stage ${stage}, and a flag that ` +
        `is accepted and ignored is worse than one that is refused. ` +
        `${stage} takes ` +
        `${applicable.length === 0 ? "no input flag — it is assembled from the case record" : applicable.map((name) => `--${name}`).join(" or ")}.`,
    );
  }
}

function requireStageName(args: Args): ExternalStageName {
  const name = requireFlag(args, "stage");
  if (!(EXTERNAL_STAGES as readonly string[]).includes(name)) {
    die(
      `--stage ${name} is not one this channel drives. Known: ` +
        `${EXTERNAL_STAGES.join(", ")}.`,
    );
  }
  return name as ExternalStageName;
}

/** A stage selector plus the input the API path would have assembled. */
interface StageCall {
  readonly selector: string | StageDescriptor;
  readonly input: {
    prompt: string;
    caseId?: string | null;
    /** The case's person dictionary — HARD RULE #3. See `buildStageCall`. */
    dict?: ReturnType<typeof buildCaseDict>;
  };
  /** Present for the stages whose caller runs checks after `zod.parse`. */
  readonly check?: (data: never) => { ok: true } | { ok: false; message: string };
}

/**
 * The fact layer file, or a refusal that says which file and how to make
 * another one.
 *
 * `--fact-layer is required` was true and useless: it named a flag, not the
 * artifact, and the artifact is a specific file written by a specific earlier
 * command. Somebody who has lost it needs to know that re-running the skeleton
 * is how it comes back, and that answering the same bundle twice is not.
 */
function requireFactLayer(args: Args): string {
  const value = flag(args, "fact-layer");
  if (value === undefined || value.trim() === "") {
    die(
      "--fact-layer is required: the file `stage:ingest --stage " +
        "judgment_skeleton --out <file>` wrote. It is the frozen skeleton the " +
        "narrative is written from, and it arrives as a file rather than being " +
        "re-derived so that a claim the narrative never received is a claim it " +
        "cannot ground.\n" +
        "  Lost it? Re-run stage:prepare --stage judgment_skeleton --out " +
        "<bundle>, answer the bundle, then stage:ingest --stage " +
        "judgment_skeleton --file <answer> --out <fact-layer>.",
    );
  }
  return value;
}

function buildStageCall(db: Db, args: Args, stage: ExternalStageName): StageCall {
  assertStageFlags(args, stage);

  switch (stage) {
    case "translate_default":
    case "translate_deep": {
      // HARD RULE #3, and the hole the walkthrough went through: this branch
      // used to hand `prepareRequest` a prompt and nothing else. An omitted
      // `dict` is not a smaller dictionary — it is `new EgressPipeline([])`,
      // which substitutes nothing, so every registered party's real name went
      // into the bundle exactly as typed. The unregistered-name check still
      // fired (it needs no dictionary to recognize a name), which is why the
      // channel looked guarded while the substitution half of the rule was not
      // running at all.
      //
      // The case is resolved the same way every other command resolves it, and
      // it is also what makes `--case` mean something here rather than being
      // read and dropped.
      const caseId = resolveCaseId(db, args);
      return {
        selector: stage,
        input: {
          prompt: textOrFile(args, "text"),
          caseId,
          dict: buildCaseDict(db, caseId),
        },
      };
    }

    case "clarification_questions": {
      const caseId = resolveCaseId(db, args);
      // The round this would be: `recordClarificationRound` is what actually
      // spends the budget, but the prompt says which round it is, so the number
      // has to be the one the round would carry.
      const board = readClarification(db, caseId);
      if (board.openRound !== null) {
        die(
          `Round ${board.openRound.roundNumber} is still waiting for answers. ` +
            `The next round is written from them — clarification:answer.`,
        );
      }
      const { prompt, file } = buildClarificationPrompt(
        db,
        caseId,
        board.roundsUsed + 1,
      );
      if (file.utterances.length === 0) {
        die(
          "Nothing in this case has been confirmed yet, so there is no record " +
            "to ask questions about. Confirm the transcription first.",
        );
      }
      return {
        selector: clarificationQuestionsStage,
        input: { prompt, caseId, dict: buildCaseDict(db, caseId) },
      };
    }

    case "steelman": {
      const caseId = resolveCaseId(db, args);
      const { prompt, file } = buildSteelmanPrompt(db, caseId);
      if (file.utterances.length === 0) die(NO_STEELMAN_MATERIAL);
      return {
        selector: steelmanStage,
        input: { prompt, caseId, dict: buildCaseDict(db, caseId) },
      };
    }

    case "issue_fixing":
    case "adverse_facts": {
      const caseId = resolveCaseId(db, args);
      const { prompt, brief } =
        stage === "issue_fixing"
          ? buildIssueFixingPrompt(db, caseId)
          : buildAdverseFactsPrompt(db, caseId);
      if (brief.utterances.length === 0) die(NO_CITABLE_MATERIAL);
      return {
        selector: stage === "issue_fixing" ? issueFixingStage : adverseFactsStage,
        input: { prompt, caseId, dict: buildCaseDict(db, caseId) },
      };
    }

    case "judgment_skeleton": {
      const caseId = resolveCaseId(db, args);
      // The dossier fetch, unchanged: `assembleJudgmentDossier` is the same
      // confirmed-material-only, byte-stable document `runJudgmentSkeleton`
      // reads, and the level block comes from `renderLevelTask`.
      const dossier = assembleJudgmentDossier(db, caseId);
      return {
        selector: judgmentSkeletonStage,
        input: {
          prompt:
            `${serializeJudgmentDossier(dossier)}\n\n${SKELETON_TASK}\n\n` +
            `${renderLevelTask(dossier.outputLevel)}`,
          caseId,
          // HARD RULE #3, and the one thing this file used to leave out. Every
          // caller on the API path hands `runStage` the case dictionary
          // (`runJudgmentSkeleton` does it on the line after the dossier); an
          // omitted `dict` is not a smaller dictionary, it is `new
          // EgressPipeline([])` — no substitution at all — and the bundle then
          // carries both parties' real names out of the process in clear.
          dict: buildCaseDict(db, caseId),
        },
        check: (data) => {
          const rejection = checkFactLayer(
            db,
            caseId,
            dossier.outputLevel,
            dossier,
            data,
          );
          return rejection === null
            ? { ok: true }
            : { ok: false, message: rejection.message };
        },
      };
    }

    case "judgment_narrative": {
      const caseId = resolveCaseId(db, args);
      // The frozen skeleton, and nothing else. `runJudgmentNarrative` hands the
      // second call the fact layer alone so a claim it did not receive is a
      // claim it cannot ground; the same holds here, which is why the fact
      // layer arrives as a file rather than being re-derived from the record.
      const raw = readFileSync(resolve(requireFactLayer(args)), "utf8");
      const factLayer = parseFactLayer(JSON.parse(raw));
      const level = readOutputLevel(db, caseId);
      const locked = level.locked;
      if (locked === null) {
        die(
          `Case ${caseId} has no locked output level. The level is derived in ` +
            `code and locked before a judgment is written: level:derive --lock.`,
        );
      }
      return {
        selector: judgmentNarrativeStage,
        input: {
          prompt: renderNarrativePrompt(locked, factLayer),
          caseId,
          dict: buildCaseDict(db, caseId),
        },
        check: (data) => {
          const rejection = checkSurfaceLayer(factLayer, data);
          return rejection === null
            ? { ok: true }
            : { ok: false, message: rejection.message };
        },
      };
    }
  }
}

function stagePrepare(db: Db, args: Args): void {
  const stage = requireStageName(args);
  const outPath = resolve(requireFlag(args, "out"));
  const call = buildStageCall(db, args, stage);

  // `--reopen` is passed through rather than acted on here: one open question
  // per payload is the ledger's rule, and `prepareStage` is the door that
  // enforces it for every caller.
  const outcome = prepareStage(
    call.selector as never,
    call.input,
    { db, reopen: boolFlag(args, "reopen") },
  );
  if (outcome.kind !== "ok") die(outcome.message);

  writeFileSync(outPath, `${outcome.json}\n`, "utf8");
  printRecord([
    ["stage", outcome.bundle.stage],
    ["case_id", outcome.bundle.case_id ?? ""],
    ["prompt_version", outcome.bundle.prompt_version],
    ["manifest_ids", outcome.bundle.manifest.ids.length],
    ["manifest_hash", outcome.bundle.manifest_hash],
    ["egress_id", outcome.egressId],
    ["out", outPath],
  ]);
}

function stageIngest(db: Db, args: Args): void {
  const stage = requireStageName(args);
  const candidate = readFileSync(resolve(requireFlag(args, "file")), "utf8");
  const call = buildStageCall(db, args, stage);

  const result = ingestStage(call.selector as never, call.input, candidate, {
    db,
    check: call.check as never,
  });

  if (result.kind === "rejected") {
    die(`rejected (${result.code}): ${result.message}`);
  }
  if (result.kind !== "ok") die(result.message);

  printRecord([
    ["stage", stage],
    ["llm_call_id", result.llmCallId],
    ["egress_id", result.egressId],
    ["manifest_hash", result.manifestHash],
  ]);

  // The validated output, so the next stage can be fed from it. This is not a
  // convenience: `judgment_narrative` is handed the fact layer as a FILE, and
  // the only file that holds the accepted one is this one. Written to `--out`
  // when asked and printed otherwise, because a skeleton that only ever went to
  // a terminal is a skeleton that has to be re-heard to get back.
  const json = `${JSON.stringify(result.data, null, 2)}\n`;
  const outPath = flag(args, "out");
  if (outPath === undefined) out(json.trimEnd());
  else {
    writeFileSync(resolve(outPath), json, "utf8");
    printRecord([["out", resolve(outPath)]]);
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

const USAGE = `fairjudge — command surface over the case pipeline

  FAIRJUDGE_DB_PATH must be set, and must not be the live database.

  case:create        --title T --intent I --client N --counterparty N
                     (--account TEXT | --account-file F) [--fixture]
                     --intent: ${CLIENT_INTENTS.join(" | ")}
  case:status        [--case ID]
  safety:screen      --template | --answers FILE [--case ID]
                     --template prints the blank questionnaire as JSON; fill in
                     each question id and hand it back with --answers. Recording
                     a screen is what satisfies safety_screen_recorded, so
                     stage:advance cannot leave intake until this has run. No
                     model is called; a red flag prints the crisis referral.
  evidence:add-transcript
                     --file TXT [--case ID] [--source ${TRANSCRIPT_SOURCES.join("|")}]
                     Registers a pasted chat log as the client's own material.
                     "Speaker:" prefixes become numbered slots for a human to
                     attribute with utterance:set — this command attributes
                     nothing to the other party and never touches
                     participation_state. The counterparty's own statement is
                     not on this surface: it goes through the consent-gated
                     respond flow in the app.
  evidence:ocr       <image> [--case ID] [--anomaly-check]
  utterance:list     [--case ID] [--pending]
                     columns: utterance_id evidence_id confirm_status speaker text
  utterance:confirm  <utterance-id>
  utterance:set      <utterance-id> [--speaker ID|PSEUDONYM|ROLE|timestamp]
                     [--retold true|false]
                     Labels a line. Leaves confirm_status alone — labelling and
                     standing behind the text are two acts.
  stage:advance      [--case ID] [--to STAGE]
  timeline:list      [--case ID]
                     columns: list event_id precision date title. The undated
                     column is printed too — an event missing from the mainline
                     is normally waiting there, not gone.
  timeline:add       --title T [--description T] [--date DATE] [--label E1]
                     [--evidence ID[,ID]] [--case ID]
                     --date is a month (2026-08), a day (2026-08-14) or an
                     exact time; the shape is the stored precision. Without one
                     the event waits in the undated column.
  timeline:place     <event-id> [--date DATE] [--mainline | --undated]
                     [--after ID] [--before ID]
                     The two ways onto the mainline: date it, or drag it in.
                     A dated event cannot be pushed back to the undated column.
  clarification:list [--case ID]
                     Every round and question, with the ids that
                     clarification:answer takes.
  clarification:open --file FILE [--case ID]
                     Opens a round from an ingested clarification_questions
                     answer. HARD RULE #4 is the server's: a fourth round is
                     refused and a fourth question is dropped.
  clarification:answer
                     <question-id> (--answer T | --answer-file F |
                     --decline [--note T]) [--case ID]
                     Declining is an answer: it settles the question and is
                     never read downstream as something the client said.
  clarification:saturate
                     [--round ID] [--case ID]
                     "This round added nothing new" — ends the loop early.
  steelman:show      [--case ID]
  steelman:record    --file FILE [--case ID]
                     Persists an ingested steelman answer as the next version.
                     can_produce:false is recorded, with its downgrade signal.
  steelman:verdict   --answer accepted|rebutted|unable [--text T|--text-file F]
                     [--case ID]
                     --text is the client's own version, required to rebut.
  participation:show [--case ID]
  participation:set  --state ${PARTICIPATION_ANSWERS.join("|")} [--case ID]
                     The client's report about whether the other party was
                     reached. Her own acts stay behind the respond flow.
  issue:list         [--case ID]
  issue:record       --file FILE [--case ID]
                     Persists an ingested issue_fixing answer as the three
                     lists. Items already reviewed survive a re-run.
  issue:review       <issue-id> (--confirm | --edit TEXT | --drop) [--case ID]
  adverse:list       [--case ID]
  adverse:record     --file FILE [--case ID]
                     Puts an ingested adverse_facts answer in front of you,
                     pending — which is what shuts the judgment gate.
  adverse:answer     <adverse-fact-id> (--acknowledge [--note T] |
                     --contest --note T) [--case ID]
  level:derive       [--case ID] [--lock]
                     Reads what the record derives; --lock writes it onto the
                     case. stage:prepare --stage judgment_narrative refuses
                     until it is locked, and so does judgment:finalize.
  stage:prepare      --stage NAME --out FILE [--case ID]
                     [--text TEXT | --text-file F] [--fact-layer FILE]
                     [--reopen]
                     One open bundle per payload: preparing an identical one
                     while the first is unanswered is refused, because an
                     answer is matched to its bundle by that payload alone.
                     --reopen emits a second copy deliberately.
  stage:ingest       --stage NAME --file FILE [--case ID]
                     [--text TEXT | --text-file F] [--fact-layer FILE]
                     [--out FILE]
                     The same stage inputs prepare took — the assembly is
                     re-run so the answer is checked against the request that
                     produced it, so translate ingest needs its --text back.
                     --out keeps the validated output. Keep the skeleton's:
                     narrative ingest needs it via --fact-layer, and so does
                     judgment:finalize.
  judgment:finalize  --fact-layer FILE --surface-layer FILE [--case ID]
                     Publishes the two ingested layers as the judgment: same
                     validators, same freeze. A finalized judgment is frozen;
                     re-hearing it is createNextVersion, not a second finalize.
  judgment:show      [--case ID]

  stages driven by prepare/ingest: ${EXTERNAL_STAGES.join(", ")}
  Every one of them binds the case's person dictionary before a byte is
  written out (HARD RULE #3), the translate pair included — which is why they
  resolve a case like every other command, and why the bundle names it.`;

type Command = (db: Db, args: Args) => void | Promise<void>;

/**
 * One command: what runs it, and every flag it reads.
 *
 * The flag list is not documentation — it is enforced in `main`, and it exists
 * because the walkthrough passed `stage:prepare --case <id>` to a command that
 * read the flag nowhere and printed an empty `case_id` for it. A flag that is
 * silently ignored is worse than one that is refused: the operator believes the
 * thing they asked for happened. So anything not listed here is refused by name,
 * and a stage that does not read one of its command's flags refuses too
 * (`assertStageFlags`).
 */
interface CommandSpec {
  readonly run: Command;
  readonly flags: readonly string[];
}

/** Almost every command acts on a case, and takes `--case` to say which. */
const CASE_FLAG = ["case"] as const;

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  "case:create": {
    run: caseCreate,
    flags: [
      "title",
      "intent",
      "client",
      "counterparty",
      "account",
      "account-file",
      "fixture",
    ],
  },
  "case:status": { run: caseStatus, flags: [...CASE_FLAG] },
  "safety:screen": {
    run: safetyScreen,
    flags: [...CASE_FLAG, "template", "answers"],
  },
  "evidence:add-transcript": {
    run: evidenceAddTranscript,
    flags: [...CASE_FLAG, "file", "source"],
  },
  "evidence:ocr": { run: evidenceOcr, flags: [...CASE_FLAG, "anomaly-check"] },
  "utterance:list": { run: utteranceList, flags: [...CASE_FLAG, "pending"] },
  "utterance:confirm": { run: utteranceConfirm, flags: [] },
  "utterance:set": { run: utteranceSet, flags: ["speaker", "retold"] },
  "stage:advance": { run: stageAdvance, flags: [...CASE_FLAG, "to"] },
  "timeline:list": { run: timelineList, flags: [...CASE_FLAG] },
  "timeline:add": {
    run: timelineAdd,
    flags: [...CASE_FLAG, "title", "description", "date", "label", "evidence"],
  },
  "timeline:place": {
    run: timelinePlace,
    flags: [...CASE_FLAG, "date", "mainline", "undated", "after", "before"],
  },
  "clarification:list": { run: clarificationList, flags: [...CASE_FLAG] },
  "clarification:open": { run: clarificationOpen, flags: [...CASE_FLAG, "file"] },
  "clarification:answer": {
    run: clarificationAnswer,
    flags: [...CASE_FLAG, "answer", "answer-file", "decline", "note"],
  },
  "clarification:saturate": {
    run: clarificationSaturate,
    flags: [...CASE_FLAG, "round"],
  },
  "steelman:show": { run: steelmanShow, flags: [...CASE_FLAG] },
  "steelman:record": { run: steelmanRecord, flags: [...CASE_FLAG, "file"] },
  "steelman:verdict": {
    run: steelmanVerdict,
    flags: [...CASE_FLAG, "answer", "text", "text-file"],
  },
  "participation:show": { run: participationShow, flags: [...CASE_FLAG] },
  "participation:set": { run: participationSet, flags: [...CASE_FLAG, "state"] },
  "issue:list": { run: issueList, flags: [...CASE_FLAG] },
  "issue:record": { run: issueRecord, flags: [...CASE_FLAG, "file"] },
  "issue:review": {
    run: issueReview,
    flags: [...CASE_FLAG, "confirm", "edit", "drop"],
  },
  "adverse:list": { run: adverseList, flags: [...CASE_FLAG] },
  "adverse:record": { run: adverseRecord, flags: [...CASE_FLAG, "file"] },
  "adverse:answer": {
    run: adverseAnswer,
    flags: [...CASE_FLAG, "acknowledge", "contest", "note"],
  },
  "level:derive": { run: levelDerive, flags: [...CASE_FLAG, "lock"] },
  "stage:prepare": {
    run: stagePrepare,
    flags: [...CASE_FLAG, "stage", "out", "reopen", ...ALL_STAGE_INPUT_FLAGS],
  },
  "stage:ingest": {
    run: stageIngest,
    flags: [...CASE_FLAG, "stage", "file", "out", ...ALL_STAGE_INPUT_FLAGS],
  },
  "judgment:finalize": {
    run: judgmentFinalize,
    flags: [...CASE_FLAG, "fact-layer", "surface-layer"],
  },
  "judgment:show": { run: judgmentShow, flags: [...CASE_FLAG] },
};

/** Refuse a flag this command does not read. See `CommandSpec`. */
function assertKnownFlags(name: string, spec: CommandSpec, args: Args): void {
  const unknown = [...args.flags.keys()].filter(
    (given) => !spec.flags.includes(given),
  );
  if (unknown.length === 0) return;

  die(
    `--${unknown[0]} is not a flag ${name} reads, so it would have been ` +
      `accepted and ignored.\n  ${name} takes: ` +
      `${spec.flags.length === 0 ? "no flags" : spec.flags.map((f) => `--${f}`).join(", ")}.`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "help") {
    out(USAGE);
    return name === undefined ? 1 : 0;
  }

  const spec = COMMANDS[name];
  if (spec === undefined) {
    process.stderr.write(`fairjudge: unknown command "${name}"\n\n${USAGE}\n`);
    return 1;
  }

  const target = resolveSandboxTarget();
  loadEnvLocal();
  // `runMigrations` looks for `drizzle/` relative to the working directory. The
  // target path is already absolute, so moving after resolving it cannot
  // redirect the connection.
  process.chdir(PROJECT_ROOT);

  const args = parseArgs(rest);
  assertKnownFlags(name, spec, args);

  const { db, sqlite } = createDb(target);
  try {
    runMigrations(db);
    await spec.run(db, args);
    return 0;
  } finally {
    sqlite.close();
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Server errors are printed as the server phrased them. `StageMachineError`
    // carries the unmet requirements, and each blocker is a sentence somebody
    // wrote for exactly this moment — so it is printed, not summarized.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fairjudge: ${message}\n`);
    const unmet = (error as { unmet?: { id: string; blocker: string }[] }).unmet;
    if (Array.isArray(unmet)) {
      for (const requirement of unmet) {
        process.stderr.write(`  ${requirement.id}: ${requirement.blocker}\n`);
      }
    }
    process.exitCode = 1;
  }
}
