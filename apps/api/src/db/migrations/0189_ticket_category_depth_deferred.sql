-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Ticket categories: the two-level rule is checked on the FINAL tree, at commit.
--
-- The old row trigger (enforce_category_depth, BEFORE INSERT OR UPDATE OF
-- parent_id) looked only at the NEW parent: it refused a parent that itself has
-- a parent, but let a root that HAS children move under another root, which
-- made a third level. It also ran per statement, so a whole-tree save (the
-- settings page's categories.reorder: swap a root and its child in one
-- transaction) was refused in the middle even though the final tree is fine.
--
-- Now a DEFERRABLE INITIALLY DEFERRED constraint trigger runs at commit, once
-- per written row, and reads the row's CURRENT neighbourhood. A live row is
-- refused when it sits on a third level: its live parent has a parent, or it
-- has a live parent and a live child, or it is a root with a live grandchild.
-- Archived rows do not count. The check stays local to the written rows, so a
-- tree left over with three levels from before does not block unrelated writes.
--
-- The tickets manifest no longer declares the row trigger (the app runtime
-- would recreate it on boot otherwise). Re-runnable.

CREATE OR REPLACE FUNCTION app_tickets.categories_depth_final_fn() RETURNS TRIGGER AS $TRIGGER_BODY$
DECLARE
  _row record;
  _bad boolean;
BEGIN
  EXECUTE format('SELECT id, parent_id, archived_at FROM %I.categories WHERE id = $1', TG_TABLE_SCHEMA)
    INTO _row USING NEW.id;
  IF _row.id IS NULL OR _row.archived_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE format($Q$
    SELECT
      -- third level: the live parent has a parent
      EXISTS (SELECT 1 FROM %1$I.categories p
              WHERE p.id = $2 AND p.archived_at IS NULL AND p.parent_id IS NOT NULL)
      -- middle with a child: a live parent and a live child
      OR ($2 IS NOT NULL
          AND EXISTS (SELECT 1 FROM %1$I.categories p WHERE p.id = $2 AND p.archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM %1$I.categories c WHERE c.parent_id = $1 AND c.archived_at IS NULL))
      -- root with a live grandchild
      OR EXISTS (SELECT 1 FROM %1$I.categories c
                 JOIN %1$I.categories g ON g.parent_id = c.id
                 WHERE c.parent_id = $1 AND c.archived_at IS NULL AND g.archived_at IS NULL)
  $Q$, TG_TABLE_SCHEMA) INTO _bad USING _row.id, _row.parent_id;
  IF _bad THEN
    RAISE EXCEPTION 'category_depth_limit';
  END IF;
  RETURN NULL;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint

ALTER FUNCTION app_tickets.categories_depth_final_fn() OWNER TO liaison_admin;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_category_depth ON app_tickets.categories;
--> statement-breakpoint

DROP FUNCTION IF EXISTS app_tickets.categories_enforce_category_depth_fn();
--> statement-breakpoint

DROP TRIGGER IF EXISTS categories_depth_final ON app_tickets.categories;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER categories_depth_final
  AFTER INSERT OR UPDATE OF parent_id, archived_at ON app_tickets.categories
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_tickets.categories_depth_final_fn();
