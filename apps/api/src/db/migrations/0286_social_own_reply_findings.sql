-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Our own replies stored as social findings are resolved.
--
-- When an organization's Page replied to a comment (from Liaison or natively),
-- Meta echoed that comment back through the webhook and the social app stored
-- it as a `comment_on_our_content` finding with status `new`: the queue filled
-- with our own words. Since social 0.6.62 such a comment is never a finding; it
-- marks the finding it answers as replied (`handled`). This applies the same
-- rule to the rows already stored:
--
--  - a finding written by one of the organization's own accounts is dismissed,
--    with `metadata.own_reply = true`. Own accounts are the ids the app knows
--    them by: each sync_state row's connected account, the Facebook Page ids it
--    routes (`metadata.meta_page_ids`), and the Page ids stored on polled
--    findings and DM conversations (`metadata.pageId`). A Facebook comment on a
--    post of ours whose author is the Page that owns the post (the post id is
--    `<pageId>_<postId>`) is own as well.
--  - an open finding that such a reply answers (its `parent_external_id`) is
--    marked `handled`, with `metadata.own_reply` naming the reply.
--
-- A no-op where the social app is not installed (no app_social schema), and
-- re-runnable: dismissed rows are skipped. Runs as liaison_admin because the
-- app tables force row-level security (see 0283).

SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
-- expand-safe: data-only repair of app rows, no DDL.
-- reviewed-dynamic: the DO block only guards on the app schema existing.
DO $$
BEGIN
  IF to_regclass('app_social.finding') IS NULL OR to_regclass('app_social.sync_state') IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE social_own_ids (org_id uuid, platform text, id text) ON COMMIT DROP;
  INSERT INTO social_own_ids
    SELECT org_id, platform, account_external_id FROM app_social.sync_state
    WHERE account_external_id IS NOT NULL AND account_external_id <> '';
  INSERT INTO social_own_ids
    SELECT s.org_id, s.platform, p.id
    FROM app_social.sync_state s,
         LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(s.metadata::jsonb -> 'meta_page_ids') = 'array'
                THEN s.metadata::jsonb -> 'meta_page_ids' ELSE '[]'::jsonb END
         ) AS p(id);
  INSERT INTO social_own_ids
    SELECT DISTINCT org_id, 'facebook', metadata::jsonb ->> 'pageId' FROM app_social.finding
    WHERE platform = 'facebook' AND COALESCE(metadata::jsonb ->> 'pageId', '') <> '';
  IF to_regclass('app_social.dm_conversation') IS NOT NULL THEN
    INSERT INTO social_own_ids
      SELECT DISTINCT org_id, 'facebook', metadata::jsonb ->> 'pageId' FROM app_social.dm_conversation
      WHERE platform = 'facebook' AND COALESCE(metadata::jsonb ->> 'pageId', '') <> '';
  END IF;

  CREATE TEMP TABLE social_own_replies ON COMMIT DROP AS
    SELECT f.id, f.org_id, f.platform, f.external_id, f.parent_external_id, f.occurred_at
    FROM app_social.finding f
    WHERE f.status <> 'dismissed'
      AND COALESCE(f.author_external_id, '') <> ''
      AND (
        EXISTS (
          SELECT 1 FROM social_own_ids o
          WHERE o.org_id = f.org_id AND o.platform = f.platform AND o.id = f.author_external_id
        )
        OR (
          f.platform = 'facebook'
          AND f.relation = 'comment_on_our_content'
          AND position('_' in COALESCE(f.parent_external_id, '')) > 1
          AND split_part(f.parent_external_id, '_', 1) = f.author_external_id
        )
      );

  -- The findings those replies answer, when stored and still open.
  UPDATE app_social.finding p
     SET status = 'handled',
         metadata = COALESCE(p.metadata::jsonb, '{}'::jsonb)
           || jsonb_build_object('own_reply', jsonb_build_object('external_id', r.external_id, 'at', r.occurred_at))
    FROM (
      SELECT DISTINCT ON (org_id, platform, parent_external_id) org_id, platform, parent_external_id, external_id, occurred_at
      FROM social_own_replies
      WHERE parent_external_id IS NOT NULL
      ORDER BY org_id, platform, parent_external_id, occurred_at DESC NULLS LAST
    ) r
   WHERE p.org_id = r.org_id AND p.platform = r.platform AND p.external_id = r.parent_external_id
     AND p.status IN ('new', 'triaged', 'drafted', 'awaiting_approval', 'failed')
     AND p.id NOT IN (SELECT id FROM social_own_replies);

  UPDATE app_social.finding f
     SET status = 'dismissed',
         metadata = COALESCE(f.metadata::jsonb, '{}'::jsonb) || '{"own_reply": true}'::jsonb
    FROM social_own_replies r
   WHERE f.id = r.id;
END $$;
--> statement-breakpoint
RESET ROLE;
