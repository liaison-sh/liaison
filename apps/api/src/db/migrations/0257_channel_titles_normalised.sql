-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Channel names carry no leading '#' and no surrounding whitespace. The server
-- applies that on create and rename (normalizeChannelTitle, packages/shared); channels
-- imported before that rule still hold titles like "#general", and nobody can rename
-- them (a rename needs a room admin, an imported channel has none).
--
-- This rewrites those titles with the same normalisation: NFKC, then strip leading
-- whitespace / '#' / format characters (Unicode Cf) and trailing whitespace / format
-- characters. Only CHANNELS are touched: type 'thread', not anchored to an entity
-- (created_from null, no thread_references row); DMs, agent chats, approvals,
-- routines and entity rooms keep their title. A title that would become empty is
-- left as is. Re-runnable: a normalised title no longer differs from itself.
--
-- No trigger, outbox or search hook exists on kernel.threads (thread titles are not
-- in the Meilisearch index) and updated_at is left alone so the room list order does
-- not move. The migration role bypasses RLS.

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
    AND t.created_from IS NULL
    AND t.title IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM kernel.thread_references r WHERE r.thread_id = t.id)
)
UPDATE kernel.threads t
SET title = norm.name
FROM norm
WHERE t.id = norm.id
  AND norm.name <> ''
  AND norm.name IS DISTINCT FROM t.title;
