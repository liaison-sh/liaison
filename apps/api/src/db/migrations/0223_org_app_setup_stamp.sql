-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The org's app setup stamp (modules/apps/setup-stamp.ts).
--
--  - organizations.app_setup_stamp: a sha256 over what the org's persistent
--    app setup depends on (the build id, every app at its version, the Google
--    login config). Written once every app registered successfully; a later
--    registration that computes the same stamp skips the org's row writes.
--    NULL = the org was never set up with a stamp, so the next registration
--    writes everything, as before this column existed.
--
-- Additive and re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.organizations ADD COLUMN IF NOT EXISTS app_setup_stamp text;
