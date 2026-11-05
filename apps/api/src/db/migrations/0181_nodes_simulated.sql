-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.nodes.simulated: a node no machine stands behind. A demo org's
-- developer scenario plays a recorded coding-agent session on one, so the
-- visitor sees a session without pairing a computer.
--
--  - A simulated node never holds a credential (CHECK): no node-auth path can
--    speak for it, whatever a route writes onto the row later.
--  - It exists only in a demo org (trigger): the org's settings carry the demo
--    marker (`settings.demo`) when the row is written. A regular org can never
--    hold one, even through a privileged write.
--  - `simulated` is fixed at insert: an update cannot turn a real node into a
--    simulated one or back.
--
-- Re-runnable.
ALTER TABLE kernel.nodes ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE kernel.nodes DROP CONSTRAINT IF EXISTS nodes_simulated_no_credential;
--> statement-breakpoint
ALTER TABLE kernel.nodes ADD CONSTRAINT nodes_simulated_no_credential
  CHECK (NOT simulated OR credential_hash IS NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.nodes_simulated_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, kernel
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.simulated IS DISTINCT FROM OLD.simulated THEN
    RAISE EXCEPTION 'nodes.simulated is fixed at insert' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.simulated THEN
    IF NOT EXISTS (
      SELECT 1 FROM kernel.organizations o
      WHERE o.id = NEW.org_id AND jsonb_typeof(o.settings -> 'demo') = 'object'
    ) THEN
      RAISE EXCEPTION 'a simulated node exists only in a demo org' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.nodes_simulated_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodes_simulated_guard ON kernel.nodes;
--> statement-breakpoint
CREATE TRIGGER nodes_simulated_guard
  BEFORE INSERT OR UPDATE OF simulated ON kernel.nodes
  FOR EACH ROW EXECUTE FUNCTION kernel.nodes_simulated_guard();
