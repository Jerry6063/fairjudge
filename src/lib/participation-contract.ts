// Shared vocabulary for stage ⑥ (counterparty participation): the five answers
// the screen offers and the copy that says what each one claims.
//
// The panel is a client component and imports this module, so nothing here may
// pull in `src/server/` at runtime. The only import is type-only and erased at
// compile time; `server/pipeline/participation.ts` re-exports these constants so
// the server and the screen cannot describe the same column differently.

import type { ParticipationState } from "../server/db/schema";

export type { ParticipationState };

/**
 * The states that count as an answer. `pending` is excluded on purpose: it is
 * the absence of an answer, not one of them. Order is the order the screen
 * offers them — most engaged first, so the list reads as a descent rather than
 * a menu.
 */
export const PARTICIPATION_ANSWERS = [
  "participating",
  "written_response",
  "refused",
  "unreachable",
  "unaware",
] as const;

export type ParticipationAnswer = (typeof PARTICIPATION_ANSWERS)[number];

/** Screen copy for each state: what it claims, and whether it is engagement. */
export interface ParticipationMeta {
  readonly label: string;
  /** What picking this says happened, in the user's words. */
  readonly meaning: string;
  /** True when the other side has actually said something on the record. */
  readonly engaged: boolean;
}

export const PARTICIPATION_META: Readonly<
  Record<ParticipationState, ParticipationMeta>
> = {
  pending: {
    label: "Not settled yet",
    meaning: "Nobody has recorded what happened when the other person was asked.",
    engaged: false,
  },
  participating: {
    label: "They are taking part",
    meaning:
      "The other person is in this process and can answer for themselves.",
    engaged: true,
  },
  written_response: {
    label: "They sent a written response",
    meaning:
      "They are not in the process, but they have put their side in writing " +
      "and it is on the record.",
    engaged: true,
  },
  refused: {
    label: "They were asked and refused",
    meaning:
      "They know about this and chose not to take part. Their silence is a " +
      "decision, not an absence of information.",
    engaged: false,
  },
  unreachable: {
    label: "They could not be reached",
    meaning: "An attempt was made and did not arrive.",
    engaged: false,
  },
  unaware: {
    label: "They do not know about this",
    meaning:
      "They have not been asked at all. Nothing here has been put to them, " +
      "and anything said about them is one person's account.",
    engaged: false,
  },
};
