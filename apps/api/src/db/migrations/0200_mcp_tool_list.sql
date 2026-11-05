-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The last tools/list of each MCP connection, with its tools' annotations.
--
-- A connection's tools lived only in process memory, filled by a dial: after an
-- API restart the agent's tool_search offered none of them until something
-- dialed the server, and the read-only hints the connection default policy and
-- the tool rows read were gone, so every tool counted as a write. Every dial
-- now writes the list here, and the boot path projects from it without dialing.
-- Nullable and additive: a connection not dialed since this migration has no
-- list until its next dial, which is the honest answer.
ALTER TABLE app_mcp_manager.mcp_connection_health
  ADD COLUMN IF NOT EXISTS tool_list jsonb,
  ADD COLUMN IF NOT EXISTS tool_list_at timestamptz;
