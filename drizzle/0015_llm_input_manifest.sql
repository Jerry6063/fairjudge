ALTER TABLE `llm_calls` ADD `input_manifest` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `input_manifest_sha256` text;--> statement-breakpoint
CREATE INDEX `llm_calls_manifest_idx` ON `llm_calls` (`input_manifest_sha256`);