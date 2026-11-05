-- SPDX-License-Identifier: FSL-1.1-ALv2
-- What a device-flow approver needs to see before pressing Approve.
--
-- The approval page used to act on a bare user code. These two columns carry the
-- context of the request so the page can show it: the platform/device label the
-- client declared (self-declared, so shown as unverified) and the IP address the
-- initiate request came from (observed server side, not declared).
ALTER TABLE kernel.device_flow_requests ADD COLUMN IF NOT EXISTS device_label text;
ALTER TABLE kernel.device_flow_requests ADD COLUMN IF NOT EXISTS request_ip text;
