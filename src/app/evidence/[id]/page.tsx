// /evidence/[id] — the line-by-line confirmation workbench.
//
// Server half: open the database, load everything the workbench renders, and
// hand it to the client component. Reading happens per request (`force-dynamic`)
// because the data is a local encrypted SQLite file that changes under the
// user's hands — there is nothing to prerender, and a build-time render could
// not open the database at all.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../server/db";
import { loadWorkbench } from "../../../server/evidence/workbench";
import EvidenceWorkbench from "./EvidenceWorkbench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = loadWorkbench(getDb(), id);
  if (data === null) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <Link href="/evidence" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← Back to evidence
        </Link>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Confirm line by line
        </h1>
        <p className="text-sm text-neutral-600">
          The original screenshot is on the left, every recognized line on the
          right. Only lines you confirm or rewrite can be cited by later
          analysis.
        </p>
      </header>

      <EvidenceWorkbench data={data} />
    </main>
  );
}
