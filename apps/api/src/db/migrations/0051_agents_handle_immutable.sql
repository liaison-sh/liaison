-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agents: an agent's `handle` never changes after creation; only
-- `display_name` is renameable. Application-layer code is one call site
-- today, but a BEFORE UPDATE trigger is defense-in-depth matching this
-- repo's existing use of triggers for invariants (see
-- app_tickets.categories_enforce_category_depth_fn in 0000_initial.sql for
-- the established syntax).
--
-- RE-RUNNABLE: CREATE OR REPLACE FUNCTION is naturally idempotent, and the
-- trigger is dropped by name first, following the convention 0033/0045
-- established for a journal `when` raised above an already-deployed
-- highwater re-running this file.

CREATE OR REPLACE FUNCTION kernel.agents_handle_immutable() RETURNS TRIGGER AS $TRIGGER_BODY$
BEGIN
  IF NEW.handle != OLD.handle THEN
    RAISE EXCEPTION 'agents_handle_immutable';
  END IF;
  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS agents_handle_immutable ON kernel.agents;
CREATE TRIGGER agents_handle_immutable BEFORE UPDATE OF handle ON kernel.agents FOR EACH ROW EXECUTE FUNCTION kernel.agents_handle_immutable();
