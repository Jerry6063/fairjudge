-- M3 wave B ⑨: the swap-test audit record.
--
-- The skeleton is heard twice — once as filed, once with the parties' address
-- terms exchanged — and this row is what the comparison leaves behind. There is
-- deliberately no score column: nothing in this product is calibrated, so a
-- number would be an invented threshold wearing the clothes of a measurement.
-- The row carries the measured differences (`report`), qualitative `flags`, and
-- `degenerate` + `degenerate_reason` for the case this product actually has,
-- where only one party has confirmed words and the comparison therefore cannot
-- isolate bias at all.
--
-- Pure CREATE TABLE + CREATE INDEX: nothing existing is touched.
CREATE TABLE `judgment_swap_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`judgment_id` text,
	`arm` text NOT NULL,
	`degenerate` integer DEFAULT false NOT NULL,
	`degenerate_reason` text,
	`flags` text,
	`report` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `judgment_swap_tests_case_idx` ON `judgment_swap_tests` (`case_id`);--> statement-breakpoint
CREATE INDEX `judgment_swap_tests_judgment_idx` ON `judgment_swap_tests` (`judgment_id`);