-- SPDX-License-Identifier: FSL-1.1-ALv2
-- 0257 only covered channels with created_from NULL. Channels created by a chat import
-- carry created_from {app: <source>, entityType: "channel", entityId} (the import's
-- provenance, chat.ts), so 0257 skipped them and they kept titles like "#general"; the
-- importer itself wrote the '#'. A room is a channel when it is a type 'thread' that no
-- entity anchors: an imported channel is one (entityType "channel", no thread_references
-- row). Spin-off / entity rooms (ticket, mail, approval...) carry other entityTypes and
-- stay as written.
--
-- Same normalisation as 0257 (NFKC, strip leading whitespace / '#' / format characters,
-- trailing whitespace / format characters), titles that would become empty are left,
-- updated_at is untouched, re-runnable.

WITH cls AS (
  SELECT '[:space:]   -     　'
      || '­؀-؅؜۝܏᠎​-‏‪-‮'
      || '⁠-⁤⁦-⁯﻿￹-￻' AS body
), norm AS (
  SELECT t.id,
         regexp_replace(
           regexp_replace(normalize(t.title, NFKC), '^[' || cls.body || '#]+', ''),
           '[' || cls.body || ']+$', ''
         ) AS name
  FROM kernel.threads t, cls
  WHERE t.type = 'thread'
    AND t.created_from->>'entityType' = 'channel'
    AND t.title IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM kernel.thread_references r WHERE r.thread_id = t.id)
)
UPDATE kernel.threads t
SET title = norm.name
FROM norm
WHERE t.id = norm.id
  AND norm.name <> ''
  AND norm.name IS DISTINCT FROM t.title;
