// SPDX-License-Identifier: FSL-1.1-ALv2
//
// notify_user is a WRITE whose result holds no org record (an ack and a hint).
// Its gate scope, kernel:agent:memory, has no write verb, so the taint
// classification kept it as if the call had READ agent memory; the next
// notify_user on the same agent-bound MCP connection was then refused
// E_SCOPE_TAINT_BLOCKED (the push matrix on demo, 2026-10-07: an agent could
// notify its own user once per taint window). It is declared taintFree: its
// own call is still checked, it just records no read.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { redis } from "~/lib/redis"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { mcpTurnTaintKey } from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

function codeOf(res: { structuredContent?: unknown }): string | undefined {
  return (res.structuredContent as { code?: string } | undefined)?.code
}

describe("notify_user over an agent-bound MCP connection", () => {
  const orgs: string[] = []
  beforeAll(async () => {
    await initSandboxPool()
  })
  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      toolRegistry.deleteByPrefix([o])
      await cleanupSeededOrg(o)
    }
  })
  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("runs on every call: its own call leaves no taint", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await registerSkillRoutineTools(seed.orgId)
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling: ["*"] })
    const conn = await seedMcpConnection({
      orgId: seed.orgId,
      userId: seed.ownerId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const post = (): ToolCallCtx => ({
      orgId: seed.orgId,
      actor: userContextFor(seed.orgId, seed.ownerId, [...seed.scopes, "kernel:agent:memory"]),
      connectionId: conn.id,
      ownerUserId: seed.ownerId,
      agentId,
      connectionThreadId: null,
      discovered: new Set(),
    })
    for (let i = 0; i < 3; i++) {
      const res = await handleToolCall(post(), "kernel__notify_user", { summary: `ping ${i}` })
      expect(codeOf(res)).not.toBe("E_SCOPE_TAINT_BLOCKED")
      expect(res.isError).toBeFalsy()
    }
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted).not.toContain("kernel:agent:memory")
  }, 30_000)
})
