// /case/[id]/referral — the crisis-referral page. HARD RULE #9.
//
// "When a safety red flag fires, hotline/resource information renders with zero
// latency and no LLM in the loop." This file is where that has to be true, and
// the way it is made true is the import list below: `buildReferralView` (two
// SELECTs against the local encrypted SQLite file) and `ReferralPanel` (a pure
// component over constants). Nothing else. In particular, NOT
// `server/safety/index.ts` — the barrel re-exports `gate.ts`, which imports
// `runStage`, which would put the Anthropic client in this module's graph.
//
// That is not a style preference, and it is not left to a reviewer to notice.
// `tests/safety-referral.test.ts` enforces it twice: it walks this file's
// imports on disk and fails if the reachable set contains `server/llm`, and it
// mocks `server/llm` and `@anthropic-ai/sdk` to throw on any property read
// before rendering, so a live call fails too. A dormant import and a real call
// are both caught.
//
// A static segment named `referral` also takes precedence over the sibling
// `[stage]` dynamic segment, so this route can never be served by the generic
// stage workspace.

import { buildReferralView } from "../../../../server/safety/screen-record";
import { getDb } from "../../../../server/db";
import { ReferralPanel } from "./referral-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReferralPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = buildReferralView(getDb(), id);
  return <ReferralPanel view={view} />;
}
