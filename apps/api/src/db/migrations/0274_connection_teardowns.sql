-- SPDX-License-Identifier: FSL-1.1-ALv2
-- What a removed OAuth connection still has to do at its provider (stop a push
-- watch, revoke the grant), durably and readable by any process: a disconnect
-- writes one row in its own transaction, moving the connection's encrypted
-- tokens here unchanged, and `modules/apps/connections/revoke.ts` works the row
-- off and deletes it. A row lives only until the provider answered, at most
-- three days through an outage, then the tokens are dropped and the failure logged.
--
-- No `org_id`: a row outlives its org's purge (`source_org_id` names it, no
-- foreign key), so a provider outage during an org deletion cannot leave a live
-- grant. Additive: a new table nobody reads before this release.
--
-- A disconnect may run under the owner's RLS, so the request role may INSERT a
-- row for its own org and nothing else: it can never read a token back.
CREATE TABLE IF NOT EXISTS kernel.connection_teardowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_org_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  app_name text NOT NULL,
  connection_name text NOT NULL,
  identifier text NOT NULL,
  oauth_client_source text NULL,
  oauth_client_id text NULL,
  access_token_encrypted text NULL,
  refresh_token_encrypted text NULL,
  token_expires_at timestamptz NULL,
  revocation_url text NULL,
  watch_stop_url text NULL,
  token_url text NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_connection_teardowns_due
  ON kernel.connection_teardowns (next_attempt_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_connection_teardowns_connection
  ON kernel.connection_teardowns (connection_id);
--> statement-breakpoint
ALTER TABLE kernel.connection_teardowns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.connection_teardowns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.connection_teardowns FROM liaison_rls;
--> statement-breakpoint
GRANT INSERT ON kernel.connection_teardowns TO liaison_rls;
--> statement-breakpoint
DROP POLICY IF EXISTS connection_teardowns_insert ON kernel.connection_teardowns;
--> statement-breakpoint
CREATE POLICY connection_teardowns_insert ON kernel.connection_teardowns FOR INSERT TO liaison_rls
  WITH CHECK (source_org_id = NULLIF(rls_ctx.org_id(), '')::uuid);
