-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Needed-template rules: which document templates a record needs, as org data
-- (modules/documents/rules.ts is the matcher).
--
--  - kernel.document_template_rules: one row per rule. `record_type`
--    ("<app>:<entity>") names the records it applies to. `when` holds up to
--    three conditions, each a non-empty list: `sku`, `countryIso2`, `carrier`
--    (AND across them, any-of within one); the API refuses any other key, and
--    the matcher ignores one found in data. An empty `when` never matches.
--    `template_ids` are the kernel.document_templates the record then needs (no
--    FK on an array: a template that is gone, disabled or archived is dropped
--    when the rule is matched).
--  - Visible and writable only inside the caller's org (FORCE RLS). Who may
--    change a rule is the API's check (kernel:org:admin).
--
-- A new table, every statement re-runnable, following the 0033/0045/0082
-- convention.

CREATE TABLE IF NOT EXISTS kernel.document_template_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  record_type text NOT NULL
    CONSTRAINT document_template_rules_record_type_check
    CHECK (length(record_type) <= 200 AND record_type ~ '^[^:]+:[^:]+$'),
  name text NOT NULL CHECK (name <> '' AND length(name) <= 200),
  "when" jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  note text CHECK (note IS NULL OR length(note) <= 2000),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_template_rules_when_check
    CHECK (jsonb_typeof("when") = 'object' AND octet_length("when"::text) <= 65536),
  CONSTRAINT document_template_rules_template_ids_check
    CHECK (cardinality(template_ids) <= 50)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_template_rules_org_record_type_idx
  ON kernel.document_template_rules (org_id, record_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_template_rules_created_by_fk_idx
  ON kernel.document_template_rules (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_template_rules_updated_by_fk_idx
  ON kernel.document_template_rules (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

ALTER TABLE kernel.document_template_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.document_template_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.document_template_rules TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS document_template_rules_select ON kernel.document_template_rules;
--> statement-breakpoint
CREATE POLICY document_template_rules_select ON kernel.document_template_rules FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_template_rules_insert ON kernel.document_template_rules;
--> statement-breakpoint
CREATE POLICY document_template_rules_insert ON kernel.document_template_rules FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_template_rules_update ON kernel.document_template_rules;
--> statement-breakpoint
CREATE POLICY document_template_rules_update ON kernel.document_template_rules FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid)
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_template_rules_delete ON kernel.document_template_rules;
--> statement-breakpoint
CREATE POLICY document_template_rules_delete ON kernel.document_template_rules FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
