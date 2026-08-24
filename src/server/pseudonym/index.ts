// Public surface of the pseudonymization gateway.

export type {
  NameWarning,
  NameWarningKind,
  PersonDict,
  PersonEntry,
  PiiMatch,
  PiiType,
  PseudonymHit,
  PseudonymizeResult,
  ScrubPiiResult,
} from "./types";

export {
  depseudonymize,
  detectUnregisteredNames,
  pseudonymize,
} from "./gateway";

/* The name rules the dictionary is built with and checked against (HARD RULE
   #3). Pure, no IO — `buildCaseDict` folds fragments into the variant table on
   the way in, and the gateway blocks on the names that are left. */
export {
  deriveNameFragments,
  detectPersonNames,
  expandPersonDict,
  expandPersonEntry,
} from "./names";

export { restorePii, scrubPii } from "./pii";
