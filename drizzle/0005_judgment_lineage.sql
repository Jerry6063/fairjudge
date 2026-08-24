-- M3 wave B: the judgment version chain.
--
-- A `final` judgment is frozen (HARD RULE #6), so a re-hearing may not edit it;
-- it writes version + 1 and points back here. The pointer is a real column
-- rather than an inference from adjacent version numbers, because "v2 exists"
-- and "v2 replaced v1" are different statements and only the second one can
-- carry the disclosure the rule asks for.
--
-- Pure ADD COLUMN + CREATE INDEX: no table is rebuilt, no row moves, and the
-- self-referencing foreign key is nullable, so every existing judgment row
-- (there are none yet on the real case) reads back as version 1 with no
-- predecessor.
ALTER TABLE `judgments` ADD `supersedes_judgment_id` text REFERENCES judgments(id);--> statement-breakpoint
CREATE INDEX `judgments_supersedes_idx` ON `judgments` (`supersedes_judgment_id`);
