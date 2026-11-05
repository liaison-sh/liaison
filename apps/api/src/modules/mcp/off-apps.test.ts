// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / A6: an app turned Off for the workspace is gone from the MCP gateway
// projection, and calling one of its tools directly (gateway or the shared
// execute path, from ANY origin) is refused with app_disabled rather than run.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { APP_DISABLED_CODE, APP_DISABLED_MESSAGE } from "@liaison/shared"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import * as executeToolModule from "~/modules/apps/execute-tool"
import { executeTool } from "~/modules/apps/execute-tool"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  cleanupSeededOrg,
  mutatingTicketTool,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { listMcpTools } from "~/modules/mcp/tool-projection"

async function makeCtx(seed: {
  orgId: string
  ownerId: string
  scopes: string[]
}): Promise<ToolCallCtx> {
  const actor = userContextFor(seed.orgId, seed.ownerId, seed.scopes)
  const conn = await seedMcpConnection({
    orgId: seed.orgId,
    userId: seed.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  return {
    orgId: seed.orgId,
    actor,
    connectionId: conn.id,
    ownerUserId: seed.ownerId,
    connectionThreadId: null,
    discovered: new Set(),
  }
}

describe("Off apps: MCP gateway and direct calls", () => {
  const orgs: string[] = []
  beforeAll(async () => {
    await initSandboxPool()
  })
  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })
  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("tools/list drops an Off app's tools; liaison_tool_search does not name them", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const before = (await listMcpTools(ctx)).map((t) => t.name)
    expect(before.some((n) => n.startsWith("test__"))).toBe(true)

    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const after = (await listMcpTools(ctx)).map((t) => t.name)
    expect(after.filter((n) => n.startsWith("test__"))).toEqual([])
    expect(after).toContain("liaison_tool_search")

    const search = await handleToolCall(ctx, "liaison_tool_search", { query: "item" })
    const hits = (
      (search.structuredContent as { tools?: Array<{ name: string }> }).tools ?? []
    ).map((t) => t.name)
    expect(hits.filter((n) => n.startsWith("test__"))).toEqual([])
  }, 30_000)

  it("tools/call of an Off app's tool returns app_disabled and does not run it", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const sdk = Object.keys(
      buildToolSet(seed.orgId, ctx.actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED),
    ).find((k) => k.startsWith("test__createItem")) as string
    expect(sdk).toBeTruthy()

    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const res = await handleToolCall(ctx, sdk, mutatingTicketTool.validParams)
    expect(res.isError).toBe(true)
    expect((res.structuredContent as { code: string }).code).toBe(APP_DISABLED_CODE)
    expect((res.structuredContent as { message: string }).message).toBe(APP_DISABLED_MESSAGE)
    expect(APP_DISABLED_MESSAGE).toBe("This app is turned off by your admin.")

    // Reversible: turn it back On and the same call runs.
    await setOrgAppStatus(seed.orgId, "test", "active")
    const ok = await handleToolCall(ctx, sdk, mutatingTicketTool.validParams)
    expect(ok.isError).toBeFalsy()
  }, 30_000)

  // fix2-F3: the gateway's own guard, proven alone. executeTool also refuses an
  // Off app, which made the test above pass with the gateway guard deleted.
  // Here executeTool is a stub that would run anything, so only the gateway
  // guard stands between the call and the tool.
  it("the gateway guard alone refuses an Off app's tool (executeTool stubbed to run anything)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const ctx = await makeCtx(seed)
    const sdk = Object.keys(
      buildToolSet(seed.orgId, ctx.actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED),
    ).find((k) => k.startsWith("test__createItem")) as string
    expect(sdk).toBeTruthy()

    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const stub = spyOn(executeToolModule, "executeTool").mockImplementation(
      async () => ({ data: { ran: true } }) as never,
    )
    try {
      const res = await handleToolCall(ctx, sdk, mutatingTicketTool.validParams)
      expect(stub).not.toHaveBeenCalled()
      expect(res.isError).toBe(true)
      expect((res.structuredContent as { code: string }).code).toBe(APP_DISABLED_CODE)
    } finally {
      stub.mockRestore()
    }
  }, 30_000)

  it("executeTool refuses a call to an Off app from EVERY origin (409 app_disabled)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const actor = userContextFor(seed.orgId, seed.ownerId, seed.scopes)
    await setOrgAppStatus(seed.orgId, "test", "disabled")

    for (const origin of ["in-app-agent", "mcp", "human-ui", "system"] as const) {
      const err = await executeTool({
        toolName: mutatingTicketTool.canonical,
        orgId: seed.orgId,
        actor,
        params: mutatingTicketTool.validParams,
        origin,
      }).then(
        () => null,
        (e: Error & { code?: string; status?: number }) => e,
      )
      expect({ origin, code: err?.code, status: err?.status }).toEqual({
        origin,
        code: APP_DISABLED_CODE,
        status: 409,
      })
      expect(err?.message).toBe(APP_DISABLED_MESSAGE)
    }

    // Re-enabled: the same call runs again, no restart.
    await setOrgAppStatus(seed.orgId, "test", "active")
    const ok = await executeTool({
      toolName: mutatingTicketTool.canonical,
      orgId: seed.orgId,
      actor,
      params: mutatingTicketTool.validParams,
      origin: "human-ui",
    })
    expect((ok as { data?: { title?: string } }).data?.title).toBe(
      mutatingTicketTool.validParams.title as string,
    )
  }, 30_000)
})
