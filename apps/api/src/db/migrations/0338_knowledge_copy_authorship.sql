-- SPDX-License-Identifier: FSL-1.1-ALv2
-- On a closed agreement's Knowledge copy, authorship reads nothing.
--
-- A signed agreement's Knowledge copy is written as the person who sent it, so that person is
-- its author. While the agreement is closed to the organization, only its current list reads
-- the copy: a sender taken off the list must read nothing of it, as its author or owner either.
-- Knowledge documents gain `author_reads` (true everywhere, as before); the agreement's list
-- follow (`kernel.restricted_access_follow`) sets it false on its copies while the agreement is
-- closed and true once it is open, and the kernel helper that writes a copy of a closed
-- agreement sets it false at once. Where it is false, the author and owner branch of the read
-- policy, the search projection and the restricted readers count nobody. Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a NOT NULL column with a constant default (no rewrite); the previous release never names it and reads every row as before
ALTER TABLE app_knowledge.documents ADD COLUMN IF NOT EXISTS author_reads boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- expand-safe: replaced in this transaction by 0117's policy with one more condition on the author branch, which shows the previous release less, never more
DROP POLICY IF EXISTS knowledge_documents_select ON app_knowledge.documents;
--> statement-breakpoint
-- expand-safe: 0117's policy, read through the rls_ctx readers, except that the author and owner branch also needs author_reads, true on every row the previous release wrote
CREATE POLICY knowledge_documents_select ON app_knowledge.documents FOR SELECT TO liaison_rls
  USING (
    org_id = rls_ctx.org_id()::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:documents:archive') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
    AND (
      (
        document_scope = 'personal'
        AND owner_user_id = rls_ctx.user_id()::uuid
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
        AND author_reads
        AND (
          created_by = rls_ctx.user_id()::uuid
          OR owner_user_id = rls_ctx.user_id()::uuid
        )
      )
    )
  );
--> statement-breakpoint
-- reviewed-dynamic: the UPDATE it executes is 0314's, on the registered table of a known type only; the one change is the Knowledge owner columns' authorship condition
-- expand-safe: same signature; every type but a closed agreement's Knowledge copy is computed exactly as before
CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(
  p_type text, p_resource_id uuid, p_org uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  -- An untagged context reads as the all-zero org: fall back to p_org as 0178 did for an unset one.
  v_org uuid := COALESCE(NULLIF(NULLIF((SELECT rls_ctx.org_id()), ''), '00000000-0000-0000-0000-000000000000')::uuid, p_org);
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
    WHEN 'kernel.dashboard' THEN ARRAY['owner_user_id']
    WHEN 'kernel.dashboard_table' THEN ARRAY['owner_user_id']
    WHEN 'kernel.company' THEN ARRAY['created_by']
  END;
  SELECT resource_table INTO v_table
    FROM kernel.shareable_resource_types WHERE resource_type = p_type;
  IF v_owner_cols IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'not a shareable resource type: %', p_type USING ERRCODE = '22023';
  END IF;
  -- A Knowledge document's author and owner count only where its authorship reads (0334).
  SELECT string_agg(format('SELECT r.%1$I::text AS uid WHERE r.%1$I IS NOT NULL', c)
           || CASE WHEN p_type = 'knowledge.document' THEN ' AND r.author_reads' ELSE '' END, ' UNION ')
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
  -- Without an org context the row matches nothing (r.org_id = NULL).
END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: the function body below runs no dynamic SQL; it replaces 0333's, which it repeats with the copies' authorship switch added
-- expand-safe: same signature and answers as 0333; the previous release calls it the same way
CREATE OR REPLACE FUNCTION kernel.restricted_access_follow(p_org uuid, p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_ctx text := NULLIF((SELECT rls_ctx.org_id()), '');
  v_app text;
  readers uuid[];
  targets text[];
  withdrawn text[] := ARRAY[]::text[];
  copies uuid[] := ARRAY[]::uuid[];
  copy_readers text[];
  reader_role text;
  doc uuid;
BEGIN
  IF p_org IS NULL OR p_id IS NULL OR (v_ctx IS NOT NULL AND v_ctx::uuid OPERATOR(pg_catalog.<>) p_org) THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_allowed');
  END IF;
  IF p_kind OPERATOR(pg_catalog.<>) ALL (ARRAY['agreements.agreement', 'knowledge.document']) THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_followed');
  END IF;
  v_app := pg_catalog.split_part(p_kind, '.', 1);
  readers := kernel.restricted_readers(p_org, 'restricted:' OPERATOR(pg_catalog.||) p_kind OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) p_id::text);
  targets := ARRAY[p_id::text];
  IF p_kind OPERATOR(pg_catalog.=) 'agreements.agreement'
     AND pg_catalog.to_regclass('app_agreements.agreement_versions') IS NOT NULL THEN
    targets := targets OPERATOR(pg_catalog.||) ARRAY(
      SELECT v.id::text FROM app_agreements.agreement_versions v
       WHERE v.agreement_id OPERATOR(pg_catalog.=) p_id AND v.org_id OPERATOR(pg_catalog.=) p_org);
  END IF;
  UPDATE kernel.client_actions
     SET visible_to = CASE WHEN readers IS NULL OR pg_catalog.cardinality(readers) OPERATOR(pg_catalog.=) 0
                           THEN NULL ELSE readers END
   WHERE org_id OPERATOR(pg_catalog.=) p_org AND target_app OPERATOR(pg_catalog.=) v_app
     AND target_id::text OPERATOR(pg_catalog.=) ANY (targets)
     AND visible_to IS DISTINCT FROM (CASE WHEN readers IS NULL OR pg_catalog.cardinality(readers) OPERATOR(pg_catalog.=) 0
                                           THEN NULL ELSE readers END);
  IF readers IS NOT NULL THEN
    UPDATE kernel.approval_requests SET resource_owner_id = requested_by
     WHERE org_id OPERATOR(pg_catalog.=) p_org AND status OPERATOR(pg_catalog.=) 'pending'
       AND tool_name OPERATOR(pg_catalog.~~) (v_app OPERATOR(pg_catalog.||) ':%')
       AND (current_payload->>'id' OPERATOR(pg_catalog.=) ANY (targets)
         OR current_payload->>'version_id' OPERATOR(pg_catalog.=) ANY (targets))
       AND requested_by OPERATOR(pg_catalog.=) ANY (readers)
       AND resource_owner_id IS DISTINCT FROM requested_by;
    WITH cancelled AS (
      UPDATE kernel.approval_requests
         SET status = 'cancelled', decided_at = pg_catalog.now(),
             reason = 'Cancelled: the record became visible to named people only, and the person who asked is not one of them'
       WHERE org_id OPERATOR(pg_catalog.=) p_org AND status OPERATOR(pg_catalog.=) 'pending'
         AND tool_name OPERATOR(pg_catalog.~~) (v_app OPERATOR(pg_catalog.||) ':%')
         AND (current_payload->>'id' OPERATOR(pg_catalog.=) ANY (targets)
           OR current_payload->>'version_id' OPERATOR(pg_catalog.=) ANY (targets))
         AND NOT (requested_by OPERATOR(pg_catalog.=) ANY (readers))
      RETURNING id::text AS id
    )
    SELECT COALESCE(pg_catalog.array_agg(c.id), ARRAY[]::text[]) INTO withdrawn FROM cancelled c;
  END IF;
  -- The agreement's Knowledge copies (one per signed version, closed to the organization):
  -- while the agreement is closed their people are exactly its list; once open, its list, the
  -- person who created it and the reader role the settings name. Role and dimension grants go
  -- while it is closed. The copies' search projection follows.
  IF p_kind OPERATOR(pg_catalog.=) 'agreements.agreement'
     AND pg_catalog.to_regclass('app_agreements.agreement_versions') IS NOT NULL
     AND pg_catalog.to_regclass('app_knowledge.documents') IS NOT NULL THEN
    copies := ARRAY(
      SELECT v.knowledge_document_id FROM app_agreements.agreement_versions v
        JOIN app_knowledge.documents d
          ON d.id OPERATOR(pg_catalog.=) v.knowledge_document_id
         AND d.org_id OPERATOR(pg_catalog.=) p_org
       WHERE v.agreement_id OPERATOR(pg_catalog.=) p_id AND v.org_id OPERATOR(pg_catalog.=) p_org
         AND v.knowledge_document_id IS NOT NULL);
    IF readers IS NOT NULL THEN
      copy_readers := ARRAY(SELECT r::text FROM pg_catalog.unnest(readers) AS r);
      reader_role := NULL;
    ELSE
      copy_readers := ARRAY(
        SELECT DISTINCT x.u FROM (
          SELECT s.user_id::text AS u FROM app_agreements.agreement_shares s
           WHERE s.agreement_id OPERATOR(pg_catalog.=) p_id AND s.org_id OPERATOR(pg_catalog.=) p_org
             AND s.removed_at IS NULL
          UNION
          SELECT a.created_by_user_id::text FROM app_agreements.agreements a
           WHERE a.id OPERATOR(pg_catalog.=) p_id AND a.org_id OPERATOR(pg_catalog.=) p_org
             AND a.created_by_user_id IS NOT NULL
        ) x);
      SELECT st.sow_reader_role_id::text INTO reader_role FROM app_agreements.agreements_settings st
       WHERE st.org_id OPERATOR(pg_catalog.=) p_org AND st.sow_reader_role_id IS NOT NULL
       LIMIT 1;
    END IF;
    FOREACH doc IN ARRAY copies LOOP
      DELETE FROM kernel.resource_grants g
       WHERE g.org_id OPERATOR(pg_catalog.=) p_org
         AND g.resource_type OPERATOR(pg_catalog.=) 'knowledge.document'
         AND g.resource_id OPERATOR(pg_catalog.=) doc
         AND NOT ((g.grantee_kind OPERATOR(pg_catalog.=) 'user'
                   AND g.grantee OPERATOR(pg_catalog.=) ANY (copy_readers))
               OR (g.grantee_kind OPERATOR(pg_catalog.=) 'role' AND reader_role IS NOT NULL
                   AND g.grantee OPERATOR(pg_catalog.=) reader_role));
      INSERT INTO kernel.resource_grants (org_id, resource_type, resource_id, grantee_kind, grantee, role)
      SELECT p_org, 'knowledge.document', doc, 'user', u, 'viewer'
        FROM pg_catalog.unnest(copy_readers) AS u
      ON CONFLICT (resource_type, resource_id, grantee_kind, grantee) DO NOTHING;
      IF reader_role IS NOT NULL THEN
        INSERT INTO kernel.resource_grants (org_id, resource_type, resource_id, grantee_kind, grantee, role)
        VALUES (p_org, 'knowledge.document', doc, 'role', reader_role, 'viewer')
        ON CONFLICT (resource_type, resource_id, grantee_kind, grantee) DO NOTHING;
      END IF;
      -- Authorship reads a copy only while the agreement is open (closed: the list alone).
      UPDATE app_knowledge.documents d
         SET author_reads = (readers IS NULL)
       WHERE d.id OPERATOR(pg_catalog.=) doc AND d.org_id OPERATOR(pg_catalog.=) p_org
         AND d.author_reads IS DISTINCT FROM (readers IS NULL);
      PERFORM kernel.recompute_search_acl('knowledge.document', doc, p_org);
    END LOOP;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'state', 'followed',
    'readers', pg_catalog.to_jsonb(readers),
    'withdrawn', pg_catalog.to_jsonb(withdrawn),
    'copies', pg_catalog.to_jsonb(copies));
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.restricted_access_follow(uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.restricted_access_follow(uuid, text, uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: the function body below runs no dynamic SQL; it replaces 0333's, the Knowledge branch's author and owner counted only where authorship reads
-- expand-safe: same signature; a document whose authorship reads (every document but a closed agreement's copy) answers as before
CREATE OR REPLACE FUNCTION kernel.restricted_readers(p_org uuid, p_scope text)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  parts text[];
  rid uuid;
  access text;
  readers uuid[];
BEGIN
  parts := pg_catalog.regexp_split_to_array(p_scope, ':');
  IF pg_catalog.cardinality(parts) OPERATOR(pg_catalog.<>) 3
     OR parts[1] OPERATOR(pg_catalog.<>) 'restricted'
     OR parts[3] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  rid := parts[3]::uuid;
  IF parts[2] OPERATOR(pg_catalog.=) 'agreements.agreement' THEN
    IF pg_catalog.to_regclass('app_agreements.agreements') IS NULL THEN
      RETURN ARRAY[]::uuid[];
    END IF;
    SELECT a.org_access INTO access FROM app_agreements.agreements a
     WHERE a.id OPERATOR(pg_catalog.=) rid AND a.org_id OPERATOR(pg_catalog.=) p_org;
    IF access IS NULL THEN
      RETURN ARRAY[]::uuid[];
    END IF;
    IF access OPERATOR(pg_catalog.<>) 'none' THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.user_id), ARRAY[]::uuid[]) INTO readers
      FROM app_agreements.agreement_shares s
     WHERE s.agreement_id OPERATOR(pg_catalog.=) rid
       AND s.org_id OPERATOR(pg_catalog.=) p_org
       AND s.removed_at IS NULL;
    RETURN readers;
  END IF;
  IF parts[2] OPERATOR(pg_catalog.=) 'knowledge.document' THEN
    IF pg_catalog.to_regclass('app_knowledge.documents') IS NULL THEN
      RETURN ARRAY[]::uuid[];
    END IF;
    SELECT d.org_access INTO access FROM app_knowledge.documents d
     WHERE d.id OPERATOR(pg_catalog.=) rid AND d.org_id OPERATOR(pg_catalog.=) p_org;
    IF access IS NULL THEN
      RETURN ARRAY[]::uuid[];
    END IF;
    IF access OPERATOR(pg_catalog.<>) 'none' THEN
      RETURN NULL;
    END IF;
    -- Knowledge's own rule: the people the document is granted to, by name or through a role
    -- they hold, and its owner and author where authorship reads (not on a closed agreement's copy).
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.user_id), ARRAY[]::uuid[]) INTO readers
      FROM (
        SELECT g.grantee::uuid AS user_id FROM kernel.resource_grants g
         WHERE g.resource_type OPERATOR(pg_catalog.=) 'knowledge.document'
           AND g.resource_id OPERATOR(pg_catalog.=) rid AND g.org_id OPERATOR(pg_catalog.=) p_org
           AND g.grantee_kind OPERATOR(pg_catalog.=) 'user'
        UNION
        SELECT ur.user_id FROM kernel.resource_grants g
          JOIN kernel.user_roles ur
            ON ur.role_id::text OPERATOR(pg_catalog.=) g.grantee
           AND ur.org_id OPERATOR(pg_catalog.=) g.org_id
         WHERE g.resource_type OPERATOR(pg_catalog.=) 'knowledge.document'
           AND g.resource_id OPERATOR(pg_catalog.=) rid AND g.org_id OPERATOR(pg_catalog.=) p_org
           AND g.grantee_kind OPERATOR(pg_catalog.=) 'role'
        UNION
        SELECT d.created_by FROM app_knowledge.documents d
         WHERE d.id OPERATOR(pg_catalog.=) rid AND d.org_id OPERATOR(pg_catalog.=) p_org
           AND d.created_by IS NOT NULL AND d.author_reads
        UNION
        SELECT d.owner_user_id FROM app_knowledge.documents d
         WHERE d.id OPERATOR(pg_catalog.=) rid AND d.org_id OPERATOR(pg_catalog.=) p_org
           AND d.owner_user_id IS NOT NULL AND d.author_reads
      ) x;
    RETURN readers;
  END IF;
  RETURN ARRAY[]::uuid[];
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.restricted_readers(uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.restricted_readers(uuid, text) TO liaison_admin;
