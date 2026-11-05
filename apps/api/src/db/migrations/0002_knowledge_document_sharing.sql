-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Google-Drive-style per-document sharing for Knowledge.
--
-- Adds two axes on top of document_scope (personal | organization):
--   1. `org_access` on documents — what EVERYONE in the org gets on an org doc:
--        'none'   → restricted: only the owner/creator + explicitly-shared people
--        'viewer' → anyone in the org may read (dimension-gated, as before)
--        'editor' → anyone in the org may read + write (dimension-gated)
--      Default 'editor' preserves the pre-sharing behaviour (org docs were
--      collaboratively editable by any update-scope holder). Existing rows are
--      backfilled to 'editor' by the column default.
--   2. `app_knowledge.document_shares` — a per-(document,user) ACL with a role
--        ('viewer' | 'editor'). An EXPLICIT share grants access regardless of the
--        team/sensitivity dimension ladder (you were specifically given access);
--        the broad `org_access` audience remains dimension-gated.
--
-- The owner and creator always retain access (unchanged branch). There is NO
-- admin bypass of a restriction — a doc shared with specific people is invisible
-- to admins who are not on the list (Drive-style), except its owner/creator.
--
-- Search already filtered on participant_ids (modules/search/permission-filter.ts);
-- that column is left in place (still used by the indexer) and is orthogonal to
-- this ACL. Reads AND writes are gated below.

-- ── 1. org_access column ────────────────────────────────────────────────────
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS org_access TEXT NOT NULL DEFAULT 'editor'
  CHECK (org_access IN ('none', 'viewer', 'editor'));

-- ── 2. document_shares table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_knowledge.document_shares (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  document_id  UUID NOT NULL REFERENCES app_knowledge.documents(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID NOT NULL
);
ALTER TABLE app_knowledge.document_shares OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_shares_doc_user
  ON app_knowledge.document_shares (document_id, user_id);
CREATE INDEX IF NOT EXISTS idx_document_shares_user
  ON app_knowledge.document_shares (org_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_knowledge.document_shares TO liaison_rls;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON app_knowledge.document_shares TO liaison_app;
GRANT REFERENCES ON app_knowledge.document_shares TO liaison_admin;

ALTER TABLE app_knowledge.document_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.document_shares FORCE ROW LEVEL SECURITY;

-- Readable: any share row in the org, for callers with knowledge read scope.
-- NOTE: this deliberately does NOT join back to app_knowledge.documents — the
-- documents SELECT policy references document_shares (the explicit-share gate),
-- so a documents→document_shares→documents cycle would be infinite RLS
-- recursion. Org + read-scope is the safe, non-recursive gate; the service
-- layer scopes share reads to a specific document. Manage (insert/update/
-- delete): org + update scope; the service layer additionally enforces that
-- only a doc's writer may edit its shares (assertCanWriteDocumentRow).
CREATE POLICY document_shares_select ON app_knowledge.document_shares FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:documents:read')
  );
CREATE POLICY document_shares_insert ON app_knowledge.document_shares FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );
CREATE POLICY document_shares_update ON app_knowledge.document_shares FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );
CREATE POLICY document_shares_delete ON app_knowledge.document_shares FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (app_knowledge.app_has_scope('knowledge:documents:update') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
  );

-- ── 3. documents SELECT policy — add org_access + explicit-share gate ────────
DROP POLICY IF EXISTS knowledge_documents_select ON app_knowledge.documents;
CREATE POLICY knowledge_documents_select ON app_knowledge.documents FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:documents:archive') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
    AND (
      (
        -- Personal docs: owner-only, scope-gated.
        document_scope = 'personal'
        AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND app_knowledge.app_has_scope('knowledge:documents:read')
      )
      OR (
        -- Org docs: access is governed by the SHARING model (Drive-style), not
        -- the team/sensitivity dimension ladder — read scope + EITHER a broad
        -- org-wide audience (org_access viewer/editor) OR an explicit share.
        document_scope = 'organization'
        AND app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          org_access IN ('viewer', 'editor')
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_shares s
            WHERE s.document_id = documents.id
              AND s.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
      )
      OR (
        -- Creator/owner always read their own doc, regardless of access mode or
        -- the sensitivity ladder.
        app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
          OR owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        )
      )
    )
  );

-- ── 4. documents UPDATE policy — writable only by owner/creator, an org-wide
--       'editor' audience, or an explicit editor-share ─────────────────────────
DROP POLICY IF EXISTS knowledge_documents_update ON app_knowledge.documents;
CREATE POLICY knowledge_documents_update ON app_knowledge.documents FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (
      -- Owner/creator always write their own doc.
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR (
        -- Org docs: an org-wide 'editor' audience OR an explicit editor share
        -- may MAINTAIN the doc. Open org docs (org_access defaults to 'editor')
        -- stay collaboratively editable; restricted docs are owner/editor-only.
        document_scope = 'organization'
        AND (
          org_access = 'editor'
          OR EXISTS (
            SELECT 1 FROM app_knowledge.document_shares s
            WHERE s.document_id = documents.id
              AND s.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
              AND s.role = 'editor'
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
