-- SPDX-License-Identifier: FSL-1.1-ALv2
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- contract: legacy_flag is no longer read or written, unused since #480
ALTER TABLE kernel.threads DROP COLUMN legacy_flag;
