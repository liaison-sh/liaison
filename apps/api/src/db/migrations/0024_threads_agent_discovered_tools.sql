-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Deferred-tool discovery persistence: SDK names of app tools the agent has
-- unlocked via tool_search in this thread, so follow-up turns keep them loaded
-- without re-searching. App tools are deferred by default (their schemas stay
-- out of provider requests until discovered).
ALTER TABLE "kernel"."threads"
  ADD COLUMN IF NOT EXISTS "agent_discovered_tools" jsonb NOT NULL DEFAULT '[]'::jsonb;
