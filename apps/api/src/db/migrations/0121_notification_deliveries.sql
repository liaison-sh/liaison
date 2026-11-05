-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.notification_deliveries (S1, A5, A10): one row per router decision
-- that held a live channel back, and one row per delivery attempt per device.
--
-- `notification_id` is the identity every payload carries (APNs custom data,
-- the desktop frame, the Web Push payload); it is deterministic per (user,
-- item), so a durable-event retry writes under the same id. `device_id` is NULL
-- for a router-level result (suppressed, no_device, no_target): there is no
-- device yet. `payload` is the frame as sent, already redacted (push/redact.ts),
-- kept for the desktop replay and purged with the row after 30 days.
--
-- RLS: the owner reads their own rows; an org admin reads the org's. Nothing
-- writes through RLS: the producers are background workers on the privileged
-- connection, the same as the push fanout.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

CREATE TABLE IF NOT EXISTS kernel.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  device_id text,
  surface text,
  channel text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL,
  reason text,
  provider_status integer,
  payload jsonb,
  CONSTRAINT notification_deliveries_surface_check
    CHECK (surface IS NULL OR surface IN ('ios', 'android', 'desktop', 'browser_tab', 'browser_push')),
  CONSTRAINT notification_deliveries_channel_check
    CHECK (channel IN ('in_app', 'desktop', 'push', 'email', 'test')),
  CONSTRAINT notification_deliveries_result_check
    CHECK (result IN ('accepted', 'rejected', 'no_connection', 'no_device', 'no_target', 'suppressed'))
);
--> statement-breakpoint

-- A router-level row (no device) is written once per (notification, channel):
-- a replayed event inserts nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_router_once_idx
  ON kernel.notification_deliveries (notification_id, channel)
  WHERE device_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_deliveries_notification_device_idx
  ON kernel.notification_deliveries (notification_id, device_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_deliveries_user_attempted_idx
  ON kernel.notification_deliveries (org_id, user_id, attempted_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_deliveries_attempted_idx
  ON kernel.notification_deliveries (attempted_at);
--> statement-breakpoint

ALTER TABLE kernel.notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.notification_deliveries TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS notification_deliveries_select ON kernel.notification_deliveries;
--> statement-breakpoint
CREATE POLICY notification_deliveries_select ON kernel.notification_deliveries FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
