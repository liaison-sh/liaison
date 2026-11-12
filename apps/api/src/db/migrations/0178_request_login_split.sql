-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A request login that cannot elevate.
--
-- Request transactions (withRlsContext) used to run on the same login as the
-- privileged ones, liaison_app, a member of liaison_admin (BYPASSRLS) and
-- liaison_schema_admin, so any statement run from a request transaction could
-- `SET ROLE liaison_admin`: every org's rows, and as the owner of the app
-- tables, their policies. This adds:
--
--  1. liaison_request, the login the request pools use when
--     DATABASE_REQUEST_PASSWORD is set (db/connection.ts): a member of
--     liaison_rls and of nothing else, owner of nothing. The migration step
--     gives it LOGIN and its password (db/migrate.ts); here it is NOLOGIN.
--  2. liaison_definer, NOLOGIN, owner of the SECURITY DEFINER functions below
--     and of nothing else, with BYPASSRLS and only the table rights those
--     functions use. No runtime role is a member of it (a migration login
--     that is not a superuser is, to hand it the functions).
--  3. The functions, for the writes request transactions made elevated and
--     that must commit with them (the outbox insert needs none: liaison_rls
--     already holds an INSERT policy on pending_events). Each one touches only
--     rows of one org: the transaction's (app.current_org_id), and the org it
--     is given must be that one when the transaction has an org.
--
-- liaison_app is unchanged: it stays the privileged login (DATABASE_URL). Roles
-- are cluster wide, so everything here is idempotent. Re-runnable.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_request') THEN
    CREATE ROLE liaison_request NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_definer') THEN
    CREATE ROLE liaison_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
-- Re-asserted on a role that already existed (LOGIN and password left alone).
-- Each ALTER only when the role differs: an ALTER ROLE rewrites the cluster-wide
-- pg_authid row, and two databases migrating at once would collide on it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_request'
              AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    ALTER ROLE liaison_request NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_definer'
              AND (rolcanlogin OR rolsuper OR NOT rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    ALTER ROLE liaison_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
-- liaison_request is a member of liaison_rls only; liaison_definer of nothing,
-- and no runtime role is a member of either. liaison_portal, which a later
-- migration creates and gives to liaison_request, is left alone: roles are
-- cluster wide, and a replay of this file on another database of the same
-- cluster must not take back what the later migration gave.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT r.rolname AS role, u.rolname AS member
      FROM pg_auth_members a
      JOIN pg_roles r ON r.oid = a.roleid
      JOIN pg_roles u ON u.oid = a.member
     WHERE (u.rolname = 'liaison_request' AND r.rolname NOT IN ('liaison_rls', 'liaison_portal'))
        OR u.rolname = 'liaison_definer'
        OR (r.rolname IN ('liaison_request', 'liaison_definer') AND u.rolname <> current_user)
  LOOP
    EXECUTE format('REVOKE %I FROM %I', m.role, m.member);
  END LOOP;
  IF NOT pg_has_role('liaison_request', 'liaison_rls', 'MEMBER') THEN
    GRANT liaison_rls TO liaison_request;
  END IF;
  -- A migration login that is not a superuser needs the membership to hand
  -- the functions below to liaison_definer (the 0000 pattern for liaison_admin).
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND NOT pg_has_role(current_user, 'liaison_definer', 'MEMBER') THEN
    EXECUTE format('GRANT liaison_definer TO %I', current_user);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO liaison_request', current_database());
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA kernel, app_knowledge TO liaison_definer;
--> statement-breakpoint
-- kernel.recompute_search_acl
GRANT SELECT ON kernel.shareable_resource_types, kernel.resource_grants TO liaison_definer;
GRANT SELECT ON kernel.contacts, app_knowledge.documents TO liaison_definer;
GRANT UPDATE (acl_user_ids, acl_role_ids) ON kernel.contacts, app_knowledge.documents TO liaison_definer;
-- kernel.ensure_audience_contact
GRANT INSERT ON kernel.contacts, kernel.resource_grants TO liaison_definer;
GRANT USAGE ON SEQUENCE kernel.contact_handle_seq TO liaison_definer;
-- kernel.delete_deleted_message_attachments
GRANT SELECT, DELETE ON kernel.files TO liaison_definer;
-- kernel.lock_live_message (a row lock needs UPDATE on one column)
GRANT SELECT ON kernel.messages TO liaison_definer;
GRANT UPDATE (deleted_at) ON kernel.messages TO liaison_definer;
-- kernel.tickets_move_team_segment_code
GRANT SELECT ON kernel.organizations TO liaison_definer;
GRANT UPDATE (settings, updated_at) ON kernel.organizations TO liaison_definer;
--> statement-breakpoint

-- The search projection of a shareable resource (modules/sharing/service.ts
-- recomputeSearchAcl): acl_user_ids = its owner columns plus the users granted;
-- acl_role_ids = the roles granted plus, for each dimension grant key=value,
-- the keys searchKeysForDimension lists (dim:key=value, dim:local=value,
-- dim:key=*, dim:local=*, dim:*, local being the key after its last ':').
-- Derived from the database alone, for a row of the transaction's org, or of
-- `p_org` in a transaction without one (none without either).
CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(
  p_type text, p_resource_id uuid, p_org uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := COALESCE(NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org);
  v_table regclass;
  v_owner_cols text[];
  v_owner_union text;
BEGIN
  IF p_org IS NOT NULL AND p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'recompute_search_acl: not the transaction''s org' USING ERRCODE = '42501';
  END IF;
  v_owner_cols := CASE p_type
    WHEN 'kernel.contact' THEN ARRAY['owner_user_id']
    WHEN 'knowledge.document' THEN ARRAY['owner_user_id', 'created_by']
  END;
  SELECT resource_table INTO v_table
    FROM kernel.shareable_resource_types WHERE resource_type = p_type;
  IF v_owner_cols IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'not a shareable resource type: %', p_type USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(format('SELECT r.%1$I::text AS uid WHERE r.%1$I IS NOT NULL', c), ' UNION ')
    INTO v_owner_union FROM unnest(v_owner_cols) AS c;
  EXECUTE format($q$
    UPDATE %s r
       SET acl_user_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT u.uid), '[]'::jsonb) FROM (
               %s
               UNION
               SELECT g.grantee AS uid FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'user'
             ) u),
           acl_role_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT k.key), '[]'::jsonb) FROM (
               SELECT g.grantee AS key FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'role'
               UNION
               SELECT dk.key
                 FROM kernel.resource_grants g
                 CROSS JOIN LATERAL (
                   SELECT split_part(g.grantee, '=', 1) AS dim,
                          substr(g.grantee, strpos(g.grantee, '=') + 1) AS val
                 ) d
                 CROSS JOIN LATERAL unnest(ARRAY[
                   'dim:' || d.dim || '=' || d.val,
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=' || d.val,
                   'dim:' || d.dim || '=*',
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=*',
                   'dim:*'
                 ]) AS dk(key)
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'dimension'
             ) k)
     WHERE r.id = $2 AND r.org_id = $3
  $q$, v_table, v_owner_union) USING p_type, p_resource_id, v_org;
  -- Without an org context the row matches nothing, as the UPDATE this
  -- replaces did (r.org_id = NULL).
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.recompute_search_acl(text, uuid, uuid) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint

-- The private contact for one piece of team work (modules/contacts/
-- audience-contact.ts): the audience's contact for the address (dimension key
-- `key=value`, shared as editor with that audience, owned by nobody), or with
-- no audience the owner's own. Found, or created with its grant and search
-- projection. The caller queues the create event when `created`.
CREATE OR REPLACE FUNCTION kernel.ensure_audience_contact(
  p_org uuid, p_email text, p_name text, p_owner uuid, p_audience_key text
)
RETURNS TABLE (contact_id uuid, contact_handle text, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_org uuid := p_org;
  v_id uuid;
  v_handle text;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM COALESCE(
       NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org) THEN
    RAISE EXCEPTION '%: not the transaction''s org', 'ensure_audience_contact' USING ERRCODE = '42501';
  END IF;
  IF p_owner IS NULL AND p_audience_key IS NULL THEN
    RAISE EXCEPTION 'ensure_audience_contact: an owner or an audience' USING ERRCODE = '22023';
  END IF;
  IF p_audience_key IS NOT NULL AND p_audience_key !~* '^[a-z0-9_-]+(:[a-z0-9_-]+)?=[^=]+$' THEN
    RAISE EXCEPTION 'ensure_audience_contact: invalid audience %', p_audience_key USING ERRCODE = '22023';
  END IF;
  SELECT c.id, c.handle INTO v_id, v_handle
    FROM kernel.contacts c
   WHERE c.org_id = v_org AND c.org_access = 'none' AND LOWER(c.email) = p_email
     AND CASE WHEN p_audience_key IS NOT NULL
              THEN c.audience_key = p_audience_key AND c.owner_user_id IS NULL
              ELSE c.owner_user_id = p_owner AND c.audience_key IS NULL END
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_handle, false;
    RETURN;
  END IF;
  v_handle := '@contact-' || nextval('kernel.contact_handle_seq'::regclass)::text;
  INSERT INTO kernel.contacts
    (org_id, handle, email, name, org_access, owner_user_id, created_by, audience_key)
  VALUES (v_org, v_handle, p_email, p_name, 'none',
          CASE WHEN p_audience_key IS NULL THEN p_owner END, p_owner, p_audience_key)
  RETURNING id INTO v_id;
  IF p_audience_key IS NOT NULL THEN
    INSERT INTO kernel.resource_grants
      (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_by)
    VALUES (v_org, 'kernel.contact', v_id, 'dimension', p_audience_key, 'editor', p_owner)
    ON CONFLICT (resource_type, resource_id, grantee_kind, grantee) DO NOTHING;
  END IF;
  PERFORM kernel.recompute_search_acl('kernel.contact', v_id, v_org);
  RETURN QUERY SELECT v_id, v_handle, true;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.ensure_audience_contact(uuid, text, text, uuid, text) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.ensure_audience_contact(uuid, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.ensure_audience_contact(uuid, text, text, uuid, text) TO liaison_rls, liaison_admin;
--> statement-breakpoint

-- The attachment rows of soft-deleted messages of the transaction's org
-- (modules/files/message-attachments.ts): of the given messages, or of every
-- deleted message when the list is NULL. A live message's files are never
-- deleted here.
CREATE OR REPLACE FUNCTION kernel.delete_deleted_message_attachments(p_org uuid, p_message_ids uuid[])
RETURNS TABLE (id text, entity_id text, storage_key text, thumbnail_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
#variable_conflict use_column
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM COALESCE(
       NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org) THEN
    RAISE EXCEPTION '%: not the transaction''s org', 'delete_deleted_message_attachments' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH removed AS (
    DELETE FROM kernel.files f
     WHERE f.org_id = p_org
       AND f.app = 'kernel' AND f.entity_type = 'message'
       AND (p_message_ids IS NULL OR f.entity_id = ANY (p_message_ids::text[]))
       AND EXISTS (
         SELECT 1 FROM kernel.messages m
          WHERE m.id = (CASE WHEN f.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                             THEN f.entity_id::uuid END)
            AND m.org_id = f.org_id AND m.deleted_at IS NOT NULL)
    RETURNING f.id::text AS file_id, f.entity_id AS file_entity_id,
              f.storage_key AS file_storage_key, f.thumbnail_key AS file_thumbnail_key
  )
  SELECT r.file_id, r.file_entity_id, r.file_storage_key, r.file_thumbnail_key FROM removed r;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.delete_deleted_message_attachments(uuid, uuid[]) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.delete_deleted_message_attachments(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.delete_deleted_message_attachments(uuid, uuid[]) TO liaison_rls, liaison_admin;
--> statement-breakpoint

-- Lock a live message of the transaction's org FOR SHARE until the caller's
-- transaction ends (modules/files/service.ts lockLiveParent): an attach and a
-- message delete serialise. True when the message is there and not deleted.
CREATE OR REPLACE FUNCTION kernel.lock_live_message(p_org uuid, p_message_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM COALESCE(
       NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org) THEN
    RAISE EXCEPTION '%: not the transaction''s org', 'lock_live_message' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM kernel.messages m
   WHERE m.id = p_message_id
     AND m.org_id = p_org
     AND m.deleted_at IS NULL
     FOR SHARE;
  RETURN FOUND;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.lock_live_message(uuid, uuid) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.lock_live_message(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.lock_live_message(uuid, uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint

-- A team rename carries the team's ticket id segment code to the new name
-- (apps/tickets/display-handle.ts moveTeamSegmentCode), when the org segments
-- ticket ids by team. A name that already has a code keeps it and the old
-- name's code is dropped; otherwise the code moves.
CREATE OR REPLACE FUNCTION kernel.tickets_move_team_segment_code(p_org uuid, p_from text, p_to text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := p_org;
  v_seg jsonb;
  v_code jsonb;
  v_codes jsonb;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM COALESCE(
       NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org) THEN
    RAISE EXCEPTION '%: not the transaction''s org', 'tickets_move_team_segment_code' USING ERRCODE = '42501';
  END IF;
  SELECT o.settings->'tickets'->'idSegment' INTO v_seg
    FROM kernel.organizations o WHERE o.id = v_org FOR UPDATE;
  IF v_seg IS NULL OR jsonb_typeof(v_seg) <> 'object'
     OR v_seg->>'by' IS DISTINCT FROM 'team'
     OR jsonb_typeof(v_seg->'codes') IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;
  v_code := v_seg->'codes'->p_from;
  IF v_code IS NULL THEN
    RETURN;
  END IF;
  v_codes := (v_seg->'codes') - p_from;
  IF NOT (v_codes ? p_to) THEN
    v_codes := v_codes || jsonb_build_object(p_to, v_code);
  END IF;
  UPDATE kernel.organizations
     SET settings = jsonb_set(settings, '{tickets,idSegment,codes}', v_codes, true),
         updated_at = now()
   WHERE id = v_org;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.tickets_move_team_segment_code(uuid, text, text) OWNER TO liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.tickets_move_team_segment_code(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.tickets_move_team_segment_code(uuid, text, text) TO liaison_rls, liaison_admin;
