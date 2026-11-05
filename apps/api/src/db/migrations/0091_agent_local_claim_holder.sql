-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_local_claims.holder_key (A32, P6b-FX11): WHICH MACHINE holds it.
--
-- 0090 recorded the user a claim belongs to and nothing else, so a second
-- window of the same user (or any other member of the room) could push the
-- lease forward and post as the agent on a session it does not run. A claim
-- belongs to its holder: the user AND the window that registered it. The
-- window names itself with an opaque key it mints once, and heartbeat, reply
-- and release are honoured for that key alone.
--
-- A takeover is still possible and is now EXPLICIT (`takeOver: true` on the
-- register call), so a second machine never silently inherits a conversation
-- somebody else's session is answering, and the swap is audited.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.agent_local_claims
  ADD COLUMN IF NOT EXISTS holder_key text NOT NULL DEFAULT '';
--> statement-breakpoint

-- The default exists for rows written before this migration; a claim taken
-- from here on always names its holder, and a lease lapses in a minute, so the
-- empty string is a transient state rather than a shape the routes accept.
ALTER TABLE kernel.agent_local_claims ALTER COLUMN holder_key DROP DEFAULT;
