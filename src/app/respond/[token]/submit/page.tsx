// `/respond/[token]/submit` — where the other party adds her own account.
//
// The write half of her entry (SPEC M5 ②). The entry screen above it explains
// what this case is and shows her the steelman of her own position; this page
// only does the three things she can actually DO: write her side, stand behind
// each line of it, or decline.
//
// What it deliberately does not render: the judgment, the client's material, or
// anything at all when the token does not resolve. A bad token gets one sentence
// and no case — the page must not confirm that a particular case exists to
// somebody holding a link they were not given.
//
// The token in the URL is the whole authentication, so it is resolved here
// against a stored hash and never trusted as an identifier: every action posts
// the token back and resolves it again server-side.

import { getDb } from "../../../../server/db";
import { readOwnClarification } from "../../../../server/participation/clarification";
import { entryHrefs } from "../../../../server/participation/entry";
import {
  readSubmissionState,
  resolveRespondingParty,
  SubmissionError,
  type SubmissionState,
} from "../../../../server/participation/submission";
import { SubmitPanel } from "./submit-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Refused({ message }: { message: string }) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-lg font-medium text-neutral-900">
        This link does not open anything
      </h1>
      <p className="text-sm leading-relaxed text-neutral-600">{message}</p>
    </section>
  );
}

export default async function RespondSubmitPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ answer?: string }>;
}) {
  const { token } = await params;
  // The entry screen addresses declining as `?answer=decline` (`entryHrefs`), so
  // that door lands on this page with the answer already in view. It opens the
  // section and puts the cursor in it; it does not pre-arm the button, because a
  // link somebody clicked is not somebody deciding.
  const declineFirst = (await searchParams).answer === "decline";
  const db = getDb();

  // `touch: false` — rendering a screen is not an act, and a render can be
  // retried. Her actions record that she was here; a GET does not.
  const party = resolveRespondingParty(db, token, { touch: false });
  if (party === null) {
    return (
      <Refused
        message={
          "This link is not one this machine issued, it has expired, or it was " +
          "replaced by a newer one. Nothing is lost — a fresh link opens the " +
          "same place."
        }
      />
    );
  }

  let state: SubmissionState;
  try {
    state = readSubmissionState(
      db,
      party.participant.caseId,
      party.participant.id,
    );
  } catch (cause) {
    if (cause instanceof SubmissionError) {
      return <Refused message={cause.message} />;
    }
    throw cause;
  }

  const clarification = readOwnClarification(
    db,
    party.participant.caseId,
    party.participant.id,
  );
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
          Add what you want this case to know
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          This page holds only what you put here. It is not the judgment, it
          shows none of the other party&apos;s material, and it decides nothing
          on your behalf — you can stop at any point, including by declining
          outright.
        </p>
      </header>

      <SubmitPanel
        token={token}
        state={state}
        clarification={clarification}
        declineHref={hrefs.decline}
        declineFirst={declineFirst}
      />
    </>
  );
}
