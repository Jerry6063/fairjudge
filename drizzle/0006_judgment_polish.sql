-- M3 wave B ⑩: the (original, polished, diff) triple the polish chain persists.
--
-- GPT polish is a decoration layer that is allowed to fail (HARD RULE #8), so
-- every run is recorded whether it was applied, rejected by validation, failed
-- at the vendor, or never attempted — including the polished draft that was
-- REFUSED, because a rejection nobody can inspect is indistinguishable from a
-- validator that never ran. The row also backs the "view the unpolished
-- original" toggle (doc 02 §1.2).
--
-- Pure CREATE TABLE + CREATE INDEX: nothing existing is touched.
CREATE TABLE `judgment_polish_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`judgment_id` text NOT NULL,
	`outcome` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`original` text,
	`polished` text,
	`diff` text,
	`failures` text,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgment_polish_runs_judgment_idx` ON `judgment_polish_runs` (`judgment_id`);