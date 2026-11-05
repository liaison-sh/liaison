-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.sessions.scope_ceiling: the most a session's access tokens may carry.
--
-- A device-flow session (a CLI or another headless client) is minted with the
-- scopes its flow request declared, intersected with the approver's effective
-- permissions. The ceiling used to live only in that first access token: the
-- refresh path reloaded the user's FULL permissions, so a restricted token
-- silently widened to full rights at its first refresh (within 15 minutes).
--
-- The ceiling now lives on the session row and every refresh intersects the
-- freshly loaded permissions with it (auth.ts applyScopeCeiling), and the
-- rotated session inherits it. NULL means "no ceiling": every browser, OAuth,
-- magic-link and password session, and every session that existed before this
-- migration, so their behaviour is unchanged and no backfill is needed. An
-- empty array is a real ceiling (a token with no scopes). Re-runnable.

ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS scope_ceiling text[];
