-- SPDX-License-Identifier: FSL-1.1-ALv2
-- App versions, health and rollback.
--
-- apps_active_version names the running version of each installed app. It now
-- also names the version that ran before it (`previous_version`): the server
-- keeps that version's files and `apps_installed` row, so a failed activation
-- switches back to it and an operator can roll back to it. `org_id` is reserved
-- for per-org installs and stays NULL: an install is instance-wide. One row per
-- (name, org_id), NULLs equal, so the reserved column never admits a second
-- instance-wide row.
--
-- app_activation_events records every activation of an app version: which
-- version it left and which it tried, whether it ran ('activated'), went back to
-- the previous version after failing its health gate ('switched_back'), or was
-- refused ('refused'). The reason is a code plus a short redacted message; the
-- full detail is in the server log. Instance-level, read and written through the
-- privileged connection only: liaison_rls gets nothing, and RLS is forced with
-- no policy as a second wall. Org admins see their own app states through the API.
--
-- kernel.apps gains the reason beside its `error` status, so the App store can
-- say why an app failed to load after a restart too.
--
-- Every statement is re-runnable.
ALTER TABLE kernel.apps_active_version ADD COLUMN IF NOT EXISTS previous_version text;
--> statement-breakpoint
ALTER TABLE kernel.apps_active_version ADD COLUMN IF NOT EXISTS org_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS apps_active_version_name_org_idx
  ON kernel.apps_active_version (name, org_id) NULLS NOT DISTINCT;
--> statement-breakpoint
ALTER TABLE kernel.apps ADD COLUMN IF NOT EXISTS problem_code text;
--> statement-breakpoint
ALTER TABLE kernel.apps ADD COLUMN IF NOT EXISTS problem_message text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.app_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app text NOT NULL,
  from_version text,
  to_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('activated', 'switched_back', 'refused')),
  reason_code text,
  reason_message text CHECK (reason_message IS NULL OR char_length(reason_message) <= 500),
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator', 'system')),
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_activation_events_app_at_idx
  ON kernel.app_activation_events (app, at DESC);
--> statement-breakpoint
ALTER TABLE kernel.app_activation_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_activation_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.app_activation_events FROM liaison_rls;
