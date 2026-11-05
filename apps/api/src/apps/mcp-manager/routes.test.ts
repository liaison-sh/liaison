// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { _setEdition } from "~/lib/edition"
import { errorHandler } from "~/middleware/error-handler"
import * as mcpClient from "~/modules/mcp-client/index"
import { ToolProjector } from "~/modules/mcp-client/projector"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { connectionDefaultDecision } from "./default-policy"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"
import type { McpToolAnnotations } from "./types"

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as any)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  // Mirror production (app.ts) so a thrown PermissionDeniedError → 403 (not a bare 500).
  app.onError(errorHandler)
  return app
}

async function postJson(actor: UserContext, path: string, body: unknown) {
  return appAs(actor).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function patchJson(actor: UserContext, path: string, body: unknown) {
  return appAs(actor).request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function getReq(actor: UserContext, path: string) {
  return appAs(actor).request(path, { method: "GET" })
}

async function deleteReq(actor: UserContext, path: string) {
  return appAs(actor).request(path, { method: "DELETE" })
}

// Test helper: route handlers return well-typed envelopes (see routes.ts); the
// tests here use generic `any` assertions to drill into them without restating
// each shape inline. Keeping these locally typed so the production routes stay
// strictly typed and we don't leak `as any` across the codebase.
type JsonBody = Record<string, any>
async function jsonOf(res: Response): Promise<JsonBody> {
  return (await res.json()) as JsonBody
}

describe("mcp-manager routes — connections CRUD", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
    _setEdition(null)
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
  })
  afterEach(() => {
    _setEdition(null)
  })

  it("POST /connections creates an http+bearer connection (200, returns id); secret stored encrypted", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "linear",
      displayName: "Linear",
      transport: "http",
      ownershipScope: "org",
      httpUrl: "https://mcp.linear.app",
      authFlavor: "bearer",
      bearerToken: "tk-1",
      agentVisibility: "discoverable",
      exposeViaGateway: true,
      connectionDefaultPolicy: "gate_writes",
    })
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)

    const [row] = await withSystemDb("rt-test-fetch", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, body.id)),
    )
    expect(row.secretsEncrypted).toBeTruthy()
    expect(row.secretsEncrypted).not.toContain("tk-1")
    expect(row.orgId).toBe(world.org.id) // session-derived, not body-derived
  })

  // The add flow derives the slug from the name and tries the next one on a
  // `slug_conflict`: a taken slug must answer that 409, never a 500.
  it("POST with a slug the org already has answers 409 slug_conflict", async () => {
    const body = {
      slug: "dup-slug",
      displayName: "Dup",
      transport: "http",
      ownershipScope: "org",
      httpUrl: "https://mcp.dup.example",
      authFlavor: "bearer",
      bearerToken: "tk-dup",
      agentVisibility: "discoverable",
      exposeViaGateway: true,
      connectionDefaultPolicy: "gate_writes",
    }
    expect((await postJson(world.admin, "/apps/mcp-manager/connections", body)).status).toBe(200)
    const again = await postJson(world.admin, "/apps/mcp-manager/connections", body)
    expect(again.status).toBe(409)
    expect((await jsonOf(again)).error.code).toBe("slug_conflict")
  })

  it("POST refuses a local-command (stdio) transport on every edition, admin included", async () => {
    for (const edition of ["managed", "self_hosted"] as const) {
      _setEdition(edition)
      const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
        slug: `fs-${edition.replace("_", "-")}`,
        displayName: "FS",
        transport: "stdio",
        stdioCommand: "/usr/bin/x",
        authFlavor: "none",
      })
      expect(res.status).toBe(400)
      const rows = await withSystemDb("rt-test-stdio", (db) =>
        db
          .select()
          .from(mcpConnections)
          .where(eq(mcpConnections.slug, `fs-${edition.replace("_", "-")}`)),
      )
      expect(rows).toHaveLength(0)
    }
  })

  it("POST rejects agent_visibility=hidden + expose_via_gateway=false (dead row) with 400", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "deadr",
      displayName: "Dead",
      transport: "http",
      httpUrl: "https://x",
      authFlavor: "none",
      agentVisibility: "hidden",
      exposeViaGateway: false,
    })
    expect(res.status).toBe(400)
    expect((await jsonOf(res)).error.code).toBe("dead_row")
  })

  it("POST rejects 403 without the mcp_manager:connection:write scope", async () => {
    const res = await postJson(world.bob, "/apps/mcp-manager/connections", {
      slug: "x",
      displayName: "X",
      transport: "http",
      httpUrl: "https://x",
      authFlavor: "none",
    })
    expect(res.status).toBe(403)
  })

  it("POST rejects an http connection pointed at a link-local metadata address (SSRF)", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "imds",
      displayName: "IMDS",
      transport: "http",
      httpUrl: "https://169.254.169.254/latest/meta-data",
      authFlavor: "none",
    })
    expect(res.status).toBe(400)
  })

  it("POST rejects a non-HTTPS http connection target", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "plain",
      displayName: "Plain",
      transport: "http",
      httpUrl: "http://example.com/mcp",
      authFlavor: "none",
    })
    expect(res.status).toBe(400)
  })

  it("PATCH rejects changing httpUrl to a loopback address (SSRF)", async () => {
    const created = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "patchme",
      displayName: "PatchMe",
      transport: "http",
      httpUrl: "https://mcp.linear.app",
      authFlavor: "none",
    })
    expect(created.status).toBe(200)
    const id = (await jsonOf(created)).id
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      httpUrl: "https://127.0.0.1/mcp",
    })
    expect(res.status).toBe(400)
  })

  it("PATCH on env-managed connection returns 409 env_managed (base-config change rejected)", async () => {
    // Seed an env-managed connection directly.
    const id = await withSystemDb("rt-seed-env", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: "env-linear",
          displayName: "Env Linear",
          transport: "http",
          httpUrl: "https://mcp.linear.app",
          authFlavor: "none",
          managedBy: "env",
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      httpUrl: "https://other",
    })
    expect(res.status).toBe(409)
    expect((await jsonOf(res)).error.code).toBe("env_managed")
  })

  it("DELETE retires the connection and queues mcp_manager:connection:deleted into the outbox", async () => {
    const created = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "to-del",
      displayName: "ToDel",
      transport: "http",
      httpUrl: "https://x",
      authFlavor: "none",
    })
    const { id } = await jsonOf(created)
    const res = await deleteReq(world.admin, `/apps/mcp-manager/connections/${id}`)
    expect(res.status).toBe(200)
    const rows = await withSystemDb("rt-check-gone", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    expect(rows).toHaveLength(0)
  })

  it("POST /:id/disable + /:id/enable toggle disabled flag", async () => {
    const created = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: "togg",
      displayName: "Togg",
      transport: "http",
      httpUrl: "https://x",
      authFlavor: "none",
    })
    const { id } = await jsonOf(created)
    const disable = await postJson(world.admin, `/apps/mcp-manager/connections/${id}/disable`, {})
    expect(disable.status).toBe(200)
    const [rowDisabled] = await withSystemDb("rt-check-disabled", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    expect(rowDisabled.disabled).toBe(true)

    const enable = await postJson(world.admin, `/apps/mcp-manager/connections/${id}/enable`, {})
    expect(enable.status).toBe(200)
    const [rowEnabled] = await withSystemDb("rt-check-enabled", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    expect(rowEnabled.disabled).toBe(false)
  })

  it("rejects cross-org create — admin in Org A submitting orgId for Org B never persists into Org B", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      orgId: world.otherOrg.id, // body claims OTHER org
      slug: "evil",
      displayName: "Evil",
      transport: "http",
      httpUrl: "https://x",
      authFlavor: "none",
    })
    // Either 200 (route ignored body.orgId, wrote to actor.orgId) or 4xx — both
    // are acceptable, the contract is "no Org B row created".
    expect([200, 400, 403, 422]).toContain(res.status)
    const cross = await withSystemDb("rt-cross-check", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.slug, "evil"), eq(mcpConnections.orgId, world.otherOrg.id))),
    )
    expect(cross).toHaveLength(0)
  })

  it("rejects cross-org read — bob (Org A, no read scope) cannot fetch otherOrg's connection", async () => {
    const otherConnId = await withSystemDb("rt-seed-other", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.otherOrg.id,
          slug: "other-stash",
          displayName: "Other Stash",
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "none",
          createdBy: world.otherAdmin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    // Give bob the read scope so RLS — not requireScope — is what stops him.
    const bobReader: UserContext = { ...world.bob, scopes: ["mcp_manager:connection:read"] }
    const res = await getReq(bobReader, `/apps/mcp-manager/connections/${otherConnId}`)
    expect([403, 404]).toContain(res.status)
  })

  it("rejects cross-actor PATCH on a personal connection — bob cannot edit alice's", async () => {
    const aliceConnId = await withSystemDb("rt-seed-alice-personal", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: "alice-personal",
          displayName: "Alice Personal",
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "none",
          ownershipScope: "personal",
          ownerUserId: world.alice.userId,
          createdBy: world.alice.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    const bobWriter: UserContext = { ...world.bob, scopes: ["mcp_manager:connection:write"] }
    const res = await patchJson(bobWriter, `/apps/mcp-manager/connections/${aliceConnId}`, {
      displayName: "Hacked",
    })
    expect([403, 404]).toContain(res.status)
    const [row] = await withSystemDb("rt-check-personal", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, aliceConnId)),
    )
    expect(row.displayName).not.toBe("Hacked")
  })
})

// ── S28: custom headers; PATCH merges the secrets blob ─────────────────────
describe("mcp-manager routes — custom headers and secret merges", () => {
  let world: McpTestWorld
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  const slug = () => `hdr-${Math.random().toString(36).slice(2, 8)}`

  async function blobOf(id: string): Promise<Record<string, any>> {
    const { CryptoContext, decryptSecret } = await import("~/lib/crypto")
    const { encryptionKey } = await import("~/lib/env")
    const [row] = await withSystemDb("hdr-read", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    if (!row.secretsEncrypted) return {}
    return JSON.parse(
      decryptSecret(row.secretsEncrypted, encryptionKey, CryptoContext.mcpConnectionSecrets),
    )
  }

  async function createBearer(extra: Record<string, unknown> = {}) {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: slug(),
      displayName: "Headers",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "bearer",
      bearerToken: "tk-1",
      ...extra,
    })
    return res
  }

  it("stores header values encrypted and returns only their names", async () => {
    const res = await createBearer({
      customHeaders: { "X-Tenant": "acme-42", "X-Api-Version": "3" },
    })
    expect(res.status).toBe(200)
    const { id } = await jsonOf(res)
    const blob = await blobOf(id)
    expect(blob.customHeaders).toEqual({ "X-Tenant": "acme-42", "X-Api-Version": "3" })
    const [row] = await withSystemDb("hdr-raw", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    expect(JSON.stringify(row.oauthMetadata ?? {})).not.toContain("acme-42")

    const one = await jsonOf(await getReq(world.admin, `/apps/mcp-manager/connections/${id}`))
    expect(one.data.customHeaderNames).toEqual(["X-Api-Version", "X-Tenant"])
    expect(JSON.stringify(one)).not.toContain("acme-42")
    const list = await jsonOf(await getReq(world.admin, "/apps/mcp-manager/connections"))
    const listed = list.data.find((c: JsonBody) => c.id === id)
    expect(listed.customHeaderNames).toEqual(["X-Api-Version", "X-Tenant"])
    expect(JSON.stringify(list)).not.toContain("acme-42")
  })

  it("refuses an invalid or reserved header name, a CR/LF value and Authorization on bearer", async () => {
    for (const customHeaders of [
      { "Bad Name": "x" },
      { Host: "evil.example" },
      { "Mcp-Session-Id": "x" },
      { "X-Ok": "line\r\nInjected: 1" },
      { Authorization: "Bearer other" },
    ]) {
      const res = await createBearer({ customHeaders })
      expect(res.status).toBe(400)
    }
  })

  it("refuses Authorization on a no-auth connection and Proxy-Authorization anywhere", async () => {
    const none = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: slug(),
      displayName: "Open",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
      customHeaders: { Authorization: "Basic eDp5" },
    })
    expect(none.status).toBe(400)
    const proxy = await createBearer({ customHeaders: { "Proxy-Authorization": "Basic eDp5" } })
    expect(proxy.status).toBe(400)
  })

  it("refuses custom headers on an OAuth connection", async () => {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug: slug(),
      displayName: "OAuth",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "oauth_dcr",
      customHeaders: { "X-Tenant": "a" },
    })
    expect(res.status).toBe(400)
  })

  it("PATCH merges headers (null removes one) and keeps the bearer token", async () => {
    const { id } = await jsonOf(await createBearer({ customHeaders: { "X-A": "1", "X-B": "2" } }))
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      customHeaders: { "X-B": null, "X-C": "3" },
    })
    expect(res.status).toBe(200)
    const blob = await blobOf(id)
    expect(blob.customHeaders).toEqual({ "X-A": "1", "X-C": "3" })
    expect(blob.bearerToken).toBe("tk-1")
  })

  it("PATCH of a bearer token keeps the custom headers", async () => {
    const { id } = await jsonOf(await createBearer({ customHeaders: { "X-A": "1" } }))
    await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, { bearerToken: "tk-2" })
    const blob = await blobOf(id)
    expect(blob.bearerToken).toBe("tk-2")
    expect(blob.customHeaders).toEqual({ "X-A": "1" })
  })

  it("PATCH refuses to overwrite secrets it cannot decrypt; the list says why the connection waits", async () => {
    const { CryptoContext, encryptSecret } = await import("~/lib/crypto")
    const { encryptionKey } = await import("~/lib/env")
    const good = encryptSecret(
      JSON.stringify({ oauthClientSecret: "old", accessToken: "at-1", refreshToken: "rt-1" }),
      encryptionKey,
      CryptoContext.mcpConnectionSecrets,
    )
    const unreadable = `${good.slice(0, -6)}AAAAAA`
    const id = await withSystemDb("hdr-seed-unreadable", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: slug(),
          displayName: "Unreadable",
          transport: "http",
          httpUrl: "https://mcp.example.com",
          authFlavor: "oauth_static",
          oauthMetadata: { clientId: "pre-1" },
          secretsEncrypted: unreadable,
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      oauthClientSecret: "new",
    })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain("cannot be decrypted")
    const [row] = await withSystemDb("hdr-read-unreadable", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    expect(row.secretsEncrypted).toBe(unreadable)
    // A non-credential edit still goes through.
    const rename = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      displayName: "Renamed",
    })
    expect(rename.status).toBe(200)
    const list = await jsonOf(await getReq(world.admin, "/apps/mcp-manager/connections"))
    const listed = list.data.find((c: JsonBody) => c.id === id)
    expect(listed.status).toBe("oauth_pending")
    expect(listed.lastError).toMatch(/cannot be decrypted/)
    // A flag beside the message: the UI says "can't read saved credentials".
    expect(listed.secretsUnreadable).toBe(true)
    const readable = await jsonOf(await createBearer())
    const fresh = await jsonOf(await getReq(world.admin, "/apps/mcp-manager/connections"))
    expect(fresh.data.find((c: JsonBody) => c.id === readable.id).secretsUnreadable).toBe(false)
  })

  it("PATCH of an OAuth client secret keeps the access and refresh tokens", async () => {
    const { CryptoContext, encryptSecret } = await import("~/lib/crypto")
    const { encryptionKey } = await import("~/lib/env")
    const id = await withSystemDb("hdr-seed-oauth", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: slug(),
          displayName: "Signed in",
          transport: "http",
          httpUrl: "https://mcp.example.com",
          authFlavor: "oauth_static",
          oauthMetadata: { clientId: "pre-1" },
          secretsEncrypted: encryptSecret(
            JSON.stringify({
              oauthClientId: "pre-1",
              oauthClientSecret: "old",
              accessToken: "at-1",
              refreshToken: "rt-1",
            }),
            encryptionKey,
            CryptoContext.mcpConnectionSecrets,
          ),
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      oauthClientSecret: "new",
    })
    expect(res.status).toBe(200)
    const blob = await blobOf(id)
    expect(blob).toMatchObject({
      oauthClientSecret: "new",
      accessToken: "at-1",
      refreshToken: "rt-1",
    })
  })
})

describe("mcp-manager routes — GET /connections/:id/tools", () => {
  let world: McpTestWorld
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })
  afterEach(() => {
    mock.restore()
  })

  async function create(actor: UserContext, slug: string): Promise<string> {
    const res = await postJson(actor, "/apps/mcp-manager/connections", {
      slug,
      displayName: "Tools",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
    })
    expect(res.status).toBe(200)
    return (await jsonOf(res)).id
  }

  it("lists the upstream tools the last dial projected, without Liaison's synthetic ones and without a dial", async () => {
    const id = await create(world.admin, "tools-a")
    // A real projector holding what a dial registered, as the pool does.
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    await projector.registerTools({
      orgId: world.org.id,
      connectionId: id,
      slug: "tools-a",
      tools: [
        {
          name: "search",
          description: "Reads",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "resource_list",
          description: "synthetic",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    })
    spyOn(mcpClient, "getMcpProjector").mockReturnValue(projector)
    const testSpy = spyOn(mcpClient, "testMcpConnection")
    const res = await getReq(world.admin, `/apps/mcp-manager/connections/${id}/tools`)
    expect(res.status).toBe(200)
    expect((await jsonOf(res)).data).toEqual([
      {
        name: "search",
        description: "Reads",
        readOnly: true,
        defaultDecisions: { auto: "auto", gate_writes: "auto", gate_all: "gate" },
        effectiveDecision: "auto",
        source: "default",
      },
    ])
    expect(testSpy).not.toHaveBeenCalled()
  })

  it("lists a tool whose input schema does not convert as unavailable, with the reason", async () => {
    const id = await create(world.admin, "tools-unavail")
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    await projector.registerTools({
      orgId: world.org.id,
      connectionId: id,
      slug: "tools-unavail",
      tools: [
        {
          name: "search",
          description: "Reads",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "remote_shape",
          description: "Refers to a remote schema",
          inputSchema: {
            type: "object",
            properties: { q: { $ref: "https://schemas.example.com/q.json" } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    })
    spyOn(mcpClient, "getMcpProjector").mockReturnValue(projector)
    const res = await getReq(world.admin, `/apps/mcp-manager/connections/${id}/tools`)
    expect(res.status).toBe(200)
    const rows = (await jsonOf(res)).data as Array<Record<string, unknown>>
    expect(rows.map((r) => r.name)).toEqual(["search", "remote_shape"])
    expect(rows[1]).toEqual({
      name: "remote_shape",
      description: "Refers to a remote schema",
      readOnly: false,
      unavailableReason: "unsupported remote $ref: https://schemas.example.com/q.json",
    })
  })

  it("each tool carries its effective decision and its source, matching default-policy.ts", async () => {
    const id = await create(world.admin, "tools-eff")
    // `bare` lists no hints at all.
    const annotated: Record<string, McpToolAnnotations> = {
      search: { readOnlyHint: true },
      wipe: { readOnlyHint: true, destructiveHint: true },
      create_page: { readOnlyHint: false },
      bare: {},
      update_page: { readOnlyHint: false },
    }
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    await projector.registerTools({
      orgId: world.org.id,
      connectionId: id,
      slug: "tools-eff",
      tools: Object.entries(annotated).map(([name, annotations]) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
        annotations,
      })),
    })
    spyOn(mcpClient, "getMcpProjector").mockReturnValue(projector)
    // An explicit choice on one write tool; the rest follow the default (gate_writes).
    const put = await appAs(world.admin).request(`/apps/mcp-manager/connections/${id}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "update_page", overrideDecision: "auto" }),
    })
    expect(put.status).toBe(200)
    const read = async () =>
      (await jsonOf(await getReq(world.admin, `/apps/mcp-manager/connections/${id}/tools`)))
        .data as Array<{ name: string; effectiveDecision: string; source: string }>
    const byName = (rows: Awaited<ReturnType<typeof read>>) =>
      Object.fromEntries(rows.map((r) => [r.name, [r.effectiveDecision, r.source]]))

    for (const policy of ["gate_writes", "gate_all", "auto"] as const) {
      const patch = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
        connectionDefaultPolicy: policy,
      })
      expect(patch.status).toBe(200)
      const rows = byName(await read())
      for (const [name, annotations] of Object.entries(annotated)) {
        if (name === "update_page") continue
        expect(rows[name]).toEqual([connectionDefaultDecision(policy, annotations), "default"])
      }
      expect(rows.update_page).toEqual(["auto", "override"])
    }
    // Under gate_writes, spelled out: reads run, everything else needs approval.
    await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      connectionDefaultPolicy: "gate_writes",
    })
    expect(byName(await read())).toEqual({
      search: ["auto", "default"],
      wipe: ["gate", "default"],
      create_page: ["gate", "default"],
      bare: ["gate", "default"],
      update_page: ["auto", "override"],
    })
  })

  it("is empty before the first dial (no projector) and 404 for a connection the caller cannot read", async () => {
    const id = await create(world.admin, "tools-b")
    spyOn(mcpClient, "getMcpProjector").mockReturnValue(null)
    const mine = await getReq(world.admin, `/apps/mcp-manager/connections/${id}/tools`)
    expect((await jsonOf(mine)).data).toEqual([])
    const foreign = await getReq(world.otherAdmin, `/apps/mcp-manager/connections/${id}/tools`)
    expect(foreign.status).toBe(404)
  })
})

describe("mcp-manager routes — the tools review (bulk policy, reviewed stamp, regate)", () => {
  let world: McpTestWorld
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })
  afterEach(() => {
    mock.restore()
  })

  async function create(slug: string): Promise<string> {
    const res = await postJson(world.admin, "/apps/mcp-manager/connections", {
      slug,
      displayName: "Review",
      transport: "http",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
    })
    expect(res.status).toBe(200)
    return (await jsonOf(res)).id
  }

  it("PUT /policy/bulk writes every override in one request and keeps role overrides", async () => {
    const id = await create("review-a")
    const roleOverrides = [{ roleId: crypto.randomUUID(), decision: "deny" }]
    await appAs(world.admin).request(`/apps/mcp-manager/connections/${id}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "search", overrideDecision: "gate", roleOverrides }),
    })
    const res = await appAs(world.admin).request(
      `/apps/mcp-manager/connections/${id}/policy/bulk`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { toolName: "search", overrideDecision: "auto" },
            { toolName: "list_pages", overrideDecision: "auto" },
          ],
        }),
      },
    )
    expect(res.status).toBe(200)
    const rows = (
      await jsonOf(await getReq(world.admin, `/apps/mcp-manager/connections/${id}/policy`))
    ).data as Array<{ toolName: string; overrideDecision: string; roleOverrides: unknown }>
    const byName = Object.fromEntries(rows.map((r) => [r.toolName, r]))
    expect(byName.search?.overrideDecision).toBe("auto")
    expect(byName.search?.roleOverrides).toEqual(roleOverrides)
    expect(byName.list_pages?.overrideDecision).toBe("auto")
  })

  it("PUT /policy/bulk refuses the connection-wide sentinel and a caller without policy:write", async () => {
    const id = await create("review-b")
    const path = `/apps/mcp-manager/connections/${id}/policy/bulk`
    const sentinel = await appAs(world.admin).request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [{ toolName: "*", overrideDecision: "auto" }] }),
    })
    expect(sentinel.status).toBe(400)
    const member = await appAs(world.alice).request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [{ toolName: "search", overrideDecision: "auto" }] }),
    })
    expect(member.status).toBe(403)
  })

  it("PATCH toolsReviewed stamps toolsReviewedAt; a default-policy change regates the projected tools", async () => {
    const id = await create("review-c")
    const before = (await jsonOf(await getReq(world.admin, `/apps/mcp-manager/connections/${id}`)))
      .data
    expect(before.toolsReviewedAt).toBeNull()
    const regate = spyOn(mcpClient, "regateMcpConnection")
    const res = await patchJson(world.admin, `/apps/mcp-manager/connections/${id}`, {
      connectionDefaultPolicy: "gate_all",
      toolsReviewed: true,
    })
    expect(res.status).toBe(200)
    const after = (await jsonOf(await getReq(world.admin, `/apps/mcp-manager/connections/${id}`)))
      .data
    expect(after.toolsReviewedAt).not.toBeNull()
    expect(after.connectionDefaultPolicy).toBe("gate_all")
    expect(regate).toHaveBeenCalledWith({
      orgId: world.org.id,
      slug: "review-c",
      connectionDefaultPolicy: "gate_all",
    })
  })
})
