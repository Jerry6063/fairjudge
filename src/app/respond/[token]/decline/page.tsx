// `/respond/[token]/decline` — refusing, on its own screen (doc 05 §A.4, §A.5).
//
// It used to be a query parameter on the submission page (`?answer=decline`),
// which put the act of refusing inside the screen for taking part: the reader
// who wanted nothing to do with this had to walk through a form asking her to
// write her account in order to reach the answer she had already chosen. Doc 05
// §A.5 asks for three exits of equal weight, and an exit that opens somebody
// else's door is not one of the three.
//
// The screen's job is to state the consequences BEFORE the act — all four of
// them, from `DECLINE_CONSEQUENCES`, which is exported by the module that
// performs the write so that the sentences and the transaction cannot drift.
// Afterwards, the same route is the record of what happened and the two acts
// that remain hers: reversing it, and closing her own door.
//
// A bad token gets one sentence and no case. The page must never confirm that a
// particular case exists to somebody holding a link they were not given.

import { getDb } from "../../../../server/db";
import { entryHrefs } from "../../../../server/participation/entry";
import {
  DECLINE_CONSEQUENCES,
  resolveRespondingParty,
} from "../../../../server/participation/submission";
import { DeclinePanel } from "./decline-panel";
import { readDeclineState } from "./state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function RespondDeclinePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = getDb();

  // A render is not an act (doc 05 §A.5). Nothing on this path writes until she
  // presses something, and arriving on the decline screen is not declining.
  const party = resolveRespondingParty(db, token, { touch: false });
  if (party === null) {
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-lg font-medium text-neutral-900">
          This link does not open anything
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          It is not one this machine issued, it has expired, or it was replaced
          by a newer one. Nothing is lost, and nothing has been recorded by your
          opening it.
        </p>
      </section>
    );
  }

  const state = readDeclineState(db, token, party);
  const hrefs = entryHrefs(token);

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          <a href={hrefs.entry} className="underline underline-offset-2">
            Back to the start
          </a>
        </p>
        <h1 className="text-lg font-medium text-neutral-900">
          {state.respondState === "declined"
            ? "You have recorded that you are not taking part"
            : "Recording that you are not taking part"}
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          This is a real answer and it is recorded as yours. It is not the same
          as ignoring the link, and it is not read as agreement with anything.
          Read what it does first — nothing is written until you confirm it.
        </p>
      </header>

      <DeclinePanel
        state={state}
        consequences={DECLINE_CONSEQUENCES}
        submitHref={hrefs.addYourAccount}
        transparencyHref={hrefs.transparency}
        entryHref={hrefs.entry}
      />
    </>
  );
}
