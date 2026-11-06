// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provider teardown across the real boundaries a deployment has: the process
// that commits a disconnect is not the one that drains its outbox event, and an
// app's manifest is what declares the Gmail watch. The provider is a local server.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { disconnectConnection } from "~/modules/apps/connections/service"
import { createScope } from "~/modules/permissions/types"

const orgId = randomUUID()
const userId = randomUUID()
let server: ReturnType<typeof Bun.serve>
const calls: Array<{ path: string; auth: string | null; body: string }> = []

const stopUrl = () => `http://localhost:${server.port}/stop`
const revokeUrl = () => `http://localhost:${server.port}/revoke`

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, 'Teardown Boundary Org', ${`teardown-boundary-${orgId}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${userId}, ${orgId}, ${`boundary-${orgId}@test.com`}, 'hash', 'Owner', 'active')`
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      })
      return new Response(new URL(req.url).pathname === "/stop" ? null : "{}", {
        status: new URL(req.url).pathname === "/stop" ? 204 : 200,
      })
    },
  })
  initializedOrgRuntimes.add(orgId)
})

afterEach(async () => {
  calls.length = 0
})

afterAll(async () => {
  server.stop(true)
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  initializedOrgRuntimes.delete(orgId)
})

function declare(appName: string, connectionName: string): void {
  connectionConfigRegistry.set([orgId, appName, connectionName], {
    type: "oauth2",
    allowedDomains: [],
    tokenUrl: "https://oauth2.example.test/token",
    revocationUrl: revokeUrl(),
    watchStopUrl: stopUrl(),
  })
}

async function insertConnection(identifier: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
       access_token_encrypted, refresh_token_encrypted, token_expires_at, status, created_by)
    VALUES (${orgId}, 'mail', 'gmail', 'user', ${userId}, 'oauth2', ${identifier},
      ${encryptSecret("access-1", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
      ${encryptSecret("refresh-1", env.ENCRYPTION_KEY, CryptoContext.connectedAccountRefreshToken)},
      ${new Date(Date.now() + 3_600_000).toISOString()}, 'active', ${userId})
    RETURNING id`
  return row!.id
}

describe("provider teardown across process boundaries", () => {
  it("an outbox consumer in ANOTHER process stops the watch and revokes the grant", async () => {
    declare("mail", "gmail")
    const id = await insertConnection(`cross-process-${orgId}@example.com`)
    // The sandboxed disconnect tool's shape: the api process commits, nobody here runs anything.
    await withPrivilegedDb(orgId, "teardown-boundary-test", (tx) =>
      disconnectConnection(tx, orgId, userId, id),
    )
    expect(calls).toHaveLength(0)

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        new URL("./teardown-boundary.process-fixture.ts", import.meta.url).pathname,
        orgId,
        "mail",
        "gmail",
        id,
        revokeUrl(),
        stopUrl(),
      ],
      { env: process.env, stdout: "ignore", stderr: "inherit" },
    )
    expect(await proc.exited).toBe(0)

    expect(calls.map((c) => c.path)).toEqual(["/stop", "/revoke"])
    expect(calls[0]!.auth).toBe("Bearer access-1")
    expect(new URLSearchParams(calls[1]!.body).get("token")).toBe("refresh-1")
  }, 60_000)

  it("DELETE /connections/:id under the owner's RLS stops the watch before it revokes", async () => {
    declare("mail", "gmail")
    const id = await insertConnection(`route-${orgId}@example.com`)
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("orgId", orgId)
      c.set("userId", userId)
      c.set("scopes", ["mail:*"].map(createScope))
      c.set("dimensionGrants", {})
      await next()
    })
    app.route("/api/connections", connectionRoutes)
    const res = await app.request(`/api/connections/${id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.path)).toEqual(["/stop", "/revoke"])
    const [row] = await sql<{ access: string | null; refresh: string | null }[]>`
      SELECT access_token_encrypted AS access, refresh_token_encrypted AS refresh
      FROM kernel.connected_accounts WHERE id = ${id}`
    expect(row).toEqual({ access: null, refresh: null })
  }, 60_000)

  it("the Gmail connections of Mail and Tickets declare where a watch is stopped", () => {
    for (const app of ["mail", "tickets"]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../../apps/${app}/app.manifest.json`, import.meta.url), "utf8"),
      )
      expect(manifest.connections.gmail.watchStopUrl).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      )
    }
  })
})
