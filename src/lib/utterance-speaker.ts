/**
 * Who said a line — the one reading of `speaker_participant_id` /
 * `speaker_label`, shared by the server workbench and the client that renders
 * it.
 *
 * Three different writers fill those two columns, and only together do they
 * mean something:
 *
 *   - OCR intake writes the bubble side it guessed (`left` / `right` /
 *     `center`) into `speaker_label` with no participant id. That is a *hint*
 *     awaiting review, not an attribution.
 *   - The M0 seed importer wrote a pseudonym (甲 / 乙), also with no id.
 *   - The workbench writes both columns at once: the participant's id and its
 *     pseudonym, or the timestamp marker with the id cleared.
 *
 * Reading those cases apart is exactly the kind of thing that drifts when two
 * layers each do it: a client that only checked "is `speaker_label` set" would
 * show every freshly recognized line as an already-marked timestamp row. So it
 * is decided once, here, in a module with no imports — the server can call it
 * next to the database and the client can call it in the browser.
 */

/**
 * `speaker_label` written when a line is chrome (a clock reading, a system
 * notice) rather than either party's speech. A sentinel rather than a fourth
 * nullable column; it is a stored machine value, never display copy — the UI
 * renders its own wording for a timestamp row.
 */
export const TIMESTAMP_SPEAKER_LABEL = "timestamp";

/**
 * The sentinel this column held before the repository moved to English. Rows
 * written by earlier builds still carry it, so reading must accept both;
 * writing only ever produces the current value.
 */
const LEGACY_TIMESTAMP_SPEAKER_LABEL = "时间戳";

/** The two columns, as anything holding an utterance has them. */
export interface SpeakerColumns {
  readonly speakerParticipantId: string | null;
  readonly speakerLabel: string | null;
}

/** A party of the case, as the resolver needs to see it. */
export interface SpeakerCandidate {
  readonly id: string;
  readonly pseudonym: string;
}

export type SpeakerView =
  /** Attributed to a party of this case. */
  | {
      readonly kind: "participant";
      readonly participantId: string;
      readonly pseudonym: string;
    }
  /** Marked as chrome: a timestamp / system row, nobody's speech. */
  | { readonly kind: "timestamp" }
  /**
   * Nobody has decided yet. `hint` carries whatever the machine wrote (the OCR
   * bubble side), for the UI to show as a guess — never as an answer.
   */
  | { readonly kind: "unassigned"; readonly hint: string | null };

/**
 * Read the speaker columns of one utterance.
 *
 * Resolution order is by trustworthiness: an explicit participant id first,
 * then the timestamp sentinel, then a label that happens to name a party of
 * this case (the seed importer's rows), and finally "unattributed, here is what
 * the machine guessed".
 */
export function resolveSpeaker(
  row: SpeakerColumns,
  participants: readonly SpeakerCandidate[],
): SpeakerView {
  if (row.speakerParticipantId !== null) {
    const byId = participants.find(
      (candidate) => candidate.id === row.speakerParticipantId,
    );
    if (byId !== undefined) {
      return {
        kind: "participant",
        participantId: byId.id,
        pseudonym: byId.pseudonym,
      };
    }
    // An id pointing at nobody (the participant was removed): fall through and
    // report the line as unattributed rather than inventing a speaker.
  }

  if (row.speakerLabel === null) return { kind: "unassigned", hint: null };
  if (
    row.speakerLabel === TIMESTAMP_SPEAKER_LABEL ||
    row.speakerLabel === LEGACY_TIMESTAMP_SPEAKER_LABEL
  ) {
    return { kind: "timestamp" };
  }

  const byPseudonym = participants.find(
    (candidate) => candidate.pseudonym === row.speakerLabel,
  );
  if (byPseudonym !== undefined) {
    return {
      kind: "participant",
      participantId: byPseudonym.id,
      pseudonym: byPseudonym.pseudonym,
    };
  }

  return { kind: "unassigned", hint: row.speakerLabel };
}
