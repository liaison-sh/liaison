-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Product attributes: small facts an organisation keeps about each product it
-- sells, keyed by SKU, in one provider-neutral place.
--
--  - kernel.product_attributes: one row per (org, sku, key). Keys are free-form;
--    `short_code` (the short operator-facing code a product reads as in a cart
--    summary, "E2") is the first documented one. A store app reads the codes to
--    summarise an order; a shipping app reads them and writes its own codes into
--    them, so neither app has to know the other.
--  - Visible and writable only inside the caller's org (FORCE RLS).
--  - New read/write scopes kernel:products:read / kernel:products:write reach the
--    roles that already hold the matching contacts scope (the member and viewer
--    presets and the custom roles built like them), so an existing member's
--    agent can read the codes the day this ships. App and admin (`*`) roles are
--    left alone.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

CREATE TABLE IF NOT EXISTS kernel.product_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  sku text NOT NULL CHECK (sku <> '' AND length(sku) <= 255),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value text NOT NULL CHECK (length(value) <= 2000),
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS product_attributes_org_sku_key_idx
  ON kernel.product_attributes (org_id, sku, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_attributes_org_key_idx
  ON kernel.product_attributes (org_id, key);
--> statement-breakpoint

ALTER TABLE kernel.product_attributes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.product_attributes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.product_attributes TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS product_attributes_select ON kernel.product_attributes;
--> statement-breakpoint
CREATE POLICY product_attributes_select ON kernel.product_attributes FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS product_attributes_insert ON kernel.product_attributes;
--> statement-breakpoint
CREATE POLICY product_attributes_insert ON kernel.product_attributes FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS product_attributes_update ON kernel.product_attributes;
--> statement-breakpoint
CREATE POLICY product_attributes_update ON kernel.product_attributes FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid)
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS product_attributes_delete ON kernel.product_attributes;
--> statement-breakpoint
CREATE POLICY product_attributes_delete ON kernel.product_attributes FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint

-- Scope grants for existing roles: products:read beside contacts:read,
-- products:write beside contacts:write. App-owned roles ("<app>.<role>") and
-- roles holding `*` are skipped. Users of a role that gained a scope get their
-- permission_version bumped so their sessions pick it up.
WITH pairs(have, add) AS (
  VALUES ('kernel:contacts:read', 'kernel:products:read'),
         ('kernel:contacts:write', 'kernel:products:write')
),
eligible AS (
  SELECT r.id AS role_id, p.add AS scope
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
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
SET permission_version = u.permission_version + 1
WHERE u.id IN (
  SELECT ur.user_id FROM kernel.user_roles ur WHERE ur.role_id IN (SELECT role_id FROM granted)
);
