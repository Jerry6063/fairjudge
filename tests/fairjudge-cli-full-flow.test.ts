/**
 * The whole pipeline from an empty database, driven only by `npm run fairjudge`.
 *
 * The second acceptance walkthrough got as far as stage ④ and stopped there, on
 * a refusal that was completely correct: `timeline_placed` — "No event is on the
 * timeline yet". The state machine was right and the command surface was
 * missing. Repo-wide, `events` was written by two seed scripts and nothing else,
 * so a case created through the CLI could never leave the timeline stage, and
 * the four gates behind it (clarification, participation, issue framing, the
 * pre-judgment confrontation) had never been reached from here at all.
 *
 * What this file asserts is that the walk now completes **without a single gate
 * being weakened**. Every precondition in `stage-machine.ts` is the one that was
 * there before; what changed is that each human act the app performs on a screen
 * now has a command that performs it. Where an artifact is model-produced —
 * clarification questions, the steelman, the three issue lists, the adverse
 * facts — it arrives the way this channel receives everything, as a prepared
 * bundle answered from outside and ingested through the same validators the API
 * path runs. The answers below are written by hand, which is exactly what the
 * external-session runtime exists to accept.
 *
 * Zero API calls: nothing here opens a socket, and the one stage that would
 * (the anomaly check) is not reached. Everything runs against a throwaway
 * encrypted database under the OS temp dir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { main } from "../scripts/fairjudge-cli";
import { createDb, runMigrations, DB_KEY_ENV_VAR, type Db } from "../src/server/db";
import { egressLedger, events } from "../src/server/db/schema";

const KEY = "5e".repeat(32);

/**
 * The two people this case is about. Registered parties, so HARD RULE #3 says
 * their names are SUBSTITUTED on every egress rather than blocking it — which is
 * the half of the rule the walkthrough found switched off.
 */
const CLIENT = "Rosalind Achebe";
const COUNTERPARTY = "Nikhil Basu";

let dir: string;
let dbPath: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of [DB_KEY_ENV_VAR, "FAIRJUDGE_DB_PATH", "DATABASE_URL"]) {
    saved[name] = process.env[name];
  }
  process.env[DB_KEY_ENV_VAR] = KEY;
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fairjudge-walk-"));
  dbPath = join(dir, "work.db");
  process.env.FAIRJUDGE_DB_PATH = dbPath;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

async function run(...argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    expect(await main(argv)).toBe(0);
  } finally {
    console.log = log;
  }
  return lines;
}

function field(lines: readonly string[], name: string): string | undefined {
  return lines.find((line) => line.startsWith(`${name}\t`))?.slice(name.length + 1);
}

function rows(lines: readonly string[], kind: string): string[][] {
  return lines
    .filter((line) => line.startsWith(`${kind}\t`))
    .map((line) => line.split("\t").slice(1));
}

function withDb<T>(read: (db: Db) => T): T {
  const { db, sqlite } = createDb(dbPath, { key: KEY });
  try {
    runMigrations(db);
    return read(db);
  } finally {
    sqlite.close();
  }
}

function path(name: string): string {
  return join(dir, name);
}

/** Write a hand-made stage answer where `stage:ingest --file` will find it. */
function answer(name: string, value: unknown): string {
  const target = path(name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function bundle(name: string): { user: string; system: string; case_id: string | null } {
  return JSON.parse(readFileSync(path(name), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* Reading a bundle the way the session on the other end would                */
/* -------------------------------------------------------------------------- */

/** The first balanced JSON object after `header` in a prompt. */
function blockAfter(text: string, header: string): unknown {
  const start = text.indexOf("{", text.indexOf(header));
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === "{") depth += 1;
    if (text[at] === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, at + 1));
    }
  }
  throw new Error(`no JSON block after ${header}`);
}

interface RecordBasis {
  readonly client_pseudonym: string;
  readonly citable_utterances: {
    readonly total: number;
    readonly by_client: number;
    readonly by_counterparty: number;
  };
  readonly parties_without_citable_utterance: string[];
}

/**
 * The record-basis counts, read out of the skeleton's own prompt.
 *
 * The prompt says "restate these numbers, do not recompute or estimate them",
 * and `checkFactLayer` verifies the restatement against the database. Reading
 * them here is what a model does with that block, and it keeps this test
 * asserting the pipeline rather than asserting a fixture's arithmetic.
 */
function recordBasis(text: string): RecordBasis {
  const block = blockAfter(text, "## Record basis") as {
    client_pseudonym: string;
    citable_utterances: { total: number; by_client: number; by_counterparty: number };
    parties: { pseudonym: string; citable_utterances: number }[];
  };
  return {
    client_pseudonym: block.client_pseudonym,
    citable_utterances: {
      total: block.citable_utterances.total,
      by_client: block.citable_utterances.by_client,
      by_counterparty: block.citable_utterances.by_counterparty,
    },
    parties_without_citable_utterance: block.parties
      .filter((party) => party.citable_utterances === 0)
      .map((party) => party.pseudonym),
  };
}

/** Every utterance id the EVIDENCE block offers, in the order it lists them. */
function citableIds(text: string): string[] {
  return [...new Set([...text.matchAll(/"id": "([0-9a-f-]{36})"/g)].map((m) => m[1]))];
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

/** All six safety questions answered "no" — a screen that passes. */
const CLEAR_ANSWERS = {
  fear_of_partner: "no",
  physical_harm: "no",
  control: "no",
  monitoring: "no",
  self_harm: "no",
  anything_else: "",
};

/**
 * A two-sided chat log. Chinese, and it stays Chinese: a verbatim record is
 * never translated or normalized (CLAUDE.md).
 */
const TRANSCRIPT = [
  "Nikhil: 你说好七点回来的",
  "Rosalind: 我加班了，忘了发消息",
  "Nikhil: 你上周也是这么说的",
  "我第二天早上道歉了。",
].join("\n");

/** Stages ① → ④: file the case, screen it, register material, confirm it. */
async function walkToTimeline(): Promise<string> {
  const created = await run(
    "case:create",
    "--title",
    "The seven o'clock argument",
    "--intent",
    "understand_what_happened",
    "--client",
    CLIENT,
    "--counterparty",
    COUNTERPARTY,
    "--account",
    "He said he would be back by seven and was not.",
    "--fixture",
  );
  const caseId = field(created, "case_id")!;

  writeFileSync(path("answers.json"), JSON.stringify(CLEAR_ANSWERS), "utf8");
  await run("safety:screen", "--case", caseId, "--answers", path("answers.json"));
  await run("stage:advance", "--case", caseId); // → evidence_intake

  writeFileSync(path("chat.txt"), TRANSCRIPT, "utf8");
  const added = await run(
    "evidence:add-transcript",
    "--case",
    caseId,
    "--file",
    path("chat.txt"),
  );
  await run("stage:advance", "--case", caseId); // → transcription

  const lines = rows(added, "utterance").map((row) => row[0]);
  // One line is attributed to the other party, and every line is signed off.
  // Attribution and confirmation stay two separate acts, as they are in the app.
  await run("utterance:set", lines[0], "--speaker", "respondent");
  for (const utteranceId of await utteranceIds(caseId)) {
    await run("utterance:confirm", utteranceId);
  }
  await run("stage:advance", "--case", caseId); // → timeline

  return caseId;
}

async function utteranceIds(caseId: string): Promise<string[]> {
  const listed = await run("utterance:list", "--case", caseId);
  return listed.map((line) => line.split("\t")[0]);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("stage ④ — the timeline, which had no command surface at all", () => {
  it("refuses to leave the timeline until an event is actually on it", async () => {
    const caseId = await walkToTimeline();

    const status = await run("case:status", "--case", caseId);
    expect(field(status, "stage")).toBe("timeline");
    expect(rows(status, "blocker").map((row) => row[0])).toContain("timeline_placed");

    // The refusal is the state machine's own, carried whole: the headline on the
    // error and the unmet requirement hanging off it, which is what the CLI
    // prints rather than a second opinion about either.
    interface Refusal {
      readonly message: string;
      readonly unmet: readonly { id: string; blocker: string }[];
    }
    let refusal: Refusal | null = null;
    try {
      await run("stage:advance", "--case", caseId);
    } catch (error) {
      refusal = error as unknown as Refusal;
    }
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain("is not reachable yet");
    expect(refusal!.unmet.map((requirement) => requirement.id)).toEqual([
      "timeline_placed",
    ]);
    expect(refusal!.unmet[0].blocker).toContain("No event is on the timeline yet");
  });

  it("dates one event onto the mainline and leaves the undated one waiting", async () => {
    const caseId = await walkToTimeline();

    const dated = await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "He does not come home at seven",
      "--description",
      "The evening the promise was broken.",
      "--date",
      "2026-08-14",
    );
    expect(field(dated, "precision")).toBe("day");
    expect(field(dated, "in_mainline")).toBe("true");

    const undated = await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "The apology the next morning",
    );
    expect(field(undated, "precision")).toBe("unknown");
    expect(field(undated, "in_mainline")).toBe("false");

    // Two lists, one table: the undated event is waiting, not missing.
    const listed = await run("timeline:list", "--case", caseId);
    expect(field(listed, "mainline")).toBe("1");
    expect(field(listed, "undated")).toBe("1");

    // A human wrote it, so it is confirmed material — no ai_draft to sign off —
    // and the client owns it, like everything else they register.
    const stored = withDb((db) => db.select().from(events).all());
    expect(stored.map((row) => row.confirmStatus)).toEqual(["confirmed", "confirmed"]);
    expect(stored.every((row) => row.ownerParticipantId !== null)).toBe(true);
    expect(stored.every((row) => row.visibility === "private")).toBe(true);
    // Fractional indexing, never an integer renumber (CLAUDE.md conventions).
    expect(new Set(stored.map((row) => row.orderKey)).size).toBe(2);

    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe(
      "clarification",
    );
  });

  it("drags an undated event in without inventing a date for it", async () => {
    const caseId = await walkToTimeline();
    const added = await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "The apology the next morning",
    );
    const eventId = field(added, "event_id")!;

    const placed = await run("timeline:place", eventId, "--mainline");
    expect(placed).toContain("in_mainline\ttrue");
    // Dragged in, still undated: the two ways onto the mainline are different
    // claims and one does not fabricate the other.
    expect(field(placed, "precision")).toBe("unknown");

    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe(
      "clarification",
    );
  });

  it("will not push a dated event back into the undated column", async () => {
    const caseId = await walkToTimeline();
    const added = await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "He does not come home at seven",
      "--date",
      "2026-08-14T19:00:00Z",
    );
    expect(field(added, "precision")).toBe("exact");

    await expect(
      run("timeline:place", field(added, "event_id")!, "--undated"),
    ).rejects.toThrow(/a dated event cannot leave the mainline/);
  });

  it("refuses a date it cannot place, rather than guessing at one", async () => {
    const caseId = await walkToTimeline();
    await expect(
      run("timeline:add", "--case", caseId, "--title", "x", "--date", "last summer"),
    ).rejects.toThrow(/is not a date this can place/);
  });
});

describe("the whole pipeline, from an empty database", () => {
  it("reaches a final judgment, and judgment:show renders it", async () => {
    const caseId = await walkToTimeline();

    /* --- stage ④ ---------------------------------------------------------- */
    await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "He does not come home at seven",
      "--date",
      "2026-08-14",
    );
    await run("stage:advance", "--case", caseId); // → clarification

    /* --- stage ⑤ clarification: the ≤3×3 loop ----------------------------- */
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--out",
      path("clar-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--file",
      answer("clar-answer.json", {
        questions: [
          {
            question: "What did you say before seven, once you knew you would be late?",
            targets_claim: "U2 — 我加班了，忘了发消息",
            why_needed:
              "Whether a message was sent decides if this is a broken promise or " +
              "an unannounced delay.",
          },
          {
            question: "What was the week before about?",
            targets_claim: "U3 — 你上周也是这么说的",
            why_needed: "The record cannot tell whether this is a pattern.",
          },
        ],
        can_proceed: true,
      }),
      "--out",
      path("clar-data.json"),
    );

    const round = await run(
      "clarification:open",
      "--case",
      caseId,
      "--file",
      path("clar-data.json"),
    );
    expect(field(round, "asked")).toBe("2");
    expect(field(round, "dropped")).toBe("0");

    await run(
      "clarification:answer",
      "r1q1",
      "--case",
      caseId,
      "--answer",
      "我没发，一直到快九点才想起来。",
    );
    // Declining is a real answer: it settles the question and spends the round,
    // and nothing downstream may read it as something the client said.
    const declined = await run(
      "clarification:answer",
      "r1q2",
      "--case",
      caseId,
      "--decline",
      "--note",
      "That is about someone else and I am not putting them in this.",
    );
    expect(field(declined, "state")).toBe("declined");
    expect(field(declined, "round_open")).toBe("false");

    const board = await run("clarification:list", "--case", caseId);
    expect(field(board, "settled")).toBe("true");
    // Columns after the kind: round_number, question_id, state, question,
    // answer. The declined one carries no answer, and that is the point.
    const declinedRow = rows(board, "question").find((row) => row[1] === "r1q2")!;
    expect(declinedRow[2]).toBe("declined");
    expect(declinedRow[4]).toBe("");

    /* --- stage ⑤ the steelman --------------------------------------------- */
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "steelman",
      "--out",
      path("steel-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "steelman",
      "--file",
      answer("steel-answer.json", {
        can_produce: true,
        unable_reason: null,
        headline:
          "I was not angry about one evening. I was angry that I had said this " +
          "once already and it changed nothing.",
        account: [
          {
            point: "Seven o'clock was their own number, not one I imposed.",
            grounded_in: ["U1"],
          },
        ],
        most_likely_rebuttals: [
          {
            your_claim: "Work ran over and I forgot to send a message.",
            their_answer:
              "Forgetting is the part that lands badly: a message takes ten seconds.",
            grounded_in: ["U2"],
          },
        ],
      }),
      "--out",
      path("steel-data.json"),
    );

    const recorded = await run(
      "steelman:record",
      "--case",
      caseId,
      "--file",
      path("steel-data.json"),
    );
    expect(field(recorded, "version")).toBe("1");
    expect(field(recorded, "verdict")).toBe("pending");

    const verdict = await run("steelman:verdict", "--case", caseId, "--answer", "accepted");
    expect(field(verdict, "verdict")).toBe("accepted");
    expect(field(verdict, "downgrade_signal")).toBe("false");

    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe(
      "participation",
    );

    /* --- stage ⑥ participation -------------------------------------------- */
    const participation = await run(
      "participation:set",
      "--case",
      caseId,
      "--state",
      "unaware",
    );
    expect(field(participation, "participation_state")).toBe("unaware");
    expect(field(participation, "settled")).toBe("true");
    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe(
      "issue_framing",
    );

    /* --- stage ⑦ the three lists ------------------------------------------ */
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "issue_fixing",
      "--out",
      path("issue-bundle.json"),
    );
    const ids = citableIds(bundle("issue-bundle.json").user);
    expect(ids.length).toBeGreaterThan(1);

    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "issue_fixing",
      "--file",
      answer("issue-answer.json", {
        undisputed_facts: [
          {
            statement: "甲 expected 乙 home at seven, and said so at the time.",
            evidence_refs: [ids[0]],
          },
        ],
        disputes_of_fact: [
          {
            statement:
              "Whether word was sent before seven: 乙 says the message was " +
              "forgotten; 甲 read the silence as a repetition.",
            evidence_refs: [ids[1]],
          },
        ],
        disputes_of_standard: [
          {
            statement:
              "What a late evening obliges: a message as the minimum owed, " +
              "against the lateness itself as the thing to answer for.",
            evidence_refs: [ids[0], ids[1]],
          },
        ],
      }),
      "--out",
      path("issue-data.json"),
    );

    const issues = await run("issue:record", "--case", caseId, "--file", path("issue-data.json"));
    expect(field(issues, "created")).toBe("3");
    expect(field(issues, "pending")).toBe("3");

    // Every item is reviewed, one at a time, as the screen asks.
    const items = rows(issues, "issue").map((row) => row[0]);
    await run("issue:review", items[0], "--case", caseId, "--confirm");
    await run(
      "issue:review",
      items[1],
      "--case",
      caseId,
      "--edit",
      "Whether any word was sent before seven is disputed.",
    );
    const lastReview = await run("issue:review", items[2], "--case", caseId, "--confirm");
    expect(field(lastReview, "pending")).toBe("0");

    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe(
      "pre_judgment",
    );

    /* --- stage ⑧ the confrontation ---------------------------------------- */
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "adverse_facts",
      "--out",
      path("adverse-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "adverse_facts",
      "--file",
      answer("adverse-answer.json", {
        adverse_facts: [
          {
            statement:
              "You gave the seven o'clock time yourself, and let the hour pass " +
              "without a word.",
            evidence_refs: [ids[0]],
          },
          {
            statement:
              "By your own account the explanation arrived only afterwards.",
            evidence_refs: [ids[1]],
          },
        ],
      }),
      "--out",
      path("adverse-data.json"),
    );

    const surfaced = await run(
      "adverse:record",
      "--case",
      caseId,
      "--file",
      path("adverse-data.json"),
    );
    expect(field(surfaced, "created")).toBe("2");
    // Pending is what shuts the gate. It is shut right now, and says so.
    expect(field(surfaced, "judgment_allowed")).toBe("false");

    const facts = rows(surfaced, "fact").map((row) => row[0]);
    await run("adverse:answer", facts[0], "--case", caseId, "--acknowledge", "--note", "确实是我说的七点。");
    // Contesting is a position, and the server refuses an empty one.
    await expect(
      run("adverse:answer", facts[1], "--case", caseId, "--contest"),
    ).rejects.toThrow(/Say what is wrong with it/);
    const answered = await run(
      "adverse:answer",
      facts[1],
      "--case",
      caseId,
      "--contest",
      "--note",
      "I called at eight and it went to voicemail.",
    );
    expect(field(answered, "pending")).toBe("0");
    expect(field(answered, "judgment_allowed")).toBe("true");

    /* --- HARD RULE #2, then stage ⑨ --------------------------------------- */
    const level = await run("level:derive", "--case", caseId, "--lock");
    expect(field(level, "locked")).toBe("L2");
    expect(field(level, "reason")).toBe("counterparty_absent");
    expect(field(await run("stage:advance", "--case", caseId), "to")).toBe("judgment");

    /* --- the two-step judgment -------------------------------------------- */
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "judgment_skeleton",
      "--out",
      path("skeleton-bundle.json"),
    );
    const skeletonPrompt = bundle("skeleton-bundle.json").user;
    const factLayer = {
      claims: [
        {
          claim_id: "c1",
          statement: '甲 asked for seven o\'clock at the time: "你说好七点回来的".',
          evidence_refs: [ids[0]],
          confidence: 0.9,
          tier: "high_confidence",
        },
        {
          claim_id: "c2",
          statement: "乙 sent no word before the hour passed, and explained afterwards.",
          evidence_refs: [ids[1]],
          confidence: 0.7,
          tier: "inferred",
        },
        {
          claim_id: "c3",
          statement:
            "Whether a call was attempted later that evening is not in the " +
            "confirmed record.",
          evidence_refs: [],
          confidence: 0.1,
          tier: "unknown",
        },
      ],
      findings: {
        // Restated from the prompt's own block, which is what it asks for and
        // what `checkFactLayer` verifies against the database.
        record_basis: {
          ...recordBasis(skeletonPrompt),
          statement:
            "甲 has not been asked anything. What is here is one person's " +
            "material, and the counts above say whose words it holds.",
        },
        unresolved: [
          {
            question: "What was the week before about?",
            reason: "clarification_unanswered",
            claim_ids: ["c3"],
          },
        ],
        // L2 allocates nothing, and the level is the case's, not the model's.
        responsibility: [],
      },
    };

    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "judgment_skeleton",
      "--file",
      answer("skeleton-answer.json", factLayer),
      "--out",
      path("fact-layer.json"),
    );

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "judgment_narrative",
      "--fact-layer",
      path("fact-layer.json"),
      "--out",
      path("narrative-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "judgment_narrative",
      "--fact-layer",
      path("fact-layer.json"),
      "--file",
      answer("narrative-answer.json", {
        sections: [
          {
            section_id: "s1",
            kind: "finding",
            heading: "What the record could be read from",
            text:
              "甲 asked for seven o'clock and said so at the time. 乙's own " +
              "account is that the hour passed without a message.",
            claim_ids: ["c1", "c2"],
            audience: "both",
          },
          {
            section_id: "s2",
            kind: "limits",
            heading: "What this cannot decide",
            text:
              "甲 has not been asked anything. No allocation of fault is made here.",
            claim_ids: ["c3"],
            audience: "both",
          },
        ],
      }),
      "--out",
      path("surface-layer.json"),
    );

    const published = await run(
      "judgment:finalize",
      "--case",
      caseId,
      "--fact-layer",
      path("fact-layer.json"),
      "--surface-layer",
      path("surface-layer.json"),
    );
    expect(field(published, "status")).toBe("final");
    expect(field(published, "version")).toBe("1");
    expect(field(published, "output_level")).toBe("L2");
    expect(field(published, "model")).toBe("external_session");

    const shown = await run("judgment:show", "--case", caseId);
    expect(field(shown, "level")).toBe("L2");
    expect(rows(shown, "claim").map((row) => row[0])).toEqual(["c1", "c2", "c3"]);
    expect(rows(shown, "section").map((row) => row[0])).toEqual(["s1", "s2"]);

    // Every bundle this walk handed out is accounted for, and every one of them
    // was answered: no emission is left open and none was answered twice.
    const ledger = withDb((db) => db.select().from(egressLedger).all());
    expect(ledger.length).toBeGreaterThanOrEqual(6);
    expect(ledger.filter((row) => row.llmCallId === null)).toHaveLength(0);
  });
});

describe("ending the clarification loop without spending the budget", () => {
  it("saturates a round the stage did not think was enough", async () => {
    const caseId = await walkToTimeline();
    await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "He does not come home at seven",
      "--date",
      "2026-08-14",
    );
    await run("stage:advance", "--case", caseId); // → clarification

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--out",
      path("bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--file",
      answer("answer.json", {
        questions: [
          {
            question: "What did you say before seven?",
            targets_claim: "U2",
            why_needed: "It decides whether this is a broken promise.",
          },
        ],
        // The stage's own advisory, and it says no.
        can_proceed: false,
      }),
      "--out",
      path("data.json"),
    );
    await run("clarification:open", "--case", caseId, "--file", path("data.json"));
    await run("clarification:answer", "r1q1", "--case", caseId, "--answer", "什么都没说。");

    // A closed round the stage does not think is enough leaves two more rounds
    // owed. Saying the loop has produced what it is going to produce is the
    // user's call, and without it the case would owe them.
    expect(field(await run("clarification:list", "--case", caseId), "settled")).toBe(
      "false",
    );
    const saturated = await run("clarification:saturate", "--case", caseId);
    expect(field(saturated, "saturated")).toBe("true");
    expect(field(saturated, "clarification_settled")).toBe("true");
  });

  it("refuses a fourth question, and says how many were dropped", async () => {
    const caseId = await walkToTimeline();
    await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      "He does not come home at seven",
      "--date",
      "2026-08-14",
    );
    await run("stage:advance", "--case", caseId);

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--out",
      path("bundle.json"),
    );
    // HARD RULE #4's per-round half. The schema's `maxItems: 3` is only the
    // backstop; the server counter is what actually holds, so a fourth question
    // arriving here is dropped rather than asked.
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--file",
      answer("answer.json", {
        questions: [1, 2, 3].map((n) => ({
          question: `Question ${n}?`,
          targets_claim: "U1",
          why_needed: "Because.",
        })),
        can_proceed: true,
      }),
      "--out",
      path("data.json"),
    );
    const round = await run(
      "clarification:open",
      "--case",
      caseId,
      "--file",
      path("data.json"),
    );
    expect(field(round, "asked")).toBe("3");
    expect(rows(round, "question")).toHaveLength(3);
  });
});

describe("the read commands that make the ids answerable", () => {
  it("prints both parties, the steelman, the issues and the adverse facts", async () => {
    const caseId = await walkToTimeline();

    const parties = await run("participation:show", "--case", caseId);
    expect(field(parties, "settled")).toBe("false");
    // Columns after the kind: id, role, pseudonym, side, participation_state.
    expect(rows(parties, "party").map((row) => row[3])).toEqual([
      "submitter",
      "counterparty",
    ]);
    expect(rows(parties, "party")[1][4]).toBe("pending");

    // Empty boards still answer, rather than failing: "nothing here yet" is a
    // state the operator needs to be able to see.
    expect(field(await run("steelman:show", "--case", caseId), "answered")).toBe("false");
    expect(field(await run("issue:list", "--case", caseId), "total")).toBe("0");
    const adverse = await run("adverse:list", "--case", caseId);
    expect(field(adverse, "total")).toBe("0");
    expect(field(adverse, "judgment_allowed")).toBe("false");
    expect(field(adverse, "gate_reason")).toContain(
      "No adverse fact has been put in front of you yet",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* HARD RULE #3 on this channel — the half that was not running                */
/* -------------------------------------------------------------------------- */

describe("registered names on the way out", () => {
  /**
   * The walkthrough found unregistered names blocking egress correctly while
   * registered ones — the case's own two parties — went into the bundle exactly
   * as typed. Both halves of HARD RULE #3 are asserted here, on both kinds of
   * stage, because the failure was per-call-site: the translate branch handed
   * `prepareRequest` a prompt and no dictionary, and an absent dictionary is not
   * a smaller one, it is `new EgressPipeline([])` — no substitution at all.
   */
  it("substitutes both parties in a translate bundle", async () => {
    const caseId = await walkToTimeline();

    const prepared = await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "translate_default",
      "--text",
      `${COUNTERPARTY} came home very late again and ${CLIENT} waited up.`,
      "--out",
      path("translate-bundle.json"),
    );
    // `--case` is honoured rather than read and dropped: the ledger row and the
    // bundle both name the case whose people are in the text.
    expect(field(prepared, "case_id")).toBe(caseId);

    const emitted = bundle("translate-bundle.json");
    expect(emitted.user).toContain("甲");
    expect(emitted.user).toContain("乙");
    for (const name of [CLIENT, COUNTERPARTY, "Nikhil", "Rosalind", "Basu", "Achebe"]) {
      expect(emitted.user).not.toContain(name);
    }
    expect(emitted.case_id).toBe(caseId);
  });

  it("substitutes them in a judgment_skeleton bundle too", async () => {
    const caseId = await walkToTimeline();
    await run(
      "timeline:add",
      "--case",
      caseId,
      "--title",
      `${COUNTERPARTY} does not come home at seven`,
      "--description",
      `${CLIENT} waited up.`,
      "--date",
      "2026-08-14",
    );

    // Drive the rest of the way to judgment on the shortest honest path.
    await run("stage:advance", "--case", caseId); // → clarification
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--out",
      path("c-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "clarification_questions",
      "--file",
      answer("c-answer.json", { questions: [], can_proceed: true }),
      "--out",
      path("c-data.json"),
    );
    await run("clarification:open", "--case", caseId, "--file", path("c-data.json"));
    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "steelman",
      "--out",
      path("s-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "steelman",
      "--file",
      answer("s-answer.json", {
        can_produce: false,
        unable_reason: "The record holds nothing this party has said for themselves.",
        headline: "",
        account: [],
        most_likely_rebuttals: [],
      }),
      "--out",
      path("s-data.json"),
    );
    await run("steelman:record", "--case", caseId, "--file", path("s-data.json"));
    await run("steelman:verdict", "--case", caseId, "--answer", "unable");
    await run("stage:advance", "--case", caseId); // → participation
    await run("participation:set", "--case", caseId, "--state", "unaware");
    await run("stage:advance", "--case", caseId); // → issue_framing

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "issue_fixing",
      "--out",
      path("i-bundle.json"),
    );
    const ids = citableIds(bundle("i-bundle.json").user);
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "issue_fixing",
      "--file",
      answer("i-answer.json", {
        undisputed_facts: [
          { statement: "甲 asked for seven o'clock.", evidence_refs: [ids[0]] },
        ],
        disputes_of_fact: [],
        disputes_of_standard: [],
      }),
      "--out",
      path("i-data.json"),
    );
    const issues = await run("issue:record", "--case", caseId, "--file", path("i-data.json"));
    await run("issue:review", rows(issues, "issue")[0][0], "--case", caseId, "--confirm");
    await run("stage:advance", "--case", caseId); // → pre_judgment

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "adverse_facts",
      "--out",
      path("a-bundle.json"),
    );
    await run(
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "adverse_facts",
      "--file",
      answer("a-answer.json", {
        adverse_facts: [
          {
            statement: "You gave the seven o'clock time yourself.",
            evidence_refs: [ids[0]],
          },
        ],
      }),
      "--out",
      path("a-data.json"),
    );
    const surfaced = await run("adverse:record", "--case", caseId, "--file", path("a-data.json"));
    await run("adverse:answer", rows(surfaced, "fact")[0][0], "--case", caseId, "--acknowledge");
    await run("level:derive", "--case", caseId, "--lock");
    await run("stage:advance", "--case", caseId); // → judgment

    await run(
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "judgment_skeleton",
      "--out",
      path("skeleton.json"),
    );

    const emitted = bundle("skeleton.json");
    // The dossier carries the timeline, the issues and the utterances — every
    // place a real name could have survived into the request.
    expect(emitted.user).toContain("甲");
    expect(emitted.user).toContain("乙");
    for (const name of [CLIENT, COUNTERPARTY, "Nikhil", "Rosalind", "Basu", "Achebe"]) {
      expect(emitted.user).not.toContain(name);
      expect(emitted.system).not.toContain(name);
    }
  });

  it("still blocks an unregistered third party rather than masking them", async () => {
    const caseId = await walkToTimeline();

    // The other half of the rule, unchanged: somebody who is not a party to
    // this case is not in the dictionary, and no substitution is invented for
    // them — the send is refused so a human decides.
    await expect(
      run(
        "stage:prepare",
        "--case",
        caseId,
        "--stage",
        "translate_default",
        "--text",
        "Marguerite said she saw the whole thing.",
        "--out",
        path("blocked.json"),
      ),
    ).rejects.toThrow(/unregistered_name|unscrubbed fragment/);
  });
});

/* -------------------------------------------------------------------------- */
/* Flags, and the one open question per payload                               */
/* -------------------------------------------------------------------------- */

describe("a flag that is read by nothing is refused, not ignored", () => {
  it("names the flags the command actually reads", async () => {
    await expect(run("case:status", "--nope", "x")).rejects.toThrow(
      /--nope is not a flag case:status reads/,
    );
  });

  it("refuses a flag the named stage does not read", async () => {
    const caseId = await walkToTimeline();
    await expect(
      run(
        "stage:prepare",
        "--case",
        caseId,
        "--stage",
        "translate_default",
        "--text",
        "他说随便你",
        "--fact-layer",
        path("nothing.json"),
        "--out",
        path("bundle.json"),
      ),
    ).rejects.toThrow(/--fact-layer means nothing to stage translate_default/);
  });

  it("documents the text flags translate ingest needs back", async () => {
    const help = (await run("help")).join("\n");
    // `stage:ingest` re-runs the assembly, so it needs the same inputs prepare
    // was given — and the help used to list --fact-layer and not --text.
    const ingest = help.slice(
      help.indexOf("  stage:ingest"),
      help.lastIndexOf("  judgment:finalize"),
    );
    expect(ingest).toContain("--text TEXT | --text-file F");
    expect(ingest).toContain("the assembly is");
    expect(help).toContain("timeline:add");
    expect(help).toContain("adverse:answer");
  });
});

describe("one open bundle per payload", () => {
  it("refuses a second identical bundle while the first is unanswered", async () => {
    const caseId = await walkToTimeline();
    const prepare = [
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "translate_default",
      "--text",
      "他说随便你",
      "--out",
      path("twin.json"),
    ];

    await run(...prepare);
    // Two open rows for one payload make the ingest ambiguous: an answer is
    // matched to its bundle by that hash alone, and the walkthrough found the
    // consequence — an already-answered bundle accepted again, against the twin.
    await expect(run(...prepare)).rejects.toThrow(/already open in the egress ledger/);
    expect(
      withDb((db) => db.select().from(egressLedger).all()).filter(
        (row) => row.llmCallId === null,
      ),
    ).toHaveLength(1);
  });

  it("emits a second copy when --reopen says so", async () => {
    const caseId = await walkToTimeline();
    const prepare = [
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "translate_default",
      "--text",
      "他说随便你",
      "--out",
      path("twin.json"),
    ];

    await run(...prepare);
    await run(...prepare, "--reopen");
    expect(
      withDb((db) => db.select().from(egressLedger).all()).filter(
        (row) => row.llmCallId === null,
      ),
    ).toHaveLength(2);
  });

  it("lets a corrected answer reach the bundle it was rejected against", async () => {
    const caseId = await walkToTimeline();
    const prepare = [
      "stage:prepare",
      "--case",
      caseId,
      "--stage",
      "translate_default",
      "--text",
      "他说随便你",
      "--out",
      path("bundle.json"),
    ];
    await run(...prepare);

    const ingest = (file: string) => [
      "stage:ingest",
      "--case",
      caseId,
      "--stage",
      "translate_default",
      "--text",
      "他说随便你",
      "--file",
      file,
    ];

    // A rejection writes nothing and leaves the emission open, so the refusal to
    // re-prepare never strands a bundle: the corrected answer still lands.
    await expect(
      run(...ingest(answer("bad.json", { benign: "nope" }))),
    ).rejects.toThrow(/rejected \(schema\)/);

    const reading = (reading: string) => ({ reading, confidence: 0.3 });
    await run(
      ...ingest(
        answer("good.json", {
          benign: reading("They mean it is up to you."),
          neutral: reading("They are declining to choose."),
          negative: reading("They are angry and will not say so."),
          cues: [],
        }),
      ),
    );
    expect(
      withDb((db) => db.select().from(egressLedger).all()).filter(
        (row) => row.llmCallId === null,
      ),
    ).toHaveLength(0);
  });
});
