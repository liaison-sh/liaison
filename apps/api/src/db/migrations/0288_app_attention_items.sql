-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.app_attention_items: the attention items an app's provider lists for
-- one person, stored (modules/apps/attention-store.ts). The platform runs an
-- app's attention provider after the app was woken (a tool, an event, a job, a
-- webhook) and on the attention minute tick, as each person, and stores what
-- it listed here; the attention feed reads this table and runs no app code.
-- One row per (org, app, person): `items` is the provider's whole list,
-- replaced on each run, so an item the provider no longer lists is cleared.
--
-- Per-person data: FORCE RLS, a person reads their own rows. Written only
-- through the privileged connection, so liaison_rls gets no write policy.
--
-- Additive, every statement re-runnable: the previous release never reads or
-- writes the table.

CREATE TABLE IF NOT EXISTS kernel.app_attention_items (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  error jsonb NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_attention_items_user_idx ON kernel.app_attention_items (user_id);
--> statement-breakpoint
ALTER TABLE kernel.app_attention_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_attention_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.app_attention_items TO liaison_rls;
--> statement-breakpoint
-- Default privileges hand liaison_rls write grants on a new table; it writes
-- nothing here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON kernel.app_attention_items FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_attention_items TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS app_attention_items_select ON kernel.app_attention_items;
--> statement-breakpoint
CREATE POLICY app_attention_items_select ON kernel.app_attention_items FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
  );
