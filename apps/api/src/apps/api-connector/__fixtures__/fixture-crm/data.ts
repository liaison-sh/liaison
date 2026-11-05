// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The fixture CRM's data: one fictional sales/ERP dataset (companies,
 * contacts, deals, orders with lines, invoices, stock) shared by the HTTP
 * fixture server, the tests and the demo's in-process transport. Every date
 * is computed from a reference date, so a test that passes a fixed date gets
 * the same records on every run, and the demo (reference = now) always has
 * orders "last month".
 *
 * Some records carry fields an adapter is NOT meant to expose
 * (`internal_notes`, `credit_check.raw_score`, `account_manager.phone_private`,
 * `lines.cost_price`, `margin`, `bank_reference`, `unit_cost`): they exist to
 * prove the connector's field projection.
 */

/** The API key the fixture accepts when none is configured (development only). */
export const FIXTURE_CRM_DEFAULT_API_KEY = "fixture-crm-dev-key"
/** The header the fixture reads the API key from. */
export const FIXTURE_CRM_API_KEY_HEADER = "X-Api-Key"
/** The default port when the server runs as a script. */
export const FIXTURE_CRM_DEFAULT_PORT = 4010
/** A fixed reference date for deterministic tests. */
export const FIXTURE_CRM_TEST_REFERENCE_DATE = new Date("2026-06-15T12:00:00Z")

export type Tier = "gold" | "silver" | "bronze"
export type DealStage = "lead" | "qualified" | "proposal" | "won" | "lost"
export type OrderStatus = "pending" | "shipped" | "delivered" | "cancelled"
export type InvoiceStatus = "paid" | "open" | "overdue"

export interface Company {
  id: string
  name: string
  domain: string
  industry: string
  city: string
  country: string
  tier: Tier
  currency: string
  created_on: string
  account_manager: { name: string; email: string; phone_private: string }
  internal_notes: string
  credit_check: { rating: string; raw_score: number }
}

export interface Contact {
  id: string
  company_id: string
  first_name: string
  last_name: string
  email: string
  phone: string
  title: string
}

export interface Deal {
  id: string
  company_id: string
  title: string
  stage: DealStage
  amount: number
  currency: string
  probability: number
  expected_close: string
  owner: { name: string; email: string }
}

export interface OrderLine {
  sku: string
  description: string
  quantity: number
  unit_price: number
  cost_price: number
}

export interface Order {
  id: string
  number: string
  company_id: string
  date: string
  status: OrderStatus
  currency: string
  total: number
  margin: number
  lines: OrderLine[]
}

export interface Invoice {
  id: string
  number: string
  company_id: string
  order_id: string
  issued_on: string
  due_on: string
  status: InvoiceStatus
  total: number
  currency: string
  bank_reference: string
}

export interface StockItem {
  sku: string
  name: string
  warehouse: string
  on_hand: number
  reserved: number
  available: number
  restock_date: string | null
  unit_cost: number
}

export interface Note {
  id: string
  company_id: string
  body: string
  pinned: boolean
  created_at: string
}

export interface FixtureCrmData {
  referenceDate: string
  companies: Company[]
  contacts: Contact[]
  deals: Deal[]
  orders: Order[]
  invoices: Invoice[]
  stock: StockItem[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function isoDate(reference: Date, daysOffset: number): string {
  return new Date(reference.getTime() + daysOffset * DAY_MS).toISOString().slice(0, 10)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface CatalogEntry {
  name: string
  price: number
  cost: number
}

const CATALOG: Record<string, CatalogEntry> = {
  "OSC-200": { name: "Oscilloscope 200 MHz, 4 channels", price: 2450, cost: 1380 },
  "PRB-10": { name: "Passive probe kit (10x)", price: 89, cost: 31 },
  "PSU-30": { name: "Bench power supply 30 V / 5 A", price: 540, cost: 290 },
  "DMM-5": { name: "Handheld multimeter, 5 digits", price: 310, cost: 150 },
  "LOG-16": { name: "Logic analyser, 16 channels", price: 1190, cost: 640 },
  "CAL-SVC": { name: "Annual calibration service", price: 380, cost: 120 },
}

const COMPANY_ROWS: Omit<Company, "created_on">[] = [
  {
    id: "cmp_001",
    name: "Acme Instruments",
    domain: "acme-instruments.example",
    industry: "Test and measurement",
    city: "Lyon",
    country: "FR",
    tier: "gold",
    currency: "EUR",
    account_manager: {
      name: "Celine Durand",
      email: "celine.durand@fixture-crm.example",
      phone_private: "+33 6 00 00 01 01",
    },
    internal_notes: "Negotiating a volume discount for Q3; do not disclose the floor price.",
    credit_check: { rating: "A", raw_score: 812 },
  },
  {
    id: "cmp_002",
    name: "Northwind Audio",
    domain: "northwind-audio.example",
    industry: "Pro audio",
    city: "Rotterdam",
    country: "NL",
    tier: "silver",
    currency: "EUR",
    account_manager: {
      name: "Celine Durand",
      email: "celine.durand@fixture-crm.example",
      phone_private: "+33 6 00 00 01 01",
    },
    internal_notes: "Late payer twice last year.",
    credit_check: { rating: "B", raw_score: 640 },
  },
  {
    id: "cmp_003",
    name: "Bluefin Robotics",
    domain: "bluefin-robotics.example",
    industry: "Industrial robotics",
    city: "Boston",
    country: "US",
    tier: "gold",
    currency: "USD",
    account_manager: {
      name: "Sam Okafor",
      email: "sam.okafor@fixture-crm.example",
      phone_private: "+1 555 0100 202",
    },
    internal_notes: "Evaluating a competitor's logic analysers.",
    credit_check: { rating: "A", raw_score: 790 },
  },
  {
    id: "cmp_004",
    name: "Halden Studio",
    domain: "halden-studio.example",
    industry: "Lighting design",
    city: "Montreal",
    country: "CA",
    tier: "bronze",
    currency: "USD",
    account_manager: {
      name: "Sam Okafor",
      email: "sam.okafor@fixture-crm.example",
      phone_private: "+1 555 0100 202",
    },
    internal_notes: "Small account, prefers email.",
    credit_check: { rating: "C", raw_score: 560 },
  },
  {
    id: "cmp_005",
    name: "Harbor and Pine Furniture",
    domain: "harbor-pine.example",
    industry: "Furniture manufacturing",
    city: "Bristol",
    country: "GB",
    tier: "silver",
    currency: "GBP",
    account_manager: {
      name: "Priya Raman",
      email: "priya.raman@fixture-crm.example",
      phone_private: "+44 7700 900123",
    },
    internal_notes: "Asked for a payment plan in March.",
    credit_check: { rating: "B", raw_score: 610 },
  },
  {
    id: "cmp_006",
    name: "Kestrel Labs",
    domain: "kestrel-labs.example",
    industry: "University research lab",
    city: "Berlin",
    country: "DE",
    tier: "bronze",
    currency: "EUR",
    account_manager: {
      name: "Priya Raman",
      email: "priya.raman@fixture-crm.example",
      phone_private: "+44 7700 900123",
    },
    internal_notes: "Grant-funded; purchases cluster at the end of the quarter.",
    credit_check: { rating: "A", raw_score: 735 },
  },
]

const CONTACTS: Contact[] = [
  ["ct_001", "cmp_001", "Jane", "Doe", "jane.doe@acme-instruments.example", "Purchasing manager"],
  ["ct_002", "cmp_001", "Marc", "Petit", "marc.petit@acme-instruments.example", "CTO"],
  ["ct_003", "cmp_001", "Ines", "Moreau", "ines.moreau@acme-instruments.example", "Lab lead"],
  ["ct_004", "cmp_002", "Pieter", "Visser", "pieter@northwind-audio.example", "Owner"],
  ["ct_005", "cmp_003", "Dana", "Reyes", "dana.reyes@bluefin-robotics.example", "Buyer"],
  ["ct_006", "cmp_003", "Lee", "Chen", "lee.chen@bluefin-robotics.example", "Test engineer"],
  ["ct_007", "cmp_004", "Noemie", "Gagnon", "noemie@halden-studio.example", "Studio manager"],
  ["ct_008", "cmp_005", "Tom", "Ashby", "tom.ashby@harbor-pine.example", "Operations"],
  ["ct_009", "cmp_006", "Lena", "Vogel", "l.vogel@kestrel-labs.example", "Research engineer"],
].map(([id, company_id, first_name, last_name, email, title], i) => ({
  id: id as string,
  company_id: company_id as string,
  first_name: first_name as string,
  last_name: last_name as string,
  email: email as string,
  title: title as string,
  phone: `+1 555 0199 ${String(100 + i).padStart(3, "0")}`,
}))

/** [id, company, daysAgo, status, lines: [sku, qty][]] */
const ORDER_ROWS: [string, string, number, OrderStatus, [string, number][]][] = [
  [
    "ord_001",
    "cmp_001",
    3,
    "pending",
    [
      ["OSC-200", 2],
      ["PRB-10", 4],
    ],
  ],
  ["ord_002", "cmp_001", 12, "shipped", [["CAL-SVC", 6]]],
  [
    "ord_003",
    "cmp_001",
    27,
    "delivered",
    [
      ["PSU-30", 5],
      ["DMM-5", 10],
    ],
  ],
  ["ord_004", "cmp_001", 41, "delivered", [["LOG-16", 1]]],
  ["ord_005", "cmp_001", 58, "cancelled", [["OSC-200", 1]]],
  ["ord_006", "cmp_002", 9, "shipped", [["DMM-5", 3]]],
  ["ord_007", "cmp_002", 35, "delivered", [["PSU-30", 2]]],
  [
    "ord_008",
    "cmp_003",
    5,
    "pending",
    [
      ["LOG-16", 4],
      ["PRB-10", 8],
    ],
  ],
  ["ord_009", "cmp_003", 44, "delivered", [["OSC-200", 3]]],
  ["ord_010", "cmp_004", 20, "delivered", [["DMM-5", 1]]],
  ["ord_011", "cmp_005", 16, "shipped", [["PSU-30", 1]]],
  ["ord_012", "cmp_006", 52, "delivered", [["OSC-200", 1]]],
]

/** [id, company, title, stage, amount, probability, closeInDays] */
const DEAL_ROWS: [string, string, string, DealStage, number, number, number][] = [
  ["dl_001", "cmp_001", "Lab refresh: 12 oscilloscopes", "proposal", 29400, 60, 21],
  ["dl_002", "cmp_001", "Calibration contract renewal", "won", 4560, 100, -10],
  ["dl_003", "cmp_002", "Studio test bench", "qualified", 3200, 40, 30],
  ["dl_004", "cmp_003", "Production line analysers", "proposal", 11900, 50, 14],
  ["dl_005", "cmp_004", "Multimeter replacement", "lead", 1240, 20, 45],
  ["dl_006", "cmp_005", "Workshop power supplies", "lost", 2160, 0, -20],
  ["dl_007", "cmp_006", "Grant purchase, autumn", "qualified", 6100, 35, 60],
]

/** [sku, warehouse, onHand, reserved, restockInDays | null] */
const STOCK_ROWS: [string, string, number, number, number | null][] = [
  ["OSC-200", "Lyon", 14, 3, null],
  ["PRB-10", "Lyon", 220, 12, null],
  ["PSU-30", "Lyon", 2, 2, 9],
  ["DMM-5", "Rotterdam", 65, 10, null],
  ["LOG-16", "Rotterdam", 0, 0, 18],
  ["CAL-SVC", "Lyon", 999, 6, null],
]

function catalogEntry(sku: string): CatalogEntry {
  const entry = CATALOG[sku]
  if (!entry) throw new Error(`fixture-crm: unknown sku ${sku}`)
  return entry
}

/** Build the whole dataset for a reference date (deterministic per date). */
export function buildFixtureCrmData(referenceDate: Date = new Date()): FixtureCrmData {
  const ref = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    ),
  )
  const companies: Company[] = COMPANY_ROWS.map((c, i) => ({
    ...c,
    account_manager: { ...c.account_manager },
    credit_check: { ...c.credit_check },
    created_on: isoDate(ref, -900 + i * 75),
  }))
  const currencyOf = (companyId: string): string =>
    companies.find((c) => c.id === companyId)?.currency ?? "EUR"

  const orders: Order[] = ORDER_ROWS.map(([id, companyId, daysAgo, status, lines], i) => {
    const orderLines: OrderLine[] = lines.map(([sku, quantity]) => {
      const entry = catalogEntry(sku)
      return {
        sku,
        description: entry.name,
        quantity,
        unit_price: entry.price,
        cost_price: entry.cost,
      }
    })
    const total = round2(orderLines.reduce((s, l) => s + l.quantity * l.unit_price, 0))
    const cost = round2(orderLines.reduce((s, l) => s + l.quantity * l.cost_price, 0))
    return {
      id,
      number: `SO-${1001 + i}`,
      company_id: companyId,
      date: isoDate(ref, -daysAgo),
      status,
      currency: currencyOf(companyId),
      total,
      margin: round2(total - cost),
      lines: orderLines,
    }
  })

  const invoices: Invoice[] = orders
    .filter((o) => o.status !== "cancelled")
    .map((o, i) => {
      const daysAgo = Math.round((ref.getTime() - Date.parse(`${o.date}T00:00:00Z`)) / DAY_MS)
      const dueInDays = 30 - daysAgo
      const status: InvoiceStatus =
        o.status === "delivered" ? (dueInDays < 0 && i % 3 === 0 ? "overdue" : "paid") : "open"
      return {
        id: `inv_${String(i + 1).padStart(3, "0")}`,
        number: `INV-${2001 + i}`,
        company_id: o.company_id,
        order_id: o.id,
        issued_on: o.date,
        due_on: isoDate(ref, dueInDays),
        status,
        total: o.total,
        currency: o.currency,
        bank_reference: `FIXTURE-REF-${7000 + i}`,
      }
    })

  const ownerA = { name: "Celine Durand", email: "celine.durand@fixture-crm.example" }
  const ownerB = { name: "Sam Okafor", email: "sam.okafor@fixture-crm.example" }
  const deals: Deal[] = DEAL_ROWS.map(
    ([id, companyId, title, stage, amount, probability, closeInDays], i) => ({
      id,
      company_id: companyId,
      title,
      stage,
      amount,
      currency: currencyOf(companyId),
      probability,
      expected_close: isoDate(ref, closeInDays),
      owner: { ...(i % 2 === 0 ? ownerA : ownerB) },
    }),
  )

  const stock: StockItem[] = STOCK_ROWS.map(([sku, warehouse, onHand, reserved, restock]) => {
    const entry = catalogEntry(sku)
    return {
      sku,
      name: entry.name,
      warehouse,
      on_hand: onHand,
      reserved,
      available: onHand - reserved,
      restock_date: restock === null ? null : isoDate(ref, restock),
      unit_cost: entry.cost,
    }
  })

  return {
    referenceDate: ref.toISOString().slice(0, 10),
    companies,
    contacts: CONTACTS.map((c) => ({ ...c })),
    deals,
    orders,
    invoices,
    stock,
  }
}

/** The summary record the `/companies/{id}` endpoint returns (computed fields included). */
export interface CompanySummary extends Company {
  contacts_count: number
  open_deals: number
  lifetime_value: number
  open_balance: number
  last_order_date: string | null
}

export function companySummary(data: FixtureCrmData, companyId: string): CompanySummary | null {
  const company = data.companies.find((c) => c.id === companyId)
  if (!company) return null
  const orders = data.orders.filter((o) => o.company_id === companyId && o.status !== "cancelled")
  const invoices = data.invoices.filter((i) => i.company_id === companyId)
  const lastOrder =
    orders
      .map((o) => o.date)
      .sort()
      .at(-1) ?? null
  return {
    ...company,
    contacts_count: data.contacts.filter((c) => c.company_id === companyId).length,
    open_deals: data.deals.filter(
      (d) => d.company_id === companyId && d.stage !== "won" && d.stage !== "lost",
    ).length,
    lifetime_value: round2(orders.reduce((s, o) => s + o.total, 0)),
    open_balance: round2(
      invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + i.total, 0),
    ),
    last_order_date: lastOrder,
  }
}
