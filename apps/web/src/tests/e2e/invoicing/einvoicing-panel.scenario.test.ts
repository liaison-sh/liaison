// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E-invoicing surfaces in the real app: the transmission panel on a document and the e-invoicing
// section of the invoicing settings. A consumer invoice is issued through the tool; a refused
// transmission is recorded on it (the platform's statuses arrive by the e-invoicing job, which
// this UI test does not drive), so the panel must show the buyer platform's verdict with its
// official code, the reason in words and the history, and offer no send. The settings section
// shows the platform switches and says, in plain words, that no platform is set.
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

test.describe("Invoicing: e-invoicing panel and settings", () => {
  test("a refused transmission shows its verdict, code, reason and history; settings show the platform section", async ({
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
          name: "Panel Customer",
          email: "panel@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const issue = await api(env.serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: installed.additionalContactIds[0],
            legal_name: "Panel Customer",
            country: "FR",
            vat_id: null,
            address: "3 rue du Panneau, 75011 Paris, France",
            email: "panel@e2e.test",
            customer_kind: "individual",
          },
          issuer_profile_id: installed.primaryIssuerProfileId,
          currency: "EUR",
          items: [
            {
              position: 1,
              description: "Contrôleur",
              quantity: "1",
              unit_price_minor: "20000",
              product_source: null,
              external_id: null,
            },
          ],
        },
      },
    })
    expect(issue.status).toBe(200)
    const documentId = unwrap(issue.body).document_id as string

    const inv = env.schemaPrefix ? `"${env.schemaPrefix}app_invoicing"` : "app_invoicing"
    await env.db.sql.unsafe(
      `INSERT INTO ${inv}.einvoice_transmissions
         (org_id, document_id, action, idempotency_key, provider_app, provider_ref, state, lifecycle_state, lifecycle_code,
          lifecycle_reason, lifecycle_log, approval_method, attempts)
       VALUES ($1, $2, 'send_einvoice', $3, 'pennylane', '4242', 'sent', 'refused', 210, 'Prix erroné', $4::text::jsonb, 'approval', 0)`,
      [
        world.org.id,
        documentId,
        `e2e-${documentId}`,
        JSON.stringify([
          {
            raw: "submitted",
            mapped: "deposited",
            code: 200,
            provider_ts: "2026-11-03T10:00:00Z",
            observed_at: "2026-11-03T10:00:02Z",
            source: "transmit",
          },
          {
            raw: "refused",
            mapped: "refused",
            code: 210,
            provider_ts: "2026-11-04T09:00:00Z",
            observed_at: "2026-11-04T09:00:01Z",
            source: "webhook",
            reason_text: "Prix erroné",
          },
        ]),
      ],
    )

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/document/${documentId}`)
    const panel = page.getByTestId("document-detail-einvoice-panel").first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("einvoice-panel-status").first()).toHaveText(
      "Refused by the buyer (210)",
    )
    await expect(page.getByTestId("einvoice-panel-attention").first()).toContainText("Prix erroné")
    await expect(page.getByTestId("einvoice-panel-timeline-entry")).toHaveCount(2)
    await expect(page.getByTestId("einvoice-panel-send")).toHaveCount(0)
    await expect(page.getByTestId("einvoice-panel-refresh").first()).toBeVisible()

    // The e-invoicing section of the app's declarative settings page (the old
    // /settings/invoicing path redirects there).
    await page.goto(`${viteUrl}/settings/invoicing`)
    const section = page.getByTestId("settings-section-einvoicing").first()
    await expect(section).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(/\/settings\/apps\/invoicing/)
    await expect(page.getByTestId("settings-einvoicing-registration").first()).toContainText(
      "No e-invoicing platform is set",
    )
    await expect(section.getByTestId("settings-input-provider_app")).toBeVisible()
    await expect(section.getByTestId("settings-input-send_enabled")).toBeVisible()
  })
})
