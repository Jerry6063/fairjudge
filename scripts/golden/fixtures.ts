/**
 * The constructed cases `npm run eval:golden` runs — SPEC M3 wave B ⑬.
 *
 * Every fixture is a whole case seeded into an in-memory database plus the
 * **recorded** model answers for every stage that case's hearing asks for, so
 * the harness replays a hearing instead of buying one: no network, no key, no
 * cost, and the same bytes every run. What is exercised is everything except the
 * model — the level derivation, the citation audit, the level constraints, the
 * record-basis arithmetic, the contract, publication, freezing and both
 * renditions.
 *
 * A hearing is not two calls. Since M6 batch 2 an L1 case runs the blind
 * advocate pair, then the skeleton twice — once as filed and once with the
 * parties' positions in the register exchanged — and only then the narrative, so
 * an L1 fixture records a brief per seat and a fact layer per seating. Recording
 * one skeleton and replaying it to both arms would be the harness answering the
 * swap test with the hearing it is supposed to be testing, and the comparison
 * would pass by construction.
 *
 * Half of these fixtures are supposed to fail, and that is the point. A harness
 * made only of clean cases proves that the checks did not fire; it cannot tell
 * that apart from checks that cannot fire. So each rule gets a case built to
 * break it, and the expectation recorded next to it is the rejection.
 *
 * Evidence text is Chinese and stays Chinese (CLAUDE.md). It is invented for
 * these fixtures — no line here comes from any real record — but it is invented in
 * the language the pipeline actually reads, because a fixture in translation
 * would exercise a code path the product does not have.
 */

import type { Db } from "../../src/server/db";
import {
  adverseFacts,
  caseParticipants,
  cases,
  clarificationRounds,
  evidence as evidenceTable,
  issues,
  safetyScreens,
  steelmanVersions,
  utterances,
  type OutputLevel,
} from "../../src/server/db/schema";
import type {
  FactLayer,
  JudgmentRejectionCode,
  SurfaceLayer,
  SwapGateDisposition,
} from "../../src/server/judgment";
import type { AdvocateBriefOutput } from "../../src/server/llm/stages";
import {
  confirmOwnLine,
  submitStatement,
} from "../../src/server/participation/submission";

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

export interface Seeded {
  readonly caseId: string;
  /** Confirmed lines, in insertion order. The only citable ids. */
  readonly citable: readonly string[];
  /** Lines on file that no stage can see (HARD RULE #1). */
  readonly pending: readonly string[];
  /** A confirmed line whose source evidence was never graded by a human. */
  readonly ungraded: string | null;
}

interface SeedSpec {
  /** Counterparty participation, which is half of the level derivation. */
  readonly counterpartyState?: "pending" | "participating" | "unreachable";
  /** Confirmed lines spoken by the counterparty 甲. */
  readonly counterpartyLines?: readonly string[];
  /** Confirmed lines spoken by the client 乙. */
  readonly clientLines?: readonly string[];
  /**
   * An account the counterparty submitted HERSELF, through her own entry.
   *
   * Different in kind from `counterpartyLines`, which are lines she SPOKE that
   * the client screenshotted, owns and signed off. Only this knob produces
   * material she owns, and only ownership opens L1 (SPEC M5 ⑥).
   */
  readonly counterpartyOwnLines?: readonly string[];
  /** Lines on file, unconfirmed, spoken by the client. */
  readonly clientPending?: readonly string[];
  /** Human-confirmed grades on the evidence the lines came out of. */
  readonly grades?: readonly ("A" | "B" | "C" | "D")[];
  /** Add one confirmed line whose evidence has no `grade_final`. */
  readonly withUngradedLine?: boolean;
  /** Fire the safety gate. */
  readonly redFlag?: boolean;
  /** Leave the single adverse fact unanswered, closing the judgment gate. */
  readonly adverseFactPending?: boolean;
}

/**
 * Build one case.
 *
 * Everything a level, a gate or a citation check reads is written here: the
 * participants, the utterances with their confirm status, the evidence rows
 * carrying `grade_final`, the three issue lists, the steelman, one adverse fact
 * and one closed clarification round.
 */
export function seed(db: Db, spec: SeedSpec = {}): Seeded {
  const [row] = db
    .insert(cases)
    .values({ stage: "pre_judgment", title: "golden fixture" })
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
        participationState: spec.counterpartyState ?? "pending",
      },
    ])
    .returning()
    .all();
  const client = parties.find((party) => party.isSubmitter)!;
  const counterparty = parties.find((party) => !party.isSubmitter)!;

  // One graded evidence row per requested grade, plus (optionally) one that no
  // human ever graded — `grade_final` NULL is what "ungraded" means everywhere
  // in this product (M2 decision record).
  const grades = spec.grades ?? ["C", "C"];
  const graded = grades.map(
    (grade) =>
      db
        .insert(evidenceTable)
        .values({
          caseId,
          sourceType: "ai_processed" as const,
          gradeSuggested: grade,
          gradeFinal: grade,
        })
        .returning()
        .all()[0],
  );
  const ungradedEvidence =
    spec.withUngradedLine === true
      ? db
          .insert(evidenceTable)
          .values({
            caseId,
            sourceType: "ai_processed" as const,
            gradeSuggested: "C" as const,
            gradeFinal: null,
          })
          .returning()
          .all()[0]
      : null;

  const citable: string[] = [];
  const counterpartyLines = spec.counterpartyLines ?? [
    "这件事今天必须说清楚",
    "你要是真在乎就不会拖到现在",
  ];
  counterpartyLines.forEach((text, at) => {
    citable.push(
      db
        .insert(utterances)
        .values({
          caseId,
          evidenceId: (graded[at % graded.length] ?? graded[0])?.id ?? null,
          speakerParticipantId: counterparty.id,
          speakerLabel: "甲",
          aiDraft: text,
          confirmStatus: "confirmed" as const,
        })
        .returning()
        .all()[0].id,
    );
  });

  (spec.clientLines ?? []).forEach((text, at) => {
    citable.push(
      db
        .insert(utterances)
        .values({
          caseId,
          evidenceId: (graded[at % graded.length] ?? graded[0])?.id ?? null,
          speakerParticipantId: client.id,
          speakerLabel: "乙",
          aiDraft: text,
          confirmStatus: "confirmed" as const,
        })
        .returning()
        .all()[0].id,
    );
  });

  // Her own account, written through the product's own path rather than as raw
  // inserts (SPEC M5 ⑥). `submitStatement` is what stamps `owner_participant_id`
  // and appends the `granted / case_record` consent event, and `confirmOwnLine`
  // is the confirmation her screen performs; a fixture that inserted the rows
  // directly would assert the level rule against material no code path can
  // produce. Her rows stay `visibility = 'private'` — they reach the case
  // record through the consent event alone.
  for (const text of spec.counterpartyOwnLines ?? []) {
    const submitted = submitStatement(db, {
      caseId,
      participantId: counterparty.id,
      text,
    });
    for (const utteranceId of submitted.utteranceIds) {
      confirmOwnLine(db, {
        caseId,
        participantId: counterparty.id,
        evidenceId: submitted.evidenceId,
        utteranceId,
      });
      citable.push(utteranceId);
    }
  }

  const ungraded =
    ungradedEvidence === null
      ? null
      : db
          .insert(utterances)
          .values({
            caseId,
            evidenceId: ungradedEvidence.id,
            speakerParticipantId: counterparty.id,
            speakerLabel: "甲",
            aiDraft: "我上周就提过这件事",
            confirmStatus: "confirmed" as const,
          })
          .returning()
          .all()[0].id;
  if (ungraded !== null) citable.push(ungraded);

  const pending = (spec.clientPending ?? ["我当时在加班", "我们明天再谈"]).map(
    (text) =>
      db
        .insert(utterances)
        .values({
          caseId,
          evidenceId: graded[0]?.id ?? null,
          speakerParticipantId: client.id,
          speakerLabel: "乙",
          aiDraft: text,
          confirmStatus: "pending" as const,
        })
        .returning()
        .all()[0].id,
  );

  if (citable.length > 0) {
    db.insert(issues)
      .values([
        {
          caseId,
          category: "undisputed" as const,
          aiDraft: "甲 asked for the argument to be settled the same day.",
          evidenceRefs: [citable[0]],
          confirmStatus: "confirmed" as const,
        },
        {
          caseId,
          category: "standard_dispute" as const,
          aiDraft: "What counts as caring enough, and how fast.",
          evidenceRefs: [citable[0]],
          confirmStatus: "confirmed" as const,
        },
      ])
      .run();

    db.insert(steelmanVersions)
      .values({
        caseId,
        version: 1,
        verdict: "accepted" as const,
        aiDraft: "甲 would say she had raised this before and got nothing back.",
      })
      .run();
  }

  db.insert(adverseFacts)
    .values({
      caseId,
      aiDraft: "You let the exchange run past what 甲 had asked for.",
      evidenceRefs: citable.length > 0 ? [citable[0]] : [],
      ackStatus:
        spec.adverseFactPending === true
          ? ("pending" as const)
          : ("acknowledged" as const),
      ackNote: spec.adverseFactPending === true ? null : "确实拖了",
    })
    .run();

  db.insert(clarificationRounds)
    .values({
      caseId,
      roundNumber: 1,
      questions: [{ id: "q1", question: "What did you say back that evening?" }],
      answers: [
        {
          questionId: "q1",
          answer: "",
          answeredAt: null,
          state: "declined" as const,
          declineNote: "not answered by the client",
        },
      ],
      saturated: true,
      canProceed: true,
      closedAt: new Date(),
    })
    .run();

  if (spec.redFlag === true) {
    db.insert(safetyScreens)
      .values({
        caseId,
        screenType: "keyword" as const,
        redFlags: ["physical_violence"],
        outcome: "refuse" as const,
      })
      .run();
  }

  return { caseId, citable, pending, ungraded };
}

/* -------------------------------------------------------------------------- */
/* Recorded answers                                                           */
/* -------------------------------------------------------------------------- */

/** A clean L2 fact layer: no allocation, one hole named as a hole. */
export function factLayerL2(seeded: Seeded): FactLayer {
  return {
    claims: [
      {
        claim_id: "c1",
        statement: '甲 asked for the argument to be settled that day: "这件事今天必须说清楚".',
        evidence_refs: [seeded.citable[0]],
        confidence: 0.9,
        tier: "high_confidence",
      },
      {
        claim_id: "c2",
        statement: "What 乙 said in reply is not in the confirmed record.",
        evidence_refs: [],
        confidence: 0.1,
        tier: "unknown",
      },
    ],
    findings: {
      record_basis: {
        client_pseudonym: "乙",
        citable_utterances: {
          total: seeded.citable.length,
          by_client: 0,
          by_counterparty: seeded.citable.length,
        },
        parties_without_citable_utterance: ["乙"],
        statement:
          "This analysis could read only 甲's words. 乙 has lines on file, none " +
          "confirmed, so 乙 has not spoken inside this record.",
      },
      unresolved: [
        {
          question: "What did 乙 say back that evening?",
          reason: "clarification_unanswered",
          claim_ids: ["c2"],
        },
      ],
      responsibility: [],
    },
  };
}

/** A clean surface layer over `factLayerL2`, with one self-only section. */
export function surfaceLayerL2(text?: string): SurfaceLayer {
  return {
    sections: [
      {
        section_id: "basis",
        kind: "disclosure",
        audience: "both",
        heading: "What this judgment could read",
        text:
          "This judgment could read 甲's confirmed lines and nothing of 乙's. " +
          "It did not allocate responsibility between the two of you.",
        claim_ids: [],
      },
      {
        section_id: "finding",
        kind: "finding",
        audience: "self_only",
        heading: "The deadline",
        text:
          text ??
          '甲 asked for the argument to be settled that day: "这件事今天必须说清楚". ' +
            "You let it run past that, and you have acknowledged as much.",
        claim_ids: ["c1"],
      },
      {
        section_id: "limits",
        kind: "limits",
        audience: "both",
        heading: "What this cannot decide",
        text: "Nothing here establishes what 乙 said in reply.",
        claim_ids: ["c2"],
      },
    ],
  };
}

/**
 * One advocate brief, for one party, grounded in that party's own lines.
 *
 * Every field is passed in rather than derived from the party's name, so two
 * calls produce two genuinely different documents — different prose, different
 * concession, different utterance ids. A harness that answered both seats from
 * one template would replay a pair that filed the same brief twice, and a
 * hearing reading one document twice proves nothing about the independence the
 * two seats exist to have (doc 05 §B.3).
 *
 * `can_produce` is true here because both parties have confirmed lines in the
 * only fixture that runs a pair. The false answer is a real one the schema
 * carries, and it belongs in a fixture built to exercise it.
 */
function advocateBriefFor(
  party: string,
  brief: {
    readonly headline: string;
    readonly point: string;
    readonly pointRefs: readonly string[];
    readonly reading: string;
    readonly whyNotForced: string;
    readonly readingRefs: readonly string[];
    readonly concession: string;
    readonly concessionRefs: readonly string[];
    /** A second point, where the party's material carries one. */
    readonly second?: { readonly point: string; readonly refs: readonly string[] };
  },
): AdvocateBriefOutput {
  return {
    for_party: party,
    can_produce: true,
    unable_reason: null,
    headline: brief.headline,
    strongest_case: [
      { point: brief.point, grounded_in: [...brief.pointRefs] },
      ...(brief.second === undefined
        ? []
        : [{ point: brief.second.point, grounded_in: [...brief.second.refs] }]),
    ],
    not_forced_by_the_record: [
      {
        reading: brief.reading,
        why_not_forced: brief.whyNotForced,
        grounded_in: [...brief.readingRefs],
      },
    ],
    must_concede: [
      { concession: brief.concession, grounded_in: [...brief.concessionRefs] },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The fixtures                                                               */
/* -------------------------------------------------------------------------- */

export type ExpectedOutcome =
  | { readonly kind: "published" }
  | { readonly kind: "no_material" }
  | { readonly kind: "blocked" }
  | { readonly kind: "rejected"; readonly code: JudgmentRejectionCode };

/**
 * What the gated hearing must actually have DONE, over and above what it
 * produced (M6 batch 2, doc 05 §B).
 *
 * Recorded per fixture because the interesting failures here are invisible in a
 * finished document: a pair that never ran, a swap arm that was never heard, a
 * disclosure the document did not carry. A published judgment looks the same
 * whether or not it was tested, which is exactly why the test has to be asserted
 * separately from the output.
 */
export interface ExpectedHearing {
  /**
   * Pseudonyms the advocate seats were told to write for, sorted. Empty below
   * L1, where the pair does not run and the single steelman IS the advocate.
   */
  readonly advocateParties: readonly string[];
  /**
   * Pseudonyms each skeleton arm's own register named as the party who brought
   * the case, sorted and de-duplicated. Two entries means both seatings were
   * genuinely heard; one means the swap arm never ran.
   */
  readonly skeletonSeatings: readonly string[];
  /** What the swap gate decided about this generation. */
  readonly gate: SwapGateDisposition;
  /**
   * Substrings the published document's own limits section must contain. Empty
   * means the gate had nothing to disclose and the server section is absent —
   * which is itself asserted, so "no disclosure" cannot pass as "disclosure not
   * checked".
   */
  readonly disclosureContains: readonly string[];
}

export interface GoldenFixture {
  readonly id: string;
  /** One line: what this case is here to prove. */
  readonly what: string;
  readonly spec: SeedSpec;
  readonly expectLevel: OutputLevel;
  /** Omit to check the level only (a refused case never reaches a hearing). */
  readonly replay?: {
    /**
     * The fact layer, recorded per **seating**.
     *
     * `client` is the pseudonym the arm being heard names as the party who
     * brought the case — 乙 as filed, and the other party on the swap arm, which
     * is the one thing the register exchange moves. Below L1 there is no swap
     * arm and the parameter is the filed client every time.
     */
    readonly factLayer: (seeded: Seeded, client: string) => FactLayer;
    readonly surfaceLayer: (seeded: Seeded) => SurfaceLayer;
    /**
     * One advocate brief, for the party the seat was handed (L1 only).
     *
     * Required at L1: `runGatedHearing` runs the blind pair before the first
     * skeleton call, and a fixture with no recording for it replays a hearing
     * the product does not have.
     */
    readonly advocateBrief?: (seeded: Seeded, party: string) => AdvocateBriefOutput;
  };
  readonly expectOutcome?: ExpectedOutcome;
  /** Golden check ids that MUST fire on the published judgment. */
  readonly expectFindings?: readonly string[];
  /** True when `renderShareable` is expected to refuse the document. */
  readonly expectShareRefused?: boolean;
  /** See `ExpectedHearing`. Omitted where the hearing's shape is not the point. */
  readonly expectHearing?: ExpectedHearing;
}

const clean = {
  factLayer: factLayerL2,
  surfaceLayer: () => surfaceLayerL2(),
};

export const FIXTURES: readonly GoldenFixture[] = [
  {
    id: "one_sided_L2",
    what:
      "the one-sided shape — only the counterparty has confirmed lines, so " +
      "the level is capped at L2 and the hearing goes through",
    spec: {},
    expectLevel: "L2",
    replay: clean,
    expectOutcome: { kind: "published" },
    // The negative control for the fixture below: at a level that allocates no
    // responsibility there is no pair, no swap arm and nothing for the gate to
    // disclose. Asserted rather than assumed — "the pair did not run" and "the
    // harness never checked" look identical in a passing run.
    expectHearing: {
      advocateParties: [],
      skeletonSeatings: ["乙"],
      gate: "not_applicable",
      disclosureContains: [],
    },
  },
  {
    id: "bilateral_L1",
    what:
      "both parties present and grounded — the only shape that licenses a " +
      "responsibility allocation",
    spec: {
      counterpartyState: "participating",
      clientLines: ["我知道我拖了，但那天我真的在加班"],
      // The half that used to be missing. Before M5 ⑥ this fixture bought L1
      // with `counterpartyState: "participating"` alone — the CLIENT'S REPORT
      // about her — and the tightening made that L2 (`one_sided_material`)
      // without touching the fixture, which is how the harness caught it.
      counterpartyOwnLines: ["我提前一天就说了那天要加班，他说随便"],
      grades: ["B", "B"],
    },
    expectLevel: "L1",
    replay: {
      // The blind pair, which since M6 batch 2 runs before the first skeleton
      // call at L1 (doc 05 §B). Two seats, two parties, two different
      // documents — see `advocateBriefFor`.
      advocateBrief: (seeded, party) =>
        party === "乙"
          ? advocateBriefFor("乙", {
              headline:
                "乙 would say the delay was a working evening he named at the " +
                "time, not a refusal he explained afterwards.",
              point:
                '乙 gave his reason while it was still that evening: "我知道我拖了，但那天我真的在加班".',
              pointRefs: [seeded.citable[2]],
              reading: "That the work was a cover for not having the conversation.",
              whyNotForced:
                "The record has the reason he gave and the evening he gave it " +
                "about. What he did with the rest of that evening is not in it, " +
                "so that reading is permitted and not established.",
              readingRefs: [seeded.citable[2]],
              concession: '乙 put the delay in his own words: "我知道我拖了".',
              concessionRefs: [seeded.citable[2]],
            })
          : advocateBriefFor("甲", {
              headline:
                "甲 would say she asked for the same day and had flagged that " +
                "evening a day ahead of it.",
              point:
                '甲 asked in plain terms for it to be settled that day: "这件事今天必须说清楚".',
              pointRefs: [seeded.citable[0]],
              reading: "That 甲 announced a deadline the two of them never agreed.",
              whyNotForced:
                "The record has her request and her account of raising the " +
                "evening the day before. Whether a deadline was ever agreed " +
                "between them is not in it either way.",
              readingRefs: [seeded.citable[0], seeded.citable[3]],
              concession:
                "The same-day request stands in the record as 甲's request, with " +
                "nothing showing it was agreed rather than announced.",
              concessionRefs: [seeded.citable[0]],
              second: {
                point:
                  '甲 says the evening was flagged in advance and drew no objection: "我提前一天就说了那天要加班，他说随便".',
                refs: [seeded.citable[3]],
              },
            }),
      // Recorded per seating. The exchange moves the client marker and nothing
      // else — 甲's words are 甲's in both arms — so the counts follow whoever
      // this arm calls the client, and the allocation, which was drawn from the
      // lines rather than from who filed, comes back the same either way. That
      // is what lets the gate publish it intact.
      factLayer: (seeded, client) => ({
        claims: [
          {
            claim_id: "c1",
            statement: '甲 asked for the argument to be settled that day: "这件事今天必须说清楚".',
            evidence_refs: [seeded.citable[0]],
            confidence: 0.9,
            tier: "high_confidence",
          },
          {
            claim_id: "c2",
            statement: '乙 gave a reason for the delay: "我知道我拖了，但那天我真的在加班".',
            evidence_refs: [seeded.citable[2]],
            confidence: 0.85,
            tier: "high_confidence",
          },
          {
            // The claim that only a bilateral record can carry: it rests on a
            // line 甲 submitted herself, not on one quoted out of 乙's material.
            claim_id: "c3",
            statement:
              '甲 says the evening was flagged in advance: "我提前一天就说了那天要加班，他说随便".',
            evidence_refs: [seeded.citable[3]],
            confidence: 0.8,
            tier: "high_confidence",
          },
        ],
        findings: {
          record_basis: {
            client_pseudonym: client,
            // 乙 has one confirmed line and 甲 has three, whichever of them the
            // arm's register is calling the client.
            citable_utterances:
              client === "乙"
                ? { total: 4, by_client: 1, by_counterparty: 3 }
                : { total: 4, by_client: 3, by_counterparty: 1 },
            parties_without_citable_utterance: [],
            statement:
              "Both parties have confirmed lines in this record, and each of " +
              "them put material of their own into it.",
          },
          unresolved: [],
          responsibility: [
            {
              party: "乙",
              allocation: "primary",
              rationale:
                "乙 let a same-day request run past the day without answering it.",
              claim_ids: ["c1", "c2"],
            },
            {
              party: "甲",
              allocation: "shared",
              rationale:
                "甲 set the deadline without agreeing it first, on an evening " +
                "she had been told about.",
              claim_ids: ["c1", "c3"],
            },
          ],
        },
      }),
      surfaceLayer: () => ({
        sections: [
          {
            section_id: "finding",
            kind: "finding",
            audience: "both",
            heading: "The deadline",
            text:
              "甲 asked for an answer that day; 乙 did not give one until " +
              "later, on an evening 甲 had been told about the day before.",
            claim_ids: ["c1", "c2", "c3"],
          },
          {
            section_id: "responsibility",
            kind: "finding",
            audience: "both",
            heading: "Where this mostly sits",
            text:
              "Most of this sits with 乙, who let a same-day request run past " +
              "the day. 甲 shares it: the deadline was set, not agreed.",
            claim_ids: ["c1", "c2"],
          },
        ],
      }),
    },
    expectOutcome: { kind: "published" },
    expectHearing: {
      advocateParties: ["乙", "甲"],
      // Both seatings, which is the whole of the swap pass: the same record
      // heard once as filed and once with 甲 in the chair 乙 filed from.
      skeletonSeatings: ["乙", "甲"],
      gate: "published_intact",
      disclosureContains: [
        "heard twice",
        "positions in the register exchanged",
        "The allocation came back the same either way",
      ],
    },
  },
  {
    id: "nothing_citable_L3",
    what:
      "nothing confirmed and nothing first-hand — the level drops to L3 and " +
      "the hearing refuses to adjudicate rather than adjudicating thinly",
    spec: {
      counterpartyLines: [],
      clientPending: ["我当时在加班"],
      grades: ["C"],
    },
    expectLevel: "L3",
    replay: clean,
    expectOutcome: { kind: "no_material" },
  },
  {
    id: "safety_refused",
    what: "a red flag forces `refused`, whatever the rest of the record says",
    spec: { redFlag: true, counterpartyState: "participating" },
    expectLevel: "refused",
  },
  {
    id: "adverse_fact_unanswered",
    what:
      "the anti-'help me win' gate: an unanswered adverse fact blocks the " +
      "hearing before a model is asked anything",
    spec: { adverseFactPending: true },
    expectLevel: "L2",
    replay: clean,
    expectOutcome: { kind: "blocked" },
  },

  /* --- the ones built to be caught ---------------------------------------- */

  {
    id: "cites_unconfirmed_line",
    what: "HARD RULE #1: a claim citing a line the client never confirmed",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: (seeded) => {
        const base = factLayerL2(seeded);
        return {
          ...base,
          claims: [
            { ...base.claims[0], evidence_refs: [seeded.pending[0]] },
            base.claims[1],
          ],
        };
      },
      surfaceLayer: () => surfaceLayerL2(),
    },
    expectOutcome: { kind: "rejected", code: "invalid_refs" },
  },
  {
    id: "cites_nonexistent_line",
    what: "HARD RULE #1: a claim citing an utterance id that does not exist",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: (seeded) => {
        const base = factLayerL2(seeded);
        return {
          ...base,
          claims: [
            {
              ...base.claims[0],
              evidence_refs: ["00000000-0000-4000-8000-000000000000"],
            },
            base.claims[1],
          ],
        };
      },
      surfaceLayer: () => surfaceLayerL2(),
    },
    expectOutcome: { kind: "rejected", code: "invalid_refs" },
  },
  {
    id: "allocates_at_L2",
    what:
      "HARD RULE #2: responsibility allocated at a level that heard one side",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: (seeded) => {
        const base = factLayerL2(seeded);
        return {
          ...base,
          findings: {
            ...base.findings,
            responsibility: [
              {
                party: "乙",
                allocation: "primary",
                rationale: "乙 did not answer in time.",
                claim_ids: ["c1"],
              },
            ],
          },
        };
      },
      surfaceLayer: () => surfaceLayerL2(),
    },
    expectOutcome: { kind: "rejected", code: "level_violation" },
  },
  {
    id: "understates_its_own_hole",
    what:
      "the record basis is arithmetic: a judgment may choose its words about " +
      "the hole in its evidence, not its size",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: (seeded) => {
        const base = factLayerL2(seeded);
        return {
          ...base,
          findings: {
            ...base.findings,
            record_basis: {
              ...base.findings.record_basis,
              citable_utterances: { total: 2, by_client: 1, by_counterparty: 1 },
              parties_without_citable_utterance: [],
            },
          },
        };
      },
      surfaceLayer: () => surfaceLayerL2(),
    },
    expectOutcome: { kind: "rejected", code: "record_basis_mismatch" },
  },
  {
    id: "narrative_outruns_skeleton",
    what: "a paragraph resting on a claim the fact layer never made",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: factLayerL2,
      surfaceLayer: () => ({
        sections: [
          {
            section_id: "invented",
            kind: "finding",
            audience: "both",
            heading: "Something nobody checked",
            text: "甲 has done this repeatedly over the past year.",
            claim_ids: ["c99"],
          },
        ],
      }),
    },
    expectOutcome: { kind: "rejected", code: "contract_violation" },
  },
  {
    id: "percentage_in_the_prose",
    what:
      "a responsibility percentage in a section both parties can read — the " +
      "contract permits it, the outward invariant does not",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: factLayerL2,
      surfaceLayer: () => ({
        sections: [
          {
            section_id: "basis",
            kind: "disclosure",
            audience: "both",
            heading: "What this judgment could read",
            text: "About 70% of this sits with 乙 on the record as it stands.",
            claim_ids: [],
          },
          {
            section_id: "limits",
            kind: "limits",
            audience: "both",
            heading: "What this cannot decide",
            text: "Nothing here establishes what 乙 said in reply.",
            claim_ids: ["c2"],
          },
        ],
      }),
    },
    expectOutcome: { kind: "published" },
    expectFindings: ["no_responsibility_percentage"],
    expectShareRefused: true,
  },
  {
    id: "characterizes_the_silent_party",
    what:
      "a character label attached to the party with no confirmed line — on " +
      "this record's shape that party is the client, not the counterparty",
    spec: {},
    expectLevel: "L2",
    replay: {
      factLayer: factLayerL2,
      surfaceLayer: () =>
        surfaceLayerL2(
          "乙 is being manipulative here, and wanted to drag it out so that " +
            "甲 would give up asking.",
        ),
    },
    expectOutcome: { kind: "published" },
    expectFindings: ["no_absent_party_characterization"],
  },
  {
    id: "claim_on_ungraded_evidence",
    what:
      "a claim resting on a confirmed line whose source evidence no human ever " +
      "graded — citable, and carrying no evidence grade",
    spec: { withUngradedLine: true },
    expectLevel: "L2",
    replay: {
      factLayer: (seeded) => {
        const base = factLayerL2(seeded);
        return {
          ...base,
          claims: [
            { ...base.claims[0], evidence_refs: [seeded.ungraded!] },
            base.claims[1],
          ],
        };
      },
      surfaceLayer: () => surfaceLayerL2(),
    },
    expectOutcome: { kind: "published" },
    expectFindings: ["claim_grade"],
  },
];
