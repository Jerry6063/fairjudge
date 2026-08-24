// Evidence intake: the upload pipeline, end to end, with the two outside
// systems replaced.
//
// OCR is a Swift subprocess and the anomaly check is a model call, so both are
// injected (`options.ocr`, `options.anomalyChecker`) and the pipeline itself —
// hashing, EXIF stripping, blob storage, row writing, grading — runs for real
// against an in-memory database and a temp blob directory. The last describe
// block goes one layer down and mocks the LLM gateway instead, to pin how the
// default checker talks to `runStage`.
//
// Two properties carry the milestone's acceptance criteria:
//
//   IDEMPOTENCE — the same bytes twice must not produce a second blob, a second
//   evidence row or (worst of all) a second set of utterances for the reviewer
//   to work through.
//
//   EXIF STRIPPING — what lands in data/blobs must be pixels and nothing else:
//   no capture time, no device model, no GPS.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  files,
  utterances,
} from "../src/server/db/schema";
import type { EvidenceAnomaly } from "../src/server/domain/grading";
import {
  ANOMALY_MIN_CHARS,
  buildOcrDigest,
  sanitizeImage,
  sha256Hex,
  type AnomalyChecker,
} from "../src/server/evidence";
import { ingestEvidenceUpload } from "../src/server/evidence/intake";
import type { BubbleBlock } from "../src/server/ocr";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A tiny JPEG carrying the metadata a real phone screenshot would. */
async function jpegWithExif(
  background: { r: number; g: number; b: number } = { r: 200, g: 40, b: 40 },
): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 24, channels: 3, background },
  })
    .jpeg({ quality: 92 })
    .withExif({
      IFD0: { Model: "iPhone 15 Pro", Software: "fairjudge-fixture" },
      IFD2: { DateTimeOriginal: "2026:07:04 21:15:00" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 5400/100" },
    })
    .toBuffer();
}

/** A JPEG whose EXIF says "rotate me 90°", to prove orientation is baked in. */
async function sidewaysJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 24, channels: 3, background: { r: 10, g: 90, b: 200 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

function block(
  side: BubbleBlock["side"],
  text: string,
  noise = false,
): BubbleBlock {
  return {
    side,
    text,
    noise,
    box: { x: 0, y: 0, w: 0.5, h: 0.05 },
    lines: [],
  };
}

/** What the fake OCR returns: two speech turns, a timestamp, and UI chrome. */
const OCR_BLOCKS: BubbleBlock[] = [
  block("center", "2026年7月4日 晚上9:15"),
  block("left", "你会先跟我讲吗？我记性不好，当时没记住。"),
  block("right", "几点？我以为你说的是明天早上的事。"),
  block("right", "已读", true),
];

/** Speech blocks only — what should become utterances. */
const SPEECH = OCR_BLOCKS.filter((b) => !b.noise);

const AI_ARTIFACT: EvidenceAnomaly = {
  is_ai_artifact: true,
  is_mass_content: false,
  rationale:
    'One side writes long, numbered analysis, and interface strings such as "重新生成" appear.',
};

const CLEAN: EvidenceAnomaly = {
  is_ai_artifact: false,
  is_mass_content: false,
  rationale: "Two people trading short turns back and forth.",
};

/* -------------------------------------------------------------------------- */

describe("evidence intake", () => {
  let db: Db;
  let sqlite: Database.Database;
  let blobDir: string;
  let caseId: string;

  /** Calls the fake OCR received, one entry per image path. */
  let ocrCalls: string[];
  /** Digests the fake anomaly checker received. */
  let anomalyCalls: { digest: string; caseId: string }[];

  const ocr = vi.fn(async (imagePath: string) => {
    ocrCalls.push(imagePath);
    return { blocks: OCR_BLOCKS };
  });

  /** Anomaly checker seam; each test picks what the "model" concluded. */
  let anomalyResult: EvidenceAnomaly | null = null;
  const anomalyChecker: AnomalyChecker = async (digest, context) => {
    anomalyCalls.push({ digest, caseId: context.caseId });
    return anomalyResult;
  };

  /** Ingest with the outside world stubbed out. */
  function ingest(bytes: Buffer, overrides: Record<string, unknown> = {}) {
    const { input = {}, ...options } = overrides as {
      input?: Record<string, unknown>;
    };
    return ingestEvidenceUpload(
      { caseId, bytes, filename: "IMG_0042.PNG", ...input },
      { db, blobDir, ocr, anomalyChecker, ...options },
    );
  }

  beforeEach(async () => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    blobDir = await mkdtemp(path.join(tmpdir(), "fairjudge-blobs-"));

    const [row] = db.insert(cases).values({ title: "upload test" }).returning().all();
    caseId = row.id;
    db.insert(caseParticipants)
      .values([
        { caseId, role: "respondent", pseudonym: "甲", displayName: "知夏" },
        { caseId, role: "initiator", pseudonym: "乙", displayName: "顾明远" },
      ])
      .run();

    ocrCalls = [];
    anomalyCalls = [];
    anomalyResult = null;
    ocr.mockClear();
  });

  afterEach(async () => {
    sqlite.close();
    await rm(blobDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /* Idempotence                                                         */
  /* ------------------------------------------------------------------ */

  describe("idempotence", () => {
    it("returns the first evidence when the same bytes arrive twice", async () => {
      const bytes = await jpegWithExif();

      const first = await ingest(bytes);
      const second = await ingest(bytes);

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.evidenceId).toBe(first.evidenceId);
      expect(second.fileId).toBe(first.fileId);
      expect(second.sha256).toBe(first.sha256);
    });

    it("writes no second row for a re-upload", async () => {
      const bytes = await jpegWithExif();
      await ingest(bytes);
      const before = db.select().from(utterances).all().length;

      await ingest(bytes);

      expect(db.select().from(files).all()).toHaveLength(1);
      expect(db.select().from(evidence).all()).toHaveLength(1);
      // The one that would actually hurt: a second confirmation queue.
      expect(db.select().from(utterances).all()).toHaveLength(before);
    });

    it("does not re-run OCR or the anomaly check for a re-upload", async () => {
      const bytes = await jpegWithExif();
      await ingest(bytes);
      await ingest(bytes);

      expect(ocrCalls).toHaveLength(1);
      expect(anomalyCalls).toHaveLength(1);
    });

    it("leaves exactly one blob on disk", async () => {
      const bytes = await jpegWithExif();
      await ingest(bytes);
      await ingest(bytes);

      expect(await readdir(blobDir)).toHaveLength(1);
    });

    it("still reports the queue length on the duplicate result", async () => {
      const bytes = await jpegWithExif();
      const first = await ingest(bytes);
      const second = await ingest(bytes);

      expect(second.utteranceCount).toBe(first.utteranceCount);
      expect(second.gradeSuggested).toBe(first.gradeSuggested);
      // Nothing was graded on the second call, so no rules are claimed to have
      // fired.
      expect(second.gradeReasons).toEqual([]);
    });

    it("treats different bytes as different evidence", async () => {
      const a = await ingest(await jpegWithExif({ r: 200, g: 40, b: 40 }));
      const b = await ingest(await jpegWithExif({ r: 40, g: 40, b: 200 }));

      expect(b.duplicate).toBe(false);
      expect(b.evidenceId).not.toBe(a.evidenceId);
      expect(db.select().from(evidence).all()).toHaveLength(2);
      expect(await readdir(blobDir)).toHaveLength(2);
    });

    it("scopes dedupe to the case", async () => {
      const bytes = await jpegWithExif();
      const first = await ingest(bytes);

      const [other] = db.insert(cases).values({ title: "another case" }).returning().all();
      const second = await ingestEvidenceUpload(
        { caseId: other.id, bytes },
        { db, blobDir, ocr, anomalyChecker },
      );

      expect(second.duplicate).toBe(false);
      expect(second.evidenceId).not.toBe(first.evidenceId);
      // Same content, same blob — the store is content-addressed.
      expect(second.sha256).toBe(first.sha256);
      expect(await readdir(blobDir)).toHaveLength(1);
    });

    it("keys on the uploaded bytes, not on the re-encoded ones", async () => {
      const bytes = await jpegWithExif();
      const result = await ingest(bytes);

      expect(result.sha256).toBe(sha256Hex(bytes));
      expect(await readdir(blobDir)).toEqual([`${sha256Hex(bytes)}.jpg`]);

      const stored = await readFile(path.join(blobDir, `${result.sha256}.jpg`));
      // The stored file is a re-encode, so its own hash is a different value —
      // which is exactly why identity is taken from the input.
      expect(sha256Hex(stored)).not.toBe(result.sha256);
    });
  });

  /* ------------------------------------------------------------------ */
  /* EXIF                                                                */
  /* ------------------------------------------------------------------ */

  describe("EXIF stripping", () => {
    it("starts from a fixture that really does carry EXIF", async () => {
      const bytes = await jpegWithExif();
      const meta = await sharp(bytes).metadata();

      expect(meta.exif).toBeDefined();
      expect(bytes.includes(Buffer.from("iPhone 15 Pro"))).toBe(true);
    });

    it("drops every metadata block when sanitizing", async () => {
      const sanitized = await sanitizeImage(await jpegWithExif());
      const meta = await sharp(sanitized.bytes).metadata();

      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
    });

    it("leaves no trace of the device or capture time in the stored blob", async () => {
      const result = await ingest(await jpegWithExif());
      const stored = await readFile(path.join(blobDir, `${result.sha256}.jpg`));

      expect((await sharp(stored).metadata()).exif).toBeUndefined();
      for (const secret of ["iPhone 15 Pro", "fairjudge-fixture", "2026:07:04"]) {
        expect(stored.includes(Buffer.from(secret))).toBe(false);
      }
      // The APP1/Exif segment header itself is gone, not just its contents.
      expect(stored.includes(Buffer.from("Exif\0\0", "binary"))).toBe(false);
    });

    it("bakes the orientation into the pixels before dropping the tag", async () => {
      // 40x24 tagged "rotate 90°": stripping the tag without rotating would
      // leave the image displayed sideways forever.
      const result = await ingest(await sidewaysJpeg());
      const stored = await sharp(
        await readFile(path.join(blobDir, `${result.sha256}.jpg`)),
      ).metadata();

      expect([stored.width, stored.height]).toEqual([24, 40]);
      expect(stored.exif).toBeUndefined();
    });

    it("records the stored file as a JPEG, whatever came in", async () => {
      const png = await sharp({
        create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();

      const result = await ingest(png);
      const [file] = db.select().from(files).where(eq(files.id, result.fileId)).all();

      expect(file.mimeType).toBe("image/jpeg");
      expect(file.storagePath?.endsWith(`${result.sha256}.jpg`)).toBe(true);
      expect((await sharp(await readFile(path.join(blobDir, `${result.sha256}.jpg`))).metadata()).format).toBe("jpeg");
      // byte_size describes what is on disk, not what was uploaded.
      expect(file.byteSize).toBe(
        (await readFile(path.join(blobDir, `${result.sha256}.jpg`))).byteLength,
      );
    });
  });

  /* ------------------------------------------------------------------ */
  /* Rows                                                                */
  /* ------------------------------------------------------------------ */

  describe("what lands in the database", () => {
    it("stores the file with the original filename and the upload hash", async () => {
      const result = await ingest(await jpegWithExif());
      const [file] = db.select().from(files).all();

      expect(file.caseId).toBe(caseId);
      expect(file.kind).toBe("screenshot");
      expect(file.originalFilename).toBe("IMG_0042.PNG");
      expect(file.sha256).toBe(result.sha256);
    });

    it("suggests a grade and leaves grade_final for a human", async () => {
      const result = await ingest(await jpegWithExif());
      const [row] = db.select().from(evidence).all();

      expect(row.sourceType).toBe("firsthand");
      expect(row.gradeSuggested).toBe("A");
      expect(row.gradeFinal).toBeNull();
      expect(row.gradeConfirmedAt).toBeNull();
      expect(row.gradeRationale).toBeTruthy();
      expect(result.gradeFinal).toBeNull();
      expect(result.gradeReasons).toEqual(["source_type"]);
    });

    it("seeds one pending utterance per speech block, in reading order", async () => {
      await ingest(await jpegWithExif());
      const rows = db
        .select()
        .from(utterances)
        .all()
        .sort((a, b) => (a.orderKey ?? "").localeCompare(b.orderKey ?? ""));

      expect(rows).toHaveLength(SPEECH.length);
      expect(rows.map((r) => r.aiDraft)).toEqual(SPEECH.map((b) => b.text));
      for (const row of rows) {
        expect(row.confirmStatus).toBe("pending");
        expect(row.humanFinal).toBeNull();
        expect(row.isRetold).toBe(false);
        expect(row.evidenceId).toBe(rows[0].evidenceId);
        expect(row.orderKey).toBeTruthy();
      }
      // Order keys are distinct, so a later drag can always insert between two.
      expect(new Set(rows.map((r) => r.orderKey)).size).toBe(rows.length);
    });

    it("parks the OCR side guess in speaker_label, not in speaker_participant_id", async () => {
      await ingest(await jpegWithExif());
      const rows = db.select().from(utterances).all();

      expect(rows.map((r) => r.speakerLabel).sort()).toEqual(
        SPEECH.map((b) => b.side).sort(),
      );
      // Attribution to a real participant is the reviewer's call.
      expect(rows.every((r) => r.speakerParticipantId === null)).toBe(true);
    });

    it("drops UI chrome instead of queueing it for confirmation", async () => {
      await ingest(await jpegWithExif());
      const drafts = db.select().from(utterances).all().map((r) => r.aiDraft);

      expect(drafts).not.toContain("已读");
    });

    it("summarizes the recognized speech for the list view", async () => {
      const result = await ingest(await jpegWithExif());
      const [row] = db
        .select()
        .from(evidence)
        .where(eq(evidence.id, result.evidenceId))
        .all();

      expect(row.contentSummary).toContain("你会先跟我讲吗");
      expect(row.contentSummary).not.toContain("已读");
    });
  });

  /* ------------------------------------------------------------------ */
  /* Anomaly check                                                       */
  /* ------------------------------------------------------------------ */

  describe("anomaly check", () => {
    it("sends a digest of the recognized text, scoped to the case", async () => {
      await ingest(await jpegWithExif());

      expect(anomalyCalls).toHaveLength(1);
      expect(anomalyCalls[0].caseId).toBe(caseId);
      expect(anomalyCalls[0].digest).toContain("你会先跟我讲吗");
      expect(anomalyCalls[0].digest).toContain("[left]");
      expect(anomalyCalls[0].digest).not.toContain("已读");
    });

    it("demotes a screenshot that turns out to be an AI session", async () => {
      anomalyResult = AI_ARTIFACT;

      const result = await ingest(await jpegWithExif());
      const [row] = db.select().from(evidence).all();

      expect(result.gradeSuggested).toBe("C");
      expect(result.gradeReasons).toEqual(["source_type", "ai_artifact_detected"]);
      expect(row.gradeSuggested).toBe("C");
      // The corrected class is recorded, not only the letter.
      expect(row.sourceType).toBe("ai_processed");
      // Still a suggestion: demotion does not confirm anything.
      expect(row.gradeFinal).toBeNull();
    });

    it("keeps the model's reasoning next to the grade for the reviewer", async () => {
      anomalyResult = AI_ARTIFACT;
      await ingest(await jpegWithExif());
      const [row] = db.select().from(evidence).all();

      expect(row.gradeAnomaly).toEqual({ ...AI_ARTIFACT });
    });

    it("leaves a clean screenshot at A", async () => {
      anomalyResult = CLEAN;
      const result = await ingest(await jpegWithExif());

      expect(result.gradeSuggested).toBe("A");
      expect(result.anomaly).toEqual(CLEAN);
    });

    it("falls back to the source_type rule when the check is unavailable", async () => {
      anomalyResult = null; // refusal, transport error, unparsable output
      const result = await ingest(await jpegWithExif());
      const [row] = db.select().from(evidence).all();

      expect(result.gradeSuggested).toBe("A");
      expect(row.gradeAnomaly).toBeNull();
    });

    it("makes no call at all when the caller opts out", async () => {
      const result = await ingest(await jpegWithExif(), { checkAnomaly: false });

      expect(anomalyCalls).toHaveLength(0);
      expect(result.anomaly).toBeNull();
      expect(result.gradeSuggested).toBe("A");
    });

    it("honours a declared kind and a provenance link without asking a model", async () => {
      const source = await ingest(await jpegWithExif({ r: 9, g: 9, b: 9 }));

      const derived = await ingest(await jpegWithExif(), {
        checkAnomaly: false,
        input: { kind: "ai_session", derivedFromEvidenceId: source.evidenceId },
      });

      expect(derived.sourceType).toBe("ai_processed");
      expect(derived.gradeSuggested).toBe("C");
      expect(derived.gradeReasons).toEqual(["source_type", "derived_from"]);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Resilience                                                          */
  /* ------------------------------------------------------------------ */

  describe("when OCR fails", () => {
    const failing = async () => {
      throw new Error("fairjudge-ocr: no such tool");
    };

    it("keeps the upload and reports the failure", async () => {
      const result = await ingest(await jpegWithExif(), { ocr: failing });

      expect(result.ocrError).toContain("no such tool");
      expect(result.utteranceCount).toBe(0);
      expect(db.select().from(evidence).all()).toHaveLength(1);
      expect(db.select().from(utterances).all()).toHaveLength(0);
      expect(await readdir(blobDir)).toHaveLength(1);
    });

    it("skips the model call rather than sending an empty digest", async () => {
      await ingest(await jpegWithExif(), { ocr: failing });
      expect(anomalyCalls).toHaveLength(0);
    });

    it("re-ingests on the next upload instead of resurrecting a half-written row", async () => {
      const bytes = await jpegWithExif();
      const failed = await ingest(bytes, { ocr: failing });
      const retried = await ingest(bytes);

      // The evidence row exists, so this is a duplicate — but the reviewer can
      // still get their lines from the workbench's re-transcribe path.
      expect(retried.duplicate).toBe(true);
      expect(retried.evidenceId).toBe(failed.evidenceId);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The default checker's wiring into the gateway                              */
/* -------------------------------------------------------------------------- */

const runStage = vi.hoisted(() => vi.fn());

vi.mock("../src/server/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/llm")>();
  return { ...actual, runStage };
});

const { checkEvidenceAnomaly } = await import("../src/server/evidence/anomaly");

describe("checkEvidenceAnomaly", () => {
  const digest =
    "[left] 你会先跟我讲吗？我记性不好，当时没记住。\n[right] 几点？";
  const dict = [{ canonical: "知夏", pseudonym: "甲", variants: [] }];

  beforeEach(() => {
    runStage.mockReset();
  });

  it("goes through the gateway's registered stage, never the SDK", async () => {
    runStage.mockResolvedValue({ kind: "ok", data: CLEAN, meta: {} });

    const result = await checkEvidenceAnomaly(digest, { caseId: "case_1", dict });

    expect(result).toEqual(CLEAN);
    expect(runStage).toHaveBeenCalledTimes(1);
    const [stage, input] = runStage.mock.calls[0];
    expect(stage).toBe("evidence_anomaly_check");
    expect(input).toEqual({ prompt: digest, dict, caseId: "case_1" });
  });

  it("hands the case dictionary along so real names never leave", async () => {
    runStage.mockResolvedValue({ kind: "ok", data: CLEAN, meta: {} });
    await checkEvidenceAnomaly(digest, { caseId: "case_1", dict });

    expect(runStage.mock.calls[0][1].dict).toBe(dict);
  });

  it("returns null on a refusal, so grading falls back to the rule", async () => {
    runStage.mockResolvedValue({ kind: "refused", category: "privacy" });
    expect(await checkEvidenceAnomaly(digest, { caseId: "c", dict })).toBeNull();
  });

  it("returns null on a transport error", async () => {
    runStage.mockResolvedValue({
      kind: "error",
      retryable: true,
      message: "socket hang up",
    });
    expect(await checkEvidenceAnomaly(digest, { caseId: "c", dict })).toBeNull();
  });

  it("does not spend a call on a digest too short to answer from", async () => {
    const tooShort = "x".repeat(ANOMALY_MIN_CHARS - 1);
    expect(await checkEvidenceAnomaly(tooShort, { caseId: "c", dict })).toBeNull();
    expect(runStage).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Digest construction                                                        */
/* -------------------------------------------------------------------------- */

describe("buildOcrDigest", () => {
  it("labels each line with the bubble side the OCR guessed", () => {
    expect(buildOcrDigest(OCR_BLOCKS)).toBe(
      [
        "[center] 2026年7月4日 晚上9:15",
        "[left] 你会先跟我讲吗？我记性不好，当时没记住。",
        "[right] 几点？我以为你说的是明天早上的事。",
      ].join("\n"),
    );
  });

  it("omits noise and blank blocks", () => {
    const digest = buildOcrDigest([...OCR_BLOCKS, block("left", "   ")]);
    expect(digest).not.toContain("已读");
    expect(digest.split("\n")).toHaveLength(3);
  });

  it("cuts on a line boundary and says it was cut", () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      block("left", `第 ${i} 句很长的话，用来把摘要顶到上限以上。`),
    );
    const digest = buildOcrDigest(long, 120);

    expect(digest.endsWith("(remainder omitted)")).toBe(true);
    expect(digest).toContain("[left] 第 0 句");
    // Every kept line is whole.
    for (const line of digest.split("\n")) {
      if (line.startsWith("[left]")) expect(line.endsWith("。")).toBe(true);
    }
  });

  it("is empty when nothing usable was recognized", () => {
    expect(buildOcrDigest([])).toBe("");
    expect(buildOcrDigest([block("right", "…", true)])).toBe("");
  });
});
