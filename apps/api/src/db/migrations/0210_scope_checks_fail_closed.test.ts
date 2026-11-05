// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0210: a scope check reads the same on a fresh pooled connection (the context
// setting NULL) and on a reused one (an earlier transaction set it, so it reads
// ''): both refuse. The personal-agent guard lets the privileged ROLE through,
// not an empty context. One connection (max: 1) stands in for a pooled server
// connection; the trigger is replayed into a SCRATCH schema against a scratch
// table, as 0120's test does.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0210_scope_checks_fail_closed.sql", import.meta.url).pathname
const SCRATCH = "mig0210_agents_guard"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const CHECKS = [
  "app_tickets.app_has_scope('tickets:tickets:write')",
  "app_projects.app_has_scope('projects:tasks:write')",
  "app_mcp_manager.app_has_scope('mcp_manager:connection:read')",
  "app_knowledge.app_has_scope('knowledge:documents:update')",
  "app_knowledge.has_exact_scope('knowledge:documents:update')",
  "kernel.has_scope('kernel:contacts:admin')",
  "kernel.session_is_admin()",
]

type Sql = ReturnType<typeof postgres>

/** Every check's answer in one privileged transaction on `conn`, as it reads the setting. */
async function answers(conn: Sql): Promise<{ setting: string | null; results: unknown[] }> {
  return conn.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    const [row] = await tx.unsafe<Record<string, unknown>[]>(
      `SELECT current_setting('app.current_scopes', true) AS setting, ${CHECKS.map(
        (c, i) => `${c} AS c${i}`,
      ).join(", ")}`,
    )
    return {
      setting: (row!.setting as string | null) ?? null,
      results: CHECKS.map((_, i) => row![`c${i}`]),
    }
  })
}

async function allocate(conn: Sql): Promise<unknown> {
  return conn.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    await tx.unsafe(`SELECT app_projects.allocate_task_number(gen_random_uuid())`)
  })
}

describe("0210 scope checks on a pooled connection", () => {
  it("NULL (fresh connection) and '' (reused connection) both read as no scope", async () => {
    const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
    try {
      const fresh = await answers(conn)
      expect(fresh.setting).toBeNull()
      expect(fresh.results).toEqual(CHECKS.map(() => false))
      await expect(allocate(conn)).rejects.toThrow("insufficient_scope: projects:tasks:write")

      // An earlier transaction sets the variable; at its commit it reads ''.
      await conn.begin((tx) => tx.unsafe(`SELECT set_config('app.current_scopes', '*', true)`))
      const reused = await answers(conn)
      expect(reused.setting).toBe("")
      expect(reused.results).toEqual(CHECKS.map(() => false))
      await expect(allocate(conn)).rejects.toThrow("insufficient_scope: projects:tasks:write")

      // The scopes a transaction sets are what the checks read.
      const granted = await conn.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE liaison_admin")
        await tx.unsafe(`SELECT set_config('app.current_scopes', 'projects:tasks:write', true)`)
        const [row] = await tx.unsafe<{ ok: boolean }[]>(
          `SELECT app_projects.app_has_scope('projects:tasks:write') AS ok`,
        )
        return row!.ok
      })
      expect(granted).toBe(true)
    } finally {
      await conn.end()
    }
  })
})

describe("0210 personal agent guard: the privileged role, not an empty context", () => {
  const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

  /** One write to the scratch personal agent, as `role` with `scopes` set (null: left as is). */
  async function write(role: string, scopes: string | null, set: string): Promise<void> {
    await sql.begin(async (tx) => {
      if (scopes !== null)
        await tx.unsafe(`SELECT set_config('app.current_scopes', '${scopes}', true)`)
      await tx.unsafe(`SET LOCAL ROLE ${role}`)
      await tx.unsafe(`UPDATE ${SCRATCH}.agents SET ${set} WHERE kind = 'personal'`)
    })
  }
  const widen = "scope_ceiling = scope_ceiling || '[\"x\"]'::jsonb"
  const rename = "name = name || '!'"

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE; CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(
      `CREATE TABLE ${SCRATCH}.agents (
         id serial PRIMARY KEY, kind text NOT NULL, name text NOT NULL DEFAULT 'a',
         scope_ceiling jsonb NOT NULL DEFAULT '[]',
         system_prompt text, tool_allowlist jsonb, tool_denylist jsonb)`,
    )
    await sql.unsafe(`INSERT INTO ${SCRATCH}.agents (kind) VALUES ('personal')`)
    const file = readFileSync(FILE, "utf8")
    const fn = file.slice(
      file.indexOf("CREATE OR REPLACE FUNCTION kernel.agents_personal_owner_rename_only"),
    )
    await sql.unsafe(fn.replaceAll("kernel.agents_personal_owner_rename_only", `${SCRATCH}.guard`))
    await sql.unsafe(
      `CREATE TRIGGER guard
         BEFORE UPDATE OF scope_ceiling, system_prompt, tool_allowlist, tool_denylist ON ${SCRATCH}.agents
         FOR EACH ROW EXECUTE FUNCTION ${SCRATCH}.guard()`,
    )
    for (const role of ["liaison_rls", "liaison_admin"]) {
      await sql.unsafe(`GRANT USAGE ON SCHEMA ${SCRATCH} TO ${role}`)
      await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${SCRATCH} TO ${role}`)
    }
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("the privileged role may change the ceiling, whatever the connection held", async () => {
    await write("liaison_admin", null, widen)
    await write("liaison_admin", "", widen)
    await write("liaison_admin", "kernel:threads:read", widen)
  })

  it("a request without an admin scope is refused, including with an empty context", async () => {
    await expect(write("liaison_rls", "kernel:threads:read", widen)).rejects.toThrow(
      "agents_personal_owner_rename_only",
    )
    await expect(write("liaison_rls", "__none__", widen)).rejects.toThrow(
      "agents_personal_owner_rename_only",
    )
    await expect(write("liaison_rls", "", widen)).rejects.toThrow(
      "agents_personal_owner_rename_only",
    )
  })

  it("the owner still renames, and an agents admin still edits", async () => {
    await write("liaison_rls", "kernel:threads:read", rename)
    await write("liaison_rls", "kernel:agents:admin", widen)
    await write("liaison_rls", "*", widen)
  })
})
