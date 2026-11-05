// SPDX-License-Identifier: FSL-1.1-ALv2
// A connection's org-level administration (connect for the organization, share,
// disconnect or reconcile an org-owned account) is decided by the connection's
// own `adminScope` from the manifest, default `<app>:accounts:admin`. The
// connections listing carries the resolved scope, so the settings page shows
// Share / Disconnect to exactly the people the server lets do it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "t2adm"
const OWN = `${APP}:admin:connection`
const DEFAULT = `${APP}:accounts:admin`

describe("connection adminScope", () => {
  let orgId: string
  let userId: string
  let ownToken: string
  let defaultToken: string

  const tokenWith = (scopes: string[]) =>
    signAccessToken(
      { userId, orgId, name: "T2", authVersion: 1, permissionVersion: 1, scopes },
      env.JWT_SECRET,
    )

  async function orgAccount(connectionName: string): Promise<string> {
    const rows = (await sql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, identifier, owner_type, provider_type, status, created_by)
      VALUES (${orgId}, ${APP}, ${connectionName}, ${crypto.randomUUID()}, 'org', 'credentials', 'active', ${userId})
      RETURNING id`) as Array<{ id: string }>
    const id = rows[0]?.id
    if (!id) throw new Error("no connected account inserted")
    return id
  }

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    userId = await withSystemDb("t2adm-user", async (db) => {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.orgId, orgId))
        .limit(1)
      if (!u) throw new Error("no user after createTestOrg")
      return u.id
    })
    ownToken = await tokenWith([OWN])
    defaultToken = await tokenWith([DEFAULT])
    manifestRegistry.set([orgId, APP], { name: APP, uiBundleUrl: null })
    const creds = {
      type: "credentials" as const,
      allowedDomains: ["demo.test"],
      credentialFields: [{ name: "token", label: "Token", type: "password", required: true }],
    }
    connectionConfigRegistry.set([orgId, APP, "keys"], { ...creds, adminScope: OWN })
    connectionConfigRegistry.set([orgId, APP, "plain"], creds)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    connectionConfigRegistry.deleteByPrefix([orgId, APP])
    manifestRegistry.delete([orgId, APP])
    await releaseTestLock()
  })

  it("the listing carries each connection's resolved admin scope", async () => {
    const res = await app.request(`/api/apps/${APP}/connections`, {
      headers: { Authorization: `Bearer ${ownToken}` },
    })
    expect(res.status).toBe(200)
    const data = ((await res.json()) as { data: Array<{ name: string; adminScope?: string }> }).data
    expect(data.find((c) => c.name === "keys")?.adminScope).toBe(OWN)
    expect(data.find((c) => c.name === "plain")?.adminScope).toBe(DEFAULT)
  })

  it("connecting for the organization takes the declared scope, not the default one", async () => {
    const post = (token: string, conn: string) =>
      app.request(`/api/connections/${APP}/${conn}/credentials`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "org", credentials: { token: "t" } }),
      })
    expect((await post(defaultToken, "keys")).status).toBe(403)
    expect((await post(ownToken, "keys")).status).toBe(201)
    expect((await post(ownToken, "plain")).status).toBe(403)
    expect((await post(defaultToken, "plain")).status).toBe(201)
  })

  it("disconnecting an org-owned account takes the declared scope", async () => {
    const del = (token: string, id: string) =>
      app.request(`/api/connections/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
    const keys = await orgAccount("keys")
    expect((await del(defaultToken, keys)).status).toBe(403)
    expect((await del(ownToken, keys)).status).toBe(200)
    const plain = await orgAccount("plain")
    expect((await del(ownToken, plain)).status).toBe(403)
    expect((await del(defaultToken, plain)).status).toBe(200)
  })
})

// Apps whose connections section is administered by their own connection scope name it on
// every connection too, so the section's people are the ones who can share or disconnect.
describe("bundled apps with their own connection admin scope", () => {
  for (const name of ["social", "ads", "boxtal", "pennylane"]) {
    it(name, () => {
      const m = JSON.parse(
        readFileSync(
          join(import.meta.dir, "../../../../../../bundled-apps", name, "app.manifest.json"),
          "utf8",
        ),
      ) as {
        connections: Record<string, { adminScope?: string }>
        settings: { sections: Array<{ adminScope?: string; blocks: Array<{ block: string }> }> }
      }
      const scope = `${name}:admin:connection`
      for (const [conn, def] of Object.entries(m.connections))
        expect(def.adminScope, conn).toBe(scope)
      const sections = m.settings.sections.filter((s) =>
        s.blocks.some((b) => b.block === "connections"),
      )
      expect(sections.length).toBeGreaterThan(0)
      for (const s of sections) expect(s.adminScope).toBe(scope)
    })
  }
})
