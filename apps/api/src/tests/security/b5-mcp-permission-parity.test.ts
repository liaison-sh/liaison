// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { UserContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedMcpConnection } from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "./seeds"

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
})

afterAll(async () => {
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("B5 — MCP permission parity: handleToolCall enforces same dimensions as direct executeTool", () => {
  test("userB sees zero threads via MCP handleToolCall — identical to direct executeTool", async () => {
    const { userB } = await seedTwoOrgsWithIsolatedData()

    const actor: UserContext = {
      actorType: "user",
      userId: userB.id,
      orgId: userB.orgId,
      // Admin role in orgB has wildcard scope; supply the read scope explicitly
      // so that both paths see the same permission set.
      scopes: ["kernel:threads:read"],
      dimensionGrants: { "*": ["*"] },
    }

    const conn = await seedMcpConnection({
      orgId: userB.orgId,
      userId: userB.id,
      clientId: "claude-code",
      label: "B5 Parity",
    })
    const ctx: ToolCallCtx = {
      orgId: userB.orgId,
      actor,
      connectionId: conn.id,
      ownerUserId: userB.id,
      connectionThreadId: null,
      discovered: new Set(),
    }

    const mcpResult = await handleToolCall(ctx, "kernel__threads_search", { query: "" })
    expect(mcpResult.isError).toBeFalsy()
    const mcpData = mcpResult.structuredContent as { threads?: Array<{ id: string }> } | undefined
    const mcpThreads = mcpData?.threads ?? []

    const direct = await executeTool({
      toolName: "kernel:threads_search",
      orgId: userB.orgId,
      actor,
      params: { query: "" },
    })
    expect(direct.blocked).toBeUndefined()
    const directThreads = (direct.data as { threads?: Array<{ id: string }> })?.threads ?? []

    const mcpIds = new Set(mcpThreads.map((t) => t.id))
    const directIds = new Set(directThreads.map((t) => t.id))
    expect([...mcpIds].sort()).toEqual([...directIds].sort())
    // Fresh org B has no threads visible to its admin.
    expect(directIds.size).toBe(0)
  })
})
