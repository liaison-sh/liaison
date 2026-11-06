-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.org_billing_state gains the nightly storage estimate of a managed org
-- (modules/cloud/storage-estimate.ts): what the org occupies beyond its files,
-- with the time it was measured, null before the first measure. Self-hosted
-- servers never write this table.
--
-- Additive, every statement re-runnable.

SET LOCAL lock_timeout = '5s';
ALTER TABLE kernel.org_billing_state ADD COLUMN IF NOT EXISTS storage_estimate jsonb;
