-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Why a turn that did not end `done` ended: `process` (the process running it
-- stopped or died and the turn could not be carried on), `turn` (it failed on
-- its own, a model or tool error) or `client` (its caller left before any
-- output). A deploy's counters count only `process`. Nullable with no
-- default: rows from before this migration have none, and the previous
-- release, which never writes it, keeps working during a rolling deploy.
-- Every turn write queues behind an ALTER waiting for a long transaction:
-- fail fast and retry the deploy instead.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kernel"."agent_turns" ADD COLUMN IF NOT EXISTS "failure_reason" text;
