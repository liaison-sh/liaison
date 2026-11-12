// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fixture CRM and its adapter, end to end through the core package: the
// adapter validates, each role operation rendered by `render()` reaches the
// real HTTP server, and `project()` hands back only the allow-listed fields
// (the server deliberately returns internal ones too). Also: cursor
// pagination, API-key auth, the write operation, and deterministic data.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  type Adapter,
  buildRequestUrl,
  nextPageQuery,
  type Operation,
  project,
  ROLE_NAMES,
  render,
} from "@liaison/api-connector-core"
import { loadFixtureCrmAdapter } from "./adapter"
import {
  buildFixtureCrmData,
  FIXTURE_CRM_API_KEY_HEADER,
  FIXTURE_CRM_TEST_REFERENCE_DATE,
} from "./data"
import { type FixtureCrm, startFixtureCrm } from "./server"

const API_KEY = "test-key-7f3a"
/** Fields the server returns that no adapter operation may expose. */
const INTERNAL_KEYS = [
  "internal_notes",
  "credit_check",
  "raw_score",
  "phone_private",
  "cost_price",
  "margin",
  "bank_reference",
  "unit_cost",
]

let crm: FixtureCrm
let adapter: Adapter

beforeAll(() => {
  crm = startFixtureCrm({ apiKey: API_KEY, referenceDate: FIXTURE_CRM_TEST_REFERENCE_DATE })
  adapter = loadFixtureCrmAdapter({ baseUrl: crm.baseUrl })
})
afterAll(async () => {
  await crm.stop()
})

function op(name: string): Operation {
  const found = adapter.operations.find((o) => o.name === name)
  if (!found) throw new Error(`no operation ${name}`)
  return found
}

function roleOp(role: string): Operation {
  const found = adapter.operations.find((o) => o.role === role)
  if (!found) throw new Error(`no operation fills ${role}`)
  return found
}

async function send(
  operation: Operation,
  params: Record<string, unknown>,
  options: { extraQuery?: [string, string][]; apiKey?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const req = render(operation, params)
  const url = buildRequestUrl(adapter, req, options.extraQuery ?? [])
  const headers: Record<string, string> = {}
  const key = options.apiKey === undefined ? API_KEY : options.apiKey
  if (key !== null) headers[FIXTURE_CRM_API_KEY_HEADER] = key
  if (req.body !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(url, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  })
  return { status: res.status, body: await res.json() }
}

/** Every dotted leaf path present in a projected item (arrays walked). */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return [prefix]
    return [...new Set(value.flatMap((v) => leafPaths(v, prefix)))]
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
  }
  return [prefix]
}

async function readRole(role: string, params: Record<string, unknown>) {
  const operation = roleOp(role)
  const { status, body } = await send(operation, params)
  expect(status).toBe(200)
  const projected = project(body, operation)
  for (const item of projected.items) {
    for (const path of leafPaths(item)) expect(operation.fields).toContain(path)
  }
  const text = JSON.stringify(projected.items)
  for (const key of INTERNAL_KEYS) expect(text).not.toContain(`"${key}"`)
  return { raw: body, items: projected.items }
}

describe("fixture CRM adapter", () => {
  it("validates against the core schema", () => {
    expect(loadFixtureCrmAdapter().id).toBe("fixture-crm")
  })

  it("fills every role in the registry, once", () => {
    const roles = adapter.operations.flatMap((o) => (o.role ? [o.role] : []))
    expect([...roles].sort()).toEqual([...ROLE_NAMES].sort())
  })

  it("declares three write operations: a company note, a company, a contact", () => {
    expect(adapter.operations.filter((o) => o.kind === "write").map((o) => o.name)).toEqual([
      "create_note",
      "create_company",
      "create_contact",
    ])
  })

  it("refuses a non-loopback http baseUrl override", () => {
    expect(() => loadFixtureCrmAdapter({ baseUrl: "http://crm.example.com/v1" })).toThrow(/baseUrl/)
  })
})

describe("roles against the fixture server", () => {
  it("customer.lookup by email finds Acme Instruments", async () => {
    const { items } = await readRole("customer.lookup", {
      email: "jane.doe@acme-instruments.example",
    })
    expect(items.map((i) => i.name)).toEqual(["Acme Instruments"])
    expect(items[0]?.id).toBe("cmp_001")
  })

  it("customer.lookup by domain finds Acme Instruments", async () => {
    const { items } = await readRole("customer.lookup", { domain: "acme-instruments.example" })
    expect(items.map((i) => i.id)).toEqual(["cmp_001"])
  })

  it("customer.lookup with an unknown email matches nothing", async () => {
    const { items } = await readRole("customer.lookup", { email: "nobody@unknown.example" })
    expect(items).toEqual([])
  })

  it("customer.summary keeps the allowed fields and drops the internal ones the server sends", async () => {
    const { raw, items } = await readRole("customer.summary", { customerId: "cmp_001" })
    // The server really does send the internal fields: projection is what drops them.
    expect(JSON.stringify(raw)).toContain("internal_notes")
    expect(JSON.stringify(raw)).toContain("phone_private")
    expect(items).toHaveLength(1)
    const summary = items[0]
    expect(summary?.name).toBe("Acme Instruments")
    expect(summary?.account_manager).toEqual({
      name: "Celine Durand",
      email: "celine.durand@fixture-crm.example",
    })
    expect(summary?.lifetime_value).toBeGreaterThan(0)
  })

  it("customer.orders returns the last 30 days' orders with projected lines", async () => {
    const { raw, items } = await readRole("customer.orders", {
      customerId: "cmp_001",
      since: "2026-05-16",
    })
    expect(JSON.stringify(raw)).toContain("cost_price")
    expect(items.map((o) => o.number)).toEqual(["SO-1001", "SO-1002", "SO-1003"])
    expect(items[0]?.lines).toEqual([
      {
        sku: "OSC-200",
        description: "Oscilloscope 200 MHz, 4 channels",
        quantity: 2,
        unit_price: 2450,
      },
      { sku: "PRB-10", description: "Passive probe kit (10x)", quantity: 4, unit_price: 89 },
    ])
  })

  // Walk D61: "our latest customer" had no read that answers it: every order
  // read wanted a customer id, so the agent called them without one until
  // they were locked. The recent orders across every customer name it.
  it("list_recent_orders names the latest customer and what it ordered, with no id asked", async () => {
    const operation = op("list_recent_orders")
    expect(operation.params?.required ?? []).toEqual([])
    const { status, body } = await send(operation, { limit: 3 })
    expect(status).toBe(200)
    const items = project(body, operation).items as Array<Record<string, unknown>>
    expect(items).toHaveLength(3)
    const dates = items.map((o) => String(o.date))
    expect([...dates].sort().reverse()).toEqual(dates)
    const data = buildFixtureCrmData(FIXTURE_CRM_TEST_REFERENCE_DATE)
    const newest = [...data.orders].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!
    const company = data.companies.find((c) => c.id === newest.company_id)!
    expect(items[0]).toMatchObject({
      number: newest.number,
      company_id: company.id,
      company_name: company.name,
    })
    expect(items[0]?.lines).toHaveLength(newest.lines.length)
    const text = JSON.stringify(items)
    for (const key of INTERNAL_KEYS) expect(text).not.toContain(`"${key}"`)
  })

  it("customer.invoices returns the customer's invoices only", async () => {
    const { raw, items } = await readRole("customer.invoices", { customerId: "cmp_001" })
    expect(JSON.stringify(raw)).toContain("bank_reference")
    expect(items.length).toBe(4)
    expect(items.every((i) => typeof i.number === "string" && typeof i.total === "number")).toBe(
      true,
    )
  })

  it("deal.list returns the customer's deals with the owner's name only", async () => {
    const { items } = await readRole("deal.list", { customerId: "cmp_001" })
    expect(items.map((d) => d.id)).toEqual(["dl_001", "dl_002"])
    expect(items[0]?.owner).toEqual({ name: "Celine Durand" })
  })

  it("stock.check by sku returns that product without its unit cost", async () => {
    const { raw, items } = await readRole("stock.check", { sku: "PSU-30" })
    expect(JSON.stringify(raw)).toContain("unit_cost")
    expect(items).toEqual([
      {
        sku: "PSU-30",
        name: "Bench power supply 30 V / 5 A",
        warehouse: "Lyon",
        on_hand: 2,
        reserved: 2,
        available: 0,
        restock_date: "2026-06-24",
      },
    ])
  })

  it("stock.check by free-text query searches product names", async () => {
    const { items } = await readRole("stock.check", { query: "probe" })
    expect(items.map((i) => i.sku)).toEqual(["PRB-10"])
  })
})

describe("cursor pagination", () => {
  it("walks every company page by page and stops on the last page", async () => {
    const operation = op("list_companies")
    const ids: string[] = []
    let extra: [string, string][] = []
    let pages = 0
    for (;;) {
      const { status, body } = await send(operation, { limit: 2 }, { extraQuery: extra })
      expect(status).toBe(200)
      pages += 1
      const projected = project(body, operation)
      ids.push(...projected.items.map((i) => String(i.id)))
      const next = nextPageQuery(operation, body, pages, projected.items.length)
      if (next === null) break
      extra = next
    }
    expect(pages).toBe(3)
    expect(ids).toEqual(["cmp_001", "cmp_002", "cmp_003", "cmp_004", "cmp_005", "cmp_006"])
  })

  it("refuses a forged cursor", async () => {
    const { status } = await send(op("list_companies"), {}, { extraQuery: [["cursor", "bogus"]] })
    expect(status).toBe(400)
  })
})

describe("auth", () => {
  it("answers 401 to a wrong API key without echoing it", async () => {
    const { status, body } = await send(
      roleOp("customer.lookup"),
      { domain: "acme-instruments.example" },
      {
        apiKey: "wrong-key",
      },
    )
    expect(status).toBe(401)
    expect(JSON.stringify(body)).not.toContain("wrong-key")
  })

  it("answers 401 to a request without the API key header", async () => {
    const { status } = await send(roleOp("stock.check"), { sku: "OSC-200" }, { apiKey: null })
    expect(status).toBe(401)
  })
})

describe("write operation", () => {
  it("create_note posts a structured body and the note is recorded", async () => {
    const operation = op("create_note")
    const { status, body } = await send(operation, {
      customerId: "cmp_001",
      text: 'Called about the "lab refresh" quote',
      pinned: true,
    })
    expect(status).toBe(201)
    const projected = project(body, operation)
    expect(projected.items[0]?.body).toBe('Called about the "lab refresh" quote')
    expect(projected.items[0]?.pinned).toBe(true)
    const last = crm.handler.notes.at(-1)
    expect(last?.company_id).toBe("cmp_001")
    expect(last?.pinned).toBe(true)
  })
})

describe("record creation", () => {
  it("create_company posts the company and it is found by its domain afterwards", async () => {
    const operation = op("create_company")
    const { status, body } = await send(operation, {
      name: "Kite Acoustics",
      domain: "kite-acoustics.example",
      country: "PT",
    })
    expect(status).toBe(201)
    const projected = project(body, operation)
    expect(projected.items[0]).toMatchObject({ name: "Kite Acoustics", country: "PT" })
    expect(JSON.stringify(projected.items)).not.toContain("internal_notes")
    const { items } = await readRole("customer.lookup", { domain: "kite-acoustics.example" })
    expect(items.map((c) => c.name)).toEqual(["Kite Acoustics"])
  })

  it("create_company refuses a domain the CRM already has", async () => {
    const { status } = await send(op("create_company"), {
      name: "Acme again",
      domain: "acme-instruments.example",
    })
    expect(status).toBe(409)
  })

  it("create_contact with companyName creates the person and their company in one call", async () => {
    const operation = op("create_contact")
    const { status, body } = await send(operation, {
      email: "ana.reis@reis-studio.example",
      firstName: "Ana",
      lastName: "Reis",
      title: "Founder",
      companyName: "Reis Studio",
      companyDomain: "reis-studio.example",
      companyIndustry: "Mastering studio for independent labels",
    })
    expect(status).toBe(201)
    const created = crm.handler.createdContacts.at(-1)
    const company = crm.handler.createdCompanies.at(-1)
    expect(company?.name).toBe("Reis Studio")
    expect(company?.industry).toBe("Mastering studio for independent labels")
    expect(created?.company_id).toBe(company?.id)
    expect(project(body, operation).items[0]).toMatchObject({
      email: "ana.reis@reis-studio.example",
      company_id: company?.id,
    })
    const { items } = await readRole("customer.lookup", { email: "ana.reis@reis-studio.example" })
    expect(items.map((c) => c.name)).toEqual(["Reis Studio"])
  })

  it("create_contact with customerId joins an existing company and sends no company", async () => {
    const operation = op("create_contact")
    const companiesBefore = crm.handler.createdCompanies.length
    const { status } = await send(operation, {
      email: "paul.martin@acme-instruments.example",
      firstName: "Paul",
      lastName: "Martin",
      customerId: "cmp_001",
    })
    expect(status).toBe(201)
    expect(crm.handler.createdContacts.at(-1)?.company_id).toBe("cmp_001")
    expect(crm.handler.createdCompanies.length).toBe(companiesBefore)
  })

  it("create_contact refuses an email the CRM already has", async () => {
    const { status } = await send(op("create_contact"), {
      email: "jane.doe@acme-instruments.example",
      firstName: "Jane",
      lastName: "Doe",
      customerId: "cmp_001",
    })
    expect(status).toBe(409)
  })
})

describe("data", () => {
  it("is deterministic for a reference date and relative to it", () => {
    const a = buildFixtureCrmData(FIXTURE_CRM_TEST_REFERENCE_DATE)
    const b = buildFixtureCrmData(new Date("2026-06-15T23:59:00Z"))
    expect(a).toEqual(b)
    const later = buildFixtureCrmData(new Date("2026-07-15T12:00:00Z"))
    expect(later.orders[0]?.date).toBe("2026-07-12")
    expect(a.orders[0]?.date).toBe("2026-06-12")
  })

  it("has six companies with Acme Instruments contacts on acme-instruments.example", () => {
    const data = buildFixtureCrmData(FIXTURE_CRM_TEST_REFERENCE_DATE)
    expect(data.companies).toHaveLength(6)
    const acme = data.contacts.filter((c) => c.company_id === "cmp_001")
    expect(acme.length).toBeGreaterThan(1)
    expect(acme.every((c) => c.email.endsWith("@acme-instruments.example"))).toBe(true)
  })

  it("spreads orders over the last 60 days", () => {
    const data = buildFixtureCrmData(FIXTURE_CRM_TEST_REFERENCE_DATE)
    const dates = data.orders.map((o) => o.date).sort()
    expect((dates[0] ?? "") >= "2026-04-16").toBe(true)
    expect((dates.at(-1) ?? "9999") <= "2026-06-15").toBe(true)
  })
})
