// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CRM whose records nest their values (`properties.name`) and whose people
// and companies are separate objects: the customer card and the agent's
// context through a field-mapped, chained `customer.lookup` (contact by email
// → its company id → the company), against the real database, with the
// outbound fetch seam answering as the CRM's v3-style search and get
// endpoints.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { errorHandler } from "~/middleware/error-handler"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import {
  registerApiConnectorApp,
  testApiConn,
} from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { resolveCustomer } from "~/modules/apps/connections/api/customer"
import { apiConnectorRoutes } from "~/modules/apps/connections/api/routes.test-helpers"
import { runConnectorOperation, writeTarget } from "~/modules/apps/connections/api/service"
import { getAdapterRow, upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ID = "nested"

const NESTED: Adapter = (() => {
  const r = validateAdapter({
    id: "nested-crm",
    name: "Nested CRM",
    version: "1",
    baseUrl: "https://api.nested-crm.example",
    auth: { type: "bearer" },
    operations: [
      {
        name: "find_customer",
        description: "Companies by a contact's email or email domain.",
        kind: "read",
        method: "POST",
        readOnlyPost: true,
        path: "/crm/v3/objects/contacts/search",
        role: "customer.lookup",
        params: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            domain: { type: "string", maxLength: 253 },
          },
        },
        body: {
          filterGroups: [
            {
              $when: "email",
              filters: [{ propertyName: "email", operator: "EQ", value: "{email}" }],
            },
            {
              $when: "domain",
              filters: [{ propertyName: "hs_email_domain", operator: "EQ", value: "{domain}" }],
            },
          ],
          limit: 5,
        },
        items: "/results",
        fields: { contactId: "id", companyId: "properties.associatedcompanyid" },
        chain: [{ operation: "get_company", params: { customerId: "{companyId}" } }],
      },
      {
        name: "get_company",
        description: "One company.",
        kind: "read",
        method: "GET",
        path: "/crm/v3/objects/companies/{customerId}",
        role: "customer.summary",
        params: {
          type: "object",
          properties: { customerId: { type: "string", maxLength: 32 } },
          required: ["customerId"],
        },
        items: "",
        fields: {
          id: "id",
          name: "properties.name",
          domain: "properties.domain",
          stage: "properties.lifecyclestage",
        },
      },
      {
        name: "create_contact",
        description: "A new contact.",
        kind: "write",
        method: "POST",
        path: "/crm/v3/objects/contacts",
        params: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
        body: { properties: { email: "{email}", associatedcompanyid: "9001" } },
        fields: ["id"],
      },
      {
        name: "list_deals",
        description: "One company's deals.",
        kind: "read",
        method: "POST",
        readOnlyPost: true,
        path: "/crm/v3/objects/deals/search",
        role: "deal.list",
        params: {
          type: "object",
          properties: { customerId: { type: "string", maxLength: 32 } },
          required: ["customerId"],
        },
        body: {
          filterGroups: [
            {
              filters: [
                { propertyName: "associations.company", operator: "EQ", value: "{customerId}" },
              ],
            },
          ],
        },
        items: "/results",
        fields: {
          id: "id",
          name: "properties.dealname",
          amount: "properties.amount",
          stage: "properties.dealstage",
        },
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

let ORG = ""
let USER = ""
let seen: { path: string; body: unknown }[] = []
/** Contacts created through `create_contact`, found by email from then on. */
let created: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

type Filter = { propertyName: string; value: string }

function filtersOf(body: unknown): Filter[] {
  const groups = (body as { filterGroups?: { filters: Filter[] }[] }).filterGroups ?? []
  return groups.flatMap((g) => g.filters)
}

function route(url: URL, body: unknown): Response {
  if (url.pathname === "/crm/v3/objects/contacts/search") {
    const f = filtersOf(body)
    const email = f.find((x) => x.propertyName === "email")?.value
    const domain = f.find((x) => x.propertyName === "hs_email_domain")?.value
    if (email === "anna@northwind.test" || domain === "northwind.test")
      return json({
        results: [
          {
            id: "501",
            properties: {
              email: "anna@northwind.test",
              associatedcompanyid: "9001",
              internal: "x",
            },
          },
          { id: "502", properties: { email: "joel@northwind.test", associatedcompanyid: "9001" } },
        ],
      })
    if (email && created.includes(email))
      return json({ results: [{ id: "504", properties: { email, associatedcompanyid: "9001" } }] })
    if (email === "loner@nowhere.test")
      return json({ results: [{ id: "503", properties: { email: "loner@nowhere.test" } }] })
    return json({ results: [] })
  }
  if (url.pathname === "/crm/v3/objects/contacts") {
    const email = (body as { properties?: { email?: string } } | undefined)?.properties?.email
    if (email) created.push(email)
    return json({ id: "504" }, 201)
  }
  if (url.pathname === "/crm/v3/objects/companies/9001")
    return json({
      id: "9001",
      properties: {
        name: "Northwind Music Retail",
        domain: "northwind.test",
        lifecyclestage: "opportunity",
        secret_margin: "0.4",
      },
    })
  if (url.pathname === "/crm/v3/objects/deals/search") {
    const company = filtersOf(body).find((x) => x.propertyName === "associations.company")?.value
    return json({
      results:
        company === "9001"
          ? [
              {
                id: "77",
                properties: {
                  dealname: "Spring order",
                  amount: "31200",
                  dealstage: "contractsent",
                },
              },
            ]
          : [],
    })
  }
  return json({ message: "not found" }, 404)
}

function makeApp() {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("userId", USER)
    c.set("scopes", ["api-connector:read"].map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/api-connector", apiConnectorRoutes)
  return app
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'api-connector-chain', ${`api-connector-chain-${Date.now()}`})
        RETURNING id`,
    ),
  )
  ORG = org?.id ?? ""
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`chain-${Date.now()}@api-connector.test`},
                'Member', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
  await upsertAdapterRow(testApiConn(ORG), ID, NESTED, USER)
  await withPrivilegedDb(ORG, "customer-chain-test", (tx) =>
    createCredentialConnection(tx, ORG, USER, "api-connector", "api", {
      identifier: ID,
      credentials: { token: "tok-nested" },
      ownerType: "org",
    }),
  )
}, 180_000)

afterAll(async () => {
  await invalidateConnectionCaches(testApiConn(ORG), ID)
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(async () => {
  seen = []
  created = []
  await invalidateConnectionCaches(testApiConn(ORG), ID)
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ path: `${url.host}${url.pathname}`, body })
    return route(url, body)
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

describe("customer card through a chained, field-mapped lookup", () => {
  it("resolves an email to the contact's company, with its real name and named deals", async () => {
    const res = await makeApp().request("/api/api-connector/customer?email=anna@northwind.test")
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: {
        matches: {
          matchedBy: string
          summary: Record<string, unknown>
          deals?: Record<string, unknown>[]
        }[]
        errors: unknown[]
      }
    }
    expect(data.errors).toEqual([])
    expect(data.matches).toHaveLength(1)
    const m = data.matches[0]
    expect(m?.matchedBy).toBe("email")
    expect(m?.summary).toEqual({
      id: "9001",
      name: "Northwind Music Retail",
      domain: "northwind.test",
      stage: "opportunity",
    })
    expect(m?.deals).toEqual([
      { id: "77", name: "Spring order", amount: "31200", stage: "contractsent" },
    ])
    // Two contacts of one company: the company is fetched once. Nothing
    // unmapped (internal, secret_margin) reaches the card.
    expect(seen.filter((s) => s.path.endsWith("/companies/9001"))).toHaveLength(2)
    expect(JSON.stringify(data)).not.toContain("secret_margin")
    expect(JSON.stringify(data)).not.toContain("internal")
    // The email search sent only the email filter group ($when).
    const search = seen.find((s) => s.path.endsWith("/contacts/search"))
    expect(filtersOf(search?.body)).toEqual([
      { propertyName: "email", operator: "EQ", value: "anna@northwind.test" } as Filter,
    ])
  })

  it("finds a contact written through the connection at once, past a miss cached before", async () => {
    const actor = { orgId: ORG, userId: USER, actorType: "user" as const }
    const before = await resolveCustomer({
      actor,
      conn: testApiConn(ORG),
      email: "ines@studio.test",
    })
    expect(before.matches).toHaveLength(0)
    // Pinned at staging against the stored adapter, as an approval is.
    const stored = (await getAdapterRow(testApiConn(ORG), ID))?.adapter
    const op = stored?.operations.find((o) => o.name === "create_contact")
    if (!stored || !op) throw new Error("no create_contact")
    const params = { email: "ines@studio.test" }
    await runConnectorOperation({
      conn: testApiConn(ORG),
      actor: { ...actor, actorType: "agent" },
      identifier: ID,
      operation: "create_contact",
      params,
      mode: "write",
      approvedTarget: writeTarget(stored, op, params),
    })
    const after = await resolveCustomer({
      actor,
      conn: testApiConn(ORG),
      email: "ines@studio.test",
    })
    expect(after.matches.map((m) => m.summary.name)).toEqual(["Northwind Music Retail"])
  })

  it("gives the agent's context (email only, first connection) the company's summary", async () => {
    const resolution = await resolveCustomer({
      conn: testApiConn(ORG),
      actor: { orgId: ORG, userId: USER, actorType: "agent" },
      email: "anna@northwind.test",
      emailOnly: true,
      firstConnectionOnly: true,
    })
    const match = resolution.matches.find((m) => m.matchedBy === "email")
    expect(match?.summary.name).toBe("Northwind Music Retail")
  })

  it("follows the domain filter when no email matches, and drops a contact without a company", async () => {
    const byDomain = await resolveCustomer({
      conn: testApiConn(ORG),
      actor: { orgId: ORG, userId: USER, actorType: "user" },
      domain: "northwind.test",
    })
    expect(byDomain.matches.map((m) => [m.matchedBy, m.summary.name])).toEqual([
      ["domain", "Northwind Music Retail"],
    ])
    await invalidateConnectionCaches(testApiConn(ORG), ID)
    seen = []
    const loner = await resolveCustomer({
      conn: testApiConn(ORG),
      actor: { orgId: ORG, userId: USER, actorType: "user" },
      email: "loner@nowhere.test",
      emailOnly: true,
    })
    expect(loner.matches).toEqual([])
    expect(seen.some((s) => s.path.includes("/companies/"))).toBe(false)
  })

  it("runs the chain for a direct read (the agent tool and CLI test path) as one call", async () => {
    const r = await runConnectorOperation({
      conn: testApiConn(ORG),
      actor: { orgId: ORG, userId: USER, actorType: "system" },
      identifier: ID,
      operation: "find_customer",
      params: { email: "anna@northwind.test" },
      mode: "test",
    })
    expect(r.items).toEqual([
      {
        id: "9001",
        name: "Northwind Music Retail",
        domain: "northwind.test",
        stage: "opportunity",
      },
    ])
    expect(r.pages).toBe(2)
  })

  it("refuses a lookup called with none of its filter params, before any request", async () => {
    await expect(
      runConnectorOperation({
        conn: testApiConn(ORG),
        actor: { orgId: ORG, userId: USER, actorType: "system" },
        identifier: ID,
        operation: "find_customer",
        params: {},
        mode: "read",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" })
    expect(seen).toEqual([])
  })

  it("caps a resolution's upstream requests per connection, leaving out what the budget cannot cover", async () => {
    const r = await resolveCustomer({
      conn: testApiConn(ORG),
      actor: { orgId: ORG, userId: USER, actorType: "user" },
      email: "anna@northwind.test",
      requestBudget: 3,
    })
    // Search + company (the chain), then one role call; the other is left out, not an error.
    expect(seen).toHaveLength(3)
    expect(r.errors).toEqual([])
    expect(r.matches[0]?.summary.name).toBe("Northwind Music Retail")
    expect(seen.slice(0, 2).map((x) => x.path)).toEqual([
      "api.nested-crm.example/crm/v3/objects/contacts/search",
      "api.nested-crm.example/crm/v3/objects/companies/9001",
    ])
  })

  it("names a chained operation's fields as the last step's in the connection summary", async () => {
    const res = await makeApp().request("/api/api-connector/adapters")
    const { data } = (await res.json()) as {
      data: { connections: { operations: { name: string; fields: string[] }[] }[] }
    }
    const op = data.connections[0]?.operations.find((o) => o.name === "find_customer")
    // The stored document is jsonb, which keeps a map's names but not their order.
    expect([...(op?.fields ?? [])].sort()).toEqual(["domain", "id", "name", "stage"])
  })
})
