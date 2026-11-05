-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.effect_ledger: outside effects happen once.
--
-- An effect a turn, a job or an app causes outside the database (a write tool,
-- an email, a webhook, a push, a remote API call) is claimed here by key
-- before it runs (`pending`, with the claiming process's instance id), and
-- marked `done` with its result after it ran. A second attempt with the same
-- key finds the `done` row and gets the stored result instead of repeating
-- the effect. A `pending` row whose claimer is no longer live, or older than
-- its TTL, is `unknown`: the effect may or may not have happened, and it is
-- not run again unless the caller can ask the remote side (lib/effect-once.ts).
--
-- Bookkeeping that holds effect results, never read by a person through a
-- route: written and read only through the privileged connection. RLS is
-- forced with no policy and the request roles get nothing (the deny-all
-- ledger template, 0182). A new table, so its keys take no lock on existing
-- data. Re-runnable.
--
-- The foreign keys take SHARE ROW EXCLUSIVE on the referenced tables, which
-- would queue behind a long transaction and block their writes for as long as
-- it waits; behind one, this fails fast and the deploy retries instead.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.effect_ledger (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 512),
  state text NOT NULL CHECK (state IN ('pending', 'done', 'unknown')),
  result jsonb,
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
--> statement-breakpoint
-- Retention prunes done rows by age.
CREATE INDEX IF NOT EXISTS effect_ledger_state_done_idx
  ON kernel.effect_ledger (state, done_at);
--> statement-breakpoint
ALTER TABLE kernel.effect_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.effect_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.effect_ledger FROM liaison_rls;
