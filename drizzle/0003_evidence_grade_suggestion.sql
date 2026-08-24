-- Evidence grading split: machine suggestion vs human-confirmed grade.
--
-- `grade_suggested` / `grade_anomaly` are new columns; `grade_final` drops its
-- NOT NULL so an unreviewed item can be NULL (see schema.ts). SQLite cannot
-- alter a column constraint in place, so the table is rebuilt.
--
-- Hand-edited: `drizzle-kit generate` emitted the rebuild alone, with an
-- INSERT ... SELECT that reads `grade_suggested` / `grade_anomaly` from the OLD
-- table, which does not have them yet ("no such column"). The two ADD COLUMNs
-- below run first so the copy has something to read.
--
-- Foreign keys must be OFF for the DROP + RENAME (otherwise the implicit DELETE
-- behind DROP TABLE cascades into `event_evidence` and nulls
-- `utterances.evidence_id`). The PRAGMA is a no-op inside a transaction and
-- drizzle wraps migrations in one, so `runMigrations()` in src/server/db turns
-- enforcement off around the whole migrate call and re-checks with
-- `PRAGMA foreign_key_check` afterwards.
ALTER TABLE `evidence` ADD `grade_suggested` text;--> statement-breakpoint
ALTER TABLE `evidence` ADD `grade_anomaly` text;--> statement-breakpoint
CREATE TABLE `__new_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`file_id` text,
	`source_type` text NOT NULL,
	`grade_suggested` text,
	`grade_final` text,
	`grade_rationale` text,
	`grade_anomaly` text,
	`grade_confirmed_at` integer,
	`derived_from_evidence_id` text,
	`content_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`derived_from_evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_evidence`("id", "case_id", "file_id", "source_type", "grade_suggested", "grade_final", "grade_rationale", "grade_anomaly", "grade_confirmed_at", "derived_from_evidence_id", "content_summary", "created_at", "updated_at") SELECT "id", "case_id", "file_id", "source_type", "grade_suggested", "grade_final", "grade_rationale", "grade_anomaly", "grade_confirmed_at", "derived_from_evidence_id", "content_summary", "created_at", "updated_at" FROM `evidence`;--> statement-breakpoint
DROP TABLE `evidence`;--> statement-breakpoint
ALTER TABLE `__new_evidence` RENAME TO `evidence`;--> statement-breakpoint
CREATE INDEX `evidence_case_idx` ON `evidence` (`case_id`);--> statement-breakpoint
CREATE INDEX `evidence_derived_from_idx` ON `evidence` (`derived_from_evidence_id`);
