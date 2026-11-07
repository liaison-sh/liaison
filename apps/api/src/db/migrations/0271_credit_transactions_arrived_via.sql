-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The transfer a credit transaction arrived through (modules/org/transfer/import.ts).
--
-- NULL: the row was written here, on this instance's meter. Set: the row was
-- metered on another instance and copied here when its org moved. The daily
-- usage report (modules/cloud/usage-report.ts) counts only NULL rows, so each
-- instance reports what its own provider key spent and an org's history is
-- never reported a second time by the instance it moved to.
--
-- A nullable column the previous release never reads; re-runnable.
SET LOCAL lock_timeout = '5s';
ALTER TABLE kernel.credit_transactions ADD COLUMN IF NOT EXISTS arrived_via uuid;
