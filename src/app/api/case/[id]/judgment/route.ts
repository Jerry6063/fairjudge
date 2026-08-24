// The judgment endpoint — SPEC M3 wave B ⑧.
//
// POST runs the hearing to completion and answers with what was published. It
// does not stream: the body is buffered, persisted as a draft, validated and
// published in one piece by `generateJudgment`, and this route is the thin
// mapping from that outcome onto HTTP. The response carries the judgment's id,
// version and status — the text is fetched from the judgment page, which reads
// the frozen row.
//
// GET is the polling half of the progress display: state plus the events so
// far, from the in-process hub. It is the fallback for a client that cannot
// hold an SSE connection open; `./stream` is the same information pushed.
//
// Neither verb can return an unvalidated sentence of the judgment. POST returns
// nothing until `finalize` has run, and GET returns progress events, whose type
// has no field a body could be written into (`judgment/progress.ts`).

import { getDb } from "../../../../../server/db";
import {
  generateJudgment,
  judgmentProgress,
  readCurrentJudgment,
  type JudgmentRunOutcome,
} from "../../../../../server/judgment";

// better-sqlite3 needs the Node.js runtime.
export const runtime = "nodejs";

type Params = { readonly params: Promise<{ readonly id: string }> };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** HTTP status per outcome. One table, so the mapping is auditable. */
function statusFor(outcome: JudgmentRunOutcome): number {
  switch (outcome.kind) {
    case "published":
      return 200;
    case "blocked":
      return 409;
    case "no_material":
      return 409;
    case "rejected":
      return 422;
    case "refused":
      return 422;
    case "error":
      return outcome.retryable ? 503 : 500;
  }
}

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { id: caseId } = await params;
  const db = getDb();

  const outcome = await generateJudgment(db, caseId);

  if (outcome.kind === "published") {
    return json(
      {
        ok: true,
        judgment: {
          id: outcome.judgment.id,
          version: outcome.judgment.version,
          status: outcome.judgment.status,
          outputLevel: outcome.judgment.outputLevel,
          model: outcome.judgment.model,
          fallbackUsed: outcome.judgment.fallbackUsed,
        },
        attempts: outcome.attempts,
      },
      200,
    );
  }

  // The rejection report quotes the model's own statements back, so it is
  // returned to the operator who asked for the hearing and never pushed onto
  // the progress channel. See the header of `judgment/progress.ts`.
  const detail =
    outcome.kind === "rejected"
      ? { step: outcome.step, code: outcome.rejection.code, detail: outcome.rejection.message }
      : outcome.kind === "refused"
        ? { category: outcome.category ?? null }
        : { detail: "message" in outcome ? outcome.message : null };

  return json({ ok: false, code: outcome.kind, ...detail }, statusFor(outcome));
}

/** Progress so far, plus the judgment that stands, if one does. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { id: caseId } = await params;
  const db = getDb();

  const snapshot = judgmentProgress.snapshot(caseId);
  const current = readCurrentJudgment(db, caseId);

  return json(
    {
      ok: true,
      state: snapshot.state,
      events: snapshot.events,
      judgment:
        current === null
          ? null
          : {
              id: current.id,
              version: current.version,
              status: current.status,
              outputLevel: current.outputLevel,
            },
    },
    200,
  );
}
