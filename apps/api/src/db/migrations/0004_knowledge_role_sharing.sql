-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Role-based document sharing for Knowledge.
--
-- Generalises the per-USER `document_shares` ACL (0002) and the single
-- `edit_scope` gate (0003) into a flexible per-ROLE ACL: a document can be
-- shared with any number of ORG ROLES, each as 'viewer' or 'editor'. This is
-- the "share a doc with the Marketing team" primitive — pick a role in the
-- Share dialog, choose view or edit, done. It composes with (does not replace)
-- the per-user shares and org-wide `org_access` audience.
--
--   app_knowledge.document_role_shares(document_id, role_id, role viewer|editor)
--
-- A member of a shared role gets read (viewer|editor) or write (editor) on the
-- doc, exactly parallel to an explicit per-user share. Role membership is proven
-- via the new `app.current_roles` GUC (the JWT `roles` claim, set per request in
-- db/rls.ts) and the `app_knowledge.has_role` predicate below.
--
-- The old scoped-edit story ("everyone views, only C-Level edits") is now just
-- "org_access = viewer + edit-share to the C-Level role" — no dedicated marker
-- scope required. `edit_scope` (0003) stays honoured for backward-compatibility
-- but the UI drives role shares.

-- ── 1. has_role predicate ────────────────────────────────────────────────────
-- Literal membership test against the comma-joined role-id GUC. Like
-- has_exact_scope, it does NOT wildcard-expand: an org admin does not implicitly
-- belong to every role, so role-restricted access is honoured for admins too
-- (Drive-style). Returns false when the GUC is unset/empty/'__none__'.
CREATE OR REPLACE FUNCTION app_knowledge.has_role(_role_id UUID) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN _role_id::text = ANY(string_to_array(current_setting('app.current_roles', true), ','));
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.has_role(UUID) OWNER TO liaison_admin;
GRANT EXECUTE ON FUNCTION app_knowledge.has_role(UUID) TO liaison_rls, liaison_app;

-- ── 2. document_role_shares table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_knowledge.document_role_shares (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  document_id  UUID NOT NULL REFERENCES app_knowledge.documents(id) ON DELETE CASCADE,
  role_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID NOT NULL
);
ALTER TABLE app_knowledge.document_role_shares OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_role_shares_doc_role
  ON app_knowledge.document_role_shares (document_id, role_id);
CREATE INDEX IF NOT EXISTS idx_document_role_shares_doc
  ON app_knowledge.document_role_shares (document_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_knowledge.document_role_shares TO liaison_rls;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON app_knowledge.document_role_shares TO liaison_app;
GRANT REFERENCES ON app_knowledge.document_role_shares TO liaison_admin;

ALTER TABLE app_knowledge.document_role_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.document_role_shares FORCE ROW LEVEL SECURITY;

-- Same non-recursion discipline as document_shares: the documents SELECT policy
-- references document_role_shares, so this policy must NOT join back to
-- documents. Org + read-scope is the safe gate; the service layer scopes reads
-- to a specific document.
CREATE POLICY document_role_shares_select ON app_knowledge.document_role_shares FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:documents:read')
  );
CREATE POLICY document_role_shares_insert ON app_knowledge.document_role_shares FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );
CREATE POLICY document_role_shares_update ON app_knowledge.document_role_shares FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );
CREATE POLICY document_role_shares_delete ON app_knowledge.document_role_shares FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );

-- ── 3. documents SELECT policy — add role-share gate ─────────────────────────
-- Carries forward the 0002 policy verbatim and adds "OR shared to a role I
-- hold" to the org-doc branch (any role = read).
DROP POLICY IF EXISTS knowledge_documents_select ON app_knowledge.documents;
CREATE POLICY knowledge_documents_select ON app_knowledge.documents FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:documents:archive') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
    AND (
      (
        document_scope = 'personal'
        AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND app_knowledge.app_has_scope('knowledge:documents:read')
      )
      OR (
        document_scope = 'organization'
        AND app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          org_access IN ('viewer', 'editor')
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_shares s
            WHERE s.document_id = documents.id
              AND s.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_role_shares rs
            WHERE rs.document_id = documents.id
              AND app_knowledge.has_role(rs.role_id)
          )
        )
      )
      OR (
        app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
          OR owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        )
      )
    )
  );

-- ── 4. documents UPDATE policy — add editor role-share gate ──────────────────
-- Carries forward the 0003 policy (owner/creator OR org 'editor' OR edit_scope
-- OR explicit editor user-share) and adds "OR editor-shared to a role I hold".
DROP POLICY IF EXISTS knowledge_documents_update ON app_knowledge.documents;
CREATE POLICY knowledge_documents_update ON app_knowledge.documents FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR (
        document_scope = 'organization'
        AND (
          org_access = 'editor'
          OR (edit_scope IS NOT NULL AND app_knowledge.has_exact_scope(edit_scope))
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_shares s
            WHERE s.document_id = documents.id
              AND s.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
              AND s.role = 'editor'
          )
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_role_shares rs
            WHERE rs.document_id = documents.id
              AND rs.role = 'editor'
              AND app_knowledge.has_role(rs.role_id)
          )
        )
      )
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
  );
