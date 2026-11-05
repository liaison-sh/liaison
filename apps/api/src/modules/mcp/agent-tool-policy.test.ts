// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { loadAgentToolPolicy } from "~/modules/mcp/agent-tool-policy"
import {
  archiveAgent,
  cleanupSeededOrg,
  seedAgentForOrg,
  seedOrgWithUser,
} from "~/modules/mcp/test-helpers"

describe("loadAgentToolPolicy", () => {
  const orgs: string[] = []

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  it("reflects an edit made between two calls in the same process", async () => {
    const { orgId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { toolDenylist: [] })

    const first = await loadAgentToolPolicy(orgId, agentId)
    expect(first.toolDenylist).toEqual([])

    await sql`UPDATE kernel.agents SET tool_denylist = ${["test__createItem"]} WHERE id = ${agentId}`

    const second = await loadAgentToolPolicy(orgId, agentId)
    expect(second.toolDenylist).toEqual(["test__createItem"])
  }, 30_000)

  it("an archived agent admits nothing", async () => {
    const { orgId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId)
    await archiveAgent(agentId)
    const policy = await loadAgentToolPolicy(orgId, agentId)
    expect(policy.agentMissing).toBe(true)
  }, 30_000)
})
