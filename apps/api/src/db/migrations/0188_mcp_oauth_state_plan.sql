-- SPDX-License-Identifier: FSL-1.1-ALv2
-- MCP OAuth sign-in state carries the authorization plan it was started with.
--
-- A sign-in used to write its token endpoint, client id and client secret into
-- the connection when it STARTED, so an abandoned "Sign in again" against
-- another authorization server sent the live refresh token there, and a code
-- from one sign-in could be exchanged with another one's endpoint (the mix-up
-- RFC 9207 guards against). The plan now rides with its state row and reaches
-- the connection only when that state's callback succeeds:
--   pending_metadata: the non-secret plan (endpoints, client id, resource);
--   pending_secrets_encrypted: the plan's client secret, in the same envelope
--     as mcp_connections.secrets_encrypted.
-- State rows live ten minutes; both columns are nullable, so a row written
-- before this migration finalises the old way. Re-runnable.
ALTER TABLE app_mcp_manager.mcp_oauth_state
  ADD COLUMN IF NOT EXISTS pending_metadata jsonb,
  ADD COLUMN IF NOT EXISTS pending_secrets_encrypted text;
