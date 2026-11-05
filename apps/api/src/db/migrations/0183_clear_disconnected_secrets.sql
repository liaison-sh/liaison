-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Clear the secrets that disconnected connections still hold.
--
-- Disconnecting a connection now deletes its stored tokens and credentials in
-- the same transaction (connections service, CLEARED_SECRETS). Connections
-- disconnected before that change kept their encrypted access token, refresh
-- token, credentials and token expiry. Nothing reads them: a reconnect writes
-- fresh secrets. This clears them once, so a disconnected row holds no secret
-- on any instance. Rows that already hold none are left untouched. Re-runnable.
UPDATE kernel.connected_accounts
SET access_token_encrypted = NULL,
    refresh_token_encrypted = NULL,
    credentials_encrypted = NULL,
    token_expires_at = NULL
WHERE status = 'disconnected'
  AND (access_token_encrypted IS NOT NULL
    OR refresh_token_encrypted IS NOT NULL
    OR credentials_encrypted IS NOT NULL
    OR token_expires_at IS NOT NULL);
