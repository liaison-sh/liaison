-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A draft preview's store namespace (`draft:<draftId>`, modules/app-builder/
-- preview.ts) survives across previews of the same version: `preview_store_n`
-- is the version that last wrote it, and a preview of another version (or one
-- asking for a fresh store) empties it first. `preview_lease_until` lets one
-- preview of a draft run at a time on every process (a second one is refused
-- with `preview_busy` until the lease is released or runs out).
--
-- Additive and nullable, every statement re-runnable: the previous release
-- never reads or writes the columns.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.app_drafts ADD COLUMN IF NOT EXISTS preview_store_n integer;
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.app_drafts ADD COLUMN IF NOT EXISTS preview_lease_until timestamptz;
