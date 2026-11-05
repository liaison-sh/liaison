// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T05 (A30 point 1): the Liaison MCP server acts as an agent, with a
// persona, a memory and a roster, ONLY for an agent bound connection. A plain
// user token gets a TOOL SERVER: tools, and nothing that speaks as somebody.
//
// The first case below is a REGRESSION PIN, green today because nothing
// injects a roster into the MCP instructions yet. What falsifies it is the
// roster block reaching that string: verified once by appending the rendered
// roster to `createMcpServer`'s instructions and watching the case go red.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { AGENT_ROSTER_OPEN_TAG } from "~/modules/agent/context/agent-roster"
import {
  AGENT_CHARTER_OPEN_TAG,
  composeAgentDefinition,
  UnknownAgentError,
} from "~/modules/agent/context/context"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createMcpServer } from "~/modules/mcp/server-factory"
import {
  cleanupSeededOrg,
  mutatingTicketTool,
  seedAgentForOrg,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { drainOutbox } from "~/tests/helpers/outbox"

describe("in-app agent tool execution attribution", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
    resetEventBus()
    initEventBus()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as any)
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("stamps actorType:'user' on mutations driven through buildToolSet's executeWrapper", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const tools = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const sdkName = Object.keys(tools).find((k) => k.startsWith(mutatingTicketTool.sdkPrefix))
    expect(sdkName).toBeTruthy()
    await tools[sdkName!].execute(mutatingTicketTool.validParams)
    await drainOutbox()

    const rows = await withSystemDb("t", (db) =>
      db.select().from(auditLog).where(eq(auditLog.actorId, ownerId)),
    )
    const mutationRows = rows.filter((r) => r.action !== "approve" && r.app === "test")
    expect(mutationRows.length).toBeGreaterThan(0)
    expect(mutationRows.every((r) => r.actorType === "user")).toBe(true)
  }, 30_000)
})

describe("a plain user MCP connection is a tool server, never an agent", () => {
  const orgs: string[] = []

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  function instructionsFor(ctx: {
    userId: string
    orgId: string
    scopes: string[]
    agentId?: string
  }): string {
    const server = createMcpServer({
      userId: ctx.userId,
      orgId: ctx.orgId,
      scopes: ctx.scopes as never,
      dimensionGrants: {},
      connectionId: crypto.randomUUID(),
      agentId: ctx.agentId,
    })
    return String((server as unknown as { _instructions?: string })._instructions ?? "")
  }

  it("a plain user token connection carries no roster block", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const instructions = instructionsFor({ userId: ownerId, orgId, scopes })
    expect(instructions.length).toBeGreaterThan(0)
    expect(instructions).not.toContain(AGENT_ROSTER_OPEN_TAG)
    expect(instructions).not.toContain(AGENT_CHARTER_OPEN_TAG)
  })

  it("a plain user token connection carries no memory injection", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const instructions = instructionsFor({ userId: ownerId, orgId, scopes })
    expect(instructions).not.toContain("MEMORY.md")
    expect(instructions).not.toContain("memory/")
    // Composing a definition is the ONLY path that injects a persona, a memory
    // index and a roster, and it is unreachable without an agent: the MCP
    // module never calls it, and it refuses an absent agent rather than
    // composing a personaless definition.
    const factory = await Bun.file(new URL("./server-factory.ts", import.meta.url)).text()
    expect(factory).not.toContain("composeAgentDefinition")
    await expect(
      composeAgentDefinition({
        agentId: "",
        requestingActor: userContextFor(orgId, ownerId, scopes),
        orgId,
      }),
    ).rejects.toBeInstanceOf(UnknownAgentError)
  })

  it("an agent bound connection composes a definition carrying both the charter and the roster", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["*"] })
    // A second live agent, so the org has a roster to render at all.
    await seedAgentForOrg(orgId, { scopeCeiling: ["*"] })
    const definition = await composeAgentDefinition({
      agentId,
      requestingActor: userContextFor(orgId, ownerId, scopes),
      orgId,
    })
    expect(definition.systemPrompt).toContain(AGENT_CHARTER_OPEN_TAG)
    expect(definition.systemPrompt).toContain(AGENT_ROSTER_OPEN_TAG)
  })
})
