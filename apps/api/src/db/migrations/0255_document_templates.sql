-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Document templates: an organisation's own templates for the documents it
-- prints from a record (a customs declaration, a certificate, a thank-you
-- letter).
--
--  - kernel.document_templates: one row per template. `kind` is `pdf_form` (an
--    uploaded AcroForm PDF, kept sanitized as a kernel file parented to the row,
--    `file_id`) or `rich_text` (blocks of text with field placeholders, in
--    `body`). `record_type` ("<app>:<entity>") names the records it prints from.
--    `fields` is what the template offers (a PDF form's fields, read at upload),
--    `mapping` says where each field's value comes from.
--  - `file_id` is SET NULL when its file goes, so no CHECK requires it: a
--    CHECK the cascade breaks would stop the org purge (see 0253).
--  - `body` belongs to rich_text only, bounded in size here as a backstop (the
--    API refuses far smaller bodies).
--  - Visible and writable only inside the caller's org (FORCE RLS). Who may
--    change a template is the API's check (kernel:org:admin).
--
-- A new table, every statement re-runnable, following the 0033/0045/0082
-- convention.

CREATE TABLE IF NOT EXISTS kernel.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name <> '' AND length(name) <= 200),
  kind text NOT NULL
    CONSTRAINT document_templates_kind_check CHECK (kind IN ('pdf_form', 'rich_text')),
  record_type text
    CONSTRAINT document_templates_record_type_check
    CHECK (record_type IS NULL OR (length(record_type) <= 200 AND record_type ~ '^[^:]+:[^:]+$')),
  file_id uuid REFERENCES kernel.files(id) ON DELETE SET NULL,
  body jsonb,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT document_templates_body_check
    CHECK ((kind = 'rich_text') = (body IS NOT NULL)
           AND (body IS NULL OR (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 1048576))),
  CONSTRAINT document_templates_rich_text_file_check CHECK (kind = 'pdf_form' OR file_id IS NULL),
  CONSTRAINT document_templates_fields_check CHECK (jsonb_typeof(fields) = 'array'),
  CONSTRAINT document_templates_mapping_check CHECK (jsonb_typeof(mapping) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_templates_org_record_type_idx
  ON kernel.document_templates (org_id, record_type) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_templates_file_fk_idx
  ON kernel.document_templates (file_id) WHERE file_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_templates_created_by_fk_idx
  ON kernel.document_templates (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_templates_updated_by_fk_idx
  ON kernel.document_templates (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

ALTER TABLE kernel.document_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.document_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.document_templates TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS document_templates_select ON kernel.document_templates;
--> statement-breakpoint
CREATE POLICY document_templates_select ON kernel.document_templates FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_templates_insert ON kernel.document_templates;
--> statement-breakpoint
CREATE POLICY document_templates_insert ON kernel.document_templates FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_templates_update ON kernel.document_templates;
--> statement-breakpoint
CREATE POLICY document_templates_update ON kernel.document_templates FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid)
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS document_templates_delete ON kernel.document_templates;
--> statement-breakpoint
CREATE POLICY document_templates_delete ON kernel.document_templates FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
