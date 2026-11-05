-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Connected accounts record which OAuth client minted their tokens.
--
-- A connection's client is the workspace's own, else one the instance provides
-- for every workspace. Tokens are bound to the client that minted them, so a
-- refresh, and a webhook signed with the client's secret, must use that client
-- even after the workspace saves a different one. `oauth_client_source` is
-- `org`, `instance` or `legacy`; `oauth_client_id` the minting client's id.
--
-- Rows connected before this record existed are `legacy`: their client is
-- resolved with the order that applied when they connected.
--
-- Every statement is re-runnable.
ALTER TABLE kernel.connected_accounts ADD COLUMN IF NOT EXISTS oauth_client_source text;
--> statement-breakpoint
ALTER TABLE kernel.connected_accounts ADD COLUMN IF NOT EXISTS oauth_client_id text;
--> statement-breakpoint
UPDATE kernel.connected_accounts SET oauth_client_source = 'legacy'
  WHERE provider_type = 'oauth2' AND oauth_client_source IS NULL;
--> statement-breakpoint
ALTER TABLE kernel.connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_oauth_client_source_chk;
--> statement-breakpoint
ALTER TABLE kernel.connected_accounts ADD CONSTRAINT connected_accounts_oauth_client_source_chk
  CHECK (oauth_client_source IS NULL OR oauth_client_source IN ('org', 'instance', 'legacy'));
