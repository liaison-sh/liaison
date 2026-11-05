-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.secret_requests: a secret an agent asked a person to enter.
--
-- An agent never handles a secret (an API key, a password, an OAuth client
-- secret). When it needs one, `request_secret` files a row here and the
-- conversation shows a form card keyed by the row's id. The person types the
-- secret into the card, which posts it straight to the existing route that
-- stores that kind of secret (provider keys, connection credentials, OAuth
-- clients). The row itself never holds a secret: it names what is asked for
-- (`kind`, `target`), who asked and where, and, once the server has seen a new
-- secret stored for that target, the non-secret hint the agent is told.
--
-- `baseline` holds fingerprints (sha256 of the stored ciphertext, or of a key
-- row's id) of what was already stored for the target when the agent asked.
-- Completion is derived from the stored rows only: the request is saved when a
-- fingerprint appears that is not in the baseline. The client never claims it.
--
-- RLS: org data, read by the conversation's participants and the requester.
-- liaison_rls may read and insert (the agent's tool runs under the turn's RLS
-- context, as the requester, in a conversation they are in); every status
-- change (saved, cancelled, expired) and the claim of the agent's follow-up
-- turn go through the privileged connection, so liaison_rls gets no UPDATE or
-- DELETE policy.
--
-- Every statement is re-runnable.

CREATE TABLE IF NOT EXISTS kernel.secret_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  agent_id uuid,
  requested_by uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_key text NOT NULL,
  baseline text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  hint text,
  completed_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  turn_claimed_at timestamptz,
  CONSTRAINT secret_requests_kind_chk CHECK (
    kind IN ('byok', 'connection_credentials', 'oauth_client', 'google_login_client',
             'api_connector_credentials', 'api_key')
  ),
  CONSTRAINT secret_requests_status_chk CHECK (
    status IN ('pending', 'saved', 'cancelled', 'expired')
  ),
  CONSTRAINT secret_requests_hint_len_chk CHECK (hint IS NULL OR char_length(hint) <= 40)
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'secret_requests_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.secret_requests
      ADD CONSTRAINT secret_requests_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL (agent_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS secret_requests_pending_dedup_idx
  ON kernel.secret_requests (org_id, thread_id, kind, target_key)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS secret_requests_open_idx
  ON kernel.secret_requests (expires_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS secret_requests_thread_idx
  ON kernel.secret_requests (org_id, thread_id);
--> statement-breakpoint
ALTER TABLE kernel.secret_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.secret_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.secret_requests TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS secret_requests_select ON kernel.secret_requests;
--> statement-breakpoint
CREATE POLICY secret_requests_select ON kernel.secret_requests FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      requested_by = current_setting('app.current_user_id', true)::uuid
      OR kernel.is_thread_participant(thread_id, current_setting('app.current_user_id', true)::uuid)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS secret_requests_insert ON kernel.secret_requests;
--> statement-breakpoint
CREATE POLICY secret_requests_insert ON kernel.secret_requests FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND requested_by = current_setting('app.current_user_id', true)::uuid
    AND status = 'pending'
    AND kernel.is_thread_participant(thread_id, current_setting('app.current_user_id', true)::uuid)
  );
