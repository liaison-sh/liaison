// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { archiveAgent, BaseAgentNotArchivableError, ensureBaseAgent } from "./base-agent"
import { COMMON_AGENT_BASE_SCOPES } from "./common-base-scopes"

const ORG_BASE_AGENT = "00000000-0000-0000-0000-d00000000001"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_BASE_AGENT}, 'Base Agent Org', 'base-agent-org') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_BASE_AGENT}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_BASE_AGENT}`
})

describe("BASE AGENT", () => {
  it("ensureBaseAgent creates exactly one @base agent per org", async () => {
    await ensureBaseAgent(ORG_BASE_AGENT)
    await ensureBaseAgent(ORG_BASE_AGENT)

    const rows = await sql`
      SELECT count(*)::int AS count FROM kernel.agents
      WHERE org_id = ${ORG_BASE_AGENT} AND handle = '@base'
    `

    expect(rows[0]?.count).toBe(1)
  })

  it("archiveAgent on @base throws BaseAgentNotArchivableError, even for an admin", async () => {
    const base = await ensureBaseAgent(ORG_BASE_AGENT)

    await expect(archiveAgent(ORG_BASE_AGENT, base.id, ["kernel:agents:admin"])).rejects.toThrow(
      BaseAgentNotArchivableError,
    )
    await expect(archiveAgent(ORG_BASE_AGENT, base.id, ["kernel:agents:admin"])).rejects.toThrow(
      "base agent is not archivable",
    )
  })
})

describe("BASE AGENT: bootstrapRegister wiring", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("bootstrapRegister also creates the org's @base agent", async () => {
    const org = await createTestOrg()

    const rows = await sql`
      SELECT count(*)::int AS count FROM kernel.agents
      WHERE org_id = ${org.id} AND handle = '@base' AND kind = 'system'
    `

    expect(rows[0]?.count).toBe(1)
  })

  it("bootstrapRegister gives @base the common agent base, never an empty ceiling", async () => {
    // The live QA: an empty ceiling left @base with no tool search, no way to
    // ask or hand off to another agent, and no read of the knowledge it owns.
    const org = await createTestOrg()
    const [row] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE org_id = ${org.id} AND handle = '@base' AND kind = 'system'
    `
    const ceiling = row?.scope_ceiling as string[]
    expect(ceiling).toEqual([...COMMON_AGENT_BASE_SCOPES])
    // tool_search, agents_ask / agents_invite, and the knowledge it owns.
    for (const scope of [
      "kernel:threads:read",
      "kernel:threads:write",
      "knowledge:documents:read",
    ]) {
      expect(ceiling).toContain(scope)
    }
  })
})
