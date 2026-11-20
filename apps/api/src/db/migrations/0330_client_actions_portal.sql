-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Client actions and the client portal's kernel tables.
--
--   kernel.client_actions        one request to a person outside the org: sign,
--                                accept or approve one target. Members read it
--                                with kernel:client_actions:read, never its token
--                                hashes (column rights). Written only by the
--                                privileged path.
--   kernel.client_action_events  its trail, append only (the immutable trigger
--                                the app schemas use, one year).
--   kernel.client_action_devices the address and browser an event came from,
--                                readable with kernel:portal:logs only.
--   kernel.portal_shares         what a client company may see: closed unless a
--                                row is open. No kind exists for notes,
--                                discussions, agents, routines, cost or margin.
--   kernel.portal_people         one row per client who signs in to the portal.
--
-- The portal role reads views only, each owned by liaison_admin and guarded by its
-- own WHERE: the org, the caller's open company and an open share. A company that
-- is closed, or whose portal access ended, answers nothing from portal.company_id()
-- and portal.me, so every view goes empty on the next read.
--
-- A client holds no scope and no dimension grant either: the trigger that refuses a
-- role on an external row now guards the two grant tables too.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new value; the previous release never writes or reads it, and nothing in this file uses it
ALTER TYPE kernel.actor_type ADD VALUE IF NOT EXISTS 'external';
--> statement-breakpoint
ALTER TABLE kernel.companies
  ADD COLUMN portal_require_totp boolean NOT NULL DEFAULT false,
  ADD COLUMN portal_ended_at timestamptz,
  ADD COLUMN portal_ended_by uuid;
--> statement-breakpoint
CREATE TABLE kernel.client_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sign', 'accept', 'approve')),
  target_app text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
  company_id uuid REFERENCES kernel.companies(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES kernel.contacts(id) ON DELETE SET NULL,
  signer_user_id uuid,
  invited_email text NOT NULL CHECK (invited_email = lower(invited_email)),
  invited_name text NOT NULL,
  sign_order int,
  token_hash text CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prior_token_hashes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  first_opened_at timestamptz,
  document_shown_at timestamptz,
  code_wrong_total int NOT NULL DEFAULT 0 CHECK (code_wrong_total >= 0),
  code_locked_at timestamptz,
  decided_at timestamptz,
  decision text CHECK (decision IN ('signed', 'accepted', 'approved', 'declined')),
  decided_via text CHECK (decided_via IN ('link', 'portal')),
  decided_user_id uuid,
  code_verified_at timestamptz,
  typed_name text,
  capacity text,
  words_shown text,
  words_key text,
  words_lang text,
  required_phrase text,
  typed_phrase text,
  visible_to uuid[],
  decline_reason text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text CHECK (
    revoke_reason IN ('withdrawn', 'replaced', 'access_ended', 'person_removed', 'sender_voided')
  ),
  created_by_user_id uuid,
  created_by_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_actions_decided_has_decision CHECK ((decided_at IS NULL) = (decision IS NULL)),
  CONSTRAINT client_actions_decided_or_revoked CHECK (NOT (decided_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT client_actions_revoked_has_reason CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX client_actions_token_hash_key ON kernel.client_actions (token_hash)
  WHERE token_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX client_actions_prior_token_hashes_idx ON kernel.client_actions USING gin (prior_token_hashes);
--> statement-breakpoint
CREATE INDEX client_actions_target_idx ON kernel.client_actions (org_id, target_app, target_type, target_id);
--> statement-breakpoint
CREATE INDEX client_actions_open_company_idx ON kernel.client_actions (org_id, company_id)
  WHERE decided_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX client_actions_invited_email_idx ON kernel.client_actions (org_id, invited_email);
--> statement-breakpoint
CREATE INDEX client_actions_group_idx ON kernel.client_actions (org_id, group_id);
--> statement-breakpoint
CREATE TABLE kernel.client_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES kernel.client_actions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event IN (
    'created', 'sent', 'reminded', 'rotated', 'link_loaded', 'opened', 'document_shown',
    'document_downloaded', 'reached_end', 'code_sent', 'code_ok', 'code_wrong', 'paused',
    'locked', 'decided', 'declined', 'revoked', 'expired', 'copy_resent', 'not_me',
    'new_link_asked', 'invite_asked', 'question_asked'
  )),
  actor_kind text NOT NULL CHECK (actor_kind IN ('holder', 'portal_user', 'staff', 'agent', 'system')),
  actor_user_id uuid,
  mail_id text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX client_action_events_action_idx ON kernel.client_action_events (action_id, at);
--> statement-breakpoint
CREATE INDEX client_action_events_mail_idx ON kernel.client_action_events (org_id, mail_id)
  WHERE mail_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX client_action_events_retention_idx ON kernel.client_action_events (org_id, at);
--> statement-breakpoint
CREATE TABLE kernel.client_action_devices (
  event_id uuid PRIMARY KEY REFERENCES kernel.client_action_events(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  ip text,
  user_agent text
);
--> statement-breakpoint
CREATE TABLE kernel.portal_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES kernel.companies(id) ON DELETE CASCADE,
  -- The whole list of what a client can be shown. Notes, discussions, agents,
  -- routines, cost rates and margin have no kind, so no row can open them.
  kind text NOT NULL CHECK (kind IN (
    'project_progress', 'project_reports', 'project_hours', 'invoices', 'requests',
    'agreement', 'change_request', 'file', 'ticket'
  )),
  object_id uuid,
  shared_by_user_id uuid NOT NULL,
  shared_at timestamptz NOT NULL DEFAULT now(),
  only_user_ids uuid[],
  closed_at timestamptz,
  closed_by_user_id uuid,
  -- A company-wide kind names no object; every other kind names exactly one.
  CONSTRAINT portal_shares_object_check CHECK (
    (kind IN ('invoices', 'requests')) = (object_id IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX portal_shares_open_key ON kernel.portal_shares (company_id, kind, object_id)
  NULLS NOT DISTINCT WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX portal_shares_org_company_idx ON kernel.portal_shares (org_id, company_id);
--> statement-breakpoint
CREATE TABLE kernel.portal_people (
  user_id uuid PRIMARY KEY REFERENCES kernel.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES kernel.companies(id),
  contact_id uuid NOT NULL,
  title text,
  invited_by_user_id uuid,
  invited_at timestamptz NOT NULL DEFAULT now(),
  notice_ack_at timestamptz,
  notice_version int,
  last_sign_in_at timestamptz,
  removed_at timestamptz,
  sees_only_share_ids uuid[],
  sees_only_contact_ids uuid[]
);
--> statement-breakpoint
CREATE UNIQUE INDEX portal_people_contact_key ON kernel.portal_people (org_id, contact_id)
  WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE INDEX portal_people_company_idx ON kernel.portal_people (org_id, company_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kernel"."client_action_events_kernel_immutable_fn"() RETURNS TRIGGER AS $TRG_5ac57ca6a95aae92$ DECLARE k text; BEGIN   IF current_setting('liaison.retention_override', true) = 'on'      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;     RETURN NEW;   END IF;   IF TG_OP = 'DELETE' AND current_user = 'liaison_admin'      AND current_setting('liaison.demo_purge_org', true) = to_jsonb(OLD)->>'org_id' THEN     IF EXISTS (SELECT 1 FROM "kernel".organizations o WHERE o.id = (to_jsonb(OLD)->>'org_id')::uuid                AND (o.deleting_at IS NOT NULL                     OR (jsonb_typeof(o.settings->'demo') = 'object'                         AND o.settings->'demo'->>'variant' IN ('reserved', 'visitor')))) THEN       RETURN OLD;     END IF;   END IF;   IF TG_OP = 'DELETE' THEN     IF OLD."at" > now() - interval '1 years' THEN       RAISE EXCEPTION 'immutable_retention: a % row cannot be deleted within 1 years of its record', TG_TABLE_NAME USING ERRCODE = 'P0001';     END IF;     RETURN OLD;   END IF;   FOR k IN SELECT o.key FROM jsonb_each(to_jsonb(OLD)) o JOIN jsonb_each(to_jsonb(NEW)) n USING (key)            WHERE o.value <> 'null'::jsonb AND o.value IS DISTINCT FROM n.value AND o.key <> 'updated_at' LOOP     RAISE EXCEPTION 'immutable_row: %.% is immutable once set', TG_TABLE_NAME, k USING ERRCODE = 'P0001';   END LOOP;   RETURN NEW; END $TRG_5ac57ca6a95aae92$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "kernel_immutable" BEFORE UPDATE OR DELETE ON "kernel"."client_action_events"
  FOR EACH ROW EXECUTE FUNCTION "kernel"."client_action_events_kernel_immutable_fn"();
--> statement-breakpoint
ALTER TABLE kernel.client_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.client_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.client_action_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.client_action_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.client_action_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.client_action_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.portal_shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.portal_shares FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.portal_people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.portal_people FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The schema's default privileges hand new tables to the request role. Members
-- only read these, and a client action's token hashes not even that: every
-- write goes through the privileged path.
REVOKE ALL ON kernel.client_actions, kernel.client_action_events, kernel.client_action_devices,
  kernel.portal_shares, kernel.portal_people FROM liaison_rls, PUBLIC;
--> statement-breakpoint
GRANT SELECT (
  id, org_id, group_id, kind, target_app, target_type, target_id, target_sha256, company_id,
  contact_id, signer_user_id, invited_email, invited_name, sign_order, expires_at, sent_at,
  first_opened_at, document_shown_at, code_wrong_total, code_locked_at, decided_at, decision,
  decided_via, decided_user_id, code_verified_at, typed_name, capacity, words_shown, words_key,
  words_lang, required_phrase, typed_phrase, visible_to, decline_reason, revoked_at, revoked_by,
  revoke_reason, created_by_user_id, created_by_agent_id, created_at
) ON kernel.client_actions TO liaison_rls;
--> statement-breakpoint
GRANT SELECT ON kernel.client_action_events, kernel.client_action_devices,
  kernel.portal_shares, kernel.portal_people TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.client_actions, kernel.client_action_events,
  kernel.client_action_devices, kernel.portal_shares, kernel.portal_people TO liaison_admin, liaison_app;
--> statement-breakpoint
-- A restricted document's action is read only by the people it was opened to.
CREATE POLICY client_actions_select ON kernel.client_actions FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:client_actions:read'))
    AND (visible_to IS NULL OR (SELECT rls_ctx.user_id())::uuid = ANY (visible_to))
  );
--> statement-breakpoint
-- An event is read with its action: the subquery runs under the action's own policy.
CREATE POLICY client_action_events_select ON kernel.client_action_events FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (SELECT 1 FROM kernel.client_actions a WHERE a.id = action_id)
  );
--> statement-breakpoint
CREATE POLICY client_action_devices_select ON kernel.client_action_devices FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:portal:logs'))
    AND EXISTS (SELECT 1 FROM kernel.client_action_events e WHERE e.id = event_id)
  );
--> statement-breakpoint
CREATE POLICY portal_shares_select ON kernel.portal_shares FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND ((SELECT kernel.has_scope('kernel:portal:admin')) OR (SELECT kernel.has_scope('kernel:portal:share')))
  );
--> statement-breakpoint
CREATE POLICY portal_people_select ON kernel.portal_people FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('kernel:portal:admin'))
  );
--> statement-breakpoint
-- What a client did in the portal is read only by whoever holds the portal log scope.
-- expand-safe: the previous release writes no row with app = 'portal', so every row it reads passes
CREATE POLICY audit_log_portal_rows ON kernel.audit_log AS RESTRICTIVE FOR SELECT TO liaison_rls
  USING (app IS DISTINCT FROM 'portal' OR (SELECT kernel.has_scope('kernel:portal:logs')));
--> statement-breakpoint
-- portal.contact_id() runs as liaison_definer, which has no right on schema portal:
-- it repeats portal.company_id()'s conditions instead of calling it.
GRANT SELECT (user_id, org_id, company_id, contact_id, removed_at) ON kernel.portal_people TO liaison_definer;
--> statement-breakpoint
-- A login that is no superuser may hand a function only to a role holding
-- CREATE on its schema, so liaison_definer holds it for the length of the hand-over.
GRANT CREATE ON SCHEMA kernel TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION kernel.user_grants_member_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM kernel.users u WHERE u.id = NEW.user_id AND u.user_type = 'external') THEN
    RAISE EXCEPTION 'an external user holds no scope or dimension grant';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.user_grants_member_only() OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA kernel FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.user_grants_member_only() FROM PUBLIC;
--> statement-breakpoint
-- expand-safe: no external row holds a grant, so every grant the previous release writes passes
CREATE TRIGGER user_scope_grants_member_only BEFORE INSERT OR UPDATE OF user_id ON kernel.user_scope_grants
  FOR EACH ROW EXECUTE FUNCTION kernel.user_grants_member_only();
--> statement-breakpoint
-- expand-safe: no external row holds a grant, so every grant the previous release writes passes
CREATE TRIGGER user_dimension_grants_member_only BEFORE INSERT OR UPDATE OF user_id ON kernel.user_dimension_grants
  FOR EACH ROW EXECUTE FUNCTION kernel.user_grants_member_only();
--> statement-breakpoint
-- The caller's company only while it is open and its portal access has not ended.
-- expand-safe: same signature and owner; it answers for fewer callers, and no previous-release code calls it
CREATE OR REPLACE FUNCTION portal.company_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT u.company_id FROM kernel.users u
    JOIN kernel.companies c ON c.id = u.company_id
   WHERE u.id = (SELECT rls_ctx.user_id())::uuid
     AND c.org_id = (SELECT rls_ctx.org_id())::uuid
     AND u.user_type = 'external' AND u.status = 'active'
     AND c.closed_at IS NULL AND c.portal_ended_at IS NULL
$fn$;
--> statement-breakpoint
CREATE OR REPLACE VIEW portal.me WITH (security_barrier = true) AS
  SELECT u.id, u.name, u.email, u.locale, u.timezone, u.company_id
    FROM kernel.users u
   WHERE u.id = (SELECT rls_ctx.user_id())::uuid
     AND u.org_id = (SELECT rls_ctx.org_id())::uuid
     AND u.user_type = 'external' AND u.status = 'active'
     AND u.company_id = (SELECT portal.company_id());
--> statement-breakpoint
GRANT CREATE ON SCHEMA portal TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION portal.contact_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT p.contact_id FROM kernel.portal_people p
    JOIN kernel.users u ON u.id = p.user_id AND u.company_id = p.company_id
    JOIN kernel.companies c ON c.id = p.company_id
   WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
     AND p.org_id = (SELECT rls_ctx.org_id())::uuid
     AND c.org_id = p.org_id
     AND p.removed_at IS NULL
     AND u.user_type = 'external' AND u.status = 'active'
     AND c.closed_at IS NULL AND c.portal_ended_at IS NULL
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.contact_id() OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: granted above in this file, for the hand-over just made
REVOKE CREATE ON SCHEMA portal FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.contact_id() FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.contact_id() TO liaison_portal;
--> statement-breakpoint
-- The shares open to the caller's company, without the ones named for someone else.
CREATE VIEW portal.shares WITH (security_barrier = true) AS
  SELECT s.kind, s.object_id, s.shared_at
    FROM kernel.portal_shares s
   WHERE s.org_id = (SELECT rls_ctx.org_id())::uuid
     AND s.company_id = (SELECT portal.company_id())
     AND s.closed_at IS NULL
     AND (s.only_user_ids IS NULL OR (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids))
     AND NOT EXISTS (
       SELECT 1 FROM kernel.portal_people p
        WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
          AND p.sees_only_share_ids IS NOT NULL
          AND NOT (s.id = ANY (p.sees_only_share_ids))
     );
--> statement-breakpoint
ALTER VIEW portal.shares OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.shares TO liaison_portal;
--> statement-breakpoint
CREATE VIEW portal.people_me WITH (security_barrier = true) AS
  SELECT p.title, p.notice_ack_at, p.notice_version
    FROM kernel.portal_people p
   WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
     AND p.org_id = (SELECT rls_ctx.org_id())::uuid
     AND p.removed_at IS NULL
     AND p.company_id = (SELECT portal.company_id());
--> statement-breakpoint
ALTER VIEW portal.people_me OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.people_me TO liaison_portal;
--> statement-breakpoint
-- An action reaches the portal only through an open agreement or change request
-- share on its target. A restricted document's action needs that share to name the
-- caller; an unrestricted one is seen by whoever the share is open to.
CREATE VIEW portal.client_actions WITH (security_barrier = true) AS
  SELECT a.id, a.kind, a.target_app, a.target_type, a.target_id, a.invited_name, a.invited_email,
         a.expires_at, a.decided_at, a.decision, a.revoked_at, a.created_at
    FROM kernel.client_actions a
   WHERE a.org_id = (SELECT rls_ctx.org_id())::uuid
     AND a.company_id = (SELECT portal.company_id())
     AND EXISTS (
       SELECT 1 FROM kernel.portal_shares s
        WHERE s.org_id = a.org_id
          AND s.company_id = a.company_id
          AND s.kind IN ('agreement', 'change_request')
          AND s.object_id = a.target_id
          AND s.closed_at IS NULL
          AND CASE WHEN a.visible_to IS NULL
                   THEN s.only_user_ids IS NULL OR (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
                   ELSE s.only_user_ids IS NOT NULL AND (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
              END
          AND NOT EXISTS (
            SELECT 1 FROM kernel.portal_people p
             WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
               AND p.sees_only_share_ids IS NOT NULL
               AND NOT (s.id = ANY (p.sees_only_share_ids))
          )
     );
--> statement-breakpoint
ALTER VIEW portal.client_actions OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.client_actions TO liaison_portal;
