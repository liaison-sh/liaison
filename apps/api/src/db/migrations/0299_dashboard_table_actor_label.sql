-- A named agent's handle is stored with its "@" ("@logistics"), and the table history wrote one
-- more in front ("@@logistics"). The writer no longer adds it (dashboards/tables/service.ts,
-- writerOf); this rewrites the labels already written. Idempotent: a label written once has a
-- single "@" and is left alone.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
UPDATE kernel.dashboard_table_changes
   SET actor_label = substr(actor_label, 2)
 WHERE actor_type = 'agent' AND actor_label LIKE '@@%';
