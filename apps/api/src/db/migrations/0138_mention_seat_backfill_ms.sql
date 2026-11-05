-- SPDX-License-Identifier: FSL-1.1-ALv2
-- 0137's backfill again, at the seat's precision (D23a).
--
-- A mention seat is anchored at its summoning message, but the anchor goes
-- through a JS Date: the seat keeps milliseconds while the message keeps
-- microseconds (demo 0ea6134d: message 19:52:46.753696, seat 19:52:46.753),
-- so 0137's `m.created_at <= tp.created_at` missed every anchored seat. The
-- message time is compared truncated to milliseconds. Same rule otherwise.
-- Re-runnable.

UPDATE kernel.thread_participants tp
   SET seat_origin = 'mention'
  FROM kernel.threads t
 WHERE t.id = tp.thread_id
   AND tp.participant_type = 'agent'
   AND tp.seat_origin IS NULL
   AND tp.role <> 'guest'
   AND t.type = 'thread'
   AND t.title IS NULL
   AND t.created_from IS NULL
   AND t.is_pinned = false
   AND (SELECT COUNT(*) FROM kernel.thread_participants h
         WHERE h.thread_id = t.id AND h.participant_type = 'user') = 2
   AND EXISTS (
     SELECT 1 FROM kernel.messages m
      WHERE m.thread_id = t.id
        AND m.org_id = t.org_id
        AND jsonb_typeof(m.mentions) = 'array'
        AND m.mentions @> jsonb_build_array(jsonb_build_object('type', 'agent', 'id', tp.agent_id::text))
        AND (
          date_trunc('milliseconds', m.created_at) <= tp.created_at
          OR EXISTS (SELECT 1 FROM kernel.messages r
                      WHERE r.id = m.reply_root_id
                        AND date_trunc('milliseconds', r.created_at) = tp.created_at)
        )
   );
