-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The class of an org, as a database fact: `standard`, or `demo` (a disposable workspace of a
-- demo instance). Until now only the jsonb marker `settings.demo` said so, and the demo purge and
-- the immutability trigger trusted it: one bad write to `settings` made a customer's org purgeable
-- and its legal records deletable. The class is written when the org is created.
--
-- Orgs that carry a valid marker today become `demo`. `org_billing_state` can only hold a
-- `standard` org: (org_id, org_class) references (id, class). The release that forbids changing a
-- class, and a marker on a `standard` org, comes after this one: the previous release still
-- creates demo orgs without a class while both run.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A billed org with a demo marker is a contradiction a person must resolve: stop before writing.
-- reviewed-dynamic: reads only, then raises; no DDL.
DO $$
DECLARE billed text;
BEGIN
  SELECT string_agg(o.id::text, ', ' ORDER BY o.id) INTO billed
    FROM kernel.organizations o
    JOIN kernel.org_billing_state b ON b.org_id = o.id
   WHERE jsonb_typeof(o.settings->'demo') = 'object'
     AND o.settings->'demo'->>'variant' IN ('reserved', 'visitor');
  IF billed IS NOT NULL THEN
    RAISE EXCEPTION 'org class: these orgs carry both a demo marker (settings.demo) and a billing row: %. A demo org cannot be billed. Remove settings.demo from a customer org, or the org_billing_state row of a demo org, then migrate again', billed;
  END IF;
END $$;
--> statement-breakpoint
-- expand-safe: a new column with a default; the previous release never writes it.
ALTER TABLE kernel.organizations
  ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'standard'
    CONSTRAINT organizations_class_check CHECK (class IN ('standard', 'demo'));
--> statement-breakpoint
UPDATE kernel.organizations
   SET class = 'demo'
 WHERE class = 'standard'
   AND jsonb_typeof(settings->'demo') = 'object'
   AND settings->'demo'->>'variant' IN ('reserved', 'visitor');
--> statement-breakpoint
-- index-build: kernel.organizations 20000 12ms
CREATE UNIQUE INDEX IF NOT EXISTS organizations_id_class_key ON kernel.organizations (id, class);
--> statement-breakpoint
-- expand-safe: a new column with a default; the previous release never writes it, and every org it bills is `standard`.
ALTER TABLE kernel.org_billing_state
  ADD COLUMN IF NOT EXISTS org_class text NOT NULL DEFAULT 'standard'
    CONSTRAINT org_billing_state_org_class_check CHECK (org_class = 'standard');
--> statement-breakpoint
-- expand-safe: the guard above proved no billed org is a demo org, and the previous release bills only customer orgs.
ALTER TABLE kernel.org_billing_state
  ADD CONSTRAINT org_billing_state_org_class_fk FOREIGN KEY (org_id, org_class)
    REFERENCES kernel.organizations (id, class) ON DELETE CASCADE;
