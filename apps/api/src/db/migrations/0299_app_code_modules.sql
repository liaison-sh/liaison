-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.app_code_modules: the Worker modules of code that runs without an
-- installed app version (modules/apps/workers/adhoc-module.ts): an app-builder
-- draft's preview, an import transform, a PDF template. Built by the platform
-- (the same Worker module builder as a package's worker.js) when the code is
-- saved, published or first run, so it runs on the app loader or the sandbox
-- service like an installed app; never written from anything else.
--
--   source_key  sha256 of what the module was built from (the code, the
--               platform's Worker runtime, the export list); a draft's is
--               `draft:<sha256>` of its own built worker.js
--   sha256      the module's bytes (what the loader and the sandbox service
--               load, re-hashed by both)
--   org_id      the org whose code it is (NULL: an installed app's PDF
--               template, instance-wide like the template itself). Deleted
--               with the org.
--   last_used_at  touched when a run looks the module up (at most hourly per
--               process); a module unused for 30 days is pruned by a kernel job
--
-- System data, read and written through the privileged connection only:
-- FORCE RLS with no policy for liaison_rls.
--
-- New table, every statement re-runnable: the previous release never reads or
-- writes it.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.app_code_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  origin text NOT NULL
    CONSTRAINT app_code_modules_origin_check
    CHECK (origin IN ('draft', 'import-transform', 'pdf-template')),
  source_key text NOT NULL CHECK (source_key ~ '^(draft:)?[0-9a-f]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 8388608),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_code_modules_org_source_idx
  ON kernel.app_code_modules (org_id, source_key) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_code_modules_sha256_idx
  ON kernel.app_code_modules (sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_code_modules_last_used_idx
  ON kernel.app_code_modules (last_used_at);
--> statement-breakpoint
ALTER TABLE kernel.app_code_modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_code_modules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Default privileges hand liaison_rls grants on a new table; it reads and
-- writes nothing here.
REVOKE ALL ON kernel.app_code_modules FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.app_code_modules TO liaison_app;
