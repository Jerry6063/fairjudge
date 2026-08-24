// POST /api/translate — the plain-speech translator endpoint.
//
// Thin by design: validate the body, pick the stage, hand the text to the LLM
// gateway, and translate the returned `StageResult` into HTTP. The gateway owns
// pseudonymization, the refusal check and the audit rows; this file owns only
// the wire format and the error copy.

import { z } from "zod";

import {
  TRANSLATE_MAX_CHARS,
  type TranslateErrorCode,
  type TranslateRequest,
  type TranslateResponseBody,
} from "../../../lib/translate-contract";
import { runStage } from "../../../server/llm";

// better-sqlite3 (via the gateway's audit ledger) needs the Node.js runtime.
export const runtime = "nodejs";

/** Request validation. `satisfies` keeps it in step with the shared contract. */
const requestSchema = z.object({
  text: z.string().max(TRANSLATE_MAX_CHARS),
  deep: z.boolean().optional(),
}) satisfies z.ZodType<TranslateRequest>;

/** HTTP status per failure code — the single mapping table. */
const STATUS_BY_CODE: Record<TranslateErrorCode, number> = {
  invalid_request: 400,
  refused: 422,
  unavailable: 503,
  internal: 500,
};

function json(body: TranslateResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(
  code: TranslateErrorCode,
  error: string,
  detail?: string,
): Response {
  return json(
    detail === undefined
      ? { ok: false, code, error }
      : { ok: false, code, error, detail },
    STATUS_BY_CODE[code],
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_request", "Malformed request: a JSON body is required.");
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", describeInvalidRequest(body));
  }

  const text = parsed.data.text.trim();
  if (text.length === 0) {
    return fail("invalid_request", "Enter the line you want translated first.");
  }

  const stage = parsed.data.deep ? "translate_deep" : "translate_default";
  const result = await runStage(stage, { prompt: text });

  switch (result.kind) {
    case "ok":
      return json({ ok: true, data: result.data, meta: result.meta }, 200);

    case "refused":
      return fail(
        "refused",
        "The model declined to read this line. Rephrase it, or take out the sensitive content, and try again.",
        result.category,
      );

    case "error":
      return result.retryable
        ? fail(
            "unavailable",
            "The model service is temporarily unavailable. Try again shortly.",
            result.message,
          )
        : fail(
            "internal",
            "This translation did not complete. Check the server logs.",
            result.message,
          );
  }
}

/**
 * Turn a schema failure into one concrete sentence. The three cases the form
 * can actually produce are worth distinguishing; anything else falls back to a
 * generic message rather than leaking zod's raw issue text into the UI.
 */
function describeInvalidRequest(body: unknown): string {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    return "The request is missing the text field (the line to translate).";
  }
  if (text.length > TRANSLATE_MAX_CHARS) {
    return `That text is too long (${text.length} characters); trim it to ${TRANSLATE_MAX_CHARS} or fewer.`;
  }
  return "Invalid request parameter: deep must be a boolean.";
}
