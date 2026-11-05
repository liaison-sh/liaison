-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.durable_consumer_marks: "this consumer has already handled this
-- outbox event", one row per (consumer, event).
--
-- WHY IT IS PERSISTED. The outbox is at-least-once: a row stays unprocessed
-- until every durable consumer has run, so a consumer that already did its
-- work sees the same event again whenever ANOTHER consumer throws, or whenever
-- the process dies before `processed_at` is stamped. An in-process Set answers
-- that correctly until the process restarts, and then the replay is evaluated
-- against the world as it is NOW. For the push fanout that is A18's exact
-- failure: a recipient granted the scope in between is told about a message
-- that was invisible to them when it was sent. Deciding the question at the
-- event's own time is not available here, because the grant tables
-- (kernel.user_scope_grants, kernel.role_scope_grants, kernel.user_roles)
-- carry no created_at and no honest backfill exists for one, so the mark is
-- the durable answer instead.
--
-- It is NOT an outbox offset and NOT a delivery ledger: it says only that a
-- named consumer finished an event id, which is the smallest fact that closes
-- the restart gap. Rows are pruned with the outbox rows that produced them.
--
-- Written and read through the privileged (liaison_admin, BYPASSRLS)
-- connection alone: it is worker bookkeeping, not org data, so RLS is FORCED
-- with no policy at all and liaison_rls holds no grant on it. Every statement
-- is re-runnable, following the 0033/0045/0082/0088 convention.

CREATE TABLE IF NOT EXISTS kernel.durable_consumer_marks (
  consumer text NOT NULL,
  -- TEXT, not uuid: `DurableEventContext.eventId` is a string, and it is the
  -- outbox row id today only because that is what the worker passes. A type
  -- that refuses any other id would make this table the reason a caller could
  -- not use it.
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
--> statement-breakpoint

-- The prune predicate, run beside the outbox cleanup.
CREATE INDEX IF NOT EXISTS durable_consumer_marks_created_idx
  ON kernel.durable_consumer_marks (created_at);
--> statement-breakpoint

ALTER TABLE kernel.durable_consumer_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.durable_consumer_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- liaison_admin ALONE. Every reader and writer of this table runs as that role
-- (consumer-marks.ts through withPrivilegedDb, and the outbox worker's prune),
-- so a grant to liaison_app named a path that does not exist and invited one.
GRANT SELECT, INSERT, DELETE ON kernel.durable_consumer_marks TO liaison_admin;
--> statement-breakpoint
-- No policy exists, so these REVOKEs are belt and braces: an RLS-context caller
-- fails at the grant instead of silently reading zero rows. The liaison_app
-- line also takes back what the first version of this migration granted, so a
-- database that already ran it converges on the same state as a fresh one.
REVOKE ALL ON kernel.durable_consumer_marks FROM liaison_rls;
--> statement-breakpoint
REVOKE ALL ON kernel.durable_consumer_marks FROM liaison_app;
