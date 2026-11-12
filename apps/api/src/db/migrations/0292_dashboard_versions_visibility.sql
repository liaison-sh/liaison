-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.dashboard_versions.visibility: whether the dashboard was personal or shared when the
-- version was saved. Versions saved while it was personal (its owner's drafts) stay its
-- owner's once it is shared: the service hides them from everyone else. NULL = saved before
-- this column (shown, as before). The previous release never reads it and inserts without it.
--
-- Every statement re-runnable.

SET LOCAL lock_timeout = '5s';

-- expand-safe: a new nullable column; the previous release's inserts leave it NULL.
ALTER TABLE kernel.dashboard_versions
  ADD COLUMN IF NOT EXISTS visibility text
    CONSTRAINT dashboard_versions_visibility_check CHECK (visibility IN ('personal', 'org'));
