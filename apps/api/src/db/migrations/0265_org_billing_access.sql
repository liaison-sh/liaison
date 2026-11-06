-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.org_billing_state gains what the cell needs to enforce the end of a
-- managed subscription (modules/cloud/suspension.ts, delete-org.ts):
--   access_until    while suspended, until when org admins may still sign in
--                   to export and pay; null otherwise;
--   closed_at       when the control plane closed the org; the deletion fence
--                   (`DELETE /api/cloud/orgs/:id`) reads it;
--   billing_contact the address the suspended page shows.
-- `status` stays plain text: the new `closed` value needs no check change.
-- Self-hosted servers never write this table.
--
-- Additive, every statement re-runnable.

SET LOCAL lock_timeout = '5s';
ALTER TABLE kernel.org_billing_state ADD COLUMN IF NOT EXISTS access_until timestamptz;
ALTER TABLE kernel.org_billing_state ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE kernel.org_billing_state ADD COLUMN IF NOT EXISTS billing_contact text;
