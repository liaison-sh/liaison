-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Scopes an app gives every member of the workspace (S16).
--
-- `kernel.apps.every_member_scopes` records the manifest's `everyMemberScopes`
-- for the org's install of the app. The registration rewrites it on every boot
-- (modules/apps/runtime.ts, writeOrgAppRows), so a manifest change reaches every
-- org without a data migration, and `loadEffectivePermissions`
-- (modules/permissions/permissions.ts) unions it into the effective scopes of
-- each ACTIVE member of the org, whatever their roles, before the app-access
-- restriction (S20) drops the scopes of an app the person is kept out of. A
-- removed app gives nothing. The manifest contract pins every entry to the
-- app's own `member` tier. Re-runnable.
ALTER TABLE kernel.apps
  ADD COLUMN IF NOT EXISTS every_member_scopes text[] NOT NULL DEFAULT '{}';
