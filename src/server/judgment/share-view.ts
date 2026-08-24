/**
 * The read model behind `/case/[id]/share` — the one screen in this product that
 * shows the one artifact that ever leaves this machine.
 *
 * Everything here is a READ. Nothing in this module writes a row, mints a token,
 * exports a copy or changes a rule. The export gate (`export-gate.ts`), the
 * rendition frame (`rendition.ts`) and the consent log (`access/consent.ts`) are
 * the authorities; this module runs their own exported checks over the document
 * that is about to be shown and reports, check by check, what each one examined
 * and what it concluded.
 *
 * ## Why a report rather than a green tick
 *
 * The export gate already refuses a bad document, and it says why in a message
 * nobody reads until they are already blocked. That is the wrong moment. The
 * person on this screen is deciding whether to hand a document about somebody to
 * that somebody, and the checks are the only evidence they have that the document
 * is safe to hand over. A tick asserts the conclusion; a report shows the work —
 * which names were scanned for, which quotes were found, which of them the
 * attribution rule exempted and on what grounds. The quote exemption in
 * particular is a deliberate ruling (SPEC M4 decision record, 2026-08-10) and a
 * reader should be able to audit it, which means seeing the quote.
 *
 * ## The preview is a dry run, and it is not the gate
 *
 * `checkExportGate` runs the gate's exported check functions in the gate's own
 * order over the same text. It cannot BE the gate: the gate writes an audit row
 * on success, and auditing a copy that never left would make the log lie. So the
 * relationship is stated rather than hidden — the preview is advisory, the export
 * re-runs every check for real, and the one thing this module re-derives rather
 * than calls (which participant is the recipient) is a lookup, not a rule. If
 * the two ever disagree the export refuses, which is the safe direction.
 *
 * ## The known unfairness this module refuses to hide
 *
 * At L1 the `audience` rule inverts (SPEC M5 decision record, 2026-08-14, open):
 * `audience: self_only` is a fixed section property, so at L1 the counterparty
 * receives the responsibility finding against her and not the one against him,
 * while the limits section she does receive asserts an allocation she cannot see.
 * `describeL1AudienceDefect` detects that the document on screen was issued at L1
 * and hands the screen the concrete evidence — which sections are withheld, which
 * allocations the frozen fact layer holds, and where the document asserts one.
 * A screen that rendered an L1 document without saying this would be doing the
 * exact thing the export gate exists to prevent, one layer up.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  namedRenditionConsent,
  readCaseConsentState,
  NamedRenditionRevokedError,
  type CaseConsentState,
  type NamedRenditionConsent,
} from "../access/consent";
import type { Db } from "../db";
import {
  caseParticipants,
  judgmentRenditions,
  type OutputLevel,
  type RenditionKind,
} from "../db/schema";
import { buildCaseDict } from "../evidence/anomaly";
import { readClarification } from "../pipeline/clarification";
import { detectUnregisteredNames, type PersonDict } from "../pseudonym";
import {
  JudgmentStoreError,
  assertShareTokenAllowed,
  readCurrentJudgment,
  readJudgment,
  type JudgmentRecord,
  type JudgmentSection,
  type ResponsibilityFinding,
  type SurfaceLayer,
} from "./contract";
import {
  ExportBlockedError,
  MAX_THIRD_PARTY_QUOTE_CHARS,
  assertExportAllowed,
  composeWatermark,
  deriveNameFragments,
  findVerbatimQuotes,
  isRecipientQuote,
  listCaseExports,
  scanRealNames,
  stripExportMetadata,
  type ExportAuditRecord,
} from "./export-gate";
import {
  DEFAULT_RESPONSE_ENTRY_POINT,
  INVITATION_TEXT,
  RESPONSE_PROMPT,
  RenditionError,
  assertShareable,
  findProvenanceNotice,
  hasProvenanceNotice,
  readShareableNarrative,
  renderJudgmentRendition,
} from "./rendition";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The only kind this screen ever asks for.
 *
 * `self_reflection` carries the criticism written for the client alone. It has
 * no place on a screen whose whole subject is what the OTHER party receives, so
 * the preview path does not take the kind from a caller at all — it is this
 * constant, and {@link previewShareableDocument} asserts it through the gate's
 * own `assertExportAllowed` besides.
 */
export const SHARE_PREVIEW_KIND: RenditionKind = "shareable";

/**
 * The export id printed in the preview's watermark.
 *
 * All zeroes, and a real UUID shape, so the preview shows the watermark's real
 * geometry without inventing an audit row id that resolves to nothing. The
 * export stamps the actual row's id in this position.
 */
export const PREVIEW_EXPORT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The cool-down buffer, doc 01 §post-judgment ③: 24–48 hours before sharing.
 *
 * Measured from when the document that would be sent was WRITTEN, not from when
 * somebody first opened this screen. That anchor is already stored
 * (`judgment_renditions.generated_at`), it needs no new column, and — the reason
 * it is the right one — it cannot be started by clicking. A pause you can begin
 * by pressing a button is a pause you can begin and then immediately ignore.
 */
export const COOLING_OFF_MIN_MS = 24 * 60 * 60 * 1000;

/** The far end of doc 01's window. Past this the pause has fully run. */
export const COOLING_OFF_SETTLED_MS = 48 * 60 * 60 * 1000;

/** The shortest answer to the doc 01 question that is an answer at all. */
export const MIN_SEND_INTENT_CHARS = 6;

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type SharePreviewErrorCode =
  | "no_judgment"
  | "not_final"
  /** The counterparty narrative has not been generated. There is no document. */
  | "shareable_narrative_missing"
  | "rendition_missing"
  /** The stored document does not hold up — the render layer refused it. */
  | "document_refused"
  /** Who this copy is for could not be established from the case. */
  | "recipient_unknown";

export interface SharePreviewProblem {
  readonly code: SharePreviewErrorCode;
  /** What is missing, in the words the screen prints. */
  readonly message: string;
  /** What to run to fix it, when there is such a thing. */
  readonly hint: string | null;
}

/* -------------------------------------------------------------------------- */
/* The recipient                                                              */
/* -------------------------------------------------------------------------- */

export interface ShareViewRecipient {
  /** Pseudonym of the person this copy is written to. Never a real name. */
  readonly pseudonym: string;
  readonly participantId: string | null;
  /** Everybody else who could be quoted in it — the quote rule's other side. */
  readonly others: readonly string[];
  /** How it was decided, printed so the reader can disagree with it. */
  readonly basis: string;
}

/**
 * Who receives this copy.
 *
 * A LOOKUP, not a rule: the case's one non-submitting participant, which is what
 * `resolveRecipient` inside the export gate reads too. It is duplicated here
 * rather than exported from there because the gate's copy is private to a path
 * that writes, and this module may not import a writer's internals — but that
 * means the two must agree, so this states the direction of failure out loud: the gate
 * resolves the recipient again at export time and refuses (`recipient_unknown`)
 * if it cannot, so a disagreement blocks the export rather than passing a wrong
 * one. The preview says who it thinks it is; the export decides.
 */
export function resolveShareRecipient(
  db: Db,
  caseId: string,
  judgment: JudgmentRecord,
): ShareViewRecipient | null {
  const participants = db
    .select({
      id: caseParticipants.id,
      pseudonym: caseParticipants.pseudonym,
      isSubmitter: caseParticipants.isSubmitter,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all();

  const everyone = new Set<string>(participants.map((row) => row.pseudonym));
  everyone.add(judgment.factLayer.findings.record_basis.client_pseudonym);

  const candidates = participants.filter((row) => !row.isSubmitter);
  if (candidates.length !== 1) return null;

  const recipient = candidates[0];
  return {
    pseudonym: recipient.pseudonym,
    participantId: recipient.id,
    others: [...everyone].filter((name) => name !== recipient.pseudonym).sort(),
    basis:
      `the one participant on this case who did not bring it` +
      `${participants.length === 0 ? "" : ` (of ${participants.length} on file)`}`,
  };
}

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The stored counterparty document, rendered exactly as the recipient gets it.
 *
 * Goes through `renderJudgmentRendition`, which is the same function the export
 * gate calls, so what this screen shows and what an export produces are the same
 * bytes derived by the same code — the frame, the label, the invitation and the
 * response entry point included. Nothing is re-wrapped, summarized or trimmed
 * for display: a preview that shortened the document would be previewing a
 * different one.
 *
 * `kind` is a parameter only so the refusal can be asserted. Anything other than
 * `shareable` is refused by the gate's own `assertExportAllowed` before a row is
 * read, which is how `self_reflection` can never reach this screen.
 */
export function previewShareableDocument(
  db: Db,
  judgment: JudgmentRecord,
  kind: RenditionKind = SHARE_PREVIEW_KIND,
  responseEntryPoint: string = DEFAULT_RESPONSE_ENTRY_POINT,
): string {
  assertExportAllowed(kind);
  return renderJudgmentRendition(db, judgment, kind, {
    responseEntryPoint,
    clientPseudonym: judgment.factLayer.findings.record_basis.client_pseudonym,
  }).text;
}

/* -------------------------------------------------------------------------- */
/* The gate report                                                            */
/* -------------------------------------------------------------------------- */

export type GateCheckId =
  | "kind_allowed"
  | "consent"
  | "metadata_stripped"
  | "real_name_scan"
  | "residual_pii"
  | "quote_rule"
  | "share_gate"
  | "share_token";

/**
 * `pass` — the check ran and found nothing.
 * `blocked` — the check ran and would refuse this export.
 *
 * There is deliberately no third value. The export stops at the first refusal,
 * because it has somewhere to be; the report does not, because its job is to let
 * one pass over the document fix all of it. Every check below runs even when an
 * earlier one has already said no.
 */
export type GateVerdict = "pass" | "blocked";

export interface GateFinding {
  /** One sentence naming what was found. */
  readonly detail: string;
  /** The offending fragment, verbatim, when there is one to point at. */
  readonly excerpt?: string;
}

export interface GateCheck {
  readonly id: GateCheckId;
  readonly title: string;
  /** What the check is for, so the verdict means something. */
  readonly rule: string;
  /** What it actually looked at, itemized. Never "the document". */
  readonly examined: readonly string[];
  readonly verdict: GateVerdict;
  /** What it concluded, in one sentence. */
  readonly conclusion: string;
  readonly findings: readonly GateFinding[];
}

/** What the quote rule decided about one verbatim span, and on what grounds. */
export type QuoteOutcome =
  | "under_cap"
  | "exempt_recipient_own_words"
  | "blocked";

export interface QuoteRuleEntry {
  /** The quote as written, marks included. Verbatim — never trimmed (CLAUDE.md). */
  readonly quote: string;
  /** Code points. One Han character is one character. */
  readonly length: number;
  readonly overCap: boolean;
  /** What the attribution test concluded about who is speaking. */
  readonly recipientsOwnWords: boolean;
  /** The run-up the attribution test reads: the sentence up to the quote. */
  readonly attributionContext: string;
  readonly outcome: QuoteOutcome;
}

export interface ShareGateReport {
  readonly checks: readonly GateCheck[];
  /** Every verbatim span in the document, with the rule's decision on each. */
  readonly quotes: readonly QuoteRuleEntry[];
  /** True when any check would refuse this export. */
  readonly blocked: boolean;
  /** The watermark shape the export will stamp, with a placeholder id. */
  readonly previewWatermark: string;
}

/**
 * Display-only counts for the metadata strip.
 *
 * Deliberately the same character classes `stripExportMetadata` removes, written
 * as escapes so this file contains none of the invisible characters it is
 * counting. The before/after delta is the authority; these numbers only say
 * which class was responsible.
 */
const DISPLAY_INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
const DISPLAY_HTML_COMMENT = /<!--[\s\S]*?-->/g;
const DISPLAY_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

/** Sentence boundaries, both scripts — the same set the attribution test uses. */
const SENTENCE_BOUNDARY = /[.!?。！？\n]/;

/** The run of text from the start of the sentence up to an index. Display only. */
function sentenceRunUp(text: string, index: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start - 1])) start -= 1;
  return text.slice(start, index).trim();
}

function countMatches(text: string, pattern: RegExp): number {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  return [...text.matchAll(global)].length;
}

/**
 * Run every export-gate check over a document, without exporting it.
 *
 * The checks are the gate's own exported functions, called in the gate's own
 * order, so this report cannot drift into a second opinion about the rules. What
 * it adds is the half the gate throws away: on a clean pass the gate returns a
 * document and says nothing about what it looked at, and that is precisely what
 * the person about to send it needs to see.
 */
export function checkExportGate(
  db: Db,
  judgment: JudgmentRecord,
  document: string,
  recipient: ShareViewRecipient,
  dict: PersonDict,
  options: { readonly now?: Date; readonly responseEntryPoint?: string } = {},
): ShareGateReport {
  const now = options.now ?? new Date();
  const entryPoint = options.responseEntryPoint ?? DEFAULT_RESPONSE_ENTRY_POINT;
  const clientPseudonym =
    judgment.factLayer.findings.record_basis.client_pseudonym;
  const checks: GateCheck[] = [];

  /* 1. Which kinds may leave at all. ------------------------------------- */

  const storedRow = db
    .select({
      id: judgmentRenditions.id,
      kind: judgmentRenditions.kind,
      shareable: judgmentRenditions.shareable,
      revision: judgmentRenditions.revision,
      shareTokenHash: judgmentRenditions.shareTokenHash,
      shareExpiresAt: judgmentRenditions.shareExpiresAt,
    })
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgment.id),
        eq(judgmentRenditions.kind, SHARE_PREVIEW_KIND),
      ),
    )
    .get();

  const kindFindings: GateFinding[] = [];
  let kindVerdict: GateVerdict = "pass";
  try {
    assertExportAllowed(SHARE_PREVIEW_KIND);
  } catch (error) {
    /* c8 ignore next 3 -- unreachable: the constant is `shareable`. */
    if (!(error instanceof ExportBlockedError)) throw error;
    kindVerdict = "blocked";
    kindFindings.push(...error.violations.map(toFinding));
  }
  if (storedRow === undefined) {
    kindVerdict = "blocked";
    kindFindings.push({
      detail:
        `This judgment has no shareable rendition row. Renditions are minted ` +
        `when a judgment is frozen, so a missing one means the freeze did not ` +
        `complete.`,
    });
  } else if (!storedRow.shareable) {
    kindVerdict = "blocked";
    kindFindings.push({
      detail:
        `Rendition ${storedRow.id} is stored as NOT shareable. What the ` +
        `database believes wins over what the caller asked for: no copy of it ` +
        `leaves.`,
    });
  }

  checks.push({
    id: "kind_allowed",
    title: "Only the counterparty's copy may leave",
    rule:
      `The self-reflection rendition carries the criticism written for the ` +
      `client alone. There is no export of it and no share token for it — the ` +
      `refusal lives in the server, not in a hidden button.`,
    examined: [
      `the requested kind: ${SHARE_PREVIEW_KIND}`,
      storedRow === undefined
        ? "no stored rendition row for this judgment"
        : `the stored rendition row's own shareable flag (${storedRow.shareable}), revision ${storedRow.revision}`,
    ],
    verdict: kindVerdict,
    conclusion:
      kindVerdict === "pass"
        ? `This is the counterparty-addressed copy, and the row it comes from is stored as shareable.`
        : `This copy may not leave.`,
    findings: kindFindings,
  });

  /* 2. Consent, with the recipient known. -------------------------------- */

  const consentFindings: GateFinding[] = [];
  let consentVerdict: GateVerdict = "pass";
  try {
    assertExportAllowed(SHARE_PREVIEW_KIND, {
      db,
      caseId: judgment.caseId,
      recipientParticipantId: recipient.participantId,
    });
  } catch (error) {
    if (!(error instanceof ExportBlockedError)) throw error;
    consentVerdict = "blocked";
    consentFindings.push(...error.violations.map(toFinding));
  }

  const consentState = namedRenditionConsent(
    db,
    judgment.caseId,
    recipient.participantId,
  );

  checks.push({
    id: "consent",
    title: "Consent of the people this document names",
    rule:
      `A party who has withdrawn consent for a document naming them closes ` +
      `both doors — export and share links — for as long as the withdrawal ` +
      `stands. Nobody having been asked is not the same as somebody saying no, ` +
      `and only a standing revocation blocks.`,
    examined: [
      `the named_rendition consent log for case ${judgment.caseId}`,
      `asked about recipient ${recipient.pseudonym}${
        recipient.participantId === null
          ? " (no participant row — only a blanket withdrawal could answer)"
          : ""
      }`,
      ...consentState.parties.map(
        (party) =>
          `${party.pseudonym}: ${party.standing}${
            party.decidedBy === null
              ? " (never asked)"
              : ` since ${party.decidedBy.occurredAt.toISOString()}`
          }`,
      ),
    ],
    verdict: consentVerdict,
    conclusion:
      consentVerdict === "pass"
        ? consentState.parties.some((party) => party.standing === "granted")
          ? `A grant stands and has not been withdrawn.`
          : `No standing revocation. Nobody has been asked, which the export path treats as not-revoked — the policy M4 shipped with, left alone deliberately.`
        : `A party has withdrawn consent, and while that stands nothing leaves.`,
    findings: consentFindings,
  });

  /* 3. Metadata, stripped before anything is inspected. ------------------- */

  const body = stripExportMetadata(document);
  const invisible = countMatches(document, DISPLAY_INVISIBLE);
  const comments = countMatches(document, DISPLAY_HTML_COMMENT);
  const frontMatter = DISPLAY_FRONT_MATTER.test(document);

  checks.push({
    id: "metadata_stripped",
    title: "Everything the reader cannot see is removed first",
    rule:
      `Front matter, HTML comments and every invisible character class — ` +
      `zero-width spaces, bidi controls, the Unicode tag block — are removed ` +
      `before any other check runs. They are how a name, a per-copy ` +
      `fingerprint or an instruction hides from a reader and from a check at ` +
      `the same time.`,
    examined: [
      `${[...document].length} characters in, ${[...body].length} out`,
      `YAML front matter: ${frontMatter ? "present, removed" : "none"}`,
      `HTML comments: ${comments}`,
      `invisible characters: ${invisible}`,
    ],
    verdict: "pass",
    conclusion:
      invisible === 0 && comments === 0 && !frontMatter
        ? `Nothing hidden was in this document; the text scanned below is the text a reader sees.`
        : `Removed before scanning. What follows was checked against the stripped text, so nothing was both invisible and unexamined.`,
    findings: [],
  });

  /* 4. The pseudonym dictionary. ----------------------------------------- */

  const hits = scanRealNames(body, dict);
  const fragments = dict.flatMap((entry) => deriveNameFragments(entry.canonical));

  checks.push({
    id: "real_name_scan",
    title: "Real names and registered nickname variants",
    rule:
      `A real name or a registered nickname in a document about to be handed ` +
      `over is the failure HARD RULE #3 exists to prevent, arriving at the one ` +
      `moment it cannot be undone. A hit refuses the export and names what it ` +
      `found, which pseudonym it should have been, and where.`,
    examined:
      dict.length === 0
        ? [
            `no registered names for this case — nothing to scan against, which ` +
              `is a hole in the check rather than a clean result`,
          ]
        : [
            ...dict.map(
              (entry) =>
                `${entry.canonical} → ${entry.pseudonym}` +
                (entry.variants.length === 0
                  ? ""
                  : ` (variants: ${entry.variants.join(", ")})`),
            ),
            fragments.length === 0
              ? "no derived given-name fragments"
              : `derived fragments also scanned: ${fragments.join(", ")}`,
          ],
    verdict: hits.length === 0 ? "pass" : "blocked",
    conclusion:
      dict.length === 0
        ? `The dictionary for this case is empty, so this scan proves nothing. A name can only be caught if somebody registered it.`
        : hits.length === 0
          ? `No registered name, variant or given-name fragment appears in the document.`
          : `${hits.length} name hit${hits.length === 1 ? "" : "s"} — this document identifies a real person to whoever receives it.`,
    findings: hits.map((hit) => ({
      detail:
        `"${hit.found}" appears at character ${hit.index} — ` +
        `${
          hit.kind === "canonical"
            ? "a registered real name"
            : hit.kind === "variant"
              ? "a registered nickname or alternative spelling"
              : "a fragment of a registered real name (a given name on its own)"
        }. It should be "${hit.pseudonym}" everywhere outside this machine.`,
      excerpt: excerptAround(body, hit.index),
    })),
  });

  /* 5. Residual PII — the same seam wave-A egress uses. ------------------- */

  const pii = detectUnregisteredNames(body, dict);
  checks.push({
    id: "residual_pii",
    title: "Phone numbers, emails, handles and ID patterns",
    rule:
      `A contact detail that survived into the document identifies its owner ` +
      `whatever the pseudonym layer did. Same detector the LLM egress path ` +
      `runs; when name recognition lands behind it, this check gets it for free.`,
    examined: [`the ${[...body].length}-character stripped document`],
    verdict: pii.length === 0 ? "pass" : "blocked",
    conclusion:
      pii.length === 0
        ? `No residual PII pattern in the document.`
        : `${pii.length} residual pattern${pii.length === 1 ? "" : "s"} found.`,
    findings: pii.map((warning) => ({
      detail: `${warning.detail} Found "${warning.original}".`,
      excerpt: warning.index < 0 ? undefined : excerptAround(body, warning.index),
    })),
  });

  /* 6. The quote rule, scoped by attribution. ---------------------------- */

  const audience = {
    recipientPseudonym: recipient.pseudonym,
    otherPseudonyms: recipient.others,
  };
  const quotes: QuoteRuleEntry[] = findVerbatimQuotes(body).map((span) => {
    const overCap = span.length > MAX_THIRD_PARTY_QUOTE_CHARS;
    const own = isRecipientQuote(body, span, audience);
    return {
      quote: `${span.marks[0]}${span.content}${span.marks[1]}`,
      length: span.length,
      overCap,
      recipientsOwnWords: own,
      attributionContext: sentenceRunUp(body, span.index),
      outcome: !overCap
        ? "under_cap"
        : own
          ? "exempt_recipient_own_words"
          : "blocked",
    };
  });

  const blockedQuotes = quotes.filter((quote) => quote.outcome === "blocked");
  const exemptQuotes = quotes.filter(
    (quote) => quote.outcome === "exempt_recipient_own_words",
  );

  checks.push({
    id: "quote_rule",
    title: "Long verbatim quotes, scoped by who said them",
    rule:
      `A verbatim quote over ${MAX_THIRD_PARTY_QUOTE_CHARS} characters is a ` +
      `fingerprint of whoever wrote it, so it is refused — unless it is the ` +
      `recipient's own words. Hers are the evidence this document rests on and ` +
      `she already knows she wrote them; stripping them would remove exactly ` +
      `what she is entitled to check (SPEC M4 decision record, 2026-08-10). ` +
      `A quote over the cap is never trimmed to pass: a trimmed quote is an ` +
      `edited record.`,
    examined: [
      `${quotes.length} verbatim span${quotes.length === 1 ? "" : "s"} in the document`,
      `cap: ${MAX_THIRD_PARTY_QUOTE_CHARS} characters, counted as code points`,
      `recipient: ${recipient.pseudonym}`,
      recipient.others.length === 0
        ? "no other party could be the speaker"
        : `other possible speakers: ${recipient.others.join(", ")}`,
    ],
    verdict: blockedQuotes.length === 0 ? "pass" : "blocked",
    conclusion:
      quotes.length === 0
        ? `The document quotes nothing verbatim.`
        : blockedQuotes.length === 0
          ? `${quotes.length - exemptQuotes.length} under the cap, ` +
            `${exemptQuotes.length} exempt as ${recipient.pseudonym}'s own words. Nothing refused.`
          : `${blockedQuotes.length} quote${blockedQuotes.length === 1 ? "" : "s"} over the cap and not attributed to ${recipient.pseudonym}.`,
    findings: blockedQuotes.map((quote) => ({
      detail:
        `A ${quote.length}-character quote is reproduced without being ` +
        `attributed to ${recipient.pseudonym}. Either attribute it to her ` +
        `plainly in the same sentence, or say what it means in the judgment's ` +
        `own words.`,
      excerpt: quote.quote,
    })),
  });

  /* 7. The share gate, on the watermarked bytes. -------------------------- */

  const previewWatermark = composeWatermark({
    exportId: PREVIEW_EXPORT_ID,
    judgmentVersion: judgment.version,
    exportedAt: now,
  });
  const watermarked = `${previewWatermark}\n\n${body}`;

  const frameFindings: GateFinding[] = [];
  let frameVerdict: GateVerdict = "pass";
  try {
    assertShareable(watermarked, entryPoint, clientPseudonym);
  } catch (error) {
    if (!(error instanceof RenditionError)) throw error;
    frameVerdict = "blocked";
    frameFindings.push(
      ...error.violations.map((violation) => ({
        detail: violation.detail,
        ...(violation.excerpt === undefined ? {} : { excerpt: violation.excerpt }),
      })),
    );
  }

  checks.push({
    id: "share_gate",
    title: "The frame, the vocabulary, and who the document is talking to",
    rule:
      `Run last, over exactly the bytes that leave, so the watermark itself ` +
      `cannot be what breaks it: the provenance-and-redistribution notice is ` +
      `present, the document ends on the invitation carrying the way in, the ` +
      `prose has no win/lose framing and no responsibility percentage, and no ` +
      `sentence addresses the client in the second person.`,
    examined: [
      `the notice: ${hasProvenanceNotice(watermarked) ? "present" : "MISSING"}`,
      `the invitation: ${watermarked.includes(INVITATION_TEXT) ? "present" : "MISSING"}`,
      `the last line: ${
        watermarked.trimEnd().endsWith(`${RESPONSE_PROMPT} ${entryPoint}`)
          ? `"${RESPONSE_PROMPT} ${entryPoint}"`
          : "does NOT end on the response entry point"
      }`,
      `win/lose vocabulary and responsibility percentages, over the judgment's own prose with verbatim quotes stripped first`,
      `client-address check against the client pseudonym "${clientPseudonym}"`,
      `the watermark line that will be stamped on top`,
    ],
    verdict: frameVerdict,
    conclusion:
      frameVerdict === "pass"
        ? `The document is framed, addressed to its reader, and hands them a way to answer.`
        : `The document itself is wrong, not the export.`,
    findings: frameFindings,
  });

  /* 8. The share-token door. --------------------------------------------- */

  const tokenFindings: GateFinding[] = [];
  let tokenVerdict: GateVerdict = "pass";
  try {
    // The blanket question: a share link has no named recipient — it goes to
    // whoever is handed it — so only a blanket withdrawal answers it.
    assertShareTokenAllowed(SHARE_PREVIEW_KIND, { db, caseId: judgment.caseId });
  } catch (error) {
    tokenVerdict = "blocked";
    if (error instanceof NamedRenditionRevokedError) {
      tokenFindings.push({ detail: error.message });
    } else if (error instanceof JudgmentStoreError) {
      tokenFindings.push({ detail: error.message });
      /* c8 ignore next 2 -- assertShareTokenAllowed throws nothing else. */
    } else throw error;
  }
  if (judgment.status !== "final") {
    tokenVerdict = "blocked";
    tokenFindings.push({
      detail:
        `Judgment ${judgment.id} is ${judgment.status}. A draft is work in ` +
        `progress; nothing is shared out of one.`,
    });
  }

  checks.push({
    id: "share_token",
    title: "Minting a share link",
    rule:
      `A link is a document THIS machine serves, so a withdrawal can still ` +
      `reach it after the fact — an already-minted link stops opening while a ` +
      `revocation stands, and works again if consent is granted again. That is ` +
      `the one promise about a shared copy this product can actually keep.`,
    examined: [
      `the kind (${SHARE_PREVIEW_KIND})`,
      `blanket named_rendition consent on case ${judgment.caseId}`,
      `judgment status: ${judgment.status}`,
      storedRow?.shareTokenHash == null
        ? "no link has been minted for this document"
        : `a link is already minted (hash on file, plaintext never stored)` +
          (storedRow.shareExpiresAt === null
            ? ""
            : storedRow.shareExpiresAt.getTime() <= now.getTime()
              ? `, and it expired on ${storedRow.shareExpiresAt.toISOString()}`
              : `, valid until ${storedRow.shareExpiresAt.toISOString()}`),
      // A second mint replaces the first: one hash column, one live link.
      `minting again replaces the current link rather than adding one`,
    ],
    verdict: tokenVerdict,
    conclusion:
      tokenVerdict === "pass"
        ? `A link may be minted for this document.`
        : `No link is minted while this stands.`,
    findings: tokenFindings,
  });

  return {
    checks,
    quotes,
    blocked: checks.some((check) => check.verdict === "blocked"),
    previewWatermark,
  };
}

function toFinding(violation: {
  readonly detail: string;
  readonly excerpt?: string;
}): GateFinding {
  return violation.excerpt === undefined
    ? { detail: violation.detail }
    : { detail: violation.detail, excerpt: violation.excerpt };
}

function excerptAround(text: string, index: number, span = 50): string {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}

/* -------------------------------------------------------------------------- */
/* The L1 audience defect (SPEC M5 decision record, 2026-08-14 — OPEN)        */
/* -------------------------------------------------------------------------- */

/** Prose that asserts an allocation of responsibility, in the document's own words. */
const ALLOCATION_ASSERTIONS: readonly { readonly label: string; readonly pattern: RegExp }[] =
  [
    {
      label: "allocates responsibility",
      pattern: /\ballocat(es|ed|ing|ion of)\b[^.!?。！？]{0,40}\bresponsibilit/i,
    },
    {
      label: "responsibility is shared",
      pattern: /\bresponsibilit\w*\b[^.!?。！？]{0,30}\b(is|as|was)\s+shared\b/i,
    },
    {
      label: "shared between the parties",
      pattern: /\bshared\s+between\s+(the\s+)?(parties|both|you)\b/i,
    },
    {
      label: "both parties carry responsibility",
      pattern: /\bboth\s+(parties|of\s+you)\b[^.!?。！？]{0,40}\bresponsib/i,
    },
  ];

export interface WithheldSection {
  readonly sectionId: string;
  readonly heading: string;
  readonly kind: string;
}

export interface AllocationAssertion {
  readonly sectionId: string;
  readonly heading: string;
  readonly label: string;
  readonly excerpt: string;
}

export interface L1AudienceDefect {
  readonly judgmentLevel: OutputLevel;
  /**
   * Sections of the CLIENT's copy marked `self_only` — headings only, never the
   * text. The defect is that at L1 these are withheld from a participant; naming
   * them is the disclosure, printing them would be the leak.
   */
  readonly withheldFromRecipient: readonly WithheldSection[];
  /** The allocations the frozen fact layer actually holds, per party. */
  readonly responsibility: readonly ResponsibilityFinding[];
  /** Where the document on screen asserts an allocation to its reader. */
  readonly assertedToRecipient: readonly AllocationAssertion[];
}

/**
 * Whether the known L1 unfairness applies to the document on screen, and what of
 * it is concretely present.
 *
 * The condition is the judgment's OWN level, not the case's: a judgment is
 * written inside the frame it was issued at, and a case that has since moved to
 * L1 does not retroactively make an L2 document unfair in this way.
 *
 * Returns null below L1. Above it, returns the evidence even when a given case
 * has none of the specific shapes — an empty `withheldFromRecipient` does not
 * make the rule sound, and the screen says the rule applies either way.
 */
export function describeL1AudienceDefect(
  judgment: JudgmentRecord,
  counterpartyNarrative: SurfaceLayer | null,
): L1AudienceDefect | null {
  if (judgment.outputLevel !== "L1") return null;

  const clientSections: readonly JudgmentSection[] =
    judgment.surfaceLayer?.sections ?? [];

  // One entry per section, not one per pattern: several of these patterns hit
  // the same sentence, and three cards quoting one sentence read as three
  // separate problems. The first match names it; the sentence is the finding.
  const assertions: AllocationAssertion[] = [];
  for (const section of counterpartyNarrative?.sections ?? []) {
    for (const { label, pattern } of ALLOCATION_ASSERTIONS) {
      const match = pattern.exec(section.text);
      if (match === null) continue;
      assertions.push({
        sectionId: section.section_id,
        heading: section.heading,
        label,
        excerpt: excerptAround(section.text, match.index, 90),
      });
      break;
    }
  }

  return {
    judgmentLevel: judgment.outputLevel,
    withheldFromRecipient: clientSections
      .filter((section) => section.audience === "self_only")
      .map((section) => ({
        sectionId: section.section_id,
        heading: section.heading,
        kind: section.kind,
      })),
    responsibility: judgment.factLayer.findings.responsibility,
    assertedToRecipient: assertions,
  };
}

/* -------------------------------------------------------------------------- */
/* The cool-down buffer (doc 01, post-judgment ③)                             */
/* -------------------------------------------------------------------------- */

export type CoolingOffState = "waiting" | "open" | "settled" | "undated";

export interface CoolingOff {
  readonly state: CoolingOffState;
  /** When the document that would be sent was written. Null when unrecorded. */
  readonly anchor: Date | null;
  readonly anchorLabel: string;
  readonly elapsedMs: number;
  /** When the 24-hour floor is reached. Null when there is no anchor. */
  readonly opensAt: Date | null;
  /** When the 48-hour window closes. */
  readonly settledAt: Date | null;
  readonly remainingMs: number;
  /** True when the pause has run and a link may be asked for. */
  readonly elapsed: boolean;
}

/**
 * Where the cool-down stands.
 *
 * `undated` counts as elapsed, deliberately and narrowly: a rendition written by
 * the generation path always carries `generated_at`, so the only way to land
 * here is a hand-built fixture, and refusing forever on a missing timestamp
 * would turn an absent fact into a permanent block. The state is reported rather
 * than swallowed, so the screen can say the pause could not be measured.
 */
export function describeCoolingOff(
  anchor: Date | null,
  anchorLabel: string,
  now: Date = new Date(),
): CoolingOff {
  if (anchor === null) {
    return {
      state: "undated",
      anchor: null,
      anchorLabel,
      elapsedMs: 0,
      opensAt: null,
      settledAt: null,
      remainingMs: 0,
      elapsed: true,
    };
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  const state: CoolingOffState =
    elapsedMs < COOLING_OFF_MIN_MS
      ? "waiting"
      : elapsedMs < COOLING_OFF_SETTLED_MS
        ? "open"
        : "settled";

  return {
    state,
    anchor,
    anchorLabel,
    elapsedMs,
    opensAt: new Date(anchor.getTime() + COOLING_OFF_MIN_MS),
    settledAt: new Date(anchor.getTime() + COOLING_OFF_SETTLED_MS),
    remainingMs: Math.max(0, COOLING_OFF_MIN_MS - elapsedMs),
    elapsed: state !== "waiting",
  };
}

/* -------------------------------------------------------------------------- */
/* The doc 01 question                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The answers doc 01 names as the reason for asking.
 *
 * "What do you want the other party to feel after reading this" is a question
 * with one answer the product has an opinion about: wanting them to realize they
 * were wrong. Doc 01 §post-judgment ③ says to warn that it triggers defensiveness
 * rather than change.
 *
 * Lexical, partial, and biased towards warning — the cost of a false positive is
 * one sentence somebody reads and disagrees with, and the cost of a miss is a
 * document sent to win an argument. Both scripts, because the sender writes in
 * their own words and this is not a place to demand English.
 *
 * The one bias deliberately corrected: most of these words are also what the
 * GOOD answer is made of. "I want to apologize for not answering" and "I regret
 * how I handled it" are the sender's own remorse, which is the opposite of what
 * doc 01 is warning about, and warning on them would teach people that the
 * question is a hurdle rather than a question. So everything about an emotion
 * the OTHER person is meant to have is scoped to that other person, and the
 * sender's own is left alone.
 */
const OTHER_PERSON = String.raw`\b(she|he|they|her|him|them|她|他|对方)\b`;

const DEFENSIVENESS_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  {
    label: "wanting them to realize they were wrong",
    pattern:
      /\b(reali[sz]e|admit|accept|see|understand|know|acknowledge|concede)\b[^.!?]{0,48}\b(wrong|at fault|to blame|her fault|his fault|their fault)\b/i,
  },
  { label: "who was right", pattern: /\bwho (was|is) (right|wrong)\b/i },
  {
    // The noun is the wanting of one; the verb only counts when they are the
    // one doing it ("I want to apologize to her" is not this).
    label: "wanting an apology from them",
    pattern: new RegExp(
      String.raw`\bapolog(y|ies)\b|${OTHER_PERSON}[^.!?]{0,24}\bapolog(ize|ise|izes|ises|izing|ising|ized|ised)\b`,
      "i",
    ),
  },
  {
    label: "wanting them to feel guilty",
    pattern: new RegExp(
      `${OTHER_PERSON}[^.!?]{0,32}\\b(guilty|guilt|ashamed|shame|bad about)\\b`,
      "i",
    ),
  },
  {
    label: "wanting them to regret it",
    pattern: new RegExp(`${OTHER_PERSON}[^.!?]{0,32}\\bregrets?\\b`, "i"),
  },
  { label: "wanting to win", pattern: /\b(win|winning|beat|prove (her|him|them) wrong)\b/i },
  { label: "wanting them to back down", pattern: /\b(back down|give in|cave in)\b/i },
  // Chinese has no lexical subject marker to lean on here, so the scoping is
  // the causative instead: 让/想让/希望/要/逼/叫 + the other person + the word.
  // "我想让她认错" is caught; "我想为那几天没回她道歉" — the sender apologizing,
  // with 她 as the object of 回 — is not, and it is the answer doc 01 is hoping for.
  {
    label: "让对方认错",
    pattern:
      /(让|想让|希望|要|逼|叫)\s*(她|他|对方)[^。！？.!?]{0,12}(认错|承认.{0,4}错|意识到.{0,6}错|知道.{0,4}错)/,
  },
  {
    label: "让对方道歉",
    pattern: /(让|想让|希望|要|逼|叫)\s*(她|他|对方)[^。！？.!?]{0,12}道歉|道个歉/,
  },
  {
    label: "让对方内疚 / 愧疚 / 后悔",
    pattern:
      /(让|想让|希望|要|逼|叫)\s*(她|他|对方)[^。！？.!?]{0,12}(内疚|愧疚|后悔|羞愧)/,
  },
  { label: "谁对谁错", pattern: /谁对谁错|谁的错/ },
];

export interface SendIntent {
  /** The sender's own words, verbatim. Never normalized, never rewritten. */
  readonly answer: string;
  /** False when the answer is too short to be an answer. */
  readonly answered: boolean;
  /** True when the answer reads as "make them realize they were wrong". */
  readonly flagged: boolean;
  /** Which patterns matched, so the warning is not a black box. */
  readonly matched: readonly string[];
  /** Doc 01's warning, or null when there is nothing to warn about. */
  readonly warning: string | null;
}

/** The doc 01 question, as the screen asks it. */
export const SEND_INTENT_QUESTION =
  "What do you want the other person to feel after reading this?";

/**
 * Read the sender's answer to the doc 01 question.
 *
 * Pure, and stores nothing: this is a question asked at the moment of sending,
 * and an answer kept on a row would turn "asked once more before sharing" into
 * a form field that was filled in weeks ago.
 */
export function readSendIntent(answer: string): SendIntent {
  const trimmed = answer.trim();
  const answered = [...trimmed].length >= MIN_SEND_INTENT_CHARS;
  const matched = DEFENSIVENESS_PATTERNS.filter(({ pattern }) =>
    pattern.test(trimmed),
  ).map(({ label }) => label);

  return {
    answer: trimmed,
    answered,
    flagged: answered && matched.length > 0,
    matched,
    warning:
      answered && matched.length > 0
        ? `That is an answer about being right rather than about being ` +
          `understood, and it is the one doc 01 asks this question to catch. A ` +
          `document sent to make somebody realize they were wrong reliably ` +
          `produces defensiveness rather than change — she will read it as an ` +
          `argument to win, because that is what it was sent as. Nothing stops ` +
          `you sending it. It is worth knowing what it will do first.`
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* What the document tells her, before it is sent                             */
/* -------------------------------------------------------------------------- */

export interface PreSendDisclosure {
  readonly id: "never_asked" | "unanswered_clarifications" | "invites_a_response";
  /**
   * Where the claim was read from.
   *
   * `document` means the bytes on screen either carry it or do not, and
   * `present` is that answer. `record` means it is a fact about the case that
   * the sender is owed before sending — the document's silence about it is not
   * a fault, and rendering it with a "not in the document" badge would say the
   * opposite.
   */
  readonly source: "document" | "record";
  readonly claim: string;
  /** For a document claim: whether the document carries it. */
  readonly present: boolean;
  /** The sentence that carries it, verbatim. */
  readonly evidence: string | null;
  /** What it means for the person receiving it. */
  readonly consequence: string;
}

/**
 * The three standing product rules, checked against THIS document.
 *
 * Not a checklist of things the sender promises — a reading of what the bytes on
 * screen actually say. Every entry either quotes the sentence that carries it or
 * reports that the document does not carry it, which is the only version of this
 * that is worth putting in front of somebody: a checklist can be true of a
 * document nobody looked at.
 */
export function preSendDisclosures(
  db: Db,
  caseId: string,
  document: string,
  entryPoint: string,
): PreSendDisclosure[] {
  const clarification = readClarification(db, caseId);
  const questions = clarification.rounds.flatMap((round) => round.questions);
  const unanswered = questions.filter(
    (question) => question.answer === null && !question.declined,
  );
  const declined = questions.filter((question) => question.declined);
  const open = unanswered.length + declined.length;

  const endsOnEntryPoint = document
    .trimEnd()
    .endsWith(`${RESPONSE_PROMPT} ${entryPoint}`);

  return [
    {
      id: "never_asked",
      source: "document",
      // The notice states what produced the document, what it rests on at this
      // level (at L2: that she was never asked), and what not to do with it.
      // One notice, per doc 05 §C amendment 5 — the one-sidedness label used to
      // be a second paragraph saying half of this.
      claim: "It tells her what made this and what it rests on.",
      present: hasProvenanceNotice(document),
      evidence: findProvenanceNotice(document),
      consequence:
        `She is being handed a written account of her own relationship, ` +
        `produced without her, by a machine. The notice is the first thing she ` +
        `reads and it is the only thing standing between this document and ` +
        `being taken as a finding about her.`,
    },
    {
      id: "unanswered_clarifications",
      source: "record",
      claim:
        questions.length === 0
          ? "No clarification question was ever put to you on this case."
          : open === 0
            ? `All ${questions.length} clarification question` +
              `${questions.length === 1 ? "" : "s"} put to you ` +
              `${questions.length === 1 ? "was" : "were"} answered.`
            : `${open} clarification question${open === 1 ? "" : "s"} put to you ` +
              `${open === 1 ? "was" : "were"} never answered` +
              (declined.length === 0
                ? ""
                : ` (${declined.length} declined outright)`) +
              `, and the record this document rests on is missing what they ` +
              `would have settled.`,
      present: open > 0,
      evidence:
        unanswered.length === 0
          ? declined.length === 0
            ? null
            : declined[0].question
          : unanswered[0].question,
      consequence:
        open === 0
          ? `Nothing in this document was left open by a question you did not ` +
            `answer, so what it cannot settle is the record's limit rather than ` +
            `yours.`
          : `The gaps are yours, not hers. She is about to read a document ` +
            `whose limits were set partly by questions you left unanswered, ` +
            `and she has no way to know which conclusions would have moved.`,
    },
    {
      id: "invites_a_response",
      source: "document",
      claim: "It invites her to answer, and tells her where.",
      present: document.includes(INVITATION_TEXT) && endsOnEntryPoint,
      evidence: document.includes(INVITATION_TEXT)
        ? `${INVITATION_TEXT}\n\n${RESPONSE_PROMPT} ${entryPoint}`
        : null,
      consequence:
        `The last line of the document is a promise that she can add her side ` +
        `and have everything above re-heard with it in. Sending this is ` +
        `undertaking to actually do that.`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The whole screen's read                                                    */
/* -------------------------------------------------------------------------- */

export interface ShareTokenState {
  /** True when a link has been minted. The plaintext is never stored. */
  readonly minted: boolean;
  readonly expiresAt: Date | null;
  readonly expired: boolean;
  /**
   * True when nothing on this build redeems a share token.
   *
   * Checked as a fact about the routes, not assumed: `/respond/[token]` resolves
   * invite and identity tokens, and a minted share link's last line points at
   * `/respond/<token>`. Naming it here is the same discipline that caught the
   * M4 defect (a document promising a route that 404s) rather than repeating it.
   */
  readonly routeUnbuilt: true;
}

export interface RenditionProvenance {
  readonly revision: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly promptVersion: string | null;
  readonly fallbackUsed: boolean;
  readonly generatedAt: Date | null;
}

export interface SharePreview {
  readonly caseId: string;
  readonly judgment: JudgmentRecord;
  readonly rendition: RenditionProvenance;
  /** Exactly what the recipient receives. Rendered, not stored; never trimmed. */
  readonly document: string;
  readonly documentSha256: string;
  readonly documentBytes: number;
  readonly responseEntryPoint: string;
  readonly recipient: ShareViewRecipient;
  readonly gate: ShareGateReport;
  readonly consent: CaseConsentState;
  readonly namedRendition: NamedRenditionConsent;
  readonly exports: readonly ExportAuditRecord[];
  readonly disclosures: readonly PreSendDisclosure[];
  readonly coolingOff: CoolingOff;
  readonly l1Defect: L1AudienceDefect | null;
  readonly shareToken: ShareTokenState;
}

export type SharePreviewResult =
  | { readonly ok: true; readonly preview: SharePreview }
  | { readonly ok: false; readonly problem: SharePreviewProblem };

export interface SharePreviewOptions {
  /** Injectable clock, so the cool-down and the watermark do not race a real one. */
  readonly now?: Date;
  /** Override the dictionary the name scan runs against. Defaults to the case's. */
  readonly dict?: PersonDict;
  /** A specific judgment; defaults to the case's standing one. */
  readonly judgmentId?: string;
}

/**
 * Everything the share screen renders, read in one pass.
 *
 * Returns a problem rather than throwing for every state a case can honestly be
 * in — no judgment, a draft, a counterparty narrative that was never generated.
 * Those are answers, and the screen prints them. A `RenditionError` from the
 * render path is the one case where the DOCUMENT is wrong rather than absent, and
 * it comes back as `document_refused` carrying the render layer's own message,
 * because that message names the faulty sentence.
 */
export function readSharePreview(
  db: Db,
  caseId: string,
  options: SharePreviewOptions = {},
): SharePreviewResult {
  const now = options.now ?? new Date();

  const judgment =
    options.judgmentId === undefined
      ? readCurrentJudgment(db, caseId)
      : readJudgment(db, options.judgmentId);

  if (judgment === null) {
    return {
      ok: false,
      problem: {
        code: "no_judgment",
        message:
          `This case has no judgment, so there is no document that could be ` +
          `handed to anybody.`,
        hint: null,
      },
    };
  }
  if (judgment.status !== "final") {
    return {
      ok: false,
      problem: {
        code: "not_final",
        message:
          `Judgment ${judgment.id} is a ${judgment.status}. A draft is work in ` +
          `progress and nothing is handed to anyone out of one.`,
        hint: null,
      },
    };
  }

  const recipient = resolveShareRecipient(db, judgment.caseId, judgment);
  if (recipient === null) {
    return {
      ok: false,
      problem: {
        code: "recipient_unknown",
        message:
          `Who this copy is for cannot be established: this case does not have ` +
          `exactly one participant who did not bring it. The recipient decides ` +
          `which quotes are the reader's own words and is what the export ` +
          `audit records, so nothing is previewed against a guess.`,
        hint: null,
      },
    };
  }

  const row = db
    .select()
    .from(judgmentRenditions)
    .where(
      and(
        eq(judgmentRenditions.judgmentId, judgment.id),
        eq(judgmentRenditions.kind, SHARE_PREVIEW_KIND),
      ),
    )
    .get();

  if (row === undefined) {
    return {
      ok: false,
      problem: {
        code: "rendition_missing",
        message:
          `Judgment ${judgment.id} has no shareable rendition row. Renditions ` +
          `are minted when a judgment is frozen.`,
        hint: null,
      },
    };
  }

  const entryPoint = DEFAULT_RESPONSE_ENTRY_POINT;
  let document: string;
  try {
    document = previewShareableDocument(
      db,
      judgment,
      SHARE_PREVIEW_KIND,
      entryPoint,
    );
  } catch (error) {
    if (error instanceof RenditionError) {
      return {
        ok: false,
        problem: {
          code:
            error.code === "shareable_narrative_missing"
              ? "shareable_narrative_missing"
              : "document_refused",
          message: error.message,
          hint:
            error.code === "shareable_narrative_missing"
              ? `npm run judgment:shareable -- ${judgment.id}`
              : null,
        },
      };
    }
    /* c8 ignore next 8 -- the kind is the module constant; this cannot fire. */
    if (error instanceof ExportBlockedError) {
      return {
        ok: false,
        problem: { code: "document_refused", message: error.message, hint: null },
      };
    }
    throw error;
  }

  const dict = options.dict ?? buildCaseDict(db, judgment.caseId);

  return {
    ok: true,
    preview: {
      caseId: judgment.caseId,
      judgment,
      rendition: {
        revision: row.revision,
        model: row.model,
        effort: row.effort,
        promptVersion: row.promptVersion,
        fallbackUsed: row.fallbackUsed,
        generatedAt: row.generatedAt,
      },
      document,
      documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
      documentBytes: Buffer.byteLength(document, "utf8"),
      responseEntryPoint: entryPoint,
      recipient,
      gate: checkExportGate(db, judgment, document, recipient, dict, {
        now,
        responseEntryPoint: entryPoint,
      }),
      consent: readCaseConsentState(db, judgment.caseId),
      namedRendition: namedRenditionConsent(
        db,
        judgment.caseId,
        recipient.participantId,
      ),
      exports: listCaseExports(db, judgment.caseId),
      disclosures: preSendDisclosures(db, judgment.caseId, document, entryPoint),
      coolingOff: describeCoolingOff(
        row.generatedAt ?? judgment.finalizedAt,
        row.generatedAt === null
          ? "when this judgment was frozen"
          : "when this document was written",
        now,
      ),
      l1Defect: describeL1AudienceDefect(
        judgment,
        readShareableNarrative(db, judgment.id),
      ),
      shareToken: {
        minted: row.shareTokenHash !== null,
        expiresAt: row.shareExpiresAt,
        expired:
          row.shareExpiresAt !== null &&
          row.shareExpiresAt.getTime() <= now.getTime(),
        routeUnbuilt: true,
      },
    },
  };
}
