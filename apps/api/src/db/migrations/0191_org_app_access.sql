-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who may use an app in a workspace (S18, S20, A3, A4).
--
-- `kernel.apps.access_mode`: 'everyone' (default, today's behaviour) or
-- 'restricted'. For a restricted app, `kernel.org_app_access` lists the roles
-- and people who keep it; everyone else loses the app's scopes at effective-
-- scope resolution (modules/permissions/permissions.ts). Org admins (`*`) are
-- exempt. Rows are org data: FORCE RLS by the request's org, like
-- `apps_org_rls`; the privileged logins read and write them for the kernel's
-- app-state cache (modules/apps/org-apps.ts). Re-runnable.
ALTER TABLE kernel.apps
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'everyone';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apps_access_mode_check'
                  AND conrelid = 'kernel.apps'::regclass) THEN
    ALTER TABLE kernel.apps ADD CONSTRAINT apps_access_mode_check
      CHECK (access_mode IN ('everyone', 'restricted'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.org_app_access (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL CHECK (char_length(app) BETWEEN 1 AND 128),
  principal_type text NOT NULL CHECK (principal_type IN ('role', 'user')),
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app, principal_type, principal_id)
);
--> statement-breakpoint
ALTER TABLE kernel.org_app_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_app_access FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_app_access_org_rls ON kernel.org_app_access;
--> statement-breakpoint
CREATE POLICY org_app_access_org_rls ON kernel.org_app_access
  FOR ALL TO liaison_rls
  USING (org_id = rls_ctx.org_id()::uuid)
  WITH CHECK (org_id = rls_ctx.org_id()::uuid);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_app_access TO liaison_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_app_access TO liaison_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_app_access TO liaison_app;
  END IF;
END
$$;
