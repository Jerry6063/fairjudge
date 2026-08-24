-- M5 ①③④⑤: identity, invite tokens, the visibility model, consent as events,
-- deletion requests, and the actor on an appeal.
--
-- THE migration for M5. Everything the later M5 work needs is here, because a
-- milestone that generates a migration per feature ends with four of them that
-- each half-apply on somebody's machine. Nothing below rewrites an existing row's
-- meaning; the two backfills state, in SQL, what was already true of the record.
--
-- 1. `case_participants` — the invite token grows the three columns that make it
--    real: when it was minted, when it dies, and whether it has been spent. The
--    hash column already existed and still holds a SHA-256; the plaintext is
--    returned once at mint time and never stored. `respond_state` / `decline_reason`
--    are hers: what SHE did, kept apart from `participation_state`, which is the
--    client's report of what happened when she was asked.
--
-- 2. `participant_identities` — what redeeming an invite creates (doc 02 §1.3:
--    "single-use, upgradable to a full account"). One per participant, enforced
--    by a unique index rather than by whoever calls the redeem path.
--
-- 3. `owner_participant_id` + `visibility` on every table a party submits into
--    (`files`, `evidence`, `utterances`, `events`). Default `private`. Enforced in
--    the query layer (`src/server/access/visibility.ts`) — the only place it can
--    be enforced, since a prompt cannot widen what a SELECT did not return.
--
--    The backfill sets the owner of existing material to the case's submitter.
--    That is not a new claim: until M5 one person brought every case and every
--    row in it, and leaving the column NULL would make the record say nobody
--    submitted his evidence.
--
-- 4. `consent_events` — append-only, actor + kind + scope + timestamp. The
--    BEFORE UPDATE trigger is what makes "append-only" a property of the database
--    instead of a habit of the callers. DELETE is left to the cascade from
--    `cases`: when a whole case goes there is no history left to protect.
--
-- 5. `deletion_requests` — the asymmetric half of deletion. What she submitted she
--    deletes outright and no row appears here; this is for material about her that
--    he submitted, where the honest answer is a recorded request surfaced to him.
--
-- 6. `appeals.actor_participant_id` + the per-actor uniqueness rule. One appeal per
--    version per actor: applied across people, "one appeal per version" would mean
--    the first party to complain consumes the other's only chance to. Existing rows
--    are backfilled to the submitter, because every appeal filed so far was his.
CREATE TABLE `consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`actor_participant_id` text,
	`actor_pseudonym` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`subject_participant_id` text,
	`note` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subject_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `consent_events_case_idx` ON `consent_events` (`case_id`);--> statement-breakpoint
CREATE INDEX `consent_events_actor_idx` ON `consent_events` (`case_id`,`actor_participant_id`);--> statement-breakpoint
CREATE INDEX `consent_events_scope_idx` ON `consent_events` (`case_id`,`scope`,`occurred_at`);--> statement-breakpoint
CREATE TRIGGER `consent_events_append_only`
BEFORE UPDATE ON `consent_events`
BEGIN
	SELECT RAISE(ABORT, 'consent_events is append-only: a grant is superseded by a later revocation event, never edited');
END;--> statement-breakpoint
CREATE TABLE `deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`requester_participant_id` text,
	`requester_pseudonym` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_summary` text,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution_note` text,
	`resolved_at` integer,
	`resolved_by_participant_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deletion_requests_case_idx` ON `deletion_requests` (`case_id`);--> statement-breakpoint
CREATE INDEX `deletion_requests_status_idx` ON `deletion_requests` (`case_id`,`status`);--> statement-breakpoint
CREATE INDEX `deletion_requests_target_idx` ON `deletion_requests` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `participant_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`display_name` text,
	`identity_token_hash` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_identities_participant_uq` ON `participant_identities` (`participant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `participant_identities_token_uq` ON `participant_identities` (`identity_token_hash`);--> statement-breakpoint
DROP INDEX `appeals_original_judgment_uq`;--> statement-breakpoint
ALTER TABLE `appeals` ADD `actor_participant_id` text REFERENCES case_participants(id);--> statement-breakpoint
UPDATE `appeals` SET `actor_participant_id` = (
	SELECT `id` FROM `case_participants`
	WHERE `case_participants`.`case_id` = `appeals`.`case_id`
	  AND `case_participants`.`is_submitter` = 1
	LIMIT 1
) WHERE `actor_participant_id` IS NULL;--> statement-breakpoint
-- On `ifnull(...)`, not on the bare column: SQLite treats NULLs as distinct in a
-- unique index, so `(original_judgment_id, actor_participant_id)` would let two
-- actor-less rows through and quietly lose the anti-shopping rule for exactly the
-- path that had it before M5. Declared in schema.ts under the same name; drizzle's
-- DSL cannot express the expression, which is why this file is hand-edited.
CREATE UNIQUE INDEX `appeals_original_judgment_actor_uq` ON `appeals` (`original_judgment_id`,ifnull(`actor_participant_id`, ''));--> statement-breakpoint
ALTER TABLE `case_participants` ADD `invite_token_issued_at` integer;--> statement-breakpoint
ALTER TABLE `case_participants` ADD `invite_token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `case_participants` ADD `invite_token_redeemed_at` integer;--> statement-breakpoint
ALTER TABLE `case_participants` ADD `respond_state` text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE `case_participants` ADD `respond_state_at` integer;--> statement-breakpoint
ALTER TABLE `case_participants` ADD `decline_reason` text;--> statement-breakpoint
CREATE INDEX `case_participants_invite_hash_idx` ON `case_participants` (`invite_token_hash`);--> statement-breakpoint
ALTER TABLE `events` ADD `owner_participant_id` text REFERENCES case_participants(id);--> statement-breakpoint
ALTER TABLE `events` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `events_owner_idx` ON `events` (`case_id`,`owner_participant_id`);--> statement-breakpoint
ALTER TABLE `evidence` ADD `owner_participant_id` text REFERENCES case_participants(id);--> statement-breakpoint
ALTER TABLE `evidence` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `evidence_owner_idx` ON `evidence` (`case_id`,`owner_participant_id`);--> statement-breakpoint
ALTER TABLE `files` ADD `owner_participant_id` text REFERENCES case_participants(id);--> statement-breakpoint
ALTER TABLE `files` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`case_id`,`owner_participant_id`);--> statement-breakpoint
ALTER TABLE `utterances` ADD `owner_participant_id` text REFERENCES case_participants(id);--> statement-breakpoint
ALTER TABLE `utterances` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `utterances_owner_idx` ON `utterances` (`case_id`,`owner_participant_id`);--> statement-breakpoint
-- The backfill. Existing material is the client's: until M5 one person brought
-- every case and every row in it. Visibility stays `private`, which is the honest
-- state — his material was never shared with anybody — and the query layer reads
-- the submitter's private material into the case record because submitting a case
-- is what putting material into it means. A row whose case has no submitter on
-- file stays NULL and is treated as owned by the case rather than by a person.
UPDATE `files` SET `owner_participant_id` = (
	SELECT `id` FROM `case_participants`
	WHERE `case_participants`.`case_id` = `files`.`case_id`
	  AND `case_participants`.`is_submitter` = 1
	LIMIT 1
) WHERE `owner_participant_id` IS NULL;--> statement-breakpoint
UPDATE `evidence` SET `owner_participant_id` = (
	SELECT `id` FROM `case_participants`
	WHERE `case_participants`.`case_id` = `evidence`.`case_id`
	  AND `case_participants`.`is_submitter` = 1
	LIMIT 1
) WHERE `owner_participant_id` IS NULL;--> statement-breakpoint
UPDATE `utterances` SET `owner_participant_id` = (
	SELECT `id` FROM `case_participants`
	WHERE `case_participants`.`case_id` = `utterances`.`case_id`
	  AND `case_participants`.`is_submitter` = 1
	LIMIT 1
) WHERE `owner_participant_id` IS NULL;--> statement-breakpoint
UPDATE `events` SET `owner_participant_id` = (
	SELECT `id` FROM `case_participants`
	WHERE `case_participants`.`case_id` = `events`.`case_id`
	  AND `case_participants`.`is_submitter` = 1
	LIMIT 1
) WHERE `owner_participant_id` IS NULL;
