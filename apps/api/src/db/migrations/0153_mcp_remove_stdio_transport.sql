-- SPDX-License-Identifier: FSL-1.1-ALv2
-- MCP connections are remote servers only: the local-command (stdio) transport
-- is removed.
--
-- 1. Existing stdio connections are deleted. Every table that references
--    app_mcp_manager.mcp_connections (tool policy, resource subscriptions,
--    OAuth state, connection health) does so ON DELETE CASCADE, so their rows
--    go with the connection and nothing is left dangling.
-- 2. The transport enum loses 'stdio' (Postgres cannot drop an enum value, so
--    the type is rebuilt with the remaining values and the column re-typed).
-- 3. The transport CHECK now requires an http_url and keeps the legacy
--    stdio_command / stdio_args columns NULL. The columns stay for now so a
--    running build that still names them keeps working through a deploy; a
--    later migration drops them.
--
-- Re-runnable: every step checks the current state first.

DELETE FROM app_mcp_manager.mcp_connections WHERE transport::text = 'stdio';
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connections
  DROP CONSTRAINT IF EXISTS mcp_connections_transport_config_check;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'app_mcp_manager' AND t.typname = 'mcp_transport' AND e.enumlabel = 'stdio'
  ) THEN
    ALTER TYPE app_mcp_manager.mcp_transport RENAME TO mcp_transport_with_stdio;
    CREATE TYPE app_mcp_manager.mcp_transport AS ENUM ('http', 'sse');
    ALTER TABLE app_mcp_manager.mcp_connections
      ALTER COLUMN transport TYPE app_mcp_manager.mcp_transport
      USING transport::text::app_mcp_manager.mcp_transport;
    DROP TYPE app_mcp_manager.mcp_transport_with_stdio;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connections
  ADD CONSTRAINT mcp_connections_transport_config_check CHECK (
    http_url IS NOT NULL AND stdio_command IS NULL AND stdio_args IS NULL
  );
