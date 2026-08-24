-- M4 ①: the counterparty-addressed shareable rendition.
--
-- The shareable copy stops being a filtered projection of the client-addressed
-- narrative and becomes a second narrative, generated from the same frozen fact
-- layer and written to the other party. It therefore needs a surface layer of
-- its own, plus its own provenance: a rendition is a derived artifact with its
-- own lifecycle, so regenerating one bumps `revision` here and leaves the frozen
-- judgment row untouched (HARD RULE #6).
--
-- Additive only — seven ADD COLUMNs, no rebuild, nothing existing rewritten.
-- Rows written before this migration keep `surface_layer` NULL, which is exactly
-- the state "no counterparty narrative has been generated yet" and is what the
-- render path refuses to share.
ALTER TABLE `judgment_renditions` ADD `surface_layer` text;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `model` text;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `prompt_version` text;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `fallback_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `judgment_renditions` ADD `generated_at` integer;