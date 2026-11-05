-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Demo spend ledger: what verified demo visitors spent on this box's model key.
--
-- A verified visitor's agents run on the box's key inside budgets kept in
-- Redis (modules/demo/demo-budget.ts). This table is their durable copy, so a
-- Redis flush or restart never resets a budget: every settled step is written
-- here FIRST, and a missing Redis counter is rehydrated from it.
--
--  - budget: which budget the counter is. 'email' (a normalized address, lifetime),
--    'net' (a client network, per UTC day), 'box' (the box, per UTC day),
--    'boxhour' (the box, per 5-minute bucket; the rolling hour sums 12).
--  - key: the email, the network, or 'box'.
--  - period: 'life', a UTC day (YYYY-MM-DD), or a bucket start (epoch ms).
--  - spent_micro_eur: integer micro-EUR, only ever increased.
--
-- Instance-level, not tenant data (an email's budget spans orgs): written and
-- read only through the privileged connection. liaison_rls gets nothing; RLS
-- is forced with no policy as a second wall (the demo_leads precedent).
-- Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.demo_spend (
  budget text NOT NULL CHECK (budget IN ('email', 'net', 'box', 'boxhour')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 320),
  period text NOT NULL CHECK (char_length(period) BETWEEN 1 AND 32),
  spent_micro_eur bigint NOT NULL DEFAULT 0 CHECK (spent_micro_eur >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (budget, key, period)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS demo_spend_updated_at_idx ON kernel.demo_spend (updated_at);
--> statement-breakpoint
ALTER TABLE kernel.demo_spend ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.demo_spend FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.demo_spend FROM liaison_rls;
