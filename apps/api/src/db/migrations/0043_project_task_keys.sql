-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Jira-style task keys: each project gets a short uppercase `key` (e.g. ERB),
-- each task a per-project sequential `number`, so a task can be addressed as
-- `ERB-12` instead of an opaque uuid.
--
-- Three steps: add nullable columns, backfill every existing row, then lock
-- the columns down (NOT NULL + uniqueness + format check). Safe against
-- existing data per the migrations convention (IF NOT EXISTS, backfill
-- before NOT NULL).

ALTER TABLE app_projects.projects ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE app_projects.projects
  ADD COLUMN IF NOT EXISTS next_task_number integer NOT NULL DEFAULT 1;
ALTER TABLE app_projects.tasks ADD COLUMN IF NOT EXISTS number integer;
--> statement-breakpoint

-- Backfill project keys. Derivation rule (mirrored in
-- apps/projects/service/task-key.ts `deriveProjectKey` for new projects):
--   1. Strip everything but letters, split on whitespace into words.
--   2. One word  -> first 3 letters, uppercased.
--      2+ words  -> first 2 letters of word 1 + first letter of word 2.
--   3. Pad from any remaining letters in the name if still under 3 chars.
--   4. If still under 2 chars, fall back to 'PRJ'.
-- A small fixed set of production project names get an explicit, memorable
-- key instead of the mechanical derivation (matches what the org already
-- calls these boards in conversation).
-- Collisions within an org: replace the last character with 2..9, then A..Z
-- until the key is free.
DO $$
DECLARE
  proj RECORD;
  candidate text;
  letters text;
  words text[];
  suffix_chars text := '23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  i int;
BEGIN
  FOR proj IN SELECT id, org_id, name FROM app_projects.projects WHERE key IS NULL ORDER BY created_at, id
  LOOP
    candidate := CASE lower(trim(proj.name))
      WHEN 'eureka bugs' THEN 'ERB'
      WHEN 'feature requests' THEN 'FRQ'
      WHEN 'qa to-do' THEN 'QAT'
      WHEN 'website bugs' THEN 'WEB'
      WHEN 'dealer shipments' THEN 'DSH'
      WHEN 'support shipments & repairs' THEN 'SSR'
      WHEN 'logistique & litiges transporteurs' THEN 'LLT'
      ELSE NULL
    END;

    IF candidate IS NULL THEN
      letters := upper(regexp_replace(proj.name, '[^a-zA-Z]', '', 'g'));
      words := regexp_split_to_array(trim(regexp_replace(proj.name, '[^a-zA-Z]+', ' ', 'g')), '\s+');
      words := array_remove(words, '');

      IF array_length(words, 1) IS NULL OR array_length(words, 1) = 0 THEN
        candidate := NULL;
      ELSIF array_length(words, 1) = 1 THEN
        candidate := upper(left(words[1], 3));
      ELSE
        candidate := upper(left(words[1], 2)) || upper(left(words[2], 1));
      END IF;

      -- Pad from any remaining letters in the name if still short.
      IF candidate IS NOT NULL AND length(candidate) < 3 AND length(letters) > length(candidate) THEN
        candidate := upper(left(letters, 3));
      END IF;

      IF candidate IS NULL OR length(candidate) < 2 THEN
        candidate := 'PRJ';
      END IF;
    END IF;

    -- Collision handling within the org: replace the last char with 2..9,A..Z.
    IF EXISTS (
      SELECT 1 FROM app_projects.projects
      WHERE org_id = proj.org_id AND key = candidate AND id <> proj.id
    ) THEN
      FOR i IN 1..length(suffix_chars) LOOP
        IF NOT EXISTS (
          SELECT 1 FROM app_projects.projects
          WHERE org_id = proj.org_id
            AND key = left(candidate, length(candidate) - 1) || substr(suffix_chars, i, 1)
            AND id <> proj.id
        ) THEN
          candidate := left(candidate, length(candidate) - 1) || substr(suffix_chars, i, 1);
          EXIT;
        END IF;
      END LOOP;
    END IF;

    UPDATE app_projects.projects SET key = candidate WHERE id = proj.id;
  END LOOP;
END $$;
--> statement-breakpoint

-- Backfill task numbers: per-project sequential, ordered by creation.
UPDATE app_projects.tasks t
SET number = numbered.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
  FROM app_projects.tasks
) numbered
WHERE t.id = numbered.id AND t.number IS NULL;
--> statement-breakpoint

-- Set next_task_number to one past the highest allocated number per project.
UPDATE app_projects.projects p
SET next_task_number = COALESCE((
  SELECT max(t.number) + 1 FROM app_projects.tasks t WHERE t.project_id = p.id
), 1);
--> statement-breakpoint

ALTER TABLE app_projects.projects ALTER COLUMN key SET NOT NULL;
ALTER TABLE app_projects.tasks ALTER COLUMN number SET NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS app_projects_org_key_uidx
  ON app_projects.projects (org_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS app_projects_tasks_number_uidx
  ON app_projects.tasks (project_id, number);
--> statement-breakpoint

ALTER TABLE app_projects.projects DROP CONSTRAINT IF EXISTS app_projects_projects_key_format;
ALTER TABLE app_projects.projects
  ADD CONSTRAINT app_projects_projects_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$');
--> statement-breakpoint

-- Task-number allocation needs to UPDATE app_projects.projects.next_task_number,
-- but that column lives on a row gated by the projects_update RLS policy, which
-- requires projects:projects:write. Task creation itself only requires
-- projects:tasks:write (see the tasks_insert policy), so a role holding
-- tasks:write but not projects:write (e.g. the member role) could never
-- allocate a number and createTask would 404 with "project not found" even
-- though the actor is fully entitled to create the task. This SECURITY
-- DEFINER function narrows the privilege to exactly this one counter column,
-- checking projects:tasks:write itself instead of relying on the table policy.
CREATE OR REPLACE FUNCTION app_projects.allocate_task_number(_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_projects, pg_catalog
AS $FUNCTION_BODY$
DECLARE
  n integer;
  org uuid;
BEGIN
  IF NOT app_projects.app_has_scope('projects:tasks:write') THEN
    RAISE EXCEPTION 'insufficient_scope: projects:tasks:write required';
  END IF;
  org := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  IF org IS NULL THEN
    RAISE EXCEPTION 'no org context';
  END IF;
  UPDATE app_projects.projects
     SET next_task_number = next_task_number + 1
   WHERE id = _project_id AND org_id = org
  RETURNING next_task_number - 1 INTO n;
  RETURN n;
END
$FUNCTION_BODY$;
ALTER FUNCTION app_projects.allocate_task_number(uuid) OWNER TO liaison_admin;
REVOKE ALL ON FUNCTION app_projects.allocate_task_number(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_projects.allocate_task_number(uuid) TO liaison_rls;
