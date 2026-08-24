// /case/[id]/post_judgment — what the judgment is supposed to change
// (SPEC M4 ②③).
//
// Two documents, derived from the frozen judgment and shown next to the thing
// they were derived from. The screen is deliberately literal about three
// distinctions that matter more here than anywhere else in the product:
//
//   1. **A commitment and an invitation are not the same object.** At L2 the
//      other party was never heard, so nothing in this case can bind her. Items
//      addressed to her are stored as invitations and appear under their own
//      heading, with the reason printed — not as a softer commitment, and not
//      hidden. An item the generation wrote as a commitment and the server
//      demoted says so on its face.
//   2. **Every item shows what it rests on.** The claim ids are not decoration:
//      they are the difference between this contract and relationship advice,
//      and a person should be able to read the claim underneath an undertaking
//      before deciding to make it. The claim's own sentence is printed, not just
//      its id, because "rests on c3" is provenance nobody can check.
//   3. **What is generated and what a person decided are different states.**
//      The confirmation status of both documents is on screen, so a script
//      somebody has edited is never mistaken for one the machine wrote.
//
// Nothing is computed here. Everything comes from `server/judgment`, so the
// screen cannot drift into a second opinion about what was stored.

import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "../../../../server/db";
import { StageMachineError, collectCaseFacts } from "../../../../server/pipeline";
import {
  readCurrentJudgment,
  readImprovementContract,
  readRepairScript,
  repairScriptProvenance,
  resolveClaimProvenance,
  type ClaimProvenance,
  type ImprovementContractRecord,
  type JudgmentRecord,
  type RepairScriptRecord,
  type StoredContractItem,
} from "../../../../server/judgment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PostJudgmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let judgment: JudgmentRecord | null;
  let contract: ImprovementContractRecord | null = null;
  let script: RepairScriptRecord | null = null;
  try {
    const db = getDb();
    collectCaseFacts(db, id);
    judgment = readCurrentJudgment(db, id);
    if (judgment !== null) {
      contract = readImprovementContract(db, judgment.id);
      script = readRepairScript(db, judgment.id);
    }
  } catch (cause) {
    if (cause instanceof StageMachineError && cause.code === "case_not_found") {
      notFound();
    }
    // The layout already rendered the database failure; do not repeat it here.
    return null;
  }

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <p className="text-xs tracking-wide text-neutral-500 uppercase">
          After the judgment
        </p>
        <h2 className="text-lg font-medium text-neutral-900">
          What this is supposed to change
        </h2>
        <p className="text-sm leading-relaxed text-neutral-600">
          A judgment that is read, agreed with and put down changes nothing.
          These two are derived from the frozen judgment: a small number of
          things to do this week, and the sentences for the conversation itself.
        </p>
      </div>

      {judgment === null ? (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          This case has no judgment yet, so there is nothing to derive from.
        </p>
      ) : (
        <>
          <p className="text-xs text-neutral-500">
            Derived from judgment version {judgment.version} ({judgment.outputLevel},{" "}
            {judgment.status}), written by{" "}
            <span className="font-mono">{judgment.model}</span>. Nothing on this
            page is written back to it.
          </p>

          <ContractBlock judgment={judgment} contract={contract} />
          <ScriptBlock judgment={judgment} script={script} />
        </>
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

/* -------------------------------------------------------------------------- */
/* The improvement contract                                                   */
/* -------------------------------------------------------------------------- */

function ContractBlock({
  judgment,
  contract,
}: {
  judgment: JudgmentRecord;
  contract: ImprovementContractRecord | null;
}) {
  if (contract === null) {
    return (
      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
        <h3 className="text-sm font-medium text-neutral-900">
          The improvement contract
        </h3>
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          Not generated yet. It is derived from the frozen fact layer by{" "}
          <span className="font-mono">npm run judgment:plan -- {judgment.id}</span>
          .
        </p>
      </div>
    );
  }

  const provenance = contract.content.generated_by ?? null;

  return (
    <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-neutral-900">
          The improvement contract
        </h3>
        <span className="text-xs text-neutral-500">
          {contract.status} · {contract.confirmStatus}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-neutral-500">
          {contract.commitments.length === 0
            ? "This contract binds no one"
            : `What ${contract.commitments.length === 1 ? "is" : "are"} committed to`}
        </p>
        {contract.commitments.map((item) => (
          <ContractItemCard
            key={item.item_id}
            item={item}
            judgment={judgment}
            tone="commitment"
          />
        ))}
      </div>

      {contract.invitations.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-neutral-500">
            Invitations — not commitments
          </p>
          <p className="text-xs leading-relaxed text-neutral-600">
            This case was heard at {contract.content.output_level}: the other
            party never gave her account and has agreed to nothing. Anything
            addressed to her is something she could be asked, not something she
            has undertaken to do, and it is stored that way.
          </p>
          {contract.invitations.map((item) => (
            <ContractItemCard
              key={item.item_id}
              item={item}
              judgment={judgment}
              tone="invitation"
            />
          ))}
        </div>
      )}

      {provenance !== null && (
        <p className="text-xs text-neutral-500">
          Drafted by <span className="font-mono">{provenance.model}</span>
          {provenance.effort === null ? "" : ` at effort ${provenance.effort}`}
          {provenance.prompt_version === null
            ? ""
            : ` (${provenance.prompt_version})`}
          .
          {provenance.fallback_used
            ? " Served by the fallback model: this text was written by a different model from the one that was asked for."
            : ""}
        </p>
      )}
    </div>
  );
}

function ContractItemCard({
  item,
  judgment,
  tone,
}: {
  item: StoredContractItem;
  judgment: JudgmentRecord;
  tone: "commitment" | "invitation";
}) {
  const claims = resolveClaimProvenance(judgment.factLayer, item.claim_ids);
  const frame =
    tone === "commitment"
      ? "border-neutral-200 bg-white"
      : "border-sky-200 bg-sky-50";

  return (
    <div className={`flex flex-col gap-1 rounded-lg border p-3 ${frame}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] tracking-wide text-neutral-600 uppercase">
          {tone === "commitment" ? "Commitment" : "Invitation"}
        </span>
        <span className="text-xs text-neutral-500">
          binds {item.bound_party === "client" ? "you" : "the other party"} ·
          within {item.within_days} day{item.within_days === 1 ? "" : "s"}
        </span>
      </div>

      <p className="text-sm text-neutral-900">
        <span className="text-neutral-500">When </span>
        {item.trigger}
      </p>
      <p className="text-sm text-neutral-900">
        <span className="text-neutral-500">Then </span>
        {item.action}
      </p>
      <p className="text-sm text-neutral-700">
        <span className="text-neutral-500">Anyone would see </span>
        {item.observable}
      </p>

      {item.demoted_from_commitment && (
        <p className="text-xs text-sky-900">
          This was written as a commitment binding her. It is recorded as an
          invitation: she has not been heard, and this hearing cannot put words
          in her mouth.
        </p>
      )}

      <ProvenanceList claims={claims} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The repair script                                                          */
/* -------------------------------------------------------------------------- */

function ScriptBlock({
  judgment,
  script,
}: {
  judgment: JudgmentRecord;
  script: RepairScriptRecord | null;
}) {
  if (script === null) {
    return (
      <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
        <h3 className="text-sm font-medium text-neutral-900">
          The repair conversation
        </h3>
        <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
          Not generated yet. It comes from the same frozen fact layer —{" "}
          <span className="font-mono">
            npm run judgment:plan -- {judgment.id} --script
          </span>
          .
        </p>
      </div>
    );
  }

  const block = script.content.when_it_goes_wrong;
  const claims = repairScriptProvenance(judgment.factLayer, script.content);

  return (
    <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-neutral-900">
          The repair conversation
        </h3>
        <span className="text-xs text-neutral-500">{script.confirmStatus}</span>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-500">
          What you could open with
        </p>
        <blockquote className="rounded-lg border-l-2 border-neutral-300 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-900">
          {script.content.opening_line}
        </blockquote>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-neutral-500">
          When it goes wrong
        </p>
        <dl className="flex flex-col gap-2">
          <div>
            <dt className="text-xs text-neutral-500">Pause signal</dt>
            <dd className="text-sm text-neutral-900">{block.pause_signal}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">
              How you will know you are flooded
            </dt>
            <dd className="text-sm text-neutral-900">
              {block.flooding_self_check}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">When you come back</dt>
            <dd className="text-sm text-neutral-900">{block.return_time}</dd>
          </div>
        </dl>
      </div>

      <ProvenanceList claims={claims} />

      {script.provenance !== null && (
        <p className="text-xs text-neutral-500">
          Drafted by <span className="font-mono">{script.provenance.model}</span>
          {script.provenance.effort === null
            ? ""
            : ` at effort ${script.provenance.effort}`}
          .
          {script.provenance.fallback_used
            ? " Served by the fallback model."
            : ""}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The claims a derived item rests on, spelled out.
 *
 * A missing statement is shown rather than hidden: every write path refuses
 * content citing a claim the fact layer does not define, so if one ever appears
 * here it means a stored row is out of step with its judgment, and that is worth
 * seeing.
 */
function ProvenanceList({ claims }: { claims: readonly ClaimProvenance[] }) {
  if (claims.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-t border-neutral-100 pt-2">
      {claims.map((claim) => (
        <li key={claim.claimId} className="text-xs leading-relaxed text-neutral-600">
          <span className="font-mono text-neutral-500">{claim.claimId}</span>
          {claim.tier === null ? (
            <span className="text-rose-800">
              {" "}
              — not in this judgment&apos;s fact layer
            </span>
          ) : (
            <>
              <span className="text-neutral-400"> [{claim.tier}]</span>{" "}
              {claim.statement}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
