-- SPDX-License-Identifier: FSL-1.1-ALv2
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- index-build: kernel.messages 90000000 45000ms
CREATE INDEX IF NOT EXISTS messages_body_idx ON kernel.messages (created_at);
