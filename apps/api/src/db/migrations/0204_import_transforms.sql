-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.import_transforms: the transforms an org's imports run, versioned.
--
-- A transform is a plain script (modules/imports/transforms) that turns an
-- export into import records. Saving a transform under an existing name adds
-- the next version; a version is never changed afterwards, so an import run
-- that references (id, version) always runs the code that was previewed and
-- approved. An API-source transform names the api-connector connection it
-- pulls from; the hosts it may be redirected to are declared on that
-- connection's adapter (`redirectHosts`), never here, so transform code can
-- never widen its own egress.
--
-- RLS: reached only through the privileged connection (the import tools and
-- the runner, which take orgId from the run). FORCE RLS plus a deny-all
-- SELECT policy for liaison_rls and no write policy (the 0058 template).
--
-- Versions are immutable: a trigger refuses any UPDATE that changes anything
-- but `created_by` (which ON DELETE SET NULL clears when the author's user is
-- deleted), for every role, the privileged one included.
--
-- Every statement is re-runnable.

CREATE TABLE IF NOT EXISTS kernel.import_transforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL,
  source text NOT NULL,
  kinds text[] NOT NULL DEFAULT '{}',
  source_type text NOT NULL,
  connection_identifier text,
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_transforms_version_chk CHECK (version >= 1),
  CONSTRAINT import_transforms_source_type_chk CHECK (source_type IN ('upload', 'api')),
  CONSTRAINT import_transforms_connection_chk CHECK (
    (source_type = 'api') = (connection_identifier IS NOT NULL)
  ),
  CONSTRAINT import_transforms_source_len_chk CHECK (char_length(source) <= 200000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_transforms_org_name_version_idx
  ON kernel.import_transforms (org_id, name, version);
--> statement-breakpoint
ALTER TABLE kernel.import_transforms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.import_transforms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.import_transforms TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS import_transforms_select ON kernel.import_transforms;
--> statement-breakpoint
CREATE POLICY import_transforms_select ON kernel.import_transforms FOR SELECT TO liaison_rls
  USING (false);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.import_transforms_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.kinds IS DISTINCT FROM OLD.kinds
    OR NEW.source_type IS DISTINCT FROM OLD.source_type
    OR NEW.connection_identifier IS DISTINCT FROM OLD.connection_identifier
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'import transform versions are immutable: save a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS import_transforms_immutable ON kernel.import_transforms;
--> statement-breakpoint
CREATE TRIGGER import_transforms_immutable BEFORE UPDATE ON kernel.import_transforms
  FOR EACH ROW EXECUTE FUNCTION kernel.import_transforms_immutable();
