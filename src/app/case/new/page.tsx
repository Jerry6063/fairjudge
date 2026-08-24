// /case/new — the front door.
//
// The product had no way to create a case: the only one in the database was put
// there by the seed importer. This is the screen that makes filing an act a
// person performs rather than a script somebody runs.
//
// The page itself is a frame. Everything that matters is in `filing-form.tsx`
// and `copy.tsx` — the order of the questions, and the words.

import Link from "next/link";

import { FilingForm } from "./filing-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function NewCasePage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6 sm:p-10">
        <div className="flex flex-col gap-3">
          <Link
            href="/case"
            className="w-fit text-sm text-neutral-500 hover:text-neutral-800"
          >
            ← All cases
          </Link>
          <h1 className="text-2xl font-semibold">File a case</h1>
          <p className="text-sm leading-relaxed text-neutral-700">
            This produces a written document about one conflict, at a level
            computed from what the record actually contains. It is not a court,
            it is not a lawyer, and it is not therapy. Everything below stays on
            this machine except the text sent to a model, which has both names
            replaced first.
          </p>
        </div>

        <FilingForm />
      </div>
    </main>
  );
}
