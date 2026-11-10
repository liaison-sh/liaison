// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The boot reconcile of stored common-base copies, against real Postgres and
// through the real privileged path (withSystemDb, liaison_admin under FORCE
// RLS): a migration once "succeeded" while RLS hid every row it meant to fix.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { composeRoleAgentCeiling } from "~/cli/provisioners/agents"
import { sql } from "~/db"
import { ensureBaseAgent } from "~/modules/agent/directory/base-agent"
import { assertNoAdminScopesInRoleCeiling } from "~/modules/agent/directory/ceiling-guard"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"
import { reconcileAgentBaseCeilings } from "~/modules/agent/directory/reconcile-base-ceilings"

const ORG = crypto.randomUUID()
const FRESH_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const ids = {
  base: crypto.randomUUID(),
  role: crypto.randomUUID(),
  current: crypto.randomUUID(),
  archived: crypto.randomUUID(),
  personal: crypto.randomUUID(),
}

/** The base as an older release stored it: the last three scopes missing. */
const STALE = COMMON_AGENT_BASE_SCOPES.slice(0, -3)
const MISSING = COMMON_AGENT_BASE_SCOPES.slice(-3)
const EXTRA = "tickets:tickets:read"

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, `base-reconcile-${tag}`],
    [FRESH_ORG, `base-reconcile-fresh-${tag}`],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'BaseReconcile', ${slug})`
  }
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${USER}, ${ORG}, ${`owner-${tag}@example.test`}, 'Owner')`
  const insert = async (
    id: string,
    kind: string,
    handle: string,
    ceiling: readonly string[],
    opts: { owner?: string; archived?: boolean } = {},
  ) => {
    await sql`INSERT INTO kernel.agents
        (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id, archived_at)
      VALUES (${id}, ${ORG}, ${kind}::kernel.agent_kind, ${handle}, ${handle},
              ${JSON.stringify(ceiling)}::jsonb, ${opts.owner ?? null},
              ${opts.archived ? new Date().toISOString() : null}::timestamptz)`
  }
  await insert(ids.base, "system", "@base", STALE)
  await insert(ids.role, "role", `@support-${tag}`, [...STALE, EXTRA])
  await insert(ids.current, "role", `@current-${tag}`, [...COMMON_AGENT_BASE_SCOPES])
  await insert(ids.archived, "role", `@gone-${tag}`, STALE, { archived: true })
  await insert(ids.personal, "personal", `@owner-${tag}`, [EXTRA], { owner: USER })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG}, ${FRESH_ORG})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${FRESH_ORG})`
})

async function row(id: string): Promise<{ ceiling: string[]; updatedAt: Date }> {
  const [r] = await sql<{ scope_ceiling: string[]; updated_at: Date }[]>`
    SELECT scope_ceiling, updated_at FROM kernel.agents WHERE id = ${id}`
  return { ceiling: r!.scope_ceiling, updatedAt: r!.updated_at }
}

describe("reconcileAgentBaseCeilings", () => {
  const before: Record<string, { ceiling: string[]; updatedAt: Date }> = {}
  let first: Awaited<ReturnType<typeof reconcileAgentBaseCeilings>>

  beforeAll(async () => {
    for (const [k, id] of Object.entries(ids)) before[k] = await row(id)
    first = await reconcileAgentBaseCeilings()
  })

  it("a stale @base gains the missing base scopes, appended in order", async () => {
    expect(first.agentIds).toContain(ids.base)
    expect((await row(ids.base)).ceiling).toEqual([...COMMON_AGENT_BASE_SCOPES])
  })

  it("a stale role agent gains them and keeps its own extra scope", async () => {
    expect(first.agentIds).toContain(ids.role)
    const { ceiling } = await row(ids.role)
    expect(ceiling).toEqual([...STALE, EXTRA, ...MISSING])
    expect(() => assertNoAdminScopesInRoleCeiling("role", ceiling)).not.toThrow()
  })

  it("leaves personal, archived and already-current agents alone", async () => {
    for (const k of ["personal", "archived", "current"] as const) {
      expect(first.agentIds).not.toContain(ids[k])
      expect(await row(ids[k])).toEqual(before[k]!)
    }
  })

  it("a second run changes no row", async () => {
    const afterFirst = { base: await row(ids.base), role: await row(ids.role) }
    const second = await reconcileAgentBaseCeilings()
    for (const id of Object.values(ids)) expect(second.agentIds).not.toContain(id)
    expect(await row(ids.base)).toEqual(afterFirst.base)
    expect(await row(ids.role)).toEqual(afterFirst.role)
  })
})

describe("one constant feeds every copy of the base", () => {
  it("a new @base, a composed role ceiling and the reconcile all carry COMMON_AGENT_BASE_SCOPES", async () => {
    const created = await ensureBaseAgent(FRESH_ORG)
    expect(created.scopeCeiling).toEqual([...COMMON_AGENT_BASE_SCOPES])
    expect(composeRoleAgentCeiling([])).toEqual([...COMMON_AGENT_BASE_SCOPES])
    // Emptied, the new @base comes back to exactly the constant.
    await sql`UPDATE kernel.agents SET scope_ceiling = '[]'::jsonb WHERE id = ${created.id}`
    await reconcileAgentBaseCeilings()
    expect((await row(created.id)).ceiling).toEqual([...COMMON_AGENT_BASE_SCOPES])
  })
})
