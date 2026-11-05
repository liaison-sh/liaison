-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Where a thread's outside-text mark came from.
--
-- `kernel.threads.tainted_sources`: the namespace of each MCP server whose result set the mark
-- (`mcp:<slug>`), kept while the mark stands and reset when it is lifted. NULL means unknown: a
-- mark from any other kind of source (web, mail, knowledge, a trigger event, replayed history
-- that names no server) and every mark set before this migration. The outside-content hold lets
-- an MCP read through only when every source is that same server (scopes/scope-taint.ts, rule
-- 6h), so NULL keeps the hold. Additive, no backfill. Re-runnable.
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS tainted_sources text[];
