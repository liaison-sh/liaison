-- SPDX-License-Identifier: FSL-1.1-ALv2
CREATE INDEX IF NOT EXISTS threads_created_idx ON kernel.threads (created_at);
