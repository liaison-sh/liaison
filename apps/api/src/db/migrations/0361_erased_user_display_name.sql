-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An erased person's messages are signed "Deleted user", not "deleted-user-<uuid>".
--
-- Erasure tombstones the person's `kernel.users` row and keeps what they wrote in shared threads,
-- ticket notes and task comments. It used to set the row's name to the same placeholder as its
-- email (`deleted-user-<uuid>`), so every one of those surfaces printed that placeholder as the
-- author. Erasure now sets the neutral name (`ERASED_USER_DISPLAY_NAME`, the per-org sentinel
-- row's name too), which the web shows in the reader's language. This gives the rows erased
-- before that change the same name.
--
-- Only tombstones: a row whose email is the erasure placeholder for its own id, which is what
-- marks it erased (`erasedUserEmail`), and whose name is not already the neutral one. The name
-- holds no personal data. Re-runnable: a second run matches no row.
UPDATE kernel.users
  SET name = 'Deleted user', updated_at = now()
  WHERE email = 'deleted-user-' || id::text
    AND name IS DISTINCT FROM 'Deleted user';
