-- SPDX-License-Identifier: FSL-1.1-ALv2
-- When a person last reviewed an MCP server's tools.
--
-- Adding a server ends on a tools review the person has to complete (or dismiss,
-- which keeps the connection's default policy). A connection whose tools nobody
-- has reviewed reopens that review when an admin opens it. Nullable and additive:
-- an existing connection has never been reviewed, which is the honest answer.
ALTER TABLE app_mcp_manager.mcp_connections
  ADD COLUMN IF NOT EXISTS tools_reviewed_at timestamptz;
