"use client";

// Steelman review — the other party's strongest case, put to the user.
//
// The interaction is the ordinary ConfirmCard triple, read in this stage's
// terms: confirm means "they would probably say roughly this", rewrite means
// "here is what they would actually say", and the destructive third option
// means "I cannot recognize them in any of this". The third one is not a
// delete: the server records it as a downgrade signal on the case, which
// output-level derivation reads later. Saying it is a legitimate answer, and
// the copy below says so rather than making it feel like giving up.
//
// ConfirmCard is imported and never edited; everything stage-specific is copy
// overrides and the footer slot. The downgrade banner is deliberately NOT
// rendered here — the page owns it, straight from the case row, so the badge a
// user sees is the flag the pipeline will actually read.

import { useState, useTransition } from "react";

import ConfirmCard from "../../../../components/ConfirmCard";
import type { SteelmanBoard, SteelmanView } from "../../../../server/pipeline";
import { generateSteelmanAction, recordSteelmanVerdictAction } from "./actions";

const LABELS = {
  confirm: "They would probably say roughly this",
  edit: "Write what they would actually say",
  reject: "I cannot recognize them in this",
  rejectArmed: "Record that — and the downgrade",
  save: "Save their version",
  cancel: "Cancel",
  draft: "The machine's version",
  emptyDraft: "(nothing has been written yet)",
  rejectedNote:
    "Recorded: the other party could not be recognized in any version of " +
    "their case that this record supports. That is a downgrade signal — it " +
    "does not stop the case, it limits what the case can support, and the " +
    "judgment has to disclose it.",
};

const VERDICT_NOTE: Readonly<Record<SteelmanView["verdict"], string | null>> = {
  pending: null,
  accepted:
    "Recorded: they would recognize themselves in this. Later stages argue " +
    "with it as a real position rather than a straw man.",
  rebutted:
    "Recorded: your version of what they would say. The other side is still " +
    "argued — in your words instead of the machine's — so nothing is " +
    "downgraded.",
  unable:
    "Recorded as a downgrade signal: the other side of this case could not " +
    "be reconstructed.",
};

export function SteelmanPanel({
  caseId,
  board,
}: {
  caseId: string;
  board: SteelmanBoard;
}) {
  const [current, setCurrent] = useState<SteelmanView | null>(board.current);
  const [unableReason, setUnableReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, startWriting] = useTransition();

  function write() {
    setError(null);
    setUnableReason(null);
    startWriting(async () => {
      const result = await generateSteelmanAction(caseId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setCurrent(result.data.steelman);
      setUnableReason(result.data.unableReason);
    });
  }

  /** ConfirmCard's contract: a rejected promise is a failure it renders. */
  async function answer(
    verdict: "accepted" | "rebutted" | "unable",
    text?: string,
  ) {
    if (current === null) return;
    const result = await recordSteelmanVerdictAction(
      caseId,
      current.id,
      verdict,
      text,
    );
    if (!result.ok) throw new Error(result.message);
    setCurrent(result.data);
  }

  // The stage's own "I cannot write one". Distinct from the user's verdict of
  // the same name: there is no draft to confirm, so there is no card to show.
  const machineUnable =
    current !== null &&
    current.verdict === "unable" &&
    current.confirmStatus === "pending";

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-neutral-900">
          The other side, argued properly
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          Only your material exists in this case. Before anything is judged, the
          strongest honest version of the other person&apos;s case is written
          from the confirmed record — not invented — and put to you. Accept it,
          replace it with what they would actually say, or say that you cannot
          recognize them in it.
        </p>
      </header>

      {current === null ? (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          Nothing has been written yet.
        </p>
      ) : machineUnable ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            No version of their case could be written from this record.
          </p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-amber-900">
            {unableReason ?? current.aiDraft}
          </p>
          <p className="text-xs text-amber-800">
            Recorded as a downgrade signal. Confirming more of what they
            actually said, and writing this again, is what lifts it.
          </p>
        </div>
      ) : (
        <ConfirmCard
          heading={
            <span className="text-xs text-neutral-500">
              Version {current.version}
            </span>
          }
          aiDraft={current.aiDraft}
          humanFinal={current.humanFinal}
          status={current.confirmStatus}
          labels={LABELS}
          onConfirm={() => answer("accepted")}
          onSave={(text) => answer("rebutted", text)}
          onReject={() => answer("unable")}
          footer={
            VERDICT_NOTE[current.verdict] === null ? undefined : (
              <p className="border-t border-neutral-100 pt-3 text-xs text-neutral-500">
                {VERDICT_NOTE[current.verdict]}
              </p>
            )
          }
        />
      )}

      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3">
        <button
          type="button"
          disabled={writing}
          onClick={write}
          className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {writing
            ? "Arguing their side…"
            : current === null
              ? "Write their case"
              : "Write it again (new version)"}
        </button>
        {board.versions.length > 1 && (
          <p className="text-xs text-neutral-500">
            {board.versions.length} versions have been written. The newest is
            the one the case answers.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-rose-700">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export default SteelmanPanel;
