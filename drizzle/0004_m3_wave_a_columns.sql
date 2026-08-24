-- M3 wave A, one migration for the whole wave.
--
-- Every column the six wave-A steps need lands here so no later agent has to
-- generate a migration of its own: the safety questionnaire payload, the
-- clarification round's proceed report and close time, the steelman verdict,
-- the evidence_refs each issue and adverse fact carries (HARD RULE #1 validates
-- them server-side), the adverse-fact acknowledgement note, and the case-level
-- downgrade signal plus the stage-machine's stage_entered_at.
--
-- Pure ADD COLUMN: no table is rebuilt, so no data moves and no foreign key is
-- touched. `clarification_rounds.questions` / `.answers` change SHAPE (string[]
-- -> {id, question} / {questionId, answer, answeredAt}) but they are JSON text
-- columns, so that is a TypeScript-side retype with no SQL and no rows to
-- convert (the table is empty).
ALTER TABLE `adverse_facts` ADD `evidence_refs` text;--> statement-breakpoint
ALTER TABLE `adverse_facts` ADD `ack_note` text;--> statement-breakpoint
ALTER TABLE `adverse_facts` ADD `acked_at` integer;--> statement-breakpoint
ALTER TABLE `cases` ADD `downgrade_signal` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cases` ADD `downgrade_reason` text;--> statement-breakpoint
ALTER TABLE `cases` ADD `stage_entered_at` integer;--> statement-breakpoint
ALTER TABLE `clarification_rounds` ADD `can_proceed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `clarification_rounds` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `evidence_refs` text;--> statement-breakpoint
ALTER TABLE `safety_screens` ADD `answers` text;--> statement-breakpoint
ALTER TABLE `safety_screens` ADD `rationale` text;--> statement-breakpoint
ALTER TABLE `steelman_versions` ADD `verdict` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `steelman_versions` ADD `rebuttal` text;--> statement-breakpoint
ALTER TABLE `steelman_versions` ADD `verdict_at` integer;