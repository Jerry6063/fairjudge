"use client";

// The one question stage ⑥ asks.
//
// Five buttons, each spelling out what picking it claims happened. There is no
// "skip" and no default: the pending state is the absence of an answer, and the
// stage machine refuses to enter issue fixing while it is still there. The
// answer is not a judgement about the other person — it is a fact about the
// process, and the record has to carry it either way.

import { useState, useTransition } from "react";

import {
  PARTICIPATION_ANSWERS,
  PARTICIPATION_META,
  type ParticipationAnswer,
} from "../../../../lib/participation-contract";
import type { ParticipationBoard } from "../../../../server/pipeline";
import { setParticipationAction } from "./actions";

export function ParticipationPanel({
  caseId,
  board,
}: {
  caseId: string;
  board: ParticipationBoard;
}) {
  const [current, setCurrent] = useState(board);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const counterparty = current.counterparty;

  function choose(state: ParticipationAnswer) {
    setError(null);
    startTransition(async () => {
      const result = await setParticipationAction({ caseId, state });
      if (result.ok) {
        setCurrent(result.data);
      } else {
        setError(result.message);
      }
    });
  }

  if (counterparty === null) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm text-amber-900">
          This case has no second party on it, so there is no participation
          state to settle.
        </p>
      </section>
    );
  }

  const settled = counterparty.participationState !== "pending";

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-neutral-900">
          What happened when {counterparty.pseudonym} was asked?
        </h2>
        <p className="text-xs leading-relaxed text-neutral-600">
          The other party in this case is {counterparty.pseudonym}
          {counterparty.displayName === null
            ? ""
            : ` (${counterparty.displayName}, local only — the name never leaves this machine)`}
          . Nothing here is a judgement about them; it records whether they have
          had a chance to speak, which is one of the three inputs the output
          level is derived from.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {PARTICIPATION_ANSWERS.map((state) => {
          const meta = PARTICIPATION_META[state];
          const selected = counterparty.participationState === state;
          return (
            <li key={state}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={pending}
                onClick={() => choose(state)}
                className={
                  selected
                    ? "flex w-full flex-col gap-0.5 rounded-lg border border-neutral-900 bg-neutral-900 p-3 text-left disabled:opacity-60"
                    : "flex w-full flex-col gap-0.5 rounded-lg border border-neutral-300 p-3 text-left hover:bg-neutral-50 disabled:opacity-60"
                }
              >
                <span
                  className={
                    selected
                      ? "text-sm font-medium text-white"
                      : "text-sm font-medium text-neutral-900"
                  }
                >
                  {meta.label}
                </span>
                <span
                  className={
                    selected
                      ? "text-xs leading-relaxed text-neutral-200"
                      : "text-xs leading-relaxed text-neutral-600"
                  }
                >
                  {meta.meaning}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {error !== null && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}

      <p className="border-t border-neutral-100 pt-3 text-xs text-neutral-500">
        {settled
          ? `Recorded: ${PARTICIPATION_META[counterparty.participationState].label}. ` +
            `It can be changed here while the case is still in this stage.`
          : "Not settled yet. Issue fixing does not open until one of these is picked."}
      </p>
    </section>
  );
}

export default ParticipationPanel;
