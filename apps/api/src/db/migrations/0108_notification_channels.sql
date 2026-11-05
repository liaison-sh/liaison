-- SPDX-License-Identifier: FSL-1.1-ALv2
-- S1/S8: the per-user notification grid (group x channel) and whether the user
-- set work hours explicitly. NULL means "all defaults": the default grid from
-- packages/shared, and no quiet time on push/desktop. The stored shape is
-- `{ "grid": { <group>: { <channel>: boolean } }, "workHoursExplicit": true }`
-- with only the cells that differ from the defaults.
--
-- Written ONLY through the targeted updates in modules/notifications/settings.ts,
-- never through the full-replace `updatePreferences` (same trap as
-- home_card_layout, 0038).
ALTER TABLE kernel.user_preferences
  ADD COLUMN IF NOT EXISTS notification_channels jsonb;
