// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo side of the API connector (C8): a demo org's seeded connection is
// answered in-process by the fixture CRM, with ZERO outbound requests and no
// DNS lookup, and a normal org is never answered from the fixture, even with
// the very same adapter and URL.
//
// Real database, the real routes module (which registers the responder at
// load), and the outbound fetch seam as a spy that counts every request.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { errorHandler } from "~/middleware/error-handler"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { loadFixtureCrmAdapter } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/adapter"
import {
  registerApiConnectorApp,
  testApiConn,
} from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { apiConnectorRoutes } from "~/modules/apps/connections/api/routes.test-helpers"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  DEMO_API_CONNECTOR_BASE_URL,
  DEMO_API_CONNECTOR_IDENTIFIER,
  forgetDemoFixtureCrm,
  installDemoApiConnectorConnection,
  maybeDemoApiConnectorResponse,
} from "./index"
import { DemoFixtureCrmTestAccess } from "./responder"

const READ_ADMIN = ["api-connector:read", "api-connector:admin"]
const ACME_CONTACT = "jane.doe@acme-instruments.example"

let DEMO_ORG = ""
let NORMAL_ORG = ""
let USER = ""
let outbound: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

function makeApp(orgId: string) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", orgId)
    c.set("userId", USER)
    c.set("scopes", READ_ADMIN.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/api-connector", apiConnectorRoutes)
  return app
}

async function newOrg(label: string): Promise<string> {
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${label}, ${`${label}-${Date.now()}`}) RETURNING id`,
    ),
  )
  return org?.id ?? ""
}

beforeAll(async () => {
  await acquireTestLock()
  DEMO_ORG = await newOrg("api-connector-demo-c8")
  NORMAL_ORG = await newOrg("api-connector-normal-c8")
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${DEMO_ORG}::uuid, ${`admin-${Date.now()}@api-connector-demo.test`},
                'Admin', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(DEMO_ORG)
  await registerApiConnectorApp(DEMO_ORG)
  await ensureAppsForOrg(NORMAL_ORG)
  await registerApiConnectorApp(NORMAL_ORG)
  await markOrgAsDemo(DEMO_ORG, visitorMarker(24))
  DemoModeTestAccess.set(true)
  invalidateDemoMarker()
}, 120_000)

afterAll(async () => {
  DemoModeTestAccess.set(null)
  invalidateDemoMarker()
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(async () => {
  outbound = []
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    outbound.push(String(input))
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch)
  await invalidateConnectionCaches(testApiConn(DEMO_ORG), DEMO_API_CONNECTOR_IDENTIFIER)
  await invalidateConnectionCaches(testApiConn(NORMAL_ORG), DEMO_API_CONNECTOR_IDENTIFIER)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

describe("demo org: the seeded API connection", () => {
  it("is installed idempotently with the fixture adapter at the demo origin", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const counts = await withPrivilegedDb(DEMO_ORG, "test-demo-api-connector-counts", async (tx) =>
      extractRows<{ adapters: number; accounts: number }>(
        await tx.execute(drizzleSql`
          SELECT
            (SELECT count(*)::int FROM kernel.api_adapters WHERE org_id = ${DEMO_ORG}::uuid) AS adapters,
            (SELECT count(*)::int FROM kernel.connected_accounts
               WHERE org_id = ${DEMO_ORG}::uuid AND app_name = 'api-connector') AS accounts`),
      ),
    )
    expect(counts[0]).toEqual({ adapters: 1, accounts: 1 })

    const res = await makeApp(DEMO_ORG).request("/api/api-connector/adapters")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        readOnly: boolean
        connections: { identifier: string; baseUrl: string; status: string }[]
      }
    }
    expect(body.data.readOnly).toBe(true)
    expect(body.data.connections).toEqual([
      expect.objectContaining({
        identifier: DEMO_API_CONNECTOR_IDENTIFIER,
        baseUrl: DEMO_API_CONNECTOR_BASE_URL,
        status: "ok",
      }),
    ])
  })

  it("answers the customer card from the fixture with zero outbound requests", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const res = await makeApp(DEMO_ORG).request(
      `/api/api-connector/customer?email=${encodeURIComponent(ACME_CONTACT)}`,
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: {
        configured: boolean
        matches: { connection: string; summary: Record<string, string>; orders?: unknown[] }[]
      }
    }
    expect(data.configured).toBe(true)
    expect(data.matches).toHaveLength(1)
    expect(data.matches[0]?.connection).toBe(DEMO_API_CONNECTOR_IDENTIFIER)
    expect(Object.values(data.matches[0]?.summary ?? {}).join(" ")).toContain("Acme Instruments")
    expect((data.matches[0]?.orders ?? []).length).toBeGreaterThan(0)
    expect(outbound).toEqual([])
    expect(lookupSpy).not.toHaveBeenCalled()
  })

  it("runs a read operation from the Test panel with zero outbound requests", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const res = await makeApp(DEMO_ORG).request(
      `/api/api-connector/adapters/${DEMO_API_CONNECTOR_IDENTIFIER}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "find_customers", params: { email: ACME_CONTACT } }),
      },
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { ok: boolean; items: { name?: string; internal_notes?: string }[] }
    }
    expect(data.ok).toBe(true)
    expect(data.items.map((i) => i.name)).toEqual(["Acme Instruments"])
    // Projection still applies to the in-process answer.
    expect(data.items[0]?.internal_notes).toBeUndefined()
    expect(outbound).toEqual([])
  })
})

describe("demo org: the fixture CRM keeps what the agent writes", () => {
  const NEW_CONTACT = `ines.new-${Date.now()}@new-customer.example`
  let seq = Date.now()

  async function createContact(orgId: string, email: string): Promise<Response> {
    const adapter = loadFixtureCrmAdapter({ baseUrl: DEMO_API_CONNECTOR_BASE_URL })
    const operation = adapter.operations.find((o) => o.name === "create_contact")
    if (!operation) throw new Error("fixture adapter has no create_contact")
    const res = await maybeDemoApiConnectorResponse({
      ...testApiConn(orgId),
      identifier: DEMO_API_CONNECTOR_IDENTIFIER,
      adapter,
      operation,
      url: new URL(`${DEMO_API_CONNECTOR_BASE_URL}/contacts`),
      method: "POST",
      body: {
        contact: {
          first_name: "Ines",
          last_name: "New",
          email,
          company: { name: `New Customer ${++seq}`, domain: `new-customer-${seq}.example` },
        },
      },
    })
    if (!res) throw new Error("the demo responder declined a demo org's write")
    return res
  }

  async function customerCard(orgId: string, email: string) {
    const res = await makeApp(orgId).request(
      `/api/api-connector/customer?email=${encodeURIComponent(email)}`,
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { matches: { summary: Record<string, string> }[] }
    }
    return data.matches
  }

  it("finds a contact created through the connector on the next lookup, in that org only", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const OTHER_DEMO_ORG = await newOrg("api-connector-demo-other")
    await ensureAppsForOrg(OTHER_DEMO_ORG)
    await registerApiConnectorApp(OTHER_DEMO_ORG)
    await markOrgAsDemo(OTHER_DEMO_ORG, visitorMarker(24))
    invalidateDemoMarker()
    await installDemoApiConnectorConnection({ orgId: OTHER_DEMO_ORG, createdByUserId: USER })

    const created = await createContact(DEMO_ORG, NEW_CONTACT)
    expect(created.status).toBe(201)

    const matches = await customerCard(DEMO_ORG, NEW_CONTACT)
    expect(matches).toHaveLength(1)
    expect(Object.values(matches[0]?.summary ?? {}).join(" ")).toContain("New Customer")

    // A second create of the same person is refused: the store saw the first.
    expect((await createContact(DEMO_ORG, NEW_CONTACT)).status).toBe(409)

    // Another visitor's org never sees it.
    expect(await customerCard(OTHER_DEMO_ORG, NEW_CONTACT)).toEqual([])
    expect(outbound).toEqual([])
  })

  it("starts from the seed again once the org's store is forgotten (a reset)", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const email = `reset-${Date.now()}@new-customer.example`
    expect((await createContact(DEMO_ORG, email)).status).toBe(201)
    await forgetDemoFixtureCrm(DEMO_ORG)
    expect((await createContact(DEMO_ORG, email)).status).toBe(201)
  })

  // Regression: the write (an approved connector_write) ran on one api
  // replica and the customer card's read landed on another, whose own memory
  // never saw it: "No customer found" for the contact just created.
  it("finds the contact from a process that did not take the write", async () => {
    await installDemoApiConnectorConnection({ orgId: DEMO_ORG, createdByUserId: USER })
    const email = `replica-${Date.now()}@new-customer.example`
    expect((await createContact(DEMO_ORG, email)).status).toBe(201)

    // Another process: nothing of the org's store in its memory.
    DemoFixtureCrmTestAccess.dropLocalReplicas()
    const matches = await customerCard(DEMO_ORG, email)
    expect(matches).toHaveLength(1)
    expect(Object.values(matches[0]?.summary ?? {}).join(" ")).toContain("New Customer")

    // It also refuses the duplicate, as the writer's replica does.
    DemoFixtureCrmTestAccess.dropLocalReplicas()
    expect((await createContact(DEMO_ORG, email)).status).toBe(409)

    // A reset reaches every process: the next one starts from the seed.
    await forgetDemoFixtureCrm(DEMO_ORG)
    expect(await customerCard(DEMO_ORG, email)).toEqual([])
  })
})

describe("normal org: never intercepted", () => {
  it("sends the same adapter's request out, not to the fixture", async () => {
    const adapter = loadFixtureCrmAdapter({ baseUrl: DEMO_API_CONNECTOR_BASE_URL })
    await upsertAdapterRow(testApiConn(NORMAL_ORG), DEMO_API_CONNECTOR_IDENTIFIER, adapter, USER)
    await withPrivilegedDb(NORMAL_ORG, "test-normal-org-credentials", (tx) =>
      createCredentialConnection(tx, NORMAL_ORG, USER, "api-connector", "api", {
        identifier: DEMO_API_CONNECTOR_IDENTIFIER,
        credentials: { apiKey: "normal-org-key" },
        ownerType: "org",
      }),
    )
    const res = await makeApp(NORMAL_ORG).request(
      `/api/api-connector/customer?email=${encodeURIComponent(ACME_CONTACT)}`,
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { matches: unknown[] } }
    // The spy answered an empty list: no fixture data reached this org.
    expect(data.matches).toEqual([])
    expect(outbound.length).toBeGreaterThan(0)
    expect(outbound.every((u) => u.startsWith(DEMO_API_CONNECTOR_BASE_URL))).toBe(true)
  })
})

describe("demo org: an oauth2 connection written around the routes (P2-SK4)", () => {
  it("never requests a token: refused before anything leaves the box", async () => {
    const r = validateAdapter({
      id: "erp",
      name: "Some ERP",
      version: "1",
      baseUrl: "https://erp.example.com",
      auth: { type: "oauth2ClientCredentials", tokenUrl: "https://erp.example.com/oauth/token" },
      operations: [
        {
          name: "list_stock",
          description: "Stock.",
          kind: "read",
          method: "GET",
          path: "/stock",
          params: { type: "object", properties: {} },
          items: "/data",
          fields: ["sku"],
        },
      ],
    })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    await db.execute(drizzleSql`
      INSERT INTO kernel.api_adapters
        (org_id, app_name, connection_name, identifier, adapter, adapter_version)
      VALUES (${DEMO_ORG}::uuid, 'api-connector', 'api', 'erp', ${JSON.stringify(r.adapter)}::jsonb, '1')
      ON CONFLICT (org_id, app_name, connection_name, identifier) DO UPDATE SET adapter = EXCLUDED.adapter`)
    await withPrivilegedDb(DEMO_ORG, "test-demo-oauth-credentials", (tx) =>
      tx.insert(connectedAccounts).values({
        orgId: DEMO_ORG,
        appName: "api-connector",
        connectionName: "api",
        ownerType: "org",
        ownerId: null,
        identifier: "erp",
        providerType: "credentials",
        displayName: "Some ERP",
        status: "active",
        createdBy: USER,
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ clientId: "cid", clientSecret: "demo-oauth-secret" }),
          process.env.ENCRYPTION_KEY ?? "",
          CryptoContext.connectedAccountCredentials,
        ),
      }),
    )
    await invalidateConnectionCaches(testApiConn(DEMO_ORG), "erp")
    const res = await makeApp(DEMO_ORG).request("/api/api-connector/adapters/erp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "list_stock", params: {} }),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { ok: boolean; code?: string } }
    expect(data).toMatchObject({ ok: false, code: "demo_restricted" })
    expect(outbound).toEqual([])
    expect(lookupSpy).not.toHaveBeenCalled()
  })
})

describe("demo org: connector changes refused (C8)", () => {
  it("an adapter upload is refused with zero rows written and nothing sent", async () => {
    const count = async () =>
      extractRows<{ adapters: number; accounts: number }>(
        await db.execute(drizzleSql`SELECT
          (SELECT count(*)::int FROM kernel.api_adapters WHERE org_id = ${DEMO_ORG}::uuid) AS adapters,
          (SELECT count(*)::int FROM kernel.connected_accounts WHERE org_id = ${DEMO_ORG}::uuid) AS accounts`),
      )[0]
    const before = await count()
    const adapter = loadFixtureCrmAdapter({ baseUrl: "https://crm.attacker.invalid" })
    const res = await makeApp(DEMO_ORG).request("/api/api-connector/adapters/visitor-crm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adapter),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await count()).toEqual(before)
    expect(outbound).toEqual([])
  })
})
