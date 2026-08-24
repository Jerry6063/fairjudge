// Public surface of the access layer (SPEC M5 ①③): who a party is, what they
// may read, and what they have consented to. Everything downstream of a SELECT
// trusts this module, so nothing in it may be bypassed by a caller in a hurry —
// the read paths take an audience and default it, rather than offering an
// unfiltered variant beside a filtered one.

// The visibility model. `visibleMaterial` is the predicate the existing read
// paths put in their WHERE clause; there is no parallel query layer.
export {
  CASE_RECORD,
  SHARED_VISIBILITY,
  asParticipant,
  describeAudience,
  isParticipantAudience,
  isVisible,
  resolveMaterialGrant,
  scopedToCase,
  visibleMaterial,
} from "./visibility";

export type {
  MaterialAudience,
  MaterialGrant,
  OwnedRow,
  OwnedTable,
} from "./visibility";

// Consent as append-only events, three-valued on the way out: granted, revoked,
// and "nobody has been asked", which is not the same as no. Current state is
// `foldConsent` over the log; the log itself survives every revocation.
export {
  ConsentError,
  NamedRenditionRevokedError,
  actorsWithActiveConsent,
  assertNamedRenditionAllowed,
  consentFoldFor,
  consentStandingFor,
  foldConsent,
  grantNamedRendition,
  hasActiveConsent,
  isConsentRevoked,
  listConsentEvents,
  listConsentEventsByActor,
  namedRenditionConsent,
  readCaseConsentState,
  recordConsent,
  revokeNamedRendition,
} from "./consent";

export type {
  CaseConsentState,
  ConsentErrorCode,
  ConsentFold,
  ConsentRecord,
  ConsentStanding,
  ExportedCopy,
  NamedRenditionActInput,
  NamedRenditionChange,
  NamedRenditionConsent,
  NamedRenditionContext,
  PartyConsentStanding,
  PartyConsentSummary,
  RecordConsentInput,
} from "./consent";

// Invite tokens: minted here, delivered by nobody. Single-use, hashed at rest,
// expiring; verify is a read, redeem is the act.
export {
  INVITE_TOKEN_TTL_MS,
  InviteError,
  MINTING_CLOSED_BY_ACCOUNT,
  MINTING_CLOSED_BY_DECLINE,
  hasIdentity,
  hashIdentityToken,
  hashInviteToken,
  issueInviteToken,
  readIdentity,
  redeemInviteToken,
  resolveIdentityToken,
  verifyInviteToken,
} from "./invite";

export type {
  IdentityRecord,
  InviteCheck,
  InviteErrorCode,
  InviteRefusalReason,
  InvitedParticipant,
  IssueInviteOptions,
  IssuedInvite,
  RedeemInviteOptions,
  RedeemOutcome,
  ResolveIdentityOptions,
  TokenCheckOptions,
} from "./invite";

// Sharing material into the case and taking it back out — the visibility state
// and the consent event written together, so the two cannot drift.
export {
  shareMaterialIntoCase,
  withdrawMaterialFromCase,
} from "./material";

export type { MaterialShareInput, MaterialShareResult } from "./material";

// The transparency view: everything held about one party, with provenance. The
// coverage list is exported because a test asserts it against the live schema —
// a table added later must fail loudly rather than go quietly missing.
export {
  TRANSPARENCY_FORMAT,
  TRANSPARENCY_SECTION_IDS,
  TRANSPARENCY_TABLE_COVERAGE,
  TransparencyError,
  buildTransparencyView,
} from "./transparency";

export type {
  ProvenanceSource,
  TableCoverage,
  TransparencyControl,
  TransparencyItem,
  TransparencyProvenance,
  TransparencyRight,
  TransparencySection,
  TransparencySectionId,
  TransparencyView,
} from "./transparency";

// Deletion, asymmetric on purpose: hers is removed, his is asked about. Both
// write an audit row; neither pretends to be the other.
export {
  DeletionError,
  deleteOwnMaterial,
  deletionRightsFor,
  listDeletionAudit,
  listDeletionRequests,
  requestMaterialDeletion,
  resolveDeletionRequest,
} from "./deletion";

export type {
  DeleteOwnMaterialInput,
  DeletionAuditRecord,
  DeletionErrorCode,
  DeletionOutcome,
  DeletionRequestRecord,
  DeletionRights,
  ListDeletionRequestOptions,
  RequestDeletionInput,
  ResolveDeletionRequestInput,
  ResolveDeletionRequestOutcome,
} from "./deletion";
