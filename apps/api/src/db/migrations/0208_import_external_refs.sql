-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Import external refs (modules/imports, kinds knowledge.*, calendar.event,
-- chat.message, projects.task dependencies).
--
-- An import dedups by `<source>:<key>` stored in the app's own external ref
-- (A13): a nullable TEXT column plus a partial unique index, the shape of
-- app_tickets.tickets.external_ref and 0013's app_projects.tasks. NULLs (rows
-- written by the app itself) are exempt; only imported rows pay the
-- constraint, and a duplicate insert is a 23505 the runner counts as skipped.
--
--   app_knowledge.documents    (org_id, external_ref)
--   app_knowledge.collections  (org_id, external_ref)
--   app_calendar.events        (org_id, calendar_id, external_ref): the
--                              calendar app's tables are created by its
--                              manifest at registration, so this half runs
--                              only when the table already exists; the
--                              manifest declares the same column and index.
--   kernel.messages            (org_id, thread_id, external_ref). The index
--                              build reads the table once, under a SHARE lock
--                              (writes to messages wait for it: about 1 s per
--                              million rows). Not CONCURRENTLY: the migrator
--                              runs each file in one transaction (as 0116 and
--                              0156 note), where CONCURRENTLY is refused.
--
-- kernel.import_ledger gets a partial unique index on the files it names: a
-- stored file is on one run's ledger at most, so two runs can never both claim
-- (and undo) the same file.
--
-- The calendar `sync_status` CHECK gains `imported` through the calendar
-- manifest (its enum), applied by the app's schema sync when the app registers,
-- which every server does at boot before it serves an import.
--
-- app_projects.task_dependencies gains an `id`: its key is (task_id,
-- depends_on_task_id) and the import ledger names rows by id, so a dependency
-- an import created can be recorded and undone like any other row.
--
-- The knowledge and calendar manifests mirror these columns and indexes (same
-- names), so the app's schema sync keeps them. Columns inherit the tables'
-- grants. Every statement is re-runnable.

ALTER TABLE app_knowledge.documents ADD COLUMN IF NOT EXISTS external_ref TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_knowledge_documents_external_ref
  ON app_knowledge.documents (org_id, external_ref) WHERE external_ref IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app_knowledge.collections ADD COLUMN IF NOT EXISTS external_ref TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_knowledge_collections_external_ref
  ON app_knowledge.collections (org_id, external_ref) WHERE external_ref IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('app_calendar.events') IS NOT NULL THEN
    ALTER TABLE app_calendar.events ADD COLUMN IF NOT EXISTS external_ref TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_calendar_events_calendar_id_external_ref
      ON app_calendar.events (org_id, calendar_id, external_ref) WHERE external_ref IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.messages ADD COLUMN IF NOT EXISTS external_ref TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kernel_messages_thread_external_ref
  ON kernel.messages (org_id, thread_id, external_ref) WHERE external_ref IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app_projects.task_dependencies
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_projects_task_dependencies_id_key
  ON app_projects.task_dependencies (id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_ledger_files_once
  ON kernel.import_ledger (row_id) WHERE table_name = 'kernel.files';
