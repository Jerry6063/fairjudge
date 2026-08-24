/**
 * What an Anthropic SDK error says about a request that produced no message.
 *
 * Shared by the two paths that put case material on the wire through that SDK —
 * the Messages gateway (`llm/claude.ts`) and the Message Batches submit in
 * `followups/runner.ts` — because both ask it the same two questions, and
 * HARD RULE #7 should not depend on two answers:
 *
 *   1. **Did any byte reach a socket?** If not, nothing is recorded. If it did,
 *      or if it cannot be told either way, the audit pair is written.
 *   2. **Why did nothing come back?** An abort is a different fact from a
 *      connection the network dropped, and a reader of the ledger should not
 *      have to guess which one a silent row was.
 *
 * The removed OpenAI polish path answered question 1 from its own transport's
 * config error instead — a different vendor, a different SDK, the same
 * asymmetry. Both paths are now this one.
 */

/** Why a request that left the process never produced a response. */
export type UndeliveredReason = "aborted" | "transport_error";

/**
 * Failures the SDK raises *before* it puts anything on the wire.
 *
 * Everything else is recorded, including failures that may never have opened a
 * socket at all (a DNS failure, a refused connection). That asymmetry is
 * deliberate: the ledger answers "what has left this machine", and the answer
 * it must never give is "less than it did". Over-reporting a connection whose
 * death cannot be confirmed is a smaller lie than losing a full-case payload
 * from the record.
 *
 * The two below are matched on the SDK's own wording rather than its error
 * classes, because `instanceof` is not available to the callers in tests — the
 * SDK is mocked module-wide there, so `Anthropic.APIError` and friends do not
 * exist — and the gateway already reads SDK values through structural views for
 * the same reason. If the wording ever changes, the behaviour degrades to
 * recording the attempt, which is the safe direction to fail in.
 */
const NEVER_DISPATCHED = [
  // BaseAnthropic: credential resolution runs once at construction and, when it
  // fails, is re-thrown on every request before that request is built.
  /could not resolve authentication method/i,
  // Messages.create: a `max_tokens` whose worst case runs past the SDK's
  // non-streaming ceiling. `MAX_NONSTREAMING_TOKENS` switches the gateway to the
  // streaming transport before this can fire, so reaching it means the two
  // ceilings have drifted apart — a bug to surface, not an egress to record.
  // (The Batches endpoint never raises it: nothing there streams.)
  /streaming is required/i,
] as const;

export function neverDispatched(error: unknown): boolean {
  // An HTTP status means the provider answered, whatever it answered with.
  if (typeof (error as { status?: unknown } | null)?.status === "number") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return NEVER_DISPATCHED.some((pattern) => pattern.test(message));
}

/**
 * Which kind of no-response this was, for `stop_reason`.
 *
 * An abort — ours, the caller's, or the SDK's own deadline expiring on a
 * request it had already sent — is a different fact from a connection the
 * network dropped.
 *
 * A provider that answered with an HTTP error produced no message either, and
 * lands in `transport_error`; the status itself is not lost, it is in the error
 * the caller returns and in `request_id` when the vendor sent one.
 *
 * `aborted` is the caller's own evidence, when it has any — a stream helper
 * that knows it was cancelled, say — and outranks reading the error's name.
 */
export function undeliveredReason(
  error: unknown,
  aborted = false,
): UndeliveredReason {
  if (aborted) return "aborted";
  const thrown = error as {
    name?: unknown;
    constructor?: { name?: unknown };
  } | null;
  const names: unknown[] = [thrown?.name, thrown?.constructor?.name];
  if (names.includes("AbortError")) return "aborted";
  if (
    names.includes("APIUserAbortError") ||
    names.includes("APIConnectionTimeoutError")
  ) {
    return "aborted";
  }
  return "transport_error";
}

/** The `request-id` header the SDK attaches to an API error, when it has one. */
export function requestIdOf(error: unknown): string | null {
  const id = (error as { requestID?: unknown } | null)?.requestID;
  return typeof id === "string" ? id : null;
}
