// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An invoice from a month's planned vs done card, on the real product: a project billed by the
// day, with its company and the company's billing contact, closes two tasks this month. The agent draws the card (only
// the model is scripted, the tool runs for real); the person presses Create invoice on it, which
// makes a draft with no number; the draft's request waits in Invoicing's Pending Approval tab, the
// sidebar's link; the person opens it there and issues it from its page, which takes the number.
import { openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "../agent-turn"
import { loginAs } from "../fixtures/test"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { seedFactory } from "../helpers/seed"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

const DRAWN = "Here is the month's planned vs done card."
const SEE = { timeout: 30_000 } as const

interface BillableProject {
  projectId: string
  key: string
  month: string
  taskIds: string[]
}

test.describe("Invoicing: an invoice from planned vs done", () => {
  test.setTimeout(300_000)

  test("a person creates from the card and issues from the pending list", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // The person runs the project's time and rates and issues invoices.
    await seedFactory(env, world.org.id, "roles.grantScopes", {
      userId: qa.admin.id,
      scopes: ["projects:*", "invoicing:*"],
      name: "e2e-billing",
      onlyMissing: true,
    })
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
    })
    const project = await seedFactory<BillableProject>(
      env,
      world.org.id,
      "projects.billableMonth",
      {
        ownerId: qa.admin.id,
        key: "LUNE",
        name: "Maison Lune platform",
        company: "Maison Lune",
        contactName: "Claire Lune",
        contactEmail: "claire@lune.example",
        billingAddress: {
          street1: "12 Harbor Lane",
          postalCode: "97209",
          city: "Portland",
          countryIso2: "US",
        },
        rateMinor: 93_000,
        currency: "EUR",
        tasks: [
          { title: "Data export", days: 3 },
          { title: "Monitoring", days: 4 },
        ],
      },
    )
    await seedModelPricingAndCredits(env, world.org.id)
    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        {
          toolCalls: [
            { name: "kernel__tool_search", args: { query: "select:projects__reconcile_propose" } },
          ],
        },
        {
          toolCalls: [
            {
              name: "projects__reconcile_propose",
              args: {
                project: project.key,
                month: project.month,
                lines: [
                  { name: "Data export", taskIds: [project.taskIds[0]], proofs: [] },
                  { name: "Monitoring", taskIds: [project.taskIds[1]], proofs: [] },
                ],
              },
            },
          ],
        },
        { text: DRAWN },
      ],
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "reconcile this month for Maison Lune")
    await waitForTurnEnd(env, { threadId, token, contains: DRAWN })

    // The card prices the month and offers Create invoice; pressing it makes a draft, no number.
    const create = conversation
      .getByTestId("card-action")
      .filter({ hasText: /^Create invoice$/ })
      .first()
    await expect(create).toBeVisible(SEE)
    await create.click()
    await expect(conversation.getByTestId("card-summary").first()).toBeVisible(SEE)
    const before = await env.db.sql.unsafe(
      `SELECT id::text AS id, status, number FROM "${env.schemaPrefix}app_invoicing".documents
        WHERE org_id = $1 AND billing_project_id = $2`,
      [world.org.id, project.projectId],
    )
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ status: "draft", number: null })
    const draftId = String(before[0]?.id)

    // The sidebar's Pending Approval link opens a tab that lists the draft's request.
    const base = `http://localhost:${env.ports[1]}`
    await page.goto(`${base}/invoicing/pending-approval`)
    const pending = page.getByTestId("invoicing-pending")
    await expect(pending).toBeVisible(SEE)
    const open = pending.locator(`[data-testid^="pending-open-"]`).first()
    await expect(open).toBeVisible(SEE)
    await open.click()
    await page.waitForURL(new RegExp(`/invoicing/document/${draftId}`), SEE)

    // Its page says where it came from and that it has no number; one button issues it.
    const panel = page.getByTestId("sourced-draft")
    await expect(panel).toBeVisible(SEE)
    await expect(panel.getByTestId("sourced-draft-badge")).toHaveText("From planned vs done")
    await expect(panel.getByTestId("sourced-draft-no-number")).toBeVisible()
    const issue = panel.getByTestId("sourced-draft-issue")
    await expect(issue).toHaveText(/^Issue, .*6.510\.00 EUR excl\. VAT$/)
    await issue.click()

    await expect
      .poll(
        async () => {
          const rows = await env.db.sql.unsafe(
            `SELECT status, number, external_ref, billing_project_id::text AS project
               FROM "${env.schemaPrefix}app_invoicing".documents
              WHERE org_id = $1 AND billing_project_id = $2 AND number IS NOT NULL`,
            [world.org.id, project.projectId],
          )
          return rows[0] ?? null
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "issued", project: project.projectId })
    const [issued] = await env.db.sql.unsafe(
      `SELECT external_ref FROM "${env.schemaPrefix}app_invoicing".documents
        WHERE org_id = $1 AND billing_project_id = $2 AND number IS NOT NULL`,
      [world.org.id, project.projectId],
    )
    expect(String(issued?.external_ref)).toMatch(/^reconcile:/)
  })
})
