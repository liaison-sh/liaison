-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Invariant: an org that has at least one eligible inbox (kind = 'mailbox' AND
-- archived_at IS NULL) always has exactly one live default (is_default_for_create
-- = true AND archived_at IS NULL). The public ticket webhook resolves the target
-- inbox for an api-keyed caller with a plain SELECT for the live default and
-- REJECTS the ticket (422 inbox_required) when that returns nothing. An org can
-- reach zero live defaults several independent ways: archiving the default
-- inbox (the flag stays set on the now-archived row, which both blocks the
-- partial unique index from letting a replacement claim it AND is invisible to
-- the webhook's `archived_at IS NULL` filter), or creating the org's first
-- mailbox inbox alongside an existing api-kind inbox (an api inbox can never be
-- default, by inboxes_kind_shape_check, so the org has an inbox but no default).
--
-- This is enforced with a DB trigger rather than a service-level check because
-- four independent writers can produce the broken state and none of them is a
-- single choke point: the tickets admin ops (admin.ts inboxesCreate /
-- inboxesUpdate / inboxesDisconnect), the tickets app's mail-account-connected
-- handler (reached through the sandboxed app's db bridge, not admin.ts), the
-- CLI provisioners, and seeds. A trigger on the table itself covers all of
-- them, present and future, without relying on every call site remembering to
-- ask the question.
--
-- Deferred-until-commit (CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED)
-- is load-bearing, not incidental: `inboxesCreate` legitimately INSERTs a new
-- default-to-be inbox with is_default_for_create = false and then UPDATEs it
-- to true in the SAME transaction, and `inboxesUpdate` clears the old default
-- before setting the new one. A same-row trigger would see (and try to correct)
-- each of those intermediate, still-uncommitted states. Firing once at commit
-- lets the trigger judge only the end state actually being committed.
--
-- Backfill runs first and is set-based and idempotent: safe to re-run, and it
-- heals the exact class of already-broken org this invariant exists for.

-- Backfill: for every org with at least one eligible inbox and no live
-- default, first drop the flag from any archived row still carrying it (it
-- occupies the partial unique index and is invisible to the webhook anyway),
-- then hand the flag to the org's oldest eligible inbox.
WITH broken_orgs AS (
  SELECT DISTINCT i.org_id
  FROM app_tickets.inboxes i
  WHERE i.kind = 'mailbox' AND i.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_tickets.inboxes d
      WHERE d.org_id = i.org_id AND d.is_default_for_create = true AND d.archived_at IS NULL
    )
)
UPDATE app_tickets.inboxes
SET is_default_for_create = false, updated_at = now()
WHERE is_default_for_create = true
  AND archived_at IS NOT NULL
  AND org_id IN (SELECT org_id FROM broken_orgs);
--> statement-breakpoint

WITH broken_orgs AS (
  SELECT DISTINCT i.org_id
  FROM app_tickets.inboxes i
  WHERE i.kind = 'mailbox' AND i.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_tickets.inboxes d
      WHERE d.org_id = i.org_id AND d.is_default_for_create = true AND d.archived_at IS NULL
    )
),
oldest_eligible AS (
  SELECT DISTINCT ON (i.org_id) i.id, i.org_id
  FROM app_tickets.inboxes i
  JOIN broken_orgs b ON b.org_id = i.org_id
  WHERE i.kind = 'mailbox' AND i.archived_at IS NULL
  ORDER BY i.org_id, i.created_at, i.id
)
UPDATE app_tickets.inboxes t
SET is_default_for_create = true, updated_at = now()
FROM oldest_eligible o
WHERE t.id = o.id;
--> statement-breakpoint

-- SECURITY DEFINER + owned by the table owner (liaison_admin): app_tickets.inboxes
-- has FORCE ROW LEVEL SECURITY on, and its only policy (inboxes_deny_default)
-- is USING (false), so a normal RLS-scoped writer can see and touch zero rows
-- here. liaison_admin carries BYPASSRLS, which overrides FORCE RLS, so running
-- the body as that owner is what lets it read and heal ANY org's row regardless
-- of which role's write fired the trigger. Without SECURITY DEFINER the body
-- would run as the writing role, hit the deny-all policy, and silently affect
-- zero rows: the exact silent failure this migration exists to prevent.
CREATE OR REPLACE FUNCTION app_tickets.inboxes_ensure_default() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $FUNCTION_BODY$
DECLARE
  target_org UUID := COALESCE(NEW.org_id, OLD.org_id);
  has_live_default BOOLEAN;
  has_eligible BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM app_tickets.inboxes
    WHERE org_id = target_org AND is_default_for_create = true AND archived_at IS NULL
  ) INTO has_live_default;

  IF has_live_default THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM app_tickets.inboxes
    WHERE org_id = target_org AND kind = 'mailbox' AND archived_at IS NULL
  ) INTO has_eligible;

  IF NOT has_eligible THEN
    RETURN NULL;
  END IF;

  -- Free the partial unique index: an archived row can still carry the flag
  -- (e.g. it was the default when it got archived) and would otherwise
  -- collide with the row about to be promoted.
  UPDATE app_tickets.inboxes
  SET is_default_for_create = false
  WHERE org_id = target_org AND is_default_for_create = true AND archived_at IS NOT NULL;

  UPDATE app_tickets.inboxes
  SET is_default_for_create = true, updated_at = now()
  WHERE id = (
    SELECT id FROM app_tickets.inboxes
    WHERE org_id = target_org AND kind = 'mailbox' AND archived_at IS NULL
    ORDER BY created_at, id
    LIMIT 1
  );

  RETURN NULL;
END;
$FUNCTION_BODY$;
ALTER FUNCTION app_tickets.inboxes_ensure_default() OWNER TO liaison_admin;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inboxes_ensure_default ON app_tickets.inboxes;
CREATE CONSTRAINT TRIGGER inboxes_ensure_default
AFTER INSERT OR UPDATE OR DELETE ON app_tickets.inboxes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_tickets.inboxes_ensure_default();
