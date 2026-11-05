-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-org caps (modules/org/caps.ts): seats, mailboxes, storage and background
-- jobs per hour. Only the operator sets them (`liaison org caps`, or the
-- `limits` section of `liaison config apply`); an org admin reads them in
-- Settings -> Organization and cannot change them. A missing or null key is
-- unlimited, so every existing org and every new one starts unlimited.
--
-- The storage quota used to live in `settings.storageQuotaGb`, an org setting
-- an org admin could change. Its value 10 is the historical column default,
-- carried by every org whether anyone chose it or not, so it maps to
-- "unlimited"; any other positive value was someone's choice and is copied
-- into `caps.storageGb`, rounded up to whole GB (a cap is a whole number).
-- 0 (or less) already meant unlimited. The old key is
-- left in the rows for the previous release, which still reads it during a
-- deploy, and is dropped from the column default so a new org no longer
-- carries it.
-- Accepted: during a rolling deploy the previous release still reads
-- `settings.storageQuotaGb ?? 10`, so an org it creates after this migration
-- has a 10 GB quota from that release until the new one serves it (harmless
-- on a single node; the new release reads only `caps`).
--
-- Additive and re-runnable.
-- A catalog-only change, but every org read queues behind an ALTER waiting for
-- a long transaction: fail fast and retry the deploy instead.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.organizations ADD COLUMN IF NOT EXISTS caps jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
UPDATE kernel.organizations
SET caps = caps || jsonb_build_object(
  'storageGb', ceil((settings ->> 'storageQuotaGb')::numeric)::bigint
)
WHERE caps -> 'storageGb' IS NULL
  AND CASE WHEN jsonb_typeof(settings -> 'storageQuotaGb') = 'number'
        THEN (settings ->> 'storageQuotaGb')::numeric > 0
         AND (settings ->> 'storageQuotaGb')::numeric <> 10
        ELSE false END;
--> statement-breakpoint
ALTER TABLE kernel.organizations
  ALTER COLUMN settings SET DEFAULT '{"fileSizeLimitMb":50,"auditRetentionDays":90}'::jsonb;
--> statement-breakpoint
-- Every cap is a whole number of at least 1: unlimited is the key's
-- absence (or null), never 0, which the job cap would read as "no limit" and
-- the seat cap as "nobody". Keys this release does not know are left alone for
-- a later one. Dropped first so a re-run re-adds it.
-- expand-safe: drops only this file's own constraint, which no release before this one has
ALTER TABLE kernel.organizations DROP CONSTRAINT IF EXISTS organizations_caps_valid;
--> statement-breakpoint
-- expand-safe: checks only the caps column added above, which the previous release never writes
ALTER TABLE kernel.organizations ADD CONSTRAINT organizations_caps_valid CHECK (
  jsonb_typeof(caps) = 'object'
  AND CASE jsonb_typeof(caps -> 'seats')
    WHEN 'number' THEN (caps ->> 'seats')::numeric >= 1 AND (caps ->> 'seats')::numeric = trunc((caps ->> 'seats')::numeric)
    WHEN 'null' THEN true
    ELSE caps -> 'seats' IS NULL END
  AND CASE jsonb_typeof(caps -> 'mailboxes')
    WHEN 'number' THEN (caps ->> 'mailboxes')::numeric >= 1 AND (caps ->> 'mailboxes')::numeric = trunc((caps ->> 'mailboxes')::numeric)
    WHEN 'null' THEN true
    ELSE caps -> 'mailboxes' IS NULL END
  AND CASE jsonb_typeof(caps -> 'storageGb')
    WHEN 'number' THEN (caps ->> 'storageGb')::numeric >= 1 AND (caps ->> 'storageGb')::numeric = trunc((caps ->> 'storageGb')::numeric)
    WHEN 'null' THEN true
    ELSE caps -> 'storageGb' IS NULL END
  AND CASE jsonb_typeof(caps -> 'jobsPerHour')
    WHEN 'number' THEN (caps ->> 'jobsPerHour')::numeric >= 1 AND (caps ->> 'jobsPerHour')::numeric = trunc((caps ->> 'jobsPerHour')::numeric)
    WHEN 'null' THEN true
    ELSE caps -> 'jobsPerHour' IS NULL END
);
