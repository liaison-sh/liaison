// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received tab in the real app. Two supplier e-invoices are mirrored (the platform's arrival
// and statuses come through the e-invoicing job, which this UI test does not drive): one just
// received, one refused. The list shows both with their status in words and code, the status
// filter narrows it, a row opens its own tab; on the open invoice a person picks a reason from the
// platform's list and asks for the refusal, which runs on her own permission (nothing parked) and
// says what the platform answered; the refused invoice offers no action and says why.
import { loginAs } from "../fixtures/test"
import { grantScopes } from "../helpers/agent-seed"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

const REASONS = [
  {
    reason: "duplicate_invoice",
    afnor_code: "DOUBLON",
    label_en: "Duplicate invoice",
    label_fr: "Facture en double",
  },
  {
    reason: "incorrect_vat_rate",
    afnor_code: "TX_TVA_ERR",
    label_en: "Incorrect VAT rate",
    label_fr: "Taux de TVA erroné",
  },
]

test.describe("Invoicing: the Received tab", () => {
  test("lists received supplier e-invoices, filters by status, a member's refusal runs on her own permission with nothing parked, offers nothing on a refused one", async ({
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
    const inv = env.schemaPrefix ? `"${env.schemaPrefix}app_invoicing"` : "app_invoicing"
    const kernel = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const insert = async (o: {
      ref: string
      number: string
      status: string
      code: number | null
      actions: unknown[]
      received: string
    }) => {
      const [row] = await env.db.sql.unsafe(
        `INSERT INTO ${inv}.received_einvoices
           (org_id, provider_app, provider_ref, supplier_name, supplier_siren, invoice_number, issue_date, due_date, currency,
            total_before_tax, total_tax, total, status, status_raw, status_code, lifecycle_log, actions, payment_linked,
            received_at, last_synced_at, files_pending)
         VALUES ($1, 'pennylane', $2, 'Fournisseur Exemple', '732829320', $3, '2026-11-03', '2026-12-03', 'EUR',
           '100.0', '20.0', '120.0', $4, $5, $6, $7::text::jsonb, $8::text::jsonb, false, $9, $9, false)
         RETURNING id`,
        [
          world.org.id,
          o.ref,
          o.number,
          o.status,
          o.status === "received" ? null : o.status,
          o.code,
          JSON.stringify([
            {
              raw: null,
              mapped: "received",
              code: null,
              provider_ts: o.received,
              observed_at: o.received,
              source: "webhook",
            },
          ]),
          JSON.stringify(o.actions),
          o.received,
        ],
      )
      return (row as unknown as { id: string }).id
    }
    const open = await insert({
      ref: "9101",
      number: "FS-2026-101",
      status: "received",
      code: null,
      actions: [
        { action: "refuse", reasons: REASONS, comment: false },
        { action: "dispute", reasons: REASONS, comment: false },
      ],
      received: "2026-11-03T08:00:00Z",
    })
    const refused = await insert({
      ref: "9102",
      number: "FS-2026-102",
      status: "refused",
      code: 210,
      actions: [],
      received: "2026-11-02T08:00:00Z",
    })

    // Amina may read the received invoices and ask for a decision on one, but
    // holds no approve scope.
    await grantScopes(env, world.org.id, qa.amina.id, [
      "invoicing:received:read",
      "invoicing:received:write",
    ])
    await loginAs(page, env, qa.amina.email, "QaPass1!")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/invoicing/received`)
    await expect(page.getByTestId("received-table").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`received-row-status-${open}`)).toHaveText("Received")
    await expect(page.getByTestId(`received-row-status-${refused}`)).toHaveText("Refused (210)")

    await page.getByTestId("received-filter-refused").click()
    await expect(page.getByTestId(`received-row-${refused}`)).toBeVisible()
    await expect(page.getByTestId(`received-row-${open}`)).toHaveCount(0)
    await page.getByTestId("received-filter-all").click()

    await page.getByTestId(`received-row-${open}`).click()
    await expect(page.getByTestId("received-detail-title").first()).toHaveText(
      "Fournisseur Exemple · FS-2026-101",
      { timeout: 20_000 },
    )
    await page.getByTestId("received-action-refuse").click()
    await expect(page.getByTestId("received-action-submit")).toBeDisabled()
    await page.getByTestId("received-action-reason").selectOption("duplicate_invoice")
    await page.getByTestId("received-action-comment").fill("Billed twice")
    await page.getByTestId("received-action-submit").click()
    const dialog = page.getByTestId("received-action-confirm")
    // Approvals are for agents: a person's own request runs on the tool's own
    // permission (received:write, which shows this button); the approve
    // permission plays no part, so the confirm no longer names it.
    await expect(dialog).toContainText("This is sent to the supplier's platform now.")
    await expect(dialog).not.toContainText("approve permission")
    await dialog.getByRole("button", { name: "Confirm" }).click()
    // It runs on Amina's own authority, nothing parked: this org has no
    // e-invoicing platform bound, so the action says so and changes nothing.
    const note = page.getByTestId("received-action-note")
    await expect(note).toContainText("No provider is bound", { timeout: 20_000 })
    const approvals = (await env.db.sql.unsafe(
      `SELECT status FROM ${kernel}.approval_requests WHERE org_id = $1 AND tool_name LIKE 'invoicing:received_einvoice%'`,
      [world.org.id],
    )) as unknown as Array<{ status: string }>
    expect(approvals).toHaveLength(0)
    await expect(page.getByTestId("received-detail-status").filter({ visible: true })).toHaveText(
      "Received",
    )

    await page.goto(`${viteUrl}/invoicing/received/${refused}`)
    // Every opened tab stays mounted (hidden): read the visible detail, not the first one.
    await expect(page.getByTestId("received-detail-status").filter({ visible: true })).toHaveText(
      "Refused (210)",
      {
        timeout: 20_000,
      },
    )
    await expect(page.getByTestId("received-no-action").filter({ visible: true })).toContainText(
      "refused",
    )
    // The earlier (still open, now hidden) tab keeps its actions: count the
    // visible detail's only.
    await expect(page.getByTestId("received-action-refuse").filter({ visible: true })).toHaveCount(
      0,
    )
    await expect(page.getByTestId("received-action-dispute").filter({ visible: true })).toHaveCount(
      0,
    )
  })
})
