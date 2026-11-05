-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agents: the named-agent registry (role / personal / system), T01's
-- schema landed as a real migration.
--
-- Org-wide read is discoverability per spec-agents.md: `agents_select` is an
-- org match ONLY, with no `kind`/DM-visibility branch. The DM-picker/mention
-- exclusion of `@base` is an application-layer filter added in T14, not an
-- RLS clause. `agents_insert`/`agents_update` are deferred to T24 (per-kind
-- write authority is its own task) — this migration creates no write policy,
-- so INSERT/UPDATE/DELETE are denied by default under FORCE RLS until T24
-- lands them.
--
-- Every statement here is RE-RUNNABLE (CREATE TABLE / INDEX with IF NOT
-- EXISTS, ENABLE/FORCE ROW LEVEL SECURITY and GRANT are naturally idempotent,
-- CREATE POLICY is dropped by name first), following the convention 0033
-- established for the same reason: a journal `when` raised above an
-- already-deployed highwater can cause this file to run a second time on a
-- database that applied it under an earlier draft.

DO $$ BEGIN
  CREATE TYPE kernel.agent_kind AS ENUM ('role', 'personal', 'system');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  kind kernel.agent_kind NOT NULL,
  handle text NOT NULL,
  display_name text NOT NULL,
  owner_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  scope_ceiling jsonb NOT NULL DEFAULT '[]'::jsonb,
  system_prompt text NOT NULL DEFAULT '',
  tool_allowlist text[],
  tool_denylist text[],
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_owner_user_id_personal_chk CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agents_org_handle_idx ON kernel.agents (org_id, handle);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agents_org_kind_idx ON kernel.agents (org_id, kind);
--> statement-breakpoint
ALTER TABLE kernel.agents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agents TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agents_select ON kernel.agents;
CREATE POLICY agents_select ON kernel.agents FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
