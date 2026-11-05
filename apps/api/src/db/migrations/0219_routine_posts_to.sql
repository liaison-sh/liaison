-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine has ONE "where it posts": report_thread_id.
--
-- A routine's output thread (output_thread_id) could be pointed at a
-- conversation, a second way to choose where a routine posts beside
-- report_thread_id (0166). It is now internal: always the routine's own run
-- thread (type 'routine'), created on its first run.
--
-- A routine whose output thread is a conversation its owner sits in moves that
-- conversation to report_thread_id (when it has none yet; an existing choice
-- wins), and its output thread is cleared, so its next run makes its own run
-- thread as a new routine does. A routine whose owner does not sit in that
-- conversation keeps it as it is: posting there needs the owner's seat, and
-- clearing it would drop the only place its runs go.
--
-- Re-runnable: a second run finds no routine whose output thread is a
-- conversation.
UPDATE kernel.routines r
   SET report_thread_id = COALESCE(r.report_thread_id, r.output_thread_id),
       output_thread_id = NULL,
       updated_at = now()
  FROM kernel.threads t
 WHERE t.id = r.output_thread_id
   AND t.org_id = r.org_id
   AND t.type <> 'routine'
   AND EXISTS (
     SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = t.id AND tp.org_id = r.org_id AND tp.user_id = r.owner_user_id
   );
