-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T05: app_knowledge.documents carries requiredScopes provenance, the same
-- shape as kernel.messages.required_scopes (0059): text[] NOT NULL DEFAULT
-- '{}'. A constant default makes ADD COLUMN a metadata-only change that fills
-- every existing document with the empty set, which every member satisfies,
-- so existing documents read exactly as before and every existing writer
-- (which names none of it) keeps working. The turn-scoped writers supply the
-- value explicitly (write inheritance); the read predicate is a separate
-- change.
-- Migration-owned like org_access and acl_user_ids: not declared in
-- app.manifest.json, so no manifest-driven generic write can set it.
-- Re-runnable: IF NOT EXISTS.
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS required_scopes text[] NOT NULL DEFAULT '{}'::text[];
