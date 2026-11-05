// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — credit notes (invoicing app 0.5.0).
//
// Credit notes are the legally-compliant reversal document: their own CN-
// number series, negative line amounts mirroring what is reversed, and a
// persisted reference to the original invoice (external_refs.original_
// document_id/_number + a "credit_note_issued" entry on the original's
// lifecycle). This scenario drives the full flow with direct tool calls
// (no LLM), then verifies the load-bearing UI surface: the Credit notes
// sidebar filter lists the document and its detail page shows the type
// label and the original-invoice link.
import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

test.describe("Invoicing: credit notes", () => {
  test("an intra-EU buyer VAT number VIES says is invalid is refused with a 422 and the reason", async ({
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "DE",
          name: "Invalid VAT Kunde",
          email: "invalid-vat@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const resp = await api(env.serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: installed.additionalContactIds[0],
            legal_name: "Invalid VAT Kunde GmbH",
            country: "DE",
            // Unregistered in the VIES stand-in: VIES answers "invalid".
            vat_id: "DE123456789",
            address: "Hauptstrasse 5, 10115 Berlin, Germany",
            email: "invalid-vat@e2e.test",
          },
          issuer_profile_id: installed.primaryIssuerProfileId,
          currency: "EUR",
          incoterm: "DAP",
          items: [
            {
              position: 1,
              description: "Tessera II unit",
              quantity: "1",
              unit_price_minor: "59900",
              product_source: null,
              external_id: null,
            },
          ],
        },
      },
    })
    expect(resp.status, JSON.stringify(resp.body)).toBe(422)
    const error = ((resp.body ?? {}) as { error?: { code?: string; message?: string } }).error
    expect(error?.code).toBe("vat_id_invalid")
    expect(error?.message).toContain("DE123456789 is NOT valid")
  })

  test("issuing a partial credit note against an invoice: CN numbering, negative totals, original linkage, UI surfaces", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "DE",
          name: "Credit Note Kunde",
          email: "credit-note@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    const counterparty = {
      contact_id: contactId,
      legal_name: "Credit Note Kunde GmbH",
      country: "DE",
      // Valid in the test stack's VIES stand-in (LIAISON_TEST_VIES_STUB, sandbox/bridge/test-vies.ts).
      vat_id: "DE298765432",
      address: "Hauptstrasse 5, 10115 Berlin, Germany",
      email: "credit-note@e2e.test",
    }

    // 1. Issue the original invoice (10 units).
    const issueResp = await api(
      env.serverUrl,
      "/api/apps/invoicing/tools/invoice_create_and_issue",
      {
        method: "POST",
        token: qa.admin.token,
        body: {
          params: {
            counterparty,
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: "Tessera II unit — dealer batch",
                quantity: "10",
                unit_price_minor: "59900",
                product_source: null,
                external_id: null,
              },
            ],
          },
        },
      },
    )
    expect(issueResp.status).toBe(200)
    const invoice = unwrap(issueResp.body)
    const invoiceId = invoice.document_id as string
    const invoiceNumber = invoice.number as string
    expect(invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/)

    // 2. Issue a PARTIAL credit note against it — 2 units returned, negative
    //    amounts mirroring the reversed lines.
    const cnResp = await api(
      env.serverUrl,
      "/api/apps/invoicing/tools/credit_note_create_and_issue",
      {
        method: "POST",
        token: qa.admin.token,
        body: {
          params: {
            counterparty,
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            original_document_id: invoiceId,
            reason: "2 of 10 units returned — transport damage",
            items: [
              {
                position: 1,
                description: "Tessera II unit — dealer batch (returned)",
                quantity: "2",
                unit_price_minor: "-59900",
                product_source: null,
                external_id: null,
              },
            ],
          },
        },
      },
    )
    if (cnResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[credit-note issue] non-200:", cnResp.status, JSON.stringify(cnResp.body))
    }
    expect(cnResp.status).toBe(200)
    const cn = unwrap(cnResp.body)
    const cnId = cn.document_id as string
    const cnNumber = cn.number as string
    // Own CN- series, independent of the invoice sequence.
    expect(cnNumber).toMatch(/^CN-\d{4}-\d{4}$/)

    // 3. Tool-level assertions on the credit note.
    const cnGet = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { id: cnId } },
    })
    expect(cnGet.status).toBe(200)
    const cnDoc = unwrap(cnGet.body)
    expect(cnDoc.type).toBe("credit_note")
    expect(cnDoc.status).toBe("issued")
    // Negative grand total (2 × -599.00 = -1,198.00 EUR, DE reverse-charge → 0% tax).
    expect(String(cnDoc.grand_total_minor)).toBe("-119800")
    const refs = (cnDoc.external_refs ?? {}) as Record<string, unknown>
    expect(refs.original_document_id).toBe(invoiceId)
    expect(refs.original_document_number).toBe(invoiceNumber)
    expect(["ready", "pdf_a3_normalization_skipped"]).toContain(String(cnDoc.pdf_status))

    // 4. The ORIGINAL invoice's lifecycle records the credit note.
    const origGet = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { id: invoiceId } },
    })
    expect(origGet.status).toBe(200)
    const origDoc = unwrap(origGet.body)
    const lifecycle = (origDoc.lifecycle_log ?? []) as Array<Record<string, unknown>>
    const cnEvent = lifecycle.find((e) => e.event === "credit_note_issued")
    expect(cnEvent).toBeDefined()
    expect(cnEvent?.credit_note_id).toBe(cnId)
    // The invoice itself is untouched otherwise.
    expect(origDoc.number).toBe(invoiceNumber)
    expect(origDoc.status).toBe("issued")

    // 5. UI — the Credit notes sidebar filter lists the document.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/documents/credit-notes`)
    await page.waitForLoadState("networkidle")
    const table = page.getByTestId("invoicing-documents-table").first()
    await expect(table).toBeVisible({ timeout: 20_000 })
    await expect(table.getByText(cnNumber).first()).toBeVisible({ timeout: 15_000 })

    // 6. UI — detail page: type label + original-invoice link.
    await page.goto(`${viteUrl}/invoicing/document/${cnId}`)
    await page.waitForLoadState("networkidle")
    const overview = page.getByTestId("document-detail-overview").first()
    await expect(overview).toBeVisible({ timeout: 20_000 })
    const originalLink = page.getByTestId("document-detail-original-invoice").first()
    await expect(originalLink).toBeVisible()
    await expect(originalLink).toHaveText(invoiceNumber)
    // Clicking it navigates to the original invoice's detail.
    await originalLink.click()
    await page.waitForURL(`**/invoicing/document/${invoiceId}`, { timeout: 15_000 })

    // The shell's agent-chat pane pings /api/agent/chat (+ an optimistic
    // thread's /references) during navigation — no LLM runs in this harness,
    // so those 500/400 are ambient shell noise unrelated to invoicing.
    const relevant = consoleErrors.filter(
      (e) => !/agent\/chat|optimistic-|Failed to load resource/.test(e),
    )
    expect(relevant, `console errors: ${relevant.join("\n")}`).toEqual([])
  })
})
