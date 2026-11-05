-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.user_preferences.dictation_auto_clean: "Clean up dictation
-- automatically" (voice dictation, S11).
--
-- On (the default), a transcript goes through the clean-up model before it is
-- inserted; off, the raw transcript is inserted. The default needs no backfill:
-- every existing row reads true. Written ONLY by the targeted
-- updateDictationAutoClean (PUT /user/preferences/dictation), never by the
-- full-replace updatePreferences (the trap updateTheme documents). Re-runnable.

ALTER TABLE kernel.user_preferences
  ADD COLUMN IF NOT EXISTS dictation_auto_clean boolean NOT NULL DEFAULT true;
