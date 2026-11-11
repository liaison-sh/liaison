-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.webhook_inbox: every verified app webhook delivery is stored before
-- its handler runs (modules/webhooks/inbox.ts).
--
-- The inbound route verifies the signature, stores the delivery here, then
-- runs the handler. A delivery whose handler fails, whose process dies before
-- it finished, or whose org is at an app day cap stays here and is replayed by
-- the `webhook-inbox-replay` job (backoff per attempt; the
-- `webhook-inbox-sweep` job re-wakes anything due whose job was lost). A
-- second delivery with the same verified identity (`delivery_hash`, the
-- sha256 of the verifier's replay key) is processed once while
-- `dedup_until` holds.
--
-- `due_at`: when a pending or held row is next tried, or when a processing
-- row's lease ends (its claimer is then presumed dead). `payload` and
-- `headers` are cleared once a row settles (done, rejected, dropped); a dead
-- row keeps them for diagnosis until retention deletes it. Rows go with their
-- org (ON DELETE CASCADE).
--
-- Bookkeeping never read by a person through a route: written and read only
-- through the privileged connection. RLS is forced with no policy and the
-- request roles get nothing (the deny-all ledger template, as 0226). A new
-- table: the previous release never reads or writes it. Re-runnable.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app_name text NOT NULL CHECK (char_length(app_name) BETWEEN 1 AND 128),
  endpoint_name text NOT NULL CHECK (char_length(endpoint_name) BETWEEN 1 AND 128),
  delivery_hash text NOT NULL CHECK (char_length(delivery_hash) BETWEEN 1 AND 256),
  dedup_until timestamptz NOT NULL,
  payload jsonb,
  headers jsonb,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (
    status IN ('processing', 'pending', 'held', 'done', 'rejected', 'dropped', 'dead')
  ),
  attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
--> statement-breakpoint
-- One row per verified delivery identity of an endpoint (dedup).
CREATE UNIQUE INDEX IF NOT EXISTS webhook_inbox_delivery_uq
  ON kernel.webhook_inbox (org_id, app_name, endpoint_name, delivery_hash);
--> statement-breakpoint
-- The sweep reads the unsettled rows that are due.
CREATE INDEX IF NOT EXISTS webhook_inbox_due_idx
  ON kernel.webhook_inbox (due_at)
  WHERE status IN ('processing', 'pending', 'held');
--> statement-breakpoint
-- Retention deletes settled rows by age.
CREATE INDEX IF NOT EXISTS webhook_inbox_settled_idx
  ON kernel.webhook_inbox (status, settled_at);
--> statement-breakpoint
ALTER TABLE kernel.webhook_inbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.webhook_inbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.webhook_inbox FROM liaison_rls;
