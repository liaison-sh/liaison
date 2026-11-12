-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.app_adoptions: the data steps the platform ran once when an app that
-- used to ship in the server's source tree became a catalog app of the same
-- name (modules/apps/moved-apps.ts). One row per (app, step) that completed,
-- with what it changed. Instance-wide (no org column), privileged pool only:
-- written and read by the boot reconcile, never by a person.
--
-- New table, every statement re-runnable: the previous release never reads it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.app_adoptions (
  app_name text NOT NULL,
  step_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT app_adoptions_pk PRIMARY KEY (app_name, step_id)
);
--> statement-breakpoint
ALTER TABLE kernel.app_adoptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_adoptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.app_adoptions FROM liaison_rls;
