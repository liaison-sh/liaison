-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Scoped edit for Knowledge documents.
--
-- A doc can restrict WRITE access to holders of a specific scope while keeping
-- READ open to the whole org — e.g. "everyone can view, only C-Level can edit".
--
-- `documents.edit_scope` (nullable): when set, editing the doc additionally
-- requires the caller to hold that EXACT scope. It is checked with
-- `app_knowledge.has_exact_scope`, which — unlike `app_has_scope` — does NOT
-- honour the `*` / `knowledge:*` wildcards. This is deliberate: on a deployment where every
-- user is an org admin holding `*`, so a wildcard-expanding check could never
-- exclude anyone. An exact match means only users whose token literally carries
-- the scope (granted by a dedicated role, e.g. "C-Level" → scope `clevel`) may
-- edit; org admins who lack that role are correctly excluded. Owner/creator and
-- explicit `editor` shares always retain write access.
--
-- READ is unchanged (governed by org_access + shares from 0002). This only
-- widens/narrows WRITE.

-- Exact (non-wildcard) scope predicate.
CREATE OR REPLACE FUNCTION app_knowledge.has_exact_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN _scope = ANY(string_to_array(current_setting('app.current_scopes', true), ','));
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.has_exact_scope(TEXT) OWNER TO liaison_admin;
GRANT EXECUTE ON FUNCTION app_knowledge.has_exact_scope(TEXT) TO liaison_rls, liaison_app;

ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS edit_scope TEXT;

-- Rewrite the UPDATE policy to add the scoped-edit branch. Base is the 0002
-- policy (owner/creator OR org-wide 'editor' OR explicit editor share); we add
-- "OR the doc names an edit_scope the caller exactly holds".
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
