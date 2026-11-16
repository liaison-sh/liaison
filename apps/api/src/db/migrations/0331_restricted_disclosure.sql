-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Restricted records: what a read of one touches stays with the people on its list.
--
-- A read of a row closed to the organization (`org_access = 'none'`: an agreement, a
-- Knowledge document) stamps the turn with the taint scope
-- `restricted:<app>.<entity>:<id>`. No grant ever covers such a scope, `*` included: the
-- people who may read what the turn wrote are the row's list, nobody else.
--
-- 1. kernel.restricted_readers(org, scope): the list behind one restricted scope, read by
--    the kernel's privileged code only (the stamping writer of messages and the taint
--    judgement). NULL when the row is no longer restricted (the scope then adds nothing);
--    an empty array when the row is unknown (nobody holds it).
-- 2. kernel.restricted_among(org, kind, ids): which ids of a read's result are restricted,
--    the lookup behind the stamp.
-- 3. kernel.scopes_covered never covers a `restricted:` entry, so the messages policy (0249)
--    admits a message stamped with one only through the other branch, its disclosure list,
--    which the stamping writer fills with the list. The rest of the policy is unchanged:
--    a message whose stamp holds a restricted entry is read by the people on its disclosure
--    list who also hold every other scope of its stamp.
-- Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
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
    -- Knowledge's own rule (0002): the people the document is shared with, and its author.
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.user_id), ARRAY[]::uuid[]) INTO readers
      FROM (
        SELECT s.user_id FROM app_knowledge.document_shares s
         WHERE s.document_id OPERATOR(pg_catalog.=) rid AND s.org_id OPERATOR(pg_catalog.=) p_org
        UNION
        SELECT d.created_by FROM app_knowledge.documents d
         WHERE d.id OPERATOR(pg_catalog.=) rid AND d.org_id OPERATOR(pg_catalog.=) p_org
           AND d.created_by IS NOT NULL
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
--> statement-breakpoint
-- Which of these ids name a restricted row (`org_access = 'none'`) of one kind, in one org:
-- the kernel's lookup after a read tool returns (the stamp), never a handler's or a model's.
CREATE OR REPLACE FUNCTION kernel.restricted_among(p_org uuid, p_kind text, p_ids text[])
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  ids uuid[];
  found text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO ids
    FROM pg_catalog.unnest(p_ids) AS x
   WHERE x ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  IF pg_catalog.cardinality(ids) OPERATOR(pg_catalog.=) 0 THEN
    RETURN ARRAY[]::text[];
  END IF;
  IF p_kind OPERATOR(pg_catalog.=) 'agreements.agreement' THEN
    IF pg_catalog.to_regclass('app_agreements.agreements') IS NULL THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(a.id::text), ARRAY[]::text[]) INTO found
      FROM app_agreements.agreements a
     WHERE a.id OPERATOR(pg_catalog.=) ANY (ids) AND a.org_id OPERATOR(pg_catalog.=) p_org
       AND a.org_access OPERATOR(pg_catalog.=) 'none';
    RETURN found;
  END IF;
  IF p_kind OPERATOR(pg_catalog.=) 'knowledge.document' THEN
    IF pg_catalog.to_regclass('app_knowledge.documents') IS NULL THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(d.id::text), ARRAY[]::text[]) INTO found
      FROM app_knowledge.documents d
     WHERE d.id OPERATOR(pg_catalog.=) ANY (ids) AND d.org_id OPERATOR(pg_catalog.=) p_org
       AND d.org_access OPERATOR(pg_catalog.=) 'none';
    RETURN found;
  END IF;
  RAISE EXCEPTION 'restricted_among: unknown kind %', p_kind;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.restricted_among(uuid, text, text[]) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.restricted_among(uuid, text, text[]) TO liaison_admin;
--> statement-breakpoint
-- expand-safe: covers exactly what 0249's version covers, minus `restricted:` entries, which no stamp held before this release.
CREATE OR REPLACE FUNCTION kernel.scopes_covered(required text[], cover jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  r text;
  i integer;
  j integer;
  hit boolean;
BEGIN
  IF required IS NULL OR cover IS NULL THEN
    RETURN required IS NOT NULL AND pg_catalog.cardinality(required) OPERATOR(pg_catalog.=) 0;
  END IF;
  FOREACH r IN ARRAY required LOOP
    IF r IS NULL OR r OPERATOR(pg_catalog.=) '' THEN
      RETURN false;
    END IF;
    -- A restricted record's scope: no grant covers it, `*` included.
    IF pg_catalog.left(r, 11) OPERATOR(pg_catalog.=) 'restricted:' THEN
      RETURN false;
    END IF;
    CONTINUE WHEN cover OPERATOR(pg_catalog.?) '*'
      OR cover OPERATOR(pg_catalog.?) ('=' OPERATOR(pg_catalog.||) r);
    hit := false;
    i := 0;
    LOOP
      j := pg_catalog.strpos(pg_catalog.substr(r, i OPERATOR(pg_catalog.+) 1), ':');
      EXIT WHEN j OPERATOR(pg_catalog.=) 0;
      i := i OPERATOR(pg_catalog.+) j;
      IF cover OPERATOR(pg_catalog.?) ('>' OPERATOR(pg_catalog.||) pg_catalog.left(r, i)) THEN
        hit := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT hit THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;
--> statement-breakpoint
-- The rest of a restricted stamp: every entry but the `restricted:` ones.
CREATE OR REPLACE FUNCTION kernel.scopes_unrestricted(required text[])
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN required IS NULL THEN NULL ELSE ARRAY(
    SELECT s FROM pg_catalog.unnest(required) WITH ORDINALITY AS u(s, n)
     WHERE s IS NULL OR pg_catalog.left(s, 11) OPERATOR(pg_catalog.<>) 'restricted:'
     ORDER BY n
  ) END
$fn$;
--> statement-breakpoint
-- expand-safe: a message with no restricted entry reads exactly as under 0249; one with a restricted entry (none before this release) is read by its disclosure list holding the rest of its stamp.
ALTER POLICY messages_select ON kernel.messages USING (
  org_id = ((SELECT rls_ctx.org_id()))::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = messages.thread_id
      AND tp.user_id = ((SELECT rls_ctx.user_id()))::uuid
      AND tp.org_id = ((SELECT rls_ctx.org_id()))::uuid
  )
  AND (
    kernel.scopes_covered(required_scopes, (SELECT kernel.scope_cover_keys((SELECT rls_ctx.scopes()))))
    OR (
      COALESCE(NULLIF((SELECT rls_ctx.user_id()), '') = ANY (disclosure_list::text[]), false)
      AND (
        NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(required_scopes) AS rq(s) WHERE pg_catalog.left(rq.s, 11) = 'restricted:')
        OR kernel.scopes_covered(kernel.scopes_unrestricted(required_scopes), (SELECT kernel.scope_cover_keys((SELECT rls_ctx.scopes()))))
      )
    )
  )
);
