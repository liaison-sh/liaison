-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Routine token budget and hard limit (S17, A34).
--
--  - token_budget: a soft budget. The runner tells the agent, in the tick
--    prompt, roughly how many tokens it has for the job.
--  - hard_token_limit: the run is stopped once its cumulative tokens (input,
--    cached included, plus output, summed over the run and every agents_ask
--    sub-run it starts) reach it.
-- Both nullable: NULL means no budget / no limit, which is every routine today.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS token_budget integer;
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS hard_token_limit integer;
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_token_budget_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_token_budget_chk CHECK (token_budget IS NULL OR token_budget > 0);
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_hard_token_limit_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_hard_token_limit_chk CHECK (hard_token_limit IS NULL OR hard_token_limit > 0);
