-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An agent's avatar colour is stored, not derived. The web used to hash the
-- agent id into one of the eight agent avatar gradients, so two agents of one
-- org could wear the same colour and nobody could change it. avatar_color is
-- the slot (0-7); every create path picks the colour the org uses least.
--
-- Backfill: per org, the agents get distinct colours in creation order (live
-- role and personal agents first, then the built-in agent, then archived
-- ones), wrapping around only past eight agents, so repeats spread evenly. Only NULLs are written, and the
-- slot is the agent's rank in its org, so a second run changes nothing.
--
-- Every statement is re-runnable.
ALTER TABLE kernel.agents ADD COLUMN IF NOT EXISTS avatar_color smallint;
--> statement-breakpoint
ALTER TABLE kernel.agents DROP CONSTRAINT IF EXISTS agents_avatar_color_range_chk;
--> statement-breakpoint
ALTER TABLE kernel.agents ADD CONSTRAINT agents_avatar_color_range_chk
  CHECK (avatar_color IS NULL OR (avatar_color BETWEEN 0 AND 7));
--> statement-breakpoint
UPDATE kernel.agents a
   SET avatar_color = ranked.slot
  FROM (
    SELECT id,
           ((ROW_NUMBER() OVER (
              PARTITION BY org_id
              ORDER BY (archived_at IS NOT NULL), (kind = 'system'), created_at, id
            ) - 1) % 8)::smallint AS slot
      FROM kernel.agents
  ) ranked
 WHERE a.id = ranked.id
   AND a.avatar_color IS NULL;
