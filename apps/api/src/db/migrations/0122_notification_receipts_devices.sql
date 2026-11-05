-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Receipts, device credentials and the computer devices (S1, S3, A3, A7, F1).
--
--  - kernel.desktop_devices: one desktop app install per (user, device_id),
--    with the OS permission it last reported.
--  - kernel.browser_push_subscriptions: one browser profile per (user,
--    device_id), with its Web Push subscription when it has one (endpoint
--    NULL = in-tab notifications only).
--  - kernel.notification_device_credentials: receipt-only credentials, one
--    live per (user, org, device), stored hashed and bound to the server
--    origin that issued them. Revoked on logout, device deletion and
--    re-registration. Never readable through RLS: issued and checked on the
--    privileged connection only.
--  - kernel.notification_receipts: one per (notification, device), the
--    outcome under the precedence suppressed > shown > received (A3). Same
--    RLS and 30-day retention as the delivery log.
--
-- Device tables carry ownership RLS like push_tokens (0088): a device address
-- is one person's, no admin branch.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

CREATE TABLE IF NOT EXISTS kernel.desktop_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  os text,
  app_version text,
  reported_permission text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desktop_devices_permission_check
    CHECK (reported_permission IS NULL OR reported_permission IN ('granted', 'denied', 'not_determined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS desktop_devices_user_device_idx
  ON kernel.desktop_devices (user_id, device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS desktop_devices_org_user_idx
  ON kernel.desktop_devices (org_id, user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.browser_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  endpoint text,
  p256dh text,
  auth text,
  user_agent text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS browser_push_subscriptions_user_device_idx
  ON kernel.browser_push_subscriptions (user_id, device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS browser_push_subscriptions_org_user_idx
  ON kernel.browser_push_subscriptions (org_id, user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.notification_device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  surface text NOT NULL,
  token_hash text NOT NULL,
  server_origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT notification_device_credentials_surface_check
    CHECK (surface IN ('ios', 'android', 'desktop', 'browser'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_device_credentials_hash_idx
  ON kernel.notification_device_credentials (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_device_credentials_device_idx
  ON kernel.notification_device_credentials (org_id, user_id, device_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.notification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  device_id text NOT NULL,
  surface text,
  app_state text,
  outcome text NOT NULL,
  reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_receipts_outcome_check
    CHECK (outcome IN ('received', 'shown', 'suppressed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_receipts_notification_device_idx
  ON kernel.notification_receipts (notification_id, device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_receipts_user_idx
  ON kernel.notification_receipts (org_id, user_id, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_receipts_received_idx
  ON kernel.notification_receipts (received_at);
--> statement-breakpoint

ALTER TABLE kernel.desktop_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.desktop_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.browser_push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.browser_push_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_device_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_device_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.desktop_devices TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.browser_push_subscriptions TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT ON kernel.notification_receipts TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS desktop_devices_owner ON kernel.desktop_devices;
--> statement-breakpoint
CREATE POLICY desktop_devices_owner ON kernel.desktop_devices FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS browser_push_subscriptions_owner ON kernel.browser_push_subscriptions;
--> statement-breakpoint
CREATE POLICY browser_push_subscriptions_owner ON kernel.browser_push_subscriptions FOR ALL TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS notification_receipts_select ON kernel.notification_receipts;
--> statement-breakpoint
CREATE POLICY notification_receipts_select ON kernel.notification_receipts FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
