/**
 * Reading the improvement contract from the outside — the documented seam
 * (SPEC M4 ②/④).
 *
 * The contract is built by different code on a different schedule, and this
 * module is deliberately not coupled to it. It reads the
 * `improvement_contracts.content` JSON through a tolerant extractor rather than
 * importing the contract layer's own types, for two reasons:
 *
 *   1. **The follow-up scheduler must work before the contract exists.** A
 *      check-in scheduled at freeze time may fire against a case that never got
 *      a contract, or got one whose shape changed after this was written.
 *      Neither is a reason to skip the check-in.
 *   2. **A shape it does not recognize degrades to "no commitments", never to a
 *      crash.** The questions then ask about the behaviour the judgment
 *      established instead of about a commitment. That is a worse follow-up
 *      and a much better failure than none at all.
 *
 * The extractor accepts the field names the contract layer is most likely to
 * use and normalizes them. When the contract layer settles, this becomes a
 * two-line adapter — but until then it is what keeps the two halves buildable
 * independently.
 *
 * The **L2 rule matters here**: only the client's items are commitments; items
 * addressed to the counterparty are invitations, because she was never heard
 * and cannot commit to anything. A follow-up asks "did you do it" about a
 * commitment. It never asks the client to report on whether the other party
 * kept a promise she never made — an invitation is carried only as context for
 * "was it noticed".
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db";
import { improvementContracts } from "../db/schema";

/** What a follow-up needs to know about one contract item. */
export interface CommitmentItem {
  /** Stable id used by the generated questions to point back here. */
  readonly id: string;
  /** The action as the contract states it. Quoted, never rewritten. */
  readonly action: string;
  /**
   * `commitment` — the client's, and answerable ("did you do it").
   * `invitation` — addressed to the counterparty at L2, and context only.
   */
  readonly kind: "commitment" | "invitation";
  /** Claim ids the item is tied to; validated against the frozen fact layer. */
  readonly claimRefs: readonly string[];
}

export interface ContractSnapshot {
  readonly contractId: string | null;
  readonly items: readonly CommitmentItem[];
  /** Why there are no items, when there are none. Surfaced in the UI. */
  readonly note: string | null;
}

export const EMPTY_SNAPSHOT: ContractSnapshot = {
  contractId: null,
  items: [],
  note: "no improvement contract on this case",
};

/**
 * The field names this extractor will answer to. Loose on purpose — see the
 * module comment; a rename in the contract layer must not silence follow-ups.
 */
const itemSchema = z
  .object({
    id: z.string().optional(),
    commitment_id: z.string().optional(),
    item_id: z.string().optional(),
    action: z.string().optional(),
    commitment: z.string().optional(),
    statement: z.string().optional(),
    text: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    addressed_to: z.string().optional(),
    claim_ids: z.array(z.string()).optional(),
    claim_refs: z.array(z.string()).optional(),
  })
  .passthrough();

const contentSchema = z
  .object({
    commitments: z.array(itemSchema).optional(),
    invitations: z.array(itemSchema).optional(),
    items: z.array(itemSchema).optional(),
  })
  .passthrough();

type RawItem = z.infer<typeof itemSchema>;

function normalize(raw: RawItem, index: number, fallbackKind: CommitmentItem["kind"]) {
  const action = raw.action ?? raw.commitment ?? raw.statement ?? raw.text ?? "";
  if (action.trim() === "") return null;

  const declared = (raw.kind ?? raw.type ?? "").toLowerCase();
  const addressed = (raw.addressed_to ?? "").toLowerCase();
  const kind: CommitmentItem["kind"] =
    declared.includes("invitation") || addressed.includes("counterparty")
      ? "invitation"
      : declared.includes("commitment")
        ? "commitment"
        : fallbackKind;

  return {
    id: raw.id ?? raw.commitment_id ?? raw.item_id ?? `item-${index + 1}`,
    action: action.trim(),
    kind,
    claimRefs: raw.claim_ids ?? raw.claim_refs ?? [],
  } satisfies CommitmentItem;
}

/** Pull the items out of one contract's `content` JSON. Never throws. */
export function extractCommitments(content: unknown): CommitmentItem[] {
  const parsed = contentSchema.safeParse(content);
  if (!parsed.success) return [];

  const items: CommitmentItem[] = [];
  const push = (raws: RawItem[] | undefined, fallback: CommitmentItem["kind"]): void => {
    for (const [index, raw] of (raws ?? []).entries()) {
      const item = normalize(raw, items.length + index, fallback);
      if (item !== null) items.push(item);
    }
  };

  push(parsed.data.commitments, "commitment");
  push(parsed.data.invitations, "invitation");
  push(parsed.data.items, "commitment");

  // Same id twice (two arrays carrying the same item, say) — keep the first.
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Read the contract a follow-up should ask about.
 *
 * `contractId` wins when the row is linked; otherwise falls back to the case's
 * contract, so a check-in scheduled before the contract existed still finds it.
 */
export function readContractSnapshot(
  db: Db,
  caseId: string,
  contractId: string | null,
): ContractSnapshot {
  const row =
    contractId === null
      ? db
          .select()
          .from(improvementContracts)
          .where(eq(improvementContracts.caseId, caseId))
          .get()
      : db
          .select()
          .from(improvementContracts)
          .where(eq(improvementContracts.id, contractId))
          .get();

  if (row === undefined) return EMPTY_SNAPSHOT;

  const items = extractCommitments(row.content);
  return {
    contractId: row.id,
    items,
    note:
      items.length === 0
        ? "the improvement contract on this case carries no readable commitments"
        : null,
  };
}
