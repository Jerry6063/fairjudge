/**
 * `judgment:finalize` — the step that was missing between ingest and a judgment.
 *
 * `stage:ingest` validates a returned layer and persists the CALL: an
 * `llm_calls` row linked to the egress row it answers. It does not persist a
 * judgment, and nothing else on the command surface did either, so the
 * acceptance walkthrough could drive both judgment stages successfully and then
 * meet "Case … has no final judgment" from `judgment:show`. The pipeline ended
 * one call short of the thing it exists for.
 *
 * What is asserted here is not that a row appears. It is that the row appears
 * through the app's own publication path — the adverse-fact gate, both contract
 * validators re-run against a dossier assembled at the moment of the freeze, and
 * `finalize` — and that HARD RULE #6 holds afterwards: a published judgment is
 * frozen, and asking again is refused rather than obeyed.
 *
 * No model is called. The two "answers" are fixtures written by hand, which is
 * exactly what the external-session channel expects to be handed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { main } from "../scripts/fairjudge-cli";
import { createDb, runMigrations, DB_KEY_ENV_VAR, type Db } from "../src/server/db";
import {
  adverseFacts,
  caseParticipants,
  cases,
  clarificationRounds,
  issues,
  judgments,
  steelmanVersions,
  utterances,
} from "../src/server/db/schema";
import type { FactLayer, SurfaceLayer } from "../src/server/judgment";

const KEY = "7a".repeat(32);

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
  dir = mkdtempSync(join(tmpdir(), "fairjudge-judgment-"));
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

function write(name: string, value: unknown): string {
  const target = path(name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

/* -------------------------------------------------------------------------- */
/* A case that has genuinely arrived at judgment                              */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly caseId: string;
  readonly citable: readonly string[];
}

/**
 * Seeded directly rather than driven through the CLI: what is under test is the
 * publication step, and the eight stages in front of it have their own tests.
 * Evidence is Chinese and stays Chinese — a verbatim record (CLAUDE.md).
 */
function seedJudgmentReadyCase(): Fixture {
  return withDb((db) => {
    const [row] = db
      .insert(cases)
      .values({
        stage: "judgment",
        title: "fixture",
        isFixture: true,
        outputLevel: "L2",
        outputLevelLockedAt: new Date(),
      })
      .returning()
      .all();
    const caseId = row.id;

    const parties = db
      .insert(caseParticipants)
      .values([
        {
          caseId,
          role: "initiator" as const,
          pseudonym: "乙",
          isSubmitter: true,
          participationState: "participating" as const,
        },
        {
          caseId,
          role: "respondent" as const,
          pseudonym: "甲",
          isSubmitter: false,
          participationState: "unreachable" as const,
        },
      ])
      .returning()
      .all();
    const counterparty = parties.find((party) => !party.isSubmitter)!;

    const citable = db
      .insert(utterances)
      .values([
        {
          caseId,
          speakerParticipantId: counterparty.id,
          speakerLabel: "甲",
          aiDraft: "你要是真在乎就不会拖到现在",
          confirmStatus: "confirmed" as const,
        },
        {
          caseId,
          speakerParticipantId: counterparty.id,
          speakerLabel: "甲",
          aiDraft: "这件事今天必须说清楚",
          confirmStatus: "confirmed" as const,
        },
      ])
      .returning()
      .all()
      .map((utterance) => utterance.id);

    db.insert(issues)
      .values({
        caseId,
        category: "undisputed" as const,
        aiDraft: "甲 set a same-day deadline for resolving the argument.",
        evidenceRefs: [citable[1]],
        confirmStatus: "confirmed" as const,
      })
      .run();

    // The confrontation `assertJudgmentAllowed` requires, already answered.
    db.insert(adverseFacts)
      .values({
        caseId,
        aiDraft: "You let the exchange run past what 甲 had asked for.",
        evidenceRefs: [citable[0]],
        ackStatus: "acknowledged" as const,
        ackNote: "确实拖了",
      })
      .run();

    db.insert(steelmanVersions)
      .values({
        caseId,
        version: 1,
        verdict: "accepted" as const,
        aiDraft: "甲 would say they had already raised this twice and got nothing.",
      })
      .run();

    db.insert(clarificationRounds)
      .values({
        caseId,
        roundNumber: 1,
        questions: [
          { id: "q1", question: "What did you say back after 甲's second message?" },
        ],
        answers: [],
      })
      .run();

    return { caseId, citable };
  });
}

/** A well-formed L2 fact layer over the fixture: no allocation, one unknown. */
function factLayer(fixture: Fixture): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: '甲 set a same-day deadline: "这件事今天必须说清楚".',
        evidence_refs: [fixture.citable[1]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement:
          "What 乙 said in reply is not in the confirmed record; none of 乙's " +
          "own utterances have been confirmed.",
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: { total: 2, by_client: 0, by_counterparty: 2 },
        parties_without_citable_utterance: ["乙"],
        statement:
          "This judgment could read two lines, both 甲's. Not one line 乙 " +
          "spoke is confirmed, so nothing here rests on 乙's own account.",
      },
      unresolved: [
        {
          question: "What did 乙 say back after 甲's second message?",
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [],
    },
  };
}

function surfaceLayer(): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "s1",
        kind: "finding",
        heading: "What the record could be read from",
        text:
          "This judgment could read two lines, both 甲's. 乙 has no confirmed " +
          "line in this record.",
        claim_ids: ["c1"],
        audience: "both",
      },
      {
        section_id: "s2",
        kind: "limits",
        heading: "What this cannot decide",
        text: "With one side's words absent, no allocation is made here.",
        claim_ids: [],
        audience: "both",
      },
    ],
  };
}

/**
 * Drive both stages the way the skill does: prepare a bundle, hand back an
 * answer, keep the validated output. The two `--out` files are the whole reason
 * that flag exists — `judgment:finalize` is fed from them.
 */
async function ingestBothStages(fixture: Fixture): Promise<{
  fact: string;
  surface: string;
}> {
  await run(
    "stage:prepare",
    "--case",
    fixture.caseId,
    "--stage",
    "judgment_skeleton",
    "--out",
    path("skeleton-bundle.json"),
  );
  await run(
    "stage:ingest",
    "--case",
    fixture.caseId,
    "--stage",
    "judgment_skeleton",
    "--file",
    write("skeleton-answer.json", factLayer(fixture)),
    "--out",
    path("fact-layer.json"),
  );

  await run(
    "stage:prepare",
    "--case",
    fixture.caseId,
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
    fixture.caseId,
    "--stage",
    "judgment_narrative",
    "--fact-layer",
    path("fact-layer.json"),
    "--file",
    write("narrative-answer.json", surfaceLayer()),
    "--out",
    path("surface-layer.json"),
  );

  return { fact: path("fact-layer.json"), surface: path("surface-layer.json") };
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                  */
/* -------------------------------------------------------------------------- */

describe("judgment:finalize", () => {
  it("publishes the two ingested layers, and judgment:show then renders", async () => {
    const fixture = seedJudgmentReadyCase();
    const files = await ingestBothStages(fixture);

    // Before: both calls are on the record and there is still no judgment.
    await expect(run("judgment:show", "--case", fixture.caseId)).rejects.toThrow(
      /has no final judgment/,
    );

    const published = await run(
      "judgment:finalize",
      "--case",
      fixture.caseId,
      "--fact-layer",
      files.fact,
      "--surface-layer",
      files.surface,
    );

    expect(field(published, "status")).toBe("final");
    expect(field(published, "version")).toBe("1");
    // The level is read off the case, never passed in (HARD RULE #2).
    expect(field(published, "output_level")).toBe("L2");
    // Provenance this channel can honestly state: no vendor was paid, and the
    // surrounding session's model is not this process's to name.
    expect(field(published, "model")).toBe("external_session");
    expect(field(published, "finalized_at")).not.toBe("");

    const shown = await run("judgment:show", "--case", fixture.caseId);
    expect(field(shown, "level")).toBe("L2");
    expect(rows(shown, "claim").map((row) => row[0])).toEqual(["c1", "c2"]);
    expect(rows(shown, "section").map((row) => row[0])).toEqual(["s1", "s2"]);
  });

  it("refuses a second finalize — a judgment that has been issued is frozen", async () => {
    const fixture = seedJudgmentReadyCase();
    const files = await ingestBothStages(fixture);

    await run(
      "judgment:finalize",
      "--case",
      fixture.caseId,
      "--fact-layer",
      files.fact,
      "--surface-layer",
      files.surface,
    );

    await expect(
      run(
        "judgment:finalize",
        "--case",
        fixture.caseId,
        "--fact-layer",
        files.fact,
        "--surface-layer",
        files.surface,
      ),
    ).rejects.toThrow(/is final and is frozen/);

    // And the frozen row is untouched: still one judgment, still version 1.
    const chain = withDb((db) => db.select().from(judgments).all());
    expect(chain).toHaveLength(1);
    expect(chain[0].version).toBe(1);
  });

  it("re-runs the contract validators at the moment of the freeze", async () => {
    const fixture = seedJudgmentReadyCase();
    const files = await ingestBothStages(fixture);

    // A reviewer un-confirms the line the skeleton rests on, between the ingest
    // that accepted it and the publication that would freeze it. The citation
    // that authorizes publication has to be the one that holds NOW.
    withDb((db) => {
      db.update(utterances).set({ confirmStatus: "pending" }).run();
    });

    await expect(
      run(
        "judgment:finalize",
        "--case",
        fixture.caseId,
        "--fact-layer",
        files.fact,
        "--surface-layer",
        files.surface,
      ),
    ).rejects.toThrow(/rejected \(skeleton\)/);

    expect(withDb((db) => db.select().from(judgments).all())).toHaveLength(0);
  });

  it("refuses when the adverse-fact gate is shut, before anything is written", async () => {
    const fixture = seedJudgmentReadyCase();
    const files = await ingestBothStages(fixture);

    withDb((db) => {
      db.update(adverseFacts).set({ ackStatus: "pending" }).run();
    });

    await expect(
      run(
        "judgment:finalize",
        "--case",
        fixture.caseId,
        "--fact-layer",
        files.fact,
        "--surface-layer",
        files.surface,
      ),
    ).rejects.toThrow(/this gate cannot be skipped/);
  });

  it("names the file --surface-layer wants", async () => {
    const fixture = seedJudgmentReadyCase();
    const files = await ingestBothStages(fixture);

    await expect(
      run(
        "judgment:finalize",
        "--case",
        fixture.caseId,
        "--fact-layer",
        files.fact,
      ),
    ).rejects.toThrow(/stage:ingest --stage judgment_narrative --out/);
  });

  it("keeps the ingested fact layer usable as a file — that is what --out is for", async () => {
    const fixture = seedJudgmentReadyCase();
    await ingestBothStages(fixture);

    // The narrative is handed the skeleton as a file so a claim it never
    // received is a claim it cannot ground; the only copy of the accepted one is
    // the one `stage:ingest --out` wrote.
    const written = JSON.parse(readFileSync(path("fact-layer.json"), "utf8"));
    expect(written.claims.map((claim: { claim_id: string }) => claim.claim_id)).toEqual([
      "c1",
      "c2",
    ]);
  });
});
