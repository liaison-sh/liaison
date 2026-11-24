-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A personal Knowledge folder is seen by its owner alone.
--
-- Until now every folder was listed to every reader, whoever owned it. The rows
-- are now hidden by row security, with no admin exception (as personal pages
-- are). Folders written before meant something else: the provisioner, the agent
-- tool and imports gave a team's folder to whoever ran them, so a reclassification
-- comes first.
--
--  1. collections.previous_owner_user_id: who owned a folder before this
--     migration shared it. Only this file writes it.
--  2. The rule, once. A tree is a top folder and everything under it; the root of
--     a synced source is its own top and its tree is left alone. A tree stays
--     personal only if its top has an owner, every live folder in it has that
--     owner, and it holds at least one live page or source link, all created by
--     that owner and readable by nobody else. Every other tree becomes shared. No
--     page's access changes, nothing is re-parented, updated_at is not touched.
--  3. Triggers: a personal folder or source whose owner is lost (erasure, deleted
--     user) is archived and renamed instead of becoming shared.
--  4. Policies on collections (own or shared) and on collection_memberships (the
--     folder must be visible too).
--  5. Two SECURITY DEFINER functions for what one person's row view cannot do:
--     empty a folder into its parent, and tell whether a tree is only one's own.
--
-- The previous release keeps working: the new column is nullable, its writes give
-- a folder to the caller or to nobody, and it hides what it may not see.
--
-- Revert of 2 (touches only folders nobody re-assigned since):
-- UPDATE app_knowledge.collections SET owner_user_id = previous_owner_user_id, previous_owner_user_id = NULL
--  WHERE previous_owner_user_id IS NOT NULL AND owner_user_id IS NULL AND archived_at IS NULL;
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- expand-safe: a new nullable column, which the previous release neither writes nor reads.
ALTER TABLE app_knowledge.collections
  ADD COLUMN IF NOT EXISTS previous_owner_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint

-- The tables force row security and their policies name the runtime roles only,
-- so a migration login that is not a superuser would read no row (see 0283).
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
WITH RECURSIVE tree AS (
  SELECT c.id, c.org_id, c.id AS top, c.owner_user_id AS top_owner,
         EXISTS (SELECT 1 FROM app_knowledge.synced_sources s WHERE s.root_collection_id = c.id) AS synced
    FROM app_knowledge.collections c
   WHERE c.parent_collection_id IS NULL
      OR EXISTS (SELECT 1 FROM app_knowledge.synced_sources s WHERE s.root_collection_id = c.id)
  UNION ALL
  SELECT c.id, c.org_id, t.top, t.top_owner, t.synced
    FROM app_knowledge.collections c JOIN tree t ON c.parent_collection_id = t.id AND c.org_id = t.org_id
   WHERE NOT EXISTS (SELECT 1 FROM app_knowledge.synced_sources s WHERE s.root_collection_id = c.id)
), item AS (
  SELECT t.top,
         d.created_by = t.top_owner AND COALESCE(d.owner_user_id, t.top_owner) = t.top_owner
         AND (d.document_scope = 'personal'
              OR (d.org_access NOT IN ('viewer','editor')
                  AND NOT EXISTS (SELECT 1 FROM kernel.resource_grants g
                                   WHERE g.org_id = d.org_id AND g.resource_type = 'knowledge.document' AND g.resource_id = d.id
                                     AND NOT (g.grantee_kind = 'user' AND g.grantee = t.top_owner::text)))) AS only_owner
    FROM tree t
    JOIN app_knowledge.collection_memberships m ON m.collection_id = t.id AND m.target_type = 'document'
    JOIN app_knowledge.documents d ON d.id = m.target_id AND d.org_id = m.org_id AND d.archived_at IS NULL
  UNION ALL
  SELECT t.top, false FROM tree t
    JOIN app_knowledge.collection_memberships m ON m.collection_id = t.id AND m.target_type = 'source_link'
    JOIN app_knowledge.source_links l ON l.id = m.target_id AND l.org_id = m.org_id AND l.archived_at IS NULL
), keep AS (
  SELECT i.top FROM item i GROUP BY i.top HAVING bool_and(COALESCE(i.only_owner, false))
  EXCEPT
  SELECT t.top FROM tree t JOIN app_knowledge.collections c ON c.id = t.id
   WHERE c.archived_at IS NULL AND c.owner_user_id IS DISTINCT FROM t.top_owner
)
UPDATE app_knowledge.collections c
   SET previous_owner_user_id = c.owner_user_id, owner_user_id = NULL
  FROM tree t
 WHERE t.id = c.id AND NOT t.synced AND c.owner_user_id IS NOT NULL
   AND t.top NOT IN (SELECT top FROM keep)
   -- Once only: after this migration a personal folder is one its owner meant.
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
                    WHERE g.tgname = 'collections_owner_lost'
                      AND g.tgrelid = 'app_knowledge.collections'::regclass);
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- Only a request of the owner, who alone sees the folder, really shares it.
CREATE OR REPLACE FUNCTION app_knowledge.collections_owner_lost_fn()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
     AND OLD.owner_user_id::text IS DISTINCT FROM rls_ctx.user_id() THEN
    NEW.archived_at := COALESCE(NEW.archived_at, now());
    NEW.name := 'Deleted folder';
    NEW.description := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_knowledge.collections_owner_lost_fn() OWNER TO liaison_admin;
--> statement-breakpoint
-- expand-safe: the previous release never clears an owner but for the owner's own request, erasure or a deleted user.
DROP TRIGGER IF EXISTS collections_owner_lost ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: fires only when an owner is lost outside the owner's own request; the previous release then published the folder.
CREATE TRIGGER collections_owner_lost BEFORE UPDATE OF owner_user_id ON app_knowledge.collections
  FOR EACH ROW EXECUTE FUNCTION app_knowledge.collections_owner_lost_fn();
--> statement-breakpoint

-- A personal source never becomes the organization's. Archived, so no sync run
-- brings its folders back; an ownerless source must name a sensitivity
-- (knowledge_synced_sources_scope_sensitivity_check), so the strictest one.
CREATE OR REPLACE FUNCTION app_knowledge.synced_sources_owner_lost_fn()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL THEN
    NEW.archived_at := COALESCE(NEW.archived_at, now());
    NEW.default_sensitivity := COALESCE(NEW.default_sensitivity, 'restricted');
    NEW.display_name := 'Deleted source';
    NEW.folder_ref := 'deleted:' || NEW.id::text;
    NEW.source_account := NULL;
    NEW.last_error := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_knowledge.synced_sources_owner_lost_fn() OWNER TO liaison_admin;
--> statement-breakpoint
-- expand-safe: the previous release never clears the owner of a source but by erasure.
DROP TRIGGER IF EXISTS synced_sources_owner_lost ON app_knowledge.synced_sources;
--> statement-breakpoint
-- expand-safe: fires only when the owner of a personal source is lost, which failed on the table's own check before.
CREATE TRIGGER synced_sources_owner_lost BEFORE UPDATE OF owner_user_id ON app_knowledge.synced_sources
  FOR EACH ROW EXECUTE FUNCTION app_knowledge.synced_sources_owner_lost_fn();
--> statement-breakpoint

-- expand-safe: replaced below by one policy per command; the previous release reads and writes through them.
DROP POLICY IF EXISTS knowledge_collections_rls ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: re-run guard for the policy created below.
DROP POLICY IF EXISTS knowledge_collections_select ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: the previous release sees fewer folders, as this release does.
CREATE POLICY knowledge_collections_select ON app_knowledge.collections FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:documents:read'))
    AND (owner_user_id IS NULL OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid)
  );
--> statement-breakpoint
-- expand-safe: re-run guard for the policy created below.
DROP POLICY IF EXISTS knowledge_collections_insert ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: the previous release creates folders for the caller or for everyone, which this allows.
CREATE POLICY knowledge_collections_insert ON app_knowledge.collections FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND (owner_user_id IS NULL OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid)
  );
--> statement-breakpoint
-- expand-safe: re-run guard for the policy created below.
DROP POLICY IF EXISTS knowledge_collections_update ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: the previous release edits the folders it can see; giving one to another person is refused.
CREATE POLICY knowledge_collections_update ON app_knowledge.collections FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:documents:read'))
    AND (owner_user_id IS NULL OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid)
  )
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND (owner_user_id IS NULL OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid)
  );
--> statement-breakpoint
-- expand-safe: re-run guard for the policy created below.
DROP POLICY IF EXISTS knowledge_collections_delete ON app_knowledge.collections;
--> statement-breakpoint
-- expand-safe: the previous release deletes no folder row through row security.
CREATE POLICY knowledge_collections_delete ON app_knowledge.collections FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND (owner_user_id IS NULL OR owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid)
  );
--> statement-breakpoint

-- expand-safe: the membership of a folder the reader cannot see is hidden with it.
DROP POLICY IF EXISTS knowledge_collection_memberships_select ON app_knowledge.collection_memberships;
--> statement-breakpoint
-- expand-safe: the previous release reads memberships only beside their folder.
CREATE POLICY knowledge_collection_memberships_select ON app_knowledge.collection_memberships
  FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:documents:read'))
    AND EXISTS (
      SELECT 1 FROM app_knowledge.collections c
      WHERE c.id = collection_memberships.collection_id
        AND c.org_id = collection_memberships.org_id
    )
    AND (
      (target_type = 'document' AND EXISTS (
        SELECT 1 FROM app_knowledge.documents d
        WHERE d.id = collection_memberships.target_id
          AND d.org_id = collection_memberships.org_id
      ))
      OR (target_type = 'source_link' AND EXISTS (
        SELECT 1 FROM app_knowledge.source_links sl
        WHERE sl.id = collection_memberships.target_id
          AND sl.org_id = collection_memberships.org_id
      ))
    )
  );
--> statement-breakpoint
-- expand-safe: replaced below by the same rule plus the folder's visibility.
DROP POLICY IF EXISTS knowledge_collection_memberships_insert ON app_knowledge.collection_memberships;
--> statement-breakpoint
-- expand-safe: the previous release files into folders it can see.
CREATE POLICY knowledge_collection_memberships_insert ON app_knowledge.collection_memberships
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND EXISTS (
      SELECT 1 FROM app_knowledge.collections c
      WHERE c.id = collection_memberships.collection_id
        AND c.org_id = collection_memberships.org_id
    )
  );
--> statement-breakpoint
-- expand-safe: replaced below by the same rule plus the folder's visibility.
DROP POLICY IF EXISTS knowledge_collection_memberships_update ON app_knowledge.collection_memberships;
--> statement-breakpoint
-- expand-safe: the previous release updates no membership.
CREATE POLICY knowledge_collection_memberships_update ON app_knowledge.collection_memberships
  FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND EXISTS (
      SELECT 1 FROM app_knowledge.collections c
      WHERE c.id = collection_memberships.collection_id
        AND c.org_id = collection_memberships.org_id
    )
  )
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND EXISTS (
      SELECT 1 FROM app_knowledge.collections c
      WHERE c.id = collection_memberships.collection_id
        AND c.org_id = collection_memberships.org_id
    )
  );
--> statement-breakpoint
-- expand-safe: replaced below by the same rule plus the folder's visibility.
DROP POLICY IF EXISTS knowledge_collection_memberships_delete ON app_knowledge.collection_memberships;
--> statement-breakpoint
-- expand-safe: the previous release unfiles from folders it can see.
CREATE POLICY knowledge_collection_memberships_delete ON app_knowledge.collection_memberships
  FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (SELECT app_knowledge.app_has_scope('knowledge:collections:manage'))
    AND EXISTS (
      SELECT 1 FROM app_knowledge.collections c
      WHERE c.id = collection_memberships.collection_id
        AND c.org_id = collection_memberships.org_id
    )
  );
--> statement-breakpoint

-- What the two functions below need, as liaison_definer (0178) runs them.
GRANT USAGE ON SCHEMA app_knowledge TO liaison_definer;
--> statement-breakpoint
-- A migration login that is not a superuser hands the functions over only if
-- their new owner may create in the schema; taken back below.
GRANT CREATE ON SCHEMA app_knowledge TO liaison_definer;
--> statement-breakpoint
GRANT SELECT ON app_knowledge.collections, app_knowledge.collection_memberships,
  app_knowledge.source_links, app_knowledge.synced_sources TO liaison_definer;
--> statement-breakpoint
GRANT UPDATE (parent_collection_id, updated_at) ON app_knowledge.collections TO liaison_definer;
--> statement-breakpoint
GRANT INSERT, DELETE ON app_knowledge.collection_memberships TO liaison_definer;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL
GRANT EXECUTE ON FUNCTION app_knowledge.app_has_scope(text) TO liaison_definer;
--> statement-breakpoint

-- Everything filed in a folder of the transaction's person moves to its parent,
-- pages that person cannot read and archived ones included: deleting a folder
-- hides no page. At the top of a section (or under a folder of another section)
-- the pages are filed nowhere and the subfolders go to the top.
CREATE OR REPLACE FUNCTION app_knowledge.empty_folder_into_parent(p_folder uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := NULLIF(rls_ctx.org_id(), '')::uuid;
  v_user uuid := NULLIF(rls_ctx.user_id(), '')::uuid;
  v_owner uuid;
  v_parent uuid;
  v_target uuid;
BEGIN
  IF app_knowledge.app_has_scope('knowledge:collections:manage') IS NOT TRUE THEN
    RAISE EXCEPTION 'empty_folder_into_parent: not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT c.owner_user_id, c.parent_collection_id INTO v_owner, v_parent
    FROM app_knowledge.collections c
   WHERE c.id = p_folder AND c.org_id = v_org
     AND (c.owner_user_id IS NULL OR c.owner_user_id = v_user)
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'empty_folder_into_parent: no such folder' USING ERRCODE = '42501';
  END IF;
  SELECT c.id INTO v_target
    FROM app_knowledge.collections c
   WHERE c.id = v_parent AND c.org_id = v_org AND c.archived_at IS NULL
     AND c.owner_user_id IS NOT DISTINCT FROM v_owner;
  IF v_target IS NOT NULL THEN
    INSERT INTO app_knowledge.collection_memberships
      (org_id, collection_id, target_type, target_id, created_by, created_at)
    SELECT m.org_id, v_target, m.target_type, m.target_id, m.created_by, m.created_at
      FROM app_knowledge.collection_memberships m
     WHERE m.collection_id = p_folder AND m.org_id = v_org
    ON CONFLICT (org_id, collection_id, target_type, target_id) DO NOTHING;
  END IF;
  DELETE FROM app_knowledge.collection_memberships m
   WHERE m.collection_id = p_folder AND m.org_id = v_org;
  UPDATE app_knowledge.collections c
     SET parent_collection_id = v_target, updated_at = now()
   WHERE c.parent_collection_id = p_folder AND c.org_id = v_org;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_knowledge.empty_folder_into_parent(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_knowledge.empty_folder_into_parent(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL
GRANT EXECUTE ON FUNCTION app_knowledge.empty_folder_into_parent(uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint

-- True when making the tree personal hides nothing of anybody else: no live page
-- or source link created or owned by another person, no live folder of another
-- person. A yes or no, so it names nothing the person cannot read.
CREATE OR REPLACE FUNCTION app_knowledge.folder_tree_is_only_mine(p_folder uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := NULLIF(rls_ctx.org_id(), '')::uuid;
  v_user uuid := NULLIF(rls_ctx.user_id(), '')::uuid;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM app_knowledge.collections c
     WHERE c.id = p_folder AND c.org_id = v_org
       AND (c.owner_user_id IS NULL OR c.owner_user_id = v_user)
  ) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    WITH RECURSIVE tree AS (
      SELECT c.id, c.owner_user_id, c.archived_at
        FROM app_knowledge.collections c WHERE c.id = p_folder AND c.org_id = v_org
      UNION
      SELECT c.id, c.owner_user_id, c.archived_at
        FROM app_knowledge.collections c
        JOIN tree t ON c.parent_collection_id = t.id AND c.org_id = v_org
    )
    SELECT 1 FROM tree t
     WHERE t.archived_at IS NULL AND t.owner_user_id IS NOT NULL AND t.owner_user_id <> v_user
    UNION ALL
    SELECT 1 FROM tree t
      JOIN app_knowledge.collection_memberships m ON m.collection_id = t.id AND m.target_type = 'document'
      JOIN app_knowledge.documents d ON d.id = m.target_id AND d.org_id = m.org_id AND d.archived_at IS NULL
     WHERE d.created_by IS DISTINCT FROM v_user OR COALESCE(d.owner_user_id, v_user) <> v_user
    UNION ALL
    SELECT 1 FROM tree t
      JOIN app_knowledge.collection_memberships m ON m.collection_id = t.id AND m.target_type = 'source_link'
      JOIN app_knowledge.source_links l ON l.id = m.target_id AND l.org_id = m.org_id AND l.archived_at IS NULL
     WHERE l.owner_user_id IS DISTINCT FROM v_user
  );
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_knowledge.folder_tree_is_only_mine(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_knowledge.folder_tree_is_only_mine(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE, no dynamic SQL
GRANT EXECUTE ON FUNCTION app_knowledge.folder_tree_is_only_mine(uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint
-- expand-safe: takes back the right this file granted for the hand-over above; nothing else uses it.
REVOKE CREATE ON SCHEMA app_knowledge FROM liaison_definer;
