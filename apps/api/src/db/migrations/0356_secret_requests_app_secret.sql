-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Secret requests: a request may ask a person for an app-held secret they copy from the
-- provider's dashboard (a webhook endpoint's signing secret), kind `app_secret`. The card posts
-- it to the connection's app-secret route; the row still never holds a secret.
--
-- Widening a CHECK: every row the old one accepted, the new one accepts. Re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the CHECK is replaced in the same transaction by a wider one, so the previous release relies on nothing that goes
ALTER TABLE kernel.secret_requests DROP CONSTRAINT IF EXISTS secret_requests_kind_chk;
--> statement-breakpoint
-- expand-safe: the new CHECK accepts every kind the previous release writes, plus app_secret
ALTER TABLE kernel.secret_requests ADD CONSTRAINT secret_requests_kind_chk CHECK (
  kind IN ('byok', 'connection_credentials', 'oauth_client', 'google_integration_client',
           'oauth_connect', 'api_connector_credentials', 'api_key', 'app_secret')
);
