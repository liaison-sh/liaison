-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.contact_addresses: a contact's address book, with verification.
--
-- One row per postal address of a contact: billing, delivery or other. Where
-- the row came from is `origin` (typed by hand, an import, an order sync, or
-- this migration's copy of the legacy metadata). Whether a person checked it
-- is the verification: `verified_at`, `verified_by` and `source` (what the
-- person checked it against: a purchase order, an email, a phone call),
-- optionally with a note and a file. The three are set together or not at
-- all; the CHECK below makes a verification without a verifier and a basis
-- impossible, so nothing can mark an address verified anonymously.
--
-- `verified_by` carries no ON DELETE action: SET NULL would break that CHECK
-- while the address still exists (the org purge deletes table by table and
-- retries what a foreign key refuses, a CHECK failure would stop it). A user
-- merge re-points the column first (users/merge-references.ts), and erasure
-- keeps the user row.
--
-- RLS: an address is visible exactly when its contact is visible to the reader
-- (the policies read kernel.contacts under the caller's own RLS, the 0124
-- pattern), so a restricted contact's addresses never show to someone who
-- cannot see the contact. Writing one needs the contact to be editable by the
-- caller, mirroring contacts_update (0117).
--
-- Backfill: each contact's `metadata.shipping_address` (an object written by
-- the shipping app) becomes one delivery address, origin `legacy_metadata`,
-- NOT verified: nobody checked it. A metadata value that is not a JSON object
-- (a double-encoded string) is left out; the metadata itself is not changed,
-- so the shipping app's legacy reader still sees it. A country that is not a
-- two-letter code is left empty on the row (it stays in the metadata). The
-- copy runs once per contact: a second run adds nothing.
--
-- A new table, every statement re-runnable.

CREATE TABLE IF NOT EXISTS kernel.contact_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES kernel.contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'delivery'
    CONSTRAINT contact_addresses_role_check CHECK (role IN ('billing', 'delivery', 'other')),
  label text,
  name text,
  company text,
  street1 text,
  street2 text,
  city text,
  postal_code text,
  region text,
  country_iso2 text,
  phone text,
  email text,
  origin text NOT NULL DEFAULT 'manual'
    CONSTRAINT contact_addresses_origin_check
    CHECK (origin IN ('manual', 'import', 'order_sync', 'legacy_metadata')),
  verified_at timestamptz,
  verified_by uuid REFERENCES kernel.users(id),
  source text
    CONSTRAINT contact_addresses_source_check
    CHECK (source IS NULL OR source IN ('purchase_order', 'email', 'phone_call', 'other')),
  source_note text,
  source_file_id uuid REFERENCES kernel.files(id) ON DELETE SET NULL,
  stale_at timestamptz,
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT contact_addresses_verification_check
    CHECK ((verified_at IS NULL) = (verified_by IS NULL)
           AND (verified_at IS NULL) = (source IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_addresses_contact_idx
  ON kernel.contact_addresses (org_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_addresses_contact_id_fk_idx
  ON kernel.contact_addresses (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_addresses_verified_by_fk_idx
  ON kernel.contact_addresses (verified_by) WHERE verified_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_addresses_created_by_fk_idx
  ON kernel.contact_addresses (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_addresses_source_file_fk_idx
  ON kernel.contact_addresses (source_file_id) WHERE source_file_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE kernel.contact_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.contact_addresses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.contact_addresses TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS contact_addresses_select ON kernel.contact_addresses;
--> statement-breakpoint
CREATE POLICY contact_addresses_select ON kernel.contact_addresses FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.contacts c WHERE c.id = contact_addresses.contact_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contact_addresses_insert ON kernel.contact_addresses;
--> statement-breakpoint
CREATE POLICY contact_addresses_insert ON kernel.contact_addresses FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.contacts c
       WHERE c.id = contact_addresses.contact_id
         AND c.org_id = contact_addresses.org_id
         AND (
           c.org_access = 'editor'
           OR c.owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
           OR kernel.resource_grant_role('kernel.contact', c.id) = 'editor'
         )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contact_addresses_update ON kernel.contact_addresses;
--> statement-breakpoint
CREATE POLICY contact_addresses_update ON kernel.contact_addresses FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.contacts c
       WHERE c.id = contact_addresses.contact_id
         AND (
           c.org_access = 'editor'
           OR c.owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
           OR kernel.resource_grant_role('kernel.contact', c.id) = 'editor'
         )
    )
  )
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.contacts c
       WHERE c.id = contact_addresses.contact_id
         AND c.org_id = contact_addresses.org_id
         AND (
           c.org_access = 'editor'
           OR c.owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
           OR kernel.resource_grant_role('kernel.contact', c.id) = 'editor'
         )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contact_addresses_delete ON kernel.contact_addresses;
--> statement-breakpoint
CREATE POLICY contact_addresses_delete ON kernel.contact_addresses FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.contacts c
       WHERE c.id = contact_addresses.contact_id
         AND (
           c.org_access = 'editor'
           OR c.owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
           OR kernel.resource_grant_role('kernel.contact', c.id) = 'editor'
         )
    )
  );
--> statement-breakpoint

INSERT INTO kernel.contact_addresses
  (org_id, contact_id, role, name, company, street1, street2, city, postal_code, region,
   country_iso2, phone, email, origin)
SELECT f.org_id, f.contact_id, 'delivery', f.name, f.company, f.street1, f.street2, f.city,
       f.postal_code, f.region,
       CASE WHEN f.country ~ '^[A-Za-z]{2}$' THEN upper(f.country) END,
       f.phone, f.email, 'legacy_metadata'
  FROM (
    SELECT c.org_id,
           c.id AS contact_id,
           NULLIF(btrim(a ->> 'name'), '') AS name,
           NULLIF(btrim(a ->> 'company'), '') AS company,
           COALESCE(NULLIF(btrim(a ->> 'street'), ''), NULLIF(btrim(a ->> 'street1'), ''),
                    NULLIF(btrim(a ->> 'address1'), '')) AS street1,
           COALESCE(NULLIF(btrim(a ->> 'street2'), ''), NULLIF(btrim(a ->> 'address2'), '')) AS street2,
           NULLIF(btrim(a ->> 'city'), '') AS city,
           COALESCE(NULLIF(btrim(a ->> 'postalCode'), ''), NULLIF(btrim(a ->> 'postal_code'), ''),
                    NULLIF(btrim(a ->> 'zip'), '')) AS postal_code,
           COALESCE(NULLIF(btrim(a ->> 'state'), ''), NULLIF(btrim(a ->> 'province'), ''),
                    NULLIF(btrim(a ->> 'province_code'), ''), NULLIF(btrim(a ->> 'region'), '')) AS region,
           COALESCE(NULLIF(btrim(a ->> 'countryIsoCode'), ''), NULLIF(btrim(a ->> 'country_iso_code'), ''),
                    NULLIF(btrim(a ->> 'countryCode'), ''), NULLIF(btrim(a ->> 'country'), '')) AS country,
           NULLIF(btrim(a ->> 'phone'), '') AS phone,
           NULLIF(btrim(a ->> 'email'), '') AS email
      FROM kernel.contacts c
      CROSS JOIN LATERAL (SELECT c.metadata -> 'shipping_address' AS a) m
     WHERE jsonb_typeof(c.metadata) = 'object'
       AND jsonb_typeof(m.a) = 'object'
       AND NOT EXISTS (
         SELECT 1 FROM kernel.contact_addresses x
          WHERE x.contact_id = c.id AND x.origin = 'legacy_metadata')
  ) f
 WHERE f.street1 IS NOT NULL OR f.city IS NOT NULL OR f.postal_code IS NOT NULL;
