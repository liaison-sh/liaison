-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine's human name (routines.title), shown wherever the routine is listed or opened
-- ("Assign on status · Phone"). `name` stays the routine's stable kebab-case identifier
-- (tools, tests and the template link use it); NULL title = show `name`.
-- Additive and re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS title text;
--> statement-breakpoint
-- expand-safe: a new check on a new column the previous release never writes.
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_title_len_chk;
--> statement-breakpoint
-- expand-safe: a new check on a new column the previous release never writes.
ALTER TABLE kernel.routines ADD CONSTRAINT routines_title_len_chk CHECK (
  title IS NULL OR char_length(title) BETWEEN 1 AND 120
);
