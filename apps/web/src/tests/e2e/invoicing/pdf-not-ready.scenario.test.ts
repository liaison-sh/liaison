// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In a browser: Preview PDF on a document with no PDF yet says what is happening, and the tab offers
// to render it again. The editor says under the field when a chosen issue date would be refused.
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

test.describe("Invoicing: what a person is told", () => {
  test("Preview PDF on a pending PDF says so, and the PDF tab offers a retry", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Pending Customer",
          email: "pending@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const issued = await api(env.serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: installed.additionalContactIds[0],
            legal_name: "Pending Customer",
            country: "FR",
            address: "1 rue de Test, 75011 Paris",
            email: "pending@e2e.test",
            customer_kind: "individual",
          },
          issuer_profile_id: installed.primaryIssuerProfileId,
          currency: "EUR",
          operation_category: "services",
          items: [
            {
              description: "Service",
              quantity: "1",
              unit_price_minor: "10000",
              line_kind: "software",
            },
          ],
        },
      },
    })
    expect(issued.status).toBe(200)
    const body = issued.body as { data?: { document_id?: string }; document_id?: string }
    const id = body.data?.document_id ?? body.document_id

    await loginAs(page, env, qa.admin.email, "12345678")
    // A document whose render never ran: nothing but its status differs, and the tool has no file.
    await page.route("**/api/apps/invoicing/tools/documents_get", async (route) => {
      const res = await route.fetch()
      const json = (await res.json()) as { data?: Record<string, unknown> }
      if (json.data) {
        json.data.pdf_status = "pending"
        json.data.pdf_file_id = null
      }
      await route.fulfill({ response: res, json })
    })
    await page.route("**/api/apps/invoicing/tools/documents_preview_pdf", (route) =>
      route.fulfill({
        json: { data: { file_id: null, url: null, legal_original: false, management_copy: null } },
      }),
    )
    await page.goto(`http://localhost:${env.ports[1]}/invoicing/document/${id}`)
    await page.getByTestId("document-detail-action-preview-pdf").click()
    const note = page.getByTestId("document-detail-action-note")
    await expect(note).toContainText("This PDF is not ready yet")
    await page.getByTestId("document-detail-tab-pdf").click()
    await expect(page.getByTestId("document-detail-action-retry-pdf")).toBeVisible()
  })

  test("a chosen issue date that would be refused says why before the click", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/invoicing`)
    await page.getByTestId("invoicing-sidebar-new-cta").click()
    const date = page.getByTestId("editor-field-issued-at")
    await expect(date).toBeVisible()
    const notice = page.getByTestId("editor-issue-date-notice")
    await expect(notice).toHaveCount(0)
    await date.fill("2099-01-01")
    await expect(notice).toContainText("after today")
    await date.fill("2020-01-01")
    await expect(notice).toHaveCount(0)
  })
})
