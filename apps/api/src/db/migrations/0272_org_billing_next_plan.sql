-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.org_billing_state gains the next plan the control plane pushes, `{id,
-- caps}`, null on the largest plan or before a push that carries it. A refusal
-- at a cap says what the next plan gives (modules/cloud/billing.ts). Self-hosted
-- servers never write this table.
--
-- Additive, every statement re-runnable.

SET LOCAL lock_timeout = '5s';
ALTER TABLE kernel.org_billing_state ADD COLUMN IF NOT EXISTS next_plan jsonb;
