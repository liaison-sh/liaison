-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Re-applies the seeds that did nothing when the migration login is not a
-- superuser.
--
-- The tables these seeds read and write force row-level security, and their
-- policies name the runtime roles only. A migration login that is neither a
-- superuser nor BYPASSRLS (a database owner, for instance) therefore reads no
-- row there: an INSERT ... SELECT inserts nothing, an UPDATE or DELETE
-- touches nothing, and the migration still succeeds. These ran that way:
--
--  - 0119: dropping the retired mail:sensitivity dimension grants;
--  - 0133 and 0134: mcp_manager:personal_connection:write and
--    mcp_manager:connection:read for the member roles of an org that has
--    mcp-manager (0135's narrowing is part of 0133's rule, so it is not
--    re-run);
--  - 0252: dropping the grant wildcards from agent replies' required scopes;
--  - 0254: kernel:products:read / kernel:products:write beside the matching
--    contacts scope.
--
-- Every statement runs as liaison_admin (BYPASSRLS), which every migration
-- login is a member of (0000 grants it to the login that runs it). A database
-- migrated by a superuser already has all of this, so each statement is a
-- no-op there:
--  - grants use ON CONFLICT DO NOTHING, and a scope an admin took away from a
--    role since (an audited role_scope.revoke) is not given back;
--  - the DELETE and the 0252 repair are re-runnable as written.
-- Users of a role that gained a scope get their permission_version bumped.

-- The UPDATE of kernel.messages takes row locks: fail the deploy cleanly behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint

-- 0119
DELETE FROM kernel.user_dimension_grants WHERE dimension_key = 'mail:sensitivity';
--> statement-breakpoint
DELETE FROM kernel.role_dimension_grants WHERE dimension_key = 'mail:sensitivity';
--> statement-breakpoint

-- 0254
WITH pairs(have, add) AS (
  VALUES ('kernel:contacts:read', 'kernel:products:read'),
         ('kernel:contacts:write', 'kernel:products:write')
),
eligible AS (
  SELECT r.id AS role_id, r.org_id, p.add AS scope
  FROM kernel.roles r
  JOIN pairs p ON EXISTS (
    SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = p.have
  )
  WHERE NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.role_id, e.scope
  FROM eligible e
  WHERE NOT EXISTS (
    SELECT 1 FROM kernel.audit_log l
    WHERE l.org_id = e.org_id
      AND l.entity_type = 'role_scope'
      AND l.action = 'role_scope.revoke'
      AND l.entity_id = e.role_id::text
      AND l.changes ->> 'scope' = e.scope
  )
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
--> statement-breakpoint

-- 0133
WITH eligible AS (
  SELECT r.id, r.org_id
  FROM kernel.roles r
  WHERE EXISTS (
      SELECT 1 FROM kernel.apps a WHERE a.org_id = r.org_id AND a.name = 'mcp-manager'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:threads:write', 'kernel:threads:*', 'kernel:threads', 'kernel:*', 'kernel')
    )
    AND EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id
        AND g.scope IN ('kernel:contacts:write', 'kernel:contacts:*', 'kernel:contacts', 'kernel:*', 'kernel')
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.audit_log l
      WHERE l.org_id = r.org_id
        AND l.entity_type = 'role_scope'
        AND l.action = 'role_scope.revoke'
        AND l.entity_id = r.id::text
        AND l.changes ->> 'scope' = 'mcp_manager:personal_connection:write'
    )
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.id, 'mcp_manager:personal_connection:write'
  FROM eligible e
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
--> statement-breakpoint

-- 0134
WITH eligible AS (
  SELECT r.id
  FROM kernel.roles r
  WHERE EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g
      WHERE g.role_id = r.id AND g.scope = 'mcp_manager:personal_connection:write'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.apps a
      WHERE a.org_id = r.org_id AND left(r.name, length(a.name) + 1) = a.name || '.'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.role_scope_grants g WHERE g.role_id = r.id AND g.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.audit_log l
      WHERE l.org_id = r.org_id
        AND l.entity_type = 'role_scope'
        AND l.action = 'role_scope.revoke'
        AND l.entity_id = r.id::text
        AND l.changes ->> 'scope' = 'mcp_manager:connection:read'
    )
),
granted AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), e.id, 'mcp_manager:connection:read'
  FROM eligible e
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
--> statement-breakpoint

-- 0252, as written there (its comment says why it is safe and re-runnable)
WITH wildcard_rows AS (
  SELECT m.id, m.org_id, m.author_type, m.metadata
  FROM kernel.messages m
  WHERE m.required_scopes IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM unnest(m.required_scopes) AS w(scope)
      WHERE w.scope = '*'
        OR COALESCE(array_position(string_to_array(w.scope, ':'), '*'),
                    cardinality(string_to_array(w.scope, ':')))
           < cardinality(string_to_array(w.scope, ':'))
    )
),
unsafe_orgs AS (
  SELECT DISTINCT r.org_id FROM wildcard_rows r
  WHERE r.author_type IS DISTINCT FROM 'agent'
    OR COALESCE(r.metadata, '{}'::jsonb) ? 'externalClientPost'
)
UPDATE kernel.messages m
SET required_scopes = ARRAY(
  SELECT s.scope FROM unnest(m.required_scopes) WITH ORDINALITY AS s(scope, n)
  WHERE NOT (
    s.scope = '*'
    OR COALESCE(array_position(string_to_array(s.scope, ':'), '*'),
                cardinality(string_to_array(s.scope, ':')))
       < cardinality(string_to_array(s.scope, ':'))
  )
  ORDER BY s.n
)
FROM wildcard_rows r
WHERE m.id = r.id
  AND m.author_type = 'agent'
  AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'externalClientPost')
  AND m.org_id NOT IN (SELECT org_id FROM unsafe_orgs)
  AND array_position(m.required_scopes, NULL) IS NULL
  AND EXISTS (
    SELECT 1 FROM unnest(m.required_scopes) AS k(scope)
    WHERE NOT (
      k.scope = '*'
      OR COALESCE(array_position(string_to_array(k.scope, ':'), '*'),
                  cardinality(string_to_array(k.scope, ':')))
         < cardinality(string_to_array(k.scope, ':'))
    )
  );
--> statement-breakpoint
RESET ROLE;
