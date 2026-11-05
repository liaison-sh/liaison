// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0153 removes the local-command (stdio) MCP transport: existing stdio
// connections are deleted (their policy and health rows cascade with them),
// http/sse connections are untouched, the enum loses 'stdio' and the CHECK
// refuses a row without an http_url or with a command. The live tables are
// already migrated when this runs, so the file is replayed against SCRATCH
// copies in their own schema: the statements are the file's own, only the
// schema name is swapped (0113's recipe).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0153_mcp_remove_stdio_transport.sql", import.meta.url).pathname
const SCRATCH = "mig0153_mcp_stdio"

const HTTP_CONN = "00000000-0000-0000-0000-0000000153a1"
const STDIO_CONN = "00000000-0000-0000-0000-0000000153a2"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

function migrationText(): string {
  return readFileSync(FILE, "utf8").replaceAll("app_mcp_manager", SCRATCH)
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationText().split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

describe("0153 removes the stdio MCP transport", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    // The 0000 shapes this migration touches.
    await sql.unsafe(`CREATE TYPE ${SCRATCH}.mcp_transport AS ENUM ('stdio','http','sse')`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.mcp_connections (
      id uuid PRIMARY KEY,
      transport ${SCRATCH}.mcp_transport NOT NULL,
      http_url text,
      stdio_command text,
      stdio_args text[],
      CONSTRAINT mcp_connections_transport_config_check CHECK (
        (transport IN ('http','sse') AND http_url IS NOT NULL AND stdio_command IS NULL) OR
        (transport = 'stdio' AND stdio_command IS NOT NULL AND http_url IS NULL)))`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.mcp_tool_policy (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL REFERENCES ${SCRATCH}.mcp_connections(id) ON DELETE CASCADE,
      tool_name text NOT NULL)`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.mcp_connections (id, transport, http_url, stdio_command, stdio_args) VALUES
      ('${HTTP_CONN}', 'http', 'https://mcp.example.com', NULL, NULL),
      ('${STDIO_CONN}', 'stdio', NULL, '/usr/bin/mcp-fs', ARRAY['--root','/srv'])`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.mcp_tool_policy (connection_id, tool_name) VALUES
      ('${HTTP_CONN}', 'search'), ('${STDIO_CONN}', 'read_file')`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("deletes stdio connections with their dependent rows and keeps remote ones", async () => {
    await applyMigration()
    const conns = await sql.unsafe<{ id: string; transport: string }[]>(
      `SELECT id::text, transport::text FROM ${SCRATCH}.mcp_connections ORDER BY id`,
    )
    expect(conns.map((c) => ({ id: c.id, transport: c.transport }))).toEqual([
      { id: HTTP_CONN, transport: "http" },
    ])
    const policies = await sql.unsafe<{ connection_id: string }[]>(
      `SELECT connection_id::text FROM ${SCRATCH}.mcp_tool_policy`,
    )
    expect(policies.map((p) => p.connection_id)).toEqual([HTTP_CONN])
  })

  it("leaves no 'stdio' in the transport enum", async () => {
    const [row] = await sql.unsafe<{ labels: string }[]>(
      `SELECT enum_range(NULL::${SCRATCH}.mcp_transport)::text AS labels`,
    )
    expect(row?.labels).toBe("{http,sse}")
  })

  it("refuses a connection without a URL or with a command", async () => {
    // A postgres.js query only runs once awaited, so each insert is awaited inside its own call.
    const insertFails = async (statement: string): Promise<boolean> => {
      try {
        await sql.unsafe(statement)
        return false
      } catch {
        return true
      }
    }
    expect(
      await insertFails(
        `INSERT INTO ${SCRATCH}.mcp_connections (id, transport, http_url) VALUES (gen_random_uuid(), 'http', NULL)`,
      ),
    ).toBe(true)
    expect(
      await insertFails(
        `INSERT INTO ${SCRATCH}.mcp_connections (id, transport, http_url, stdio_command)
         VALUES (gen_random_uuid(), 'http', 'https://x.example', '/bin/sh')`,
      ),
    ).toBe(true)
  })

  it("is re-runnable", async () => {
    await applyMigration()
    const conns = await sql.unsafe<{ id: string }[]>(
      `SELECT id::text FROM ${SCRATCH}.mcp_connections`,
    )
    expect(conns.map((c) => c.id)).toEqual([HTTP_CONN])
  })
})
