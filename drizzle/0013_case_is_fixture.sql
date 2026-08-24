-- docs/05 §C / doc 04 §6.3: authored demonstration cases.
--
-- A fixture case is product content — a fully fictional case the app can open,
-- judge and share so that design work and the portfolio capture never touch a
-- real person's record. The flag exists so the UI can label the fiction on
-- every surface that names the case. It defaults to false and is never set on
-- the real case (CLAUDE.md, Verification rule).
ALTER TABLE `cases` ADD `is_fixture` integer DEFAULT false NOT NULL;