// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The buyer invoices API end to end on the real routes and database: a key created by an admin,
// the matching rule against recorded and earlier Shopify sales (a forged id next to the right
// email gets nothing), the other issuer profile and the other org out of reach, the 5-minute link
// and its PDF, expiry, and a revocation that kills the key and its live links.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { ObjectStreamResult } from "~/infra/storage/object-storage"
import { registerApps } from "~/modules/apps/runtime"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"
import invoicingManifest from "../../../../../bundled-apps/invoicing/app.manifest.json"
import { buyerFileStorage } from "./file"

let w: DoorWorld
let adminBearer = ""
let memberBearer = ""
let profileA = ""
let profileB = ""
let otherProfile = ""
let key = ""
let keyId = ""
let otherKey = ""
const ids: Record<string, string> = {}
/** A real list and link response, for the website's contract replay (BUYER_INVOICES_SAMPLE_OUT). */
const sample: { list?: unknown; link?: unknown } = {}

const INVOICING = invoicingManifest as unknown as Record<string, unknown>

/** The invoicing tables (schema only, no org rows), as an installed app has them. */
async function registerInvoicingSchema(orgId: string): Promise<void> {
  const desc = {
    ...INVOICING,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../bundled-apps/.source/invoicing/${String(INVOICING.version)}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
  const { failedApps } = await registerApps([desc], orgId, { skipOrgRows: true })
  if (failedApps.length > 0) throw new Error(`invoicing did not register: ${failedApps.join(", ")}`)
}

const K = (t: string) => `"${schemaRef("kernel")}".${t}`

async function insert(table: string, row: Record<string, RowValue>) {
  await sql.unsafe(insertSql(table, row))
}

async function issuer(orgId: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  await insert("app_invoicing.issuer_profiles", {
    id,
    org_id: orgId,
    legal_name: name,
    country: "FR",
    default_currency: "EUR",
  })
  return id
}

async function file(orgId: string): Promise<string> {
  const id = crypto.randomUUID()
  await insert("kernel.files", {
    id,
    org_id: orgId,
    app: "invoicing",
    entity_type: "document",
    entity_id: id,
    filename: "render.pdf",
    mime_type: "application/pdf",
    size_bytes: 9,
    storage_key: `${orgId}/buyer-invoices/${id}`,
    enc_version: 0,
  })
  return id
}

async function doc(
  orgId: string,
  profile: string,
  values: Record<string, RowValue> & { number: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await insert("app_invoicing.documents", {
    id,
    org_id: orgId,
    issuer_profile_id: profile,
    type: "invoice",
    status: "issued",
    payment_status: "paid",
    currency: "EUR",
    grand_total_minor: 12000,
    issued_at: "2026-11-20",
    pdf_file_id: await file(orgId),
    ...values,
  })
  return id
}

async function sale(
  orgId: string,
  profile: string,
  values: Record<string, RowValue> & { external_id: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await insert("app_invoicing.sales", {
    id,
    org_id: orgId,
    issuer_profile_id: profile,
    stream: "hub",
    source_ref: values.external_id,
    sold_on: "2026-11-18",
    state: "issued",
    ...values,
  })
  return id
}

/** An open invoicing park of a paid Shopify order (the order payload invoicing stores). */
async function parkOrder(
  orgId: string,
  orderId: string,
  values: {
    shop?: string
    email?: string | null
    customerId?: string | null
    total?: string
    status?: string
    number?: string
  },
): Promise<void> {
  await insert("app_invoicing.deferred_events", {
    id: crypto.randomUUID(),
    org_id: orgId,
    event_id: orderId,
    status: values.status ?? "awaiting_data",
    reason: "einvoice_data_missing",
    blocked_on: JSON.stringify({ kind: "einvoice_identity", contact_id: crypto.randomUUID() }),
    retry_count: 0,
    event_payload_json: JSON.stringify({
      id: orderId,
      order_number: values.number ?? null,
      shop_id: values.shop ?? "atelier-a.example",
      createdAt: "2026-11-26T08:00:00Z",
      total_price_minor: values.total ?? "45000",
      currency: "eur",
      customer: {
        id: values.customerId ? `gid://shopify/Customer/${values.customerId}` : null,
        email: values.email ?? null,
        contact_id: null,
      },
    }),
  })
}

function call(path: string, body: unknown, bearer = key) {
  return app.request(`/api/buyer-invoices${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function listOf(buyer: Record<string, unknown>, bearer = key) {
  const res = await call("/list", { buyer }, bearer)
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("no-store")
  const json = (await res.json()) as { documents: Array<Record<string, unknown>> }
  return json.documents
}

const numbers = (docs: Array<Record<string, unknown>>) =>
  docs.map((d) => (d.number as string | null) ?? "").sort()

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await registerInvoicingSchema(w.orgId)
  adminBearer = await minimal.token(w.admin.userId)
  memberBearer = await minimal.token(w.member.userId)
  profileA = await issuer(w.orgId, "Atelier A")
  profileB = await issuer(w.orgId, "Atelier B")
  otherProfile = await issuer(w.otherOrgId, "Other org")

  // A Hub sale with a strong id, its invoice and a credit note against it.
  const hub = await sale(w.orgId, profileA, {
    external_id: "pi_hub_1",
    buyer_email: "ana@example.com",
    hub_user_id: "6f1c2a9e-0000-4000-8000-000000000001",
  })
  ids.hubInvoice = await doc(w.orgId, profileA, { number: "INV-2026-0101", sale_id: hub })
  ids.hubCredit = await doc(w.orgId, profileA, {
    number: "CN-2026-0007",
    type: "credit_note",
    status: "refunded",
    grand_total_minor: 2000,
    original_document_id: ids.hubInvoice,
  })
  // A pending Hub sale, not invoiced yet.
  await sale(w.orgId, profileA, {
    external_id: "pi_hub_2",
    buyer_email: "ana@example.com",
    hub_user_id: "6f1c2a9e-0000-4000-8000-000000000001",
    state: "pending",
    sold_on: "2026-11-21",
    total_minor: 1999,
    currency: "usd",
  })
  // A guest sale: email only.
  const guest = await sale(w.orgId, profileA, {
    external_id: "pi_guest",
    buyer_email: "ana@example.com",
  })
  ids.guestInvoice = await doc(w.orgId, profileA, { number: "INV-2026-0102", sale_id: guest })
  // An earlier Shopify invoice (no sale row): its contact carries the Shopify customer id.
  ids.shopifyInvoice = await doc(w.orgId, profileA, {
    number: "INV-2026-0099",
    shopify_order_id: "13479198425419",
    shopify_order_number: "#3655",
    counterparty_email: " Ana@Example.com ",
    counterparty_contact_id: w.clientA.contactId,
  })
  await sql.unsafe(
    `UPDATE ${K("contacts")} SET external_ids = '{"shopify":"8123456789012"}'::jsonb WHERE id = '${w.clientA.contactId}'`,
  )
  // An earlier Shopify order invoiced twice: one invoice to a contact with a customer id, a
  // reissue (same email) to a contact without one. One identity covers both.
  ids.splitA = await doc(w.orgId, profileA, {
    number: "INV-2026-0090",
    shopify_order_id: "13479198420000",
    counterparty_email: "cy@example.com",
    counterparty_contact_id: w.clientB.contactId,
  })
  ids.splitB = await doc(w.orgId, profileA, {
    number: "INV-2026-0091",
    shopify_order_id: "13479198420000",
    counterparty_email: "cy@example.com",
    counterparty_contact_id: w.clientC.contactId,
  })
  await sql.unsafe(
    `UPDATE ${K("contacts")} SET external_ids = '{"shopify":"111"}'::jsonb WHERE id = '${w.clientB.contactId}'`,
  )
  // Another buyer's invoice in the same profile, and the same email in profile B and another org.
  const bob = await sale(w.orgId, profileA, {
    external_id: "pi_bob",
    buyer_email: "bob@example.com",
  })
  ids.bobInvoice = await doc(w.orgId, profileA, { number: "INV-2026-0103", sale_id: bob })
  const inB = await sale(w.orgId, profileB, { external_id: "pi_b", buyer_email: "ana@example.com" })
  ids.profileBInvoice = await doc(w.orgId, profileB, { number: "B-2026-0001", sale_id: inB })
  const other = await sale(w.otherOrgId, otherProfile, {
    external_id: "pi_other",
    buyer_email: "ana@example.com",
  })
  ids.otherOrgInvoice = await doc(w.otherOrgId, otherProfile, { number: "O-1", sale_id: other })

  // A Stripe stream sale bound under profile A, whose website names the stream "hub". Recorded
  // the way older sales were: its source_ref is the Checkout Session, its external id the
  // PaymentIntent. The same provider's sale under profile B has no key of its own.
  await insert("app_invoicing.revenue_streams", {
    id: crypto.randomUUID(),
    org_id: w.orgId,
    provider_app: "stripe",
    issuer_profile_id: profileA,
    mode: "auto",
    mail: "none",
    buyer_source_key: "hub",
  })
  const stripeSale = await sale(w.orgId, profileA, {
    stream: "stripe",
    external_id: "pi_stripe_1",
    source_ref: "cs_live_stripe_1",
    buyer_email: "fio@example.com",
    hub_user_id: "6f1c2a9e-0000-4000-8000-000000000002",
  })
  ids.stripeInvoice = await doc(w.orgId, profileA, {
    number: "INV-2026-0110",
    sale_id: stripeSale,
    external_ref: "stripe:pi_stripe_1:software",
  })
  await sale(w.orgId, profileA, {
    stream: "stripe",
    external_id: "pi_stripe_2",
    source_ref: "cs_live_stripe_2",
    buyer_email: "fio@example.com",
    hub_user_id: "6f1c2a9e-0000-4000-8000-000000000002",
    state: "pending",
    total_minor: 4900,
    currency: "eur",
  })
  const stripeB = await sale(w.orgId, profileB, {
    stream: "stripe",
    external_id: "pi_stripe_b",
    source_ref: "cs_live_stripe_b",
    buyer_email: "fio@example.com",
  })
  await doc(w.orgId, profileB, { number: "B-2026-0010", sale_id: stripeB })

  // Paid Shopify orders whose invoice is parked: profile A is the shop's issuer.
  await sql.unsafe(
    `UPDATE app_invoicing.issuer_profiles SET shopify_shop_id = 'atelier-a.example' WHERE id = '${profileA}'`,
  )
  await sql.unsafe(
    `UPDATE app_invoicing.issuer_profiles SET shopify_shop_id = 'atelier-b.example' WHERE id = '${profileB}'`,
  )
  await parkOrder(w.orgId, "6100000000001", {
    email: "dee@example.com",
    customerId: "777",
    number: "#4100",
  })
  // Another buyer's parked order, a resolved park, a zero total, another shop's park.
  await parkOrder(w.orgId, "6100000000002", { email: "eve@example.com", customerId: "888" })
  await parkOrder(w.orgId, "6100000000003", {
    email: "dee@example.com",
    customerId: "777",
    status: "resolved",
  })
  await parkOrder(w.orgId, "6100000000004", {
    email: "dee@example.com",
    customerId: "777",
    total: "0",
  })
  await parkOrder(w.orgId, "6100000000005", {
    email: "dee@example.com",
    customerId: "777",
    shop: "atelier-b.example",
  })
  // A guest checkout parked: email only.
  await parkOrder(w.orgId, "6100000000006", { email: "gus@example.com", number: "#4106" })

  const created = await app.request("/api/invoicing/buyer-keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminBearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ issuerProfileId: profileA, label: "Website" }),
  })
  expect(created.status).toBe(201)
  const body = (await created.json()) as { data: { id: string; key: string } }
  key = body.data.key
  keyId = body.data.id
  const otherCreated = await app.request("/api/invoicing/buyer-keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminBearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ issuerProfileId: profileB, label: "Website B" }),
  })
  otherKey = ((await otherCreated.json()) as { data: { key: string } }).data.key
})

afterAll(async () => {
  const out = process.env.BUYER_INVOICES_SAMPLE_OUT
  if (out && sample.list && sample.link) {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          note: "Recorded from the Liaison buyer invoices API integration test (fixture data). Request buyer: {email: <redacted>, shopifyCustomerId: null, hubUserId: '6f1c2a9e-0000-4000-8000-000000000001'}.",
          list: {
            request: {
              buyer: {
                email: "REDACTED",
                shopifyCustomerId: null,
                hubUserId: "6f1c2a9e-0000-4000-8000-000000000001",
              },
            },
            response: sample.list,
          },
          link: {
            request: {
              buyer: { email: "REDACTED", hubUserId: "6f1c2a9e-0000-4000-8000-000000000001" },
              documentId: ids.hubInvoice,
            },
            response: sample.link,
          },
        },
        null,
        2,
      )}\n`,
    )
  }
  for (const org of [w.orgId, w.otherOrgId]) {
    for (const t of [
      "app_invoicing.documents",
      "app_invoicing.sales",
      "app_invoicing.deferred_events",
      "app_invoicing.revenue_streams",
      "app_invoicing.issuer_profiles",
    ]) {
      await sql.unsafe(`DELETE FROM ${t} WHERE org_id = '${org}'`)
    }
    await sql.unsafe(`DELETE FROM ${K("files")} WHERE org_id = '${org}'`)
    await sql.unsafe(`DELETE FROM ${K("buyer_invoice_keys")} WHERE org_id = '${org}'`)
  }
  await dropDoorWorld(w)
  await releaseTestLock()
})

describe("website access keys", () => {
  it("are linv_ keys, stored as a hash and a prefix only", async () => {
    expect(key).toMatch(/^linv_[A-Z2-7]{32}$/)
    const rows = await sql.unsafe(
      `SELECT key_prefix, key_hash FROM ${K("buyer_invoice_keys")} WHERE id = '${keyId}'`,
    )
    expect(rows[0]?.key_prefix).toBe(key.slice(0, 8))
    expect(JSON.stringify(rows)).not.toContain(key)
  })

  it("need the issuer admin scope and an unrestricted session", async () => {
    const res = await app.request("/api/invoicing/buyer-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${memberBearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issuerProfileId: profileA, label: "Mine" }),
    })
    expect(res.status).toBe(403)
  })

  it("are at most two active per issuer profile", async () => {
    const second = await app.request("/api/invoicing/buyer-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issuerProfileId: profileA, label: "Rotation" }),
    })
    expect(second.status).toBe(201)
    const third = await app.request("/api/invoicing/buyer-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issuerProfileId: profileA, label: "Too many" }),
    })
    expect(third.status).toBe(409)
    const rotation = ((await second.json()) as { data: { id: string } }).data.id
    const revoked = await app.request(`/api/invoicing/buyer-keys/${rotation}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
    expect(revoked.status).toBe(200)
  })
})

describe("POST /api/buyer-invoices/list", () => {
  it("refuses a missing, malformed or unknown key with one answer", async () => {
    for (const bearer of ["", "nope", `linv_${"A".repeat(32)}`]) {
      const res = await call("/list", { buyer: { email: "ana@example.com" } }, bearer)
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_KEY")
    }
  })

  it("refuses a body with an unknown field, no identity, a gid or bad JSON", async () => {
    for (const body of [
      { buyer: { email: "ana@example.com" }, extra: 1 },
      { buyer: { email: null, shopifyCustomerId: null, hubUserId: null } },
      { buyer: { shopifyCustomerId: "gid://shopify/Customer/1" } },
      "{not json",
    ]) {
      const res = await call("/list", body)
      expect(res.status).toBe(400)
    }
  })

  it("the strong id reaches the Hub sale, its credit note and the pending sale", async () => {
    const docs = await listOf({
      email: "ana@example.com",
      shopifyCustomerId: null,
      hubUserId: "6f1c2a9e-0000-4000-8000-000000000001",
    })
    expect(numbers(docs)).toEqual(["", "CN-2026-0007", "INV-2026-0101", "INV-2026-0102"])
    sample.list = { documents: docs, nextCursor: null }
    const credit = docs.find((d) => d.number === "CN-2026-0007")
    expect(credit).toMatchObject({
      kind: "credit_note",
      parentInvoiceId: ids.hubInvoice,
      totalMinor: 2000,
      status: "refunded",
    })
    expect(docs.find((d) => d.number === "INV-2026-0101")?.status).toBe("partially_credited")
    const pending = docs.find((d) => d.state === "pending")
    expect(pending).toMatchObject({
      id: null,
      issuedAt: null,
      saleDate: "2026-11-21",
      totalMinor: 1999,
      currency: "USD",
      status: "pending",
      source: { stream: "hub", ref: "pi_hub_2", name: null },
    })
    // Newest sale date first.
    expect(docs[0]?.state).toBe("pending")
  })

  it("a Stripe stream sale lists under its stream's buyer source key and its PaymentIntent", async () => {
    const docs = await listOf({
      email: "fio@example.com",
      hubUserId: "6f1c2a9e-0000-4000-8000-000000000002",
    })
    expect(docs.map((d) => [d.state, d.number, d.source])).toEqual([
      ["pending", null, { stream: "hub", ref: "pi_stripe_2", name: null }],
      ["issued", "INV-2026-0110", { stream: "hub", ref: "pi_stripe_1", name: null }],
    ])
    expect(JSON.stringify(docs)).not.toContain("cs_live")
    // The matching rule still holds: the email alone does not reach a sale with a strong id,
    // nor does a forged id next to it.
    expect(await listOf({ email: "fio@example.com" })).toEqual([])
    expect(
      await listOf({ email: "fio@example.com", hubUserId: "6f1c2a9e-0000-4000-8000-0000000000ff" }),
    ).toEqual([])
    // The same provider under another issuer profile, with no key of its own: the provider name.
    const inB = await listOf({ email: "fio@example.com" }, otherKey)
    expect(inB.map((d) => d.source)).toEqual([{ stream: "stripe", ref: "pi_stripe_b", name: null }])
  })

  it("an email alone reaches only sales with no strong id", async () => {
    expect(numbers(await listOf({ email: "ANA@example.com " }))).toEqual(["INV-2026-0102"])
  })

  it("a forged id next to the right email gets nothing of the sale it forges", async () => {
    const docs = await listOf({
      email: "ana@example.com",
      shopifyCustomerId: "999",
      hubUserId: "6f1c2a9e-0000-4000-8000-0000000000ff",
    })
    expect(numbers(docs)).toEqual(["INV-2026-0102"])
  })

  it("an earlier Shopify invoice is reached by its contact's customer id, never by email alone", async () => {
    const docs = await listOf({ email: "ana@example.com", shopifyCustomerId: "8123456789012" })
    expect(numbers(docs)).toEqual(["INV-2026-0099", "INV-2026-0102"])
    expect(docs.find((d) => d.number === "INV-2026-0099")?.source).toEqual({
      stream: "shopify",
      ref: "13479198425419",
      name: "#3655",
    })
  })

  it("an earlier order's invoices share one identity: a reissue without the id unlocks nothing", async () => {
    expect(await listOf({ email: "cy@example.com" })).toEqual([])
    expect(await listOf({ email: "cy@example.com", shopifyCustomerId: "999" })).toEqual([])
    expect(numbers(await listOf({ email: "cy@example.com", shopifyCustomerId: "111" }))).toEqual([
      "INV-2026-0090",
      "INV-2026-0091",
    ])
  })

  it("another issuer profile's documents and another org's are out of reach", async () => {
    const all = JSON.stringify(
      await listOf({ email: "ana@example.com", hubUserId: "6f1c2a9e-0000-4000-8000-000000000001" }),
    )
    expect(all).not.toContain("B-2026-0001")
    expect(all).not.toContain("O-1")
    expect(numbers(await listOf({ email: "ana@example.com" }, otherKey))).toEqual(["B-2026-0001"])
  })

  it("a paid order whose invoice is parked shows as pending, and says nothing of the park", async () => {
    const docs = await listOf({ email: "dee@example.com", shopifyCustomerId: "777" })
    expect(docs).toEqual([
      {
        id: null,
        kind: "invoice",
        number: null,
        issuedAt: null,
        saleDate: "2026-11-26",
        totalMinor: 45000,
        currency: "EUR",
        status: "pending",
        parentInvoiceId: null,
        state: "pending",
        source: { stream: "shopify", ref: "6100000000001", name: "#4100" },
      },
    ])
    const raw = JSON.stringify(docs)
    for (const leak of ["einvoice", "awaiting", "blocked", "reason", "contact"]) {
      expect(raw).not.toContain(leak)
    }
    // The other shop's issuer profile sees its own park only.
    const inB = await listOf({ email: "dee@example.com", shopifyCustomerId: "777" }, otherKey)
    expect(inB.map((d) => d.source)).toEqual([
      { stream: "shopify", ref: "6100000000005", name: null },
    ])
  })

  it("a parked order follows the matching rule: never another buyer's, never by email alone", async () => {
    expect(await listOf({ email: "dee@example.com" })).toEqual([])
    expect(await listOf({ email: "dee@example.com", shopifyCustomerId: "999" })).toEqual([])
    const eve = JSON.stringify(await listOf({ email: "eve@example.com", shopifyCustomerId: "888" }))
    expect(eve).toContain("6100000000002")
    expect(eve).not.toContain("6100000000001")
    const gus = await listOf({ email: " GUS@example.com" })
    expect(gus.map((d) => d.source)).toEqual([
      { stream: "shopify", ref: "6100000000006", name: "#4106" },
    ])
    // An email alone never reaches an order placed with a customer account.
    expect(await listOf({ email: "eve@example.com" })).toEqual([])
  })

  it("once the parked order's invoice is issued, the document replaces the pending entry", async () => {
    ids.gusInvoice = await doc(w.orgId, profileA, {
      number: "INV-2026-0110",
      shopify_order_id: "6100000000006",
      shopify_order_number: "#4106",
      counterparty_email: "gus@example.com",
    })
    const docs = await listOf({ email: "gus@example.com" })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      id: ids.gusInvoice,
      state: "issued",
      source: { stream: "shopify", ref: "6100000000006", name: "#4106" },
    })
  })

  it("pages with a cursor", async () => {
    const res = await call("/list", {
      buyer: { email: "ana@example.com", hubUserId: "6f1c2a9e-0000-4000-8000-000000000001" },
      limit: 2,
    })
    const page = (await res.json()) as { documents: unknown[]; nextCursor: string | null }
    expect(page.documents).toHaveLength(2)
    expect(page.nextCursor).toBe("2")
  })
})

describe("links and the PDF", () => {
  it("another buyer's document, another profile's or an unknown id: the same 404", async () => {
    for (const documentId of [
      ids.bobInvoice,
      ids.profileBInvoice,
      ids.otherOrgInvoice,
      crypto.randomUUID(),
    ]) {
      const res = await call("/link", { buyer: { email: "ana@example.com" }, documentId })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
    }
  })

  it("a forged id cannot link the document of the sale it forges", async () => {
    const res = await call("/link", {
      buyer: { email: "ana@example.com", hubUserId: "6f1c2a9e-0000-4000-8000-0000000000ff" },
      documentId: ids.hubInvoice,
    })
    expect(res.status).toBe(404)
  })

  it("a matching document gets a 5-minute link that serves its PDF, then 410", async () => {
    const res = await call("/link", {
      buyer: { email: "ana@example.com", hubUserId: "6f1c2a9e-0000-4000-8000-000000000001" },
      documentId: ids.hubInvoice,
    })
    expect(res.status).toBe(200)
    const link = (await res.json()) as { url: string; expiresAt: string }
    sample.link = { ...link, url: link.url.replace(/\/pdf\/[^/]+$/, "/pdf/REDACTED") }
    const ttl = Date.parse(link.expiresAt) - Date.now()
    expect(ttl).toBeGreaterThan(4 * 60 * 1000)
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000)
    const path = new URL(link.url).pathname
    const opened: string[] = []
    const original = buyerFileStorage.open
    buyerFileStorage.open = async (storageKey: string) => {
      opened.push(storageKey)
      return {
        stream: new Blob(["%PDF-1.7\n"]).stream(),
        contentLength: 9,
      } as unknown as ObjectStreamResult
    }
    try {
      const pdf = await app.request(path)
      expect(pdf.status).toBe(200)
      expect(pdf.headers.get("content-type")).toBe("application/pdf")
      expect(pdf.headers.get("cache-control")).toBe("private, no-store")
      expect(pdf.headers.get("content-disposition")).toContain("INV-2026-0101.pdf")
      expect(opened).toHaveLength(1)
      await sql.unsafe(
        `UPDATE ${K("buyer_invoice_links")} SET expires_at = now() - interval '1 second' WHERE key_id = '${keyId}'`,
      )
      expect((await app.request(path)).status).toBe(410)
      expect((await app.request("/api/buyer-invoices/pdf/unknown")).status).toBe(404)
    } finally {
      buyerFileStorage.open = original
    }
  })

  it("a revoked key stops at once, and so do its live links", async () => {
    const res = await call("/link", {
      buyer: { email: "ana@example.com" },
      documentId: ids.guestInvoice,
    })
    const path = new URL(((await res.json()) as { url: string }).url).pathname
    const revoked = await app.request(`/api/invoicing/buyer-keys/${keyId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminBearer}` },
    })
    expect(revoked.status).toBe(200)
    expect((await call("/list", { buyer: { email: "ana@example.com" } })).status).toBe(401)
    expect((await app.request(path)).status).toBe(404)
  })
})
