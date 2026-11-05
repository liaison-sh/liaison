-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An auto-approve policy does not approve, on its own, an action that leaves the
-- organisation (a send, a reply, a payment) from a turn that has read outside
-- text (an inbound email, a web page, a remote tool result): such a call parks
-- for a person instead. An admin who wants unattended runs of that tool after
-- such reads (for example automatic replies to inbound mail) says so on the
-- policy itself.
ALTER TABLE kernel.auto_approve_policies
  ADD COLUMN IF NOT EXISTS allow_after_untrusted_content boolean NOT NULL DEFAULT false;
