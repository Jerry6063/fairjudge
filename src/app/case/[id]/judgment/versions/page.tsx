// /case/[id]/judgment/versions — the version-comparison view (SPEC M3 wave B ⑫).
//
// HARD RULE #6 does not merely permit a re-hearing, it conditions one: a
// regenerated judgment must disclose the diff and which model produced it. This
// page is where that disclosure is actually made to a person, so it leads with
// the three things the rule names — what changed, which model served each
// version, and whether the server-side fallback answered instead — before it
// shows a single line of prose.
//
// Nothing is computed here. The comparison comes from
// `server/judgment/versions.ts`, the same function a script or an export would
// call, so the page cannot drift into a second opinion about what changed.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../../server/db";
import {
  compareJudgmentVersions,
  listVersionSides,
  type DiffLine,
  type VersionComparison,
  type VersionSide,
} from "../../../../../server/judgment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function JudgmentVersionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let versions: VersionSide[];
  let comparison: VersionComparison | null;
  try {
    const db = getDb();
    versions = listVersionSides(db, id);
    comparison = compareJudgmentVersions(db, id);
  } catch {
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  if (versions.length === 0) notFound();

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          Judgment history
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          Versions of this judgment
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          A judgment that has been issued is never rewritten. Re-hearing the case
          writes a new version and keeps the old one exactly as it was, so both
          can be read side by side.
        </p>
      </div>

      <ol className="flex flex-col gap-2">
        {versions.map((side) => (
          <li
            key={side.judgmentId}
            className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium text-neutral-900">
                Version {side.version}
              </span>
              <span className="text-xs text-neutral-500">{side.status}</span>
              <span className="text-xs text-neutral-500">
                {side.outputLevel}
              </span>
              {side.finalizedAt !== null && (
                <span className="text-xs text-neutral-500">
                  issued {side.finalizedAt.toISOString().slice(0, 10)}
                </span>
              )}
            </div>
            <p className="text-xs text-neutral-600">
              Written by <span className="font-mono">{side.model}</span>
              {side.effort === null ? "" : ` at effort ${side.effort}`}
              {side.promptVersion === null ? "" : ` (${side.promptVersion})`}.
            </p>
            {side.fallbackUsed && (
              <p className="text-xs text-amber-800">
                Served by the fallback model: the request was routed away from
                the model that was asked for, and this text was written by a
                different one.
              </p>
            )}
          </li>
        ))}
      </ol>

      {comparison === null ? (
        <p className="text-sm text-neutral-600">
          There is one version, so there is nothing to compare it against.
        </p>
      ) : (
        <ComparisonBlock comparison={comparison} />
      )}

      <Link
        href={`/case/${id}`}
        className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
      >
        Back to the case overview
      </Link>
    </section>
  );
}

function ComparisonBlock({ comparison }: { comparison: VersionComparison }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
        <p className="text-xs font-medium text-neutral-900">
          What changed between version {comparison.before.version} and version{" "}
          {comparison.after.version}
        </p>
        <p className="text-xs leading-relaxed text-neutral-700">
          {comparison.disclosure}
        </p>
      </div>

      {comparison.allocationChanges.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-neutral-900">Responsibility</h3>
          <ul className="flex flex-col gap-1">
            {comparison.allocationChanges.map((change) => (
              <li key={change.party} className="text-xs text-neutral-700">
                {change.party}: {change.before ?? "none"} → {change.after ?? "none"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(comparison.claimsAdded.length > 0 ||
        comparison.claimsRemoved.length > 0 ||
        comparison.claimsChanged.length > 0) && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-neutral-900">
            The findings underneath
          </h3>
          {comparison.claimsAdded.map((claim) => (
            <p key={claim.claimId} className="text-xs text-emerald-800">
              + {claim.claimId}: {claim.statement}
            </p>
          ))}
          {comparison.claimsRemoved.map((claim) => (
            <p key={claim.claimId} className="text-xs text-rose-800">
              − {claim.claimId}: {claim.statement}
            </p>
          ))}
          {comparison.claimsChanged.map((change) => (
            <p key={change.claimId} className="text-xs text-neutral-700">
              {change.claimId} changed ({change.changed.join(", ")}):{" "}
              {change.before.tier} {change.before.confidence} →{" "}
              {change.after.tier} {change.after.confidence}
            </p>
          ))}
        </div>
      )}

      {comparison.sectionsChanged.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-neutral-900">The text itself</h3>
          {comparison.sectionsChanged.map((section) => (
            <div key={section.sectionId} className="flex flex-col gap-1">
              <p className="text-xs font-medium text-neutral-800">
                {section.heading}
                {section.audienceChanged && " (audience changed)"}
              </p>
              <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed whitespace-pre-wrap">
                {section.diff.map((line, index) => (
                  <DiffRow key={index} line={line} />
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const className =
    line.op === "added"
      ? "text-emerald-800"
      : line.op === "removed"
        ? "text-rose-800"
        : "text-neutral-500";
  const marker = line.op === "added" ? "+" : line.op === "removed" ? "−" : " ";
  return (
    <span className={`block ${className}`}>
      {marker} {line.text}
    </span>
  );
}
