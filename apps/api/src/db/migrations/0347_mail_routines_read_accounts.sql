-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Two shipped routine templates draft mail with `mail__compose`, which reads the mailbox it sends
-- from (mail:accounts:read), and did not list that read: Failed payments (Stripe) and Deal
-- follow-ups. Their routines ran green and drafted nothing. The templates list it now; this adds it
-- to the routines made from them, which keep the scopes they were enabled with. Only where the
-- routine still drafts mail, its owner holds the read by a role or a grant of their own, and its
-- agent's ceiling covers it: a routine given a scope its owner lacks would pause instead. Only adds.
--
-- A routine's scopes change here, but nobody edited the routine: its last editor (0230) is kept,
-- so the routines_mark_definition_edit trigger is held off for this one update only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the trigger is off for this transaction's own update only, and on again before it commits
ALTER TABLE kernel.routines DISABLE TRIGGER routines_mark_definition_edit;
--> statement-breakpoint
-- Run as liaison_admin (BYPASSRLS): the tables force row security, so a migration login that is no
-- superuser would read no row and change nothing.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
UPDATE kernel.routines r
   SET scopes = array_append(r.scopes, 'mail:accounts:read')
 WHERE ((r.source_kind = 'app' AND r.app_name = 'stripe' AND r.template_key = 'failed-payments')
     OR (r.source_kind = 'kernel' AND r.template_key = 'deal-followups'))
   AND 'mail:conversations:write' = ANY (r.scopes)
   AND NOT r.scopes && ARRAY['mail:accounts:read', 'mail:accounts:*', 'mail:accounts',
                             'mail:*', 'mail', '*']::text[]
   AND (EXISTS (
          SELECT 1 FROM kernel.user_roles ur
            JOIN kernel.role_scope_grants g ON g.role_id = ur.role_id
           WHERE ur.user_id = r.owner_user_id AND ur.org_id = r.org_id
             AND g.scope IN ('mail:accounts:read', 'mail:accounts:*', 'mail:accounts',
                             'mail:*', 'mail', '*'))
     OR EXISTS (
          SELECT 1 FROM kernel.user_scope_grants g
           WHERE g.user_id = r.owner_user_id AND g.org_id = r.org_id
             AND g.scope IN ('mail:accounts:read', 'mail:accounts:*', 'mail:accounts',
                             'mail:*', 'mail', '*')))
   AND (r.owner_agent_id IS NULL
     OR EXISTS (
          SELECT 1 FROM kernel.agents a
           WHERE a.id = r.owner_agent_id AND a.org_id = r.org_id
             AND a.scope_ceiling ?| ARRAY['mail:accounts:read', 'mail:accounts:*', 'mail:accounts',
                                          'mail:*', 'mail', '*']));
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- expand-safe: the trigger 0230 created, back on with its own definition unchanged
ALTER TABLE kernel.routines ENABLE TRIGGER routines_mark_definition_edit;
