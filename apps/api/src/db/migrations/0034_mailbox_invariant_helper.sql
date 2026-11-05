-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Invariant P: the two SECURITY DEFINER helpers the plaintext trigger calls.
--
-- The trigger is declared in the mail app manifest and emitted by the app DDL
-- generator, which produces a plain SECURITY INVOKER function. `app_mail.accounts`
-- carries FORCE ROW LEVEL SECURITY with a deny-default policy and a personalScope
-- helper, and `kernel.user_mailbox_identities` is owner-scoped, so an inline lookup
-- from inside the trigger would return zero rows for any writer session that cannot
-- see those rows, leave the state NULL, and let the write through. That is a
-- fail-OPEN on the one guarantee this feature sells, so the lookup is routed
-- through SECURITY DEFINER helpers owned by the BYPASSRLS registration role,
-- mirroring the personalScope owner-lookup helper the RLS generator already emits.
--
-- Arming is NOT `encryption_state`. A single UPDATE of that column would otherwise
-- disarm the database guarantee, and `ready -> blocked` is a legal transition on any
-- seal failure. Arming is instead the existence of an active mailbox identity for
-- the account's owner: `blocked` and `paused` accounts stay armed, which is the
-- point, because "something went wrong" is never a licence to write plaintext.
--
-- Ordering: on a cold boot this runs BEFORE the mail app registers and creates its
-- schema, so it is guarded on the table existing and normally no-ops on the deploy
-- that introduces the feature. `assertMailboxSchemaState` re-asserts both helpers
-- after every schema sync; that boot step is the path that actually has to work.

DO $$
BEGIN
  IF to_regclass('app_mail.accounts') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('kernel.user_mailbox_identities') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION app_mail.mailbox_invariant_armed(acct uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $body$
      SELECT EXISTS (
        SELECT 1
          FROM app_mail.accounts a
          JOIN kernel.user_mailbox_identities i
            ON i.user_id = a.owner_id AND i.status = 'active'
         WHERE a.id = acct AND a.owner_type = 'user'
      )
    $body$
  $fn$;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION app_mail.mailbox_account_exists(acct uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $body$
      SELECT EXISTS (SELECT 1 FROM app_mail.accounts a WHERE a.id = acct)
    $body$
  $fn$;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    ALTER FUNCTION app_mail.mailbox_invariant_armed(uuid) OWNER TO liaison_admin;
    ALTER FUNCTION app_mail.mailbox_account_exists(uuid) OWNER TO liaison_admin;
  END IF;
END $$;
