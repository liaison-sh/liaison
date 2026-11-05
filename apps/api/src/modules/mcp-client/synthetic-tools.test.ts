// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { makeMcpRepo } from "~/apps/mcp-manager/repo"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { ToolProjector } from "~/modules/mcp-client/projector"
import { SyntheticToolRegistrar } from "~/modules/mcp-client/synthetic-tools"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-000000000001"
const CONN_ID = "00000000-0000-0000-0000-000000000010"

async function seedConnection(
  world: McpTestWorld,
  overrides: Partial<typeof mcpConnections.$inferInsert>,
): Promise<string> {
  return withSystemDb("seed-conn", async (db) => {
    const [row] = await db
      .insert(mcpConnections)
      .values({
        orgId: world.org.id,
        slug: `synth-${Math.random().toString(36).slice(2, 8)}`,
        displayName: "Synthetic Test",
        transport: "http",
        httpUrl: "https://example.test",
        authFlavor: "none",
        managedBy: "ui",
        createdBy: world.admin.userId,
        ...overrides,
      })
      .returning({ id: mcpConnections.id })
    return row.id
  })
}

describe("SyntheticToolRegistrar", () => {
  beforeEach(() => {
    resetAppRegistries()
  })

  it("registers four resource synthetics when capabilities.resources=true", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const synth = new SyntheticToolRegistrar({ projector, repo: makeMcpRepo() })
    await synth.registerForCapabilities({
      orgId: ORG,
      connectionId: CONN_ID,
      slug: "linear",
      capabilities: { resources: true, prompts: false, tools: false },
    })
    for (const t of [
      "resource_list",
      "resource_read",
      "resource_subscribe",
      "resource_unsubscribe",
    ]) {
      expect(toolRegistry.get([ORG, "mcp", `linear:${t}`])).toBeDefined()
    }
    expect(toolRegistry.get([ORG, "mcp", "linear:prompt_list"])).toBeUndefined()
  })

  it("registers two prompt synthetics when capabilities.prompts=true", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const synth = new SyntheticToolRegistrar({ projector, repo: makeMcpRepo() })
    await synth.registerForCapabilities({
      orgId: ORG,
      connectionId: CONN_ID,
      slug: "linear",
      capabilities: { resources: false, prompts: true, tools: false },
    })
    for (const t of ["prompt_list", "prompt_get"]) {
      expect(toolRegistry.get([ORG, "mcp", `linear:${t}`])).toBeDefined()
    }
    expect(toolRegistry.get([ORG, "mcp", "linear:resource_list"])).toBeUndefined()
  })

  it("registers no synthetics when no capabilities are advertised", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const synth = new SyntheticToolRegistrar({ projector, repo: makeMcpRepo() })
    await synth.registerForCapabilities({
      orgId: ORG,
      connectionId: CONN_ID,
      slug: "linear",
      capabilities: { resources: false, prompts: false, tools: true },
    })
    expect(toolRegistry.get([ORG, "mcp", "linear:resource_list"])).toBeUndefined()
    expect(toolRegistry.get([ORG, "mcp", "linear:prompt_list"])).toBeUndefined()
  })
})

describe("SyntheticToolRegistrar — annotation + gating contract", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    resetAppRegistries()
    world = await buildMcpWorld()
  })

  it("resource_read is registered with destructive+non-readOnly annotations (gate_writes → gate)", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const synth = new SyntheticToolRegistrar({ projector, repo: makeMcpRepo() })
    await synth.registerForCapabilities({
      orgId: world.org.id,
      connectionId: CONN_ID,
      slug: "linear",
      capabilities: { resources: true, prompts: false, tools: false },
    })
    const entry = toolRegistry.get([world.org.id, "mcp", "linear:resource_read"])
    expect(entry).toBeDefined()
    // We assert the projected entry has the scope/name we expect; the destructive
    // annotation lives in the repo cache, asserted in the next test.
    expect(entry?.requiredScopes).toEqual(["mcp:linear:resource_read"])
  })

  it("projects read-only synthetics ungated and resource_read gated under gate_writes", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const synth = new SyntheticToolRegistrar({ projector, repo: makeMcpRepo() })
    await synth.registerForCapabilities({
      orgId: world.org.id,
      connectionId: CONN_ID,
      slug: "linear",
      capabilities: { resources: true, prompts: true, tools: false },
    })
    const gated = (n: string) => toolRegistry.get([world.org.id, "mcp", `linear:${n}`])?.gated
    expect({
      resource_list: gated("resource_list"),
      resource_read: gated("resource_read"),
      resource_subscribe: gated("resource_subscribe"),
      prompt_list: gated("prompt_list"),
      prompt_get: gated("prompt_get"),
    }).toEqual({
      resource_list: false,
      resource_read: true,
      resource_subscribe: true,
      prompt_list: false,
      prompt_get: false,
    })
  })

  it("repo.getPolicyForCall resolves resource_read on a gate_writes connection to gate", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const repo = makeMcpRepo()
    const synth = new SyntheticToolRegistrar({ projector, repo })
    const connId = await seedConnection(world, { connectionDefaultPolicy: "gate_writes" })
    await synth.registerForCapabilities({
      orgId: world.org.id,
      connectionId: connId,
      slug: "linear",
      capabilities: { resources: true, prompts: false, tools: false },
    })
    const decision = await repo.getPolicyForCall(connId, "resource_read", world.admin)
    expect(decision.decision).toBe("gate")
    expect(decision.policyPath).toBe("connection_default")
  })

  // A gate_writes connection runs read-only synthetics (prompt_list, prompt_get, resource_list)
  // without approval, like any read-only upstream tool; resource_read stays gated (destructive).
  it("repo.getPolicyForCall resolves prompt_get on a gate_writes connection to auto", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const repo = makeMcpRepo()
    const synth = new SyntheticToolRegistrar({ projector, repo })
    const connId = await seedConnection(world, { connectionDefaultPolicy: "gate_writes" })
    await synth.registerForCapabilities({
      orgId: world.org.id,
      connectionId: connId,
      slug: "linear",
      capabilities: { resources: false, prompts: true, tools: false },
    })
    const decision = await repo.getPolicyForCall(connId, "prompt_get", world.admin)
    expect(decision.decision).toBe("auto")
    expect(decision.policyPath).toBe("connection_default")
  })
})
