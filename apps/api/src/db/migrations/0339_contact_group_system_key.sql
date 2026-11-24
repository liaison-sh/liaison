-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A contact group an app keeps for itself, named by a key.
--
-- An app's routine template may name a contact group by its key (for example the clients under
-- a signed agreement, whose mail a routine reads): the kernel resolves the key to the org's
-- group when the template is enabled, creating that manual group once, and the app keeps its
-- members through its declared `kernel:contacts_group_add`. `system_key` is `<app>:<key>`, one
-- group per key in an org; every other group has none. Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a nullable column with no default (no rewrite); the previous release never names it
ALTER TABLE kernel.contact_segments ADD COLUMN IF NOT EXISTS system_key text;
--> statement-breakpoint
-- index-build: kernel.contact_segments 10000 200
CREATE UNIQUE INDEX IF NOT EXISTS contact_segments_system_key_uniq
  ON kernel.contact_segments (org_id, system_key) WHERE system_key IS NOT NULL;
