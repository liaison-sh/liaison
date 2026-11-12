-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.dashboard_viewer_states also remembers the dashboard filter values one person last
-- chose (`filters`: {filterId: [values]}), beside the time range. A person who picks only
-- filters has no remembered range: time_range and compare become nullable (NULL = the
-- dashboard's default). The previous release reads a NULL range as "no remembered range"
-- (its parse refuses it and falls back to the default), and never reads `filters`.
--
-- Every statement re-runnable.

SET LOCAL lock_timeout = '5s';

-- expand-safe: a nullable relax; the previous release treats a NULL range as no saved range.
ALTER TABLE kernel.dashboard_viewer_states ALTER COLUMN time_range DROP NOT NULL;
--> statement-breakpoint
-- expand-safe: as above, for the comparison.
ALTER TABLE kernel.dashboard_viewer_states ALTER COLUMN compare DROP NOT NULL;
--> statement-breakpoint
-- expand-safe: the check covers only the new column, whose default meets it; the previous release never writes it.
ALTER TABLE kernel.dashboard_viewer_states
  ADD COLUMN IF NOT EXISTS filters jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT dashboard_viewer_states_filters_check
    CHECK (jsonb_typeof(filters) = 'object' AND octet_length(filters::text) <= 16384);
