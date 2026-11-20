-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A signed agreement's Knowledge copies follow its list.
--
-- Each signed version of an agreement has one Knowledge copy, closed to the organization and
-- shared by name (written once, as the person who sent it). When the agreement's list changes
-- later, `kernel.restricted_access_follow` (0332) now brings those copies' grants to it in the
-- same transaction as the client actions: while the agreement is closed the copies' people are
-- exactly its list (no role, no dimension grant); once open, its list, its creator and the
-- reader role its settings name. Nothing else of 0332's function changes.
--
-- `kernel.restricted_readers` reads a restricted Knowledge document's people from
-- `kernel.resource_grants` (users, and the members of granted roles), its owner and its
-- author: 0331 read `app_knowledge.document_shares`, which 0117 retired, so any read of a
-- restricted Knowledge stamp failed. Re-runnable.

-- reviewed-dynamic: the function body below runs no dynamic SQL; it replaces 0332's with the copies' grants added
-- expand-safe: same signature and answers (one more key, `copies`, which the previous release ignores); the previous release calls it the same way
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
-- reviewed-dynamic: the function body below runs no dynamic SQL; it replaces 0331's Knowledge branch
-- expand-safe: same signature and answers; the Knowledge branch reads the grants table that exists instead of failing on a retired one
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
    -- Knowledge's own rule (0117): the people the document is granted to, by name or through a
    -- role they hold, its owner and its author. (0331 read the share table 0117 retired.)
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
           AND d.created_by IS NOT NULL
        UNION
        SELECT d.owner_user_id FROM app_knowledge.documents d
         WHERE d.id OPERATOR(pg_catalog.=) rid AND d.org_id OPERATOR(pg_catalog.=) p_org
           AND d.owner_user_id IS NOT NULL
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
