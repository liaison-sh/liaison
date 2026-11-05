-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who last changed what a routine does, so a routine is known to be its
-- owner's own work: `edited_by_user_id` is the person whose edit last changed
-- the routine's definition (its prompt, its scopes, whom it runs as) and
-- `edited_at` when. Both NULL means nobody changed it since it was created, so
-- its creator is its last editor.
--
-- A routine whose creator and last editor are its owner may read its owner's
-- server-managed mailbox on a tick (mailbox-plaintext-broker.ts); one set up or
-- changed by anyone else may not. The writers that know the editor set both
-- columns. The trigger covers every other path: a change to the prompt, the
-- scopes or the owner that did not move `edited_at` records an UNKNOWN editor
-- (`edited_at` set, `edited_by_user_id` NULL), which never counts as the owner.
--
-- Additive and nullable: the previous release never writes them and keeps
-- working during a rolling deploy (its edits are caught by the trigger, which
-- only ever withholds a mailbox read).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never writes edited_by_user_id, so the key can refuse none of its writes
ALTER TABLE "kernel"."routines" ADD COLUMN IF NOT EXISTS "edited_by_user_id" uuid
  REFERENCES "kernel"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "kernel"."routines" ADD COLUMN IF NOT EXISTS "edited_at" timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kernel"."routines_mark_definition_edit"()
  RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $edit$
BEGIN
  IF (NEW.prompt IS DISTINCT FROM OLD.prompt
      OR NEW.scopes IS DISTINCT FROM OLD.scopes
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
     AND NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at THEN
    NEW.edited_by_user_id := NULL;
    NEW.edited_at := now();
  END IF;
  RETURN NEW;
END
$edit$;
--> statement-breakpoint
-- expand-safe: it only fills the two new columns the previous release never reads; its writes go through unchanged
CREATE OR REPLACE TRIGGER "routines_mark_definition_edit"
  BEFORE UPDATE ON "kernel"."routines"
  FOR EACH ROW EXECUTE FUNCTION "kernel"."routines_mark_definition_edit"();
