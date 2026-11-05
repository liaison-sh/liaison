-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The @base system agent carries the common agent base, not an empty ceiling.
--
-- Bootstrap and migrate-agents both created @base with `scope_ceiling = []`
-- (the column default). An empty ceiling intersects every turn to nothing, so
-- @base could not search tools (`kernel:threads:read`), ask or hand off to
-- another agent (`kernel:threads:write`), or read the knowledge collections a
-- roster gives it (`knowledge:documents:read`), while its own prompt told it to
-- hand off. New rows now get COMMON_AGENT_BASE_SCOPES
-- (modules/agent/directory/common-base-scopes.ts); this repairs the rows
-- already out there.
--
-- Additive: the common base first, then whatever the row already held, in its
-- order, deduplicated. A ceiling an admin widened keeps every extra scope. Only
-- `kind = 'system'` rows missing at least one base scope are written, so a
-- second run touches nothing. The list is a snapshot of the constant at the
-- time of writing (0101-base-agent-common-ceiling.test.ts pins the two equal).
UPDATE kernel.agents a
  SET scope_ceiling = (
        SELECT jsonb_agg(s ORDER BY ord)
        FROM (
          SELECT s, min(ord) AS ord
          FROM (
            SELECT base.s, base.ord
              FROM jsonb_array_elements_text(
                '["kernel:skills:read","kernel:skills:write","kernel:threads:read","kernel:threads:write","kernel:agent:memory","kernel:contacts:read","kernel:files:read","kernel:files:analyze","knowledge:documents:read","knowledge:documents:create","projects:projects:read","projects:tasks:read","projects:tasks:write"]'::jsonb
              ) WITH ORDINALITY AS base(s, ord)
            UNION ALL
            SELECT own.s, 1000 + own.ord
              FROM jsonb_array_elements_text(a.scope_ceiling) WITH ORDINALITY AS own(s, ord)
          ) merged
          GROUP BY s
        ) deduped
      ),
      updated_at = now()
  WHERE a.kind = 'system'
    AND NOT (a.scope_ceiling @> '["kernel:skills:read","kernel:skills:write","kernel:threads:read","kernel:threads:write","kernel:agent:memory","kernel:contacts:read","kernel:files:read","kernel:files:analyze","knowledge:documents:read","knowledge:documents:create","projects:projects:read","projects:tasks:read","projects:tasks:write"]'::jsonb);
