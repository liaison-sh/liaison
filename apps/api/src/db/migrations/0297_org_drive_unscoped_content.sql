-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- reviewed-dynamic: a one-off data fix in a DO block; its only DDL is a temp table dropped on commit
-- Knowledge that an ORGANIZATION Google Drive connection synced, kept within the
-- shared drives an admin chose. Until this release the server checked it at every
-- org setup (a kernel call); Google Drive now ships as a catalog app whose sync
-- applies the rule at every pass, and this migration does the setup check once.
--
-- For each active organization Drive account (app google-drive, connection drive):
--   - with no shared drive chosen (metadata.sharedDrives empty or absent), the
--     folders that sync through it are hidden: their documents and source links
--     archived (an `archive` event queued for each, so the search indexer drops
--     them), the folder marked in error saying why;
--   - with shared drives chosen, those folders sync again at the next tick (the
--     sync keeps only what the chosen drives hold).
-- A folder syncs through the org account when it records that account, or records
-- none, and its owner holds no personal Drive account of that address (content of a
-- personal connection is never touched). Re-runnable: archived rows are skipped.
DO $$
DECLARE
  a record;
  r record;
BEGIN
  IF to_regclass('app_knowledge.synced_sources') IS NULL THEN
    RETURN;
  END IF;
  FOR a IN
    SELECT ca.org_id, ca.identifier,
           jsonb_typeof(ca.metadata -> 'sharedDrives') = 'array'
             AND jsonb_array_length(ca.metadata -> 'sharedDrives') > 0 AS chosen
      FROM kernel.connected_accounts ca
     WHERE ca.app_name = 'google-drive' AND ca.connection_name = 'drive'
       AND ca.owner_type = 'org' AND ca.status = 'active'
  LOOP
    CREATE TEMP TABLE IF NOT EXISTS _org_drive_sources (id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _org_drive_sources;
    INSERT INTO _org_drive_sources (id)
      SELECT ss.id
        FROM app_knowledge.synced_sources ss
       WHERE ss.org_id = a.org_id AND ss.app_name = 'google-drive' AND ss.archived_at IS NULL
         AND (ss.source_account IS NULL OR lower(ss.source_account) = lower(a.identifier))
         AND NOT EXISTS (
           SELECT 1 FROM kernel.connected_accounts p
            WHERE p.org_id = ss.org_id AND p.app_name = 'google-drive' AND p.status = 'active'
              AND p.owner_type = 'user' AND p.owner_id = COALESCE(ss.owner_user_id, ss.created_by)
              AND (ss.source_account IS NULL OR lower(p.identifier) = lower(ss.source_account))
         )
      ON CONFLICT DO NOTHING;

    IF a.chosen THEN
      UPDATE app_knowledge.synced_sources s
         SET last_sync_at = NULL, updated_at = now()
       WHERE s.id IN (SELECT id FROM _org_drive_sources) AND s.last_sync_status <> 'running';
      CONTINUE;
    END IF;

    FOR r IN
      UPDATE app_knowledge.documents d
         SET archived_at = now(), updated_at = now()
       WHERE d.org_id = a.org_id AND d.synced_source_id IN (SELECT id FROM _org_drive_sources)
         AND d.archived_at IS NULL
      RETURNING d.id, d.synced_source_id, 'document'::text AS entity
    LOOP
      INSERT INTO kernel.pending_events (org_id, payload)
      VALUES (a.org_id, jsonb_build_object(
        'app', 'knowledge', 'entity', r.entity, 'action', 'archive', 'entityId', r.id::text,
        'data', jsonb_build_object('id', r.id::text, 'syncedSourceId', r.synced_source_id::text),
        'actorId', 'system', 'actorType', 'system', 'orgId', a.org_id::text));
    END LOOP;
    FOR r IN
      UPDATE app_knowledge.source_links l
         SET archived_at = now(), updated_at = now()
       WHERE l.org_id = a.org_id AND l.synced_source_id IN (SELECT id FROM _org_drive_sources)
         AND l.archived_at IS NULL
      RETURNING l.id, l.synced_source_id, 'source_link'::text AS entity
    LOOP
      INSERT INTO kernel.pending_events (org_id, payload)
      VALUES (a.org_id, jsonb_build_object(
        'app', 'knowledge', 'entity', r.entity, 'action', 'archive', 'entityId', r.id::text,
        'data', jsonb_build_object('id', r.id::text, 'syncedSourceId', r.synced_source_id::text),
        'actorId', 'system', 'actorType', 'system', 'orgId', a.org_id::text));
    END LOOP;
    UPDATE app_knowledge.synced_sources s
       SET last_sync_status = 'error',
           last_error = 'Hidden: this folder syncs through the organization''s Google Drive connection, which shares no shared drive yet. An admin picks the shared drives the team should see; the folder then syncs again and shows what those drives hold.',
           last_sync_at = now(), updated_at = now()
     WHERE s.id IN (SELECT id FROM _org_drive_sources) AND s.last_sync_status <> 'running';
  END LOOP;
END $$;
