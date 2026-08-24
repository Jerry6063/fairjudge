"use client";

// The invitation control — the only act on the client's side of the wait.
//
// It holds state for one reason: the link comes back from the server once and
// is never stored, so there is a moment where the only copy of a working
// invitation into somebody's relationship is in this component. That is why the
// panel around it says so in as many words rather than styling it as a success
// toast.
//
// The button being present is not the gate. `createInvitationAction` re-reads
// the row and refuses a decline (doc 05 §A.4) whatever this screen believes, so
// a stale tab clicking a button that should have gone gets the doctrine's own
// sentence back instead of a link.

import { useState, useTransition } from "react";

import { createInvitationAction, type InviteActionData } from "./invite-actions";
import { INVITE_LINK_FACTS, utc } from "./wait-labels";

export function InviteControl({ caseId }: { caseId: string }) {
  const [pending, startTransition] = useTransition();
  const [minted, setMinted] = useState<InviteActionData | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function mint() {
    setRefusal(null);
    startTransition(async () => {
      const result = await createInvitationAction({ caseId });
      if (!result.ok) {
        setRefusal(result.message);
        return;
      }
      setMinted(result.data);
    });
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // The browser's call. The link is on screen and selectable either way.
      setCopied(false);
    }
  }

  if (minted !== null) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
        <p className="text-sm font-medium text-neutral-900">
          The invitation exists. It is shown once.
        </p>
        <code className="rounded border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs break-all text-neutral-800">
          {minted.link}
        </code>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void copy(minted.link)}
            className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-800 hover:bg-neutral-100"
          >
            {copied ? "Copied" : "Copy the link"}
          </button>
          <span className="text-xs text-neutral-500">
            Created {utc(new Date(minted.issuedAtIso))} · stops working{" "}
            {utc(new Date(minted.expiresAtIso))}
          </span>
        </div>
        <p className="max-w-[64ch] text-xs leading-relaxed text-neutral-600">
          Only the hash of this token is stored, so nothing on this machine can
          produce the link again — a database that could would be a database that
          leaks the way into this case. Passing it to {minted.recipientPseudonym}{" "}
          is yours to do, in whatever channel you choose. Nothing here sends it,
          and nothing here will know whether you did.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={mint}
        className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
      >
        {pending ? "Creating…" : "Create an invitation"}
      </button>
      <ul className="flex max-w-[64ch] flex-col gap-1">
        {INVITE_LINK_FACTS.map((fact) => (
          <li key={fact} className="text-xs leading-relaxed text-neutral-600">
            <span aria-hidden className="mr-1 text-neutral-400">
              •
            </span>
            {fact}
          </li>
        ))}
      </ul>
      {refusal !== null && (
        <p className="max-w-[64ch] text-xs leading-relaxed text-neutral-700">
          {refusal}
        </p>
      )}
    </div>
  );
}

export default InviteControl;
