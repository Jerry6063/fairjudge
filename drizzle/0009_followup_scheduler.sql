-- M4 ④: the 7 / 30-day follow-up scheduler.
--
-- The `followups` table has existed since M0 as four columns and an intent.
-- What it lacked was everything needed to answer "did this actually fire?" —
-- which is the only question that matters here, because the failure mode of a
-- scheduled task on a laptop that sleeps is silence, not an error.
--
-- So the additions are all provenance and state:
--   * `judgment_id` / `improvement_contract_id` — what the check-in is derived
--     from. The contract link is nullable by design (the documented seam): the
--     scheduler keys off the frozen judgment, so a follow-up exists from the
--     moment the judgment is frozen whether or not a contract has been written.
--   * `commitments` / `questions` — the snapshot the questions were generated
--     from, and the checked questions themselves.
--   * `generation_status` / `batch_id` / `batch_custom_id` / `llm_call_id` /
--     `fired_at` / `generated_at` / `attempts` / `last_error` — the Message
--     Batches round trip, recorded rather than inferred. A batch that never
--     came back leaves `submitted` + a `batch_id` on the row; a generation that
--     failed its retries leaves `failed` + `last_error`. Both render in the UI.
--
-- `followups_case_kind_unique` is what makes scheduling idempotent in storage
-- instead of in a caller's head: one 7-day and one 30-day check-in per case,
-- so the freeze path and the catch-up sweep can both run and still produce two
-- rows. (A pre-existing database with duplicate (case_id, kind) rows would fail
-- here — loudly, which is correct: those rows are a scheduling bug.)
--
-- Additive only: twelve ADD COLUMNs and two indexes, no table rebuild.
ALTER TABLE `followups` ADD `judgment_id` text REFERENCES judgments(id);--> statement-breakpoint
ALTER TABLE `followups` ADD `improvement_contract_id` text REFERENCES improvement_contracts(id);--> statement-breakpoint
ALTER TABLE `followups` ADD `commitments` text;--> statement-breakpoint
ALTER TABLE `followups` ADD `questions` text;--> statement-breakpoint
ALTER TABLE `followups` ADD `generation_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `followups` ADD `batch_id` text;--> statement-breakpoint
ALTER TABLE `followups` ADD `batch_custom_id` text;--> statement-breakpoint
ALTER TABLE `followups` ADD `llm_call_id` text REFERENCES llm_calls(id);--> statement-breakpoint
ALTER TABLE `followups` ADD `fired_at` integer;--> statement-breakpoint
ALTER TABLE `followups` ADD `generated_at` integer;--> statement-breakpoint
ALTER TABLE `followups` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `followups` ADD `last_error` text;--> statement-breakpoint
CREATE INDEX `followups_generation_idx` ON `followups` (`generation_status`,`scheduled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `followups_case_kind_unique` ON `followups` (`case_id`,`kind`);
