import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  evidence,
  files,
  utterances,
} from "../src/server/db/schema";
import { resolveSpeaker } from "../src/lib/utterance-speaker";
import { GRADE_BY_SOURCE_TYPE } from "../src/server/domain/grading";
import {
  TIMESTAMP_SPEAKER_LABEL,
  UTTERANCE_TRANSITIONS,
  WorkbenchError,
  canTransition,
  confirmEvidenceGrade,
  confirmUtterance,
  editUtterance,
  listCitableUtterances,
  loadWorkbench,
  rejectUtterance,
  updateUtteranceAttributes,
} from "../src/server/evidence/workbench";

/** Assert that `work` fails as a WorkbenchError carrying `code`. */
function expectFailure(work: () => unknown, code: string): void {
  try {
    work();
  } catch (cause) {
    expect(cause).toBeInstanceOf(WorkbenchError);
    expect((cause as WorkbenchError).code).toBe(code);
    return;
  }
  throw new Error(`expected a WorkbenchError(${code}), but the call succeeded`);
}

interface Fixture {
  caseId: string;
  /** The evidence under review (C-grade AI screenshot, three OCR lines). */
  evidenceId: string;
  /** A second evidence of the same case, for ownership checks. */
  otherEvidenceId: string;
  /** An utterance belonging to `otherEvidenceId`. */
  foreignUtteranceId: string;
  jiaId: string;
  yiId: string;
  /** Participant of an unrelated case. */
  outsiderId: string;
  lineIds: string[];
}

function seed(db: Db): Fixture {
  const [c] = db.insert(cases).values({ title: "确认工作台测试" }).returning().all();

  const [jia] = db
    .insert(caseParticipants)
    .values({
      caseId: c.id,
      role: "respondent",
      pseudonym: "甲",
      displayName: "知夏",
    })
    .returning()
    .all();
  const [yi] = db
    .insert(caseParticipants)
    .values({
      caseId: c.id,
      role: "initiator",
      pseudonym: "乙",
      displayName: "Adrian",
      isSubmitter: true,
    })
    .returning()
    .all();

  const [file] = db
    .insert(files)
    .values({
      caseId: c.id,
      kind: "screenshot",
      sha256: "a".repeat(64),
      originalFilename: "IMG_0001.PNG",
      mimeType: "image/png",
    })
    .returning()
    .all();

  // As intake leaves it: a suggestion, no confirmed grade.
  const [ev] = db
    .insert(evidence)
    .values({
      caseId: c.id,
      fileId: file.id,
      sourceType: "ai_processed",
      gradeSuggested: "C",
      gradeRationale: "ChatGPT 会话截图",
    })
    .returning()
    .all();

  const [other] = db
    .insert(evidence)
    .values({ caseId: c.id, sourceType: "public_sentiment", gradeSuggested: "D" })
    .returning()
    .all();

  // Inserted out of order on purpose: the list must come back by order_key.
  const lineIds = ["a2", "a0", "a1"]
    .map(
      (orderKey, index) =>
        db
          .insert(utterances)
          .values({
            caseId: c.id,
            evidenceId: ev.id,
            aiDraft: `第 ${String(index)} 次插入`,
            orderKey,
          })
          .returning()
          .all()[0],
    )
    .sort((left, right) => (left.orderKey ?? "").localeCompare(right.orderKey ?? ""))
    .map((row) => row.id);

  const [foreign] = db
    .insert(utterances)
    .values({ caseId: c.id, evidenceId: other.id, aiDraft: "别人家的行" })
    .returning()
    .all();

  const [otherCase] = db.insert(cases).values({ title: "另一个案子" }).returning().all();
  const [outsider] = db
    .insert(caseParticipants)
    .values({ caseId: otherCase.id, role: "initiator", pseudonym: "甲" })
    .returning()
    .all();

  return {
    caseId: c.id,
    evidenceId: ev.id,
    otherEvidenceId: other.id,
    foreignUtteranceId: foreign.id,
    jiaId: jia.id,
    yiId: yi.id,
    outsiderId: outsider.id,
    lineIds,
  };
}

describe("evidence workbench", () => {
  let db: Db;
  let sqlite: Database.Database;
  let fx: Fixture;

  beforeEach(() => {
    ({ db, sqlite } = createDb(":memory:"));
    runMigrations(db);
    fx = seed(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  const ref = (index = 0) => ({
    evidenceId: fx.evidenceId,
    utteranceId: fx.lineIds[index],
  });

  const read = (id: string) =>
    db.select().from(utterances).where(eq(utterances.id, id)).all()[0];

  /* ---------------------------------------------------------------- */
  /* Confirm-status transitions                                        */
  /* ---------------------------------------------------------------- */

  describe("confirm-status transitions", () => {
    it("pending → confirmed freezes the draft into human_final", () => {
      const before = read(fx.lineIds[0]);
      expect(before.confirmStatus).toBe("pending");
      expect(before.humanFinal).toBeNull();

      const result = confirmUtterance(db, ref());

      expect(result.confirmStatus).toBe("confirmed");
      expect(result.humanFinal).toBe(before.aiDraft);
      expect(result.text).toBe(before.aiDraft);

      const after = read(fx.lineIds[0]);
      expect(after.confirmStatus).toBe("confirmed");
      expect(after.humanFinal).toBe(before.aiDraft);
      // The draft is kept verbatim as provenance.
      expect(after.aiDraft).toBe(before.aiDraft);
    });

    it("pending → edited stores the reviewer's own wording", () => {
      const result = editUtterance(db, { ...ref(), text: "  我改写过的一行  " });

      expect(result.confirmStatus).toBe("edited");
      expect(result.humanFinal).toBe("我改写过的一行");
      expect(read(fx.lineIds[0]).confirmStatus).toBe("edited");
    });

    it("counts a rewrite identical to the draft as a confirmation", () => {
      const draft = read(fx.lineIds[0]).aiDraft ?? "";
      const result = editUtterance(db, { ...ref(), text: draft });

      expect(result.confirmStatus).toBe("confirmed");
      expect(result.humanFinal).toBe(draft);
    });

    it("pending → rejected, and a rejected line accepts nothing afterwards", () => {
      const rejected = rejectUtterance(db, ref());
      expect(rejected.confirmStatus).toBe("rejected");

      // The core rule: a deleted line cannot be confirmed back into the corpus.
      expectFailure(() => confirmUtterance(db, ref()), "illegal_transition");
      expectFailure(
        () => editUtterance(db, { ...ref(), text: "再试一次" }),
        "illegal_transition",
      );
      expectFailure(() => rejectUtterance(db, ref()), "illegal_transition");
      expectFailure(
        () => updateUtteranceAttributes(db, { ...ref(), isRetold: true }),
        "illegal_transition",
      );

      const after = read(fx.lineIds[0]);
      expect(after.confirmStatus).toBe("rejected");
      expect(after.isRetold).toBe(false);
    });

    it("allows revising an already-settled line, but never re-labels it", () => {
      confirmUtterance(db, ref());
      // Re-confirming is a no-op, not an error.
      expect(confirmUtterance(db, ref()).confirmStatus).toBe("confirmed");

      const edited = editUtterance(db, { ...ref(), text: "改了主意" });
      expect(edited.confirmStatus).toBe("edited");
      // Confirming an edited line keeps it edited: the text is the human's.
      expect(confirmUtterance(db, ref()).confirmStatus).toBe("edited");
      expect(read(fx.lineIds[0]).humanFinal).toBe("改了主意");
    });

    it("declares rejected terminal in the transition table", () => {
      expect(UTTERANCE_TRANSITIONS.rejected).toEqual([]);
      expect(canTransition("rejected", "confirmed")).toBe(false);
      expect(canTransition("rejected", "edited")).toBe(false);
      expect(canTransition("rejected", "rejected")).toBe(false);
      expect(canTransition("pending", "confirmed")).toBe(true);
      expect(canTransition("pending", "edited")).toBe(true);
      expect(canTransition("pending", "rejected")).toBe(true);
    });

    it("refuses to confirm a line with no text at all", () => {
      const [empty] = db
        .insert(utterances)
        .values({ caseId: fx.caseId, evidenceId: fx.evidenceId, aiDraft: "   " })
        .returning()
        .all();

      expectFailure(
        () =>
          confirmUtterance(db, {
            evidenceId: fx.evidenceId,
            utteranceId: empty.id,
          }),
        "empty_text",
      );
      expect(read(empty.id).confirmStatus).toBe("pending");
    });

    it("refuses an empty rewrite (deleting is a different decision)", () => {
      expectFailure(
        () => editUtterance(db, { ...ref(), text: "   \n " }),
        "empty_text",
      );
      expect(read(fx.lineIds[0]).confirmStatus).toBe("pending");
    });
  });

  /* ---------------------------------------------------------------- */
  /* Ownership                                                         */
  /* ---------------------------------------------------------------- */

  describe("ownership checks", () => {
    it("refuses an utterance that belongs to another evidence", () => {
      const foreign = {
        evidenceId: fx.evidenceId,
        utteranceId: fx.foreignUtteranceId,
      };
      expectFailure(() => confirmUtterance(db, foreign), "ownership_mismatch");
      expectFailure(
        () => editUtterance(db, { ...foreign, text: "偷偷改" }),
        "ownership_mismatch",
      );
      expectFailure(() => rejectUtterance(db, foreign), "ownership_mismatch");
      expect(read(fx.foreignUtteranceId).confirmStatus).toBe("pending");
    });

    it("reports unknown ids without touching anything", () => {
      expectFailure(
        () => confirmUtterance(db, { evidenceId: "nope", utteranceId: fx.lineIds[0] }),
        "evidence_not_found",
      );
      expectFailure(
        () => confirmUtterance(db, { evidenceId: fx.evidenceId, utteranceId: "nope" }),
        "utterance_not_found",
      );
      expectFailure(
        () => confirmEvidenceGrade(db, { evidenceId: "nope", grade: "C" }),
        "evidence_not_found",
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /* Attributes: is_retold / tone / speaker                            */
  /* ---------------------------------------------------------------- */

  describe("line attributes", () => {
    it("labels a line that has not been confirmed yet", () => {
      // Reading order: the reviewer marks retold / tone / speaker while deciding,
      // and only then confirms. Metadata writes must not require a settled row.
      const retold = updateUtteranceAttributes(db, { ...ref(), isRetold: true });
      expect(retold.isRetold).toBe(true);
      expect(retold.confirmStatus).toBe("pending");

      const speaker = updateUtteranceAttributes(db, {
        ...ref(),
        speaker: { kind: "participant", participantId: fx.jiaId },
        tone: "tired",
      });
      expect(speaker.speakerLabel).toBe("甲");
      expect(speaker.tone).toBe("tired");
      expect(read(fx.lineIds[0]).confirmStatus).toBe("pending");
    });

    it("sets is_retold and tone without moving confirm_status", () => {
      confirmUtterance(db, ref());

      const retold = updateUtteranceAttributes(db, { ...ref(), isRetold: true });
      expect(retold.isRetold).toBe(true);
      expect(retold.confirmStatus).toBe("confirmed");

      const toned = updateUtteranceAttributes(db, { ...ref(), tone: "sarcastic" });
      expect(toned.tone).toBe("sarcastic");
      expect(toned.isRetold).toBe(true);

      const cleared = updateUtteranceAttributes(db, { ...ref(), tone: null });
      expect(cleared.tone).toBeNull();
      expect(read(fx.lineIds[0]).confirmStatus).toBe("confirmed");
    });

    it("rejects an unknown tone label", () => {
      expectFailure(
        () =>
          updateUtteranceAttributes(db, {
            ...ref(),
            tone: "furious" as never,
          }),
        "invalid_tone",
      );
      expect(read(fx.lineIds[0]).tone).toBeNull();
    });

    it("attributes a line to a participant of the same case", () => {
      const result = updateUtteranceAttributes(db, {
        ...ref(),
        speaker: { kind: "participant", participantId: fx.jiaId },
      });

      expect(result.speakerParticipantId).toBe(fx.jiaId);
      expect(result.speakerLabel).toBe("甲");
    });

    it("marks a line as a timestamp row, clearing the speaker", () => {
      updateUtteranceAttributes(db, {
        ...ref(),
        speaker: { kind: "participant", participantId: fx.yiId },
      });

      const result = updateUtteranceAttributes(db, {
        ...ref(),
        speaker: { kind: "timestamp" },
      });

      expect(result.speakerParticipantId).toBeNull();
      expect(result.speakerLabel).toBe(TIMESTAMP_SPEAKER_LABEL);
    });

    it("reads OCR's side guess as unattributed, not as a decision", () => {
      // What intake writes: the bubble column it clustered the line into.
      const [guessed] = db
        .insert(utterances)
        .values({
          caseId: fx.caseId,
          evidenceId: fx.evidenceId,
          aiDraft: "识别出来的一行",
          speakerLabel: "left",
        })
        .returning()
        .all();

      const parties = loadWorkbench(db, fx.evidenceId)?.participants ?? [];
      const row = loadWorkbench(db, fx.evidenceId)?.utterances.find(
        (candidate) => candidate.id === guessed.id,
      );

      // The guess is a hint for the reviewer, never an attribution — and in
      // particular not the timestamp marker, which only a human writes.
      expect(resolveSpeaker(row!, parties)).toEqual({
        kind: "unassigned",
        hint: "left",
      });

      // Once the reviewer decides, it resolves to that party.
      updateUtteranceAttributes(db, {
        evidenceId: fx.evidenceId,
        utteranceId: guessed.id,
        speaker: { kind: "participant", participantId: fx.yiId },
      });
      const after = loadWorkbench(db, fx.evidenceId)?.utterances.find(
        (candidate) => candidate.id === guessed.id,
      );
      expect(resolveSpeaker(after!, parties)).toEqual({
        kind: "participant",
        participantId: fx.yiId,
        pseudonym: "乙",
      });
    });

    it("reads the timestamp marker and a seeded pseudonym", () => {
      updateUtteranceAttributes(db, { ...ref(), speaker: { kind: "timestamp" } });
      const parties = loadWorkbench(db, fx.evidenceId)?.participants ?? [];
      const marked = loadWorkbench(db, fx.evidenceId)?.utterances[0];
      expect(resolveSpeaker(marked!, parties)).toEqual({ kind: "timestamp" });

      // M0 seed rows carry the pseudonym with no participant id.
      expect(
        resolveSpeaker(
          { speakerParticipantId: null, speakerLabel: "甲" },
          parties,
        ),
      ).toMatchObject({ kind: "participant", participantId: fx.jiaId });

      // Nothing written at all.
      expect(
        resolveSpeaker({ speakerParticipantId: null, speakerLabel: null }, parties),
      ).toEqual({ kind: "unassigned", hint: null });
    });

    it("refuses a participant from another case", () => {
      expectFailure(
        () =>
          updateUtteranceAttributes(db, {
            ...ref(),
            speaker: { kind: "participant", participantId: fx.outsiderId },
          }),
        "speaker_not_in_case",
      );
      expect(read(fx.lineIds[0]).speakerParticipantId).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /* Evidence grade sign-off                                           */
  /* ---------------------------------------------------------------- */

  describe("grade_final sign-off", () => {
    it("starts unconfirmed and records the human decision", () => {
      const before = loadWorkbench(db, fx.evidenceId);
      expect(before?.evidence.gradeConfirmedAt).toBeNull();
      expect(before?.progress.gradeConfirmed).toBe(false);
      // Intake left a suggestion and no final grade.
      expect(before?.evidence.gradeFinal).toBeNull();
      expect(before?.evidence.gradeSuggested).toBe("C");

      const confirmed = confirmEvidenceGrade(db, {
        evidenceId: fx.evidenceId,
        grade: "C",
      });
      expect(confirmed.gradeFinal).toBe("C");
      expect(confirmed.gradeConfirmedAt).toBeTypeOf("number");

      const row = db
        .select()
        .from(evidence)
        .where(eq(evidence.id, fx.evidenceId))
        .all()[0];
      expect(row.gradeFinal).toBe("C");
      expect(row.gradeConfirmedAt).toBeInstanceOf(Date);

      expect(loadWorkbench(db, fx.evidenceId)?.progress.gradeConfirmed).toBe(true);
    });

    it("lets the human override the rule's suggestion", () => {
      const result = confirmEvidenceGrade(db, {
        evidenceId: fx.evidenceId,
        grade: "A",
      });
      expect(result.gradeFinal).toBe("A");
      expect(result.gradeSuggested).toBe("C");
      expect(result.gradeConfirmedAt).not.toBeNull();
    });

    it("refuses a grade outside A-D and leaves the row alone", () => {
      expectFailure(
        () =>
          confirmEvidenceGrade(db, {
            evidenceId: fx.evidenceId,
            grade: "F" as never,
          }),
        "invalid_grade",
      );

      const row = db
        .select()
        .from(evidence)
        .where(eq(evidence.id, fx.evidenceId))
        .all()[0];
      // Still unreviewed: a refused sign-off must not leave a grade behind.
      expect(row.gradeFinal).toBeNull();
      expect(row.gradeConfirmedAt).toBeNull();
    });

    it("falls back to the source_type rule when no suggestion was stored", () => {
      // M0 seed rows predate `grade_suggested`; the workbench still has to show
      // the reviewer what the rule would say.
      const [legacy] = db
        .insert(evidence)
        .values({ caseId: fx.caseId, sourceType: "recollection" })
        .returning()
        .all();

      const view = loadWorkbench(db, legacy.id);
      expect(view?.evidence.gradeSuggested).toBe(
        GRADE_BY_SOURCE_TYPE.recollection,
      );
      expect(view?.evidence.gradeSuggested).toBe("B");
      expect(view?.evidence.gradeFinal).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /* Read model                                                        */
  /* ---------------------------------------------------------------- */

  describe("loadWorkbench", () => {
    it("returns null for an unknown evidence id", () => {
      expect(loadWorkbench(db, "nope")).toBeNull();
    });

    it("lists this evidence's lines in order_key order, with its image", () => {
      const data = loadWorkbench(db, fx.evidenceId);
      expect(data).not.toBeNull();
      expect(data?.utterances.map((row) => row.id)).toEqual(fx.lineIds);
      expect(data?.utterances.map((row) => row.orderKey)).toEqual(["a0", "a1", "a2"]);
      expect(data?.image?.sha256).toBe("a".repeat(64));
      expect(data?.image?.originalFilename).toBe("IMG_0001.PNG");
      // Both parties are offered for speaker attribution (the list order is
      // the database's collation, which is not the 甲/乙 reading order).
      expect(new Set(data?.participants.map((p) => p.pseudonym))).toEqual(
        new Set(["甲", "乙"]),
      );
      // The other evidence's line is not in this list.
      expect(data?.utterances.some((row) => row.id === fx.foreignUtteranceId)).toBe(
        false,
      );
    });

    it("only reports complete once every line is settled AND the grade is signed off", () => {
      const progressNow = () => loadWorkbench(db, fx.evidenceId)?.progress;

      expect(progressNow()).toMatchObject({
        total: 3,
        pending: 3,
        settled: false,
        complete: false,
      });

      confirmUtterance(db, ref(0));
      editUtterance(db, { ...ref(1), text: "改写这一行" });
      expect(progressNow()).toMatchObject({ pending: 1, complete: false });

      rejectUtterance(db, ref(2));
      expect(progressNow()).toMatchObject({
        pending: 0,
        confirmed: 1,
        edited: 1,
        rejected: 1,
        settled: true,
        gradeConfirmed: false,
        // Lines are done, but the grade is not — not complete yet.
        complete: false,
      });

      confirmEvidenceGrade(db, { evidenceId: fx.evidenceId, grade: "C" });
      expect(progressNow()).toMatchObject({ complete: true });
    });
  });

  /* ---------------------------------------------------------------- */
  /* HARD RULE #1                                                      */
  /* ---------------------------------------------------------------- */

  describe("citable utterances (hard rule #1)", () => {
    it("exposes confirmed and edited lines only", () => {
      confirmUtterance(db, ref(0));
      editUtterance(db, { ...ref(1), text: "人写的版本" });
      rejectUtterance(db, ref(2));
      // fx.foreignUtteranceId stays pending.

      const citable = listCitableUtterances(db, fx.caseId);
      const ids = citable.map((row) => row.id);

      expect(ids).toContain(fx.lineIds[0]);
      expect(ids).toContain(fx.lineIds[1]);
      expect(ids).not.toContain(fx.lineIds[2]);
      expect(ids).not.toContain(fx.foreignUtteranceId);
      expect(citable).toHaveLength(2);

      // What a downstream stage would quote is the human's text.
      const edited = citable.find((row) => row.id === fx.lineIds[1]);
      expect(edited?.text).toBe("人写的版本");
    });

    it("drops a line out of the citable set the moment it is rejected", () => {
      confirmUtterance(db, ref(0));
      expect(listCitableUtterances(db, fx.caseId)).toHaveLength(1);

      rejectUtterance(db, ref(0));
      expect(listCitableUtterances(db, fx.caseId)).toHaveLength(0);
    });

    it("does not leak another case's confirmed lines", () => {
      confirmUtterance(db, ref(0));
      expect(listCitableUtterances(db, "some-other-case")).toHaveLength(0);
    });
  });
});
