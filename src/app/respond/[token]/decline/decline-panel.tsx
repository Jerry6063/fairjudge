"use client";

// The decline confirmation, and the door that stays open behind it.
//
// Doc 05 §A.4 fixes what this screen must say, and it must say it BEFORE the
// button rather than after: participation becomes `refused` by her own act; the
// existing analysis stands unchanged at its one-sided level; later versions
// state "invited, declined" as a fact and may infer nothing from it; she keeps
// this door. Those four sentences are not written here — they come from
// `DECLINE_CONSEQUENCES` in the module that performs the write, so the promise
// and the transaction cannot drift apart.
//
// Once she has declined, the same screen becomes the record of it, plus the two
// acts that remain hers: reversing the decision, and closing her own door.

import { useState, useTransition } from "react";

import type { ActionResult } from "../../../../lib/action-result";
import { closeDoorAction, recordDeclineAction, reopenAction } from "./actions";
import type { DeclineState } from "./state";

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export function DeclinePanel({
  state,
  consequences,
  submitHref,
  transparencyHref,
  entryHref,
}: {
  state: DeclineState;
  /** `DECLINE_CONSEQUENCES`, passed in rather than restated. */
  consequences: readonly string[];
  submitHref: string;
  transparencyHref: string;
  entryHref: string;
}) {
  const [current, setCurrent] = useState(state);
  const [reason, setReason] = useState("");
  const [armed, setArmed] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const declined = current.respondState === "declined";

  function run<T>(
    action: () => Promise<ActionResult<T>>,
    onOk: (data: T) => void,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) onOk(result.data);
      else setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {declined ? (
        <RecordedDecline state={current} consequences={consequences} />
      ) : (
        <BeforeYouDecide consequences={consequences} />
      )}

      {!declined && (
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
          <label htmlFor="decline-reason" className="text-sm font-medium text-neutral-900">
            A reason, if you want to give one
          </label>
          <p className="text-xs leading-relaxed text-neutral-600">
            It is kept word for word, in whatever language you write it, and it
            is never rewritten or translated. Giving none is a complete answer
            and is not recorded as evasion.
          </p>
          <textarea
            id="decline-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            disabled={pending}
            className="w-full resize-y rounded-lg border border-neutral-300 p-3 text-sm leading-relaxed text-neutral-900 outline-none focus:border-neutral-500 disabled:bg-neutral-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            {armed ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () =>
                        recordDeclineAction(current.token, {
                          reason: reason.trim() === "" ? null : reason,
                        }),
                      (data) => {
                        setCurrent(data);
                        setArmed(false);
                      },
                    )
                  }
                  className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
                >
                  {pending ? "Recording…" : "Yes — record that I am not taking part"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setArmed(false)}
                  className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-neutral-800"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setArmed(true)}
                className="rounded-lg border border-neutral-400 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
              >
                Record that I am not taking part
              </button>
            )}
          </div>
          <p className="text-xs text-neutral-500">
            Nothing is written until you confirm. Leaving this page without
            confirming records nothing at all.
          </p>
        </section>
      )}

      {/* Every screen on this route keeps the other two doors in view, at the
          same weight. A confirmation screen that offered only its own act would
          be a funnel. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-900">
          {declined ? "What is still open to you" : "Or, instead of declining"}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <li className="flex">
            <a
              href={submitHref}
              className="flex w-full flex-col gap-1 rounded-xl border border-neutral-300 p-4 hover:bg-neutral-50"
            >
              <span className="text-sm font-medium text-neutral-900">
                {declined ? "Change your answer and add your account" : "Add your account"}
              </span>
              <span className="text-xs leading-relaxed text-neutral-600">
                Say what happened in your own words. You confirm it line by line,
                and it stays yours.
              </span>
            </a>
          </li>
          <li className="flex">
            <a
              href={transparencyHref}
              className="flex w-full flex-col gap-1 rounded-xl border border-neutral-300 p-4 hover:bg-neutral-50"
            >
              <span className="text-sm font-medium text-neutral-900">
                Read everything held about you
              </span>
              <span className="text-xs leading-relaxed text-neutral-600">
                Item by item, with where each came from, and what you can delete
                or ask to have deleted.
              </span>
            </a>
          </li>
        </ul>
      </section>

      {declined && (
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-900">
            Taking this answer back
          </h2>
          <p className="text-xs leading-relaxed text-neutral-600">
            You can reverse this, and nobody else can. Reversing it puts your
            participation back to undecided and lets you add your account
            afterwards. What you wrote as your reason stays on file either way —
            a change of mind is a second act, not an erasure of the first, and
            this product does not delete your words on your behalf.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => reopenAction(current.token),
                  (data) => setCurrent(data),
                )
              }
              className="rounded-lg border border-neutral-400 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
            >
              {pending ? "Working…" : "Take this answer back"}
            </button>
            <a
              href={entryHref}
              className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
            >
              Back to the start
            </a>
          </div>
        </section>
      )}

      {/* Closing her own door: last, framed as the irreversible one it is. */}
      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-900">
          Closing this door for good
        </h2>
        {closed ? (
          <p className="text-sm leading-relaxed text-neutral-900">
            This link has been closed. It will not open anything again, and
            nothing can re-create it — the machine never stored the link itself,
            only a fingerprint of it, and that has been cleared.
          </p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-neutral-600">
              This stops the link working, for you as well. It is the one thing
              on this screen that cannot be undone: nothing stored anywhere can
              re-create the link, and{" "}
              {current.mintingClosed
                ? "no further invitation will be created for you either."
                : "you would need a fresh invitation to come back."}{" "}
              Nothing held about you is deleted by it — deleting material is a
              different act, on the transparency view.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {closeArmed ? (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => closeDoorAction(current.token),
                        (data) => {
                          setClosed(data.revoked);
                          setCloseArmed(false);
                          if (!data.revoked) {
                            setError(
                              "There was no live link on this record to close.",
                            );
                          }
                        },
                      )
                    }
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
                  >
                    {pending ? "Closing…" : "Yes, close it permanently"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setCloseArmed(false)}
                    className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-neutral-800"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setCloseArmed(true)}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
                >
                  Close this link permanently
                </button>
              )}
            </div>
          </>
        )}
      </section>

      {error !== null && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Before                                                                     */
/* -------------------------------------------------------------------------- */

/** The four consequences, stated before the act rather than after it. */
function BeforeYouDecide({ consequences }: { consequences: readonly string[] }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-300 bg-neutral-50 p-5">
      <h2 className="text-sm font-medium text-neutral-900">
        What declining does, exactly
      </h2>
      <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm leading-relaxed text-neutral-800">
        {consequences.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <p className="text-xs leading-relaxed text-neutral-600">
        Nothing you have already submitted is deleted by declining, and nothing
        held about you is removed. Those are separate acts, on the transparency
        view, and they stay available to you afterwards.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* After                                                                      */
/* -------------------------------------------------------------------------- */

/** The done state: what was recorded, in the same words she was shown. */
function RecordedDecline({
  state,
  consequences,
}: {
  state: DeclineState;
  consequences: readonly string[];
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-300 bg-neutral-50 p-5">
      <h2 className="text-sm font-medium text-neutral-900">
        Recorded: you are not taking part
      </h2>

      {state.declineReason !== null && (
        <blockquote className="border-l-2 border-neutral-400 pl-4 text-sm leading-relaxed whitespace-pre-wrap text-neutral-900">
          {state.declineReason}
        </blockquote>
      )}

      <p className="text-sm leading-relaxed text-neutral-800">
        That is now the record&rsquo;s answer, given by you. This is what it did,
        which is what you were told it would do:
      </p>
      <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm leading-relaxed text-neutral-800">
        {consequences.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>

      <ul className="flex list-disc flex-col gap-1 border-t border-neutral-200 pt-3 pl-4 text-xs leading-relaxed text-neutral-600">
        <li>
          {state.mintingClosed
            ? "No further invitation can be created for you. That is enforced where invitations are made, not by a hidden button."
            : "No further invitation is being created for you."}
        </li>
        <li>
          {state.standing
            ? "Your link no longer expires. It is now your own standing way back in, for as long as you want it."
            : state.hasAccount
              ? "You already hold an account here, and it does not expire. That is your way back in."
              : "Your link's deadline is unchanged."}
        </li>
      </ul>
    </section>
  );
}

export default DeclinePanel;
