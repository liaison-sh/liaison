-- SPDX-License-Identifier: FSL-1.1-ALv2
-- MCP OAuth sign-in state records what the authorization request was bound to.
--
-- The MCP authorization spec (2026-07-28 client MUSTs) has the client store the
-- authorization server's issuer with the PKCE verifier and state, and compare
-- the callback's RFC 9207 `iss` with it; an AS that advertises
-- `authorization_response_iss_parameter_supported` must send `iss`. The RFC 8707
-- `resource` and the requested scope ride along so the code exchange sends the
-- same values. State rows live ten minutes, so existing rows need no backfill:
-- the new columns are nullable (the boolean defaults to false). Re-runnable.
ALTER TABLE app_mcp_manager.mcp_oauth_state
  ADD COLUMN IF NOT EXISTS issuer text,
  ADD COLUMN IF NOT EXISTS resource text,
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS iss_supported boolean NOT NULL DEFAULT false;
