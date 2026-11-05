-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Home card order/collapse persistence (liaison-messaging-visibility Task 7).
--
-- One nullable jsonb column on the existing 1-row-per-user
-- kernel.user_preferences table -- no new table. Null = "use the default
-- card order, nothing collapsed" (forward-compatible: a client that has
-- never reordered/collapsed anything never wrote a row-value here).
--
-- Written ONLY via the dedicated `updateHomeCardLayout` service fn / the
-- `PUT /preferences/home-cards` route, never through the full-replace
-- `updatePreferences` path -- see the column comment in
-- db/schema/kernel/user-preferences.ts for why (the same "theme" trap this
-- codebase already documents on `updateTheme`).
ALTER TABLE kernel.user_preferences
  ADD COLUMN IF NOT EXISTS home_card_layout jsonb;
