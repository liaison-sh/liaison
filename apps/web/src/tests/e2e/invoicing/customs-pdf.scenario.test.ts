// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S4 — Customs PDF carries required fields (export-treatment invoice).
//
// Plan §S4: an invoice issued by a FR issuer to a US counterparty (export
// treatment `eu_export_non_eu`) produces a PDF containing HS code per line,
// country of origin per line, declared currency, declared total, the incoterm,
// and the export legal mention. Pins spec #4 at the rendered-PDF-bytes tier
// (the template's field rendering is unit-tested separately in templates.test.ts).
//
// Customs values flow from the `product_customs_overlay` (seeded by the I1
// install route's `seedCustomsFixtures`): a line referencing
// source='manual', external_id='test-product-customs' picks up HS 9207.10,
// CoO CN, description "Electronic pad controller". A line's own hs_code is NOT
// used at issuance — only the overlay lookup populates the snapshot line.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"
import { pdfBytesToText, validateCustomsPdfText } from "./helpers/validate-customs-pdf"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

test.describe("Invoicing: customs PDF", () => {
  test("FR→US export invoice PDF carries HS code, CoO, incoterm, currency, total, legal mention", async ({
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    // FR issuer, US counterparty (→ eu_export_non_eu), customs fixtures seeded,
    // no approval threshold so the export invoice issues directly.
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      issuerOverrides: { invoice_approval_threshold_minor: null },
      seedCustomsFixtures: true,
      additionalContacts: [
        {
          country: "US",
          name: "US Test Customer",
          email: "us-test-s4@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    // Issue to the US contact; the line references the seeded overlay product.
    const issueResp = await api(
      env.serverUrl,
      "/api/apps/invoicing/tools/invoice_create_and_issue",
      {
        method: "POST",
        token: qa.admin.token,
        body: {
          params: {
            counterparty: {
              contact_id: contactId,
              legal_name: "US Test Customer",
              country: "US",
              vat_id: null,
              address: "500 Market Street, San Francisco, CA 94105, USA",
              email: "us-test-s4@e2e.test",
            },
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: "Kestrel 2 — Black",
                quantity: "1",
                unit_price_minor: "45000",
                // Overlay key (seedCustomsFixtures): → HS 9207.10, CoO CN.
                product_source: "manual",
                external_id: "test-product-customs",
              },
            ],
          },
        },
      },
    )
    if (issueResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S4 issue] non-200:", issueResp.status, JSON.stringify(issueResp.body))
    }
    expect(issueResp.status).toBe(200)
    const issuePayload = unwrap(issueResp.body)
    expect(issuePayload.status).toBe("completed")
    const documentId = issuePayload.document_id as string
    expect(documentId).toBeTruthy()

    // Read the document: export treatment + a rendered PDF.
    const getResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { id: documentId } },
    })
    expect(getResp.status).toBe(200)
    const doc = unwrap(getResp.body)
    expect(doc.tax_treatment).toBe("eu_export_non_eu")
    const pdfFileId = doc.pdf_file_id as string
    expect(pdfFileId, JSON.stringify(doc)).toBeTruthy()

    // Fetch the rendered PDF bytes and extract its text layer.
    const pdfResp = await fetch(`${env.serverUrl}/api/files/${pdfFileId}/inline`, {
      headers: { Authorization: `Bearer ${qa.admin.token}` },
    })
    expect(pdfResp.status).toBe(200)
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer())
    expect(pdfBuf.subarray(0, 5).toString("utf8")).toBe("%PDF-")
    const text = await pdfBytesToText(pdfBuf)

    // Validate the customs fields.
    const checks = validateCustomsPdfText(text)
    const missing = checks.filter((c) => !c.present).map((c) => c.field)
    expect(
      missing,
      `missing customs fields: ${missing.join(", ")}\n--- PDF TEXT ---\n${text}`,
    ).toEqual([])
    const detail = (field: string) => checks.find((c) => c.field === field)?.detail
    expect(detail("incoterm")).toBe("DAP")
    expect(detail("hs_code")).toBe("9207.10")
    expect(detail("country_of_origin")).toBe("CN")
    expect(detail("currency")).toBe("EUR")
    // Export is VAT-exempt (0-rate), so grand total == subtotal == 450.00.
    expect(detail("total_value")).toBe("450.00")
  })
})
