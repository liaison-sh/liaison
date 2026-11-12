// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Platform-held API connections are generic: any app whose manifest declares a
// connection with an `api` block gets `ctx.api.*` for that connection, and its
// adapters are its own (keyed by org, app, connection, identifier). No app is
// named by the platform.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { validateAdapter } from "@liaison/api-connector-core"
import { sql } from "~/db"
import { validateAppManifest } from "~/modules/apps/contract"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createApiConnectionMethods } from "./bridge"
import { apiConnectionOf } from "./declarations"
import { deleteConnection, listAdapterRows, upsertAdapterRow } from "./store"

/** A valid multi-account credentials connection, as the api-connector app declares one. */
const CRED = {
  type: "credentials",
  multiInstance: true,
  allowedDomains: [],
  credentialFields: [{ name: "token", type: "password", label: "Token", required: false }],
}
const DECL = { readScope: "acme:read", writeScope: "acme:write", adminScope: "acme:admin" }
let ORG = ""

const adapter = (() => {
  const r = validateAdapter({
    id: "erp",
    name: "Acme ERP",
    version: "1",
    baseUrl: "https://erp.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "list_orders",
        description: "Orders.",
        kind: "read",
        method: "GET",
        path: "/orders",
        params: { type: "object", properties: {} },
        items: "/data",
        fields: ["id"],
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

function methodsOf(app: string, connections: Record<string, unknown>) {
  return createApiConnectionMethods({
    appName: app,
    orgId: ORG,
    userId: "system",
    actorType: "system",
    manifest: { name: app, connections },
    callerScopes: ["acme:read", "acme:admin", "other:read"],
    bridgeOptions: undefined,
    inheritedActor: { actorType: "system", orgId: ORG },
  } as unknown as Parameters<typeof createApiConnectionMethods>[0])
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await ensureOrg({ slug: `api-decl-${Date.now()}`, name: "API declarations" })).orgId
})

afterAll(async () => {
  await sql`DELETE FROM kernel.api_adapters WHERE org_id = ${ORG}`
  await releaseTestLock()
})

describe("platform-held API connections are generic", () => {
  it("finds the one connection with an api block, whatever its name or the app's", () => {
    expect(apiConnectionOf({ connections: { svc: {} } })).toBeNull()
    expect(apiConnectionOf({ connections: { svc: {}, remote: { api: DECL } } })).toEqual({
      connection: "remote",
      decl: DECL,
    })
  })

  it("gives ctx.api to any app that declares one, and to no other", () => {
    expect(
      Object.keys(methodsOf("acme", { remote: { type: "credentials", api: DECL } })),
    ).toContain("api_listOperations")
    expect(methodsOf("acme", { remote: { type: "credentials" } })).toEqual({})
  })

  it("keeps each app's adapters its own", async () => {
    const acme = { orgId: ORG, app: "acme", connection: "remote" }
    const other = { orgId: ORG, app: "other", connection: "api" }
    await upsertAdapterRow(acme, "erp", adapter, null)
    expect((await listAdapterRows(acme)).map((r) => r.identifier)).toEqual(["erp"])
    expect(await listAdapterRows(other)).toEqual([])
    const acmeList = JSON.parse(
      await methodsOf("acme", { remote: { type: "credentials", api: DECL } }).api_listOperations!(
        "{}",
      ),
    ) as { connections: Array<{ connection: string }> }
    expect(acmeList.connections.map((c) => c.connection)).toEqual(["erp"])
    const otherDecl = {
      readScope: "other:read",
      writeScope: "other:write",
      adminScope: "other:admin",
    }
    const otherList = JSON.parse(
      await methodsOf("other", { api: { type: "credentials", api: otherDecl } })
        .api_listOperations!("{}"),
    ) as { connections: unknown[] }
    expect(otherList.connections).toEqual([])
    expect(await deleteConnection(other, "erp")).toBe(false)
    expect((await listAdapterRows(acme)).map((r) => r.identifier)).toEqual(["erp"])
  })

  it("the manifest allows one api connection, and its customerContext names the app's own tools", () => {
    const base = {
      name: "acme",
      version: "1.0.0",
      description: "Acme",
      scopes: ["acme:read", "acme:write", "acme:admin"],
      tools: {
        read_it: {
          description: "Read.",
          handler: "readIt",
          requiredScopes: ["acme:read"],
          params: { type: "object", properties: {} },
        },
      },
    }
    const errorsOf = (connections: Record<string, unknown>) =>
      validateAppManifest({ ...base, connections }).error ?? ""
    expect(
      errorsOf({
        a: { ...CRED, api: DECL },
        b: { ...CRED, api: DECL },
      }),
    ).toContain("at most one connection may carry an api block")
    expect(
      errorsOf({
        a: {
          ...CRED,
          api: {
            ...DECL,
            customerContext: { listTool: "read_it", readTool: "read_it", writeTool: "nope" },
          },
        },
      }),
    ).toContain('customerContext.writeTool: "nope" is not a tool of the app')
  })
})
