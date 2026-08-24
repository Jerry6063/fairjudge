/**
 * The `evidence_anomaly_check` adapter: OCR blocks in, two booleans out.
 *
 * This is the only place in the intake path that leaves the machine, so it is
 * also where the egress discipline is concrete:
 *
 *   - it goes through `runStage`, never the SDK (HARD RULE #7), which means the
 *     pseudonymization gateway, the refusal check and the two audit tables all
 *     apply automatically;
 *   - it is handed the case's person dictionary, so a registered party leaves as
 *     甲 or 乙 rather than as themselves (HARD RULE #3);
 *   - it sends a *digest*, not the transcript. The check needs to recognise the
 *     shape of a ChatGPT session or a Xiaohongshu post, which the first couple
 *     of screens already show. Sending the whole screenshot text would disclose
 *     more than the question requires.
 *
 * Best-effort by construction: a refusal, a transport failure or an empty
 * digest all come back as `null`, and grading falls through to the source_type
 * rule alone. A screenshot never fails to upload because a model was down.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db";
import { caseParticipants } from "../db/schema";
import type { EvidenceAnomaly } from "../domain/grading";
import { runStage } from "../llm";
import type { BubbleBlock } from "../ocr";
import { expandPersonEntry, type PersonDict } from "../pseudonym";

/** Digest ceiling. Two phone screens of text is plenty to recognise a UI. */
export const ANOMALY_DIGEST_MAX_CHARS = 1200;

/** Below this much recognized text the check is skipped as unanswerable. */
export const ANOMALY_MIN_CHARS = 24;

/** Marker appended when the digest was cut short. */
const TRUNCATION_MARKER = "\n(remainder omitted)";

/**
 * Bubble-side markers, so the model sees the chat layout. System annotation,
 * hence English — the recognized text they prefix is never touched.
 */
const SIDE_LABEL: Record<BubbleBlock["side"], string> = {
  left: "left",
  right: "right",
  center: "center",
};

/**
 * Render OCR blocks as a compact transcript sketch.
 *
 * The side markers are the useful signal: a human-to-human chat alternates
 * left/right in short turns, while an AI session is one enormous left column.
 * Noise blocks are dropped — they are UI chrome and would only dilute it.
 */
export function buildOcrDigest(
  blocks: readonly BubbleBlock[],
  maxChars: number = ANOMALY_DIGEST_MAX_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;

  for (const block of blocks) {
    if (block.noise) continue;
    const text = block.text.trim();
    if (text === "") continue;

    const line = `[${SIDE_LABEL[block.side]}] ${text}`;
    if (used + line.length > maxChars) {
      // Keep whole lines: a half-sentence tells the model less than a clean cut.
      if (lines.length === 0) lines.push(line.slice(0, maxChars));
      return lines.join("\n") + TRUNCATION_MARKER;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}

/**
 * Person dictionary for this case: every participant with a real name mapped
 * onto their pseudonym. Real names never leave the process, so this must be
 * built before any digest is sent.
 *
 * ## Why the variants are derived here and not left empty
 *
 * `case_participants.display_name` holds one string, the one somebody typed into
 * the filing form — usually a full name. What a record then actually says is the
 * given name: "at the Ridgeway allotment with Nikhil", never "with Nikhil
 * Raman". A dictionary registered as `{canonical, variants: []}` masks the form
 * that almost never appears and lets through the form that always does, which is
 * how a registered party's own given name egressed in clear.
 *
 * `expandPersonEntry` folds the name's fragments into the variant table, so the
 * substitution is done by the same longest-match pass as everything else — the
 * full name is still matched whole before either half is considered. This is the
 * one dictionary builder in the product (every judgment, steelman, clarification
 * and anomaly call reads it), so the fix lands on the API path and the
 * external-session path at once; there is no second place for it to be missing.
 */
export function buildCaseDict(db: Db, caseId: string): PersonDict {
  return db
    .select({
      displayName: caseParticipants.displayName,
      pseudonym: caseParticipants.pseudonym,
    })
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, caseId))
    .all()
    .flatMap((row) =>
      row.displayName && row.displayName.length > 0
        ? [
            expandPersonEntry({
              canonical: row.displayName,
              pseudonym: row.pseudonym,
              variants: [],
            }),
          ]
        : [],
    );
}

/** What the intake path needs from an anomaly checker. */
export type AnomalyChecker = (
  digest: string,
  context: { caseId: string; dict: PersonDict },
) => Promise<EvidenceAnomaly | null>;

/**
 * Default checker: one `evidence_anomaly_check` run, failures swallowed.
 *
 * The `console.warn` is the only trace a failed check leaves; the call itself
 * is already in `llm_calls` + `egress_ledger` whatever the outcome.
 */
export const checkEvidenceAnomaly: AnomalyChecker = async (digest, context) => {
  if (digest.trim().length < ANOMALY_MIN_CHARS) return null;

  const result = await runStage("evidence_anomaly_check", {
    prompt: digest,
    dict: context.dict,
    caseId: context.caseId,
  });

  if (result.kind === "ok") return result.data;

  // eslint-disable-next-line no-console
  console.warn(
    `evidence_anomaly_check unavailable (${result.kind}); ` +
      `grading falls back to the source_type rule.`,
  );
  return null;
};
