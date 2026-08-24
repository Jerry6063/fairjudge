/**
 * The invariants a judgment has to satisfy no matter which case it came from —
 * SPEC M3 wave B ⑬, the checking half of `npm run eval:golden`.
 *
 * These are not the contract checks. `judgment/contract.ts` asks whether a
 * document holds together, and `judgment/generation.ts` asks whether it holds up
 * against the record; both run inside the pipeline and both can be satisfied by
 * a judgment nobody should ship. What is checked here is the outward promise —
 * what a reader of the finished document is entitled to assume — re-derived from
 * the stored artifact rather than from the run that produced it. A check that
 * only ever runs on the pipeline's own return value cannot notice a judgment
 * that was written before the rule existed.
 *
 * ## Two severities, and why the softer one exists
 *
 * `violation` is fatal: the harness fails and the run is not green. Every check
 * at this severity answers a question with one right answer — does this
 * citation resolve to a confirmed line in this case, does this claim rest on
 * graded evidence, is there a responsibility percentage in this rendition.
 *
 * `review` is printed and does not fail anything. There is exactly one such
 * check — motive attribution to the absent party — and it is soft because the
 * distinction it is chasing is not lexical. "甲 asked for an answer that day"
 * and "甲 wanted to corner him" differ in what they claim about a mind, not in
 * their vocabulary, and a pattern list that fails a build on the second will
 * eventually fail it on the first. The same argument that kept regex assertions
 * out of the (since removed) polish validation chain applies here:
 * a check that gets believed has to be one that is right. So the motive scan
 * reports sentences for a human to read, and says so in its own output, rather
 * than certifying an absence it cannot establish.
 *
 * Character *epithets* are a different matter and are fatal: "manipulative",
 * "narcissistic", "toxic" are labels applied to a person, not readings of a
 * situation, and there is no legitimate sentence of a one-sided judgment that
 * attaches one to a party who never spoke.
 *
 * ## Verbatim quotes are stripped before any scan
 *
 * A counterparty who wrote `"这事你占七成责任"` is a fact about the record. The
 * checks run over the judgment's own prose (`stripVerbatimQuotes`), because
 * suppressing evidence to pass our own test would be rewriting evidence —
 * the same rule `rendition.ts` follows for the shareable language check.
 */

import { eq, inArray } from "drizzle-orm";

import type { Db } from "../db";
import { evidence as evidenceTable, utterances } from "../db/schema";
import type { FactLayer } from "../judgment/contract";
import { stripVerbatimQuotes } from "../judgment/rendition";
import { auditCitations, describeCitationFaults } from "../pipeline/evidence-refs";

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type GoldenSeverity = "violation" | "review";

export interface GoldenFinding {
  /** Stable check id, so a report can be diffed between runs. */
  readonly check: string;
  readonly severity: GoldenSeverity;
  /** Which document this was found in ("fact layer", "shareable", …). */
  readonly where: string;
  readonly detail: string;
}

function violation(check: string, where: string, detail: string): GoldenFinding {
  return { check, severity: "violation", where, detail };
}

/* -------------------------------------------------------------------------- */
/* ① Citations resolve, and resolve to confirmed lines                        */
/* -------------------------------------------------------------------------- */

/**
 * HARD RULE #1, re-checked against SQLite from the stored fact layer.
 *
 * Deliberately re-runs the pipeline's own auditor rather than reimplementing
 * it: two copies of "is this citable" is how the two answers drift apart. What
 * makes this a different check is *when* it runs — against the frozen judgment,
 * whenever the harness is run, rather than once at generation time.
 *
 * `unknown`-tier claims are excluded because the contract requires them to cite
 * nothing; that they cite nothing is checked below, not here.
 */
export function checkCitations(
  db: Db,
  caseId: string,
  factLayer: FactLayer,
  where = "fact layer",
): GoldenFinding[] {
  const citing = factLayer.claims
    .filter((claim) => claim.tier !== "unknown")
    .map((claim) => ({
      label: claim.claim_id,
      statement: claim.statement,
      evidenceRefs: claim.evidence_refs,
    }));

  if (citing.length === 0) return [];

  const audit = auditCitations(db, caseId, citing);
  if (audit.ok) return [];
  return [violation("citations_resolve", where, describeCitationFaults(audit))];
}

/* -------------------------------------------------------------------------- */
/* ② Every claim carries an evidence grade and a confidence tier              */
/* -------------------------------------------------------------------------- */

/**
 * A claim is either grounded in graded material or is not grounded at all.
 *
 * The tier and the confidence are guaranteed by the schema, so the part worth
 * checking here is the grade: an `evidence_ref` points at an utterance, an
 * utterance comes out of a piece of evidence, and that evidence carries
 * `grade_final` — the human-confirmed column, never the machine's suggestion
 * (M2 decision record). A claim resting on a line whose source was never graded
 * has no evidence grade, however confident it sounds.
 *
 * An `unknown`-tier claim citing nothing is the correct shape and is checked
 * for the opposite property: it must cite nothing, or it is a claim pretending
 * to be a hole.
 */
export function checkClaimGrading(
  db: Db,
  factLayer: FactLayer,
  where = "fact layer",
): GoldenFinding[] {
  const findings: GoldenFinding[] = [];

  const refs = [
    ...new Set(factLayer.claims.flatMap((claim) => [...claim.evidence_refs])),
  ];
  const grades = new Map<string, string | null>();
  if (refs.length > 0) {
    for (const row of db
      .select({
        utteranceId: utterances.id,
        grade: evidenceTable.gradeFinal,
      })
      .from(utterances)
      .leftJoin(evidenceTable, eq(utterances.evidenceId, evidenceTable.id))
      .where(inArray(utterances.id, refs))
      .all()) {
      grades.set(row.utteranceId, row.grade);
    }
  }

  for (const claim of factLayer.claims) {
    if (claim.tier === "unknown") {
      if (claim.evidence_refs.length > 0) {
        findings.push(
          violation(
            "claim_grade",
            where,
            `claim ${claim.claim_id} is tier "unknown" and cites ` +
              `${claim.evidence_refs.length} line(s). An unknown claim is the ` +
              `judgment naming a hole in its own record; citing evidence for one ` +
              `makes it a finding wearing a hole's label.`,
          ),
        );
      }
      continue;
    }

    if (claim.evidence_refs.length === 0) {
      findings.push(
        violation(
          "claim_grade",
          where,
          `claim ${claim.claim_id} (tier ${claim.tier}) cites nothing, so it ` +
            `carries no evidence grade.`,
        ),
      );
      continue;
    }

    const ungraded = claim.evidence_refs.filter(
      (ref) => (grades.get(ref) ?? null) === null,
    );
    if (ungraded.length > 0) {
      findings.push(
        violation(
          "claim_grade",
          where,
          `claim ${claim.claim_id} rests on ${ungraded.length} line(s) whose ` +
            `source evidence has no confirmed grade (grade_final is NULL): ` +
            `${ungraded.join(", ")}.`,
        ),
      );
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* ③ No responsibility percentage                                             */
/* -------------------------------------------------------------------------- */

/**
 * A share of blame, expressed as a number, anywhere a reader can see it.
 *
 * Three spellings, because this product is read in two languages: `70%`,
 * "70 percent", and the Chinese `七成` / `七分` construction. Verbatim quotes are
 * stripped first — a party who said `"这事你占七成责任"` said it, and the record
 * keeps it.
 */
const PERCENT_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "digits + %", re: /\d+(?:\.\d+)?\s*%/g },
  { label: "percent / per cent", re: /\d+(?:\.\d+)?\s*per\s?cent\b/gi },
  { label: "N 成 / N 分 responsibility", re: /[一二三四五六七八九十两0-9]+\s*[成分]\s*(?:的)?\s*责任/g },
];

export function checkNoResponsibilityPercentage(
  text: string,
  where: string,
): GoldenFinding[] {
  const prose = stripVerbatimQuotes(text);
  const findings: GoldenFinding[] = [];

  for (const { label, re } of PERCENT_PATTERNS) {
    const hits = [...prose.matchAll(new RegExp(re.source, re.flags))].map(
      (match) => match[0],
    );
    if (hits.length > 0) {
      findings.push(
        violation(
          "no_responsibility_percentage",
          where,
          `${hits.length} numeric share(s) of responsibility (${label}): ` +
            `${hits.join(", ")}.`,
        ),
      );
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* ④ Nothing said about the absent party's character or motives               */
/* -------------------------------------------------------------------------- */

/**
 * Labels applied to a person rather than readings of a situation.
 *
 * Kept short and kept to epithets on purpose: every entry is a word that
 * describes what someone *is*, and none of them has a use in a judgment written
 * from two confirmed sentences.
 */
const CHARACTER_EPITHETS: readonly string[] = [
  "abusive",
  "callous",
  "calculating",
  "controlling",
  "cruel",
  "dishonest",
  "gaslighting",
  "hysterical",
  "immature",
  "manipulative",
  "narcissistic",
  "petty",
  "selfish",
  "toxic",
  "vindictive",
];

/**
 * Constructions that assert why someone did something.
 *
 * Reported, never fatal — see the module header. The list is written to catch
 * the shape of a motive claim ("in order to", "was trying to", "deliberately"),
 * which is also the shape of several perfectly legitimate sentences.
 */
const MOTIVE_PATTERNS: readonly string[] = [
  "in order to",
  "so that",
  "was trying to",
  "were trying to",
  "wanted to",
  "intended to",
  "deliberately",
  "on purpose",
  "to punish",
  "to control",
  "to manipulate",
  "to humiliate",
  "her goal",
  "his goal",
  "their goal",
  "because they wanted",
  "because she wanted",
  "because he wanted",
];

/** Split into sentences, keeping enough context to quote one back. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Scan for characterization of a party who has not spoken in the record.
 *
 * `absent` is the pseudonym list — the parties with no confirmed utterance of
 * their own, which on a record submitted as the counterparty's own screenshots
 * is the *client*, not the counterparty. That inversion is the point of taking
 * the list as a parameter instead of assuming the absent party is the one being
 * judged.
 */
export function checkAbsentPartyCharacterization(
  text: string,
  absent: readonly string[],
  where: string,
): GoldenFinding[] {
  if (absent.length === 0) return [];

  const findings: GoldenFinding[] = [];
  const prose = stripVerbatimQuotes(text);

  for (const sentence of sentences(prose)) {
    const named = absent.filter((pseudonym) => sentence.includes(pseudonym));
    if (named.length === 0) continue;

    const lower = sentence.toLowerCase();

    const epithets = CHARACTER_EPITHETS.filter((word) => lower.includes(word));
    if (epithets.length > 0) {
      findings.push(
        violation(
          "no_absent_party_characterization",
          where,
          `character label(s) ${epithets.join(", ")} applied in a sentence ` +
            `naming ${named.join(", ")}, who has no confirmed line in this ` +
            `record: "${sentence}"`,
        ),
      );
    }

    const motives = MOTIVE_PATTERNS.filter((phrase) => lower.includes(phrase));
    if (motives.length > 0) {
      findings.push({
        check: "absent_party_motive_review",
        severity: "review",
        where,
        detail:
          `motive construction(s) ${motives.join(", ")} in a sentence naming ` +
          `${named.join(", ")}: "${sentence}" — read it and decide; this check ` +
          `cannot tell a claim about a mind from a description of an act.`,
      });
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                  */
/* -------------------------------------------------------------------------- */

export interface RenditionUnderTest {
  readonly where: string;
  readonly text: string;
}

/**
 * Every invariant, over one published judgment.
 *
 * `absent` is computed by the caller from the record (`computeRecordAsymmetry`'s
 * `partiesWithoutCitableUtterance`), not from the judgment — a judgment that has
 * mis-stated who is missing must not also get to choose who the check protects.
 */
export function checkJudgment(
  db: Db,
  caseId: string,
  factLayer: FactLayer,
  renditions: readonly RenditionUnderTest[],
  absent: readonly string[],
): GoldenFinding[] {
  const findings: GoldenFinding[] = [
    ...checkCitations(db, caseId, factLayer),
    ...checkClaimGrading(db, factLayer),
  ];

  for (const rendition of renditions) {
    findings.push(
      ...checkNoResponsibilityPercentage(rendition.text, rendition.where),
      ...checkAbsentPartyCharacterization(rendition.text, absent, rendition.where),
    );
  }

  return findings;
}

/** Fatal findings only. */
export function fatal(findings: readonly GoldenFinding[]): GoldenFinding[] {
  return findings.filter((finding) => finding.severity === "violation");
}
