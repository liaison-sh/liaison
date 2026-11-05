-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.user_preferences.agent_mail_access: the "assistant may read my mail"
-- switch, carried between the account holder's devices.
--
-- The switch lived only in each browser's storage, so turning the assistant
-- off on the desktop left it on for the phone's plaintext responder. It is
-- now relayed through this column, and the server is only a relay: it cannot
-- turn the assistant ON for anyone. The record is
-- `{ "enabled": bool, "at": epoch ms, "mac"?: base64 }`, and a device applies
-- it only when it is newer than what that device holds and, for enabled=true,
-- only when `mac` verifies under the holder's mailbox key (an HMAC the server
-- never has the key for). A refusal (enabled=false) needs no proof: the worst
-- a forged one does is switch the assistant off. See the web module
-- mailbox/agent-mail-access.ts for the full rule.
--
-- NULL = never synced (every device keeps its own value, default on). Written
-- ONLY by the targeted updateAgentMailAccess (same trap as favorite_emoji).
-- The CHECK keeps the shape whatever writes it. Re-runnable.

ALTER TABLE kernel.user_preferences ADD COLUMN IF NOT EXISTS agent_mail_access jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_preferences_agent_mail_access_shape'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.user_preferences
      ADD CONSTRAINT user_preferences_agent_mail_access_shape
      CHECK (
        agent_mail_access IS NULL OR (
          jsonb_typeof(agent_mail_access) = 'object'
          AND jsonb_typeof(agent_mail_access -> 'enabled') = 'boolean'
          AND jsonb_typeof(agent_mail_access -> 'at') = 'number'
        )
      );
  END IF;
END $$;
