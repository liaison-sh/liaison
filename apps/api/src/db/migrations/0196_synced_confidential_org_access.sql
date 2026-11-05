-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Synced knowledge documents of a confidential or restricted source lose
-- org-wide access.
--
-- The sync reconciler inserted every synced document with the column default
-- org_access = 'editor', so a file from a source marked confidential or
-- restricted was readable (and editable) by every member of the org. A
-- document created in Knowledge derives org_access from its sensitivity
-- (confidential/restricted -> 'none', see 0008); the reconciler now does the
-- same, and this migration brings the rows it already wrote in line.
--
-- For each such document (archived ones too, so a file that reappears upstream
-- does not come back org-wide): org_access becomes 'none' (org_wide, a
-- generated column, follows), its search ACL projection is recomputed so its
-- owner and creator, who keep reading it, find it in search, and a `share`
-- event is queued on the outbox so the search indexer re-reads the row, as
-- setDocumentSharing does. Explicit user and role shares are untouched.
-- Personal sources carry no sensitivity and are not matched. Re-runnable: a
-- second run matches no row and queues nothing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    UPDATE app_knowledge.documents d
       SET org_access = 'none'
      FROM app_knowledge.synced_sources s
     WHERE d.synced_source_id = s.id
       AND d.org_id = s.org_id
       AND s.owner_user_id IS NULL
       AND s.default_sensitivity IN ('confidential', 'restricted')
       AND d.document_scope = 'organization'
       AND d.org_access IN ('viewer', 'editor')
    RETURNING d.id, d.org_id, d.synced_source_id, s.created_by
  LOOP
    PERFORM kernel.recompute_search_acl('knowledge.document', r.id, r.org_id);
    INSERT INTO kernel.pending_events (org_id, payload)
    VALUES (
      r.org_id,
      jsonb_build_object(
        'app', 'knowledge',
        'entity', 'document',
        'action', 'share',
        'entityId', r.id::text,
        'data', jsonb_build_object(
          'id', r.id::text,
          'orgAccess', 'none',
          'syncedSourceId', r.synced_source_id::text
        ),
        'actorId', r.created_by::text,
        'actorType', 'system',
        'orgId', r.org_id::text
      )
    );
  END LOOP;
END $$;
