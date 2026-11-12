-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.user_preferences.hidden_sidebar_apps: the rail entries a person hid
-- from their own sidebar (desktop and tablet rail, phone Work list), as an
-- array of activity-bar entry ids (`sessions`, `dashboards`, an app's name).
--
-- NULL means nothing hidden, so existing rows need no backfill. Hiding is a
-- display preference only: it changes no scope, role or RLS rule. Written ONLY
-- by the targeted updateHiddenSidebarApps, never by the full-replace
-- updatePreferences (the trap updateTheme documents). The previous release
-- never reads the column. Every statement is re-runnable.

SET LOCAL lock_timeout = '5s';

-- expand-safe: a new nullable column; its check covers only the new column, which every row meets (NULL).
ALTER TABLE kernel.user_preferences
  ADD COLUMN IF NOT EXISTS hidden_sidebar_apps jsonb
    CONSTRAINT user_preferences_hidden_sidebar_apps_array
    CHECK (hidden_sidebar_apps IS NULL OR jsonb_typeof(hidden_sidebar_apps) = 'array');
