-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Every member may export their own data (2026-11-07).
--
-- `kernel:data_subject:export:self` joins the kernel's every-member scopes (KERNEL_EVERY_MEMBER_SCOPES,
-- every-member-scopes.ts): a member exports what the organization holds about them as a person with
-- `data_subject_export`. `kernel.every_member_scope_covers` carries the same list for the readers of
-- the grant tables (0261), so it is replaced with the new list. Nothing else changes. Re-runnable.
-- expand-safe: CREATE OR REPLACE of a STABLE function with the same signature; the previous release
-- reads one scope fewer from it and asks for that scope nowhere.
CREATE OR REPLACE FUNCTION kernel.every_member_scope_covers(p_org uuid, p_user uuid, p_required text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM kernel.users u
      LEFT JOIN kernel.apps a ON a.org_id = u.org_id AND a.status::text <> 'removed'
      CROSS JOIN LATERAL unnest(
        ARRAY['kernel:bug_reports:file', 'kernel:data_subject:export:self']::text[] || COALESCE(a.every_member_scopes, '{}'::text[])
      ) AS m(scope)
     WHERE u.id = p_user
       AND u.org_id = p_org
       AND u.status = 'active'
       AND NOT kernel.app_access_denied(p_org, p_user, split_part(m.scope, ':', 1))
       AND (
         m.scope = '*'
         OR m.scope = p_required
         OR left(p_required, length(m.scope) + 1) = m.scope || ':'
         OR (
           right(m.scope, 2) = ':*'
           AND strpos(left(m.scope, length(m.scope) - 1), '*') = 0
           AND left(p_required, length(m.scope) - 1) = left(m.scope, length(m.scope) - 1)
         )
       )
  )
$fn$;
