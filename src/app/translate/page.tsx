"use client";

// The plain-speech translator — the /translate page.
//
// One textarea, two submit paths (default / deep reading), and a three-column
// readout. The three readings are always rendered side by side and never
// ranked: presenting one of them as "the" answer is exactly what this product
// refuses to do, so the layout, not the copy, carries that rule.

import Link from "next/link";
import { useState } from "react";

import {
  TRANSLATE_MAX_CHARS,
  type TranslateResponseBody,
  type TranslateSuccessBody,
} from "../../lib/translate-contract";

type Translation = TranslateSuccessBody["data"];
type Meta = TranslateSuccessBody["meta"];

/** Which submit path is in flight, if any. */
type Pending = "default" | "deep" | null;

interface Failure {
  message: string;
  detail?: string;
}

/**
 * Per-reading presentation. Class strings are written out in full because
 * Tailwind only sees literals — never build them by concatenation.
 */
const READINGS = [
  {
    key: "benign",
    label: "Benign reading",
    hint: "Giving them the benefit of the doubt",
    card: "border-emerald-200 bg-emerald-50",
    title: "text-emerald-900",
    track: "bg-emerald-100",
    bar: "bg-emerald-500",
  },
  {
    key: "neutral",
    label: "Neutral reading",
    hint: "Taking it at face value",
    card: "border-slate-200 bg-slate-50",
    title: "text-slate-900",
    track: "bg-slate-200",
    bar: "bg-slate-500",
  },
  {
    key: "negative",
    label: "Negative reading",
    hint: "Reading it in the worst light",
    card: "border-rose-200 bg-rose-50",
    title: "text-rose-900",
    track: "bg-rose-100",
    bar: "bg-rose-500",
  },
] as const;

function percent(confidence: number): number {
  return Math.round(Math.min(Math.max(confidence, 0), 1) * 100);
}

export default function TranslatePage() {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [result, setResult] = useState<Translation | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const trimmed = text.trim();
  const tooLong = text.length > TRANSLATE_MAX_CHARS;
  const canSubmit = trimmed.length > 0 && !tooLong && pending === null;

  async function submit(deep: boolean) {
    if (!canSubmit) return;
    setPending(deep ? "deep" : "default");
    setFailure(null);
    setResult(null);
    setMeta(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, deep }),
      });
      const body = (await response.json()) as TranslateResponseBody;

      if (body.ok) {
        setResult(body.data);
        setMeta(body.meta);
      } else {
        setFailure({ message: body.error, detail: body.detail });
      }
    } catch {
      setFailure({
        message:
          "The request did not go through. The local server may have stopped, or it returned something unexpected.",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6 sm:p-10">
      <header className="flex flex-col gap-2">
        <Link
          href="/"
          className="text-sm text-neutral-500 hover:text-neutral-800"
        >
          ← Home
        </Link>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Plain-speech translator
        </h1>
        <p className="text-sm text-neutral-600">
          Take one vague, loaded or passive-aggressive line and read it three
          ways, in plain words.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <label
          htmlFor="translate-input"
          className="text-sm font-medium text-neutral-800"
        >
          What the other person said
        </label>
        <textarea
          id="translate-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder="e.g. 随便你，我无所谓。"
          className="w-full resize-y rounded-lg border border-neutral-300 p-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={!canSubmit}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {pending === "default" ? "Translating…" : "Translate"}
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={!canSubmit}
            title="Re-read with a stronger model: slower, and it costs more"
            className="rounded-lg border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-300 disabled:text-neutral-400"
          >
            {pending === "deep" ? "Reading closely…" : "Deep reading"}
          </button>
          <span
            className={tooLong ? "text-sm text-rose-600" : "text-sm text-neutral-500"}
          >
            {text.length} / {TRANSLATE_MAX_CHARS} characters
          </span>
        </div>
      </section>

      {pending !== null && (
        <p className="text-sm text-neutral-500">
          {pending === "deep"
            ? "Reading it closely with the stronger model; this usually takes ten to twenty seconds…"
            : "Reading it…"}
        </p>
      )}

      {failure !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-rose-200 bg-rose-50 p-4"
        >
          <p className="text-sm font-medium text-rose-900">{failure.message}</p>
          {failure.detail !== undefined && (
            <p className="font-mono text-xs break-all text-rose-700">
              {failure.detail}
            </p>
          )}
        </div>
      )}

      {result !== null && (
        <section className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            {READINGS.map((reading) => {
              const value = result[reading.key];
              return (
                <article
                  key={reading.key}
                  className={`flex flex-col gap-3 rounded-xl border p-4 ${reading.card}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className={`text-base font-semibold ${reading.title}`}>
                      {reading.label}
                    </h2>
                    <span className="text-xs text-neutral-500">
                      {reading.hint}
                    </span>
                  </div>

                  <p className="text-sm leading-relaxed text-neutral-800">
                    {value.reading}
                  </p>

                  <div className="mt-auto flex flex-col gap-1">
                    <div className="flex items-center justify-between text-xs text-neutral-600">
                      <span>Confidence</span>
                      <span>{percent(value.confidence)}%</span>
                    </div>
                    <div
                      className={`h-1.5 w-full overflow-hidden rounded-full ${reading.track}`}
                    >
                      <div
                        className={`h-full rounded-full ${reading.bar}`}
                        style={{ width: `${percent(value.confidence)}%` }}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {result.cues.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-neutral-800">
                Linguistic cues
              </h3>
              <ul className="flex flex-wrap gap-2">
                {result.cues.map((cue) => (
                  <li
                    key={cue}
                    className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-700"
                  >
                    {cue}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {meta !== null && (
            <p className="text-xs text-neutral-500">
              Model {meta.model}
              {meta.effort !== null && ` · effort ${meta.effort}`}
              {meta.fallbackUsed && " · fell back to the substitute model"} · cost $
              {meta.costUsd.toFixed(4)} · {(meta.latencyMs / 1000).toFixed(1)}s
            </p>
          )}
        </section>
      )}

      <footer className="mt-auto border-t border-neutral-200 pt-4">
        <p className="text-xs text-neutral-500">
          A translation is a reading of what was meant. It is not a finding of
          fact.
        </p>
      </footer>
    </main>
  );
}
