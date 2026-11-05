-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.scope_disclosure_policy: the tighten-only rule (spec-security.md S7)
-- becomes a DATABASE invariant. This deliberately reverses the note 0068 left.
--
-- 0068 argued that a CHECK cannot see the old row, so the transition rule
-- belonged to P2b-T09's code guard alone, and that a second authority in the
-- database would make that guard's failure mode ambiguous. A skeptic pass then
-- measured the result: as an org admin, `UPDATE kernel.scope_disclosure_policy
-- SET disclosable = true` on a tightened row SUCCEEDED (1 row).
-- `updateScopeDisclosurePolicy` has no production caller yet, so the first
-- caller that writes its own UPDATE would drop the invariant silently. And
-- `liaison_app` is BYPASSRLS, so a privileged handle could DELETE a tightened
-- row and let the scope fall back to the disclosable default.
--
-- A CHECK still cannot express this. A TRIGGER can, because it sees OLD and
-- NEW, and triggers also run for the BYPASSRLS roles (`liaison_app`,
-- `liaison_admin`): those roles skip row security, never triggers.
--
-- TWO AUTHORITIES, KEPT UNAMBIGUOUS
--   * P2b-T09 remains the authority every caller is meant to meet. It refuses
--     the loosening in code, BEFORE any SQL, with the friendly typed error
--     `E_DISCLOSURE_POLICY_LOOSENING`, and it never writes `true` at all, so no
--     correct path can reach this trigger.
--   * This trigger is the backstop UNDERNEATH that guard. Its firing means
--     something bypassed T09, which is a different fact and so gets a different
--     shape: SQLSTATE `LI001` (a user-defined class, which can never collide
--     with a Postgres condition) plus the fixed message
--     `scope_disclosure_policy_tighten_only`. A handler can tell the two apart
--     on the code alone, without string matching, so T09's error stays the
--     friendly one at the app layer.
--
-- WHY THE DELETE IS SUPPRESSED RATHER THAN RAISED
-- 0068 already refuses the delete for `liaison_rls` by giving it no DELETE
-- policy: that affects 0 rows and raises nothing. This keeps exactly that shape
-- for the privileged handles. The row survives and the statement reports 0 rows
-- (plus a server WARNING), rather than bolting a second, fatal failure mode
-- onto a statement that is already a silent no-op for every other caller. The
-- invariant is what matters, and it holds either way: while its organization
-- exists, a tightened row cannot be removed.
--
-- THE ONE DELETE THAT PROCEEDS is the `org_id` FK cascade. Once the
-- organization is gone the policy row governs nothing, and suppressing the
-- cascade would be actively harmful: Postgres does not re-check the foreign key
-- after a BEFORE DELETE trigger returns NULL, so the row would silently outlive
-- the organization it points at. The trigger separates the two cases by looking
-- for the parent, which a cascade has already deleted and a direct delete has
-- not.
--
-- RE-RUNNABLE: CREATE OR REPLACE FUNCTION is naturally idempotent and each
-- trigger is dropped by name before it is created, following the convention
-- 0033/0045/0051/0053 established for a journal `when` raised above an
-- already-deployed highwater re-running this file.

CREATE OR REPLACE FUNCTION kernel.scope_disclosure_policy_tighten_only() RETURNS TRIGGER AS $TRIGGER_BODY$
BEGIN
  -- Only a row that is ALREADY non-disclosable is protected: tightening
  -- (true -> false) and re-tightening (false -> false, the shape T09's
  -- onConflictDoUpdate writes) stay ordinary writes, and a disclosable row can
  -- still be edited or removed freely.
  IF TG_OP = 'DELETE' THEN
    IF OLD.disclosable = false
       AND EXISTS (SELECT 1 FROM kernel.organizations WHERE id = OLD.org_id)
    THEN
      RAISE WARNING 'scope_disclosure_policy_tighten_only: refused to delete the non-disclosable row for scope % (org %)', OLD.scope, OLD.org_id;
      RETURN NULL;
    END IF;
    RETURN OLD;
  END IF;

  -- Renaming the scope or moving the row to another organization would leave
  -- the ORIGINAL scope with no row, i.e. back to the disclosable default: the
  -- same loosening, spelled differently.
  IF OLD.disclosable = false
     AND (NEW.disclosable = true
          OR NEW.scope IS DISTINCT FROM OLD.scope
          OR NEW.org_id IS DISTINCT FROM OLD.org_id)
  THEN
    RAISE EXCEPTION 'scope_disclosure_policy_tighten_only'
      USING ERRCODE = 'LI001',
            DETAIL = 'a scope marked non-disclosable can never be made disclosable again, renamed, or moved to another organization';
  END IF;

  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS scope_disclosure_policy_tighten_only ON kernel.scope_disclosure_policy;
CREATE TRIGGER scope_disclosure_policy_tighten_only
  BEFORE UPDATE ON kernel.scope_disclosure_policy
  FOR EACH ROW EXECUTE FUNCTION kernel.scope_disclosure_policy_tighten_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS scope_disclosure_policy_no_delete_tightened ON kernel.scope_disclosure_policy;
CREATE TRIGGER scope_disclosure_policy_no_delete_tightened
  BEFORE DELETE ON kernel.scope_disclosure_policy
  FOR EACH ROW EXECUTE FUNCTION kernel.scope_disclosure_policy_tighten_only();
