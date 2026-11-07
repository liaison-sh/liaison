-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- The per-org app data store and dashboards.
--
--  - kernel.app_documents: JSON documents an app keeps for its org, keyed by
--    (app, collection, doc_id). `app` is the app that owns the collection (or
--    `agent`, the agent's own namespace); the service (modules/data-store)
--    lets an app reach only its own collections, the database keeps orgs apart
--    (FORCE RLS on org_id). `size_bytes` is the serialized size the service
--    measured (at most 256 KiB, bounded here as a backstop); `version` counts
--    writes for optimistic concurrency.
--  - kernel.app_document_usage: one counter row per (org, app, collection),
--    updated in the same transaction as every document write, so the
--    documents-per-collection limit holds without a scan and the storage
--    estimate reads totals cheaply.
--  - kernel.dashboards: a person's (`personal`) or the org's (`org`) dashboard,
--    its blocks in `spec`. A personal dashboard always has an owner; an org one
--    may lose it (its owner's erasure sets it NULL, the dashboard is org
--    content). Personal ones are visible to their owner only; org ones to the
--    org. Writes: the owner (an org dashboard needs kernel:dashboards:share or
--    :admin), or kernel:dashboards:admin for any org dashboard.
--
-- New tables, every statement re-runnable.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS kernel.app_documents (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL CHECK (app ~ '^[a-z][a-z0-9_-]{0,62}$'),
  collection text NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_]{0,62}$'),
  doc_id text NOT NULL CHECK (doc_id <> '' AND length(doc_id) <= 200),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 262144),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app, collection, doc_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_documents_recent_idx
  ON kernel.app_documents (org_id, app, collection, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_documents_data_idx
  ON kernel.app_documents USING gin (data jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_documents_created_by_fk_idx
  ON kernel.app_documents (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_documents_updated_by_fk_idx
  ON kernel.app_documents (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.app_document_usage (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL,
  collection text NOT NULL,
  docs integer NOT NULL DEFAULT 0 CHECK (docs >= 0),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app, collection)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
  visibility text NOT NULL
    CONSTRAINT dashboards_visibility_check CHECK (visibility IN ('personal', 'org')),
  owner_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  spec jsonb NOT NULL
    CONSTRAINT dashboards_spec_check
    CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 262144),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A personal dashboard without an owner would be nobody's: only an org one
  -- may lose its owner (ON DELETE SET NULL, erasure).
  CONSTRAINT dashboards_owner_check CHECK (owner_user_id IS NOT NULL OR visibility = 'org')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboards_org_idx
  ON kernel.dashboards (org_id, visibility, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboards_owner_user_fk_idx
  ON kernel.dashboards (owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboards_created_by_fk_idx
  ON kernel.dashboards (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboards_updated_by_fk_idx
  ON kernel.dashboards (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

ALTER TABLE kernel.app_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_document_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_document_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_documents TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_document_usage TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.dashboards TO liaison_rls, liaison_app;
--> statement-breakpoint

-- app_documents: the caller's org.
DROP POLICY IF EXISTS app_documents_select ON kernel.app_documents;
--> statement-breakpoint
CREATE POLICY app_documents_select ON kernel.app_documents FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_documents_insert ON kernel.app_documents;
--> statement-breakpoint
CREATE POLICY app_documents_insert ON kernel.app_documents FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_documents_update ON kernel.app_documents;
--> statement-breakpoint
CREATE POLICY app_documents_update ON kernel.app_documents FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid)
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_documents_delete ON kernel.app_documents;
--> statement-breakpoint
CREATE POLICY app_documents_delete ON kernel.app_documents FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint

-- app_document_usage: the caller's org.
DROP POLICY IF EXISTS app_document_usage_select ON kernel.app_document_usage;
--> statement-breakpoint
CREATE POLICY app_document_usage_select ON kernel.app_document_usage FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_document_usage_insert ON kernel.app_document_usage;
--> statement-breakpoint
CREATE POLICY app_document_usage_insert ON kernel.app_document_usage FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_document_usage_update ON kernel.app_document_usage;
--> statement-breakpoint
CREATE POLICY app_document_usage_update ON kernel.app_document_usage FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid)
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_document_usage_delete ON kernel.app_document_usage;
--> statement-breakpoint
CREATE POLICY app_document_usage_delete ON kernel.app_document_usage FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint

-- dashboards: org ones to the org, personal ones to their owner. The user is
-- compared by casting the context value, never the column (0253).
DROP POLICY IF EXISTS dashboards_select ON kernel.dashboards;
--> statement-breakpoint
CREATE POLICY dashboards_select ON kernel.dashboards FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      visibility = 'org'
      OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboards_insert ON kernel.dashboards;
--> statement-breakpoint
CREATE POLICY dashboards_insert ON kernel.dashboards FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (
        owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          visibility = 'personal'
          OR (SELECT kernel.has_scope('kernel:dashboards:share'))
          OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
        )
      )
      OR (visibility = 'org' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboards_update ON kernel.dashboards;
--> statement-breakpoint
CREATE POLICY dashboards_update ON kernel.dashboards FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR (visibility = 'org' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (
        owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          visibility = 'personal'
          OR (SELECT kernel.has_scope('kernel:dashboards:share'))
          OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
        )
      )
      OR (visibility = 'org' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboards_delete ON kernel.dashboards;
--> statement-breakpoint
CREATE POLICY dashboards_delete ON kernel.dashboards FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR (visibility = 'org' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
