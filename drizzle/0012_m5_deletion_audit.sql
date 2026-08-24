-- M5 ④: the deletion audit.
--
-- `deletion_requests` (0011) is the asking, and its status moves while an answer
-- is pending. This is the audit: one immutable row per act — a deletion, a
-- request, a grant, a refusal — written in the same transaction as the act, so a
-- deletion that happened cannot be a deletion that went unlogged.
--
-- `target_id` is deliberately NOT a foreign key. A reference that cascaded away
-- with its target would delete the audit along with the thing it audits, which
-- is the one failure this table exists to prevent. `target_summary` and both
-- pseudonyms are denormalized for the same reason: the row has to stay legible
-- after its target, and after the participant, are gone.
--
-- The BEFORE UPDATE trigger is what makes "append-only" a property of the
-- database rather than a habit of the callers, exactly as for `consent_events`.
-- DELETE is left to the cascade from `cases`: when a whole case goes there is no
-- history left to protect.
CREATE TABLE `deletion_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`actor_participant_id` text,
	`actor_pseudonym` text NOT NULL,
	`act` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_summary` text,
	`target_owner_participant_id` text,
	`target_owner_pseudonym` text,
	`request_id` text,
	`note` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_owner_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `deletion_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deletion_audit_case_idx` ON `deletion_audit` (`case_id`);--> statement-breakpoint
CREATE INDEX `deletion_audit_actor_idx` ON `deletion_audit` (`case_id`,`actor_participant_id`);--> statement-breakpoint
CREATE INDEX `deletion_audit_target_idx` ON `deletion_audit` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TRIGGER `deletion_audit_append_only`
BEFORE UPDATE ON `deletion_audit`
BEGIN
	SELECT RAISE(ABORT, 'deletion_audit is append-only: a later act is a new row, never an edit to the record of an earlier one');
END;