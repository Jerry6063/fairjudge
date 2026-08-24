/**
 * Drizzle SQLite schema for fairjudge (M0 data foundation).
 *
 * Covers all 20 tables listed in SPEC.md §2. Field choices follow
 * 02-engineering-architecture.md §1.4 (and the referenced hard rules): the
 * nine-stage case state machine, code-derived `output_level`, the A-D evidence
 * grade with a `derived_from_evidence_id` provenance chain, per-utterance
 * confirmation gating, event ordering via fractional-index `order_key`, the
 * judgment `content` fact-layer stored as JSON text, LLM usage accounting, and
 * the egress ledger with `payload_sha256` + expiry.
 *
 * Conventions (see CLAUDE.md):
 * - `jsonb` columns use `text({ mode: 'json' })`.
 * - The AI-product triple `ai_draft` / `human_final` / `confirm_status` recurs
 *   on every human-in-the-loop confirmation unit.
 * - Ordering uses fractional-indexing `order_key` (text), never integer reindex.
 * - Timestamps are integer epoch-milliseconds.
 */

import { randomUUID } from "node:crypto";
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/* -------------------------------------------------------------------------- */
/* Enumerations (single source of truth for column vocabularies)              */
/* -------------------------------------------------------------------------- */

/**
 * The nine-stage case pipeline (01-pipeline-design.md §"Pipeline overview"),
 * plus two terminal phases. `stage` is a code-driven state machine on `cases`.
 *   ① intake            intake positioning + safety screening (a gate)
 *   ② evidence_intake   material registration + evidence grading
 *   ③ transcription     transcription and speaker confirmation
 *   ④ timeline          timeline reconstruction
 *   ⑤ clarification     clarification loop + steelmanning the other party
 *   ⑥ participation     counterparty invitation, participation state settled
 *   ⑦ issue_framing     issue fixing (the three lists)
 *   ⑧ pre_judgment      pre-judgment confrontation: adverse-fact
 *                       pre-acknowledgment + evidence-map sign-off
 *   ⑨ judgment          judgment output (graded)
 *      post_judgment    dual-version / contract / repair script / follow-up /
 *                       appeal
 *      closed           case closed
 */
export const CASE_STAGES = [
  "intake",
  "evidence_intake",
  "transcription",
  "timeline",
  "clarification",
  "participation",
  "issue_framing",
  "pre_judgment",
  "judgment",
  "post_judgment",
  "closed",
] as const;
export type CaseStage = (typeof CASE_STAGES)[number];

/**
 * Output level derived by code (never by prompt) and locked onto the case.
 * L1 full judgment / L2 single-side analysis / L3 narrative-only / refused.
 */
export const OUTPUT_LEVELS = ["L1", "L2", "L3", "refused"] as const;
export type OutputLevel = (typeof OUTPUT_LEVELS)[number];

export const CASE_STATUSES = ["open", "closed", "archived"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/**
 * What the client said they came for, asked at creation (04-ux-design-plan.md
 * §4.1).
 *
 * It is stored because the answer is the one thing the product must respond to
 * with a cost rather than with agreement: `allocate_fault` names the output the
 * system will not produce from one account, and every later surface that has to
 * say "this is not what you asked for, and here is what would change that"
 * needs the question's answer on file rather than in someone's memory of the
 * form. It is a record of a request, never an input to the judgment — nothing
 * downstream may read it as an instruction, and `deriveOutputLevel` does not
 * see it (HARD RULE #2).
 *
 * NULL means the case predates the question or was created by a script, which
 * is deliberately distinct from any of the three answers.
 */
export const CLIENT_INTENTS = [
  /** "I want to work out what actually happened." */
  "understand_what_happened",
  /** "I want to know whose fault it was." Needs both parties; see doc 05 §A.4. */
  "allocate_fault",
  /** "I want to know how to stop it happening again." */
  "prevent_recurrence",
] as const;
export type ClientIntent = (typeof CLIENT_INTENTS)[number];

export const PARTICIPANT_ROLES = ["initiator", "respondent"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/**
 * Counterparty participation, which must be settled before judgment
 * (01-pipeline-design.md ⑥: participating / written response / explicitly
 * refused / unreachable / unaware).
 */
export const PARTICIPATION_STATES = [
  "pending",
  "participating",
  "written_response",
  "refused",
  "unreachable",
  "unaware",
] as const;
export type ParticipationState = (typeof PARTICIPATION_STATES)[number];

/**
 * Row-level visibility for anything a party submitted (SPEC M5 ①).
 *
 * Two states, and the default is the restrictive one:
 *   private — the owner's own material. Nobody else reads it through a query.
 *   case    — the owner put it into the case record, so every party to the case
 *             may read it. Getting here is an act, recorded as a consent event.
 *
 * There is deliberately no `public`. Nothing in this product is published, and a
 * state nothing can reach is a state somebody will eventually reach by accident.
 */
export const VISIBILITY_STATES = ["private", "case"] as const;
export type VisibilityState = (typeof VISIBILITY_STATES)[number];

/**
 * Where the counterparty is in her own entry flow (SPEC M5 ②).
 *
 * Kept apart from `participation_state`, which is the *client's* report of what
 * happened when the other party was asked. This column is what **she** did, from
 * inside the product, and only her own actions write it. Collapsing the two
 * would make "he says she refused" indistinguishable from "she declined", and
 * the whole point of M5 is that those are different facts with different
 * standing.
 *
 *   not_started — nothing has been offered yet
 *   invited     — an invite token was minted for her
 *   opened      — she opened the invitation with a valid token
 *   joined      — she redeemed the token and now has an identity
 *   declined    — she said no, in the product, in her own words
 */
export const RESPOND_STATES = [
  "not_started",
  "invited",
  "opened",
  "joined",
  "declined",
] as const;
export type RespondState = (typeof RESPOND_STATES)[number];

/** Consent is an event, never a bit: it is granted or revoked, by someone, at a time. */
export const CONSENT_KINDS = ["granted", "revoked"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * What a consent event is about (SPEC M5 ③).
 *
 * Three scopes, because there are three genuinely different questions and
 * answering one has never implied the others:
 *
 *   case_record      — my material may form part of the record this case is
 *                      judged on. Read by the query layer: without it, a
 *                      non-submitter's material is not in the dossier at all.
 *   counterparty_read — the other party may read my material.
 *   named_rendition  — a document naming me may be exported or shared.
 *                      Revoking this blocks export and share tokens; it is the
 *                      one thing the counterparty controls outright.
 */
export const CONSENT_SCOPES = [
  "case_record",
  "counterparty_read",
  "named_rendition",
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** What a deletion request points at. One row of one of these tables. */
export const DELETION_TARGET_KINDS = [
  "evidence",
  "utterance",
  "file",
  "event",
] as const;
export type DeletionTargetKind = (typeof DELETION_TARGET_KINDS)[number];

/**
 * What became of a deletion request (SPEC M5 ④).
 *
 * A request exists only for material somebody *else* submitted: what she
 * submitted herself she deletes outright, with no request and no status. So
 * `refused` is a real and legitimate outcome — the system does not promise
 * unilateral erasure of another person's records, and a status list that could
 * only ever end in `granted` would be pretending it does.
 */
export const DELETION_REQUEST_STATUSES = [
  "open",
  "granted",
  "refused",
  "withdrawn",
] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];

/**
 * What one row of the deletion audit records (SPEC M5 ④).
 *
 * Four acts, because deletion in a two-person case is four different events and
 * flattening them would lose the only thing the audit is for — telling apart
 * what somebody DID from what somebody ASKED FOR:
 *
 *   deleted   — the owner removed their own material. It is gone.
 *   requested — somebody asked for material they do not own to be removed.
 *               Nothing was deleted by this act, and the row says so.
 *   granted   — the owner answered a request by deleting the material.
 *   refused   — the owner answered a request by declining. Also audited, because
 *               "I asked and was told no" is a fact about this case.
 */
export const DELETION_ACTS = [
  "deleted",
  "requested",
  "granted",
  "refused",
] as const;
export type DeletionAct = (typeof DELETION_ACTS)[number];

/** Shared confirmation state for the ai_draft / human_final / confirm_status triple. */
export const CONFIRM_STATUSES = [
  "pending",
  "confirmed",
  "edited",
  "rejected",
] as const;
export type ConfirmStatus = (typeof CONFIRM_STATUSES)[number];

export const FILE_KINDS = ["screenshot", "audio", "text", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Evidence source type; drives the deterministic grade
 * (A first-hand / B retold / C AI-processed / D mass-market emotional).
 */
export const EVIDENCE_SOURCE_TYPES = [
  "firsthand", // A: first-hand original record
  "recollection", // B: retold / from memory
  "ai_processed", // C: AI-processed artifact (session screenshots etc.)
  "public_sentiment", // D: mass-market emotional content (Xiaohongshu etc.)
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const EVIDENCE_GRADES = ["A", "B", "C", "D"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const UTTERANCE_TONES = [
  "serious",
  "tired",
  "joking",
  "sarcastic",
] as const;
export type UtteranceTone = (typeof UTTERANCE_TONES)[number];

/** Temporal precision of an event; unknown when only ordering is available. */
export const OCCURRED_PRECISIONS = [
  "exact",
  "day",
  "month",
  "range",
  "unknown",
] as const;
export type OccurredPrecision = (typeof OCCURRED_PRECISIONS)[number];

/** The three issue lists at issue fixing (issue_framing). */
export const ISSUE_CATEGORIES = [
  "undisputed", // undisputed facts
  "fact_dispute", // disputes of fact
  "standard_dispute", // disputes of standard
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/** Acknowledgement state for adverse-fact pre-confirmation (pre-judgment confrontation). */
export const ACK_STATUSES = ["pending", "acknowledged", "disputed"] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

/**
 * What the user did with the counterparty's steelmanned story (M3 wave A ④).
 *
 * `unable` is a real answer, not a missing one: when no steelman can be
 * produced, or the user cannot recognize the counterparty in any version of it,
 * that is recorded as a downgrade signal on the case rather than silently
 * treated as agreement.
 */
export const STEELMAN_VERDICTS = [
  "pending",
  "accepted",
  "rebutted",
  "unable",
] as const;
export type SteelmanVerdict = (typeof STEELMAN_VERDICTS)[number];

/* -------------------------------------------------------------------------- */
/* JSON payload shapes (typed views over `text({ mode: 'json' })` columns)     */
/* -------------------------------------------------------------------------- */

/** One answered question from the intake safety questionnaire. */
export interface SafetyAnswer {
  /** Stable question id, so an answer survives a reworded prompt. */
  id: string;
  /** The question as it was actually asked, in the wording the user saw. */
  question: string;
  /** The user's answer, verbatim — evidence, so never normalized. */
  answer: string;
}

/** One question inside a clarification round. */
export interface ClarificationQuestion {
  /** Stable id, referenced by the matching answer. */
  id: string;
  /** The question text as asked. */
  question: string;
}

/**
 * What became of one clarification question once the client dealt with it.
 *
 * `declined` is a real answer, not a missing one. A person asked what they said
 * during the worst week of their relationship is allowed to say "I am not
 * answering that", and the product has to be able to record it: the round still
 * happened, still closes, and still spends budget, but the judgment must be able
 * to see that this particular question taught it nothing. An absent entry cannot
 * carry that — it is indistinguishable from a round still in flight.
 */
export const CLARIFICATION_ANSWER_STATES = ["answered", "declined"] as const;
export type ClarificationAnswerState =
  (typeof CLARIFICATION_ANSWER_STATES)[number];

/** The user's reply to one clarification question. */
export interface ClarificationAnswer {
  /** `ClarificationQuestion.id` this answers. */
  questionId: string;
  /** The reply, verbatim — evidence, so never normalized. Empty when declined. */
  answer: string;
  /** Epoch-ms; null while the question is still open, and null when declined. */
  answeredAt: number | null;
  /**
   * Absent on rows written before this state existed, and read as `answered`
   * there — a stored reply with no state field is a reply.
   */
  state?: ClarificationAnswerState;
  /** Epoch-ms the decline was recorded. Only set when `state` is `declined`. */
  declinedAt?: number | null;
  /**
   * One line about why nothing was answered — the client's own words when they
   * gave a reason, otherwise the system's record of why the state was written.
   * Never a stand-in for an answer: no downstream reader may quote it as one.
   */
  declineNote?: string;
}

export const JUDGMENT_STATUSES = ["draft", "final", "superseded"] as const;
export type JudgmentStatus = (typeof JUDGMENT_STATUSES)[number];

export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

/** Rendition audience: self_reflection is never shareable; shareable expires. */
export const RENDITION_KINDS = ["self_reflection", "shareable"] as const;
export type RenditionKind = (typeof RENDITION_KINDS)[number];

export const CONTRACT_STATUSES = ["draft", "active", "fulfilled", "broken"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const FOLLOWUP_KINDS = ["day7", "day30"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_STATUSES = ["scheduled", "completed", "skipped"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/**
 * Where a follow-up's *questions* are in the Message Batches round trip
 * (M4 ④), kept separate from `FOLLOWUP_STATUSES` on purpose.
 *
 * `status` is the lifecycle of the check-in as the user experiences it
 * (scheduled → completed / skipped); this is the lifecycle of the generation
 * that has to happen before there is anything to answer. Collapsing the two
 * would make "the batch never came back" indistinguishable from "the user has
 * not answered yet", and telling those apart is the entire point: a follow-up
 * that silently never fires is the failure mode this feature exists to prevent.
 */
export const FOLLOWUP_GENERATION_STATUSES = [
  /** Scheduled, not yet due (or due and waiting for the next scheduler run). */
  "pending",
  /** A batch carrying this row's request is in flight. */
  "submitted",
  /** Questions were generated, checked and stored. */
  "ready",
  /** Generation failed its retries; `last_error` says why. Visible in the UI. */
  "failed",
] as const;
export type FollowupGenerationStatus =
  (typeof FOLLOWUP_GENERATION_STATUSES)[number];

export const APPEAL_STATUSES = [
  "submitted",
  "under_review",
  "resolved",
  "rejected",
] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/**
 * How a copy of a judgment may leave this machine (SPEC M4 ⑥).
 *
 * The list is short because it is a policy, not a capability survey: a document
 * this product produced from one person's account of their relationship is
 * handed over deliberately, by the person who holds it, to someone they chose.
 * There is no social channel here and adding one is not a feature — a one-click
 * share turns "I am showing you what I wrote about us" into publication, and the
 * other party never agreed to either.
 */
export const EXPORT_CHANNELS = ["file", "clipboard", "print"] as const;
export type ExportChannel = (typeof EXPORT_CHANNELS)[number];

export const SAFETY_SCREEN_TYPES = ["keyword", "llm", "pre_judgment"] as const;
export type SafetyScreenType = (typeof SAFETY_SCREEN_TYPES)[number];

export const SAFETY_OUTCOMES = ["clear", "flagged", "refuse"] as const;
export type SafetyOutcome = (typeof SAFETY_OUTCOMES)[number];

/**
 * Egress targets this product has ever had.
 *
 * `"openai"` is no longer reachable — the polish layer that used it was removed
 * on 2026-08-16 (doc 02 §1.1a) and nothing writes a row with this value any
 * more. It stays in the union because the `llm_calls` and `egress_ledger` rows
 * from the real polish runs carry it, and narrowing the type would make the
 * audit trail unreadable in the name of tidiness.
 *
 * `"external_session"` is the second runtime (doc 05 §B): the prepared bundle is
 * handed to the model already driving the surrounding session instead of being
 * put on a socket. It is a *target*, not a vendor — nobody was billed, no model
 * id is knowable from inside this process, and rows carrying it have null tokens
 * and null cost for exactly that reason. It is still an egress: the case left
 * this process the moment the bundle was written out, which is why
 * `llm/external.ts` writes the ledger row at emission rather than at ingest.
 *
 * The API path this product drives itself is `"anthropic"`, and that has not
 * changed.
 */
export const LLM_PROVIDERS = ["anthropic", "openai", "external_session"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * What became of one run of the removed GPT polish chain (SPEC M3 wave B ⑩).
 *
 * Historical: no code path produces a new one. The four values are what the
 * archived `judgment_polish_runs` rows read back as, and they mean different
 * things when you read the audit trail:
 *   applied  — polished text passed every check and was written to the draft
 *   rejected — a draft came back and validation refused it (the interesting one)
 *   failed   — the vendor errored, timed out, or returned something unusable
 *   skipped  — no call was made (circuit breaker open, no model available)
 */
export const POLISH_OUTCOMES = [
  "applied",
  "rejected",
  "failed",
  "skipped",
] as const;
export type PolishOutcome = (typeof POLISH_OUTCOMES)[number];

/* -------------------------------------------------------------------------- */
/* Column helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Text primary key defaulting to a random UUID (works with :memory: too). */
const pk = () => text("id").primaryKey().$defaultFn(() => randomUUID());

/** created_at / updated_at as epoch-ms integers, defaulted in JS. */
function timestamps() {
  return {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  };
}

/** The recurring AI-product confirmation triple (ai_draft / human_final / confirm_status). */
function confirmTriple() {
  return {
    aiDraft: text("ai_draft"),
    humanFinal: text("human_final"),
    confirmStatus: text("confirm_status", { enum: CONFIRM_STATUSES })
      .notNull()
      .default("pending"),
  };
}

/**
 * The two columns every piece of submitted material carries (SPEC M5 ①).
 *
 * `owner_participant_id` is who put it there; `visibility` is who may read it,
 * and it defaults to `private`. Both are enforced in the query layer
 * (`src/server/access/visibility.ts`), which is the only place that can enforce
 * them: a prompt cannot widen what a SELECT did not return.
 *
 * A NULL owner is not a hole, it is the pre-M5 record: material the client
 * brought when there was one party and nothing to protect. The migration
 * backfills it to the case's submitter wherever a submitter is on file, and the
 * predicate treats what remains as owned by the case rather than by a person.
 */
function ownership() {
  return {
    ownerParticipantId: text("owner_participant_id").references(
      (): AnySQLiteColumn => caseParticipants.id,
      { onDelete: "set null" },
    ),
    visibility: text("visibility", { enum: VISIBILITY_STATES })
      .notNull()
      .default("private"),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. cases                                                                   */
/* -------------------------------------------------------------------------- */

export const cases = sqliteTable("cases", {
  id: pk(),
  /** One-line "what is being judged this time" statement, confirmed at issue_framing. */
  title: text("title"),
  /** Nine-stage state machine; advances server-side only. */
  stage: text("stage", { enum: CASE_STAGES }).notNull().default("intake"),
  /** Code-derived output level; null until locked. See domain/output-level.ts. */
  outputLevel: text("output_level", { enum: OUTPUT_LEVELS }),
  outputLevelLockedAt: integer("output_level_locked_at", {
    mode: "timestamp_ms",
  }),
  status: text("status", { enum: CASE_STATUSES }).notNull().default("open"),
  /**
   * What the client answered when asked what they wanted out of this, at
   * creation. A record of the request, not an instruction to anything
   * downstream — see CLIENT_INTENTS. NULL on cases created before the question
   * existed, and on script-created ones.
   */
  clientIntent: text("client_intent", { enum: CLIENT_INTENTS }),
  /** Mandatory evidence-onesidedness / completeness disclaimer surfaced in L1/L2. */
  onesidednessDisclaimer: text("onesidedness_disclaimer"),
  /**
   * True on authored demonstration cases (docs/05 §C, doc 04 §6.3): every person
   * in them is fictional. The UI must label such a case as fictional on every
   * surface that names it — the label is product content, not a debug flag.
   * The real case record is never marked with this, whatever a task book says
   * (see CLAUDE.md, Verification rule).
   */
  isFixture: integer("is_fixture", { mode: "boolean" }).notNull().default(false),
  /**
   * Set when wave A recorded something that weakens what this case can support
   * — today: no steelman of the counterparty could be produced or confirmed
   * (01-pipeline-design.md ⑤). It is a fact about the record, not a verdict:
   * output-level derivation reads it, and the judgment must disclose it.
   */
  downgradeSignal: integer("downgrade_signal", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Why the flag is set, in one line, for the disclosure block. */
  downgradeReason: text("downgrade_reason"),
  /**
   * When the case entered its current `stage`. Written by `advanceStage`
   * (server/pipeline/stage-machine.ts) — `updated_at` cannot serve, since any
   * edit to any column bumps it.
   */
  stageEnteredAt: integer("stage_entered_at", { mode: "timestamp_ms" }),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  ...timestamps(),
});

/* -------------------------------------------------------------------------- */
/* 2. case_participants                                                       */
/* -------------------------------------------------------------------------- */

export const caseParticipants = sqliteTable(
  "case_participants",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    role: text("role", { enum: PARTICIPANT_ROLES }).notNull(),
    /** Real name — local only, never leaves the machine, never sent to any LLM. */
    displayName: text("display_name"),
    /** Deterministic pseudonym (甲/乙/FRIEND_1) used at every LLM egress. */
    pseudonym: text("pseudonym").notNull(),
    participationState: text("participation_state", {
      enum: PARTICIPATION_STATES,
    })
      .notNull()
      .default("pending"),
    /**
     * SHA-256 of the one-time invite token. The plaintext is returned to the
     * caller once, at mint time, and never stored — so a copy of this database
     * does not contain a working invitation to anybody's relationship.
     */
    inviteTokenHash: text("invite_token_hash"),
    /** When the live token was minted. Re-issuing replaces the hash and this. */
    inviteTokenIssuedAt: integer("invite_token_issued_at", {
      mode: "timestamp_ms",
    }),
    /** Hard expiry. A token past it verifies as `expired`, never as unknown. */
    inviteTokenExpiresAt: integer("invite_token_expires_at", {
      mode: "timestamp_ms",
    }),
    /**
     * When the token was spent. This column is what makes it single-use: the
     * redemption UPDATE is conditional on it being NULL, so a replay finds
     * nothing to claim rather than relying on a caller to check first.
     */
    inviteTokenRedeemedAt: integer("invite_token_redeemed_at", {
      mode: "timestamp_ms",
    }),
    /** True for the party who actually submitted the case (may differ from device owner). */
    isSubmitter: integer("is_submitter", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Where this party is in their own entry flow. Only their acts write it. */
    respondState: text("respond_state", { enum: RESPOND_STATES })
      .notNull()
      .default("not_started"),
    /** When `respond_state` last moved. */
    respondStateAt: integer("respond_state_at", { mode: "timestamp_ms" }),
    /**
     * Why she declined, in her own words, verbatim — evidence, so never
     * normalized and never translated (CLAUDE.md). Null unless she wrote one:
     * declining without giving a reason is allowed and must stay legible as
     * "no reason given" rather than as an empty string somebody may quote.
     */
    declineReason: text("decline_reason"),
    ...timestamps(),
  },
  (t) => [
    index("case_participants_case_idx").on(t.caseId),
    uniqueIndex("case_participants_case_role_uq").on(t.caseId, t.role),
    /** Token lookup is by hash — the plaintext is never in the database. */
    index("case_participants_invite_hash_idx").on(t.inviteTokenHash),
  ],
);

/* -------------------------------------------------------------------------- */
/* 2b. participant_identities (what redeeming an invite creates)              */
/* -------------------------------------------------------------------------- */

/**
 * The account a redeemed invite upgrades a participant into
 * (02-engineering-architecture.md §1.3: "invite token — hashed in the DB,
 * single-use, upgradable to a full account").
 *
 * One row per participant, enforced by a unique index rather than by whoever
 * calls the redeem path: an identity is the thing that says "this row is now a
 * person who is here", and two of them for one participant would make every
 * later question about who did what unanswerable.
 *
 * `identity_token_hash` is a bearer capability, not a password: it is what lets
 * her come back to her own transparency view after the single-use invite is
 * spent. Hashed at rest for the same reason the invite is — a stolen copy of
 * this file must not be a way into anybody's case. There is no passkey here yet
 * (doc 02 §1.3 puts that at Phase 1); this is the seam where one goes.
 */
export const participantIdentities = sqliteTable(
  "participant_identities",
  {
    id: pk(),
    participantId: text("participant_id")
      .notNull()
      .references(() => caseParticipants.id, { onDelete: "cascade" }),
    /**
     * The name she gave for herself, if she gave one. Local only, never sent to
     * any model — the pseudonym on `case_participants` is what egresses
     * (HARD RULE #3).
     */
    displayName: text("display_name"),
    /** SHA-256 of the returned identity token. The plaintext is never stored. */
    identityTokenHash: text("identity_token_hash").notNull(),
    /** Last time that token resolved to this identity. */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("participant_identities_participant_uq").on(t.participantId),
    uniqueIndex("participant_identities_token_uq").on(t.identityTokenHash),
  ],
);

/* -------------------------------------------------------------------------- */
/* 3. files                                                                   */
/* -------------------------------------------------------------------------- */

export const files = sqliteTable(
  "files",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    originalFilename: text("original_filename"),
    /** M0 stores a placeholder path; raw media is not copied into the repo. */
    storagePath: text("storage_path"),
    /** Content hash for idempotent seed import (no duplicate rows on re-run). */
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size"),
    mimeType: text("mime_type"),
    ...ownership(),
    ...timestamps(),
  },
  (t) => [
    index("files_case_idx").on(t.caseId),
    uniqueIndex("files_case_sha_uq").on(t.caseId, t.sha256),
    index("files_owner_idx").on(t.caseId, t.ownerParticipantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 4. evidence                                                                */
/* -------------------------------------------------------------------------- */

export const evidence = sqliteTable(
  "evidence",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fileId: text("file_id").references(() => files.id, { onDelete: "set null" }),
    sourceType: text("source_type", { enum: EVIDENCE_SOURCE_TYPES }).notNull(),
    /**
     * Machine suggestion: the deterministic rule in domain/grading.ts applied to
     * source_type + provenance + the `evidence_anomaly_check` result. Advisory
     * only — nothing may treat it as the case's grade.
     */
    gradeSuggested: text("grade_suggested", { enum: EVIDENCE_GRADES }),
    /**
     * Final grade A-D. NULL until a human confirms it: the suggestion lives in
     * `grade_suggested`, and a query filtering on `grade_final` must therefore
     * never see an unreviewed item (same gating idea as `confirm_status`).
     */
    gradeFinal: text("grade_final", { enum: EVIDENCE_GRADES }),
    gradeRationale: text("grade_rationale"),
    /**
     * Raw `evidence_anomaly_check` output ({is_ai_artifact, is_mass_content,
     * rationale}) kept for audit: it is what demoted an A-looking screenshot to
     * C/D, so the reviewer can see the machine's reasoning next to the badge.
     */
    gradeAnomaly: text("grade_anomaly", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    /**
     * When a human signed off on `grade_final` (evidence workbench, M2).
     *
     * The grade is the confirmation triple spread over three columns:
     * `grade_suggested` is the ai_draft, `grade_final` is the human_final, and
     * this timestamp records the moment the two were reconciled. Setting one
     * without the other is a bug — both are written by the same confirm action.
     */
    gradeConfirmedAt: integer("grade_confirmed_at", { mode: "timestamp_ms" }),
    /**
     * Provenance chain: e.g. a C-grade AI summary derived from an A-grade
     * screenshot points back to its source evidence (self-reference).
     */
    derivedFromEvidenceId: text("derived_from_evidence_id").references(
      (): AnySQLiteColumn => evidence.id,
      { onDelete: "set null" },
    ),
    contentSummary: text("content_summary"),
    ...ownership(),
    ...timestamps(),
  },
  (t) => [
    index("evidence_case_idx").on(t.caseId),
    index("evidence_derived_from_idx").on(t.derivedFromEvidenceId),
    index("evidence_owner_idx").on(t.caseId, t.ownerParticipantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 5. utterances                                                              */
/* -------------------------------------------------------------------------- */

export const utterances = sqliteTable(
  "utterances",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    speakerParticipantId: text("speaker_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** Pseudonym label (甲/乙) captured alongside the speaker. */
    speakerLabel: text("speaker_label"),
    /**
     * When true the quote is a recollection ("as you recall it, they said…");
     * the rendering layer enforces this framing — do not rely on the model.
     */
    isRetold: integer("is_retold", { mode: "boolean" }).notNull().default(false),
    tone: text("tone", { enum: UTTERANCE_TONES }),
    /** Fractional-index ordering within the source evidence. */
    orderKey: text("order_key"),
    ...ownership(),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [
    index("utterances_case_idx").on(t.caseId),
    index("utterances_evidence_idx").on(t.evidenceId),
    index("utterances_confirm_idx").on(t.confirmStatus),
    index("utterances_owner_idx").on(t.caseId, t.ownerParticipantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6. events                                                                  */
/* -------------------------------------------------------------------------- */

export const events = sqliteTable(
  "events",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** External label such as E1..E11 from the referenced-events table. */
    label: text("label"),
    title: text("title"),
    description: text("description"),
    /** Point-in-time anchor (when precision is exact/day/month). */
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
    /** Range anchors (when precision is range, e.g. E5/E9). */
    occurredStart: integer("occurred_start", { mode: "timestamp_ms" }),
    occurredEnd: integer("occurred_end", { mode: "timestamp_ms" }),
    occurredPrecision: text("occurred_precision", { enum: OCCURRED_PRECISIONS })
      .notNull()
      .default("unknown"),
    /** Fractional-index key for user drag-ordering (never integer reindex). */
    orderKey: text("order_key").notNull().default("a0"),
    /**
     * Whether the user has placed this event on the timeline mainline.
     *
     * An event with a date anchor (occurred_precision != 'unknown') belongs on
     * the mainline by its own dating and ignores this flag. Undated events sit
     * in the "date undecided" holding area until the user drags one in, which is the
     * only thing this bit records — `order_key` alone cannot express it, since
     * every event always carries an order key.
     */
    inTimeline: integer("in_timeline", { mode: "boolean" })
      .notNull()
      .default(false),
    confirmStatus: text("confirm_status", { enum: CONFIRM_STATUSES })
      .notNull()
      .default("pending"),
    ...ownership(),
    ...timestamps(),
  },
  (t) => [
    index("events_case_idx").on(t.caseId),
    index("events_order_idx").on(t.caseId, t.orderKey),
    index("events_owner_idx").on(t.caseId, t.ownerParticipantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 7. event_evidence (junction)                                               */
/* -------------------------------------------------------------------------- */

export const eventEvidence = sqliteTable(
  "event_evidence",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.evidenceId] })],
);

/* -------------------------------------------------------------------------- */
/* 8. clarification_rounds                                                    */
/* -------------------------------------------------------------------------- */

export const clarificationRounds = sqliteTable(
  "clarification_rounds",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** 1-based round index; the FSM caps at 3 rounds in code (schema is a backstop). */
    roundNumber: integer("round_number").notNull(),
    /**
     * Up to 3 questions per round (enforced by the server FSM — HARD RULE #4).
     * Each carries an id so its answer can be matched back after a reword.
     */
    questions: text("questions", { mode: "json" }).$type<
      ClarificationQuestion[]
    >(),
    /** Answers keyed to `questions[].id`; a round may be partly answered. */
    answers: text("answers", { mode: "json" }).$type<ClarificationAnswer[]>(),
    /** True once no new information emerges (marginal-diminishing saturation). */
    saturated: integer("saturated", { mode: "boolean" }).notNull().default(false),
    /**
     * The stage's own `can_proceed` report. Advisory only: how many rounds and
     * questions are allowed is counted in server code, never read off a model
     * answer (HARD RULE #4).
     */
    canProceed: integer("can_proceed", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Set when every question in the round has an answer — the round is done. */
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    ...timestamps(),
  },
  (t) => [
    index("clarification_rounds_case_idx").on(t.caseId),
    uniqueIndex("clarification_rounds_case_round_uq").on(t.caseId, t.roundNumber),
  ],
);

/* -------------------------------------------------------------------------- */
/* 9. steelman_versions                                                       */
/* -------------------------------------------------------------------------- */

export const steelmanVersions = sqliteTable(
  "steelman_versions",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** Monotonic version as the steelman is regenerated/refined. */
    version: integer("version").notNull().default(1),
    /**
     * What the user answered to "they would probably say roughly this".
     *
     * Distinct from `confirm_status`, which is about the text of the draft:
     * this is about the *claim* the draft makes. A rewritten steelman can still
     * be `rebutted`, and `unable` sets the case's downgrade signal.
     */
    verdict: text("verdict", { enum: STEELMAN_VERDICTS })
      .notNull()
      .default("pending"),
    /** The user's own account of what the counterparty would actually say. */
    rebuttal: text("rebuttal"),
    /** When `verdict` was recorded. */
    verdictAt: integer("verdict_at", { mode: "timestamp_ms" }),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [index("steelman_versions_case_idx").on(t.caseId)],
);

/* -------------------------------------------------------------------------- */
/* 10. issues (three lists at issue_framing)                                  */
/* -------------------------------------------------------------------------- */

export const issues = sqliteTable(
  "issues",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /**
     * Which of the three lists this item belongs to — this column IS the list
     * type (undisputed / fact_dispute / standard_dispute).
     */
    category: text("category", { enum: ISSUE_CATEGORIES }).notNull(),
    /**
     * Utterance ids this item rests on. Every item carries them, and the server
     * validates each one exists AND is confirmed before the generation is
     * accepted — HARD RULE #1. Never trusted as returned by a model.
     */
    evidenceRefs: text("evidence_refs", { mode: "json" }).$type<string[]>(),
    orderKey: text("order_key"),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [
    index("issues_case_idx").on(t.caseId),
    index("issues_category_idx").on(t.caseId, t.category),
  ],
);

/* -------------------------------------------------------------------------- */
/* 11. adverse_facts                                                          */
/* -------------------------------------------------------------------------- */

export const adverseFacts = sqliteTable(
  "adverse_facts",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** Evidence backing this adverse fact (evidence-map signoff). */
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    /**
     * Utterance ids backing this adverse fact, beyond the single `evidence_id`
     * above. Validated for existence and confirmed status like every other
     * model-emitted reference (HARD RULE #1).
     */
    evidenceRefs: text("evidence_refs", { mode: "json" }).$type<string[]>(),
    /** Pre-confirmation acknowledgement state (pre-judgment confrontation). */
    ackStatus: text("ack_status", { enum: ACK_STATUSES })
      .notNull()
      .default("pending"),
    /** What the user said when acknowledging or contesting it. */
    ackNote: text("ack_note"),
    /** When `ack_status` left `pending`. */
    ackedAt: integer("acked_at", { mode: "timestamp_ms" }),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [index("adverse_facts_case_idx").on(t.caseId)],
);

/* -------------------------------------------------------------------------- */
/* 12. judgments                                                              */
/* -------------------------------------------------------------------------- */

export const judgments = sqliteTable(
  "judgments",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** Version bumps on every regeneration; a final judgment is frozen. */
    version: integer("version").notNull().default(1),
    /** Locked output level this judgment was issued at. */
    outputLevel: text("output_level", { enum: OUTPUT_LEVELS }).notNull(),
    /** Immutable fact_layer (claims[] with evidence_refs) as JSON text. */
    content: text("content", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Narrative surface_layer bound to claim_ids (JSON text). */
    surfaceLayer: text("surface_layer", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    /** Model snapshot (e.g. claude-fable-5) for version/appeal disclosure. */
    model: text("model").notNull(),
    effort: text("effort", { enum: LLM_EFFORTS }),
    promptVersion: text("prompt_version"),
    /** Set when the request was silently routed to the fallback model (sticky routing). */
    fallbackUsed: integer("fallback_used", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status", { enum: JUDGMENT_STATUSES })
      .notNull()
      .default("draft"),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
    /**
     * The judgment this one was regenerated from. Null on version 1.
     *
     * HARD RULE #6 says a `final` judgment is frozen, so a re-hearing cannot
     * edit it — it writes `version + 1` instead, and this column is the link
     * back. Without it the chain would only be inferable from the version
     * numbers, which says the rows are adjacent but not that one replaced the
     * other; the disclosure the rule demands ("here is the diff, here is which
     * model produced it") needs a stated predecessor, not an adjacent row.
     */
    supersedesJudgmentId: text("supersedes_judgment_id").references(
      (): AnySQLiteColumn => judgments.id,
      { onDelete: "set null" },
    ),
    ...timestamps(),
  },
  (t) => [
    index("judgments_case_idx").on(t.caseId),
    index("judgments_supersedes_idx").on(t.supersedesJudgmentId),
    uniqueIndex("judgments_case_version_uq").on(t.caseId, t.version),
  ],
);

/* -------------------------------------------------------------------------- */
/* 13. judgment_renditions                                                    */
/* -------------------------------------------------------------------------- */

export const judgmentRenditions = sqliteTable(
  "judgment_renditions",
  {
    id: pk(),
    judgmentId: text("judgment_id")
      .notNull()
      .references(() => judgments.id, { onDelete: "cascade" }),
    /** self_reflection is never exportable; shareable carries an expiring token. */
    kind: text("kind", { enum: RENDITION_KINDS }).notNull(),
    content: text("content"),
    /**
     * The narrative this rendition renders, when it has one of its own.
     *
     * `shareable` does (SPEC M4 ①): the document handed to the counterparty is a
     * second surface layer, generated from the same frozen fact layer and
     * addressed to her, because filtering the client-addressed narrative
     * produced a document that called the recipient by her partner's role
     * ("You, 乙, submitted this case"). `self_reflection` leaves this null — it
     * renders the judgment's own `surface_layer` and always will.
     *
     * Null on a shareable row means the counterparty narrative has not been
     * generated yet, and nothing is rendered or shared from that row until it is.
     */
    surfaceLayer: text("surface_layer", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    /** False for self_reflection; true only for a gated shareable rendition. */
    shareable: integer("shareable", { mode: "boolean" }).notNull().default(false),
    /**
     * Provenance of the generated narrative — a rendition is a DERIVED artifact
     * with its own lifecycle, so it carries its own model, effort and prompt
     * version rather than inheriting the judgment's. Regenerating one bumps
     * `revision` and never touches the frozen judgment row (HARD RULE #6).
     */
    model: text("model"),
    effort: text("effort", { enum: LLM_EFFORTS }),
    promptVersion: text("prompt_version"),
    fallbackUsed: integer("fallback_used", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 0 while nothing has been generated; +1 on every (re)generation. */
    revision: integer("revision").notNull().default(0),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }),
    /** Hashed one-time share token (never plaintext); only for shareable kind. */
    shareTokenHash: text("share_token_hash"),
    shareExpiresAt: integer("share_expires_at", { mode: "timestamp_ms" }),
    ...timestamps(),
  },
  (t) => [
    index("judgment_renditions_judgment_idx").on(t.judgmentId),
    uniqueIndex("judgment_renditions_judgment_kind_uq").on(
      t.judgmentId,
      t.kind,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 13b. judgment_swap_tests (bias audit — SPEC M3 wave B ⑨)                   */
/* -------------------------------------------------------------------------- */

/**
 * One swap test: the same skeleton heard twice, once with the parties' address
 * terms exchanged, and what differed between the two hearings.
 *
 * There is no score column and there will not be one. The product has no
 * calibration data, so a number here would be a threshold somebody invented,
 * printed with the authority of a measurement. What is stored instead is the
 * measured difference (`report`) plus qualitative `flags`, and — first, because
 * it decides how much any of the rest is worth — whether the record makes the
 * comparison unable to isolate bias at all (`degenerate`).
 */
export const judgmentSwapTests = sqliteTable(
  "judgment_swap_tests",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** The judgment whose skeleton was tested; null when run standalone. */
    judgmentId: text("judgment_id").references(() => judgments.id, {
      onDelete: "set null",
    }),
    /** Which transformation was applied (see judgment/swap-test.ts). */
    arm: text("arm").notNull(),
    /**
     * True when the record cannot support the inference the test exists to
     * make — e.g. only one party has confirmed utterances, so the swapped arm
     * is a different case rather than a mirror of the same one.
     */
    degenerate: integer("degenerate", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Why, in one paragraph, in the words shown to whoever reads the audit. */
    degenerateReason: text("degenerate_reason"),
    /** Qualitative flag codes (`allocation_exchanged`, …). Never a score. */
    flags: text("flags", { mode: "json" }).$type<string[]>(),
    /** The whole comparison: dictionary, both skeletons, measured differences. */
    report: text("report", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("judgment_swap_tests_case_idx").on(t.caseId),
    index("judgment_swap_tests_judgment_idx").on(t.judgmentId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 14. improvement_contracts                                                  */
/* -------------------------------------------------------------------------- */

export const improvementContracts = sqliteTable(
  "improvement_contracts",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    judgmentId: text("judgment_id").references(() => judgments.id, {
      onDelete: "set null",
    }),
    /** Structured commitments (JSON text). */
    content: text("content", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status", { enum: CONTRACT_STATUSES })
      .notNull()
      .default("draft"),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [index("improvement_contracts_case_idx").on(t.caseId)],
);

/* -------------------------------------------------------------------------- */
/* 15. repair_scripts                                                         */
/* -------------------------------------------------------------------------- */

export const repairScripts = sqliteTable(
  "repair_scripts",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    judgmentId: text("judgment_id").references(() => judgments.id, {
      onDelete: "set null",
    }),
    /** Suggested repair-conversation script (opus-transformed from fact_layer). */
    content: text("content"),
    ...confirmTriple(),
    ...timestamps(),
  },
  (t) => [index("repair_scripts_case_idx").on(t.caseId)],
);

/* -------------------------------------------------------------------------- */
/* 16. followups (7/30-day)                                                   */
/* -------------------------------------------------------------------------- */

export const followups = sqliteTable(
  "followups",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: FOLLOWUP_KINDS }).notNull(),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: FOLLOWUP_STATUSES })
      .notNull()
      .default("scheduled"),
    /** Behavior-only responses (JSON text). */
    response: text("response", { mode: "json" }).$type<Record<string, unknown>>(),

    /* --- M4 ④: what the row is derived from ------------------------------ */

    /** The frozen judgment whose freeze scheduled this. Never written to. */
    judgmentId: text("judgment_id").references(() => judgments.id, {
      onDelete: "set null",
    }),
    /**
     * The improvement contract whose commitments this check-in asks about.
     *
     * Nullable, and that is the documented seam: the scheduler keys off the
     * judgment, so a follow-up is scheduled at freeze time whether or not a
     * contract exists yet. When one is written later, the row is linked on the
     * next scheduler pass; when none ever is, the check-in still fires and asks
     * about the behaviour the judgment established.
     */
    improvementContractId: text("improvement_contract_id").references(
      () => improvementContracts.id,
      { onDelete: "set null" },
    ),
    /**
     * The commitments as they read when the questions were generated (JSON).
     * A snapshot, because the questions must keep meaning what they meant even
     * if the contract is edited afterwards.
     */
    commitments: text("commitments", { mode: "json" }).$type<unknown>(),
    /** The generated behaviour questions (JSON), after every server check. */
    questions: text("questions", { mode: "json" }).$type<unknown>(),

    /* --- M4 ④: the Message Batches round trip ---------------------------- */

    generationStatus: text("generation_status", {
      enum: FOLLOWUP_GENERATION_STATUSES,
    })
      .notNull()
      .default("pending"),
    /** Anthropic `msgbatch_…` id, for re-attaching to an in-flight batch. */
    batchId: text("batch_id"),
    /** This row's `custom_id` inside that batch. Results arrive unordered. */
    batchCustomId: text("batch_custom_id"),
    /** The `llm_calls` row this request was audited under, for usage backfill. */
    llmCallId: text("llm_call_id").references(() => llmCalls.id, {
      onDelete: "set null",
    }),
    /**
     * When a scheduler run claimed this row. Set by a conditional UPDATE, which
     * is what makes firing exactly-once: a second run finds nothing to claim.
     */
    firedAt: integer("fired_at", { mode: "timestamp_ms" }),
    /** When checked questions were stored. */
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }),
    /** Generation attempts so far; bounded, so a failure stops being retried. */
    attempts: integer("attempts").notNull().default(0),
    /** Why the last attempt failed. Rendered in the UI — never only logged. */
    lastError: text("last_error"),
    ...timestamps(),
  },
  (t) => [
    index("followups_case_idx").on(t.caseId),
    index("followups_scheduled_idx").on(t.status, t.scheduledAt),
    index("followups_generation_idx").on(t.generationStatus, t.scheduledAt),
    /**
     * One 7-day and one 30-day check-in per case, ever. This is what makes
     * scheduling idempotent at the storage layer rather than in a caller's
     * head: freezing the same judgment twice, or a catch-up sweep running
     * beside the freeze path, both land on the same two rows.
     */
    uniqueIndex("followups_case_kind_unique").on(t.caseId, t.kind),
  ],
);

/* -------------------------------------------------------------------------- */
/* 17. appeals                                                                */
/* -------------------------------------------------------------------------- */

export const appeals = sqliteTable(
  "appeals",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    originalJudgmentId: text("original_judgment_id")
      .notNull()
      .references(() => judgments.id, { onDelete: "cascade" }),
    /** The new judgment version produced by the appeal (once resolved). */
    newJudgmentId: text("new_judgment_id").references(() => judgments.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    /**
     * Who filed it (SPEC M5 ⑤). Null on rows written before the counterparty
     * could file at all, which the migration backfills to the case's submitter:
     * every appeal on file until now was his.
     *
     * The column exists so the scarcity rule can be per-actor. "One appeal per
     * version" is there to stop one person re-rolling the dice; applied across
     * people it would mean the first party to complain consumes the other's only
     * chance to, which is not anti-shopping, it is first-come-first-served
     * justice.
     */
    actorParticipantId: text("actor_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** New evidence submitted with the appeal (JSON text). */
    newEvidence: text("new_evidence", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    status: text("status", { enum: APPEAL_STATUSES })
      .notNull()
      .default("submitted"),
    ...timestamps(),
  },
  (t) => [
    index("appeals_case_idx").on(t.caseId),
    /**
     * One appeal per judgment version **per actor** — the anti-judgment-shopping
     * rule (01-pipeline-design.md, SPEC M4 ⑤) as M5 ⑤ narrows it.
     *
     * The rule is enforced in the service layer (`judgment/appeal.ts` refuses a
     * second filing with a sentence a person can read); this index is what makes
     * the refusal true rather than merely usual. It is deliberately NOT scoped to
     * a status: an appeal that failed mid-hearing is re-heard, never re-filed, so
     * there is no state in which a second row by the same actor against the same
     * version is correct.
     *
     * In the database the index is on `(original_judgment_id,
     * ifnull(actor_participant_id, ''))` — see migration 0011. SQLite treats
     * NULLs as distinct in a unique index, so a plain two-column index would let
     * two actor-less rows through and quietly lose the rule for exactly the path
     * that had it before M5. Drizzle's schema DSL cannot express the expression
     * index, so it is written by hand there and declared here under the same
     * name.
     */
    uniqueIndex("appeals_original_judgment_actor_uq").on(
      t.originalJudgmentId,
      t.actorParticipantId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 17c. consent_events (SPEC M5 ③ — consent is an event, not a bit)           */
/* -------------------------------------------------------------------------- */

/**
 * Append-only record of every grant and every revocation, with an actor and a
 * time.
 *
 * A boolean cannot carry this. "She consented" is a claim about a moment: who
 * said it, when, about what, and whether it still stands — and the answer has
 * to survive the answer changing. Revocation is not the deletion of a grant, it
 * is a later event that supersedes it, so both remain readable and the case can
 * show what was true while it was true.
 *
 * Effective state is therefore *derived*: the latest event per (actor, scope)
 * decides, and nothing in this table is ever rewritten. A `BEFORE UPDATE`
 * trigger in migration 0011 enforces that at the storage layer, because
 * "append-only" implemented as "we only ever call insert" is a convention, and
 * conventions are what a later caller does not know about.
 *
 * `actor_pseudonym` is denormalized on purpose. It is the audit's own copy of
 * who acted, and it must stay readable even if the participant row is gone.
 */
export const consentEvents = sqliteTable(
  "consent_events",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** The person whose consent this is. Their material, their say. */
    actorParticipantId: text("actor_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** The actor's egress token (甲 / 乙) — never their real name. */
    actorPseudonym: text("actor_pseudonym").notNull(),
    kind: text("kind", { enum: CONSENT_KINDS }).notNull(),
    scope: text("scope", { enum: CONSENT_SCOPES }).notNull(),
    /**
     * Who the event is about, when that is somebody other than the actor —
     * e.g. `counterparty_read` granted to a named party. Null means "everyone
     * this scope can mean", which for `case_record` is the only reading.
     */
    subjectParticipantId: text("subject_participant_id").references(
      (): AnySQLiteColumn => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** What they said about it, verbatim. Never normalized, never translated. */
    note: text("note"),
    /** When the act happened, as distinct from when the row was written. */
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("consent_events_case_idx").on(t.caseId),
    index("consent_events_actor_idx").on(t.caseId, t.actorParticipantId),
    index("consent_events_scope_idx").on(t.caseId, t.scope, t.occurredAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* 17d. deletion_requests (SPEC M5 ④ — the asymmetric half of deletion)       */
/* -------------------------------------------------------------------------- */

/**
 * A request to delete material somebody else submitted.
 *
 * Material she submitted herself is not in this table: she deletes it, and that
 * is the end of it. This exists for the other half — material *about* her that
 * the client submitted — where the honest answer is a recorded request surfaced
 * to him, not an erasure the product performs on his records and calls a right.
 *
 * The row is the record of the asking. It stays after the answer, whichever way
 * the answer went, because "I asked and was refused" is a fact about this case
 * that a later reader is entitled to see.
 */
export const deletionRequests = sqliteTable(
  "deletion_requests",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    requesterParticipantId: text("requester_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** The requester's pseudonym, kept on the row so the audit survives them. */
    requesterPseudonym: text("requester_pseudonym").notNull(),
    targetKind: text("target_kind", { enum: DELETION_TARGET_KINDS }).notNull(),
    /** Row id in the table `target_kind` names. Not a foreign key: the request
     * has to outlive the thing it asked about, including when the answer was
     * "yes" and the row is gone. */
    targetId: text("target_id").notNull(),
    /**
     * What the item is, in one line — so the request stays legible after its
     * target is deleted.
     *
     * It **identifies and does not reproduce**: kind, owner, size, grade, id.
     * Writing the material itself here would mean that granting a request moved
     * the content into this table instead of deleting it, and the first person
     * to read the request would find exactly what was asked to be removed. The
     * person answering does not need the copy — the row is still there while he
     * decides, and it is named by id. See `access/deletion.ts`.
     */
    targetSummary: text("target_summary"),
    /** Why she wants it gone, in her own words. Verbatim. */
    reason: text("reason"),
    status: text("status", { enum: DELETION_REQUEST_STATUSES })
      .notNull()
      .default("open"),
    /** The client's answer, in his own words. Verbatim, including a refusal. */
    resolutionNote: text("resolution_note"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedByParticipantId: text("resolved_by_participant_id").references(
      (): AnySQLiteColumn => caseParticipants.id,
      { onDelete: "set null" },
    ),
    ...timestamps(),
  },
  (t) => [
    index("deletion_requests_case_idx").on(t.caseId),
    index("deletion_requests_status_idx").on(t.caseId, t.status),
    index("deletion_requests_target_idx").on(t.targetKind, t.targetId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 17e. deletion_audit (SPEC M5 ④ — every deletion and every request)         */
/* -------------------------------------------------------------------------- */

/**
 * Append-only log of every act of deletion, and every act of asking.
 *
 * `deletion_requests` is the *asking*, with a status that moves while the answer
 * is pending. This is the *audit*, and it is a different thing: one immutable
 * row per act, written the moment the act happens, in the same transaction as
 * the act itself, so a deletion that was performed can never be a deletion that
 * was not logged. A BEFORE UPDATE trigger (migration 0012) makes that a property
 * of the database, exactly as it does for `consent_events`.
 *
 * The row has to survive its target: that is the whole point. `target_summary`
 * keeps one verbatim line of what the material was, so the record stays legible
 * after the material is gone, and `target_id` is deliberately not a foreign key
 * — a reference that cascades away when the row is deleted would erase the audit
 * along with the thing it audits.
 *
 * Both pseudonyms are denormalized for the same reason: an audit that becomes
 * unreadable when a participant row goes is not an audit.
 */
export const deletionAudit = sqliteTable(
  "deletion_audit",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** Who acted. Null only if their participant row was later removed. */
    actorParticipantId: text("actor_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    /** The actor's egress token (甲 / 乙) — never their real name. */
    actorPseudonym: text("actor_pseudonym").notNull(),
    act: text("act", { enum: DELETION_ACTS }).notNull(),
    targetKind: text("target_kind", { enum: DELETION_TARGET_KINDS }).notNull(),
    /** Row id in the table `target_kind` names. Not a foreign key — see above. */
    targetId: text("target_id").notNull(),
    /**
     * One line naming what the material was — kind, owner, size, id.
     *
     * It identifies and never reproduces. An audit that quoted the deleted line
     * would not be an audit of a deletion, it would be a second copy of the
     * thing somebody asked to have removed. See `access/deletion.ts`.
     */
    targetSummary: text("target_summary"),
    /** Who had submitted the material. The asymmetry, on the row itself. */
    targetOwnerParticipantId: text("target_owner_participant_id").references(
      (): AnySQLiteColumn => caseParticipants.id,
      { onDelete: "set null" },
    ),
    targetOwnerPseudonym: text("target_owner_pseudonym"),
    /** The request this act belongs to, when it belongs to one. */
    requestId: text("request_id").references(
      (): AnySQLiteColumn => deletionRequests.id,
      { onDelete: "set null" },
    ),
    /** What the actor said about it, verbatim — including a refusal. */
    note: text("note"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("deletion_audit_case_idx").on(t.caseId),
    index("deletion_audit_actor_idx").on(t.caseId, t.actorParticipantId),
    index("deletion_audit_target_idx").on(t.targetKind, t.targetId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 17b. judgment_exports (the egress audit — SPEC M4 ⑥)                       */
/* -------------------------------------------------------------------------- */

/**
 * One row per copy of a judgment that left this machine.
 *
 * Written by the export gate (`judgment/export-gate.ts`) as the last step of an
 * export that passed every check, and by nothing else. A blocked export writes
 * no row, which is the honest encoding: what is audited here is egress, and a
 * document that was refused never left.
 *
 * The exported text itself is not stored. `content_sha256` identifies the exact
 * bytes — enough to prove a given leaked copy is or is not this export — without
 * making the audit table a second place the judgment lives. Same discipline as
 * `egress_ledger`, for the same reason.
 */
export const judgmentExports = sqliteTable(
  "judgment_exports",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    judgmentId: text("judgment_id")
      .notNull()
      .references(() => judgments.id, { onDelete: "cascade" }),
    renditionId: text("rendition_id").references(() => judgmentRenditions.id, {
      onDelete: "set null",
    }),
    /** Which audience's copy. `self_reflection` may never appear here. */
    kind: text("kind", { enum: RENDITION_KINDS }).notNull(),
    /** Judgment version and rendition revision the copy was taken from. */
    judgmentVersion: integer("judgment_version").notNull(),
    renditionRevision: integer("rendition_revision").notNull().default(0),
    /** Who received it — a pseudonym. A real name in this column is the bug. */
    recipientPseudonym: text("recipient_pseudonym").notNull(),
    recipientParticipantId: text("recipient_participant_id").references(
      () => caseParticipants.id,
      { onDelete: "set null" },
    ),
    channel: text("channel", { enum: EXPORT_CHANNELS }).notNull(),
    /** SHA-256 of the exact bytes handed over, and how many there were. */
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** The visible watermark stamped on those bytes; carries this row's id. */
    watermark: text("watermark").notNull(),
    exportedAt: integer("exported_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("judgment_exports_case_idx").on(t.caseId),
    index("judgment_exports_judgment_idx").on(t.judgmentId),
    index("judgment_exports_exported_idx").on(t.exportedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* 18. safety_screens                                                         */
/* -------------------------------------------------------------------------- */

export const safetyScreens = sqliteTable(
  "safety_screens",
  {
    id: pk(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    screenType: text("screen_type", { enum: SAFETY_SCREEN_TYPES }).notNull(),
    /**
     * The questionnaire as asked and answered. Kept with the screen because the
     * outcome is only auditable next to what the user was actually asked.
     */
    answers: text("answers", { mode: "json" }).$type<SafetyAnswer[]>(),
    /**
     * Hit red flags (domestic violence / coercive control / stalking /
     * self-harm …) as JSON text.
     */
    redFlags: text("red_flags", { mode: "json" }).$type<string[]>(),
    /** Grounds for the outcome, in one short paragraph. */
    rationale: text("rationale"),
    outcome: text("outcome", { enum: SAFETY_OUTCOMES }).notNull(),
    /** True when the deterministic (non-LLM) crisis-referral path was shown. */
    referralShown: integer("referral_shown", { mode: "boolean" })
      .notNull()
      .default(false),
    ...timestamps(),
  },
  (t) => [index("safety_screens_case_idx").on(t.caseId)],
);

/* -------------------------------------------------------------------------- */
/* 19. llm_calls (usage & cost audit)                                         */
/* -------------------------------------------------------------------------- */

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: pk(),
    caseId: text("case_id").references(() => cases.id, { onDelete: "set null" }),
    stage: text("stage"),
    provider: text("provider", { enum: LLM_PROVIDERS }).notNull(),
    model: text("model").notNull(),
    effort: text("effort", { enum: LLM_EFFORTS }),
    promptVersion: text("prompt_version"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    costUsd: real("cost_usd"),
    latencyMs: integer("latency_ms"),
    /** Must be checked before reading content (refusal is an expected path here). */
    stopReason: text("stop_reason"),
    fallbackUsed: integer("fallback_used", { mode: "boolean" })
      .notNull()
      .default(false),
    /** usage.iterations fallback_message — sticky-routing detection. */
    fallbackMessage: text("fallback_message"),
    requestId: text("request_id"),
    /**
     * The input manifest: the ids this call actually serialized into its prompt,
     * sorted and de-duplicated, plus the prompt version they were serialized
     * under (doc 05 §B.3). JSON text, byte-stable — `{"ids":[…],"prompt_version":…}`
     * with sorted keys — so two calls that saw the same record hash the same.
     *
     * "What did this agent see" is meant to be a ledger answer rather than a
     * prompt-reading exercise, which is why the manifest is derived from the
     * assembled outbound bytes rather than declared by the caller: a declaration
     * can disagree with what was actually sent, and this cannot.
     *
     * **Null means the pre-manifest era** — every row written before migration
     * 0015 (2026-08-17). It is not "this call saw nothing": a call that genuinely
     * serialized no ids records an empty `ids` array and still gets a hash.
     */
    inputManifest: text("input_manifest"),
    /** SHA-256 of `input_manifest`'s exact bytes. Null on pre-manifest rows. */
    inputManifestSha256: text("input_manifest_sha256"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("llm_calls_case_idx").on(t.caseId),
    index("llm_calls_created_idx").on(t.createdAt),
    // "Which calls saw this exact input" — the manifest's own query.
    index("llm_calls_manifest_idx").on(t.inputManifestSha256),
  ],
);

/* -------------------------------------------------------------------------- */
/* 20. egress_ledger (data-egress accounting, hash-chained)                   */
/* -------------------------------------------------------------------------- */

export const egressLedger = sqliteTable(
  "egress_ledger",
  {
    id: pk(),
    llmCallId: text("llm_call_id").references(() => llmCalls.id, {
      onDelete: "set null",
    }),
    caseId: text("case_id").references(() => cases.id, { onDelete: "set null" }),
    /** Egress target/endpoint (e.g. anthropic / openai). */
    target: text("target").notNull(),
    model: text("model"),
    /** SHA-256 of the exact payload sent out. */
    payloadSha256: text("payload_sha256").notNull(),
    payloadBytes: integer("payload_bytes"),
    /** Previous entry hash — tamper-evident chain. */
    prevHash: text("prev_hash"),
    /** This entry's chain hash. */
    entryHash: text("entry_hash"),
    /** Retention expiry (30-day window) for the "current exposure" view. */
    expiryAt: integer("expiry_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("egress_ledger_case_idx").on(t.caseId),
    index("egress_ledger_expiry_idx").on(t.expiryAt),
    index("egress_ledger_call_idx").on(t.llmCallId),
  ],
);

/* -------------------------------------------------------------------------- */
/* 21. judgment_polish_runs (the (original, polished, diff) triple) — CLOSED   */
/* -------------------------------------------------------------------------- */

/**
 * The archive of the GPT polish layer. **Closed to new rows.**
 *
 * The layer was removed on 2026-08-16 (doc 02 §1.1a) and no code in this
 * repository inserts here any more; `judgment/polish-history.ts` reads it and
 * nothing writes it. The table and its rows stay because they are the audit
 * record of what this product sent to a second vendor and what came back —
 * including the six real GPT round trips whose measurement is the reason the
 * layer was cut. Dropping the table would delete the evidence behind the
 * decision.
 */
export const judgmentPolishRuns = sqliteTable(
  "judgment_polish_runs",
  {
    id: pk(),
    judgmentId: text("judgment_id")
      .notNull()
      .references(() => judgments.id, { onDelete: "cascade" }),
    /** What happened to the polished draft. See POLISH_OUTCOMES. */
    outcome: text("outcome", { enum: POLISH_OUTCOMES }).notNull(),
    /** OpenAI model that served the polish; null when none ever ran. */
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** Fable's surface_layer as it stood before polishing (JSON). */
    original: text("original", { mode: "json" }).$type<Record<string, unknown>>(),
    /**
     * The polished surface_layer (JSON) — kept even when it was REJECTED,
     * because "what the decorator wanted to say and why we refused it" is the
     * only evidence that the validation chain is doing anything.
     */
    polished: text("polished", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Per-section before/after (JSON), for the "view the unpolished original" toggle. */
    diff: text("diff", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Deterministic + entailment failures that rejected the draft (JSON). */
    failures: text("failures", { mode: "json" }).$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    ...timestamps(),
  },
  (t) => [index("judgment_polish_runs_judgment_idx").on(t.judgmentId)],
);

/* -------------------------------------------------------------------------- */
/* Relations (typed query helpers)                                            */
/* -------------------------------------------------------------------------- */

export const casesRelations = relations(cases, ({ many }) => ({
  participants: many(caseParticipants),
  files: many(files),
  evidence: many(evidence),
  utterances: many(utterances),
  events: many(events),
  clarificationRounds: many(clarificationRounds),
  steelmanVersions: many(steelmanVersions),
  issues: many(issues),
  adverseFacts: many(adverseFacts),
  judgments: many(judgments),
  improvementContracts: many(improvementContracts),
  repairScripts: many(repairScripts),
  followups: many(followups),
  appeals: many(appeals),
  safetyScreens: many(safetyScreens),
}));

export const caseParticipantsRelations = relations(
  caseParticipants,
  ({ one }) => ({
    case: one(cases, {
      fields: [caseParticipants.caseId],
      references: [cases.id],
    }),
    /** The account a redeemed invite created, if this party has taken one up. */
    identity: one(participantIdentities, {
      fields: [caseParticipants.id],
      references: [participantIdentities.participantId],
    }),
  }),
);

export const participantIdentitiesRelations = relations(
  participantIdentities,
  ({ one }) => ({
    participant: one(caseParticipants, {
      fields: [participantIdentities.participantId],
      references: [caseParticipants.id],
    }),
  }),
);

export const consentEventsRelations = relations(consentEvents, ({ one }) => ({
  case: one(cases, { fields: [consentEvents.caseId], references: [cases.id] }),
  actor: one(caseParticipants, {
    fields: [consentEvents.actorParticipantId],
    references: [caseParticipants.id],
  }),
}));

export const deletionRequestsRelations = relations(
  deletionRequests,
  ({ one }) => ({
    case: one(cases, {
      fields: [deletionRequests.caseId],
      references: [cases.id],
    }),
    requester: one(caseParticipants, {
      fields: [deletionRequests.requesterParticipantId],
      references: [caseParticipants.id],
    }),
  }),
);

export const deletionAuditRelations = relations(deletionAudit, ({ one }) => ({
  case: one(cases, { fields: [deletionAudit.caseId], references: [cases.id] }),
  actor: one(caseParticipants, {
    fields: [deletionAudit.actorParticipantId],
    references: [caseParticipants.id],
  }),
  request: one(deletionRequests, {
    fields: [deletionAudit.requestId],
    references: [deletionRequests.id],
  }),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  case: one(cases, { fields: [files.caseId], references: [cases.id] }),
  evidence: many(evidence),
}));

export const evidenceRelations = relations(evidence, ({ one, many }) => ({
  case: one(cases, { fields: [evidence.caseId], references: [cases.id] }),
  file: one(files, { fields: [evidence.fileId], references: [files.id] }),
  derivedFrom: one(evidence, {
    fields: [evidence.derivedFromEvidenceId],
    references: [evidence.id],
    relationName: "evidence_provenance",
  }),
  derivations: many(evidence, { relationName: "evidence_provenance" }),
  utterances: many(utterances),
  eventLinks: many(eventEvidence),
}));

export const utterancesRelations = relations(utterances, ({ one }) => ({
  case: one(cases, { fields: [utterances.caseId], references: [cases.id] }),
  evidence: one(evidence, {
    fields: [utterances.evidenceId],
    references: [evidence.id],
  }),
  speaker: one(caseParticipants, {
    fields: [utterances.speakerParticipantId],
    references: [caseParticipants.id],
  }),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  case: one(cases, { fields: [events.caseId], references: [cases.id] }),
  evidenceLinks: many(eventEvidence),
}));

export const eventEvidenceRelations = relations(eventEvidence, ({ one }) => ({
  event: one(events, {
    fields: [eventEvidence.eventId],
    references: [events.id],
  }),
  evidence: one(evidence, {
    fields: [eventEvidence.evidenceId],
    references: [evidence.id],
  }),
}));

export const judgmentsRelations = relations(judgments, ({ one, many }) => ({
  case: one(cases, { fields: [judgments.caseId], references: [cases.id] }),
  renditions: many(judgmentRenditions),
  /** The frozen version this one was regenerated from (null on version 1). */
  supersedes: one(judgments, {
    fields: [judgments.supersedesJudgmentId],
    references: [judgments.id],
    relationName: "judgment_lineage",
  }),
  supersededBy: many(judgments, { relationName: "judgment_lineage" }),
}));

export const judgmentRenditionsRelations = relations(
  judgmentRenditions,
  ({ one }) => ({
    judgment: one(judgments, {
      fields: [judgmentRenditions.judgmentId],
      references: [judgments.id],
    }),
  }),
);

export const llmCallsRelations = relations(llmCalls, ({ one, many }) => ({
  case: one(cases, { fields: [llmCalls.caseId], references: [cases.id] }),
  egressEntries: many(egressLedger),
}));

export const egressLedgerRelations = relations(egressLedger, ({ one }) => ({
  llmCall: one(llmCalls, {
    fields: [egressLedger.llmCallId],
    references: [llmCalls.id],
  }),
  case: one(cases, { fields: [egressLedger.caseId], references: [cases.id] }),
}));

/** Convenience: the full schema object for drizzle() and typed queries. */
export const schema = {
  cases,
  caseParticipants,
  participantIdentities,
  consentEvents,
  deletionRequests,
  deletionAudit,
  files,
  evidence,
  utterances,
  events,
  eventEvidence,
  clarificationRounds,
  steelmanVersions,
  issues,
  adverseFacts,
  judgments,
  judgmentRenditions,
  judgmentPolishRuns,
  judgmentSwapTests,
  improvementContracts,
  repairScripts,
  followups,
  appeals,
  judgmentExports,
  safetyScreens,
  llmCalls,
  egressLedger,
};
