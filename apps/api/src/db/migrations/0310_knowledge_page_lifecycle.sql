-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Knowledge pages: history, quieter autosave events, Trash, links and folder pages.
--
-- Every column and table the page work needs is added here, so no later step of it
-- needs a migration of its own:
--
--  1. app_knowledge.document_versions: the texts a page had. A row is the text one
--     author's session produced (post-image), or a baseline of the text before a write
--     when history did not hold it yet, or a text a person could not apply (a conflict
--     left open). Readable and writable only with the edit right on the page, through
--     app_knowledge.can_edit_document, which repeats the conditions of the
--     knowledge_documents_update policy under the reader's own row view.
--  2. app_knowledge.document_links: which page links to which. A link may name a page
--     that does not exist (yet, or any more), so the target has no foreign key.
--  3. documents.trashed_at / trashed_by: when and by whom a page went to Trash.
--     The trigger documents_trash_guard clears both whenever a page is un-archived,
--     becomes synced, or is archived again without a new clock, so a release that
--     does not know the columns (restore, re-archive, a re-sync) can never leave a
--     live page, or a page archived again, with an old clock.
--  4. documents.update_event_at / update_event_pending_at: when the last update event
--     of a page was queued, and whether one is still owed (autosave sends at most one
--     a minute; a job sends the owed one).
--  5. documents.links_indexed_at: when the page's links were last recorded.
--  6. collections.index_document_id: the page a folder shows as its own text.
--
-- The previous release keeps working: every new column is nullable, it never writes
-- the new tables, and the trigger only clears columns it does not know.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- expand-safe: a new nullable column; the previous release neither reads nor writes it.
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS trashed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trashed_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS update_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS update_event_pending_at timestamptz,
  ADD COLUMN IF NOT EXISTS links_indexed_at timestamptz;
--> statement-breakpoint
-- expand-safe: a new nullable column; deleting a page clears it, which the previous release never reads.
ALTER TABLE app_knowledge.collections
  ADD COLUMN IF NOT EXISTS index_document_id uuid
    REFERENCES app_knowledge.documents(id) ON DELETE SET NULL;
--> statement-breakpoint

-- index-build: documents 50000 7
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_update_event_pending
  ON app_knowledge.documents (org_id, update_event_pending_at)
  WHERE update_event_pending_at IS NOT NULL;
--> statement-breakpoint
-- index-build: documents 50000 6
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_trashed
  ON app_knowledge.documents (org_id, trashed_at)
  WHERE trashed_at IS NOT NULL;
--> statement-breakpoint
-- index-build: documents 50000 6
CREATE INDEX IF NOT EXISTS idx_app_knowledge_documents_trashed_by_fk
  ON app_knowledge.documents (trashed_by) WHERE trashed_by IS NOT NULL;
--> statement-breakpoint
-- index-build: collections 5000 1
CREATE INDEX IF NOT EXISTS idx_app_knowledge_collections_index_document_fk
  ON app_knowledge.collections (index_document_id) WHERE index_document_id IS NOT NULL;
--> statement-breakpoint

-- A clock only ever belongs to a page in Trash: archived, not synced, and archived
-- together with the clock.
CREATE OR REPLACE FUNCTION app_knowledge.documents_trash_guard_fn()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.archived_at IS NULL OR NEW.synced_source_id IS NOT NULL THEN
    NEW.trashed_at := NULL;
    NEW.trashed_by := NULL;
  ELSIF OLD.archived_at IS NULL AND NEW.trashed_at IS NOT DISTINCT FROM OLD.trashed_at THEN
    NEW.trashed_at := NULL;
    NEW.trashed_by := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
-- expand-safe: re-run guard for the trigger created below.
DROP TRIGGER IF EXISTS documents_trash_guard ON app_knowledge.documents;
--> statement-breakpoint
-- expand-safe: clears only the new Trash columns, which the previous release neither reads nor writes.
CREATE TRIGGER documents_trash_guard
  BEFORE UPDATE OF archived_at, trashed_at, synced_source_id ON app_knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION app_knowledge.documents_trash_guard_fn();
--> statement-breakpoint

-- The edit right on a page, as knowledge_documents_update grants it, judged under the
-- caller's own row view (the SELECT policy applies inside, so a page the caller cannot
-- read is never editable). A yes or no: it names nothing.
CREATE OR REPLACE FUNCTION app_knowledge.can_edit_document(p_document uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_knowledge.documents d
     WHERE d.id = p_document
       AND d.org_id = current_setting('app.current_org_id', true)::uuid
       AND (app_knowledge.app_has_scope('knowledge:documents:update')
            OR app_knowledge.app_has_scope('knowledge:documents:admin'))
       AND (
         d.owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR d.created_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (
           d.document_scope = 'organization'
           AND (
             d.org_access = 'editor'
             OR (d.edit_scope IS NOT NULL AND app_knowledge.has_exact_scope(d.edit_scope))
             OR kernel.resource_grant_role('knowledge.document', d.id) = 'editor'
           )
         )
       )
  )
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_knowledge.can_edit_document(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL
GRANT EXECUTE ON FUNCTION app_knowledge.can_edit_document(uuid)
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_knowledge.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  document_id uuid NOT NULL REFERENCES app_knowledge.documents(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('baseline', 'edit', 'agent', 'import', 'restore', 'unapplied')),
  title text NOT NULL,
  body text NOT NULL,
  body_md5 text NOT NULL,
  revision integer,
  base_revision integer,
  session_id uuid,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
  author_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  agent_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  required_scopes text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_document_versions_document
  ON app_knowledge.document_versions (document_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_document_versions_org
  ON app_knowledge.document_versions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_knowledge_document_versions_author_fk
  ON app_knowledge.document_versions (author_id) WHERE author_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app_knowledge.document_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_knowledge.document_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app_knowledge.document_versions
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_versions_select ON app_knowledge.document_versions;
--> statement-breakpoint
CREATE POLICY knowledge_document_versions_select ON app_knowledge.document_versions
  FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(document_id));
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_versions_insert ON app_knowledge.document_versions;
--> statement-breakpoint
CREATE POLICY knowledge_document_versions_insert ON app_knowledge.document_versions
  FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(document_id));
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_versions_update ON app_knowledge.document_versions;
--> statement-breakpoint
CREATE POLICY knowledge_document_versions_update ON app_knowledge.document_versions
  FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(document_id))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(document_id));
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_versions_delete ON app_knowledge.document_versions;
--> statement-breakpoint
CREATE POLICY knowledge_document_versions_delete ON app_knowledge.document_versions
  FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(document_id));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_knowledge.document_links (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES app_knowledge.documents(id) ON DELETE CASCADE,
  target_document_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_document_id, target_document_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_document_links_target
  ON app_knowledge.document_links (org_id, target_document_id);
--> statement-breakpoint
ALTER TABLE app_knowledge.document_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_knowledge.document_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app_knowledge.document_links
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_links_select ON app_knowledge.document_links;
--> statement-breakpoint
CREATE POLICY knowledge_document_links_select ON app_knowledge.document_links
  FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (SELECT 1 FROM app_knowledge.documents d WHERE d.id = source_document_id)
  );
--> statement-breakpoint
-- Who may record a page's links: its editors, and the person who just created it with
-- the create scope alone (a page created with a link in its body).
DROP POLICY IF EXISTS knowledge_document_links_insert ON app_knowledge.document_links;
--> statement-breakpoint
CREATE POLICY knowledge_document_links_insert ON app_knowledge.document_links
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      app_knowledge.can_edit_document(source_document_id)
      OR (
        app_knowledge.app_has_scope('knowledge:documents:create')
        AND EXISTS (
          SELECT 1 FROM app_knowledge.documents d
           WHERE d.id = source_document_id
             AND d.created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        )
      )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_links_update ON app_knowledge.document_links;
--> statement-breakpoint
CREATE POLICY knowledge_document_links_update ON app_knowledge.document_links
  FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(source_document_id))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_knowledge.can_edit_document(source_document_id));
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_document_links_delete ON app_knowledge.document_links;
--> statement-breakpoint
CREATE POLICY knowledge_document_links_delete ON app_knowledge.document_links
  FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      app_knowledge.can_edit_document(source_document_id)
      OR (
        app_knowledge.app_has_scope('knowledge:documents:create')
        AND EXISTS (
          SELECT 1 FROM app_knowledge.documents d
           WHERE d.id = source_document_id
             AND d.created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        )
      )
    )
  );
