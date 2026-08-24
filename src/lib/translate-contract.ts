// Wire contract for `POST /api/translate`, shared by the route handler and the
// `/translate` page.
//
// Types and one constant, deliberately: the page imports this module, so any
// runtime dependency added here ships to the browser. The zod schema that
// validates the request lives in the route. The imports below are type-only and
// erased at compile time, so nothing from `src/server/` reaches the client
// bundle while the response shape still tracks the gateway's real output.

import type { StageMeta, TranslationOutput } from "../server/llm";

/** Upper bound on one translation request, in characters. */
export const TRANSLATE_MAX_CHARS = 2000;

/**
 * Request body. `deep` selects the `translate_deep` stage (claude-fable-5)
 * instead of the default one; the stage itself is never named by the client.
 */
export interface TranslateRequest {
  text: string;
  deep?: boolean;
}

/**
 * Failure taxonomy. Each code maps to exactly one HTTP status in the route:
 * `invalid_request` → 400, `refused` → 422, `unavailable` → 503,
 * `internal` → 500.
 */
export type TranslateErrorCode =
  | "invalid_request"
  | "refused"
  | "unavailable"
  | "internal";

export interface TranslateSuccessBody {
  ok: true;
  data: TranslationOutput;
  meta: StageMeta;
}

export interface TranslateErrorBody {
  ok: false;
  code: TranslateErrorCode;
  /** User-facing message; safe to render as-is. */
  error: string;
  /** Diagnostic detail from the gateway internals. Never PII. */
  detail?: string;
}

export type TranslateResponseBody = TranslateSuccessBody | TranslateErrorBody;
