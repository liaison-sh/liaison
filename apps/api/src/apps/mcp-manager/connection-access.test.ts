// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can use an organization MCP server (migration 0198). An org server is
// open to every active member by default; an admin may restrict it to listed
// roles and people. The permission loader derives the server's tool namespace
// `mcp:<slug>` from that setting, so a member outside a restricted server
// neither finds its tools in tool_search nor gets a call through, and a member
// of an "everyone" server needs no role grant at all. Personal connections keep
// their owner-only grant. A default policy change made on one process re-gates
// the tools on every process from its event.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { errorHandler } from "~/middleware/error-handler"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import {
  applyMcpConnectionEvent,
  getMcpProjector,
  initMcpClient,
  McpClientTestAccess,
} from "~/modules/mcp-client/index"
import { slugIndex } from "~/modules/mcp-client/slug-index"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

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

function send(actor: UserContext, method: string, path: string, body?: unknown) {
  return appAs(actor).request(`/apps/mcp-manager${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const TOOLS = [
  {
    name: "search_tickets",
    description: "Search the helpdesk tickets by subject",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "close_ticket",
    description: "Close one helpdesk ticket",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: {},
  },
]

describe("who can use an organization MCP server", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
    McpClientTestAccess.reset()
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
  })
  afterAll(async () => {
    McpClientTestAccess.reset()
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  /** A person's session as the token issuer builds it, read fresh. */
  async function sessionOf(who: UserContext): Promise<UserContext> {
    const perms = await withPrivilegedDb(world.org.id, "mcp-access-test-perms", (tx) =>
      loadEffectivePermissions(tx, who.userId, world.org.id),
    )
    return { ...who, scopes: perms.scopes, dimensionGrants: perms.dimensionGrants }
  }

  async function scopesOf(who: UserContext): Promise<string[]> {
    return (await sessionOf(who)).scopes as string[]
  }

  async function createConnection(
    actor: UserContext,
    slug: string,
    ownershipScope: "org" | "personal" = "org",
  ): Promise<string> {
    const res = await send(actor, "POST", "/connections", {
      slug,
      displayName: "Helpdesk",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
      ownershipScope,
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }).id
  }

  async function project(id: string, slug: string): Promise<void> {
    const projector = getMcpProjector()
    if (!projector) throw new Error("MCP client not initialised")
    await projector.registerTools({
      orgId: world.org.id,
      connectionId: id,
      slug,
      connectionDefaultPolicy: "gate_writes",
      tools: TOOLS,
    })
    slugIndex.set(world.org.id, slug, id)
  }

  async function searchNames(who: UserContext, query: string): Promise<string[]> {
    const session = await sessionOf(who)
    const frame = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      discoveredTools: new Set<string>(),
    }
    const res = (await runContextStore.run(frame, () =>
      handleToolSearch(
        { query },
        { orgId: world.org.id, userId: who.userId, scopes: session.scopes as string[] },
      ),
    )) as { matches?: Array<{ name: string }> }
    return (res.matches ?? []).map((m) => m.name)
  }

  const toolScope = (slug: string) => `mcp:${slug}:search_tickets`

  it("a new org server is open to every member: the loader grants its namespace without a role", async () => {
    const slug = `everyone-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.admin, slug)

    const access = await send(world.admin, "GET", `/connections/${id}/access`)
    expect(access.status).toBe(200)
    expect(((await access.json()) as { data: unknown }).data).toEqual({
      mode: "everyone",
      roleIds: [],
      userIds: [],
    })
    // Bob holds no role at all; Alice holds editor + viewer.
    for (const who of [world.bob, world.alice]) {
      const scopes = await scopesOf(who)
      expect(scopes).toContain(`mcp:${slug}`)
      expect(hasScope(toolScope(slug), scopes)).toBe(true)
    }
    // Another workspace's admin gets nothing from this org's server.
    expect(await scopesOf(world.otherAdmin)).not.toContain(`mcp:${slug}`)
  })

  it("restricted grants the namespace to the listed role and the listed person only", async () => {
    const slug = `restricted-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.admin, slug)

    const byRole = await send(world.admin, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      roleIds: [world.roles.viewer],
    })
    expect(byRole.status).toBe(200)
    expect(hasScope(toolScope(slug), await scopesOf(world.alice))).toBe(true)
    expect(hasScope(toolScope(slug), await scopesOf(world.bob))).toBe(false)

    const byPerson = await send(world.admin, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      userIds: [world.bob.userId],
    })
    expect(byPerson.status).toBe(200)
    expect(hasScope(toolScope(slug), await scopesOf(world.bob))).toBe(true)
    expect(hasScope(toolScope(slug), await scopesOf(world.alice))).toBe(false)

    const read = await send(world.admin, "GET", `/connections/${id}/access`)
    expect(((await read.json()) as { data: unknown }).data).toEqual({
      mode: "restricted",
      roleIds: [],
      userIds: [world.bob.userId],
    })
  })

  it("a personal connection keeps its owner-only grant and has no access setting", async () => {
    const slug = `personal-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.bob, slug, "personal")
    expect(await scopesOf(world.bob)).toContain(`mcp:${slug}`)
    expect(hasScope(toolScope(slug), await scopesOf(world.alice))).toBe(false)

    // An admin cannot even see a teammate's personal connection (RLS): 404.
    const res = await send(world.admin, "PUT", `/connections/${id}/access`, { mode: "everyone" })
    expect(res.status).toBe(404)
    // Its owner sees it, but it has no access setting, and is not an MCP admin.
    const own = await send(world.bob, "GET", `/connections/${id}/access`)
    expect(own.status).toBe(403)
    expect(hasScope(toolScope(slug), await scopesOf(world.alice))).toBe(false)
  })

  it("after PUT restricted, an outsider's tool_search hides the tools and their call is refused", async () => {
    const slug = `helpdesk-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.admin, slug)
    await project(id, slug)
    const visible = (names: string[]) => names.filter((n) => n.includes("search_tickets"))

    // Everyone: Bob, with no role, finds the server's tools.
    expect(visible(await searchNames(world.bob, "search helpdesk tickets"))).toHaveLength(1)

    const put = await send(world.admin, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      roleIds: [world.roles.viewer],
    })
    expect(put.status).toBe(200)

    expect(visible(await searchNames(world.bob, "search helpdesk tickets"))).toEqual([])
    expect(visible(await searchNames(world.alice, "search helpdesk tickets"))).toHaveLength(1)

    const refused = await executeTool({
      toolName: `mcp:${slug}:search_tickets`,
      orgId: world.org.id,
      actor: await sessionOf(world.bob),
      params: { query: "refund" },
      origin: "mcp",
    }).then(
      () => null,
      (err: Error & { status?: number; code?: string }) => err,
    )
    expect(refused?.status).toBe(403)
  })

  it("an access change bumps every member's permission_version, so older tokens are refreshed", async () => {
    const slug = `version-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.admin, slug)
    const versionOf = (userId: string) =>
      withPrivilegedDb(world.org.id, "mcp-access-test-version", async (tx) => {
        const [row] = await tx
          .select({ v: users.permissionVersion })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.orgId, world.org.id)))
        return row?.v ?? -1
      })
    const before = await versionOf(world.bob.userId)
    const res = await send(world.admin, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      roleIds: [],
      userIds: [],
    })
    expect(res.status).toBe(200)
    expect(await versionOf(world.bob.userId)).toBe(before + 1)
  })

  it("is admin only, and refuses roles and people of another workspace", async () => {
    const slug = `guard-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(world.admin, slug)
    // Alice may edit connections (editor) but not decide who uses them.
    const asEditor = await send(world.alice, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      roleIds: [world.roles.viewer],
    })
    expect(asEditor.status).toBe(403)
    expect((await send(world.alice, "GET", `/connections/${id}/access`)).status).toBe(403)

    const foreign = await send(world.admin, "PUT", `/connections/${id}/access`, {
      mode: "restricted",
      userIds: [world.otherAdmin.userId],
    })
    expect(foreign.status).toBe(400)
    // Nothing changed.
    expect(await scopesOf(world.bob)).toContain(`mcp:${slug}`)
  })

  it("a peer process re-gates the tools from the connection:updated event alone", async () => {
    const slug = `regate-${crypto.randomUUID().slice(0, 6)}`
    const id = crypto.randomUUID()
    await project(id, slug)
    const gatedOf = (tool: string) =>
      (
        [...toolRegistry.entries()].find(
          ([key, def]) =>
            key[0] === world.org.id && (def as { name: string }).name === `${slug}:${tool}`,
        )?.[1] as { gated?: boolean } | undefined
      )?.gated
    expect(gatedOf("search_tickets")).toBe(false)

    await applyMcpConnectionEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "updated",
      entityId: id,
      orgId: world.org.id,
      data: { slug, fields: ["connectionDefaultPolicy"], connectionDefaultPolicy: "gate_all" },
    })
    expect(gatedOf("search_tickets")).toBe(true)

    // A late event for another connection that once held the slug changes nothing.
    await applyMcpConnectionEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "updated",
      entityId: crypto.randomUUID(),
      orgId: world.org.id,
      data: { slug, connectionDefaultPolicy: "auto" },
    })
    expect(gatedOf("search_tickets")).toBe(true)
  })
})
