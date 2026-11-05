// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — post-issue edit flow (invoicing app 0.4.3).
//
// `documents_update` lets an ISSUED document's content (counterparty
// details, dates, incoterm, lines) be corrected after issue — number, type,
// status, issuer, and currency stay immutable, but everything else can be
// fixed without a credit note. This scenario drives that flow end to end:
// issue an invoice, open its detail page, use the Edit action to reach the
// editor, change the customer address, save, and verify both the UI surface
// (issued-notice banner, hydrated customer fields, success banner) and the
// server-side effects (documents_get shows the new address, the lifecycle
// log records an "edited" event naming counterparty_address, the PDF status
// returns to ready, and number/status are unchanged).
//
// Follows manual-invoice.scenario.test.ts's pattern: direct tool calls for
// setup/issuance (`invoice_create_and_issue`), then a real Playwright pass
// over the UI for the load-bearing user-visible surface — no LLM/agent
// involvement.
//
// Void-then-edit-rejected (task note item 5): the manifest's tool list has
// no `documents_void` / cancel tool — the only path to a `voided` status
// documented in code is `NOT_EDITABLE_STATUSES = new Set(["voided",
// "cancelled"])` in mutations.ts, and no tool sets a document into either
// state. There is no easy way to void a document via existing tools, so
// that assertion is skipped per the task's own instruction.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
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

const ORIGINAL_ADDRESS = "12 Rue de Test, 75001 Paris, France"
const NEW_ADDRESS = "48 Avenue des Corrections, 69001 Lyon, France"
const NEW_EMAIL = "post-edit-corrected@e2e.test"

test.describe("Invoicing: post-issue edit", () => {
  // An issued invoice carries a legal original fixed at issue: its address
  // cannot change on the document (the editor says to issue a credit note and
  // a new invoice). What may still change (email, notes, PO number, incoterm)
  // does, re-renders the PDF and is logged.
  test("an issued invoice refuses an address edit, takes an email edit, re-renders the PDF and logs it", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    // 1. Install + seed a FR contact (standard world, cheapest existing
    //    pattern — direct tool invocation, no LLM/agent).
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Post-Edit Customer",
          email: "post-edit@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    // 2. Create + issue the invoice directly, with an explicit counterparty
    //    address/email (small, 2-line invoice).
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
              legal_name: "Post-Edit Customer",
              country: "FR",
              vat_id: null,
              address: ORIGINAL_ADDRESS,
              email: "post-edit@e2e.test",
            },
            issuer_profile_id: installed.primaryIssuerProfileId,
            currency: "EUR",
            incoterm: "DAP",
            items: [
              {
                position: 1,
                description: "Consulting — onboarding",
                quantity: "1",
                unit_price_minor: "20000",
                product_source: null,
                external_id: null,
              },
              {
                position: 2,
                description: "Consulting — follow-up session",
                quantity: "2",
                unit_price_minor: "5000",
                product_source: null,
                external_id: null,
              },
            ],
          },
        },
      },
    )
    if (issueResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error(
        "[post-issue-edit issue] non-200:",
        issueResp.status,
        JSON.stringify(issueResp.body),
      )
    }
    expect(issueResp.status).toBe(200)
    const issuePayload = unwrap(issueResp.body)
    expect(typeof issuePayload.document_id).toBe("string")
    const documentId = issuePayload.document_id as string
    const originalNumber = issuePayload.number as string
    expect(originalNumber).toMatch(/^INV-\d{4}-\d{4}$/)

    // Sanity: freshly-issued document has a ready-ish PDF.
    const preEditGet = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { id: documentId } },
    })
    expect(preEditGet.status).toBe(200)
    const preEditDoc = unwrap(preEditGet.body)
    expect(preEditDoc.status).toBe("issued")
    expect(preEditDoc.counterparty_address).toBe(ORIGINAL_ADDRESS)
    expect(["ready", "pdf_a3_normalization_skipped"]).toContain(String(preEditDoc.pdf_status))

    // 3. UI — open the document detail page.
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/document/${documentId}`)
    await page.waitForLoadState("networkidle")
    const overview = page.getByTestId("document-detail-overview").first()
    await expect(overview).toBeVisible({ timeout: 20_000 })

    // Customer block shows the counterparty name/address/email.
    const customerBlock = page.getByTestId("document-detail-customer").first()
    await expect(customerBlock).toBeVisible()
    await expect(page.getByTestId("document-detail-customer-name").first()).toHaveText(
      "Post-Edit Customer",
    )
    await expect(page.getByTestId("document-detail-customer-address").first()).toHaveText(
      ORIGINAL_ADDRESS,
    )
    await expect(page.getByTestId("document-detail-customer-email").first()).toHaveText(
      "post-edit@e2e.test",
    )

    // Edit action is visible for the ISSUED doc.
    const editAction = page.getByTestId("document-detail-action-edit").first()
    await expect(editAction).toBeVisible()
    await editAction.click()

    // Lands on the editor for this document.
    await page.waitForURL(`**/invoicing/editor/${documentId}`, { timeout: 15_000 })
    const editorRoot = page.getByTestId("invoicing-editor").first()
    await expect(editorRoot).toBeVisible({ timeout: 20_000 })

    // Issued notice is visible, and customer fields are hydrated from the
    // real document (not a blank draft).
    await expect(page.getByTestId("editor-issued-notice").first()).toBeVisible()
    const nameField = page.getByTestId("editor-field-customer-name").first()
    const emailField = page.getByTestId("editor-field-customer-email").first()
    const addressField = page.getByTestId("editor-field-customer-address").first()
    await expect(nameField).toHaveValue("Post-Edit Customer")
    await expect(emailField).toHaveValue("post-edit@e2e.test")
    await expect(addressField).toHaveValue(ORIGINAL_ADDRESS)

    // The address is part of the legal original: the save is refused, and the
    // editor says how to correct it.
    await addressField.fill(NEW_ADDRESS)
    await expect(addressField).toHaveValue(NEW_ADDRESS)
    await page.getByTestId("editor-button-save-changes").first().click()
    const refused = page.getByTestId("editor-error-banner").first()
    await expect(refused).toBeVisible({ timeout: 15_000 })
    await expect(refused).toContainText("legal original")
    await expect(refused).toContainText("credit note")

    // The email is not: put the address back, change the email, save.
    await addressField.fill(ORIGINAL_ADDRESS)
    await emailField.fill(NEW_EMAIL)
    await page.getByTestId("editor-button-save-changes").first().click()

    // Success banner confirms the save.
    await expect(page.getByTestId("editor-success-banner").first()).toBeVisible({
      timeout: 15_000,
    })

    // No bridge wiring errors surfaced during the whole UI flow.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors, bridgeErrors.join("\n")).toHaveLength(0)

    // 4. Tool-level assertions — documents_get reflects the new email and the
    //    unchanged address, the lifecycle log's last entry is the edit event
    //    naming counterparty_email, the PDF status is ready again, and
    //    number/status are unchanged.
    let postEditDoc: Record<string, unknown> | undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const getResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_get", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { id: documentId } },
      })
      expect(getResp.status).toBe(200)
      const doc = unwrap(getResp.body)
      if (doc.counterparty_email === NEW_EMAIL) {
        postEditDoc = doc
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(postEditDoc, "documents_get should reflect the edited email").toBeTruthy()
    const doc = postEditDoc!

    expect(doc.counterparty_email).toBe(NEW_EMAIL)
    expect(doc.counterparty_address).toBe(ORIGINAL_ADDRESS)
    expect(doc.number).toBe(originalNumber)
    expect(doc.status).toBe("issued")

    const lifecycleLog = (doc.lifecycle_log ?? []) as Array<Record<string, unknown>>
    expect(lifecycleLog.length).toBeGreaterThanOrEqual(2)
    const lastEntry = lifecycleLog[lifecycleLog.length - 1]
    expect(lastEntry.event).toBe("edited")
    const editedFields = (lastEntry.fields ?? []) as unknown[]
    // The log names the fields the save submitted (the whole customer block);
    // what matters is that the locked address did not change on the document.
    expect(editedFields.map(String)).toContain("counterparty_email")

    // PDF status is ready again (re-rendered after the edit).
    expect(["ready", "pdf_a3_normalization_skipped"]).toContain(String(doc.pdf_status))

    // 5. Void-then-edit-rejected — SKIPPED. The invoicing manifest has no
    //    `documents_void` (or equivalent cancel) tool; the only tools that
    //    mutate document status are issue/mark-paid/record-refund/convert,
    //    none of which produce a `voided` status. There is no way to reach
    //    a voided document through the existing tool surface, so this
    //    scenario cannot exercise the documents_update-rejects-voided path.
  })
})
