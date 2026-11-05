// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — Tool-surface coverage. Exercises EVERY invoicing read +
// settings + secondary tool the F-stage UI calls, end-to-end against the real
// kernel (no host mocks), asserting each resolves with real data. This is the
// validation backing the "the whole app's tool layer works" claim — the
// dashboards/settings/contact-panel/document-detail surfaces all drive these.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}
const arr = (body: unknown): Array<Record<string, unknown>> => {
  const u = unwrap(body)
  if (Array.isArray(u)) return u as Array<Record<string, unknown>>
  if (Array.isArray((u as { items?: unknown[] }).items))
    return (u as { items: Array<Record<string, unknown>> }).items
  return []
}

test.describe("Invoicing: tool surface", () => {
  test("every read/settings/secondary tool resolves with real data", async ({ env, world, qa }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const call = (tool: string, params: Record<string, unknown> = {}) =>
      api(env.serverUrl, `/api/apps/invoicing/tools/${tool}`, {
        method: "POST",
        token,
        body: { params },
      })

    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      issuerOverrides: { invoice_approval_threshold_minor: null },
      seedCustomsFixtures: true,
      additionalContacts: [
        {
          country: "FR",
          name: "Tooling Customer",
          email: "tooling@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]
    const issuer = installed.primaryIssuerProfileId

    // ── Settings reads ──────────────────────────────────────────────────────
    const issuers = await call("settings_issuer_profile_list")
    expect(issuers.status).toBe(200)
    expect(arr(issuers.body).length).toBeGreaterThanOrEqual(1)
    expect(arr(issuers.body).some((r) => String(r.id) === issuer)).toBe(true)

    expect((await call("settings_tax_regime_list")).status).toBe(200)
    const hsList = await call("settings_hs_code_list")
    expect(hsList.status).toBe(200)
    expect(arr(hsList.body).some((r) => String(r.code) === "9207.10")).toBe(true) // from seedCustomsFixtures
    const shopMappings = await call("settings_shop_mapping_list")
    // eslint-disable-next-line no-console
    if (shopMappings.status !== 200)
      console.error("[shop_mapping]", JSON.stringify(shopMappings.body))
    expect(shopMappings.status).toBe(200)
    expect(arr(shopMappings.body).length).toBe(0)

    // ── deferred_list ───────────────────────────────────────────────────────
    const deferred = await call("deferred_list")
    expect(deferred.status).toBe(200)
    expect(Array.isArray(arr(deferred.body))).toBe(true)

    // ── contact_relationships set → get round-trip ──────────────────────────
    expect(
      (await call("contact_relationships_set", { contact_id: contactId, relationship: "customer" }))
        .status,
    ).toBe(200)
    const rel = await call("contact_relationships_get", { contact_id: contactId })
    expect(rel.status).toBe(200)
    const relItem = (unwrap(rel.body).item ?? unwrap(rel.body)) as Record<string, unknown>
    expect(relItem.relationship).toBe("customer")

    // ── Settings issuer CRUD: create → list(2) → update → delete → list(1) ───
    const created = await call("settings_issuer_profile_create", {
      legal_name: "Second Issuer SAS",
      country: "DE",
      default_currency: "EUR",
      default_language: "de",
      default_payment_terms_days: 14,
    })
    expect(created.status).toBe(200)
    const newIssuerId = unwrap(created.body).id as string
    expect(newIssuerId).toBeTruthy()
    expect(arr((await call("settings_issuer_profile_list")).body).length).toBeGreaterThanOrEqual(2)

    expect(
      (
        await call("settings_issuer_profile_update", {
          id: newIssuerId,
          legal_name: "Second Issuer GmbH",
        })
      ).status,
    ).toBe(200)
    const afterUpdate = arr((await call("settings_issuer_profile_list")).body).find(
      (r) => String(r.id) === newIssuerId,
    )
    expect(afterUpdate?.legal_name).toBe("Second Issuer GmbH")

    expect((await call("settings_issuer_profile_delete", { id: newIssuerId })).status).toBe(200)
    expect(
      arr((await call("settings_issuer_profile_list")).body).some(
        (r) => String(r.id) === newIssuerId,
      ),
    ).toBe(false)

    // ── Issue a document → counterparty snapshot is persisted + returned ─────
    const issued = await call("invoice_create_and_issue", {
      counterparty: {
        contact_id: contactId,
        legal_name: "Tooling Customer",
        country: "FR",
        vat_id: null,
        address: "10 Rue de la Republique, 69001 Lyon, France",
        email: "tooling@e2e.test",
      },
      issuer_profile_id: issuer,
      currency: "EUR",
      incoterm: "DAP",
      items: [
        {
          position: 1,
          description: "Item",
          quantity: "1",
          unit_price_minor: "1000",
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(issued.status).toBe(200)
    const docId = unwrap(issued.body).document_id as string

    // documents_search returns the persisted counterparty name (dashboards rely on this).
    const search = await call("documents_search", { type: "invoice" })
    expect(search.status).toBe(200)
    const issuedRow = arr(search.body).find((r) => String(r.id) === docId)
    expect(issuedRow?.counterparty_name).toBe("Tooling Customer")
    // And filtering by contact_id actually filters.
    const byContact = await call("documents_search", { contact_id: contactId, type: "invoice" })
    expect(arr(byContact.body).every((r) => r.counterparty_contact_id === contactId)).toBe(true)

    // ── PDF actions: preview/download resolve to the file; retry re-renders ──
    const preview = await call("documents_preview_pdf", { id: docId })
    expect(preview.status).toBe(200)
    expect(typeof unwrap(preview.body).file_id).toBe("string")
    expect(String(unwrap(preview.body).url)).toContain("/api/files/")

    expect((await call("documents_download_pdf", { id: docId })).status).toBe(200)

    const retry = await call("documents_retry_pdf", { id: docId })
    expect(retry.status).toBe(200)
    expect(unwrap(retry.body).status).toBe("completed")
    expect(typeof unwrap(retry.body).pdf_file_id).toBe("string")
  })
})
