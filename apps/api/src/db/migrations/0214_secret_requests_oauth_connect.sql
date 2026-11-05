-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Secret requests: the Google integration client kind is renamed, and a
-- request may ask a person to connect an OAuth account.
--
-- `google_login_client` always wrote the Google client that Gmail and Google
-- Calendar connect with (the integration client), never the client people sign
-- in with: it becomes `google_integration_client`, and rows already filed under
-- the old name follow it.
--
-- `oauth_connect` is a consent card: the person signs in at the provider from
-- the card, and the request is saved once the connection's account is stored.
-- The row still never holds a secret: no code and no token reaches it.
--
-- Every statement is re-runnable.
ALTER TABLE kernel.secret_requests DROP CONSTRAINT IF EXISTS secret_requests_kind_chk;
--> statement-breakpoint
UPDATE kernel.secret_requests SET kind = 'google_integration_client' WHERE kind = 'google_login_client';
--> statement-breakpoint
ALTER TABLE kernel.secret_requests ADD CONSTRAINT secret_requests_kind_chk CHECK (
  kind IN ('byok', 'connection_credentials', 'oauth_client', 'google_integration_client',
           'oauth_connect', 'api_connector_credentials', 'api_key')
);
