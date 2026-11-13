// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane reception ops beyond the contract's conformance cases: the download's hops and
// credentials (bearer to the API host only, none to the storage host, an unlisted host refused,
// the exact hosts listed in the manifest), the catch-up cursor per reception address, the actions
// each Pennylane status allows, a provider refusal surfaced with the re-read status.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import type { PennylaneToolCtx } from "../ctx"
import { PennylaneFake } from "../einvoicing/fake/server"
import * as ops from "../einvoicing/ops"
import { API_HOST, PENNYLANE_FILE_HOSTS, STORAGE_HOST } from "./hosts"
import { NOT_OBSERVABLE_REASON_CODES } from "./reasons"
import { offeredActions } from "./received"

const TARGET = {
  app: "invoicing",
  entity_type: "received_file",
  entity_id: "00000000-0000-4000-8000-00000000f001",
}

function setup(
  registrations = [
    { siren: "902000009", status: "activated", exchange_direction: "emission_and_reception" },
  ],
) {
  const fake = new PennylaneFake()
  fake.registrations = registrations
  const ctx = {
    orgId: "org",
    db: createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true }),
    fetch: fake.sandboxFetch,
    files_importFromUrl: fake.importFromUrl,
    connections: {
      pennylane: { getSettings: async () => ({ values: { scope: "company" }, missing: [] }) },
    },
  } as unknown as PennylaneToolCtx
  return { fake, ctx }
}

type R = Record<string, any>

describe("fetch_received_file", () => {
  it("sends the token to the API host only, follows the storage redirect bare, stores the exact bytes", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive({ original: new TextEncoder().encode("<Invoice>original</Invoice>") })
    const r = (await ops.einvoicingReceivedFile(
      { provider_ref: String(ref), file: "original", target: TARGET },
      ctx,
    )) as R
    expect(r.sha256).toBe(fake.originalSha256(ref))
    expect(fake.downloads.map((d) => [d.host, d.authorization])).toEqual([
      [API_HOST, "Bearer tok-secret"],
      [STORAGE_HOST, null],
    ])
    expect(fake.lastImport).toMatchObject({
      auth: { connection: "pennylane", scheme: "bearer", fields: ["apiToken"] },
      credentials: "first-hop-only",
      targetApp: "invoicing",
      targetEntityType: "received_file",
    })
  })

  it("a URL already on the storage host gets no token at all", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive()
    const inv = fake.supplierInvoices.get(ref)!
    inv.e_invoicing.source_file_url = `https://${STORAGE_HOST}/blob${ref}o?X-Amz-Signature=x`
    const r = (await ops.einvoicingReceivedFile(
      { provider_ref: String(ref), file: "original", target: TARGET },
      ctx,
    )) as R
    expect(r.sha256).toBe(fake.originalSha256(ref))
    expect(fake.downloads.map((d) => d.authorization)).toEqual([null])
    expect((fake.lastImport as R).headers).toBeUndefined()
    expect((fake.lastImport as R).auth).toBeUndefined()
  })

  it("a file URL on a host that is not listed is refused", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive()
    fake.supplierInvoices.get(ref)!.e_invoicing.source_file_url =
      "https://files.elsewhere.example/x.xml"
    const r = (await ops.einvoicingReceivedFile(
      { provider_ref: String(ref), file: "original", target: TARGET },
      ctx,
    )) as R
    expect(r.error.code).toBe("received_file_download_refused")
    expect(fake.downloads).toHaveLength(0)
  })

  it("the rendering comes from a fresh read of the invoice", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive()
    const r = (await ops.einvoicingReceivedFile(
      { provider_ref: String(ref), file: "rendering", target: TARGET },
      ctx,
    )) as R
    expect(r.file_id).toBeTruthy()
    expect(r.mime_type).toBe("application/pdf")
    expect(fake.calls.filter((c) => c.path === `/supplier_invoices/${ref}`)).toHaveLength(1)
  })

  it("the manifest lists both hosts exactly, never as a wildcard", () => {
    const m = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
    )
    const domains: string[] = m.connections.pennylane.allowedDomains
    for (const h of PENNYLANE_FILE_HOSTS) expect(domains).toContain(h)
    expect(domains.some((d) => d.includes("*"))).toBe(false)
  })
})

describe("list_received (catch-up)", () => {
  it("lists per reception address with its own cursor, pages, and skips emission-only registrations", async () => {
    const { fake, ctx } = setup([
      { siren: "902000009", status: "activated", exchange_direction: "emission_and_reception" },
      { siren: "902000017", status: "activated", exchange_direction: "reception" },
      { siren: "902000025", status: "activated", exchange_direction: "emission" },
    ])
    const a = Array.from({ length: 55 }, () => fake.receive({ routing: "902000009" }))
    const b = fake.receive({ routing: "902000017" })
    const c = fake.receive({ routing: "902000025" })
    const first = (await ops.einvoicingReceivedList({ cursor: null }, ctx)) as R
    expect(first.has_more).toBe(true)
    expect(first.items.map((i: R) => i.provider_ref)).toContain(String(b))
    expect(first.items).toHaveLength(51)
    const second = (await ops.einvoicingReceivedList({ cursor: first.cursor }, ctx)) as R
    expect(second.items.map((i: R) => i.provider_ref)).toEqual(a.slice(50).map(String))
    expect(second.has_more).toBe(false)
    const all = [...first.items, ...second.items].map((i: R) => i.provider_ref)
    expect(all).not.toContain(String(c))
    const third = (await ops.einvoicingReceivedList({ cursor: second.cursor }, ctx)) as R
    expect(third.items).toHaveLength(0)
  })

  it("no reception registration: nothing to list, no supplier invoice request", async () => {
    const { fake, ctx } = setup([])
    fake.receive()
    const r = (await ops.einvoicingReceivedList({ cursor: null }, ctx)) as R
    expect(r.items).toEqual([])
    expect(fake.calls.some((x) => x.path.startsWith("/supplier_invoices"))).toBe(false)
  })
})

describe("actions and statuses", () => {
  it("offers what Pennylane allows for each status", () => {
    const acts = (raw: string | null, paid = false) =>
      offeredActions(raw, paid).map((a) => a.action)
    expect(acts(null)).toEqual(["refuse", "dispute"])
    expect(acts("waiting_for_validation")).toEqual(["refuse", "dispute"])
    expect(acts("approved")).toEqual(["refuse", "dispute"])
    expect(acts("disputed")).toEqual(["refuse", "undispute"])
    expect(acts("disputed", true)).toEqual(["undispute"])
    for (const terminal of ["refused", "rejected", "collected", "partially_collected"])
      expect(acts(terminal)).toEqual([])
    expect(acts(null, true)).toEqual([])
  })

  it("maps statuses with their codes; the reason text is kept", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive({
      supplier: "Fournisseur Exemple",
      supplierSiren: "732829320",
      supplierVat: "FR44732829320",
    })
    fake.supplierInvoices.get(ref)!.e_invoicing.status = "rejected"
    fake.supplierInvoices.get(ref)!.e_invoicing.reason = "Unknown recipient"
    const r = (await ops.einvoicingReceivedGet({ provider_ref: String(ref) }, ctx)) as R
    expect(r.status).toEqual({
      raw: "rejected",
      mapped: "rejected",
      code: 213,
      reason_text: "Unknown recipient",
    })
    expect(r.supplier).toEqual({
      name: "Fournisseur Exemple",
      siren: "732829320",
      vat_id: "FR44732829320",
    })
    expect(r.actions).toEqual([])
  })

  it("a supplier invoice that did not come through the network is not a received e-invoice", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive()
    fake.supplierInvoices.get(ref)!.e_invoicing = null
    const r = (await ops.einvoicingReceivedGet({ provider_ref: String(ref) }, ctx)) as R
    expect(r.error.code).toBe("not_received_einvoice")
  })

  it("a provider refusal (422) is surfaced with the status read back", async () => {
    const { fake, ctx } = setup()
    const ref = fake.receive()
    fake.fail((c) => c.method === "PUT", "replace", {
      status: 422,
      body: { status: 422, error: "A payment is linked to this invoice" },
    })
    const r = (await ops.einvoicingReceivedSetStatus(
      { provider_ref: String(ref), status: "refused", reason: "duplicate_invoice" },
      ctx,
    )) as R
    expect(r.error.code).toBe("provider_rejected")
    expect(r.error.detail.now).toMatchObject({ mapped: "received" })
  })

  it("lists the official reason codes no Pennylane reason reaches", () => {
    expect([...NOT_OBSERVABLE_REASON_CODES].sort()).toEqual([
      "ANNUL_ENC",
      "CALCUL_ERR",
      "MONTANT_ERR",
      "ROUTAGE_ERR",
    ])
  })
})
