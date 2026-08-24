/**
 * The wire shape of a server action's outcome.
 *
 * Server actions cannot throw a domain error across the RSC boundary and keep
 * its type, so expected failures (a rejected transition, a bad id) come back as
 * data with copy the caller can render as-is. Unexpected failures are
 * left to throw and land on the error boundary — they are bugs, not answers.
 */

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly message: string };
