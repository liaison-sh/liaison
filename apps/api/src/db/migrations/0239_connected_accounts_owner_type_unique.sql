-- SPDX-License-Identifier: FSL-1.1-ALv2
-- One provider account may hold an organization connection AND a member's own.
--
-- `connected_accounts_unique_active_idx` allowed one active row per (org, app,
-- connection, identifier), whoever owned it. A connection whose org and
-- personal rows read disjoint data declares `orgAndPersonalCoexist` (Google
-- Drive: the org row reads only the Shared Drives an admin chose, the personal
-- row that person's own Drive); it needs one org row and one personal row of
-- the same account. The key gains the owner type: still at most one org row
-- and one personal row per account (two members never hold one account), and
-- every other connection keeps one owner per account in code (the OAuth
-- callback refuses a personal connect over an org-held account and an org
-- connect retires a member's row).
--
-- The new index is built before the old one goes, so the key is never absent.
SET LOCAL lock_timeout = '5s';

-- index-build: kernel.connected_accounts 5000 40
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_unique_active_owner_idx
  ON kernel.connected_accounts (org_id, app_name, connection_name, identifier, owner_type)
  WHERE status = 'active';

-- expand-safe: the new index is the old key plus owner_type, so every row the previous release writes still satisfies it; that release still keeps one owner per account in code
DROP INDEX IF EXISTS kernel.connected_accounts_unique_active_idx;
