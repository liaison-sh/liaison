-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- The in-product app builder: drafts, their versions, their build artifacts,
-- and the logs of custom apps and draft previews.
--
--  - kernel.app_drafts: an org's app in the making. `base_name` becomes the
--    custom app name `<base>-o<orgKey>`; at most one live (not discarded) draft
--    per base in an org. `published_app_name` is set at the first publish and
--    never changes after (trigger below); `base_name` and `org_id` never change.
--    `latest_version` is the highest version number ever made (versions are
--    pruned to the last 20, numbers are never reused).
--  - kernel.app_draft_versions: one immutable set of files per version
--    (app.manifest.json, handlers.ts, ui.tsx?, README.md?; at most 512 KiB in
--    the service, bounded here as a backstop) and the outcome of its build.
--  - kernel.app_build_artifacts: the built bytes (package, bundle, ui, worker)
--    by sha256, per draft, so a publish installs exactly what was built and
--    approved. Pruned with the versions that name them.
--  - kernel.app_logs: lines a custom app or a draft preview wrote through
--    ctx.logger, batched per run (at most 200 lines / 256 KiB per run), each
--    tagged with the read scopes of the run. Written by a system actor only;
--    read by holders of kernel:apps:logs whose scopes cover every tag, and a
--    draft preview's lines by the person whose run wrote them only. Pruned to
--    7 days and 10,000 rows per (org, app) by a kernel job.
--
-- New tables, every statement re-runnable.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS kernel.app_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  base_name text NOT NULL
    CONSTRAINT app_drafts_base_name_check CHECK (base_name ~ '^[a-z][a-z0-9-]{1,40}$'),
  title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT app_drafts_status_check CHECK (status IN ('draft', 'published', 'discarded')),
  published_app_name text
    CONSTRAINT app_drafts_published_app_name_check
    CHECK (published_app_name IS NULL OR published_app_name ~ '^[a-z][a-z0-9-]{1,40}-o[0-9a-f]{8}$'),
  latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version >= 1),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_drafts_published_check CHECK (status <> 'published' OR published_app_name IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_drafts_live_base_name_idx
  ON kernel.app_drafts (org_id, base_name) WHERE status <> 'discarded';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_drafts_org_idx
  ON kernel.app_drafts (org_id, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_drafts_created_by_fk_idx
  ON kernel.app_drafts (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_drafts_updated_by_fk_idx
  ON kernel.app_drafts (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

-- A draft's identity never moves: its org and base always, its published app
-- name once set. The service refuses first with a typed error; this is the
-- backstop for any other writer.
CREATE OR REPLACE FUNCTION kernel.app_drafts_identity_guard_fn() RETURNS TRIGGER AS $TRIGGER_BODY$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.base_name IS DISTINCT FROM OLD.base_name THEN
    RAISE EXCEPTION 'app_draft_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.published_app_name IS NOT NULL
     AND NEW.published_app_name IS DISTINCT FROM OLD.published_app_name THEN
    RAISE EXCEPTION 'app_draft_published_name_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER FUNCTION kernel.app_drafts_identity_guard_fn() OWNER TO liaison_admin;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_drafts_identity_guard ON kernel.app_drafts;
--> statement-breakpoint
CREATE TRIGGER app_drafts_identity_guard
  BEFORE UPDATE ON kernel.app_drafts
  FOR EACH ROW EXECUTE FUNCTION kernel.app_drafts_identity_guard_fn();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.app_draft_versions (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES kernel.app_drafts(id) ON DELETE CASCADE,
  n integer NOT NULL CHECK (n >= 1),
  files jsonb NOT NULL
    CONSTRAINT app_draft_versions_files_check
    CHECK (jsonb_typeof(files) = 'object' AND octet_length(files::text) <= 1048576),
  message text CHECK (message IS NULL OR length(message) <= 500),
  build jsonb CHECK (build IS NULL OR jsonb_typeof(build) = 'object'),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, n)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_draft_versions_org_fk_idx
  ON kernel.app_draft_versions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_draft_versions_created_by_fk_idx
  ON kernel.app_draft_versions (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.app_build_artifacts (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES kernel.app_drafts(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL
    CONSTRAINT app_build_artifacts_kind_check CHECK (kind IN ('package', 'bundle', 'ui', 'worker')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 8388608),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, sha256)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_build_artifacts_org_fk_idx
  ON kernel.app_build_artifacts (org_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.app_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app text NOT NULL CHECK (app ~ '^[a-z][a-z0-9-]{0,62}$'),
  draft_id uuid REFERENCES kernel.app_drafts(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  actor_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  scope_tags text[] NOT NULL DEFAULT '{}',
  level text NOT NULL
    CONSTRAINT app_logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message text NOT NULL CHECK (octet_length(message) <= 4096),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT app_logs_fields_check
    CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 16384),
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_logs_app_at_idx
  ON kernel.app_logs (org_id, app, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_logs_draft_fk_idx
  ON kernel.app_logs (draft_id, at DESC) WHERE draft_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_logs_actor_user_fk_idx
  ON kernel.app_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_logs_at_idx
  ON kernel.app_logs (at);
--> statement-breakpoint

ALTER TABLE kernel.app_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_drafts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_draft_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_draft_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_build_artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_build_artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_drafts TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_draft_versions TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_build_artifacts TO liaison_rls, liaison_app;
--> statement-breakpoint
-- Log rows are never edited; the prune runs on the system connection.
GRANT SELECT, INSERT ON kernel.app_logs TO liaison_rls, liaison_app;
--> statement-breakpoint

-- app_drafts: read by the org, written by holders of kernel:apps:build.
DROP POLICY IF EXISTS app_drafts_select ON kernel.app_drafts;
--> statement-breakpoint
CREATE POLICY app_drafts_select ON kernel.app_drafts FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_drafts_insert ON kernel.app_drafts;
--> statement-breakpoint
CREATE POLICY app_drafts_insert ON kernel.app_drafts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_drafts_update ON kernel.app_drafts;
--> statement-breakpoint
CREATE POLICY app_drafts_update ON kernel.app_drafts FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_drafts_delete ON kernel.app_drafts;
--> statement-breakpoint
CREATE POLICY app_drafts_delete ON kernel.app_drafts FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint

-- app_draft_versions: as app_drafts.
DROP POLICY IF EXISTS app_draft_versions_select ON kernel.app_draft_versions;
--> statement-breakpoint
CREATE POLICY app_draft_versions_select ON kernel.app_draft_versions FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_draft_versions_insert ON kernel.app_draft_versions;
--> statement-breakpoint
CREATE POLICY app_draft_versions_insert ON kernel.app_draft_versions FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_draft_versions_update ON kernel.app_draft_versions;
--> statement-breakpoint
CREATE POLICY app_draft_versions_update ON kernel.app_draft_versions FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_draft_versions_delete ON kernel.app_draft_versions;
--> statement-breakpoint
CREATE POLICY app_draft_versions_delete ON kernel.app_draft_versions FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint

-- app_build_artifacts: as app_drafts.
DROP POLICY IF EXISTS app_build_artifacts_select ON kernel.app_build_artifacts;
--> statement-breakpoint
CREATE POLICY app_build_artifacts_select ON kernel.app_build_artifacts FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS app_build_artifacts_insert ON kernel.app_build_artifacts;
--> statement-breakpoint
CREATE POLICY app_build_artifacts_insert ON kernel.app_build_artifacts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_build_artifacts_update ON kernel.app_build_artifacts;
--> statement-breakpoint
CREATE POLICY app_build_artifacts_update ON kernel.app_build_artifacts FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS app_build_artifacts_delete ON kernel.app_build_artifacts;
--> statement-breakpoint
CREATE POLICY app_build_artifacts_delete ON kernel.app_build_artifacts FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:apps:build'))
  );
--> statement-breakpoint

-- app_logs: a row is read only by a reader whose scopes cover every one of
-- its scope tags (what its run had read). An app's lines need
-- kernel:apps:logs; a draft preview's lines are their run's person's alone
-- (with kernel:apps:logs or kernel:apps:build). The user is compared by
-- casting the context value, never the column (0253).
DROP POLICY IF EXISTS app_logs_select ON kernel.app_logs;
--> statement-breakpoint
CREATE POLICY app_logs_select ON kernel.app_logs FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND NOT EXISTS (
      SELECT 1 FROM unnest(scope_tags) AS t(tag) WHERE NOT kernel.has_scope(t.tag)
    )
    AND (
      (draft_id IS NULL AND (SELECT kernel.has_scope('kernel:apps:logs')))
      OR (
        draft_id IS NOT NULL
        AND actor_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          (SELECT kernel.has_scope('kernel:apps:logs'))
          OR (SELECT kernel.has_scope('kernel:apps:build'))
        )
      )
    )
  );
--> statement-breakpoint
-- Only a system actor writes log rows (its context carries the nil user id,
-- db/rls.ts): a person's transaction never forges a line.
DROP POLICY IF EXISTS app_logs_insert ON kernel.app_logs;
--> statement-breakpoint
CREATE POLICY app_logs_insert ON kernel.app_logs FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT rls_ctx.user_id()) = '00000000-0000-0000-0000-000000000000'
  );
