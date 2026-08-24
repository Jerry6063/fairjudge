// Public surface of case creation and the case list. A case comes into
// existence here and nowhere else: the front door writes the case row, both
// dictionary registrations and the first account in one transaction, so no
// caller can produce a case that is missing one of them.

export {
  CaseCreationError,
  INITIATOR_PSEUDONYM,
  MAX_ACCOUNT_CHARS,
  MAX_NAME_CHARS,
  MAX_TITLE_CHARS,
  RESPONDENT_PSEUDONYM,
  createCase,
  readCaseParties,
  readClientIntent,
  validateCaseInput,
} from "./create";

export type {
  CaseCreationErrorCode,
  CaseCreationField,
  CreateCaseInput,
  CreatedCase,
} from "./create";

export { listCases } from "./list";
export type { CaseListItem } from "./list";
