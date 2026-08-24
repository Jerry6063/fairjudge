"use client";

/**
 * The filing form, in the order doc 04 §4.1 puts it in.
 *
 *   1. What do you want out of this — three options, and the cost of the chosen
 *      one surfaced the instant it is chosen. That immediacy is the whole point
 *      of the screen: the same information delivered at the end of the pipeline
 *      is a disappointment, and delivered here it is a promise about procedure.
 *   2. The advance-disclosure card, printed unconditionally, before anything is
 *      asked of the person (doc 05 §C amendment 2).
 *   3. The case's name.
 *   4. Both parties' names, with the reason the machine needs them.
 *   5. The first account.
 *
 * Client-side state exists for two things and nothing else: which option is
 * selected, so the cost can appear without a round trip, and the field values,
 * so a refusal from the server does not throw away what somebody typed. The
 * submit itself is a form post to a server action — there is no fetch in this
 * file and no endpoint for a browser to call.
 */

import Link from "next/link";
import { useActionState, useState } from "react";

import { fileCaseAction, type FilingState } from "./actions";
import {
  AdvanceDisclosure,
  FIELD_COPY,
  INTENT_OPTIONS,
  WHY_NAMES,
} from "./copy";
import type { CaseCreationField } from "../../../server/cases";

const FIELD_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm " +
  "text-neutral-900 outline-none focus:border-neutral-900";

const REFUSED_CLASS =
  "w-full rounded-lg border border-rose-400 bg-white px-3 py-2 text-sm " +
  "text-neutral-900 outline-none focus:border-rose-600";

/** The refusal for one field, or nothing. */
function refusalFor(
  state: FilingState,
  field: CaseCreationField,
): string | null {
  return state !== null && state.field === field ? state.message : null;
}

function FieldError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-sm leading-relaxed text-rose-800">
      {message}
    </p>
  );
}

export function FilingForm() {
  const [state, submit, pending] = useActionState<FilingState, FormData>(
    fileCaseAction,
    null,
  );

  const [intent, setIntent] = useState<string>("");
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [account, setAccount] = useState("");

  const chosen = INTENT_OPTIONS.find((option) => option.value === intent);

  return (
    <form action={submit} className="flex flex-col gap-8">
      {/* 1. The question, and the cost of the answer. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-base font-medium text-neutral-900">
          What do you want out of this?
        </legend>
        <p className="text-sm leading-relaxed text-neutral-600">
          The answer decides what this case can produce, so it is asked first
          rather than discovered at the end.
        </p>

        <div className="flex flex-col gap-2">
          {INTENT_OPTIONS.map((option) => (
            <label
              key={option.value}
              htmlFor={`intent-${option.value}`}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                intent === option.value
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-300 bg-white hover:border-neutral-500"
              }`}
            >
              <input
                id={`intent-${option.value}`}
                type="radio"
                name="intent"
                value={option.value}
                checked={intent === option.value}
                onChange={(event) => setIntent(event.target.value)}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-neutral-900">{option.label}</span>
                {option.flag !== null && (
                  <span className="text-xs text-neutral-500">
                    {option.flag}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        {/* The cost, the moment the option is chosen. Not a warning box: it is
            what the product will and will not do, said plainly. */}
        {chosen !== undefined && (
          <div
            aria-live="polite"
            className="flex flex-col gap-2 rounded-lg border border-neutral-900 bg-white p-4"
          >
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
              What that costs
            </p>
            {chosen.consequence.map((line) => (
              <p
                key={line}
                className="text-sm leading-relaxed text-neutral-800"
              >
                {line}
              </p>
            ))}
          </div>
        )}
        <FieldError message={refusalFor(state, "intent")} />
      </fieldset>

      {/* 2. Procedure disclosed before any evidence is requested. */}
      <AdvanceDisclosure />

      {/* 3. The case's name. */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="title"
          className="text-base font-medium text-neutral-900"
        >
          {FIELD_COPY.title.label}
        </label>
        <p className="text-sm leading-relaxed text-neutral-600">
          {FIELD_COPY.title.help}
        </p>
        <input
          id="title"
          name="title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={
            refusalFor(state, "title") !== null ? REFUSED_CLASS : FIELD_CLASS
          }
        />
        <FieldError message={refusalFor(state, "title")} />
      </div>

      {/* 4. Both names, and why the machine needs them. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-base font-medium text-neutral-900">
          Who the two people are
        </legend>
        {WHY_NAMES.map((line) => (
          <p key={line} className="text-sm leading-relaxed text-neutral-600">
            {line}
          </p>
        ))}

        <div className="flex flex-col gap-2">
          <label htmlFor="clientName" className="text-sm text-neutral-900">
            {FIELD_COPY.clientName.label}
          </label>
          <p className="text-xs text-neutral-500">
            {FIELD_COPY.clientName.help}
          </p>
          <input
            id="clientName"
            name="clientName"
            type="text"
            autoComplete="off"
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
            className={
              refusalFor(state, "clientName") !== null
                ? REFUSED_CLASS
                : FIELD_CLASS
            }
          />
          <FieldError message={refusalFor(state, "clientName")} />
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="counterpartyName"
            className="text-sm text-neutral-900"
          >
            {FIELD_COPY.counterpartyName.label}
          </label>
          <p className="text-xs text-neutral-500">
            {FIELD_COPY.counterpartyName.help}
          </p>
          <input
            id="counterpartyName"
            name="counterpartyName"
            type="text"
            autoComplete="off"
            value={counterpartyName}
            onChange={(event) => setCounterpartyName(event.target.value)}
            className={
              refusalFor(state, "counterpartyName") !== null
                ? REFUSED_CLASS
                : FIELD_CLASS
            }
          />
          <FieldError message={refusalFor(state, "counterpartyName")} />
        </div>
      </fieldset>

      {/* 5. The first account. */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="account"
          className="text-base font-medium text-neutral-900"
        >
          {FIELD_COPY.account.label}
        </label>
        <p className="text-sm leading-relaxed text-neutral-600">
          {FIELD_COPY.account.help}
        </p>
        <textarea
          id="account"
          name="account"
          rows={12}
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          className={`${
            refusalFor(state, "account") !== null ? REFUSED_CLASS : FIELD_CLASS
          } font-normal`}
        />
        <FieldError message={refusalFor(state, "account")} />
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-neutral-200 pt-6">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Filing…" : "File the case"}
        </button>
        <Link
          href="/case"
          className="text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
        >
          Cancel
        </Link>
        <p className="text-xs leading-relaxed text-neutral-500">
          Filing creates the case and stores your account. It sends nothing
          anywhere and asks nothing of the other person.
        </p>
      </div>
    </form>
  );
}
