-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Guard the kernel.connected_accounts RLS policy ::uuid casts against an EMPTY
-- session GUC.
--
-- Every policy below casts `current_setting('app.current_org_id'|'app.current_user_id',
-- true)::uuid`. On an UNSET GUC current_setting(...) returns NULL and NULL::uuid is
-- NULL (a benign non-match); but on an EMPTY STRING it is ''::uuid, which THROWS
-- 22P02 `invalid input syntax for type uuid: ""` and ABORTS the whole query before
-- the policy can evaluate to "deny". withRlsContext coerces a non-uuid user id to the
-- nil uuid (safeUserId) but writes `app.current_org_id` RAW, so any code path that
-- opens an RLS transaction with an empty orgId leaks '' into this cast and 22P02s.
--
-- Observed live 2026-07-09: the tickets mailbox sync resolved its OAuth token through
-- the RLS-scoped connected_accounts read while its job context carried an empty org
-- GUC, so the read threw instead of returning zero rows -- and the org-owned
-- privileged fallback in connections/service.ts never ran. Support-mail ingestion
-- stalled silently.
--
-- Wrapping each cast in `nullif(current_setting(...), '')` makes an empty GUC resolve
-- to NULL (a safe non-match, identical to the unset case) instead of throwing. A valid
-- uuid GUC is unaffected: the policy logic is otherwise byte-for-byte the originals
-- from 0000_initial.sql. This is the defense-in-depth half; the sync itself now
-- resolves org-owned connections via the privileged (BYPASSRLS) path.

DROP POLICY IF EXISTS connected_accounts_select ON kernel.connected_accounts;
CREATE POLICY connected_accounts_select ON kernel.connected_accounts FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      (owner_type = 'user' AND owner_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );

DROP POLICY IF EXISTS connected_accounts_insert ON kernel.connected_accounts;
CREATE POLICY connected_accounts_insert ON kernel.connected_accounts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS connected_accounts_update ON kernel.connected_accounts;
CREATE POLICY connected_accounts_update ON kernel.connected_accounts FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      (owner_type = 'user' AND owner_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );

DROP POLICY IF EXISTS connected_accounts_delete ON kernel.connected_accounts;
CREATE POLICY connected_accounts_delete ON kernel.connected_accounts FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      (owner_type = 'user' AND owner_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );
