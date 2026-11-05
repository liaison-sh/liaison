// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0120: a privileged write to a personal agent's ceiling must pass the
// rename-only trigger on a server connection that an earlier RLS transaction
// already used (the GUC then reads '' instead of NULL). The trigger function is
// replayed into a SCRATCH schema against a scratch table; one connection
// (max: 1) stands in for the pooled server connection.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0120_agents_rename_only_pooled_guc.sql", import.meta.url).pathname
const SCRATCH = "mig0120_agents_guc"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

async function updateCeiling(scopes: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    if (scopes !== null)
      await tx.unsafe(`SELECT set_config('app.current_scopes', '${scopes}', true)`)
    await tx.unsafe(
      `UPDATE ${SCRATCH}.agents SET scope_ceiling = scope_ceiling || '["x"]'::jsonb WHERE kind = 'personal'`,
    )
  })
}

beforeAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE; CREATE SCHEMA ${SCRATCH}`)
  await sql.unsafe(
    `CREATE TABLE ${SCRATCH}.agents (
       id serial PRIMARY KEY, kind text NOT NULL, scope_ceiling jsonb NOT NULL DEFAULT '[]',
       system_prompt text, tool_allowlist jsonb, tool_denylist jsonb)`,
  )
  await sql.unsafe(`INSERT INTO ${SCRATCH}.agents (kind) VALUES ('personal')`)
  await sql.unsafe(readFileSync(FILE, "utf8").replaceAll("kernel.", `${SCRATCH}.`))
  await sql.unsafe(
    `CREATE TRIGGER agents_personal_owner_rename_only
       BEFORE UPDATE OF scope_ceiling, system_prompt, tool_allowlist, tool_denylist ON ${SCRATCH}.agents
       FOR EACH ROW EXECUTE FUNCTION ${SCRATCH}.agents_personal_owner_rename_only()`,
  )
})

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
  await sql.end()
})

describe("0120 personal agent rename-only trigger on a pooled connection", () => {
  it("privileged write passes after an earlier transaction set the GUC on the same connection", async () => {
    await expect(updateCeiling("kernel:threads:read")).rejects.toThrow(
      "agents_personal_owner_rename_only",
    )
    const [{ guc }] = await sql.unsafe<{ guc: string | null }[]>(
      `SELECT current_setting('app.current_scopes', true) AS guc`,
    )
    expect(guc).toBe("")
    await updateCeiling(null)
  })

  it("an RLS actor with no scopes is still refused", async () => {
    await expect(updateCeiling("__none__")).rejects.toThrow("agents_personal_owner_rename_only")
  })

  it("kernel:agents:admin may change the ceiling", async () => {
    await updateCeiling("kernel:agents:admin")
  })
})
