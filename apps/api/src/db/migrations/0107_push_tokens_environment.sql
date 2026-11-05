-- SPDX-License-Identifier: FSL-1.1-ALv2
-- S11: each push token carries the APNs environment its app build was signed
-- for, so the sender picks api.sandbox.push.apple.com or api.push.apple.com per
-- token instead of per process. A token with no environment from an old client
-- is `production` (the column default).
--
-- Every iOS row that exists before this migration came from an Xcode build, so
-- it is `sandbox`. The backfill runs ONLY in the same step that adds the
-- column: a replay (hand-applied hotfix, ledger skip) must not flip a row the
-- sender has since learned is `production` back to `sandbox`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kernel' AND table_name = 'push_tokens' AND column_name = 'environment'
  ) THEN
    ALTER TABLE kernel.push_tokens ADD COLUMN environment text NOT NULL DEFAULT 'production';
    UPDATE kernel.push_tokens SET environment = 'sandbox' WHERE platform = 'ios';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE kernel.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_environment_check;
--> statement-breakpoint

ALTER TABLE kernel.push_tokens
  ADD CONSTRAINT push_tokens_environment_check CHECK (environment IN ('sandbox', 'production'));
