CREATE TABLE `adverse_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`evidence_id` text,
	`ack_status` text DEFAULT 'pending' NOT NULL,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `adverse_facts_case_idx` ON `adverse_facts` (`case_id`);--> statement-breakpoint
CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`original_judgment_id` text NOT NULL,
	`new_judgment_id` text,
	`reason` text,
	`new_evidence` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`original_judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`new_judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `appeals_case_idx` ON `appeals` (`case_id`);--> statement-breakpoint
CREATE TABLE `case_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text,
	`pseudonym` text NOT NULL,
	`participation_state` text DEFAULT 'pending' NOT NULL,
	`invite_token_hash` text,
	`is_submitter` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `case_participants_case_idx` ON `case_participants` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_participants_case_role_uq` ON `case_participants` (`case_id`,`role`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`stage` text DEFAULT 'intake' NOT NULL,
	`output_level` text,
	`output_level_locked_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`onesidedness_disclaimer` text,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clarification_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`round_number` integer NOT NULL,
	`questions` text,
	`answers` text,
	`saturated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `clarification_rounds_case_idx` ON `clarification_rounds` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clarification_rounds_case_round_uq` ON `clarification_rounds` (`case_id`,`round_number`);--> statement-breakpoint
CREATE TABLE `egress_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`llm_call_id` text,
	`case_id` text,
	`target` text NOT NULL,
	`model` text,
	`payload_sha256` text NOT NULL,
	`payload_bytes` integer,
	`prev_hash` text,
	`entry_hash` text,
	`expiry_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`llm_call_id`) REFERENCES `llm_calls`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `egress_ledger_case_idx` ON `egress_ledger` (`case_id`);--> statement-breakpoint
CREATE INDEX `egress_ledger_expiry_idx` ON `egress_ledger` (`expiry_at`);--> statement-breakpoint
CREATE INDEX `egress_ledger_call_idx` ON `egress_ledger` (`llm_call_id`);--> statement-breakpoint
CREATE TABLE `event_evidence` (
	`event_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `evidence_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`label` text,
	`title` text,
	`description` text,
	`occurred_at` integer,
	`occurred_start` integer,
	`occurred_end` integer,
	`occurred_precision` text DEFAULT 'unknown' NOT NULL,
	`order_key` text DEFAULT 'a0' NOT NULL,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_case_idx` ON `events` (`case_id`);--> statement-breakpoint
CREATE INDEX `events_order_idx` ON `events` (`case_id`,`order_key`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`file_id` text,
	`source_type` text NOT NULL,
	`grade_final` text NOT NULL,
	`grade_rationale` text,
	`derived_from_evidence_id` text,
	`content_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`derived_from_evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_case_idx` ON `evidence` (`case_id`);--> statement-breakpoint
CREATE INDEX `evidence_derived_from_idx` ON `evidence` (`derived_from_evidence_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`kind` text NOT NULL,
	`original_filename` text,
	`storage_path` text,
	`sha256` text NOT NULL,
	`byte_size` integer,
	`mime_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `files_case_idx` ON `files` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_case_sha_uq` ON `files` (`case_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`kind` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`completed_at` integer,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`response` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `followups_case_idx` ON `followups` (`case_id`);--> statement-breakpoint
CREATE INDEX `followups_scheduled_idx` ON `followups` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `improvement_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`judgment_id` text,
	`content` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `improvement_contracts_case_idx` ON `improvement_contracts` (`case_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`category` text NOT NULL,
	`order_key` text,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issues_case_idx` ON `issues` (`case_id`);--> statement-breakpoint
CREATE INDEX `issues_category_idx` ON `issues` (`case_id`,`category`);--> statement-breakpoint
CREATE TABLE `judgment_renditions` (
	`id` text PRIMARY KEY NOT NULL,
	`judgment_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text,
	`shareable` integer DEFAULT false NOT NULL,
	`share_token_hash` text,
	`share_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgment_renditions_judgment_idx` ON `judgment_renditions` (`judgment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `judgment_renditions_judgment_kind_uq` ON `judgment_renditions` (`judgment_id`,`kind`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`output_level` text NOT NULL,
	`content` text,
	`surface_layer` text,
	`model` text NOT NULL,
	`effort` text,
	`prompt_version` text,
	`fallback_used` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`finalized_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgments_case_idx` ON `judgments` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `judgments_case_version_uq` ON `judgments` (`case_id`,`version`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text,
	`stage` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`prompt_version` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cost_usd` real,
	`latency_ms` integer,
	`stop_reason` text,
	`fallback_used` integer DEFAULT false NOT NULL,
	`fallback_message` text,
	`request_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_calls_case_idx` ON `llm_calls` (`case_id`);--> statement-breakpoint
CREATE INDEX `llm_calls_created_idx` ON `llm_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `repair_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`judgment_id` text,
	`content` text,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `repair_scripts_case_idx` ON `repair_scripts` (`case_id`);--> statement-breakpoint
CREATE TABLE `safety_screens` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`screen_type` text NOT NULL,
	`red_flags` text,
	`outcome` text NOT NULL,
	`referral_shown` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `safety_screens_case_idx` ON `safety_screens` (`case_id`);--> statement-breakpoint
CREATE TABLE `steelman_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `steelman_versions_case_idx` ON `steelman_versions` (`case_id`);--> statement-breakpoint
CREATE TABLE `utterances` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`evidence_id` text,
	`speaker_participant_id` text,
	`speaker_label` text,
	`is_retold` integer DEFAULT false NOT NULL,
	`tone` text,
	`order_key` text,
	`ai_draft` text,
	`human_final` text,
	`confirm_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`speaker_participant_id`) REFERENCES `case_participants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `utterances_case_idx` ON `utterances` (`case_id`);--> statement-breakpoint
CREATE INDEX `utterances_evidence_idx` ON `utterances` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `utterances_confirm_idx` ON `utterances` (`confirm_status`);