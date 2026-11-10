-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The kernel member tier reaches the orgs created before the data store and dashboards (0275).
--
-- 0275 added `kernel:data:read`, `kernel:data:write`, `kernel:dashboards:write` and
-- `kernel:dashboards:share` to the kernel `member` preset (KERNEL_MEMBER_SCOPES,
-- permissions/default-roles.ts), which only a NEW org is seeded with. An org created before kept
-- a `member` role without them, and the system-managed "Full Member" role carried app scopes
-- only, so nobody but an administrator could make a dashboard or use the agent's data tools.
--
-- Grants the four scopes, once, to:
--  - each org's kernel `member` preset (not system-managed) that holds none of them: one seeded
--    before 0275. A preset holding any of them was seeded after, or tuned by an admin; it is
--    left alone, so a scope an admin removed does not come back;
--  - each "Full Member" role, which now carries the whole kernel member tier
--    (`extendFullMemberRole` grants the rest at the org's next app registration).
-- Then, for every holder of a role that gained a scope: the personal agents' ceilings gain the
-- scopes their owner now holds (unless the ceiling already covers one, or an administrator's
-- `ceiling_restriction` does not cover it: `personalCeiling`, personal-agent.ts), and
-- permission_version moves so live sessions pick the grants up.
-- Re-runnable: a second run finds every scope granted and changes nothing.
WITH tier(scope) AS (
  VALUES
    ('kernel:data:read'),
    ('kernel:data:write'),
    ('kernel:dashboards:write'),
    ('kernel:dashboards:share')
),
eligible AS (
  SELECT r.id
    FROM kernel.roles r
   WHERE r.name = 'member'
     AND NOT r.system_managed
     AND NOT EXISTS (
       SELECT 1 FROM kernel.role_scope_grants g JOIN tier t ON t.scope = g.scope
        WHERE g.role_id = r.id
     )
  UNION
  SELECT r.id FROM kernel.roles r WHERE r.name = 'Full Member' AND r.system_managed
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.id, t.scope
    FROM eligible e CROSS JOIN tier t
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id, scope
),
holders AS (
  SELECT DISTINCT ur.user_id, ur.org_id, g.scope
    FROM kernel.user_roles ur
    JOIN granted g ON g.role_id = ur.role_id
),
additions AS (
  SELECT a.id, jsonb_agg(DISTINCT h.scope) AS scopes
    FROM kernel.agents a
    JOIN holders h ON h.user_id = a.owner_user_id AND h.org_id = a.org_id
   WHERE a.kind = 'personal'
     -- Not covered by the ceiling already (`*`, a parent, or a `:*` glob).
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(a.scope_ceiling) AS c(s)
        WHERE c.s = '*' OR c.s = h.scope OR left(h.scope, length(c.s) + 1) = c.s || ':'
           OR (right(c.s, 2) = ':*' AND left(h.scope, length(c.s) - 1) = left(c.s, length(c.s) - 1))
     )
     -- Within an administrator's narrowing, when there is one.
     AND (
       a.ceiling_restriction IS NULL
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(a.ceiling_restriction) AS c(s)
          WHERE c.s = '*' OR c.s = h.scope OR left(h.scope, length(c.s) + 1) = c.s || ':'
             OR (right(c.s, 2) = ':*' AND left(h.scope, length(c.s) - 1) = left(c.s, length(c.s) - 1))
       )
     )
   GROUP BY a.id
),
-- A data-modifying CTE runs to completion whether or not the outer statement reads it.
ceilings AS (
  UPDATE kernel.agents a
     SET scope_ceiling = a.scope_ceiling || ad.scopes,
         updated_at = now()
    FROM additions ad
   WHERE a.id = ad.id
  RETURNING a.id
)
UPDATE kernel.users u
   SET permission_version = u.permission_version + 1
 WHERE u.id IN (SELECT h.user_id FROM holders h);
