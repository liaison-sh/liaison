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

--> statement-breakpoint
-- When a person was deactivated, on their row, by whatever path set the status (the member
-- door, a bulk change, an erasure, an import merge or a hand-run statement): the claim's 7 days
-- run from it. Set when the status becomes `deactivated`, cleared when it leaves it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a nullable column with no default; the previous release never reads or writes it
ALTER TABLE kernel.users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
--> statement-breakpoint
-- A person deactivated before this release: the last deactivation the audit log recorded, else
-- now (the 7 days then start today, never earlier than they did).
-- expand-safe: fills the new column only, on rows already deactivated
UPDATE kernel.users u
   SET deactivated_at = COALESCE(
     (SELECT max(l."timestamp") FROM kernel.audit_log l
       WHERE l.org_id = u.org_id AND l.entity_type = 'user' AND l.entity_id = u.id::text
         AND l.action = 'user.deactivate'),
     now())
 WHERE u.status = 'deactivated' AND u.deactivated_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.users_deactivated_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.status::text = 'deactivated' THEN
    IF TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'deactivated' THEN
      NEW.deactivated_at := now();
    END IF;
  ELSE
    NEW.deactivated_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.users_deactivated_at() FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: creates the trigger once, so the file stays re-runnable; no dynamic SQL
-- expand-safe: the trigger only stamps the new column, which the previous release never reads
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgname = 'users_deactivated_at'
                    AND t.tgrelid = 'kernel.users'::regclass) THEN
    CREATE TRIGGER users_deactivated_at BEFORE INSERT OR UPDATE OF status ON kernel.users
      FOR EACH ROW EXECUTE FUNCTION kernel.users_deactivated_at();
  END IF;
END
$do$;
--> statement-breakpoint
-- The claim reads the users' own stamp (above) instead of one kind of audit row.
-- expand-safe: same signature and answers; the previous release calls it the same way, and the 7 days now also count for a deactivation that wrote no audit row
CREATE OR REPLACE FUNCTION kernel.restricted_claim(p_agreement uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_user uuid := NULLIF((SELECT rls_ctx.user_id()), '')::uuid;
  v_access text;
  v_number text;
  v_named uuid[];
  v_last timestamptz;
  v_ever uuid[];
BEGIN
  IF v_org IS NULL OR v_user IS NULL
     OR NOT kernel.scopes_covered(ARRAY['kernel:users:admin'], kernel.scope_cover_keys((SELECT rls_ctx.scopes()))) THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_allowed');
  END IF;
  IF pg_catalog.to_regclass('app_agreements.agreements') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_found');
  END IF;
  SELECT a.org_access, a.number INTO v_access, v_number FROM app_agreements.agreements a
   WHERE a.id OPERATOR(pg_catalog.=) p_agreement AND a.org_id OPERATOR(pg_catalog.=) v_org
   FOR UPDATE;
  -- An open agreement, or one this org does not hold, answers the same: nothing to claim.
  IF v_access IS NULL OR v_access OPERATOR(pg_catalog.<>) 'none' THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_found');
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.user_id), ARRAY[]::uuid[]) INTO v_named
    FROM app_agreements.agreement_shares s
   WHERE s.agreement_id OPERATOR(pg_catalog.=) p_agreement
     AND s.org_id OPERATOR(pg_catalog.=) v_org AND s.removed_at IS NULL;
  IF v_user OPERATOR(pg_catalog.=) ANY (v_named) THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_found');
  END IF;
  -- Someone on the list still active (or a list naming nobody known): no row, no hint.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_named) AS n(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM kernel.users u
        WHERE u.id OPERATOR(pg_catalog.=) n.id AND u.org_id OPERATOR(pg_catalog.=) v_org
          AND u.status OPERATOR(pg_catalog.=) 'deactivated')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('state', 'not_found');
  END IF;
  -- When the last of them was deactivated: each user row's own stamp, whatever path did it.
  SELECT pg_catalog.max(u.deactivated_at) INTO v_last
    FROM kernel.users u
   WHERE u.org_id OPERATOR(pg_catalog.=) v_org AND u.id OPERATOR(pg_catalog.=) ANY (v_named);
  IF v_last IS NULL OR v_last OPERATOR(pg_catalog.>) (pg_catalog.now() OPERATOR(pg_catalog.-) interval '7 days') THEN
    RETURN pg_catalog.jsonb_build_object('state', 'too_soon');
  END IF;
  UPDATE app_agreements.agreement_shares SET removed_at = NULL, role = 'editor'
   WHERE agreement_id OPERATOR(pg_catalog.=) p_agreement AND org_id OPERATOR(pg_catalog.=) v_org
     AND user_id OPERATOR(pg_catalog.=) v_user;
  IF NOT FOUND THEN
    INSERT INTO app_agreements.agreement_shares (org_id, agreement_id, user_id, role, created_by)
    VALUES (v_org, p_agreement, v_user, 'editor', v_user);
  END IF;
  v_named := v_named OPERATOR(pg_catalog.||) v_user;
  UPDATE app_agreements.agreements
     SET claimed_by_user_id = v_user, claimed_at = pg_catalog.now(),
         acl_user_ids = (SELECT pg_catalog.to_jsonb(pg_catalog.array_agg(x::text ORDER BY x::text))
                           FROM pg_catalog.unnest(v_named) AS x)
   WHERE id OPERATOR(pg_catalog.=) p_agreement AND org_id OPERATOR(pg_catalog.=) v_org;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.user_id), ARRAY[]::uuid[]) INTO v_ever
    FROM app_agreements.agreement_shares s
   WHERE s.agreement_id OPERATOR(pg_catalog.=) p_agreement AND s.org_id OPERATOR(pg_catalog.=) v_org
     AND s.user_id OPERATOR(pg_catalog.<>) v_user;
  RETURN pg_catalog.jsonb_build_object(
    'state', 'claimed',
    'number', v_number,
    'visible_to', pg_catalog.to_jsonb(v_named),
    'ever_listed', pg_catalog.to_jsonb(v_ever));
END
$fn$;
