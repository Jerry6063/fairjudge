"use client";

// The one control that moves a case forward.
//
// It is deliberately dumb: it knows the target stage's name and whether the
// server currently considers it reachable, and that is all. The button being
// enabled is a convenience, not the gate — the server re-checks every
// precondition when the action runs, so a stale page clicking an enabled button
// gets the same refusal a hand-written request would.

import { useState, useTransition } from "react";

import type { CaseStage } from "../../../server/db/schema";
import { advanceCaseStageAction } from "./actions";

export function AdvanceControl({
  caseId,
  target,
  targetTitle,
  blocked,
}: {
  caseId: string;
  target: CaseStage;
  targetTitle: string;
  blocked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await advanceCaseStageAction({ caseId, target });
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={blocked || pending}
        onClick={submit}
        className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
      >
        {pending ? "Moving…" : `Move to ${targetTitle}`}
      </button>
      {blocked && (
        <p className="text-xs text-neutral-500">
          Available once everything above is dealt with.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default AdvanceControl;
