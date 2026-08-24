-- M4 ⑤⑥: the appeal channel and the shareable-export gate.
--
-- Two additive changes, no rebuild, nothing existing rewritten.
--
-- 1. `judgment_exports` — one row per copy of a judgment that actually left the
--    machine: what, when, which rendition (kind + revision), which recipient.
--    The text itself is not stored; `content_sha256` identifies the exact bytes
--    without making this table a second place the judgment lives. A blocked
--    export writes nothing, because what is audited here is egress and a refused
--    document never left.
--
-- 2. `appeals_original_judgment_uq` — one appeal per judgment version, the
--    anti-judgment-shopping rule from 01-pipeline-design.md. It is enforced in
--    the service layer, where it can explain itself; the constraint is what makes
--    the refusal true instead of merely usual. Not scoped to a status on purpose:
--    an appeal whose hearing failed is re-heard, never re-filed.
CREATE TABLE `judgment_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`judgment_id` text NOT NULL,
	`rendition_id` text,
	`kind` text NOT NULL,
	`judgment_version` integer NOT NULL,
	`rendition_revision` integer DEFAULT 0 NOT NULL,
	`recipient_pseudonym` text NOT NULL,
	`recipient_participant_id` text,
	`channel` text NOT NULL,
	`content_sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`watermark` text NOT NULL,
	`exported_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rendition_id`) REFERENCES `judgment_renditions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `judgment_exports_case_idx` ON `judgment_exports` (`case_id`);--> statement-breakpoint
CREATE INDEX `judgment_exports_judgment_idx` ON `judgment_exports` (`judgment_id`);--> statement-breakpoint
CREATE INDEX `judgment_exports_exported_idx` ON `judgment_exports` (`exported_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `appeals_original_judgment_uq` ON `appeals` (`original_judgment_id`);