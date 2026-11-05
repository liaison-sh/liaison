-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.import_uploads: one large file a person uploads for an import, sent
-- straight to object storage as an S3 multipart upload (or, when the store is
-- not reachable from browsers, through the API relay up to the ordinary file
-- size limit).
--
-- The row tracks the multipart state the store needs to resume and finish the
-- upload: the object key, the store's upload id and the part size. Parts
-- themselves are listed from the store (ListParts), never stored here. When
-- the upload completes, the object becomes a kernel.files row parented to the
-- uploader's own upload session (owner-only), and `file_id` points at it. A
-- reaper aborts uploads still open after `expires_at` (24 hours).
--
-- RLS: org data, owner within the org, as for kernel.file_upload_sessions.
-- liaison_rls may read its own uploads and insert one for itself (the row is
-- created in the request transaction that opens its upload session); every
-- later change (complete, abort, the reaper) goes through the privileged
-- connection, so liaison_rls gets no UPDATE or DELETE policy.
--
-- Every statement is re-runnable.

CREATE TABLE IF NOT EXISTS kernel.import_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES kernel.file_upload_sessions(id) ON DELETE SET NULL,
  file_id uuid REFERENCES kernel.files(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  mode text NOT NULL DEFAULT 'multipart',
  upload_id text,
  part_size bigint NOT NULL DEFAULT 0,
  size bigint NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT import_uploads_mode_chk CHECK (mode IN ('multipart', 'relay')),
  CONSTRAINT import_uploads_status_chk CHECK (status IN ('uploading', 'complete', 'aborted')),
  CONSTRAINT import_uploads_size_chk CHECK (size > 0 AND part_size >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_uploads_storage_key_idx
  ON kernel.import_uploads (storage_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_uploads_owner_idx
  ON kernel.import_uploads (org_id, created_by, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_uploads_open_idx
  ON kernel.import_uploads (expires_at)
  WHERE status = 'uploading';
--> statement-breakpoint
ALTER TABLE kernel.import_uploads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.import_uploads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.import_uploads TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS import_uploads_owner_select ON kernel.import_uploads;
--> statement-breakpoint
CREATE POLICY import_uploads_owner_select ON kernel.import_uploads FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS import_uploads_owner_insert ON kernel.import_uploads;
--> statement-breakpoint
CREATE POLICY import_uploads_owner_insert ON kernel.import_uploads FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
  );
