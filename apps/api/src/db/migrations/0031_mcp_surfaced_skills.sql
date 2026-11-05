-- SPDX-License-Identifier: FSL-1.1-ALv2
-- MCP skill surfacing: track which skill bodies have already been pushed to a
-- connection via an app-anchored tool result, so the push is exactly-once per
-- skill per connection rather than repeated on every tool call.
--
-- Forward-safe: additive, defaulted, NOT NULL with a default so existing rows
-- backfill to the empty set (nothing surfaced yet) without a rewrite pass.
ALTER TABLE "kernel"."mcp_connections"
  ADD COLUMN IF NOT EXISTS "surfaced_skills" text[] NOT NULL DEFAULT '{}';
