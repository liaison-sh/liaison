// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An MCP server's tools survive an API restart. A connection's tools used to
// live only in process memory (the projected registry entries and the
// annotation cache), filled by a dial. After a restart nothing dialed the
// connection until one of its tools was called, and nothing could call a tool
// tool_search no longer offered: the agent answered "no Notion here" while the
// server page listed the connection, and every tool row read "Write" because
// the read-only hints were gone with the cache.
//
// The boot path now projects every enabled connection's tools from the last
// tools/list it persisted, without dialing anything. This test dials a real
// loopback server once, simulates a fresh process (registry, caches and client
// state cleared, then the boot path run), and checks what a person and their
// personal agent see, in a DM and in a channel the agent was @-mentioned into.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnectionHealth } from "~/db/schema/app_mcp_manager"
import { roleScopeGrants, roles, threadParticipants, threads, userRoles } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { errorHandler } from "~/middleware/error-handler"
import { createPersonalAgent } from "~/modules/agent/directory/personal-agent"
import { resolveTurnScope } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureMcpOrg, initMcpClient, McpClientTestAccess } from "~/modules/mcp-client/index"
import {
  type HttpFixtureHandle,
  startFixtureHttpMcpServer,
} from "~/modules/mcp-client/transports/fixtures/http-mcp-server"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { McpManagerRepoTestAccess, makeMcpRepo } from "./repo"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

const ORIG_ALLOW = process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as never)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  app.onError(errorHandler)
  return app
}

/** A fresh API process, then the org's first touch: no projected tool, no cached hint, no MCP client state. */
async function restartProcess(orgId: string): Promise<void> {
  McpClientTestAccess.reset()
  McpManagerRepoTestAccess.clearAnnotationCache()
  for (const [key] of [...toolRegistry.entries()]) {
    if (key[0] === orgId && key[1] === "mcp") toolRegistry.delete(key)
  }
  await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
  await ensureMcpOrg(orgId)
}

describe("an MCP server's tools after an API restart", () => {
  let world: McpTestWorld
  let fixture: HttpFixtureHandle
  let owner: UserContext
  let member: UserContext
  let ownerAgentId: string
  let memberAgentId: string
  let connectionId: string
  const slug = `catalog-${crypto.randomUUID().slice(0, 6)}`

  async function sessionOf(userId: string): Promise<UserContext> {
    const perms = await withPrivilegedDb(world.org.id, "restart-test-perms", (tx) =>
      loadEffectivePermissions(tx, userId, world.org.id),
    )
    return {
      actorType: "user",
      userId,
      orgId: world.org.id,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    }
  }

  async function personalAgentOf(who: UserContext): Promise<string> {
    return withSystemDb("restart-test-agent", async (tx) => {
      const [existing] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.ownerUserId, who.userId), eq(agents.kind, "personal")))
      if (existing) {
        const { scopes } = await loadEffectivePermissions(tx, who.userId, world.org.id)
        await tx.update(agents).set({ scopeCeiling: scopes }).where(eq(agents.id, existing.id))
        return existing.id
      }
      const created = await createPersonalAgent(tx, {
        orgId: world.org.id,
        userId: who.userId,
        email: `${who.userId.slice(0, 8)}@restart.local`,
        firstName: `p${who.userId.slice(0, 6)}`,
      })
      return created.id
    })
  }

  /** A DM with the person's agent, or a channel the person owns with the agent added. */
  async function room(who: UserContext, kind: "dm" | "channel", agentId: string): Promise<string> {
    return withPrivilegedDb(world.org.id, "restart-test-room", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId: world.org.id,
          handle: `rs-${crypto.randomUUID().slice(0, 8)}`,
          type: kind === "dm" ? "agent_chat" : "thread",
          createdBy: who.userId,
        })
        .returning({ id: threads.id })
      await tx
        .insert(threadParticipants)
        .values({ threadId: t.id, userId: who.userId, orgId: world.org.id })
      if (kind === "channel") {
        await tx.insert(threadParticipants).values({
          threadId: t.id,
          agentId,
          participantType: "agent",
          orgId: world.org.id,
        })
      }
      return t.id
    })
  }

  /** tool_search inside the agent's turn in that room, at the turn's real scope. */
  async function searchInTurn(
    who: UserContext,
    kind: "dm" | "channel",
    agentId: string,
    query: string,
  ): Promise<string[]> {
    const threadId = await room(who, kind, agentId)
    const turn = await withPrivilegedDb(world.org.id, "restart-test-turn", (tx) =>
      resolveTurnScope(
        tx,
        world.org.id,
        threadId,
        { userId: who.userId, scopes: who.scopes as string[] },
        undefined,
        kind === "channel" ? agentId : undefined,
      ),
    )
    expect(turn?.agentId).toBe(agentId)
    const frame: RunContext = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      effectiveScope: turn?.effectiveScope,
      discoveredTools: new Set<string>(),
    }
    const res = (await runContextStore.run(frame, () =>
      handleToolSearch(
        { query, maxResults: 20 },
        { orgId: world.org.id, userId: who.userId, scopes: who.scopes as string[] },
      ),
    )) as { matches?: Array<{ name: string; locked?: boolean }> }
    return (res.matches ?? []).filter((m) => !m.locked).map((m) => m.name)
  }

  async function toolRows(): Promise<Array<{ name: string; readOnly: boolean }>> {
    const res = await appAs(owner).request(`/apps/mcp-manager/connections/${connectionId}/tools`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: Array<{ name: string; readOnly: boolean }> }).data
  }

  const searchName = `mcp__${slug}_page_search`
  const updateName = `mcp__${slug}_page_update`

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"
    // The committed `connection` events reach their subscribers as in production.
    resetEventBus()
    initEventBus()
    registerEventSubscribers()
    McpClientTestAccess.reset()
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    fixture = await startFixtureHttpMcpServer({
      extraTools: [
        {
          name: "page_search",
          description: "Search the workspace pages for a price",
          annotations: { readOnlyHint: true },
        },
        {
          name: "page_update",
          description: "Update one workspace page",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    })
    world = await buildMcpWorld()
    // The owner holds `*` (an org admin); the member holds no role and reaches the
    // server through its "everyone" access.
    await withSystemDb("restart-test-owner", async (db) => {
      const [r] = await db
        .insert(roles)
        .values({ orgId: world.org.id, name: `owner-${crypto.randomUUID().slice(0, 6)}` })
        .returning({ id: roles.id })
      await db.insert(roleScopeGrants).values({ roleId: r.id, scope: "*" })
      await db
        .insert(userRoles)
        .values({ userId: world.admin.userId, roleId: r.id, orgId: world.org.id })
    })
    owner = await sessionOf(world.admin.userId)
    member = await sessionOf(world.bob.userId)
    // Personal agents exist before the server is added, as in a live workspace.
    ownerAgentId = await personalAgentOf(owner)
    memberAgentId = await personalAgentOf(member)

    const created = await appAs(owner).request("/apps/mcp-manager/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        displayName: "Workspace pages",
        transport: "http",
        httpUrl: fixture.url,
        authFlavor: "none",
        connectionDefaultPolicy: "gate_writes",
      }),
    })
    expect(created.status).toBe(200)
    connectionId = ((await created.json()) as { id: string }).id
    await drainOutbox()
    const dialed = await appAs(owner).request(
      `/apps/mcp-manager/connections/${connectionId}/test`,
      { method: "POST" },
    )
    expect(((await dialed.json()) as { ok: boolean }).ok).toBe(true)
    owner = await sessionOf(world.admin.userId)
    member = await sessionOf(world.bob.userId)
  })

  afterAll(async () => {
    resetEventBus()
    McpClientTestAccess.reset()
    McpManagerRepoTestAccess.clearAnnotationCache()
    await fixture?.close()
    if (ORIG_ALLOW !== undefined) process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = ORIG_ALLOW
    else delete process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
    await releaseTestLock()
  })

  it("before the restart: the owner's agent finds the server's tools in a DM", async () => {
    expect(await searchInTurn(owner, "dm", ownerAgentId, "workspace pages price")).toContain(
      searchName,
    )
    const rows = await toolRows()
    expect(rows.find((r) => r.name === "page_search")?.readOnly).toBe(true)
  })

  it("before the restart: a member's agent, made before the server was added, finds them too", async () => {
    expect(await searchInTurn(member, "dm", memberAgentId, "workspace pages")).toContain(searchName)
  })

  describe("after a restart, with no dial since", () => {
    beforeAll(async () => {
      await restartProcess(world.org.id)
    })

    it("the owner's personal agent finds the tools in a DM", async () => {
      const names = await searchInTurn(owner, "dm", ownerAgentId, "workspace pages price")
      expect(names).toContain(searchName)
      expect(names).toContain(updateName)
    })

    it("the owner's personal agent, @-mentioned in a channel, finds them too", async () => {
      expect(await searchInTurn(owner, "channel", ownerAgentId, "workspace pages")).toContain(
        searchName,
      )
    })

    it("a member's personal agent finds them through the server's everyone access", async () => {
      expect(await searchInTurn(member, "dm", memberAgentId, "workspace pages")).toContain(
        searchName,
      )
    })

    it("the server page lists the tools with their read hints", async () => {
      const rows = await toolRows()
      expect(rows.map((r) => r.name).sort()).toEqual(["echo", "page_search", "page_update"])
      expect(rows.find((r) => r.name === "page_search")?.readOnly).toBe(true)
      expect(rows.find((r) => r.name === "page_update")?.readOnly).toBe(false)
    })

    it("a read tool runs without approval and a write still parks (gate_writes)", async () => {
      const entryOf = (tool: string) =>
        [...toolRegistry.entries()].find(
          ([k]) => k[0] === world.org.id && k[1] === "mcp" && k[2] === `${slug}:${tool}`,
        )?.[1] as { gated?: boolean } | undefined
      expect(entryOf("page_search")?.gated).toBe(false)
      expect(entryOf("page_update")?.gated).toBe(true)
      const repo = makeMcpRepo()
      const read = await repo.getPolicyForCall(connectionId, "page_search", owner)
      expect(read.decision).toBe("auto")
      const write = await repo.getPolicyForCall(connectionId, "page_update", owner)
      expect(write.decision).toBe("gate")
    })

    it("another process that never booted with the list still reads the hints", async () => {
      McpManagerRepoTestAccess.clearAnnotationCache()
      const repo = makeMcpRepo()
      expect((await repo.getPolicyForCall(connectionId, "page_search", owner)).decision).toBe(
        "auto",
      )
    })
  })

  describe("a connection last dialed before tool lists were stored", () => {
    // Connected and healthy, but its tools/list was never stored (dialed by a build
    // before migration 0200): the boot has nothing to project. Its first tool_search
    // dials it once, and the list is stored for the next boot.
    let legacy: HttpFixtureHandle
    let legacyId: string
    const legacySlug = `legacy-${crypto.randomUUID().slice(0, 6)}`

    beforeAll(async () => {
      legacy = await startFixtureHttpMcpServer({
        extraTools: [
          {
            name: "ledger_lookup",
            description: "Look up a ledger entry by reference",
            annotations: { readOnlyHint: true },
          },
        ],
      })
      const created = await appAs(owner).request("/apps/mcp-manager/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: legacySlug,
          displayName: "Ledger",
          transport: "http",
          httpUrl: legacy.url,
          authFlavor: "none",
          connectionDefaultPolicy: "gate_writes",
        }),
      })
      expect(created.status).toBe(200)
      legacyId = ((await created.json()) as { id: string }).id
      await drainOutbox()
      await makeMcpRepo().recordHealth(legacyId, {
        status: "connected",
        lastHandshakeAt: new Date(),
      })
      owner = await sessionOf(world.admin.userId)
      await restartProcess(world.org.id)
    })
    afterAll(async () => {
      await legacy?.close()
    })

    const legacyTool = () => `mcp__${legacySlug}_ledger_lookup`
    const storedList = async () => {
      const [row] = await withSystemDb("restart-test-tool-list", (db) =>
        db
          .select({ toolList: mcpConnectionHealth.toolList })
          .from(mcpConnectionHealth)
          .where(eq(mcpConnectionHealth.connectionId, legacyId)),
      )
      return row?.toolList ?? null
    }

    it("the boot projects nothing for it and contacts no server", async () => {
      expect(await storedList()).toBeNull()
      const planted = [...toolRegistry.entries()].filter(
        ([k]) => k[0] === world.org.id && k[1] === "mcp" && k[2].startsWith(`${legacySlug}:`),
      )
      expect(planted).toEqual([])
    })

    it("the first tool_search dials it once: its tools are found and its list is stored", async () => {
      expect(await searchInTurn(owner, "dm", ownerAgentId, "ledger entry reference")).toContain(
        legacyTool(),
      )
      const stored = await storedList()
      expect(stored?.map((t) => t.name)).toContain("ledger_lookup")
      expect(stored?.find((t) => t.name === "ledger_lookup")?.annotations.readOnlyHint).toBe(true)
    })
  })
})
