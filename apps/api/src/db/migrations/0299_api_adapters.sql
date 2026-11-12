-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.api_adapters / kernel.api_adapter_versions: the adapter documents of
-- the platform-held HTTP API connections (modules/apps/connections/api/), and
-- the kept previous documents. Keyed by (org, app, connection, identifier):
-- any app that declares a connection with an `api` block has its own, held by
-- the platform rather than in one app's tables. Privileged pool only (RLS
-- forced, no policy): every read and write goes through the platform's store.
--
-- The rows an existing install kept in the declaring app's own tables are
-- copied by the platform at boot (moved-apps.ts, step `api-adapters-to-platform`),
-- which re-runs every boot and never deletes them: the previous release, still
-- running during a deploy, keeps reading and writing its tables.
--
-- New tables, every statement re-runnable: the previous release never reads them.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.api_adapters (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app_name text NOT NULL,
  connection_name text NOT NULL,
  identifier text NOT NULL,
  adapter jsonb NOT NULL,
  adapter_version text NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_adapters_connection_uq UNIQUE (org_id, app_name, connection_name, identifier)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.api_adapter_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app_name text NOT NULL,
  connection_name text NOT NULL,
  identifier text NOT NULL,
  adapter jsonb NOT NULL,
  adapter_version text NOT NULL,
  saved_by uuid,
  saved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_adapter_versions_connection_idx
  ON kernel.api_adapter_versions (org_id, app_name, connection_name, identifier);
--> statement-breakpoint
ALTER TABLE kernel.api_adapters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.api_adapters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.api_adapter_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.api_adapter_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.api_adapters FROM liaison_rls;
--> statement-breakpoint
REVOKE ALL ON kernel.api_adapter_versions FROM liaison_rls;
