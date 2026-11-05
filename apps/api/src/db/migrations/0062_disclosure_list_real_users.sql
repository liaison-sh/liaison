-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P2b-T17: a disclosure list holds only real user ids. withRlsContext sets
-- app.current_user_id to the NIL uuid for a system or non-uuid actor, and the
-- messages SELECT policy (0060) admits any viewer whose id is on
-- disclosure_list, so a NIL entry would expose the message to every such
-- actor. A NULL entry matches nobody but is refused too: an entry must name a
-- person. array_position compares with IS NOT DISTINCT FROM, so it finds both.
-- Applied to kernel.messages and to kernel.audit_log (whose disclosure_list
-- records the same snapshot). Nothing writes either column yet, so existing
-- rows are all NULL and validate trivially.
-- Re-runnable: DROP CONSTRAINT IF EXISTS before each ADD.
ALTER TABLE kernel.messages DROP CONSTRAINT IF EXISTS messages_disclosure_list_real_users_chk;
--> statement-breakpoint
ALTER TABLE kernel.messages
  ADD CONSTRAINT messages_disclosure_list_real_users_chk CHECK (
    disclosure_list IS NULL OR (
      array_position(disclosure_list, '00000000-0000-0000-0000-000000000000'::uuid) IS NULL
      AND array_position(disclosure_list, NULL::uuid) IS NULL
    )
  );
--> statement-breakpoint
ALTER TABLE kernel.audit_log DROP CONSTRAINT IF EXISTS audit_log_disclosure_list_real_users_chk;
--> statement-breakpoint
ALTER TABLE kernel.audit_log
  ADD CONSTRAINT audit_log_disclosure_list_real_users_chk CHECK (
    disclosure_list IS NULL OR (
      array_position(disclosure_list, '00000000-0000-0000-0000-000000000000'::uuid) IS NULL
      AND array_position(disclosure_list, NULL::uuid) IS NULL
    )
  );
