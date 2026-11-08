-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The outbound domains somebody accountable consented to for an installed app
-- version (modules/apps/egress-grants.ts), next to granted_capabilities and
-- granted_cross_app_calls. The sandbox reaches a host only when the manifest
-- declares it AND this grant holds it (sandbox/bridge/context.ts).
--
-- NULL = grandfathered: a row installed before the column existed keeps every
-- domain its manifest declares, so no back-fill is needed (a SQL migration
-- cannot read the manifests anyway). Every install and upgrade from now on
-- writes the list.
--
-- Additive and nullable, re-runnable: the previous release never reads or
-- writes the column.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS granted_domains text[];
