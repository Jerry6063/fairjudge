/**
 * `npm run eval:golden` — the golden-cases harness (SPEC M3 wave B ⑬).
 *
 * Two halves:
 *
 *   1. **Constructed fixtures** (`scripts/golden/fixtures.ts`), each seeded into
 *      an in-memory database and heard with the model answers *recorded* rather
 *      than requested. Deterministic, free, and offline: the Anthropic client is
 *      a local function that returns the fixture's own JSON, so the whole
 *      pipeline runs — level derivation, citation audit, level constraints,
 *      record-basis arithmetic, contract validation, publication, freezing,
 *      both renditions — with the one non-deterministic part replaced by a
 *      value.
 *
 *   2. **The judgments standing in an on-disk database**, read when one is
 *      there. Nothing is generated and nothing is written: each frozen judgment
 *      is re-checked against the record as it stands now. The database this
 *      half reads by default is the fictional demo record
 *      (`data/fairjudge-demo.db`, built by `scripts/seed-fixture.ts`); any
 *      other, a live case record included, is opt-in and explicit via
 *      `FAIRJUDGE_DB_PATH`. With no database at the target this half reports
 *      SKIPPED and the run still passes — a case is data in a local database,
 *      not a fixture in this repository, so requiring one would make the
 *      harness unrunnable everywhere except on the machine holding it.
 *
 * What is asserted, per SPEC ⑬:
 *   - the derived output level matches the fixture's expectation;
 *   - zero citations to unconfirmed or non-existent utterances;
 *   - no responsibility percentage in any rendition;
 *   - nothing said about the character of a party who never spoke in the record
 *     (and motive constructions reported for a human to read — see
 *     `src/server/eval/golden.ts` for why exactly one check is advisory);
 *   - every claim carries a confidence tier and rests on graded evidence.
 *
 * And, since M6 batch 2 put the swap test in front of publication (doc 05 §B),
 * what the hearing DID as well as what it produced: that the blind advocate pair
 * ran at L1 and only at L1, that the record was genuinely heard under both
 * seatings, that the gate reached the disposition the fixture expects, and that
 * the disclosure it composed reached the published document. None of that is
 * legible in a finished judgment — an untested one looks the same — so it is
 * asserted against the calls the replay was asked for rather than inferred from
 * the output. See `checkHearing`.
 *
 * Exit code 1 on any fatal finding, any unexpected outcome, and — just as
 * importantly — on an adversarial fixture that was NOT caught.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

import { createDb, runMigrations, type Db } from "../src/server/db";
import { cases } from "../src/server/db/schema";
import { loadEnvLocal } from "../src/server/env";
import {
  checkJudgment,
  fatal,
  type GoldenFinding,
} from "../src/server/eval/golden";
import {
  computeRecordAsymmetry,
  generateJudgment,
  readCurrentJudgment,
  noticeBasisFor,
  readRenditionView,
  renderSelfReflection,
  renderShareable,
  RenditionError,
  SERVER_LIMITS_SECTION_ID,
  SWAP_LIMITS_HEADING,
  type JudgmentRunOutcome,
  type SurfaceLayer,
  type SwapGateOutcome,
} from "../src/server/judgment";
import { lockOutputLevel, readOutputLevel } from "../src/server/pipeline";
import { FIXTURES, seed, type ExpectedOutcome, type GoldenFixture } from "./golden/fixtures";

/* -------------------------------------------------------------------------- */
/* Replay                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The stages a replayed hearing may ask for.
 *
 * Since M6 batch 2 a hearing is not two calls. At L1 `runGatedHearing` runs the
 * blind advocate pair first, then the skeleton twice — once as filed and once
 * with the parties' positions in the register exchanged — and only then the
 * narrative. A recording that answers two of those five is not a recording of
 * this pipeline, which is precisely what this harness went stale on.
 */
type ReplayStage = "advocate" | "skeleton" | "narrative";

/** One replayed call, and the one thing about its prompt that identifies it. */
interface ReplayCall {
  readonly stage: ReplayStage;
  /** Advocate: the party this seat was told to write for. */
  readonly party: string | null;
  /** Skeleton: the pseudonym this arm's register names as the client. */
  readonly client: string | null;
  /** The recorded answer, serialized. Two seats filing one document is a bug. */
  readonly answer: string;
}

function stageOf(params: unknown): ReplayStage | "other" {
  const system = (params as { system?: unknown }).system;
  const text = typeof system === "string" ? system : JSON.stringify(system);
  if (text.includes("You are one of two advocates")) return "advocate";
  if (text.includes("You are the fact-finding stage")) return "skeleton";
  if (text.includes("You are the drafting stage")) return "narrative";
  return "other";
}

/** The prompt actually sent, which is where a seat and a seating are legible. */
function promptOf(params: unknown): string {
  const messages = (params as { messages?: { content?: unknown }[] }).messages ?? [];
  const first = messages[0]?.content;
  return typeof first === "string" ? first : JSON.stringify(first);
}

/** Which party an advocate seat was handed, read off its own task turn. */
function advocateParty(prompt: string): string | null {
  return /Write the brief for (\S+?)\./.exec(prompt)?.[1] ?? null;
}

/**
 * Which pseudonym this arm's own record-basis block names as the submitter.
 *
 * That single field is what the register exchange moves, so it is how the
 * filed arm and the swapped arm are told apart from the outside — the same way
 * `tests/judgment-swap-gate.test.ts` tells them apart.
 */
function armClient(prompt: string): string | null {
  return /"client_pseudonym"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? null;
}

/**
 * An Anthropic client that answers from a recording.
 *
 * Stages are told apart by their system prompts and seats by their own prompts,
 * exactly as the unit tests do it. Anything else asking for a model here is a
 * bug in the harness, so it throws rather than inventing an answer — a replay
 * that quietly invents the arm it has no recording for is a replay of a hearing
 * that never happened.
 */
function replayClient(
  answer: (stage: ReplayStage, call: ReplayCall) => unknown,
): { client: Anthropic; calls: ReplayCall[] } {
  const calls: ReplayCall[] = [];

  const create = async (params: unknown) => {
    const stage = stageOf(params);
    if (stage === "other") {
      throw new Error("the golden harness has no recording for this stage");
    }
    const prompt = promptOf(params);
    const call: ReplayCall = {
      stage,
      party: stage === "advocate" ? advocateParty(prompt) : null,
      client: stage === "skeleton" ? armClient(prompt) : null,
      answer: "",
    };
    const body = JSON.stringify(answer(stage, call));
    calls.push({ ...call, answer: body });

    return {
      id: "msg_golden",
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "text", text: body }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: null,
      },
      _request_id: "req_golden",
    };
  };

  // The gateway streams a stage whose budget is over the SDK's non-streaming
  // ceiling (`judgment_skeleton` is one), so the recording answers on both
  // transports. `finalMessage()` returns exactly what `create` does.
  const stream = (params: unknown) => ({ finalMessage: () => create(params) });

  return {
    client: {
      messages: { create, stream },
      beta: { messages: { create, stream } },
    } as unknown as Anthropic,
    calls,
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

interface CaseResult {
  readonly id: string;
  readonly what: string;
  readonly failures: readonly string[];
  readonly reviews: readonly GoldenFinding[];
  readonly skipped?: string;
}

function describeOutcome(outcome: JudgmentRunOutcome): string {
  switch (outcome.kind) {
    case "published":
      return `published v${outcome.judgment.version}`;
    case "rejected":
      return `rejected (${outcome.step}: ${outcome.rejection.code})`;
    // The message, not just the word. A bare `error` says a hearing failed and
    // nothing about where, which is a full debugging session for a harness that
    // already knows the answer.
    case "error":
      return `error (${outcome.message})`;
    case "blocked":
    case "no_material":
      return `${outcome.kind} (${outcome.message})`;
    default:
      return outcome.kind;
  }
}

function outcomeMatches(
  outcome: JudgmentRunOutcome,
  expected: ExpectedOutcome,
): boolean {
  if (expected.kind !== outcome.kind) return false;
  if (expected.kind === "rejected" && outcome.kind === "rejected") {
    return outcome.rejection.code === expected.code;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* What the hearing did, as opposed to what it produced                       */
/* -------------------------------------------------------------------------- */

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Hold one replayed hearing to the shape doc 05 §B says it has.
 *
 * None of this is visible in the finished document, which is the reason it is
 * checked here: a judgment published without the pair, without the swap arm, or
 * without the disclosure the gate produced reads exactly like one that had all
 * three. The output is not evidence about the process, so the process is
 * asserted directly — against the calls the replay was actually asked for, and
 * against the section the server writes in code.
 */
function checkHearing(
  fixture: GoldenFixture,
  gate: SwapGateOutcome,
  surface: SurfaceLayer,
  calls: readonly ReplayCall[],
): string[] {
  const expected = fixture.expectHearing;
  if (expected === undefined) return [];
  const failures: string[] = [];

  // --- the blind pair -------------------------------------------------------
  const advocates = calls.filter((call) => call.stage === "advocate");
  const parties = sorted(new Set(advocates.map((call) => call.party ?? "(unnamed)")));
  if (parties.join(",") !== sorted(expected.advocateParties).join(",")) {
    failures.push(
      `advocate seats: expected briefs for [${sorted(expected.advocateParties).join(", ")}], ` +
        `the hearing asked for [${parties.join(", ")}]`,
    );
  }
  // Two seats that filed the same document are one seat billed twice: the
  // comparison the skeleton is asked to make would be between a brief and
  // itself, and it would agree with it. Compared with the party names taken
  // out, because a template with the other seat's name substituted in is that
  // same failure wearing a label — and `checkAdvocateBrief` already rejects the
  // byte-identical case, so a check on the raw strings could never fire.
  const anonymized = new Set(
    advocates.map((call) =>
      parties.reduce((text, party) => text.split(party).join("·"), call.answer),
    ),
  );
  if (advocates.length > 0 && anonymized.size !== advocates.length) {
    failures.push(
      `advocate seats: ${advocates.length} briefs were filed and, with the ` +
        `party names removed, only ${anonymized.size} of them differ — the pair ` +
        `replayed one template twice rather than two independent readings`,
    );
  }

  // --- both seatings --------------------------------------------------------
  const seatings = sorted(
    new Set(
      calls
        .filter((call) => call.stage === "skeleton")
        .map((call) => call.client ?? "(unnamed)"),
    ),
  );
  if (seatings.join(",") !== sorted(expected.skeletonSeatings).join(",")) {
    failures.push(
      `skeleton seatings: expected the record heard with ` +
        `[${sorted(expected.skeletonSeatings).join(", ")}] in the filing chair, ` +
        `it was heard with [${seatings.join(", ")}]`,
    );
  }

  // --- the gate, and what it put in the document ----------------------------
  if (gate.disposition !== expected.gate) {
    failures.push(
      `swap gate: expected ${expected.gate}, got ${gate.disposition} (${gate.reason})`,
    );
  }

  const section = surface.sections.find(
    (item) => item.section_id === SERVER_LIMITS_SECTION_ID,
  );
  if (expected.disclosureContains.length === 0) {
    if (section !== undefined) {
      failures.push(
        `the published document carries a server limits section and this ` +
          `fixture expects none: "${section.text.slice(0, 80)}…"`,
      );
    }
    return failures;
  }
  if (section === undefined) {
    failures.push(
      "the gate's disclosure never reached the published document: it has no " +
        `"${SERVER_LIMITS_SECTION_ID}" section`,
    );
    return failures;
  }
  if (section.heading !== SWAP_LIMITS_HEADING) {
    failures.push(
      `the server limits section is headed "${section.heading}", not ` +
        `"${SWAP_LIMITS_HEADING}"`,
    );
  }
  // `audience: "both"` is the point of the disclosure — a party told nothing
  // about how the document was tested cannot weigh what it says.
  if (section.audience !== "both") {
    failures.push(
      `the gate's disclosure is addressed to "${section.audience}"; both ` +
        `parties are owed the same account of how the document was tested`,
    );
  }
  for (const phrase of expected.disclosureContains) {
    if (!section.text.includes(phrase)) {
      failures.push(
        `the gate's disclosure does not say "${phrase}" — the document is not ` +
          `disclosing what the gate decided`,
      );
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */
/* One constructed fixture                                                    */
/* -------------------------------------------------------------------------- */

async function runFixture(fixture: GoldenFixture): Promise<CaseResult> {
  const { db, sqlite } = createDb(":memory:");
  const failures: string[] = [];
  const reviews: GoldenFinding[] = [];

  try {
    runMigrations(db);
    const seeded = seed(db, fixture.spec);

    // --- the level, derived in code (HARD RULE #2) --------------------------
    const view = readOutputLevel(db, seeded.caseId);
    if (view.decision.level !== fixture.expectLevel) {
      failures.push(
        `output level: expected ${fixture.expectLevel}, derived ` +
          `${view.decision.level} (${view.decision.reason})`,
      );
    }
    if (fixture.replay === undefined) {
      return { id: fixture.id, what: fixture.what, failures, reviews };
    }
    lockOutputLevel(db, seeded.caseId);

    // --- the hearing, replayed ---------------------------------------------
    //
    // The whole gated hearing, not just its two model-facing ends: the advocate
    // pair is answered per seat and the skeleton per seating, so the swap pass
    // runs on a recording of a second hearing rather than on a re-read of the
    // first one.
    const replay = fixture.replay;
    const { client, calls } = replayClient((stage, call) => {
      if (stage === "narrative") return replay.surfaceLayer(seeded);
      if (stage === "skeleton") {
        if (call.client === null) {
          throw new Error(
            "this skeleton prompt names no client in its record basis, so the " +
              "harness cannot tell which seating it is answering",
          );
        }
        return replay.factLayer(seeded, call.client);
      }
      if (replay.advocateBrief === undefined || call.party === null) {
        throw new Error(
          `this hearing ran the advocate pair and the fixture records no brief ` +
            `for ${call.party ?? "an unnamed seat"}`,
        );
      }
      return replay.advocateBrief(seeded, call.party);
    });

    const outcome = await generateJudgment(db, seeded.caseId, {
      llm: { client },
      onProgress: () => {},
    });

    const expected = fixture.expectOutcome ?? { kind: "published" as const };
    if (!outcomeMatches(outcome, expected)) {
      failures.push(
        `outcome: expected ${
          expected.kind === "rejected" ? `rejected/${expected.code}` : expected.kind
        }, got ${describeOutcome(outcome)}`,
      );
    }
    if (outcome.kind !== "published") {
      return { id: fixture.id, what: fixture.what, failures, reviews };
    }

    // --- the invariants, over the frozen judgment ---------------------------
    const judgment = outcome.judgment;
    const surface = judgment.surfaceLayer;
    if (surface === null) {
      failures.push("published judgment has no surface layer");
      return { id: fixture.id, what: fixture.what, failures, reviews };
    }

    // --- what the hearing actually did --------------------------------------
    failures.push(...checkHearing(fixture, outcome.gate, surface, calls));

    const asymmetry = computeRecordAsymmetry(db, seeded.caseId);
    const self = renderSelfReflection(surface);

    // The share GATE, over the fixture's own narrative.
    //
    // Since M4 ① the document the other party receives is a second narrative,
    // generated to her from the frozen fact layer, and this arm has no recording
    // for that stage — the fixtures record a skeleton and a client narrative,
    // and inventing a counterparty narrative for each of them would be the
    // harness grading its own prose. What is still worth running here is the
    // gate itself: `renderShareable` frames a narrative and refuses it for
    // win/lose language, a responsibility percentage or a sentence addressed to
    // the client, and `percentage_in_the_prose` exists to prove it fires. The
    // real counterparty document is checked in the second half of this harness,
    // against the record as it stands.
    let gateText: string | null = null;
    try {
      gateText = renderShareable(surface, {
        level: judgment.outputLevel,
        basis: noticeBasisFor(judgment),
      }).text;
      if (fixture.expectShareRefused === true) {
        failures.push(
          "the share gate passed this narrative; this fixture expects it to " +
            "be refused",
        );
      }
    } catch (error) {
      if (!(error instanceof RenditionError)) throw error;
      if (fixture.expectShareRefused !== true) {
        failures.push(`share gate refused this narrative: ${error.message}`);
      }
    }

    const findings = checkJudgment(
      db,
      seeded.caseId,
      judgment.factLayer,
      [
        { where: "self_reflection", text: self.text },
        ...(gateText === null ? [] : [{ where: "share gate", text: gateText }]),
      ],
      asymmetry.partiesWithoutCitableUtterance,
    );

    reviews.push(...findings.filter((finding) => finding.severity === "review"));

    const expectedChecks = new Set(fixture.expectFindings ?? []);
    for (const finding of fatal(findings)) {
      if (expectedChecks.has(finding.check)) continue;
      failures.push(`[${finding.check} / ${finding.where}] ${finding.detail}`);
    }
    // An adversarial fixture that nothing caught is a worse failure than a
    // violation: it means the check is asleep.
    for (const check of expectedChecks) {
      if (!fatal(findings).some((finding) => finding.check === check)) {
        failures.push(`expected check "${check}" to fire, and it did not`);
      }
    }
  } finally {
    sqlite.close();
  }

  return { id: fixture.id, what: fixture.what, failures, reviews };
}

/* -------------------------------------------------------------------------- */
/* The record as it stands                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The published judgments read from an on-disk database, when one is there.
 *
 * The default is the fictional demo record (`data/fairjudge-demo.db`, built by
 * `scripts/seed-fixture.ts`). Any other database — including a live case
 * record — is opt-in and explicit via `FAIRJUDGE_DB_PATH`. There is no default
 * that reaches a real case: a case is data in a local database, not a fixture
 * in this repository.
 */
const TARGET_DB = resolve(
  process.cwd(),
  process.env.FAIRJUDGE_DB_PATH ?? "data/fairjudge-demo.db",
);

/**
 * Re-check every judgment standing in the target database.
 *
 * Read-only, and deliberately not seeded or generated: the point is to hold the
 * artifact that exists to the invariants as they are today, which is the one
 * check a rule added after a judgment was written can still fail.
 */
function runStoredCases(): CaseResult[] {
  const path = TARGET_DB;
  if (!existsSync(path)) {
    return [
      {
        id: "stored_case",
        what: "the stored judgments, re-checked against the record",
        failures: [],
        reviews: [],
        skipped:
          `no database at ${path} — no case record is in the repository ` +
          `(.gitignore), so this half of the harness has nothing to read ` +
          `(seed the demo: FAIRJUDGE_DB_PATH=data/fairjudge-demo.db npx tsx ` +
          `scripts/seed-fixture.ts)`,
      },
    ];
  }

  loadEnvLocal();
  let db: Db;
  let close: () => void;
  try {
    // Explicit, never the process default: `createDb()` with no argument falls
    // through `DATABASE_URL` to `DEFAULT_DB_PATH`, which is the live record.
    const opened = createDb(path);
    db = opened.db;
    close = () => opened.sqlite.close();
  } catch (error) {
    return [
      {
        id: "stored_case",
        what: "the stored judgments, re-checked against the record",
        failures: [],
        reviews: [],
        skipped: `database present but not readable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }

  const results: CaseResult[] = [];
  try {
    const rows = db.select({ id: cases.id, title: cases.title }).from(cases).all();
    for (const row of rows) {
      const failures: string[] = [];
      const reviews: GoldenFinding[] = [];
      const judgment = readCurrentJudgment(db, row.id);
      if (judgment === null) {
        results.push({
          id: `stored:${row.id.slice(0, 8)}`,
          what: row.title ?? "untitled case",
          failures,
          reviews,
          skipped: "no final judgment on this case yet",
        });
        continue;
      }

      const surface = judgment.surfaceLayer;
      if (surface === null) {
        failures.push("the standing judgment has no surface layer");
      } else {
        const asymmetry = computeRecordAsymmetry(db, row.id);
        const self = renderSelfReflection(surface);

        // The document that would actually be handed to the other party: the
        // counterparty-addressed narrative stored beside this judgment (M4 ①),
        // re-derived and re-gated on the way out. A judgment that has not had
        // one generated yet has no shareable copy at all — that is a missing
        // artifact, not a violated invariant, so it is reported and not failed.
        let shareText: string | null = null;
        try {
          shareText = readRenditionView(db, judgment.id, "shareable").text;
        } catch (error) {
          if (!(error instanceof RenditionError)) throw error;
          if (error.code === "shareable_narrative_missing") {
            reviews.push({
              check: "shareable_narrative_present",
              severity: "review",
              where: "shareable",
              detail:
                `no counterparty-addressed rendition has been generated for ` +
                `this judgment yet, so nothing shareable exists to check ` +
                `(npm run judgment:shareable -- ${judgment.id}).`,
            });
          } else {
            failures.push(`shareable rendition refused: ${error.message}`);
          }
        }

        const findings = checkJudgment(
          db,
          row.id,
          judgment.factLayer,
          [
            { where: "self_reflection", text: self.text },
            ...(shareText === null ? [] : [{ where: "shareable", text: shareText }]),
          ],
          asymmetry.partiesWithoutCitableUtterance,
        );
        reviews.push(...findings.filter((f) => f.severity === "review"));
        for (const finding of fatal(findings)) {
          failures.push(`[${finding.check} / ${finding.where}] ${finding.detail}`);
        }
      }

      results.push({
        id: `stored:${row.id.slice(0, 8)}`,
        what: `${row.title ?? "untitled"} — v${judgment.version}, ${judgment.outputLevel}`,
        failures,
        reviews,
      });
    }
  } finally {
    close();
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("golden cases — replayed fixtures, then the record as it stands\n");

  const results: CaseResult[] = [];
  for (const fixture of FIXTURES) {
    results.push(await runFixture(fixture));
  }
  results.push(...runStoredCases());

  let failed = 0;
  for (const result of results) {
    if (result.skipped !== undefined) {
      console.log(`SKIP  ${result.id.padEnd(30)} ${result.skipped}`);
      continue;
    }
    if (result.failures.length === 0) {
      console.log(`ok    ${result.id.padEnd(30)} ${result.what}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${result.id.padEnd(30)} ${result.what}`);
      for (const failure of result.failures) console.log(`        - ${failure}`);
    }
    for (const review of result.reviews) {
      console.log(`      review [${review.check} / ${review.where}] ${review.detail}`);
    }
  }

  const checked = results.filter((result) => result.skipped === undefined).length;
  const reviews = results.reduce((sum, result) => sum + result.reviews.length, 0);
  console.log(
    `\n${checked - failed}/${checked} cases pass` +
      (reviews > 0
        ? `; ${reviews} sentence(s) flagged for a human to read (not failures)`
        : ""),
  );

  if (failed > 0) process.exitCode = 1;
}

await main();
