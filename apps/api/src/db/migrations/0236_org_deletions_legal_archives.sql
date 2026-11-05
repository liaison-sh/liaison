-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An operator's org deletion (`liaison org delete`, modules/org/delete/):
--
-- kernel.org_deletions, the deletion ledger: one row per deletion, written
-- before the org is marked deleting and updated after every step, so a crashed
-- deletion is resumed from it (by the org id, after the org row is gone) and
-- the instance keeps a record of every org it deleted, its waivers included.
--
-- kernel.legal_archives: one row per legal-retention archive (the org's legal
-- records, encrypted to the operator's age recipient, stored outside the org's
-- object prefix), with the date until which it is kept; a daily leader job
-- deletes the object once that date has passed.
-- The row is written before the upload with `recorded_at` NULL (pending) and
-- completed once the run records the archive; the same job deletes a pending
-- row (and its object) a day later, so a run that died mid-upload never leaves
-- an unindexed archive behind.
--
-- Both must SURVIVE the org they describe: no foreign key to
-- kernel.organizations, and no `org_id` column (the purge empties every kernel
-- table that has one, modules/org/purge/rows.ts); they name the org
-- `deleted_org_id`. Instance level, read and written by the privileged pool
-- only: RLS forced, no policy, no privilege for the request role.
--
-- Additive (new tables nobody reads before this release), every statement
-- re-runnable.
CREATE TABLE IF NOT EXISTS kernel.org_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_org_id uuid NOT NULL,
  org_slug text NOT NULL,
  org_name text NOT NULL,
  operator text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  steps_done text[] NOT NULL DEFAULT '{}'::text[],
  waivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  export jsonb,
  legal_archive_recipient text,
  archive_key text,
  counts jsonb,
  error text,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT org_deletions_status_chk CHECK (
    status IN ('started','queued','running','failed','completed','aborted')
  )
);
--> statement-breakpoint
-- At most one open deletion per org.
CREATE UNIQUE INDEX IF NOT EXISTS org_deletions_one_open_idx
  ON kernel.org_deletions (deleted_org_id) WHERE status NOT IN ('completed','aborted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_deletions_slug_idx ON kernel.org_deletions (org_slug, created_at);
--> statement-breakpoint
ALTER TABLE kernel.org_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_deletions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- expand-safe: a new table; the request role never touches it
REVOKE ALL ON kernel.org_deletions FROM liaison_rls;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.legal_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_org_id uuid NOT NULL,
  org_slug text NOT NULL,
  object_key text NOT NULL,
  recipient text NOT NULL,
  bytes bigint NOT NULL DEFAULT 0,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  recorded_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT legal_archives_object_key_uq UNIQUE (object_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS legal_archives_due_idx
  ON kernel.legal_archives (retain_until) WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE kernel.legal_archives ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.legal_archives FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- expand-safe: a new table; the request role never touches it
REVOKE ALL ON kernel.legal_archives FROM liaison_rls;
