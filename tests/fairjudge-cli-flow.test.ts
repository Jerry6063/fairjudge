/**
 * The `fairjudge` CLI, driven end to end — and the hole that made it necessary.
 *
 * The acceptance walkthrough pasted a two-sided chat log into
 * `evidence:add-text`, which was `submitStatement`. That call attributes the
 * text wholly to the counterparty, records a consent event in her name and flips
 * `participation_state` to `written_response`; `level:derive --lock` then locked
 * **L1**, the level that allocates fault between two people, on a case where
 * nobody had asked her anything. One operator, one paste, no consent machinery
 * anywhere in it.
 *
 * The command is gone. `evidence:add-transcript` is what replaced it, and the
 * property that matters is asserted below in the only way worth asserting it:
 * not by unit-testing the new server function, but by driving the whole command
 * surface over a two-sided transcript and reading the level off the end of it.
 * A future edit that reintroduces an attribution shortcut fails here.
 *
 * Everything runs against a throwaway encrypted database under the OS temp dir.
 * No model is called: the safety screen runs its deterministic layer only, and
 * nothing in this file opens a socket.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { main } from "../scripts/fairjudge-cli";
import { createDb, runMigrations, DB_KEY_ENV_VAR } from "../src/server/db";
import { caseParticipants, utterances } from "../src/server/db/schema";

/** A throwaway 32-byte key in `openssl rand -hex 32` shape. */
const KEY = "3c".repeat(32);

let dir: string;
let dbPath: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of [DB_KEY_ENV_VAR, "FAIRJUDGE_DB_PATH", "DATABASE_URL"]) {
    saved[name] = process.env[name];
  }
  process.env[DB_KEY_ENV_VAR] = KEY;
  // The CLI refuses to run at all while this is set, because `resolveDbPath`
  // prefers it over the variable the guard checks.
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fairjudge-flow-"));
  dbPath = join(dir, "work.db");
  process.env.FAIRJUDGE_DB_PATH = dbPath;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Running the thing                                                          */
/* -------------------------------------------------------------------------- */

/** One invocation, with stdout captured as lines. */
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

/** The value of a `field<TAB>value` line. */
function field(lines: readonly string[], name: string): string | undefined {
  const found = lines.find((line) => line.startsWith(`${name}\t`));
  return found?.slice(name.length + 1);
}

/** Every row of one kind, as its remaining columns. */
function rows(lines: readonly string[], kind: string): string[][] {
  return lines
    .filter((line) => line.startsWith(`${kind}\t`))
    .map((line) => line.split("\t").slice(1));
}

/** Read the scratch database directly, for the columns no command prints. */
function inspect<T>(read: (db: ReturnType<typeof createDb>["db"]) => T): T {
  const { db, sqlite } = createDb(dbPath, { key: KEY });
  try {
    runMigrations(db);
    return read(db);
  } finally {
    sqlite.close();
  }
}

function file(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** All six questions answered "no" — a screen that passes. */
const CLEAR_ANSWERS = JSON.stringify({
  fear_of_partner: "no",
  physical_harm: "no",
  control: "no",
  monitoring: "no",
  self_harm: "no",
  anything_else: "",
});

async function openCase(): Promise<string> {
  const created = await run(
    "case:create",
    "--title",
    "The seven o'clock argument",
    "--intent",
    "understand_what_happened",
    "--client",
    "Dara Osei",
    "--counterparty",
    "Nikhil Raman",
    "--account",
    "He said he would be back by seven and was not.",
    "--fixture",
  );
  return field(created, "case_id")!;
}

/* -------------------------------------------------------------------------- */
/* The safety screen — stage ① could not be left without it                   */
/* -------------------------------------------------------------------------- */

describe("safety:screen", () => {
  it("prints a questionnaire that can be filled in and handed back", async () => {
    await openCase();

    const template = JSON.parse((await run("safety:screen", "--template")).join("\n"));

    // Documented and fillable in one file: the questions with their own text,
    // and an empty slot per question id.
    expect(template._questions).toHaveLength(6);
    expect(template._questions[0].id).toBe("fear_of_partner");
    expect(template._questions[0].answer_with).toBe("yes | no | unsure");
    expect(template.fear_of_partner).toBe("");
    expect(template.anything_else).toBe("");
  });

  it("records a screen, which is what lets the case leave intake", async () => {
    const caseId = await openCase();

    const before = await run("case:status", "--case", caseId);
    expect(rows(before, "blocker").map((row) => row[0])).toContain(
      "safety_screen_recorded",
    );

    const screened = await run(
      "safety:screen",
      "--case",
      caseId,
      "--answers",
      file("answers.json", CLEAR_ANSWERS),
    );
    expect(field(screened, "decision")).toBe("pass");
    // Not "clear": the model half was not run, and a half screen is recorded as
    // incomplete rather than as a clean one.
    expect(field(screened, "outcome")).toBe("flagged");

    const advanced = await run("stage:advance", "--case", caseId);
    expect(field(advanced, "to")).toBe("evidence_intake");
  });

  it("prints the crisis referral itself when a red flag fires — no model in it", async () => {
    const caseId = await openCase();

    const screened = await run(
      "safety:screen",
      "--case",
      caseId,
      "--answers",
      file(
        "afraid.json",
        JSON.stringify({ ...JSON.parse(CLEAR_ANSWERS), fear_of_partner: "yes" }),
      ),
    );

    expect(field(screened, "decision")).toBe("refer");
    expect(rows(screened, "red_flag").map((row) => row[0])).toContain("fear");
    // The referral copy and the hotlines, verbatim from `safety/resources.ts`.
    expect(screened).toContain("This case has left the judgment pipeline.");
    const resources = rows(screened, "resource");
    expect(resources.some((row) => row.includes("110"))).toBe(true);
    expect(resources.some((row) => row.includes("12338"))).toBe(true);
    // And the state that goes with it.
    expect(field(screened, "referred")).toBe("true");
    expect(field(screened, "output_level_locked")).toBe("refused");

    // A refused case leaves the pipeline entirely, including "harmless" steps.
    await expect(run("stage:advance", "--case", caseId)).rejects.toThrow(
      /stays on the referral path/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The regression: a two-sided paste is not the other party answering          */
/* -------------------------------------------------------------------------- */

describe("evidence:add-transcript", () => {
  /**
   * The transcript is Chinese and stays Chinese — a verbatim record, never
   * translated (CLAUDE.md). Two speakers by prefix, one line with none.
   */
  const TRANSCRIPT = [
    "Nikhil: 你说好七点回来的",
    "Dara: 我加班了，忘了发消息",
    "Nikhil: 你上周也是这么说的",
    "我第二天早上道歉了。",
  ].join("\n");

  async function seedTranscript(): Promise<{
    caseId: string;
    lines: string[];
    added: string[];
  }> {
    const caseId = await openCase();
    await run(
      "safety:screen",
      "--case",
      caseId,
      "--answers",
      file("answers.json", CLEAR_ANSWERS),
    );
    await run("stage:advance", "--case", caseId);

    const added = await run(
      "evidence:add-transcript",
      "--case",
      caseId,
      "--file",
      file("chat.txt", TRANSCRIPT),
    );
    return {
      caseId,
      lines: rows(added, "utterance").map((row) => row[0]),
      added,
    };
  }

  it("is gone as `evidence:add-text` — the counterparty's statement is not on this surface", async () => {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["evidence:add-text", "--text", "anything"])).toBe(1);
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join("")).toContain('unknown command "evidence:add-text"');
  });

  it("stores one pending line per line, owned by the client, attributed to nobody", async () => {
    const { caseId, lines, added } = await seedTranscript();

    expect(lines).toHaveLength(4);
    expect(field(added, "source_type")).toBe("recollection");
    expect(field(added, "grade_suggested")).toBe("B");
    // NULL, as with any registration: a human signs off what kind of artifact
    // this is before it counts towards anything.
    expect(field(added, "grade_final")).toBe("");
    expect(field(added, "client_attributed_lines")).toBe("1");

    // A parsed prefix becomes a numbered slot, reported with the name it came
    // from. The name itself is stored nowhere — `speaker_label` egresses.
    expect(rows(added, "speaker")).toEqual([
      ["speaker_1", "Nikhil", "2"],
      ["speaker_2", "Dara", "1"],
    ]);

    const stored = inspect((db) =>
      db.select().from(utterances).where(eq(utterances.caseId, caseId)).all(),
    );
    expect(stored.every((row) => row.confirmStatus === "pending")).toBe(true);
    expect(stored.every((row) => row.ownerParticipantId !== null)).toBe(true);
    expect(stored.map((row) => row.speakerLabel).filter((l) => l === "甲")).toEqual(
      [],
    );
    // The line is kept exactly as it was pasted, prefix included: parsing is how
    // the speaker is guessed at, not a licence to edit the record.
    expect(stored.map((row) => row.humanFinal)).toContain("Nikhil: 你说好七点回来的");
  });

  it("never touches participation_state", async () => {
    const { caseId } = await seedTranscript();

    const respondent = inspect((db) =>
      db
        .select()
        .from(caseParticipants)
        .where(eq(caseParticipants.caseId, caseId))
        .all()
        .find((party) => !party.isSubmitter),
    );

    // The single fact the old command got wrong. Pasting a log is something the
    // client has; participation is something the other party did.
    expect(respondent?.participationState).toBe("pending");
    expect(respondent?.respondState).toBe("not_started");
  });

  it("derives L2 for a two-sided paste, and cannot be walked into L1", async () => {
    const { caseId, lines } = await seedTranscript();

    await run("stage:advance", "--case", caseId); // → transcription

    // Attribute one of the other party's lines to her, exactly as the workbench
    // would, and confirm it. This is the strongest form of the danger: her words
    // are now in the citable record, spoken by her, signed off.
    const attributed = await run(
      "utterance:set",
      lines[0],
      "--speaker",
      "respondent",
    );
    expect(field(attributed, "speaker_label")).toBe("甲");
    // Labelling is not confirming. The line is still uncitable (HARD RULE #1).
    expect(field(attributed, "confirm_status")).toBe("pending");

    await run("utterance:confirm", lines[0]);
    await run("utterance:confirm", lines[3]);

    const level = await run("level:derive", "--case", caseId, "--lock");

    expect(field(level, "derives_now")).toBe("L2");
    // Named: the other side is not in this record. Her words being in it is not
    // the same fact as her being in it — the level turns on who OWNS confirmed
    // material, which one operator with a paste cannot manufacture.
    expect(field(level, "reason")).toBe("counterparty_absent");
    expect(field(level, "locked")).toBe("L2");
  });

  it("names both answers when --source is not one of them", async () => {
    const caseId = await openCase();
    await expect(
      run(
        "evidence:add-transcript",
        "--case",
        caseId,
        "--file",
        file("chat.txt", TRANSCRIPT),
        "--source",
        "screenshot",
      ),
    ).rejects.toThrow(/typed, export/);
  });

  it("grades an app export as the original record it is", async () => {
    const caseId = await openCase();
    const added = await run(
      "evidence:add-transcript",
      "--case",
      caseId,
      "--file",
      file("chat.txt", TRANSCRIPT),
      "--source",
      "export",
    );
    expect(field(added, "source_type")).toBe("firsthand");
    expect(field(added, "grade_suggested")).toBe("A");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals that have to be actionable                                        */
/* -------------------------------------------------------------------------- */

describe("refusals", () => {
  it("names the three intents when case:create is given another one", async () => {
    await expect(
      run(
        "case:create",
        "--title",
        "x",
        "--intent",
        "win",
        "--client",
        "Dara Osei",
        "--counterparty",
        "Nikhil Raman",
        "--account",
        "something happened",
      ),
    ).rejects.toThrow(
      /understand_what_happened, allocate_fault, prevent_recurrence/,
    );
  });

  it("says which file --fact-layer wants, and how to make another one", async () => {
    const caseId = await openCase();
    await expect(
      run(
        "stage:prepare",
        "--case",
        caseId,
        "--stage",
        "judgment_narrative",
        "--out",
        join(dir, "bundle.json"),
      ),
    ).rejects.toThrow(/stage:ingest --stage judgment_skeleton --out/);
  });

  it("documents --lock and the ingest --out file in its own help", async () => {
    const help = (await run("help")).join("\n");

    expect(help).toContain("--lock writes it onto the");
    expect(help).toContain("narrative ingest needs it via --fact-layer");
    expect(help).toContain("utterance:set");
    expect(help).toContain("safety:screen");
    expect(help).toContain("judgment:finalize");
    expect(help).not.toContain("evidence:add-text");
  });
});
