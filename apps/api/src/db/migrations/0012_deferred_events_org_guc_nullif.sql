-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Harden app_invoicing.deferred_events RLS against an EMPTY (not NULL)
-- `app.current_org_id` GUC.
--
-- Root cause: the invoicing `deferred-retry` cron (jobs.ts) can reach its
-- handler with no RLS context (a missing/empty `orgId` on the persisted
-- BullMQ scheduler payload — see the sibling jobs.ts fix making per-org
-- scheduler ids). With no context, `current_setting('app.current_org_id',
-- true)` returns '' (empty string), not NULL. The generated policy cast
-- `''::uuid` is a HARD Postgres error ("invalid input syntax for type
-- uuid"), not a 0-row filter — so the job throws instead of just seeing no
-- rows, exhausts its BullMQ retries, and the watchdog fires a [CRITICAL]
-- every 5 minutes.
--
-- `deferred_events`'s RLS policies are runtime-generated per org by
-- `generateRlsPolicySql` (modules/permissions/rls-generator.ts) at app
-- registration, not migration-tracked DDL — the generator itself is fixed
-- to emit `NULLIF(current_setting(...), '')::uuid` everywhere (self-heals
-- every app table, this one included, on the next registration/reconcile
-- pass for every org). This migration re-hardens the policies already
-- persisted for orgs that installed invoicing BEFORE that generator fix
-- shipped, so the crash stops immediately without waiting on a
-- registration pass. It reproduces the generator's exact current output
-- (scope-entity "internal", no dimensions) with only the org-condition
-- guarded — a no-op if invoicing was never installed (schema/table absent).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'app_invoicing' AND table_name = 'deferred_events'
  ) THEN
    DROP POLICY IF EXISTS "deferred_events_rls_select" ON app_invoicing.deferred_events;
    DROP POLICY IF EXISTS "deferred_events_rls_insert" ON app_invoicing.deferred_events;
    DROP POLICY IF EXISTS "deferred_events_rls_update" ON app_invoicing.deferred_events;
    DROP POLICY IF EXISTS "deferred_events_rls_delete" ON app_invoicing.deferred_events;

    CREATE POLICY "deferred_events_rls_select" ON app_invoicing.deferred_events
      FOR SELECT
      TO liaison_rls
      USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
          current_setting('app.current_scopes', true) = '*'
          OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(
              current_setting('app.current_scopes', true), ','
            )) AS g
            WHERE g = '*'
              OR g = 'invoicing:internal'
              OR g = 'invoicing:internal:write'
              OR g = 'invoicing:internal:read'
              OR g = 'invoicing:*'
              OR g = 'invoicing'
              OR starts_with('invoicing:internal', g || ':')
          )
        )
      );

    CREATE POLICY "deferred_events_rls_insert" ON app_invoicing.deferred_events
      FOR INSERT
      TO liaison_rls
      WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
          current_setting('app.current_scopes', true) = '*'
          OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(
              current_setting('app.current_scopes', true), ','
            )) AS g
            WHERE g = '*'
              OR g = 'invoicing:internal'
              OR g = 'invoicing:internal:write'
              OR g = 'invoicing:*'
              OR g = 'invoicing'
              OR starts_with('invoicing:internal', g || ':')
          )
        )
      );

    CREATE POLICY "deferred_events_rls_update" ON app_invoicing.deferred_events
      FOR UPDATE
      TO liaison_rls
      USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
          current_setting('app.current_scopes', true) = '*'
          OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(
              current_setting('app.current_scopes', true), ','
            )) AS g
            WHERE g = '*'
              OR g = 'invoicing:internal'
              OR g = 'invoicing:internal:write'
              OR g = 'invoicing:*'
              OR g = 'invoicing'
              OR starts_with('invoicing:internal', g || ':')
          )
        )
      )
      WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
          current_setting('app.current_scopes', true) = '*'
          OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(
              current_setting('app.current_scopes', true), ','
            )) AS g
            WHERE g = '*'
              OR g = 'invoicing:internal'
              OR g = 'invoicing:internal:write'
              OR g = 'invoicing:*'
              OR g = 'invoicing'
              OR starts_with('invoicing:internal', g || ':')
          )
        )
      );

    CREATE POLICY "deferred_events_rls_delete" ON app_invoicing.deferred_events
      FOR DELETE
      TO liaison_rls
      USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
          current_setting('app.current_scopes', true) = '*'
          OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(
              current_setting('app.current_scopes', true), ','
            )) AS g
            WHERE g = '*'
              OR g = 'invoicing:internal'
              OR g = 'invoicing:internal:write'
              OR g = 'invoicing:*'
              OR g = 'invoicing'
              OR starts_with('invoicing:internal', g || ':')
          )
        )
      );
  END IF;
END $$;
