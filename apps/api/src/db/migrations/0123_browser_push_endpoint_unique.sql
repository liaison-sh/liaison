-- SPDX-License-Identifier: FSL-1.1-ALv2
-- fix2-F1: a Web Push endpoint belongs to exactly one browser row.
--
-- A browser keeps its push subscription across sessions. When a session ended
-- without a sign-out (a rejected refresh token), the next user registering the
-- same subscription left the previous user's row holding the endpoint, and the
-- previous user's notifications kept reaching that browser. The register route
-- now takes the endpoint from any other row in one transaction; this index is
-- the backstop.
--
-- Existing duplicates first: on each endpoint held by several rows, the most
-- recently seen row keeps it; the others lose it (endpoint and keys) and their
-- browser receipt credentials are revoked.
WITH ranked AS (
  SELECT id, org_id, user_id, device_id,
         row_number() OVER (PARTITION BY endpoint ORDER BY last_seen_at DESC, created_at DESC, id) AS rn
    FROM kernel.browser_push_subscriptions
   WHERE endpoint IS NOT NULL
), losers AS (
  UPDATE kernel.browser_push_subscriptions s
     SET endpoint = NULL, p256dh = NULL, auth = NULL
    FROM ranked r
   WHERE s.id = r.id AND r.rn > 1
  RETURNING s.org_id, s.user_id, s.device_id
)
UPDATE kernel.notification_device_credentials c
   SET revoked_at = now()
  FROM losers l
 WHERE c.org_id = l.org_id
   AND c.user_id = l.user_id
   AND c.device_id = l.device_id
   AND c.surface = 'browser'
   AND c.revoked_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS browser_push_subscriptions_endpoint_idx
  ON kernel.browser_push_subscriptions (endpoint)
  WHERE endpoint IS NOT NULL;
