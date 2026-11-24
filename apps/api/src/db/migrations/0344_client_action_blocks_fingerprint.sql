-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The fingerprint of what a client action's page shows, beside the stored file's.
--
-- A target whose app names a stored file without a hash is fingerprinted by the kernel: the
-- SHA-256 of the file's bytes (`target_sha256`) and, when the page shows the target through its
-- blocks (a quote's lines), the SHA-256 of the canonical JSON of those blocks
-- (`target_blocks_sha256`). A decision checks both and is refused when either changed. NULL: the
-- page shows no blocks the kernel fingerprinted (the app's own hash covers what it shows).
-- Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a nullable column with no default (no rewrite); the previous release never names it
ALTER TABLE kernel.client_actions ADD COLUMN IF NOT EXISTS target_blocks_sha256 text;
