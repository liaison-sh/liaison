-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Agent memory is injected into later turns (the MEMORY.md index every turn,
-- recalled entries by relevance). A turn that has read outside text (an inbound
-- email, a web page, a remote tool result) is marked on its thread, and its
-- outward actions wait for a person. Without a mark on what that turn WROTE to
-- memory, the outside text would come back in a later, unmarked turn as recall.
-- from_untrusted records that a row was written (or last changed) by such a
-- turn; reading or injecting it marks the reading turn the same way. A person
-- editing the row in the Memory tab clears it.
ALTER TABLE kernel.agent_memory
  ADD COLUMN IF NOT EXISTS from_untrusted boolean NOT NULL DEFAULT false;
