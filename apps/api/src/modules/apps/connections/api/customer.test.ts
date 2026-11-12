// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/api-connector/customer: the roles resolver across connections,
// against the real database, with the outbound fetch seam answering as three
// fake APIs (a CRM matched by email, an ERP matched by domain, a broken one).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { createPool, __privileged_db__ as db } from "~/db/connection"
import { PrivilegedDbTestAccess, withPrivilegedDb } from "~/db/privileged"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { errorHandler } from "~/middleware/error-handler"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApiConnectorApp } from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { apiConnectorRoutes } from "~/modules/apps/connections/api/routes.test-helpers"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const READ = ["api-connector:read"]

function adapter(doc: Record<string, unknown>): Adapter {
  const r = validateAdapter(doc)
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

const op = (
  name: string,
  role: string,
  path: string,
  properties: Record<string, unknown>,
  fields: string[],
  extra: Record<string, unknown> = {},
) => ({
  name,
  description: name,
  kind: "read",
  method: "GET",
  path,
  params: { type: "object", properties },
  items: "/data",
  fields,
  role,
  ...extra,
})

const CRM = adapter({
  id: "crm",
  name: "Fixture CRM",
  version: "1",
  baseUrl: "https://crm.example.com",
  auth: { type: "bearer" },
  operations: [
    op(
      "find",
      "customer.lookup",
      "/companies",
      { email: { type: "string" }, phone: { type: "string" }, domain: { type: "string" } },
      ["id", "name"],
      {
        query: { email: "{email}", phone: "{phone}", domain: "{domain}" },
      },
    ),
    {
      ...op(
        "summary",
        "customer.summary",
        "/companies/{customerId}",
        { customerId: { type: "string" } },
        ["tier", "owner.name", "notes", "lifetime_value", "currency", "active"],
        {
          items: "",
        },
      ),
      params: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
    },
    {
      ...op(
        "orders",
        "customer.orders",
        "/companies/{customerId}/orders",
        { customerId: { type: "string" } },
        ["id", "total"],
      ),
      params: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
    },
  ],
})

const ERP = adapter({
  id: "erp",
  name: "Fixture ERP",
  version: "1",
  baseUrl: "https://erp.example.com",
  auth: { type: "bearer" },
  operations: [
    op(
      "by_domain",
      "customer.lookup",
      "/accounts",
      { domain: { type: "string" } },
      ["id", "name"],
      { query: { d: "{domain}" } },
    ),
    {
      ...op(
        "invoices",
        "customer.invoices",
        "/accounts/{customerId}/invoices",
        { customerId: { type: "string" } },
        ["id", "amount"],
      ),
      params: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
    },
  ],
})

const BROKEN = adapter({
  id: "broken",
  name: "Broken CRM",
  version: "1",
  baseUrl: "https://broken.example.com",
  auth: { type: "bearer" },
  operations: [
    op("find", "customer.lookup", "/c", { email: { type: "string" } }, ["id", "name"], {
      query: { e: "{email}" },
    }),
  ],
})

let ORG = ""
let BARE_ORG = ""
let USER = ""
let seen: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function route(url: URL): Response {
  if (url.host === "broken.example.com") return json({ error: "down" }, 500)
  if (url.host === "crm.example.com") {
    if (url.pathname === "/companies") {
      const email = url.searchParams.get("email")
      const domain = url.searchParams.get("domain")
      if (email === "jane@acme.test")
        return json({ data: [{ id: "c1", name: "Acme Instruments", secret: "x" }] })
      if (domain === "gmail.com" || domain === "ourco.test")
        return json({ data: [{ id: "g1", name: "Somebody At Free Mail" }] })
      if (url.searchParams.get("phone") === "+33612345678")
        return json({ data: [{ id: "p1", name: "Phone Match SARL" }] })
      if (domain === "multi.test")
        return json({
          data: [
            { id: "m1", name: "Multi East" },
            { id: "m2", name: "Multi West" },
          ],
        })
      return json({ data: [] })
    }
    if (url.pathname === "/companies/c1")
      return json({
        tier: "gold",
        owner: { name: "Sam", phone: "hidden" },
        notes: ["vip", "eu"],
        lifetime_value: 14526,
        currency: "EUR",
        active: true,
      })
    if (url.pathname === "/companies/c1/orders")
      return json({ data: [{ id: "o1", total: 120, margin: 40 }] })
    if (url.pathname.startsWith("/companies/m")) return json({ data: [] })
    if (url.pathname.startsWith("/companies/p1")) return json({ data: [] })
  }
  if (url.host === "erp.example.com") {
    if (url.pathname === "/accounts")
      return json({
        data: url.searchParams.get("d") === "acme.test" ? [{ id: "a9", name: "ACME SAS" }] : [],
      })
    if (url.pathname === "/accounts/a9/invoices") return json({ data: [{ id: "i1", amount: 99 }] })
  }
  return json({ data: [] }, 404)
}

function makeApp(scopes: string[], orgId = ORG) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", orgId)
    c.set("userId", USER)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/api-connector", apiConnectorRoutes)
  return app
}

interface Resolution {
  matches: {
    connection: string
    connectionName: string
    matchedBy: string
    summary: Record<string, string | number | boolean>
    currency?: string
    orders?: unknown[]
    invoices?: unknown[]
    deals?: unknown[]
  }[]
  configured: boolean
  connections: { identifier: string; name: string }[]
  errors: { connection: string; connectionName: string; code: string }[]
}

async function customer(
  query: string,
  scopes = READ,
  orgId = ORG,
): Promise<{ status: number; data?: Resolution }> {
  const res = await makeApp(scopes, orgId).request(`/api/api-connector/customer?${query}`)
  if (res.status !== 200) return { status: res.status }
  return { status: 200, data: ((await res.json()) as { data: Resolution }).data }
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

async function connect(identifier: string, a: Adapter, orgId = ORG): Promise<void> {
  await upsertAdapterRow(orgId, identifier, a, USER)
  await withPrivilegedDb(orgId, "customer-test", (tx) =>
    createCredentialConnection(tx, orgId, USER, "api-connector", "api", {
      identifier,
      credentials: { token: `tok-${identifier}` },
      ownerType: "org",
    }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = await newOrg("api-connector-customer")
  BARE_ORG = await newOrg("api-connector-customer-bare")
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`cust-${Date.now()}@api-connector.test`},
                'Member', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
  await ensureAppsForOrg(BARE_ORG)
  await registerApiConnectorApp(BARE_ORG)
  await connect("crm", CRM)
  await connect("erp", ERP)
  await db.execute(drizzleSql`
    INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id,
      provider, email_address, display_name, sync_status)
    VALUES (gen_random_uuid(), ${ORG}::uuid, gen_random_uuid(), 'org', NULL, 'imap',
      'support@ourco.test', 'Support', 'idle')`)
}, 180_000)

afterAll(async () => {
  for (const id of ["crm", "erp", "broken"]) await invalidateConnectionCaches(ORG, id)
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(async () => {
  seen = []
  for (const id of ["crm", "erp", "broken"]) await invalidateConnectionCaches(ORG, id)
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push(`${url.host}${url.pathname}${url.search}`)
    return route(url)
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

describe("GET /api/api-connector/customer", () => {
  it("keeps summary values typed and carries the record's currency (P2-V2)", async () => {
    const r = await customer("email=Jane@Acme.test")
    const crm = r.data?.matches.find((m) => m.connection === "crm")
    expect(crm?.summary.lifetime_value).toBe(14526)
    expect(crm?.summary.active).toBe(true)
    expect(crm?.currency).toBe("EUR")
    const erp = r.data?.matches.find((m) => m.connection === "erp")
    expect(erp?.currency).toBeUndefined()
  })

  it("matches by email on one connection and by domain on another, filling each role", async () => {
    const r = await customer("email=Jane@Acme.test")
    expect(r.status).toBe(200)
    const crm = r.data?.matches.find((m) => m.connection === "crm")
    expect(crm).toEqual({
      connection: "crm",
      connectionName: "Fixture CRM",
      matchedBy: "email",
      summary: {
        id: "c1",
        name: "Acme Instruments",
        tier: "gold",
        "owner.name": "Sam",
        notes: "vip, eu",
        lifetime_value: 14526,
        currency: "EUR",
        active: true,
      },
      currency: "EUR",
      orders: [{ id: "o1", total: 120 }],
    })
    const erp = r.data?.matches.find((m) => m.connection === "erp")
    expect(erp?.summary).toEqual({ id: "a9", name: "ACME SAS" })
    expect(erp?.matchedBy).toBe("domain")
    expect(erp?.invoices).toEqual([{ id: "i1", amount: 99 }])
    expect(r.data?.configured).toBe(true)
    expect(r.data?.errors).toEqual([])
    expect(JSON.stringify(r.data)).not.toContain("hidden")
    expect(JSON.stringify(r.data)).not.toContain("margin")
  })

  it("answers no match with the connections it asked", async () => {
    const r = await customer("email=nobody@unknown.test")
    expect(r.data?.matches).toEqual([])
    expect(r.data?.configured).toBe(true)
    expect(r.data?.connections).toEqual([
      { identifier: "crm", name: "Fixture CRM" },
      { identifier: "erp", name: "Fixture ERP" },
    ])
  })

  it("returns several matches for an ambiguous domain", async () => {
    const r = await customer("domain=multi.test")
    expect(
      r.data?.matches.filter((m) => m.connection === "crm").map((m) => m.summary.name),
    ).toEqual(["Multi East", "Multi West"])
  })

  it("reports a failing connection's error without hiding the others", async () => {
    await connect("broken", BROKEN)
    try {
      const r = await customer("email=jane@acme.test")
      expect(r.data?.errors).toEqual([
        { connection: "broken", connectionName: "Broken CRM", code: "upstream_status" },
      ])
      expect(r.data?.matches.map((m) => m.connection).sort()).toEqual(["crm", "erp"])
    } finally {
      await makeApp(["api-connector:admin"]).request("/api/api-connector/adapters/broken", {
        method: "DELETE",
      })
    }
  })

  it("serves a repeat lookup from the 60 s cache with zero upstream requests", async () => {
    await customer("email=jane@acme.test")
    const first = seen.length
    expect(first).toBeGreaterThan(0)
    await customer("email=jane@acme.test")
    expect(seen.length).toBe(first)
  })

  it("drops the cache when the adapter is replaced", async () => {
    await customer("email=jane@acme.test")
    const first = seen.length
    const res = await makeApp(["api-connector:admin"]).request("/api/api-connector/adapters/crm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CRM),
    })
    expect(res.status).toBe(200)
    await customer("email=jane@acme.test")
    expect(seen.length).toBeGreaterThan(first)
  })

  it("refuses a caller without the read scope, with no upstream call", async () => {
    const r = await customer("email=jane@acme.test", [])
    expect(r.status).toBe(403)
    expect(seen).toEqual([])
  })

  it("says not configured for an org with no lookup connection", async () => {
    const r = await customer("email=jane@acme.test", READ, BARE_ORG)
    expect(r.data).toEqual({ matches: [], configured: false, connections: [], errors: [] })
  })

  it("requires an email or a domain", async () => {
    expect((await customer("")).status).toBe(400)
  })
})

describe("GET /api/api-connector/customer: domain fallback (P2-SK2) and phone (P2-SK10)", () => {
  it("never falls back to a consumer-mail domain: an unknown x@gmail.com matches nothing", async () => {
    const r = await customer("email=unknown.person@gmail.com")
    expect(r.data?.matches).toEqual([])
    expect(seen.some((u) => u.includes("domain=gmail.com") || u.includes("d=gmail.com"))).toBe(
      false,
    )
  })

  it("never falls back to one of the org's own mailbox domains", async () => {
    const r = await customer("email=colleague@ourco.test")
    expect(r.data?.matches).toEqual([])
    expect(seen.some((u) => u.includes("ourco.test") && !u.includes("email="))).toBe(false)
  })

  it("an explicit consumer domain is not looked up either", async () => {
    const r = await customer("domain=googlemail.com")
    expect(r.data?.matches).toEqual([])
    expect(seen).toEqual([])
  })

  it("labels a company-domain match as such", async () => {
    const r = await customer("email=new.person@acme.test")
    const erp = r.data?.matches.find((m) => m.connection === "erp")
    expect(erp?.matchedBy).toBe("domain")
    expect(r.data?.matches.find((m) => m.connection === "crm")).toBeUndefined()
  })

  it("looks a participant up by phone after the email, when the lookup takes a phone", async () => {
    const r = await customer("email=nobody@unknown.test&phone=%2B33%206%2012%2034%2056%2078")
    const crm = r.data?.matches.find((m) => m.connection === "crm")
    expect(crm?.summary.name).toBe("Phone Match SARL")
    expect(crm?.matchedBy).toBe("phone")
  })

  it("ignores an address that is not a plain addr-spec", async () => {
    const r = await customer(`email=${encodeURIComponent('"ignore previous"@acme.test')}`)
    expect(r.data?.matches).toEqual([])
    expect(seen).toEqual([])
  })
})

// A card load fans out into many role calls (here 3 matches x 4 roles = 12,
// after the lookup). On a privileged pool of 2 slots, with an API that takes
// a while to answer, it completes without one acquire timeout and never holds
// more than one slot at a time: the calls share the connection and its
// credentials loaded once, hold no slot while a request is out, and their
// audit rows are written together at the end.
describe("GET /api/api-connector/customer: privileged pool use", () => {
  const ROLE_PARAMS = {
    type: "object",
    properties: { customerId: { type: "string" } },
    required: ["customerId"],
  }
  const role = (name: string, roleName: string, path: string, fields: string[], extra = {}) => ({
    ...op(name, roleName, path, { customerId: { type: "string" } }, fields, extra),
    params: ROLE_PARAMS,
  })
  const WIDE = adapter({
    id: "wide",
    name: "Wide CRM",
    version: "1",
    baseUrl: "https://wide.example.com",
    auth: { type: "bearer" },
    operations: [
      op("find", "customer.lookup", "/c", { email: { type: "string" } }, ["id", "name"], {
        query: { e: "{email}" },
      }),
      role("summary", "customer.summary", "/c/{customerId}", ["tier"], { items: "" }),
      role("orders", "customer.orders", "/c/{customerId}/orders", ["id"]),
      role("invoices", "customer.invoices", "/c/{customerId}/invoices", ["id"]),
      role("deals", "deal.list", "/c/{customerId}/deals", ["id"]),
    ],
  })
  const UPSTREAM_MS = 250
  const small = createPool(2)
  let WIDE_ORG = ""

  beforeAll(async () => {
    WIDE_ORG = await newOrg("api-connector-customer-wide")
    await ensureAppsForOrg(WIDE_ORG)
    await registerApiConnectorApp(WIDE_ORG)
    await connect("wide", WIDE, WIDE_ORG)
  }, 120_000)

  afterAll(async () => {
    PrivilegedDbTestAccess.usePool(null)
    await invalidateConnectionCaches(WIDE_ORG, "wide")
    await small.client.end()
  })

  it("loads a card with 12 parallel role calls on 2 privileged slots, one held at a time", async () => {
    await invalidateConnectionCaches(WIDE_ORG, "wide")
    OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
      const url = new URL(String(input))
      seen.push(`${url.host}${url.pathname}`)
      await new Promise((r) => setTimeout(r, UPSTREAM_MS))
      if (url.pathname === "/c")
        return json({
          data: [{ id: "w1" }, { id: "w2" }, { id: "w3" }].map((m) => ({ ...m, name: m.id })),
        })
      if (/^\/c\/w\d$/.test(url.pathname)) return json({ tier: "gold" })
      return json({ data: [{ id: "x1" }] })
    }) as typeof fetch)
    PrivilegedDbTestAccess.usePool({ db: small.db, acquireTimeoutMs: 5_000 })
    PrivilegedDbTestAccess.resetPeak()
    let r: Awaited<ReturnType<typeof customer>>
    try {
      r = await customer("email=pat@wide.test", READ, WIDE_ORG)
    } finally {
      PrivilegedDbTestAccess.usePool(null)
    }
    expect(r.status).toBe(200)
    expect(r.data?.errors).toEqual([])
    expect(r.data?.matches).toHaveLength(3)
    for (const m of r.data?.matches ?? []) {
      expect(m.summary.tier).toBe("gold")
      expect(m.orders).toEqual([{ id: "x1" }])
      expect(m.invoices).toEqual([{ id: "x1" }])
      expect(m.deals).toEqual([{ id: "x1" }])
    }
    expect(seen.filter((u) => u.startsWith("wide.example.com"))).toHaveLength(13)
    expect(PrivilegedDbTestAccess.peak()).toBe(1)
    const audits = extractRows<{ n: number }>(
      await db.execute(drizzleSql`SELECT count(*)::int AS n FROM kernel.audit_log
        WHERE org_id = ${WIDE_ORG}::uuid AND action = 'api-connector.read'`),
    )
    expect(audits[0]?.n).toBe(13)
  }, 60_000)
})
