// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting an MCP server takes its tools away from the agent at once.
// Live, after DELETE /connections/:id the row was gone but tool_search still
// offered the server's tools (71 for one server) until a restart: the route
// forgot the slug mapping and never retired the projected registry entries or
// closed the pooled client. These run the real route, the real projector and
// the real tool_search against the in-process registry, on this node and on a
// peer node that only sees the `connection:deleted` event.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import type { UserContext } from "~/db/rls"
import { errorHandler } from "~/middleware/error-handler"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  applyMcpConnectionEvent,
  getMcpPool,
  getMcpProjector,
  initMcpClient,
  McpClientTestAccess,
} from "~/modules/mcp-client/index"
import { slugIndex } from "~/modules/mcp-client/slug-index"
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

const TOOLS = [
  {
    name: "search_pages",
    description: "Search the workspace pages by title",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fetch_page",
    description: "Fetch one workspace page by id",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
]

describe("deleting an MCP connection retires its tools from the agent", () => {
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

  async function createConnection(slug: string): Promise<string> {
    const res = await appAs(world.admin).request("/apps/mcp-manager/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        displayName: "Pages",
        transport: "http",
        httpUrl: "https://mcp.example.com/mcp",
        authFlavor: "none",
      }),
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }).id
  }

  /** What a successful dial does: project the server's tools and map the slug. */
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

  function registeredFor(slug: string): string[] {
    return [...toolRegistry.entries()]
      .filter(
        ([key, def]) => key[0] === world.org.id && (def as { appName?: string }).appName === "mcp",
      )
      .map(([, def]) => (def as { name: string }).name)
      .filter((name) => name.startsWith(`${slug}:`))
  }

  async function searchNames(query: string): Promise<string[]> {
    const frame = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      discoveredTools: new Set<string>(),
    }
    const scopes = [...(world.admin.scopes as string[]), "mcp:*"]
    const res = (await runContextStore.run(frame, () =>
      handleToolSearch({ query }, { orgId: world.org.id, userId: world.admin.userId, scopes }),
    )) as { matches?: Array<{ name: string }> }
    return (res.matches ?? []).map((m) => m.name)
  }

  it("DELETE removes every projected tool from the registry and from tool_search", async () => {
    const slug = `pages-${crypto.randomUUID().slice(0, 6)}`
    const id = await createConnection(slug)
    await project(id, slug)
    expect(registeredFor(slug)).toHaveLength(TOOLS.length)
    expect(
      (await searchNames("search workspace pages")).filter((n) => n.includes("search_pages")),
    ).toHaveLength(1)

    const res = await appAs(world.admin).request(`/apps/mcp-manager/connections/${id}`, {
      method: "DELETE",
    })
    expect(res.status).toBe(200)

    expect(registeredFor(slug)).toEqual([])
    const after = await searchNames("search workspace pages")
    expect(after.filter((n) => n.includes("search_pages"))).toEqual([])
    expect(slugIndex.get(world.org.id, slug)).toBeUndefined()
    expect(getMcpPool()?.size() ?? 0).toBe(0)
  })

  it("a peer node retires the tools from the connection:deleted event alone", async () => {
    const slug = `peer-${crypto.randomUUID().slice(0, 6)}`
    const id = crypto.randomUUID()
    await project(id, slug)
    expect(registeredFor(slug)).toHaveLength(TOOLS.length)

    await applyMcpConnectionEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "deleted",
      entityId: id,
      orgId: world.org.id,
      data: { slug },
    })

    expect(registeredFor(slug)).toEqual([])
    expect(slugIndex.get(world.org.id, slug)).toBeUndefined()
  })

  it("a late delete event leaves a newer connection that reused the slug alone", async () => {
    const slug = `reuse-${crypto.randomUUID().slice(0, 6)}`
    const newer = crypto.randomUUID()
    await project(newer, slug)

    await applyMcpConnectionEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "deleted",
      entityId: crypto.randomUUID(),
      orgId: world.org.id,
      data: { slug },
    })

    expect(registeredFor(slug)).toHaveLength(TOOLS.length)
    expect(slugIndex.get(world.org.id, slug)).toBe(newer)
  })
})
