-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A contact's notes become messages in its discussion.
--
-- A contact now has a discussion, like a task: its primary thread
-- (`contact-primary:<contactId>`, modules/threads/contact-primary.ts), where
-- teammates and agents write about the person. It replaces the notes, which
-- were timeline entries of the contact (app `kernel`, entity `contact`,
-- action `note`). This migration:
--
--   1. keeps every contact's primary thread within the contact, out of the
--      global thread list, as a task's thread is (hidden_from_list);
--   2. creates the discussion of each contact that has notes and none yet;
--   3. copies each note into it as a message with its author (the person, or
--      the agent with its owner as the message's person) and its date. An
--      author who no longer exists becomes a system message. Each copy
--      carries `external_ref = contact-note:<entry id>`, so a second run
--      copies nothing twice;
--   4. deletes the note entries that were copied. Nothing else reads them:
--      the notes list and its routes are gone, and the contact's other
--      history stays in the timeline.
--
-- Access is unchanged in kind: the thread is participant-gated like every
-- kernel thread, and the product enrols someone only after their own RLS shows
-- them the contact (modules/contacts/discussion.ts). Nobody is enrolled here.

UPDATE kernel.threads
   SET hidden_from_list = true
 WHERE handle LIKE 'contact-primary:%'
   AND created_from ->> 'entityType' = 'contact'
   AND hidden_from_list = false;
--> statement-breakpoint

INSERT INTO kernel.threads (org_id, handle, type, hidden_from_list, created_from, created_by)
SELECT c.org_id,
       'contact-primary:' || c.id::text,
       'thread',
       true,
       jsonb_build_object('app', 'kernel', 'entityType', 'contact', 'entityId', c.id::text),
       creator.id
  FROM kernel.contacts c
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      (SELECT u.id FROM kernel.users u
        WHERE u.org_id = c.org_id AND u.id = c.owner_user_id),
      (SELECT u.id FROM kernel.users u
        WHERE u.org_id = c.org_id AND u.id = c.created_by),
      (SELECT u.id FROM kernel.timeline_entries te
         JOIN kernel.users u ON u.id = te.actor_id AND u.org_id = te.org_id
        WHERE te.org_id = c.org_id AND te.app = 'kernel' AND te.entity_type = 'contact'
          AND te.entity_id = c.id::text AND te.action = 'note'
        ORDER BY te.created_at LIMIT 1),
      (SELECT u.id FROM kernel.users u
        WHERE u.org_id = c.org_id ORDER BY u.created_at LIMIT 1)
    ) AS id
  ) creator
 WHERE creator.id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM kernel.timeline_entries te
      WHERE te.org_id = c.org_id AND te.app = 'kernel' AND te.entity_type = 'contact'
        AND te.entity_id = c.id::text AND te.action = 'note')
ON CONFLICT (org_id, handle) DO NOTHING;
--> statement-breakpoint

INSERT INTO kernel.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
SELECT t.id, t.org_id, 'kernel', 'contact', t.created_from ->> 'entityId', t.created_by
  FROM kernel.threads t
 WHERE t.handle LIKE 'contact-primary:%'
   AND t.created_from ->> 'entityType' = 'contact'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO kernel.messages
  (thread_id, org_id, author_id, author_type, author_agent_id, content, metadata,
   required_scopes, external_ref, created_at)
SELECT t.id,
       te.org_id,
       CASE
         WHEN u.id IS NOT NULL THEN u.id
         WHEN a.id IS NOT NULL THEN COALESCE(a.owner_user_id, t.created_by)
         ELSE t.created_by
       END,
       CASE WHEN u.id IS NOT NULL THEN 'user' WHEN a.id IS NOT NULL THEN 'agent' ELSE 'system' END,
       a.id,
       te.summary,
       CASE
         WHEN a.id IS NOT NULL THEN jsonb_build_object(
           'agentAuthorLabel',
           COALESCE(
             CASE WHEN a.kind <> 'personal' THEN a.display_name END,
             owner.name || '''s agent',
             a.display_name,
             'Agent'))
         ELSE NULL
       END,
       '{}'::text[],
       'contact-note:' || te.id::text,
       te.created_at
  FROM kernel.timeline_entries te
  JOIN kernel.threads t
    ON t.org_id = te.org_id AND t.handle = 'contact-primary:' || te.entity_id
  LEFT JOIN kernel.users u
    ON te.actor_type = 'user' AND u.id = te.actor_id AND u.org_id = te.org_id
  LEFT JOIN kernel.agents a
    ON te.actor_type = 'agent' AND a.id = te.actor_id AND a.org_id = te.org_id
  LEFT JOIN kernel.users owner
    ON owner.id = a.owner_user_id AND owner.org_id = a.org_id
 WHERE te.app = 'kernel' AND te.entity_type = 'contact' AND te.action = 'note'
ON CONFLICT (org_id, thread_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING;
--> statement-breakpoint

DELETE FROM kernel.timeline_entries te
 WHERE te.app = 'kernel' AND te.entity_type = 'contact' AND te.action = 'note'
   AND EXISTS (
     SELECT 1 FROM kernel.messages m
      WHERE m.org_id = te.org_id AND m.external_ref = 'contact-note:' || te.id::text);
