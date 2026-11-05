-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Approval anchors never show in a sidebar.
--
-- An approval request needs a thread row to point at (`thread_id` is NOT NULL
-- and 62 code sites read it), so a gated call with no conversation of its own
-- still creates one. That row is plumbing, not a place anyone talks: the
-- "Discuss" action that used to turn it into a real conversation is gone, and
-- discussing an approval now means pasting its URL into the DM or thread where
-- the conversation belongs.
--
-- New anchors are inserted with `hidden_from_list = true`. This retires the
-- ones already in the list.
UPDATE kernel.threads
  SET hidden_from_list = true
  WHERE type = 'approval' AND hidden_from_list = false;
