-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Synced-source imports created documents with owner_user_id = NULL for
-- org-scoped sources, flooding the Home attention feed with owner_missing
-- review items that nothing could clear. The reconciler now defaults the
-- owner to the source creator; this backfills the rows it already created.
UPDATE app_knowledge.documents
SET owner_user_id = created_by,
    updated_at = now()
WHERE owner_user_id IS NULL
  AND synced_source_id IS NOT NULL;
