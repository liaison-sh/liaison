-- SPDX-License-Identifier: FSL-1.1-ALv2
CREATE FUNCTION kernel.tidy_threads() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  ALTER TABLE kernel.threads DROP COLUMN legacy_flag;
END
$fn$;
--> statement-breakpoint
SELECT kernel.tidy_threads();
