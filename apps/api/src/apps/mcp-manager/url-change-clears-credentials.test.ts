// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An MCP connection's credentials belong to the server they were entered for.
// `PATCH /connections/:id` with a URL on another origin drops the stored bearer
// token, OAuth tokens and custom headers (unless the same PATCH brings new
// ones), so the next dial never sends the old server's token to the new host.
// A new path on the same origin keeps them. Mirrors the api-connector's
// credential-target rule.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnectionHealth, mcpConnections } from "~/db/schema/app_mcp_manager"
import { errorHandler } from "~/middleware/error-handler"
import { credentialsFromRow } from "~/modules/mcp-client/credentials"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld } from "./test-helpers/world"

function request(actor: UserContext, method: string, path: string, body: unknown) {
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
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function readRow(id: string) {
  const [row] = await withSystemDb("mcp-url-change-test-read", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
  )
  if (!row) throw new Error("connection row missing")
  return row
}

async function createBearer(actor: UserContext, slug: string): Promise<string> {
  const created = await request(actor, "POST", "/apps/mcp-manager/connections", {
    slug,
    displayName: slug,
    transport: "http",
    ownershipScope: "org",
    httpUrl: "https://mcp.vendor.example/mcp",
    authFlavor: "bearer",
    bearerToken: "OLD-SERVER-TOKEN",
    customHeaders: { "X-Tenant": "acme" },
  })
  expect(created.status).toBe(200)
  return ((await created.json()) as { id: string }).id
}

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("PATCH /connections/:id: a new server origin clears the stored credentials", () => {
  it("a new origin drops the bearer token and custom headers and asks for sign-in again", async () => {
    const world = await buildMcpWorld()
    const id = await createBearer(world.admin, "erp")

    const patched = await request(world.admin, "PATCH", `/apps/mcp-manager/connections/${id}`, {
      httpUrl: "https://other-host.example/mcp",
    })
    expect(patched.status).toBe(200)

    const row = await readRow(id)
    expect(row.httpUrl).toBe("https://other-host.example/mcp")
    const creds = credentialsFromRow(row)
    expect(creds.authorization).toBeNull()
    expect(creds.headers).toEqual({})

    const [health] = await withSystemDb("mcp-url-change-test-health", (db) =>
      db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, id)),
    )
    expect(health?.status).toBe("needs_reauth")
  })

  it("the same origin with a new path keeps the credentials", async () => {
    const world = await buildMcpWorld()
    const id = await createBearer(world.admin, "erp-path")

    const patched = await request(world.admin, "PATCH", `/apps/mcp-manager/connections/${id}`, {
      httpUrl: "https://mcp.vendor.example/v2/mcp",
    })
    expect(patched.status).toBe(200)

    const creds = credentialsFromRow(await readRow(id))
    expect(creds.authorization).toBe("Bearer OLD-SERVER-TOKEN")
    expect(creds.headers).toEqual({ "X-Tenant": "acme" })
  })

  it("a new origin with a new token in the same PATCH keeps only the new token", async () => {
    const world = await buildMcpWorld()
    const id = await createBearer(world.admin, "erp-new-token")

    const patched = await request(world.admin, "PATCH", `/apps/mcp-manager/connections/${id}`, {
      httpUrl: "https://other-host.example/mcp",
      bearerToken: "NEW-SERVER-TOKEN",
    })
    expect(patched.status).toBe(200)

    const creds = credentialsFromRow(await readRow(id))
    expect(creds.authorization).toBe("Bearer NEW-SERVER-TOKEN")
    expect(creds.headers).toEqual({})
  })
})
