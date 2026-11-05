-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Converges Knowledge READ authorization onto ONE plane end-to-end: REST,
-- agent, AND search now all enforce the same Drive-style sharing ACL
-- (org_access + document_shares + document_role_shares — see 0002/0004's
-- `knowledge_documents_select` policy). Two gaps this closes:
--
--   1. Sensitivity did not influence the `org_access` DEFAULT — a document
--      classified `confidential`/`restricted` still defaulted to org-wide
--      `editor`, so declaring a doc sensitive did nothing to its visibility
--      unless a human separately remembered to also tighten sharing. This
--      migration reconciles existing data (see step 4) and the service layer
--      (apps/knowledge/service.ts) now makes `sensitivity` the DEFAULT input
--      for `org_access`, both on create and on reclassification.
--
--   2. The MeiliSearch permission filter (modules/search/permission-filter.ts)
--      still gated Knowledge documents on the OLD team/sensitivity dimension
--      model (0000-era), which the sharing model never actually removed the
--      dimension columns for — so a REST GET and a search hit could disagree
--      about the same document. This migration adds three denormalized
--      columns so the GENERIC search indexer (no "knowledge" literals) can
--      mirror `knowledge_documents_select` exactly:
--
--        org_wide       — GENERATED: true iff org-scoped AND org_access
--                          grants org-wide read ('viewer'|'editor').
--        acl_user_ids   — distinct union of owner_user_id, created_by, and
--                          document_shares.user_id for the row.
--        acl_role_ids   — document_role_shares.role_id for the row.
--
-- INVARIANT going forward: `sensitivity`/`team` drive the org_access DEFAULT
-- and continue to gate who may CLASSIFY a document at write time
-- (assertCanSetDimensions); the Drive-style sharing ACL (org_access + user/
-- role shares) is the SOLE read-enforcement plane, on every surface. This
-- supersedes 0002's now-inaccurate "(dimension-gated, as before)" parenthetical
-- on `org_access` — no dimension gate has ever existed in the sharing read
-- policy; that comment described intent that was never implemented as a
-- read gate.
--
-- `acl_user_ids`/`acl_role_ids` are maintained by the service layer
-- (recomputeDocumentAcl in apps/knowledge/service.ts) at every write point
-- that can change owner/creator/shares: create, update (owner reassignment),
-- and setDocumentSharing. This migration backfills existing rows once.

-- ── 1. Data reconciliation — auto-tighten pre-existing confidential/restricted
--       org docs that were left org-wide readable before this policy existed.
--       Explicit user/role shares are untouched (deliberate grants survive).
UPDATE app_knowledge.documents
SET org_access = 'none'
WHERE document_scope = 'organization'
  AND sensitivity IN ('confidential', 'restricted')
  AND org_access IN ('viewer', 'editor');

-- ── 2. acl_user_ids / acl_role_ids — plain JSONB, maintained by the service.
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS acl_user_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS acl_role_ids JSONB NOT NULL DEFAULT '[]';

-- ── 3. Backfill acl_user_ids / acl_role_ids for all existing rows ───────────
UPDATE app_knowledge.documents d
SET acl_user_ids = (
  SELECT COALESCE(jsonb_agg(DISTINCT uid), '[]'::jsonb)
  FROM (
    SELECT d.owner_user_id::text AS uid WHERE d.owner_user_id IS NOT NULL
    UNION
    SELECT d.created_by::text AS uid WHERE d.created_by IS NOT NULL
    UNION
    SELECT s.user_id::text AS uid FROM app_knowledge.document_shares s WHERE s.document_id = d.id
  ) u
);

UPDATE app_knowledge.documents d
SET acl_role_ids = (
  SELECT COALESCE(jsonb_agg(DISTINCT rs.role_id::text), '[]'::jsonb)
  FROM app_knowledge.document_role_shares rs
  WHERE rs.document_id = d.id
);

-- ── 4. org_wide — GENERATED STORED column, always recomputed by Postgres. ───
-- Must come after step 1 so the reconciled org_access value is reflected in
-- the very first generated value (though a GENERATED column recomputes on
-- every read regardless of insertion order — this ordering is for clarity,
-- not correctness).
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS org_wide BOOLEAN
  GENERATED ALWAYS AS (
    document_scope = 'organization' AND org_access IN ('viewer', 'editor')
  ) STORED;
