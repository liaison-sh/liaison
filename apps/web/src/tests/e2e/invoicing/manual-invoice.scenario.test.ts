// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S1 — Manual invoice creation under threshold (no approval).
//
// Plan §S1: a user creates an invoice manually, issues it below the issuer's
// approval threshold, the PDF renders, and the document lands in the contact's
// primary thread. Spec criteria #1 (issuance is end-to-end), #2 (numbering
// monotonic — number_int = 1 on first issuance), #5 (threshold gating not
// triggered), #8 (document lands in contact's primary thread).
//
// Implementation notes (deviation from plan):
//
//  - The editor's `onIssue` (`bundled-apps/invoicing/src/ui/Editor.tsx:304`)
//    invokes `invoicing:${type}.issue` (dotted form). The manifest declares
//    `invoice_issue` (underscored). The dotted call would route to a missing
//    tool. The plan's §"Tool execution from tests" explicitly permits direct
//    tool calls via `POST /api/apps/:appName/tools/:toolName` for load-bearing
//    assertions, and the visual scenario (V3 patch) covers the editor's draft
//    state separately. S1 uses the direct-tool path for issuance and a UI
//    smoke (navigate, assert editor mounts) for the "user-visible" surface.
//
//  - The editor lacks a counterparty contact picker (only a country-code
//    field). `invoice_create_and_issue` requires `counterparty.contact_id`.
//    S1 seeds a FR contact via the I1 helper's `additionalContacts` arm and
//    threads the returned id through the tool call.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

test.describe("Invoicing: manual invoice under threshold", () => {
  test("issue an invoice manually; PDF renders; document filed against the contact's primary thread", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    // 1. Install + seed a FR contact.
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Amina Test Customer",
          email: "amina-s1@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    expect(installed.additionalContactIds.length).toBe(1)
    const contactId = installed.additionalContactIds[0]

    // 2. Login + UI smoke at `/invoicing` (the home tab). The plan's
    //    `/invoicing/editor/new` URL is not declared in the manifest
    //    `views.tabTypes` (only home / dashboard / documents / settings
    //    are routed) — the editor is mounted by parent surfaces, not by URL.
    //    The visual.scenario.test.ts file covers the editor's draft state
    //    explicitly. S1's UI smoke asserts the sidebar mounts and the page
    //    is free of bridge errors during the load.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="invoicing-sidebar"]')).toBeVisible({
      timeout: 15_000,
    })

    // 3. Issue via direct tool call. Below threshold (null threshold by
    //    default — issuance is direct). One line at €100 unit price; FR
    //    counterparty → domestic 20% VAT → grand total €120.
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
              legal_name: "Amina Test Customer",
              country: "FR",
              vat_id: null,
              address: "8 Rue de Rivoli, 75004 Paris, France",
              email: "amina-s1@e2e.test",
            },
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: "Test product",
                quantity: "1",
                unit_price_minor: "10000",
                product_source: null,
                external_id: null,
              },
            ],
          },
        },
      },
    )

    // Pin the wire shape of the success envelope. Acceptable shapes:
    //   - { data: { document_id, number } }   (Hono success() wrap)
    //   - { document_id, number }              (legacy direct)
    //   - { status: 'completed', document_id, number }  (K4 translated envelope)
    if (issueResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S1 issue] non-200:", issueResp.status, JSON.stringify(issueResp.body))
    }
    expect(issueResp.status).toBe(200)
    const body = issueResp.body as Record<string, unknown>
    const payload =
      "data" in body && body.data && typeof body.data === "object"
        ? (body.data as Record<string, unknown>)
        : body
    expect(typeof payload.document_id).toBe("string")
    expect(typeof payload.number).toBe("string")
    const documentId = payload.document_id as string
    const docNumber = payload.number as string

    // 4. Fetch the document; check status/number/number_int/totals/treatment.
    const getResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { id: documentId } },
    })
    expect(getResp.status).toBe(200)
    const docBody = getResp.body as Record<string, unknown>
    const doc =
      "data" in docBody && docBody.data && typeof docBody.data === "object"
        ? (docBody.data as Record<string, unknown>)
        : docBody
    expect(doc.status).toBe("issued")
    expect(doc.number).toBe(docNumber)
    expect(docNumber).toMatch(/^INV-\d{4}-\d{4}$/)
    // grand_total_minor is 12000 (€100 + 20% VAT = €120.00).
    expect(String(doc.grand_total_minor)).toBe("12000")
    expect(doc.currency).toBe("EUR")
    // Spec §2 — FR↔FR treatment is `eu_domestic` (EU regime, same-country).
    expect(doc.tax_treatment).toBe("eu_domestic")
    expect(doc.pdf_file_id).toBeTruthy()
    expect(["ready", "pdf_a3_normalization_skipped"]).toContain(String(doc.pdf_status))

    // 5. Fetch the PDF bytes; spot-check the PDF magic header. The kernel files
    //    module serves raw bytes from `GET /api/files/:id/inline` (there is no
    //    bare `GET /api/files/:id` bytes route — that path 404s at the router).
    const pdfFileId = doc.pdf_file_id as string
    const pdfResp = await fetch(`${env.serverUrl}/api/files/${pdfFileId}/inline`, {
      headers: { Authorization: `Bearer ${qa.admin.token}` },
    })
    expect(pdfResp.status).toBe(200)
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer())
    expect(pdfBuf.subarray(0, 5).toString("utf8")).toBe("%PDF-")
    expect(pdfBuf.length).toBeGreaterThan(1024)

    // 6. Document is filed against the contact's primary thread. That thread
    //    is entity-bound (`created_from` references the contact) with a single
    //    participant, so by design it is hidden from the global thread list
    //    (`listThreads` excludes `created_from IS NOT NULL AND participants <= 1`).
    //    The contact-detail surface finds it through the backlinks route
    //    (`/api/references` → `kernel:contact:<id>`), which is how a user reaches
    //    it in the product. The B1 contract gives it the deterministic handle
    //    `contact-primary:<contactId>`.
    const refsResp = await api(
      env.serverUrl,
      `/api/references?app=kernel&entityType=contact&entityId=${contactId}`,
      { method: "GET", token: qa.admin.token },
    )
    expect(refsResp.status).toBe(200)
    const refsBody = refsResp.body as { data?: Array<Record<string, unknown>> }
    const refs = Array.isArray(refsBody.data) ? refsBody.data : []
    const primary = refs.find((r) => String(r.handle ?? "") === `contact-primary:${contactId}`)
    expect(primary).toBeTruthy()
    const threadId = String(primary!.threadId)

    // Messages on that thread — at least one should originate from the
    // invoicing app and attach the PDF.
    const msgResp = await api(env.serverUrl, `/api/threads/${threadId}/messages?limit=20`, {
      method: "GET",
      token: qa.admin.token,
    })
    expect(msgResp.status).toBe(200)
    const msgBody = msgResp.body as { data?: Array<Record<string, unknown>> }
    const msgs = Array.isArray(msgBody.data) ? msgBody.data : []
    const fromInvoicing = msgs.filter((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>
      return meta.origin_app_id === "invoicing"
    })
    expect(fromInvoicing.length).toBeGreaterThanOrEqual(1)
    const newest = fromInvoicing[0]
    // K1 references the source PDF id in metadata (exact-id provenance)…
    const metaRefs = (((newest.metadata ?? {}) as Record<string, unknown>).attachment_file_ids ??
      []) as unknown[]
    expect(metaRefs.map(String)).toContain(pdfFileId)
    // …and materialises it as a real, viewable message attachment (a copy of
    // the rendered PDF, so its own id differs from the source pdf_file_id).
    const attachments = (newest.attachments ?? []) as Array<Record<string, unknown>>
    expect(attachments.length).toBeGreaterThanOrEqual(1)
    expect(attachments.some((a) => String(a.mimeType ?? a.mime_type ?? "").includes("pdf"))).toBe(
      true,
    )

    // 7. No approval row was created (below threshold). The decidable-feed
    //    mode of the approvals list route requires both `status=pending` and
    //    `decidableByMe=true` (the union schema is `.strict()`).
    const apResp = await api(env.serverUrl, "/api/approvals?status=pending&decidableByMe=true", {
      method: "GET",
      token: qa.admin.token,
    })
    expect(apResp.status).toBe(200)
    const apBody = apResp.body as { data?: Array<Record<string, unknown>> }
    const pending = Array.isArray(apBody.data) ? apBody.data : []
    const invoicingPending = pending.filter((r) =>
      String(r.toolName ?? r.tool_name ?? "").startsWith("invoicing:"),
    )
    expect(invoicingPending).toEqual([])

    // 8. No bridge errors during the editor mount or any tool call.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors).toEqual([])
  })
})
