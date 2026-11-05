// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — VISUAL baselines for the rendered invoice/customs/proforma PDFs.
//
// Unlike the UI-surface visual scenario (which mocks the host), these issue REAL
// documents through the kernel (install → invoice/proforma tool → K2 PDF render),
// fetch the PDF bytes, rasterise the first page to PNG (pdf-to-png-converter →
// pdfjs), and pixel-compare against a darwin baseline. The PDF text layer is
// asserted separately by S4 (`customs-pdf.scenario.test.ts`); this tier catches
// layout regressions (table columns, customs row, totals block, legal mention).
//
// Determinism: the PDFs embed today's `issued_at`, but a date glyph change is
// ~0.003 of the page — well under the 0.02 maxDiffPixelRatio tolerance, so the
// baselines survive day-to-day. Re-bake with `--update-snapshots=all` after an
// intentional template change.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { pdfToPng } from "pdf-to-png-converter"
import { callToolAsAgent, decideApproval, listPendingApprovals } from "../helpers/approvals"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle
const PIXEL_BASELINES = process.platform === "darwin"
const SHOT = { maxDiffPixelRatio: 0.02 } as const

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

async function fetchPdfPng(serverUrl: string, token: string, pdfFileId: string): Promise<Buffer> {
  const resp = await fetch(`${serverUrl}/api/files/${pdfFileId}/inline`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(resp.status).toBe(200)
  const pdfBuf = Buffer.from(await resp.arrayBuffer())
  expect(pdfBuf.subarray(0, 5).toString("utf8")).toBe("%PDF-")
  const pages = await pdfToPng(pdfBuf, { viewportScale: 2.0, pagesToProcess: [1] })
  const png = pages[0]?.content
  if (!png) throw new Error("pdf-to-png-converter returned no page content")
  return png
}

test.describe("Invoicing: PDF visual baselines", () => {
  test("invoice + customs-export + proforma PDFs match their baselines", async ({
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
      issuerOverrides: { invoice_approval_threshold_minor: null },
      seedCustomsFixtures: true,
      additionalContacts: [
        {
          country: "FR",
          name: "Domestic Customer",
          email: "dom-pdf@e2e.test",
          customerKind: "individual",
        },
        {
          country: "US",
          name: "Export Customer",
          email: "exp-pdf@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const [frContact, usContact] = installed.additionalContactIds
    const issuer = installed.primaryIssuerProfileId
    const tool = "/api/apps/invoicing/tools/invoice_create_and_issue"

    // 1. Domestic invoice (EUR, VAT 20%).
    const inv = await api(env.serverUrl, tool, {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: frContact,
            legal_name: "Domestic Customer",
            country: "FR",
            vat_id: null,
            address: "3 Rue de Rivoli, 75001 Paris, France",
            email: "dom-pdf@e2e.test",
          },
          issuer_profile_id: issuer,
          currency: "EUR",
          incoterm: "DAP",
          items: [
            {
              position: 1,
              description: "Studio bundle",
              quantity: "2",
              unit_price_minor: "15000",
              product_source: null,
              external_id: null,
            },
          ],
        },
      },
    })
    expect(inv.status).toBe(200)
    const invPdf = unwrap(inv.body).pdf_file_id as string
    // pdf_file_id may not be on the issue envelope; fall back to documents_get.
    const invDocId = unwrap(inv.body).document_id as string
    const invFileId = invPdf ?? (await getPdfId(env.serverUrl, qa.admin.token, invDocId))
    const invoicePng = await fetchPdfPng(env.serverUrl, qa.admin.token, invFileId)
    if (PIXEL_BASELINES) expect(invoicePng).toMatchSnapshot("pdf-invoice-domestic.png", SHOT)

    // 2. Customs export invoice (FR→US, HS/CoO line via the seeded overlay).
    const exp = await api(env.serverUrl, tool, {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: usContact,
            legal_name: "Export Customer",
            country: "US",
            vat_id: null,
            address: "500 Market Street, San Francisco, CA 94105, USA",
            email: "exp-pdf@e2e.test",
          },
          issuer_profile_id: issuer,
          currency: "EUR",
          incoterm: "DAP",
          items: [
            {
              position: 1,
              description: "Kestrel 2 — Black",
              quantity: "1",
              unit_price_minor: "45000",
              product_source: "manual",
              external_id: "test-product-customs",
            },
          ],
        },
      },
    })
    expect(exp.status).toBe(200)
    const expFileId = await getPdfId(
      env.serverUrl,
      qa.admin.token,
      unwrap(exp.body).document_id as string,
    )
    const customsPng = await fetchPdfPng(env.serverUrl, qa.admin.token, expFileId)
    if (PIXEL_BASELINES) expect(customsPng).toMatchSnapshot("pdf-customs-export.png", SHOT)

    // 3. Proforma (gated killer-path → approve → issued).
    // The killer path is an agent's call: a person's own call issues at once
    // (approvals are for agents), so it is staged through the agent's gate.
    const pf = await callToolAsAgent(
      env.serverUrl,
      qa.admin.token,
      "invoicing:proforma_create_and_issue",
      {
        counterparty: {
          contact_id: frContact,
          legal_name: "Domestic Customer",
          country: "FR",
          vat_id: null,
          address: "3 Rue de Rivoli, 75001 Paris, France",
          email: "dom-pdf@e2e.test",
        },
        reason: "return",
        declared_value_minor: 30000,
        items: [
          {
            position: 1,
            description: "Returned unit",
            quantity: "1",
            unit_price_minor: "30000",
            product_source: null,
            external_id: null,
          },
        ],
      },
    )
    expect(pf.status).toBe(200)
    const pfp = unwrap(pf.body)
    const approvalId =
      (pfp.blocked as { approvalRequestId?: string } | undefined)?.approvalRequestId ??
      (pfp.approval_id as string)
    expect(approvalId).toBeTruthy()
    expect(
      (
        await decideApproval({
          serverUrl: env.serverUrl,
          token: qa.admin.token,
          requestId: approvalId,
          decision: "approve",
        })
      ).status,
    ).toBe(200)
    let pfDoc: Record<string, unknown> | undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const s = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_search", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { type: "proforma" } },
      })
      const sp = unwrap(s.body)
      const rows = (Array.isArray(sp) ? sp : Array.isArray(s.body) ? s.body : []) as Array<
        Record<string, unknown>
      >
      pfDoc = rows.find((d) => d.status === "issued")
      if (pfDoc) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(pfDoc, "issued proforma after approve").toBeTruthy()
    const pfFileId = await getPdfId(env.serverUrl, qa.admin.token, pfDoc!.id as string)
    const proformaPng = await fetchPdfPng(env.serverUrl, qa.admin.token, pfFileId)
    if (PIXEL_BASELINES) expect(proformaPng).toMatchSnapshot("pdf-proforma.png", SHOT)

    // No pending approvals linger.
    expect(
      (
        await listPendingApprovals({
          serverUrl: env.serverUrl,
          token: qa.admin.token,
          toolPrefix: "invoicing:",
        })
      ).length,
    ).toBe(0)
  })
})

async function getPdfId(serverUrl: string, token: string, documentId: string): Promise<string> {
  // Poll documents_get until the PDF render completes (pdf_status ready).
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const r = await api(serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token,
      body: { params: { id: documentId } },
    })
    const doc = unwrap(r.body)
    if (doc.pdf_file_id) return doc.pdf_file_id as string
    await new Promise((res) => setTimeout(res, 300))
  }
  throw new Error(`pdf_file_id never appeared for document ${documentId}`)
}
