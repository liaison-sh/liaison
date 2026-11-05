// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMcpOrg, initMcpClient, McpClientTestAccess } from "./index"
import { slugIndex } from "./slug-index"

describe("initMcpClient + ensureMcpOrg: engine at boot, projection at the org's first touch", () => {
  let world: McpTestWorld

  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
    McpClientTestAccess.reset()
  })
  afterEach(() => {
    McpClientTestAccess.reset()
  })

  it("happy boot WITHOUT cached capabilities: slugIndex populated, but no mcp:* registry entries", async () => {
    const slug = `nocaps-${crypto.randomUUID().slice(0, 6)}`
    const id = await withSystemDb("init-test-seed-nocap", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug,
          displayName: slug,
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "none",
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    await ensureMcpOrg(world.org.id)

    expect(slugIndex.get(world.org.id, slug)).toBe(id)
    // No projected tools — none registered until first dial.
    expect(toolRegistry.get([world.org.id, "mcp", `${slug}:any_upstream_tool`])).toBeUndefined()
    // No synthetic tools either — capabilities aren't cached.
    expect(toolRegistry.get([world.org.id, "mcp", `${slug}:resource_list`])).toBeUndefined()
  })

  it("happy boot WITH cached resources capability: registers the 4 synthetic resource_* tools without dialling", async () => {
    const slug = `cap-${crypto.randomUUID().slice(0, 6)}`
    await withSystemDb("init-test-seed-cap", async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug,
        displayName: slug,
        transport: "http",
        httpUrl: "https://x",
        authFlavor: "none",
        createdBy: world.admin.userId,
        oauthMetadata: { serverCapabilities: { resources: { subscribe: true } } },
      })
    })

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    await ensureMcpOrg(world.org.id)

    for (const t of [
      "resource_list",
      "resource_read",
      "resource_subscribe",
      "resource_unsubscribe",
    ]) {
      expect(toolRegistry.get([world.org.id, "mcp", `${slug}:${t}`])).toBeDefined()
    }
  })

  it("happy boot WITH cached prompts capability: registers prompt synthetic tools", async () => {
    const slug = `cap-p-${crypto.randomUUID().slice(0, 6)}`
    await withSystemDb("init-test-seed-cap-p", async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug,
        displayName: slug,
        transport: "http",
        httpUrl: "https://x",
        authFlavor: "none",
        createdBy: world.admin.userId,
        oauthMetadata: { serverCapabilities: { prompts: {} } },
      })
    })

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    await ensureMcpOrg(world.org.id)

    expect(toolRegistry.get([world.org.id, "mcp", `${slug}:prompt_list`])).toBeDefined()
    expect(toolRegistry.get([world.org.id, "mcp", `${slug}:prompt_get`])).toBeDefined()
  })

  it("disabled connections are NOT added to slugIndex (gate's disabled flag is set instead)", async () => {
    const slug = `dis-${crypto.randomUUID().slice(0, 6)}`
    const id = await withSystemDb("init-test-seed-dis", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug,
          displayName: slug,
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "none",
          createdBy: world.admin.userId,
          disabled: true,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    await ensureMcpOrg(world.org.id)

    expect(slugIndex.get(world.org.id, slug)).toBeUndefined()
    // Sanity: the connection id still exists in DB
    expect(id).toBeTruthy()
  })

  it("boot projects nothing; the first touch of org A projects A's connections only", async () => {
    const seed = (orgId: string, userId: string, slug: string) =>
      withSystemDb("init-test-seed-two-orgs", async (db) => {
        await db.insert(mcpConnections).values({
          orgId,
          slug,
          displayName: slug,
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "none",
          createdBy: userId,
          oauthMetadata: { serverCapabilities: { prompts: {} } },
        })
      })
    const slugA = `a-${crypto.randomUUID().slice(0, 6)}`
    const slugB = `b-${crypto.randomUUID().slice(0, 6)}`
    await seed(world.org.id, world.admin.userId, slugA)
    await seed(world.otherOrg.id, world.otherAdmin.userId, slugB)

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    expect(slugIndex.get(world.org.id, slugA)).toBeUndefined()
    expect(toolRegistry.get([world.org.id, "mcp", `${slugA}:prompt_list`])).toBeUndefined()

    await ensureMcpOrg(world.org.id)
    expect(toolRegistry.get([world.org.id, "mcp", `${slugA}:prompt_list`])).toBeDefined()
    expect(slugIndex.get(world.otherOrg.id, slugB)).toBeUndefined()
    expect(toolRegistry.get([world.otherOrg.id, "mcp", `${slugB}:prompt_list`])).toBeUndefined()
  })

  it("a connection added after boot (another process) is projected at this process's first touch", async () => {
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    const slug = `late-${crypto.randomUUID().slice(0, 6)}`
    await withSystemDb("init-test-seed-late", async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug,
        displayName: slug,
        transport: "http",
        httpUrl: "https://x",
        authFlavor: "none",
        createdBy: world.admin.userId,
        oauthMetadata: { serverCapabilities: { prompts: {} } },
      })
    })
    await ensureMcpOrg(world.org.id)
    expect(toolRegistry.get([world.org.id, "mcp", `${slug}:prompt_get`])).toBeDefined()
  })

  it("returns without error when there are zero connections", async () => {
    // World has no connections — only orgs + users. initMcpClient should
    // complete without throwing.
    await expect(
      initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true }),
    ).resolves.toBeUndefined()
  })
})
