// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provider teardown across the real boundaries a deployment has: the process
// that commits a disconnect is not the one that drains its outbox event, and an
// app's manifest is what declares the Gmail watch. The provider is a local server.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
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
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"

let orgId: string
let userId: string
let server: ReturnType<typeof Bun.serve>
const calls: Array<{ path: string; auth: string | null; body: string }> = []

const stopUrl = () => `http://localhost:${server.port}/stop`
const revokeUrl = () => `http://localhost:${server.port}/revoke`

beforeAll(async () => {
  ;({ orgId, adminUserId: userId } = await minimal.secondOrg({ name: "Teardown Boundary Org" }))
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
  return seedConnectedAccountRow({
    orgId,
    appName: "mail",
    connectionName: "gmail",
    ownerType: "user",
    ownerId: userId,
    providerType: "oauth2",
    identifier,
    accessTokenEncrypted: encryptSecret(
      "access-1",
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    ),
    refreshTokenEncrypted: encryptSecret(
      "refresh-1",
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountRefreshToken,
    ),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    status: "active",
    createdBy: userId,
  })
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
