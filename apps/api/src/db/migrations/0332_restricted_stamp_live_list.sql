-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A restricted stamp is read through the record's list as it is now, never as it was.
--
-- A message, an agent memory row or a thread checkpoint written by a turn that read a
-- restricted record carries `restricted:<app>.<entity>:<id>` in `required_scopes`. 0331 lets
-- the people on the message's stored disclosure list read it: that list is the record's list
-- at the time of writing, so a person later taken off the record's list kept reading what the
-- turn wrote. Each of those tables now also has a restrictive read policy: a row whose stamp
-- holds a restricted entry is read only by a person on that record's list today
-- (`kernel.restricted_readers`). A record open to the organization again hides nothing more.
-- Rows without a restricted entry read exactly as before. Re-runnable.

CREATE OR REPLACE FUNCTION kernel.restricted_stamp_visible(p_org uuid, p_required text[])
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_user text := NULLIF((SELECT rls_ctx.user_id()), '');
  entry text;
  readers uuid[];
BEGIN
  IF p_required IS NULL THEN
    RETURN true;
  END IF;
  FOREACH entry IN ARRAY p_required LOOP
    IF entry IS NOT NULL AND pg_catalog.left(entry, 11) OPERATOR(pg_catalog.=) 'restricted:' THEN
      readers := kernel.restricted_readers(p_org, entry);
      IF readers IS NOT NULL
         AND (v_user IS NULL OR NOT (v_user::uuid OPERATOR(pg_catalog.=) ANY (readers))) THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.restricted_stamp_visible(uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.restricted_stamp_visible(uuid, text[]) TO liaison_rls;
--> statement-breakpoint
-- reviewed-dynamic: creates each policy once, so the file stays re-runnable; no dynamic SQL
-- expand-safe: restrictive read policies only; a row with no restricted entry reads as under the previous release, and one with a restricted entry (none before 0331) is read by fewer people
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname = 'kernel' AND tablename = 'messages'
                    AND policyname = 'messages_restricted_stamp') THEN
    CREATE POLICY messages_restricted_stamp ON kernel.messages AS RESTRICTIVE FOR SELECT TO liaison_rls
      USING (
        NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(required_scopes) AS rq(s) WHERE pg_catalog.left(rq.s, 11) = 'restricted:')
        OR kernel.restricted_stamp_visible(org_id, required_scopes)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname = 'kernel' AND tablename = 'agent_memory'
                    AND policyname = 'agent_memory_restricted_stamp') THEN
    CREATE POLICY agent_memory_restricted_stamp ON kernel.agent_memory AS RESTRICTIVE FOR SELECT TO liaison_rls
      USING (
        NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(required_scopes) AS rq(s) WHERE pg_catalog.left(rq.s, 11) = 'restricted:')
        OR kernel.restricted_stamp_visible(org_id, required_scopes)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname = 'kernel' AND tablename = 'agent_thread_checkpoints'
                    AND policyname = 'agent_thread_checkpoints_restricted_stamp') THEN
    CREATE POLICY agent_thread_checkpoints_restricted_stamp ON kernel.agent_thread_checkpoints AS RESTRICTIVE FOR SELECT TO liaison_rls
      USING (
        NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(required_scopes) AS rq(s) WHERE pg_catalog.left(rq.s, 11) = 'restricted:')
        OR kernel.restricted_stamp_visible(org_id, required_scopes)
      );
  END IF;
END
$do$;
--> statement-breakpoint
-- The kernel's copies of a restricted record's list, brought to the list as it is now, inside
-- the transaction that changed it (the app's one writer, or the claim): the client actions of
-- the record and of its versions carry the list as `visible_to` while the record is closed and
-- nothing once it is open; while closed, its pending approvals become the asker's alone when
-- the asker is on the list, and are cancelled when not. The list is read here
-- (`kernel.restricted_readers`), never taken from the caller. A caller under row-level
-- security follows records of its own organization only. Returns the state, the readers and the
-- cancelled request ids (the caller announces them). Idempotent: the after-commit step runs it
-- again as a reconcile.
CREATE OR REPLACE FUNCTION kernel.restricted_access_follow(p_org uuid, p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_ctx text := NULLIF((SELECT rls_ctx.org_id()), '');
  v_app text;
  readers uuid[];
  targets text[];
  withdrawn text[] := ARRAY[]::text[];
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
  RETURN pg_catalog.jsonb_build_object(
    'state', 'followed',
    'readers', pg_catalog.to_jsonb(readers),
    'withdrawn', pg_catalog.to_jsonb(withdrawn));
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.restricted_access_follow(uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant on the function above, no dynamic SQL
GRANT EXECUTE ON FUNCTION kernel.restricted_access_follow(uuid, text, uuid) TO liaison_rls, liaison_admin;
