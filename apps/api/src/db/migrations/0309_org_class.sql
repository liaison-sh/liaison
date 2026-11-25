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
-- What the guard and the backfill read and write, as liaison_admin. It owns the tables where 0000
-- made them; a schema since handed to another login leaves it none of these.
GRANT USAGE ON SCHEMA kernel TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.organizations, kernel.org_billing_state, kernel.cloud_request_outcomes TO liaison_admin;
--> statement-breakpoint
GRANT UPDATE ON kernel.organizations TO liaison_admin;
--> statement-breakpoint
-- The tables force row security and their policies name the runtime roles only, so a migration
-- login that is neither superuser nor BYPASSRLS would read no row (see 0283): the guard would
-- pass and the backfill change nothing. Both run as liaison_admin (BYPASSRLS), which 0000 makes
-- every migration login a member of; a login that is not fails here, loudly.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
-- A demo marker on a customer's org (a billing row, or created by the control plane) is a
-- contradiction a person must resolve: stop before writing.
-- reviewed-dynamic: reads only, then raises; no DDL.
DO $$
DECLARE billed text;
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'org class: % is held to row security, so the orgs cannot all be read; give it BYPASSRLS (as 0000 does), then migrate again', current_user;
  END IF;
  SELECT string_agg(o.id::text, ', ' ORDER BY o.id) INTO billed
    FROM kernel.organizations o
   WHERE jsonb_typeof(o.settings->'demo') = 'object'
     AND o.settings->'demo'->>'variant' IN ('reserved', 'visitor')
     AND (EXISTS (SELECT 1 FROM kernel.org_billing_state b WHERE b.org_id = o.id)
       OR EXISTS (SELECT 1 FROM kernel.cloud_request_outcomes r
                   WHERE r.endpoint = 'POST /orgs' AND r.idem_key = o.slug));
  IF billed IS NOT NULL THEN
    RAISE EXCEPTION 'org class: these orgs carry both a demo marker (settings.demo) and a billing row or a control plane create: %. A demo org is no customer''s. Remove settings.demo from a customer org, or the org_billing_state row of a demo org, then migrate again', billed;
  END IF;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- expand-safe: a new column with a default; the previous release never writes it.
ALTER TABLE kernel.organizations
  ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'standard'
    CONSTRAINT organizations_class_check CHECK (class IN ('standard', 'demo'));
--> statement-breakpoint
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
UPDATE kernel.organizations
   SET class = 'demo'
 WHERE class = 'standard'
   AND jsonb_typeof(settings->'demo') = 'object'
   AND settings->'demo'->>'variant' IN ('reserved', 'visitor');
--> statement-breakpoint
RESET ROLE;
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
