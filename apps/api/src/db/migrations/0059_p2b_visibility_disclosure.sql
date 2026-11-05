-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T01: empty anchor migration for slice 2b (visibility, disclosure,
-- audit). Intentionally carries no DDL yet: P2b-T02 through P2b-T06 append
-- their column/table changes to this same file, in order, so the slice ships
-- as one forward migration.

-- ===== P2b-T02: kernel.messages visibility columns =====
-- required_scopes: NOT NULL with a constant default, so ADD COLUMN fills every
-- existing row with '{}' in the same statement (no separate backfill needed).
-- disclosure_list: nullable, null means no disclosure. Re-runnable.
ALTER TABLE kernel.messages
  ADD COLUMN IF NOT EXISTS required_scopes text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS disclosure_list uuid[];
-- ===== end P2b-T02 =====
