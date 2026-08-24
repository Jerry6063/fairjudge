/**
 * Input manifests on the `llm_calls` row — doc 05 §B.3.
 *
 * "Every stage call declares an input manifest (the list of ids serialized into
 * its prompt), and the manifest hash is recorded on the `llm_calls` row. 'What
 * did this agent see' becomes a ledger answer, not a prompt-reading exercise."
 *
 * So the property under test is not "a manifest can be computed" — it is that
 * **no call escapes without one**. Every branch of the gateway that writes an
 * audit row is exercised here: the answered call, the schema-retry (two rows,
 * one run), and the request that left and never came back. A manifest that is
 * recorded on the happy path and missing on the failure paths would answer the
 * question only for the calls nobody needed to ask about.
 *
 * The SDK is mocked module-wide: these tests never touch the network and need
 * no API key.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, betaCreateMock, streamMock, betaStreamMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    betaCreateMock: vi.fn(),
    streamMock: vi.fn(),
    betaStreamMock: vi.fn(),
  }),
);

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createMock, stream: streamMock };
    beta = { messages: { create: betaCreateMock, stream: betaStreamMock } };
  }
  return { default: MockAnthropic };
});

import { createDb, runMigrations, type Db } from "../src/server/db";
import { llmCalls } from "../src/server/db/schema";
import { runStage } from "../src/server/llm";
import {
  buildManifest,
  serializeManifest,
  type InputManifest,
} from "../src/server/llm/claude";
import { MODEL_OPUS } from "../src/server/llm/config";
import { sha256Hex } from "../src/server/llm/ledger";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
  createMock.mockReset();
  betaCreateMock.mockReset();
  streamMock.mockReset();
  betaStreamMock.mockReset();
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const VALID_OUTPUT = {
  benign: { reading: "He is worn out", confidence: 0.4 },
  neutral: { reading: "He is stating an arrangement", confidence: 0.4 },
  negative: { reading: "He is hinting at dissatisfaction", confidence: 0.2 },
  cues: ['the softener "而已"'],
};

function anthropicResponse(text = JSON.stringify(VALID_OUTPUT)) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_OPUS,
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    _request_id: "req_test",
  };
}

/** Three UUIDs, deliberately not in sorted order in the prompt. */
const U1 = "3f1c9d2a-0b44-4f8e-9c21-77aa10b5e001";
const U2 = "0a2b8c7d-1e33-4a5b-8c9d-22bb30f6e002";
const U3 = "d4e5f607-2c11-4b9a-8d7e-33cc50a7e003";

function manifestRows(): {
  manifest: string | null;
  hash: string | null;
  stage: string | null;
}[] {
  return db
    .select({
      manifest: llmCalls.inputManifest,
      hash: llmCalls.inputManifestSha256,
      stage: llmCalls.stage,
    })
    .from(llmCalls)
    .all();
}

/* -------------------------------------------------------------------------- */

describe("manifest construction", () => {
  it("collects row ids and case-file handles, sorted and de-duplicated", () => {
    const manifest = buildManifest("translate.v3", [
      `EVIDENCE\n[{"id": "${U3}"}, {"id": "${U1}"}, {"id": "${U1}"}]`,
      `## Confirmed utterances\n[{"ref": "U2"}, {"ref": "U1"}]`,
      `and one more: ${U2}`,
    ]);

    expect(manifest.ids).toEqual([U2, U1, U3, "U1", "U2"].sort());
    expect(manifest.prompt_version).toBe("translate.v3");
  });

  it("serializes byte-stably, so equal inputs hash equal", () => {
    const a: InputManifest = { ids: [U1, U2], prompt_version: "v1" };
    const b: InputManifest = { ids: [U1, U2], prompt_version: "v1" };
    expect(serializeManifest(a)).toBe(serializeManifest(b));
    expect(serializeManifest(a)).toBe(
      `{"ids":["${U1}","${U2}"],"prompt_version":"v1"}`,
    );
  });

  it("records an empty list rather than nothing when a prompt carries no ids", () => {
    const manifest = buildManifest("translate.v3", ["他说随便你"]);
    expect(manifest.ids).toEqual([]);
    // Distinguishable from the pre-manifest era, which is null in the column.
    expect(serializeManifest(manifest)).toContain('"ids":[]');
  });

  it("does not mistake a bare handle in evidence text for a citation", () => {
    // "U1" inside a quoted line is conversation, not the record's id space.
    const manifest = buildManifest("v1", ['{"text": "meet me at U1 tomorrow"}']);
    expect(manifest.ids).toEqual([]);
  });
});

describe("every gateway call records its manifest", () => {
  it("records it on an answered call, matching the prompt's ids", async () => {
    createMock.mockResolvedValue(anthropicResponse());

    const result = await runStage(
      "translate_default",
      { prompt: `Read these: ${U3} and ${U1}.` },
      { db },
    );
    expect(result.kind).toBe("ok");

    const rows = manifestRows();
    expect(rows).toHaveLength(1);
    const manifest = JSON.parse(rows[0].manifest!) as InputManifest;
    expect(manifest.ids).toEqual([U1, U3].sort());
    expect(manifest.prompt_version).toBe("translate.v3");
    // The hash is of the exact stored bytes — that is the whole point of it.
    expect(rows[0].hash).toBe(sha256Hex(rows[0].manifest!));
  });

  it("records one on EACH attempt of a schema-revalidation retry", async () => {
    createMock
      .mockResolvedValueOnce(anthropicResponse('{"nope": true}'))
      .mockResolvedValueOnce(anthropicResponse());

    const result = await runStage(
      "translate_default",
      { prompt: `About ${U1}.` },
      { db },
    );
    expect(result.kind).toBe("ok");

    const rows = manifestRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.manifest).not.toBeNull();
      expect(row.hash).toBe(sha256Hex(row.manifest!));
      expect(JSON.parse(row.manifest!).ids).toEqual([U1]);
    }
    // The correction turn adds no ids, so the two attempts saw the same record.
    expect(rows[0].hash).toBe(rows[1].hash);
  });

  it("records one on a request that left and never came back", async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { status: 500 }),
    );

    const result = await runStage(
      "translate_default",
      { prompt: `About ${U2}.` },
      { db },
    );
    expect(result.kind).toBe("error");

    const rows = manifestRows();
    // Two attempts' worth of rows is the retry loop; every one of them carries
    // the manifest, because every one of them disclosed those ids.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(JSON.parse(row.manifest!).ids).toEqual([U2]);
      expect(row.hash).toBe(sha256Hex(row.manifest!));
    }
  });

  it("leaves the columns null for nothing — a call either has one or was never made", async () => {
    // An egress the gateway refuses to make writes no row at all, so there is
    // no path by which a NEW row can carry a null manifest. Null means only the
    // pre-manifest era (rows written before migration 0015).
    const blocked = await runStage(
      "translate_default",
      { prompt: "" },
      { db },
    );
    expect(blocked.kind).toBe("error");
    expect(manifestRows()).toHaveLength(0);
  });
});
