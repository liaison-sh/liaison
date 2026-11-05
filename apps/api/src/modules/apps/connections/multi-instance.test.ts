// SPDX-License-Identifier: FSL-1.1-ALv2
//
// multiInstance credentials connections: one org holds several accounts of the
// same (app, connection), each addressed by its slug identifier. Re-posting a
// slug replaces only that account; every other app keeps the one-account
// replace semantics.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import {
  createCredentialConnection,
  getCredentialsForConnection,
  registerMultiInstanceCredentialCheck,
} from "~/modules/apps/connections/service"
import { createScope } from "~/modules/permissions/types"

const ORG = "00000000-0000-0000-0000-000000710001"
const USER = "00000000-0000-0000-0000-000000710002"
const MULTI = "multi-test-app"
const SINGLE = "single-test-app"

function makeApp(scopes: string[]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("userId", USER)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/connections", connectionRoutes)
  return app
}

async function rows(app: string) {
  return sql<{ id: string; identifier: string; owner_type: string }[]>`
    SELECT id, identifier, owner_type FROM kernel.connected_accounts
    WHERE org_id = ${ORG} AND app_name = ${app} ORDER BY identifier`
}

function create(
  app: string,
  identifier: string,
  credentials: Record<string, string>,
  ownerType: "org" | "user" = "org",
) {
  return withPrivilegedDb(ORG, "multi-instance-test", (tx) =>
    createCredentialConnection(tx, ORG, USER, app, "api", { identifier, credentials, ownerType }),
  )
}

function creds(app: string, identifier: string) {
  return withPrivilegedDb(ORG, "multi-instance-test", (tx) =>
    getCredentialsForConnection(tx, ORG, USER, app, "api", identifier, {
      actorType: "system",
      ownerType: "org",
    }),
  )
}

describe("multiInstance credentials connections", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Multi Instance Org', 'multi-instance-conn')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'multi-instance@test.com', 'hash', 'Multi', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
    const fields = [
      { name: "apiKey", label: "API key", type: "password", required: false },
      { name: "token", label: "Token", type: "password", required: false },
    ]
    connectionConfigRegistry.set([ORG, MULTI, "api"], {
      type: "credentials",
      multiInstance: true,
      allowedDomains: [],
      credentialFields: fields,
    })
    connectionConfigRegistry.set([ORG, SINGLE, "api"], {
      type: "credentials",
      allowedDomains: [],
      credentialFields: fields,
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
    connectionConfigRegistry.delete([ORG, MULTI, "api"])
    connectionConfigRegistry.delete([ORG, SINGLE, "api"])
  })

  it("keeps two identifiers side by side and resolves each by identifier", async () => {
    await create(MULTI, "crm", { apiKey: "crm-key" })
    await create(MULTI, "erp", { apiKey: "erp-key" })
    expect((await rows(MULTI)).map((r) => r.identifier)).toEqual(["crm", "erp"])
    expect(await creds(MULTI, "crm")).toEqual({ apiKey: "crm-key" })
    expect(await creds(MULTI, "erp")).toEqual({ apiKey: "erp-key" })
  })

  it("re-posting one identifier replaces only that account, keeping its row id", async () => {
    const before = await rows(MULTI)
    await create(MULTI, "crm", { apiKey: "crm-key-2" })
    const after = await rows(MULTI)
    expect(after).toEqual(before)
    expect(await creds(MULTI, "crm")).toEqual({ apiKey: "crm-key-2" })
    expect(await creds(MULTI, "erp")).toEqual({ apiKey: "erp-key" })
  })

  it("refuses a user-owned or non-slug multiInstance account", async () => {
    await expect(create(MULTI, "mine", { apiKey: "x" }, "user")).rejects.toThrow(/org-owned/)
    await expect(create(MULTI, "Not A Slug", { apiKey: "x" })).rejects.toThrow(/identifier/)
    expect((await rows(MULTI)).map((r) => r.identifier)).toEqual(["crm", "erp"])
  })

  it("an app without multiInstance keeps replace semantics (regression)", async () => {
    await create(SINGLE, "first", { apiKey: "a" })
    await create(SINGLE, "second", { apiKey: "b" })
    const r = await rows(SINGLE)
    expect(r).toHaveLength(1)
    expect(r[0]?.identifier).toBe("second")
  })

  describe("POST /api/connections/:app/:conn/credentials", () => {
    const admin = [`${MULTI}:accounts:admin`, `${SINGLE}:accounts:admin`]

    it("requires the accounts admin scope even without mode=org", async () => {
      const res = await makeApp([]).request(`/api/connections/${MULTI}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "crm", apiKey: "k" }),
      })
      expect(res.status).toBe(403)
    })

    it("forces org ownership and uses the body identifier (never a credential field)", async () => {
      const res = await makeApp(admin).request(`/api/connections/${MULTI}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "billing", apiKey: "bill-key" }),
      })
      expect(res.status).toBe(201)
      const row = (await rows(MULTI)).find((r) => r.identifier === "billing")
      expect(row?.owner_type).toBe("org")
      expect(await creds(MULTI, "billing")).toEqual({ apiKey: "bill-key" })
    })

    it("refuses a missing or malformed identifier", async () => {
      for (const body of [{ apiKey: "k" }, { identifier: "../x", apiKey: "k" }]) {
        const res = await makeApp(admin).request(`/api/connections/${MULTI}/api/credentials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(res.status).toBe(400)
      }
    })

    it("runs the app's registered check and surfaces its refusal", async () => {
      registerMultiInstanceCredentialCheck(MULTI, "api", async ({ identifier, credentials }) => {
        if (identifier !== "crm")
          return { ok: false, status: 404, message: "no adapter for this identifier" }
        if (!credentials.apiKey) return { ok: false, status: 400, message: "apiKey is required" }
        return { ok: true }
      })
      try {
        const unknown = await makeApp(admin).request(`/api/connections/${MULTI}/api/credentials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "ghost", apiKey: "k" }),
        })
        expect(unknown.status).toBe(404)
        const missing = await makeApp(admin).request(`/api/connections/${MULTI}/api/credentials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "crm", token: "t" }),
        })
        expect(missing.status).toBe(400)
        expect((await rows(MULTI)).map((r) => r.identifier)).not.toContain("ghost")
      } finally {
        registerMultiInstanceCredentialCheck(MULTI, "api", null)
      }
    })
  })
})
