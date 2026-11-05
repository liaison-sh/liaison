-- SPDX-License-Identifier: FSL-1.1-ALv2
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- index-build: kernel.threads 250000 1200ms
CREATE INDEX IF NOT EXISTS threads_created_idx ON kernel.threads (created_at);
