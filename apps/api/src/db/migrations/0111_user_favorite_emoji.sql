-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.user_preferences.favorite_emoji: the reaction picker's favourites row.
--
-- The picker used to offer nine fixed emoji. Each user now pins their own
-- (up to 24, validated by PUT /user/preferences/favorite-emoji). NULL means
-- "never customised" and the client shows the nine defaults, so existing rows
-- need no backfill. An empty array is a real choice (every favourite unpinned).
--
-- Written ONLY by the targeted updateFavoriteEmoji, never by the full-replace
-- updatePreferences (the trap updateTheme documents). The CHECK keeps the
-- column an array whatever writes it. Every statement is re-runnable.

ALTER TABLE kernel.user_preferences ADD COLUMN IF NOT EXISTS favorite_emoji jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_preferences_favorite_emoji_array'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.user_preferences
      ADD CONSTRAINT user_preferences_favorite_emoji_array
      CHECK (favorite_emoji IS NULL OR jsonb_typeof(favorite_emoji) = 'array');
  END IF;
END $$;
