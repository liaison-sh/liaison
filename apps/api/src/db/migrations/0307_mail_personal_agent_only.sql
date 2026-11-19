-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A person's own mailbox is for them and their personal agent only. A SHARED agent's turn (kind
-- role or system) marks its transactions with app.current_agent_shared = 'on' (db/rls.ts), and the
-- mail tables' generated policies (manifest personalScope.personalAgentOnly) hide user-owned
-- mailboxes from it. The drafts policies are migration-owned (rlsGovernedByMigration) and OR-ed
-- with the generated ones, so they say the same here: a draft on a user-owned account is reached
-- by its owner's own context only. Org mailboxes are unchanged. The org and user are read through
-- the rls_ctx readers (tag-verified, db/rls.ts), never the raw variables.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
DROP POLICY IF EXISTS drafts_select ON app_mail.drafts;
-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
CREATE POLICY drafts_select ON app_mail.drafts FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
        AND (
          (account.owner_type = 'user'
            AND account.owner_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
            AND COALESCE(current_setting('app.current_agent_shared', true), '') <> 'on')
          OR account.owner_type = 'org'
        )
    )
  );

-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
DROP POLICY IF EXISTS drafts_insert ON app_mail.drafts;
-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
CREATE POLICY drafts_insert ON app_mail.drafts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
        AND (
          (account.owner_type = 'user'
            AND account.owner_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
            AND COALESCE(current_setting('app.current_agent_shared', true), '') <> 'on')
          OR account.owner_type = 'org'
        )
    )
  );

-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
DROP POLICY IF EXISTS drafts_update ON app_mail.drafts;
-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
CREATE POLICY drafts_update ON app_mail.drafts FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
        AND (
          (account.owner_type = 'user'
            AND account.owner_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
            AND COALESCE(current_setting('app.current_agent_shared', true), '') <> 'on')
          OR account.owner_type = 'org'
        )
    )
  );

-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
DROP POLICY IF EXISTS drafts_delete ON app_mail.drafts;
-- expand-safe: the previous release never sets app.current_agent_shared, so it reads exactly as before.
CREATE POLICY drafts_delete ON app_mail.drafts FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
        AND (
          (account.owner_type = 'user'
            AND account.owner_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
            AND COALESCE(current_setting('app.current_agent_shared', true), '') <> 'on')
          OR account.owner_type = 'org'
        )
    )
  );
