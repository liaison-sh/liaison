-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A Knowledge document written (or last changed) by an agent turn that had read
-- outside text (an inbound email, a web page, a remote tool result) records
-- that, so a later turn reading the document is marked the same way and its
-- outward actions wait for a person, instead of taking the text as trusted
-- knowledge. A person rewriting the body in the app clears it.
-- Migration-owned like required_scopes: not settable through a generic
-- manifest write. Re-runnable: IF NOT EXISTS.
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS from_untrusted boolean NOT NULL DEFAULT false;
