/**
 * The swap test (M3 wave B ⑨).
 *
 * What these tests hold down is not "the model is unbiased" — nothing here can
 * establish that, and the module is written so it cannot pretend to. They hold
 * down the three things that decide whether the test is worth running at all:
 *
 *   1. **The transformation is what it claims to be.** The swapped arm differs
 *      from the filed one in the party register and nowhere else — asserted
 *      against the serialized prompts, not against a comment. Verbatim evidence
 *      is byte-identical in both arms.
 *   2. **Differences are reported, never scored.** Flags are codes naming what
 *      moved; the module exports no threshold and no number that could be read
 *      as a pass mark.
 *   3. **Degeneracy is stated up front.** On the shape the seeded real case
 *      actually has — one party with confirmed words, the client silent — the
 *      test reports itself as unable to isolate bias, and says why in the audit
 *      row. That statement is the deliverable; a tidy comparison on this record
 *      would be the failure.
 *
 * The evidence in the fixtures is Chinese, verbatim, and never translated.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, runMigrations, type Db } from "../src/server/db";
import {
  caseParticipants,
  cases,
  utterances,
  type ConfirmStatus,
} from "../src/server/db/schema";
import { assembleCaseFile, serializeCaseFile } from "../src/server/pipeline";
import {
  SwapTestError,
  assessDegeneracy,
  buildSwapDictionary,
  describeSwapTest,
  diffSkeletons,
  flagDifferences,
  mapSkeletonBack,
  readSwapTests,
  runSwapTest,
  swapCaseFile,
  swapPseudonyms,
  type FactLayer,
  type SkeletonRunner,
} from "../src/server/judgment";

let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = createDb(":memory:"));
  runMigrations(db);
});

afterEach(() => {
  sqlite.close();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Evidence. Chinese, verbatim, never translated — the same line both arms see. */
const JIA_LINE_1 = "你到底什么时候能给我个准话";
const JIA_LINE_2 = "我周三之前必须知道";
const YI_LINE = "我那天其实一直在等你回消息";

/** The client is 乙 (the submitter), matching the seeded real case. */
function seedCase(): string {
  const [row] = db
    .insert(cases)
    .values({
      stage: "judgment",
      title: "fixture",
      outputLevel: "L2",
      outputLevelLockedAt: new Date(),
    })
    .returning()
    .all();

  db.insert(caseParticipants)
    .values([
      {
        caseId: row.id,
        role: "initiator",
        pseudonym: "乙",
        isSubmitter: true,
        participationState: "participating",
      },
      {
        caseId: row.id,
        role: "respondent",
        pseudonym: "甲",
        isSubmitter: false,
        participationState: "unaware",
      },
    ])
    .run();

  return row.id;
}

function addUtterance(
  caseId: string,
  text: string,
  speaker: string,
  confirmStatus: ConfirmStatus = "confirmed",
): void {
  db.insert(utterances)
    .values({
      caseId,
      aiDraft: text,
      confirmStatus,
      speakerLabel: speaker,
      orderKey: `a${text.length}`,
    })
    .run();
}

/** The real case's shape: only the counterparty has confirmed words. */
function seedOneSidedCase(): string {
  const caseId = seedCase();
  addUtterance(caseId, JIA_LINE_1, "甲");
  addUtterance(caseId, JIA_LINE_2, "甲");
  // The client's own line exists but nobody confirmed it — HARD RULE #1 makes
  // it invisible, which is exactly the state the real case is in.
  addUtterance(caseId, YI_LINE, "乙", "pending");
  return caseId;
}

/** A case where both parties have spoken — the shape that is NOT degenerate. */
function seedTwoSidedCase(): string {
  const caseId = seedCase();
  addUtterance(caseId, JIA_LINE_1, "甲");
  addUtterance(caseId, YI_LINE, "乙");
  return caseId;
}

/** A skeleton in the naming its own arm was given. */
function skeleton(options: {
  readonly client: string;
  readonly other: string;
  readonly otherAllocation?: "contributing" | "not_established";
  readonly clientAllocation?: "contributing" | "not_established";
  /**
   * Who this arm's record basis names as the client. Split from `client` so a
   * fixture can hold what the hearing concluded about the evidence fixed while
   * the register underneath it moves — which is the whole comparison.
   */
  readonly recordClient?: string;
  readonly byClient?: number;
  readonly extraClaim?: boolean;
}): FactLayer {
  const {
    client,
    other,
    otherAllocation = "contributing",
    clientAllocation = "not_established",
    byClient = 0,
    extraClaim = false,
  } = options;
  const recordClient = options.recordClient ?? client;

  return {
    claims: [
      {
        claim_id: "c1",
        statement: `${other} stated a deadline and treated it as already agreed.`,
        evidence_refs: ["U1"],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement: `${client}'s own words are not in the confirmed record.`,
        evidence_refs: [],
        confidence: 0.05,
        tier: "unknown",
      },
      ...(extraClaim
        ? [
            {
              claim_id: "c3",
              statement: `${other} pressed the point a second time.`,
              evidence_refs: ["U2"],
              confidence: 0.6,
              tier: "inferred" as const,
            },
          ]
        : []),
    ],
    findings: {
      record_basis: {
        client_pseudonym: recordClient,
        citable_utterances: { total: 2, by_client: byClient, by_counterparty: 2 - byClient },
        parties_without_citable_utterance: byClient === 0 ? [recordClient] : [],
        statement:
          `This hearing could read two confirmed lines. ` +
          `${byClient === 0 ? `${recordClient} has not spoken inside the record.` : ""}`,
      },
      unresolved: [
        {
          question: `What did ${client} reply that evening?`,
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [
        { party: other, allocation: otherAllocation, claim_ids: ["c1"] },
        { party: client, allocation: clientAllocation, claim_ids: ["c2"] },
      ],
    },
  };
}

/** A runner that answers each arm with a skeleton keyed to that arm's client. */
function runnerFor(
  answer: (arm: "filed" | "swapped", client: string, other: string) => FactLayer,
): SkeletonRunner {
  return async ({ arm, caseFile }) => {
    const client = caseFile.parties.find((party) => party.isSubmitter)?.pseudonym ?? "";
    const other =
      caseFile.parties.find((party) => !party.isSubmitter)?.pseudonym ?? "";
    return {
      factLayer: answer(arm, client, other),
      model: "claude-fable-5",
      effort: "xhigh",
      fallbackUsed: false,
      promptVersion: "judgment_skeleton.v1",
    };
  };
}

/**
 * A hearing that reads the record rather than the register: whoever the file
 * calls the client, it says the same thing about the same two lines — the lines
 * are 甲's in both arms, because the swap never moves evidence.
 */
function steadyRunner(): SkeletonRunner {
  return runnerFor((_arm, armClient) =>
    skeleton({
      // The conclusion is about 甲, whose two lines are in both prompts.
      client: "乙",
      other: "甲",
      // The record basis follows the register, which is the one thing that moved.
      recordClient: armClient,
      byClient: armClient === "甲" ? 2 : 0,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* The dictionary                                                             */
/* -------------------------------------------------------------------------- */

describe("the address-term dictionary", () => {
  it("registers both pseudonyms and every role word it found", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const dict = buildSwapDictionary(file);

    // Sorted by code unit: 乙 (U+4E59) before 甲 (U+7532).
    expect(dict.pair).toEqual({ a: "乙", b: "甲" });
    expect(dict.substitutions).toEqual([
      { from: "乙", to: "甲" },
      { from: "甲", to: "乙" },
    ]);

    // Role words are enumerated so nothing marks position unaccounted for. The
    // case file's party register carries `initiator` / `respondent`.
    const terms = dict.roleTerms.map((item) => item.term);
    expect(terms).toContain("initiator");
    expect(terms).toContain("respondent");
  });

  it("refuses a case that has no two parties to exchange", () => {
    const [row] = db
      .insert(cases)
      .values({ stage: "judgment", outputLevel: "L2", outputLevelLockedAt: new Date() })
      .returning()
      .all();
    db.insert(caseParticipants)
      .values({ caseId: row.id, role: "initiator", pseudonym: "乙", isSubmitter: true })
      .run();

    const file = assembleCaseFile(db, row.id);
    expect(() => buildSwapDictionary(file)).toThrowError(SwapTestError);
    try {
      buildSwapDictionary(file);
    } catch (error) {
      expect((error as SwapTestError).code).toBe("parties_not_pairable");
    }
  });

  it("exchanges both pseudonyms in one pass, without cascading", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const dict = buildSwapDictionary(file);

    // If the substitution were applied sequentially rather than in one pass,
    // 甲→乙 followed by 乙→甲 would collapse both onto 甲.
    expect(swapPseudonyms("甲 said it to 乙, and 乙 answered 甲", dict)).toBe(
      "乙 said it to 甲, and 甲 answered 乙",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The transformation                                                         */
/* -------------------------------------------------------------------------- */

describe("the swapped case file", () => {
  it("changes the party register and nothing else", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const dict = buildSwapDictionary(file);
    const swapped = swapCaseFile(file, dict);

    // The evidence is byte-identical in both arms: a record is never rewritten,
    // not even for a test (CLAUDE.md).
    expect(swapped.text).toContain(JIA_LINE_1);
    expect(swapped.text).toContain(JIA_LINE_2);
    expect(swapped.file.utterances).toEqual(file.utterances);

    // Every changed line belongs to the register — no quote, no timeline entry,
    // no clarification exchange moved.
    expect(swapped.changedLines.length).toBeGreaterThan(0);
    for (const line of swapped.changedLines) {
      expect(line).not.toContain(JIA_LINE_1);
      expect(line).not.toContain(JIA_LINE_2);
      expect(line).toMatch(/is_submitter|participation_state|role|pseudonym/);
    }

    // And the exchange actually happened: the client is now the other name.
    const client = swapped.file.parties.find((party) => party.isSubmitter);
    expect(client?.pseudonym).toBe("甲");
    expect(file.parties.find((party) => party.isSubmitter)?.pseudonym).toBe("乙");
  });

  it("keeps the register in canonical order, so list position leaks nothing", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const swapped = swapCaseFile(file, buildSwapDictionary(file));

    expect(swapped.file.parties.map((party) => party.pseudonym)).toEqual(["乙", "甲"]);
    expect(file.parties.map((party) => party.pseudonym)).toEqual(["乙", "甲"]);
  });

  it("does not touch the stored record", () => {
    const caseId = seedOneSidedCase();
    const before = serializeCaseFile(assembleCaseFile(db, caseId));
    const file = assembleCaseFile(db, caseId);
    swapCaseFile(file, buildSwapDictionary(file));

    expect(serializeCaseFile(assembleCaseFile(db, caseId))).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Degeneracy                                                                 */
/* -------------------------------------------------------------------------- */

describe("degeneracy", () => {
  it("reports the real case's shape as degenerate, and names the silent client", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const degeneracy = assessDegeneracy(file);

    expect(degeneracy.degenerate).toBe(true);
    expect(degeneracy.speakingParties).toEqual(["甲"]);
    expect(degeneracy.silentParties).toEqual(["乙"]);
    expect(degeneracy.citableUtterances).toBe(2);
    // The statement has to say the thing, not gesture at it.
    expect(degeneracy.reason).toContain("乙");
    expect(degeneracy.reason).toContain("cannot show even-handedness");
  });

  it("does not call a two-sided record degenerate", () => {
    const file = assembleCaseFile(db, seedTwoSidedCase());
    const degeneracy = assessDegeneracy(file);

    expect(degeneracy.degenerate).toBe(false);
    expect(degeneracy.speakingParties).toEqual(["乙", "甲"]);
  });

  it("is decided from the record, before either arm runs", async () => {
    // A run whose two arms agree on everything still reports degeneracy: a tidy
    // comparison cannot argue the record out of its own shape.
    const caseId = seedOneSidedCase();
    const report = await runSwapTest(db, caseId, steadyRunner());

    expect(report.degeneracy.degenerate).toBe(true);
    expect(report.flags.map((flag) => flag.code)).toContain("no_measured_difference");
    const noDifference = report.flags.find(
      (flag) => flag.code === "no_measured_difference",
    );
    expect(noDifference?.detail).toContain("not a pass");
  });
});

/* -------------------------------------------------------------------------- */
/* The comparison                                                             */
/* -------------------------------------------------------------------------- */

const PARTIES = ["乙", "甲"] as const;

describe("the comparison", () => {
  it("does not translate either arm — the swap never moved the evidence", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());
    const dict = buildSwapDictionary(file);

    // Both arms cite U1, and U1 is 甲's line in both prompts. A hearing that
    // read the record says the same thing about it whoever filed the case, so
    // identical answers must come back as no difference at all.
    const filed = skeleton({ client: "乙", other: "甲" });
    const swapped = skeleton({ client: "甲", other: "甲", clientAllocation: "not_established" });

    const differences = diffSkeletons(filed, swapped, {
      filedClient: "乙",
      swappedClient: "甲",
      parties: [...PARTIES],
    });

    expect(differences.pairedClaims[0].characterizationMoved).toBe(false);

    // `mapSkeletonBack` exists for the relabel arm and is not used here: run it
    // over an answer and it *creates* a difference that is not in the data.
    const translated = mapSkeletonBack(filed, dict);
    expect(translated.claims[0].statement).toContain("乙");
    expect(translated.claims[0].evidence_refs).toEqual(["U1"]);
  });

  it("flags an exchanged allocation as following the register, not the citations", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());

    const filed = skeleton({ client: "乙", other: "甲" });
    // The swapped arm blamed its own counterparty — which, with the register
    // exchanged and the evidence standing still, is the opposite party.
    const swapped = skeleton({ client: "甲", other: "乙" });

    const differences = diffSkeletons(filed, swapped, {
      filedClient: "乙",
      swappedClient: "甲",
      parties: [...PARTIES],
    });
    const flags = flagDifferences(differences, assessDegeneracy(file));
    const codes = flags.map((flag) => flag.code);

    expect(codes).toContain("allocation_exchanged");
    const exchanged = flags.find((flag) => flag.code === "allocation_exchanged");
    expect(exchanged?.detail).toContain("degeneracy statement");

    // Measured, not scored: the module reports which allocations moved.
    const moved = differences.allocations.filter((item) => item.changed);
    expect(moved.map((item) => item.party).sort()).toEqual(["乙", "甲"]);
  });

  it("flags a characterization that changed party on unchanged citations", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());

    const filed = skeleton({ client: "乙", other: "甲" });
    const swapped = skeleton({ client: "甲", other: "乙" });

    const differences = diffSkeletons(filed, swapped, {
      filedClient: "乙",
      swappedClient: "甲",
      parties: [...PARTIES],
    });

    const pair = differences.pairedClaims.find((item) => item.citations === "U1");
    expect(pair?.characterizationMoved).toBe(true);
    expect(pair?.partiesNamedFiled).toEqual(["甲"]);
    expect(pair?.partiesNamedSwapped).toEqual(["乙"]);
    expect(
      flagDifferences(differences, assessDegeneracy(file)).map((flag) => flag.code),
    ).toContain("characterization_moved");
  });

  it("reports a claim that exists in one arm only", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());

    const filed = skeleton({ client: "乙", other: "甲" });
    const swapped = skeleton({ client: "甲", other: "乙", extraClaim: true });

    const differences = diffSkeletons(filed, swapped, {
      filedClient: "乙",
      swappedClient: "甲",
      parties: [...PARTIES],
    });

    expect(differences.claimsOnlyInSwapped).toHaveLength(1);
    expect(differences.claimsOnlyInSwapped[0].evidenceRefs).toEqual(["U2"]);
    expect(differences.claimsOnlyInFiled).toHaveLength(0);
    expect(flagDifferences(differences, assessDegeneracy(file)).map((f) => f.code)).toContain(
      "claim_only_in_one_arm",
    );
  });

  it("flags arms that disagree about how much record there is", () => {
    const file = assembleCaseFile(db, seedOneSidedCase());

    const filed = skeleton({ client: "乙", other: "甲" });
    const swapped = skeleton({ client: "甲", other: "乙" });
    const miscounted: FactLayer = {
      ...swapped,
      findings: {
        ...swapped.findings,
        record_basis: {
          ...swapped.findings.record_basis,
          citable_utterances: { total: 5, by_client: 0, by_counterparty: 5 },
        },
      },
    };

    const differences = diffSkeletons(filed, miscounted, {
      filedClient: "乙",
      swappedClient: "甲",
      parties: [...PARTIES],
    });

    expect(differences.recordBasis.totalsAgree).toBe(false);
    expect(
      flagDifferences(differences, assessDegeneracy(file)).map((flag) => flag.code),
    ).toContain("record_basis_total_mismatch");
  });

  it("expects the arms to name different clients — that is the swap working", () => {
    const differences = diffSkeletons(
      skeleton({ client: "乙", other: "甲" }),
      skeleton({ client: "甲", other: "乙" }),
      { filedClient: "乙", swappedClient: "甲", parties: [...PARTIES] },
    );

    expect(differences.recordBasis.filedClientCorrect).toBe(true);
    expect(differences.recordBasis.swappedClientCorrect).toBe(true);
    expect(differences.recordBasis.filedClient).not.toBe(
      differences.recordBasis.swappedClient,
    );
  });

  it("reports no score and no threshold", () => {
    const differences = diffSkeletons(
      skeleton({ client: "乙", other: "甲" }),
      skeleton({ client: "甲", other: "乙" }),
      { filedClient: "乙", swappedClient: "甲", parties: [...PARTIES] },
    );

    // Confidence deltas are measured and reported; nothing compares them to a
    // cut-off, because there is no calibration data behind one.
    const serialized = JSON.stringify(differences);
    expect(serialized).not.toMatch(/threshold|score|biasScore/i);
  });
});

/* -------------------------------------------------------------------------- */
/* The audit record                                                           */
/* -------------------------------------------------------------------------- */

describe("the audit record", () => {
  it("persists degeneracy, flags and both skeletons", async () => {
    const caseId = seedOneSidedCase();

    const report = await runSwapTest(
      db,
      caseId,
      runnerFor((arm, client, other) =>
        skeleton({
          client,
          other,
          // Both arms blame their own counterparty: exchanged once mapped back.
          otherAllocation: "contributing",
          extraClaim: arm === "swapped",
        }),
      ),
      { judgmentId: null },
    );

    const rows = readSwapTests(db, caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].arm).toBe("register_exchange");
    expect(rows[0].degenerate).toBe(true);
    expect(rows[0].degenerateReason).toContain("only party who has spoken");
    expect(rows[0].flags).toContain("claim_only_in_one_arm");

    // Both skeletons are kept: a comparison nobody can re-examine is not audit.
    expect(rows[0].report.filed.factLayer.claims.length).toBeGreaterThan(0);
    expect(rows[0].report.swapped.factLayer.claims.length).toBeGreaterThan(0);
    expect(rows[0].report.filed.model).toBe("claude-fable-5");

    // The receipt for the transformation travels with the record.
    expect(rows[0].report.caseFileChangedLines.length).toBeGreaterThan(0);
    expect(report.residualChannels.join(" ")).toContain("Verbatim evidence is untouched");
  });

  it("can be asked not to persist", async () => {
    const caseId = seedOneSidedCase();
    await runSwapTest(db, caseId, steadyRunner(), { persist: false });
    expect(readSwapTests(db, caseId)).toHaveLength(0);
  });

  it("records nothing when one arm fails — half a swap test is not one", async () => {
    const caseId = seedOneSidedCase();
    const runner: SkeletonRunner = async ({ arm, caseFile }) => {
      if (arm === "swapped") throw new Error("the model refused");
      const client = caseFile.parties.find((party) => party.isSubmitter)?.pseudonym ?? "";
      const other = caseFile.parties.find((party) => !party.isSubmitter)?.pseudonym ?? "";
      return { factLayer: skeleton({ client, other }), model: "claude-fable-5" };
    };

    await expect(runSwapTest(db, caseId, runner)).rejects.toThrowError(SwapTestError);
    expect(readSwapTests(db, caseId)).toHaveLength(0);
  });

  it("puts the degeneracy statement above the flags when it writes prose", async () => {
    const caseId = seedOneSidedCase();
    const report = await runSwapTest(db, caseId, steadyRunner());

    const text = describeSwapTest(report);
    expect(text.indexOf("DEGENERATE")).toBeLessThan(text.indexOf("Measured differences"));
    expect(text).toContain("No score is reported");
  });
});
