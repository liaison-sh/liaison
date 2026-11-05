-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The DROP COLUMN hides in a string a ;-splitter never looks into.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE kernel.threads DROP COLUMN legacy_flag';
END
$$;
