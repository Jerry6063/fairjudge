/**
 * The read seam of `/respond/[token]`.
 *
 * Everything here is a pure read: token in, page data out, no writes. The acts
 * — opening, joining, declining, deleting, asking — are server actions and live
 * with the screen that offers them, so that a page refresh can never perform
 * one.
 */

export {
  loadTransparencyFor,
  loadTransparencyPage,
  resolveRespondToken,
} from "./transparency";

export type {
  RespondSubject,
  RespondTokenKind,
  RespondTokenRefusal,
  RespondTokenResolution,
  TransparencyPageData,
  TransparencyPageResult,
} from "./transparency";
