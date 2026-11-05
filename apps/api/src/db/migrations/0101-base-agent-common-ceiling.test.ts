// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0101 repairs the @base system agents bootstrap and migrate-agents created
// with an empty ceiling. The live QA on the Acme deployment: @base could
// neither search tools nor ask another agent, though its prompt told it to
// hand off. The SQL is replayed against real rows over the privileged DSN, as
// 0100's test does.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"

const MIGRATION = new URL("./0101_base_agent_common_ceiling.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const emptyOrg = crypto.randomUUID()
const widenedOrg = crypto.randomUUID()
const tag = Date.now().toString(36)
const ids = {
  emptyBase: crypto.randomUUID(),
  widenedBase: crypto.randomUUID(),
  emptyRole: crypto.randomUUID(),
}

beforeAll(async () => {
  for (const [id, name] of [
    [emptyOrg, `m0101-a-${tag}`],
    [widenedOrg, `m0101-b-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${name}, ${name})`
  }
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
            VALUES (${ids.emptyBase}, ${emptyOrg}, 'system', '@base', 'Base', '[]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
            VALUES (${ids.widenedBase}, ${widenedOrg}, 'system', '@base', 'Base',
                    '["acme:widgets:read","kernel:threads:read"]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
            VALUES (${ids.emptyRole}, ${emptyOrg}, 'role', '@idle', 'Idle', '[]'::jsonb)`
})

afterAll(async () => {
  for (const id of [emptyOrg, widenedOrg]) {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
  }
  await sql.end()
})

async function ceilingOf(id: string): Promise<string[]> {
  const [row] = await sql<{ scope_ceiling: string[] }[]>`
    SELECT scope_ceiling FROM kernel.agents WHERE id = ${id}`
  return row!.scope_ceiling
}

describe("0101: @base carries the common agent base", () => {
  it("the SQL's scope list is the COMMON_AGENT_BASE_SCOPES constant", () => {
    const text = readFileSync(MIGRATION, "utf8")
    const lists = [...text.matchAll(/'(\[[^']+\])'::jsonb/g)].map((m) => JSON.parse(m[1]!))
    expect(lists.length).toBe(2)
    for (const list of lists) expect(list).toEqual([...COMMON_AGENT_BASE_SCOPES])
  })

  it("gives an empty @base the base, keeps an admin's extra scope, and leaves role agents alone", async () => {
    expect(await ceilingOf(ids.emptyBase)).toEqual([])

    await sql.unsafe(readFileSync(MIGRATION, "utf8"))

    expect(await ceilingOf(ids.emptyBase)).toEqual([...COMMON_AGENT_BASE_SCOPES])
    // The base first, then what the row already held, without a duplicate.
    expect(await ceilingOf(ids.widenedBase)).toEqual([
      ...COMMON_AGENT_BASE_SCOPES,
      "acme:widgets:read",
    ])
    expect(await ceilingOf(ids.emptyRole)).toEqual([])
  })

  it("a second run writes nothing", async () => {
    const before = await sql<{ id: string; updated_at: Date }[]>`
      SELECT id, updated_at FROM kernel.agents WHERE id IN (${ids.emptyBase}, ${ids.widenedBase})`
    const result = await sql.unsafe(readFileSync(MIGRATION, "utf8"))
    const after = await sql<{ id: string; updated_at: Date }[]>`
      SELECT id, updated_at FROM kernel.agents WHERE id IN (${ids.emptyBase}, ${ids.widenedBase})`
    expect(after.map((r) => r.updated_at.getTime()).sort()).toEqual(
      before.map((r) => r.updated_at.getTime()).sort(),
    )
    expect(result.count).toBe(0)
  })
})
