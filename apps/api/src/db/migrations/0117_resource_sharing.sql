-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Generic, Drive-style sharing for any resource; Knowledge documents move onto
-- it and contacts adopt it.
--
-- THE MODEL (one mechanism, every shareable resource):
--   * the resource row carries `owner_user_id` and `org_access`
--     ('none' | 'viewer' | 'editor': what every member of the org gets);
--   * `kernel.resource_grants` holds explicit grants, each to a USER, a ROLE
--     (the JWT roles claim) or a DIMENSION value ("mail:inbox=<account id>":
--     whoever holds that dimension grant, so a grant to a shared mailbox follows
--     the mailbox's access instead of a copied user list that goes stale), each
--     as 'viewer' or 'editor';
--   * `kernel.resource_grant_role(type, id)` is THE evaluation: the strongest
--     role the current RLS actor holds through a grant, or NULL. Resource
--     policies call it; nothing else reads grants for authorization;
--   * who may change a resource's sharing is the resource type's own rule,
--     registered in `kernel.shareable_resource_types` as a function, and
--     dispatched by `kernel.can_manage_sharing(type, id)`, which the grants
--     table's write policies and the resource's own guard both use;
--   * search mirrors it with the existing ACL projection (org_wide,
--     acl_user_ids, acl_role_ids); a dimension grant is projected into
--     acl_role_ids as "dim:<key>=<value>" keys (and their wildcard forms), so no
--     new filterable attribute appears (modules/sharing, modules/search).
--
-- Knowledge keeps its exact semantics: its per-user and per-role share rows are
-- copied here, its two policies call resource_grant_role where they used to
-- query document_shares / document_role_shares, and sharing a document still
-- requires knowledge update or admin scope. The old tables are dropped once
-- copied.
--
-- Contacts: every existing contact becomes org_access 'editor', owner NULL:
-- exactly today's behaviour (every member reads and edits it). New contacts
-- discovered automatically are owner-only (personal mailbox) or granted to the
-- mailbox's access set (shared mailbox); only an explicit share makes one
-- org-wide (modules/contacts, modules/mail/sender-contacts.ts).

-- Bounded lock waits: the file takes locks on kernel.contacts and
-- app_knowledge.documents; behind a long transaction it fails fast and the
-- deploy retries, rather than queueing every reader behind it.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint

-- ── 1. Grants ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kernel.resource_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  grantee_kind  text NOT NULL CHECK (grantee_kind IN ('user', 'role', 'dimension')),
  grantee       text NOT NULL,
  role          text NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid
);
--> statement-breakpoint
ALTER TABLE kernel.resource_grants OWNER TO liaison_admin;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS resource_grants_unique
  ON kernel.resource_grants (resource_type, resource_id, grantee_kind, grantee);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resource_grants_grantee
  ON kernel.resource_grants (org_id, grantee_kind, grantee);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.resource_grants TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON kernel.resource_grants TO liaison_app;
--> statement-breakpoint
ALTER TABLE kernel.resource_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.resource_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── 2. Evaluation ────────────────────────────────────────────────────────────
-- Literal role membership against the JWT roles GUC (no wildcard: an admin does
-- not implicitly hold every role, exactly as app_knowledge.has_role).
CREATE OR REPLACE FUNCTION kernel.has_role(_role_id text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT _role_id = ANY(string_to_array(NULLIF(current_setting('app.current_roles', true), ''), ','))
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.has_role(text) OWNER TO liaison_admin;
--> statement-breakpoint

-- Does the session hold `_scope` (or a parent, or a wildcard) in the scopes GUC?
CREATE OR REPLACE FUNCTION kernel.has_scope(_scope text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT current_setting('app.current_scopes', true) = '*'
      OR EXISTS (
        SELECT 1
          FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
         WHERE g = '*' OR g = _scope OR starts_with(_scope, g || ':')
            OR g = split_part(_scope, ':', 1) || ':*'
      )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.has_scope(text) OWNER TO liaison_admin;
--> statement-breakpoint

-- Does the actor hold `value` (or a wildcard) on dimension `key`? Mirrors the
-- RLS generator's membership condition: a global "*" wildcard, the key's own
-- wildcard or value, under the full key ("mail:inbox") or its local form
-- ("inbox", how an unprefixed grant is aliased onto every app).
CREATE OR REPLACE FUNCTION kernel.has_dimension_value(_key text, _value text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  dims jsonb := NULLIF(current_setting('app.current_dimensions', true), '')::jsonb;
  local_key text := regexp_replace(_key, '^.*:', '');
BEGIN
  IF dims IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(dims->'*' @> '"*"'::jsonb, false)
    OR COALESCE(dims->_key @> '"*"'::jsonb, false)
    OR COALESCE(dims->_key @> to_jsonb(_value), false)
    OR COALESCE(dims->local_key @> '"*"'::jsonb, false)
    OR COALESCE(dims->local_key @> to_jsonb(_value), false);
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.has_dimension_value(text, text) OWNER TO liaison_admin;
--> statement-breakpoint

-- The strongest role the current actor holds on a resource through a grant.
-- SECURITY DEFINER so a resource policy can call it without recursing into the
-- grants table's own policy; it reads only the actor's GUCs.
CREATE OR REPLACE FUNCTION kernel.resource_grant_role(_type text, _id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
  SELECT CASE
           WHEN bool_or(g.role = 'editor') THEN 'editor'
           WHEN count(*) > 0 THEN 'viewer'
         END
    FROM kernel.resource_grants g
   WHERE g.resource_type = _type
     AND g.resource_id = _id
     AND g.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (
       (g.grantee_kind = 'user'
         AND g.grantee = NULLIF(current_setting('app.current_user_id', true), ''))
       OR (g.grantee_kind = 'role' AND kernel.has_role(g.grantee))
       OR (g.grantee_kind = 'dimension'
         AND kernel.has_dimension_value(split_part(g.grantee, '=', 1), split_part(g.grantee, '=', 2)))
     )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.resource_grant_role(text, uuid) OWNER TO liaison_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kernel.has_role(text), kernel.has_scope(text),
  kernel.has_dimension_value(text, text),
  kernel.resource_grant_role(text, uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint

-- ── 3. Who may change sharing: each resource type's own rule ────────────────
CREATE TABLE IF NOT EXISTS kernel.shareable_resource_types (
  resource_type  text PRIMARY KEY,
  can_manage     regprocedure NOT NULL,
  -- The resource's table: reading a grant needs read access to its resource.
  resource_table regclass NOT NULL
);
--> statement-breakpoint
ALTER TABLE kernel.shareable_resource_types OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.shareable_resource_types TO liaison_rls, liaison_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kernel.can_manage_sharing(_type text, _id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
DECLARE
  fn regprocedure;
  ok boolean;
BEGIN
  SELECT can_manage INTO fn FROM kernel.shareable_resource_types WHERE resource_type = _type;
  IF fn IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT %s($1)', fn::oid::regproc) INTO ok USING _id;
  RETURN COALESCE(ok, false);
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_manage_sharing(text, uuid) OWNER TO liaison_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kernel.can_manage_sharing(text, uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint

-- Can the current actor read the resource? SECURITY INVOKER on purpose: the
-- lookup runs under the caller's own RLS on the resource's table (whose
-- policies call the definer resource_grant_role, so there is no recursion).
CREATE OR REPLACE FUNCTION kernel.can_read_resource(_type text, _id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  tbl regclass;
  ok boolean;
BEGIN
  SELECT resource_table INTO tbl FROM kernel.shareable_resource_types WHERE resource_type = _type;
  IF tbl IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1)', tbl) INTO ok USING _id;
  RETURN COALESCE(ok, false);
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_read_resource(text, uuid) OWNER TO liaison_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kernel.can_read_resource(text, uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint

-- A grant is readable by whoever can read its resource (as in Drive, who sees
-- a file may see who else does), writable only by whoever may manage that
-- resource's sharing.
DROP POLICY IF EXISTS resource_grants_select ON kernel.resource_grants;
--> statement-breakpoint
CREATE POLICY resource_grants_select ON kernel.resource_grants FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND kernel.can_read_resource(resource_type, resource_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS resource_grants_write ON kernel.resource_grants;
--> statement-breakpoint
CREATE POLICY resource_grants_write ON kernel.resource_grants FOR ALL TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND kernel.can_manage_sharing(resource_type, resource_id)
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND kernel.can_manage_sharing(resource_type, resource_id)
  );
--> statement-breakpoint

-- ── 4. Knowledge documents move onto the grants ─────────────────────────────
-- Managing a document's sharing needs knowledge update or admin scope, exactly
-- the old document_shares / document_role_shares write policies; the service
-- additionally requires write access to the document.
CREATE OR REPLACE FUNCTION app_knowledge.can_manage_document_sharing(_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_knowledge.can_manage_document_sharing(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
VALUES ('knowledge.document', 'app_knowledge.can_manage_document_sharing(uuid)', 'app_knowledge.documents')
ON CONFLICT (resource_type) DO UPDATE
  SET can_manage = EXCLUDED.can_manage, resource_table = EXCLUDED.resource_table;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('app_knowledge.document_shares') IS NOT NULL THEN
    INSERT INTO kernel.resource_grants
      (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_at, created_by)
    SELECT org_id, 'knowledge.document', document_id, 'user', user_id::text, role, created_at, created_by
      FROM app_knowledge.document_shares
    ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('app_knowledge.document_role_shares') IS NOT NULL THEN
    INSERT INTO kernel.resource_grants
      (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_at, created_by)
    SELECT org_id, 'knowledge.document', document_id, 'role', role_id::text, role, created_at, created_by
      FROM app_knowledge.document_role_shares
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint

-- The two knowledge policies, carried forward verbatim except that each
-- EXISTS over a share table becomes one resource_grant_role call.
DROP POLICY IF EXISTS knowledge_documents_select ON app_knowledge.documents;
--> statement-breakpoint
CREATE POLICY knowledge_documents_select ON app_knowledge.documents FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:documents:archive') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
    AND (
      (
        document_scope = 'personal'
        AND owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND app_knowledge.app_has_scope('knowledge:documents:read')
      )
      OR (
        document_scope = 'organization'
        AND app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          org_access IN ('viewer', 'editor')
          OR kernel.resource_grant_role('knowledge.document', documents.id) IS NOT NULL
        )
      )
      OR (
        app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          created_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          OR owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
      )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS knowledge_documents_update ON app_knowledge.documents;
--> statement-breakpoint
CREATE POLICY knowledge_documents_update ON app_knowledge.documents FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (
      owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR created_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR (
        document_scope = 'organization'
        AND (
          org_access = 'editor'
          OR (edit_scope IS NOT NULL AND app_knowledge.has_exact_scope(edit_scope))
          OR kernel.resource_grant_role('knowledge.document', documents.id) = 'editor'
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
--> statement-breakpoint
DROP TABLE IF EXISTS app_knowledge.document_shares;
--> statement-breakpoint
DROP TABLE IF EXISTS app_knowledge.document_role_shares;
--> statement-breakpoint

-- ── 5. Contacts adopt the model ──────────────────────────────────────────────
ALTER TABLE kernel.contacts
  -- RESTRICT: a private contact is its owner's alone; deleting a user never
  -- silently drops or orphans it (a placeholder merge re-points it, erasure
  -- decides per contact: modules/contacts/erasure.ts).
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES kernel.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS org_access text NOT NULL DEFAULT 'editor',
  ADD COLUMN IF NOT EXISTS acl_user_ids jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS acl_role_ids jsonb NOT NULL DEFAULT '[]',
  -- The audience a restricted contact was made for ("mail:inbox=<account>",
  -- "tickets:team=<team>"): contacts are kept apart per audience, so one
  -- mailbox's or team's contact is never another's (strict separation);
  -- linking across audiences is an explicit share or merge.
  ADD COLUMN IF NOT EXISTS audience_key text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_restricted_has_audience') THEN
    ALTER TABLE kernel.contacts
      ADD CONSTRAINT contacts_restricted_has_audience
      CHECK (org_access <> 'none' OR owner_user_id IS NOT NULL OR audience_key IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_org_access_check') THEN
    ALTER TABLE kernel.contacts
      ADD CONSTRAINT contacts_org_access_check CHECK (org_access IN ('none', 'viewer', 'editor'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.contacts
  ADD COLUMN IF NOT EXISTS org_wide boolean
  GENERATED ALWAYS AS (org_access IN ('viewer', 'editor')) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_owner_idx
  ON kernel.contacts (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint

-- Existing contacts stay org-wide (org_access defaults to 'editor'); the
-- person who created one becomes its owner, so they may later take it back.
-- Contacts made by a system actor (mail sync, apps) have no owner.
UPDATE kernel.contacts c
   SET owner_user_id = c.created_by
 WHERE c.owner_user_id IS NULL
   AND c.created_by IS NOT NULL
   AND EXISTS (SELECT 1 FROM kernel.users u WHERE u.id = c.created_by);
--> statement-breakpoint

-- One address per audience: one org-visible contact per address; one private
-- contact per owner and address; one contact per (audience, address) for a
-- mailbox's or a team's contacts.
DROP INDEX IF EXISTS kernel.contacts_org_email_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_email_idx
  ON kernel.contacts (org_id, email) WHERE org_access <> 'none';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_owned_email_idx
  ON kernel.contacts (org_id, owner_user_id, email)
  WHERE org_access = 'none' AND owner_user_id IS NOT NULL AND audience_key IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_audience_email_idx
  ON kernel.contacts (org_id, audience_key, email)
  WHERE org_access = 'none' AND audience_key IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS kernel.contacts_org_phone_unique_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_phone_unique_idx
  ON kernel.contacts (org_id, phone) WHERE phone IS NOT NULL AND org_access <> 'none';
--> statement-breakpoint

-- A contact's sharing is managed by its owner. A contact nobody owns (a
-- shared mailbox's sender, an app's or the mail sync's org contact) by the
-- org's contact admins, and a mailbox's contact also by mail admins. Being
-- granted editor lets a person edit a contact, never re-share it.
CREATE OR REPLACE FUNCTION kernel.can_manage_contact_sharing(_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM kernel.contacts c
     WHERE c.id = _id
       AND c.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
       AND (
         c.owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (c.owner_user_id IS NULL AND (
               kernel.has_scope('kernel:contacts:admin')
               OR (c.audience_key LIKE 'mail:inbox=%' AND kernel.has_scope('mail:accounts:admin'))))
       )
  )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_manage_contact_sharing(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
VALUES ('kernel.contact', 'kernel.can_manage_contact_sharing(uuid)', 'kernel.contacts')
ON CONFLICT (resource_type) DO UPDATE
  SET can_manage = EXCLUDED.can_manage, resource_table = EXCLUDED.resource_table;
--> statement-breakpoint

DROP POLICY IF EXISTS contacts_org_rls ON kernel.contacts;
--> statement-breakpoint
DROP POLICY IF EXISTS contacts_select ON kernel.contacts;
--> statement-breakpoint
CREATE POLICY contacts_select ON kernel.contacts FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      org_access IN ('viewer', 'editor')
      OR owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR kernel.resource_grant_role('kernel.contact', id) IS NOT NULL
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contacts_insert ON kernel.contacts;
--> statement-breakpoint
CREATE POLICY contacts_insert ON kernel.contacts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    -- A person creates contacts they own, or org-wide ones nobody owns;
    -- never one owned by someone else, never an ownerless restricted one.
    AND (
      owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR (owner_user_id IS NULL AND org_access <> 'none')
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contacts_update ON kernel.contacts;
--> statement-breakpoint
CREATE POLICY contacts_update ON kernel.contacts FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      org_access = 'editor'
      OR owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR kernel.resource_grant_role('kernel.contact', id) = 'editor'
    )
  )
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS contacts_delete ON kernel.contacts;
--> statement-breakpoint
CREATE POLICY contacts_delete ON kernel.contacts FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      org_access = 'editor'
      OR owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR kernel.resource_grant_role('kernel.contact', id) = 'editor'
    )
  );
--> statement-breakpoint

-- What RLS cannot express on one row version: for an RLS caller the owner never
-- changes, and only a manager changes who a contact is shared with. Privileged
-- maintenance (the privatize CLI, the mail sync's sender resolution) runs as
-- liaison_admin and is not subject to it.
CREATE OR REPLACE FUNCTION kernel.contacts_sharing_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user <> 'liaison_rls' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The search ACL is derived (modules/sharing recomputes it as admin), and
    -- an audience (a mailbox's or a team's contact) is only ever set by the
    -- kernel for that audience: a person cannot plant a contact in it.
    NEW.acl_user_ids := '[]'::jsonb;
    NEW.acl_role_ids := '[]'::jsonb;
    NEW.audience_key := NULL;
    RETURN NEW;
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.audience_key IS DISTINCT FROM OLD.audience_key THEN
    RAISE EXCEPTION 'contact_owner_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.acl_user_ids IS DISTINCT FROM OLD.acl_user_ids
     OR NEW.acl_role_ids IS DISTINCT FROM OLD.acl_role_ids THEN
    RAISE EXCEPTION 'contact_acl_derived' USING ERRCODE = '42501';
  END IF;
  IF NEW.org_access IS DISTINCT FROM OLD.org_access
     AND NOT kernel.can_manage_sharing('kernel.contact', OLD.id) THEN
    RAISE EXCEPTION 'contact_sharing_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contacts_sharing_guard ON kernel.contacts;
--> statement-breakpoint
CREATE TRIGGER contacts_sharing_guard
  BEFORE INSERT OR UPDATE ON kernel.contacts
  FOR EACH ROW EXECUTE FUNCTION kernel.contacts_sharing_guard();
--> statement-breakpoint

-- The same for Knowledge documents, whose ACL projection (since 0008) an RLS
-- caller could otherwise write directly: it is derived, as admin, only.
CREATE OR REPLACE FUNCTION app_knowledge.documents_acl_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user <> 'liaison_rls' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.acl_user_ids := '[]'::jsonb;
    NEW.acl_role_ids := '[]'::jsonb;
    RETURN NEW;
  END IF;
  IF NEW.acl_user_ids IS DISTINCT FROM OLD.acl_user_ids
     OR NEW.acl_role_ids IS DISTINCT FROM OLD.acl_role_ids THEN
    RAISE EXCEPTION 'document_acl_derived' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_acl_guard ON app_knowledge.documents;
--> statement-breakpoint
CREATE TRIGGER documents_acl_guard
  BEFORE INSERT OR UPDATE ON app_knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION app_knowledge.documents_acl_guard();
--> statement-breakpoint

-- A deleted resource takes its grants with it.
CREATE OR REPLACE FUNCTION kernel.resource_grants_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
BEGIN
  DELETE FROM kernel.resource_grants
   WHERE resource_type = TG_ARGV[0] AND resource_id = OLD.id;
  RETURN OLD;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.resource_grants_cleanup() OWNER TO liaison_admin;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contacts_grants_cleanup ON kernel.contacts;
--> statement-breakpoint
CREATE TRIGGER contacts_grants_cleanup AFTER DELETE ON kernel.contacts
  FOR EACH ROW EXECUTE FUNCTION kernel.resource_grants_cleanup('kernel.contact');
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_grants_cleanup ON app_knowledge.documents;
--> statement-breakpoint
CREATE TRIGGER documents_grants_cleanup AFTER DELETE ON app_knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION kernel.resource_grants_cleanup('knowledge.document');
