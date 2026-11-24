-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The time a billing claim counted.
--
-- A card bills the minutes it was made from. Time entered on the same task afterwards, whatever day
-- it is dated, belongs to no card: it is told from the minutes the claim counted, and goes on the
-- next card. Null on an older claim, and on a claim whose line is not billed by its time.
--
-- Forward only, no backfill: an existing claim reads null.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads this column, and null passes its check
ALTER TABLE app_projects.billing_claims
  ADD COLUMN counted_minutes integer
    CONSTRAINT billing_claims_counted_minutes_not_negative CHECK (counted_minutes >= 0);
