-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T29: knowledge documents and agent memory rows inherit the writing
-- turn's requiredScopes, and EVERY writer now supplies the value explicitly
-- (the service create/update, the sandbox knowledge bridge, the memory tool
-- and the human routes, the sync reconciler, the seeds and the fixtures).
-- With the writers covered, the column DEFAULTS come off:
--   app_knowledge.documents.required_scopes  (added by 0064)
--   kernel.agent_memory.required_scopes      (added by 0055)
-- An untagged insert must FAIL (23502) instead of silently landing as the
-- empty set, which every member satisfies: a scoped document or memory left
-- untagged is world-readable, which is precisely the leak D5 closes. A new
-- write path that forgets the field now breaks loudly at its first insert
-- rather than quietly disclosing.
--
-- Existing rows are untouched (NOT NULL still holds, no backfill needed) and
-- the column type is unchanged; only the DEFAULT is removed.
-- Re-runnable: DROP DEFAULT against a column that has none is a no-op.
ALTER TABLE app_knowledge.documents ALTER COLUMN required_scopes DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE kernel.agent_memory ALTER COLUMN required_scopes DROP DEFAULT;
