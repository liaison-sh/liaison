// SPDX-License-Identifier: FSL-1.1-ALv2
// API connector: settings and the customer card, end to end (S15, S18).
//
// The fixture CRM runs on 127.0.0.1 inside this test; the lane's API server
// may reach loopback because pwServerEnv sets
// LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true. Through the real UI:
//   1. the admin adds a connection by pasting the fixture adapter YAML and the
//      API key, then runs a READ operation from the Test panel (items shown;
//      the write operation is never offered);
//   2. a ticket whose requester is an Acme contact shows the customer card
//      with its summary and orders, and an unknown sender shows "no match"
//      naming the system;
//   3. a member without api-connector:read gets no card at all;
//   4. a mail conversation WE started shows the card for the first inbound
//      sender, collapsible from its header.
import { readFileSync } from "node:fs"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { FIXTURE_CRM_ADAPTER_FILE } from "../../../../api/src/modules/apps/connections/api/__fixtures__/fixture-crm/adapter"
import {
  type FixtureCrm,
  startFixtureCrm,
} from "../../../../api/src/modules/apps/connections/api/__fixtures__/fixture-crm/server"
import { expect, loginAs, test } from "./fixtures/test"
import { resolveContact } from "./helpers/contacts-seed"
import { seedMailAccount, seedMailConversation } from "./helpers/mail-fixtures"
import { seedInbox, seedTicket } from "./helpers/seed"

const ACME_CONTACT = "jane.doe@acme-instruments.example"
const API_KEY = "fixture-crm-e2e-key"

let crm: FixtureCrm | null = null

test.afterAll(async () => {
  await crm?.stop()
  crm = null
})

test("[API connector] settings, customer card on tickets and mail, scope gate", async ({
  page,
  env,
  qa,
  world,
  browser,
}) => {
  test.setTimeout(180_000)
  crm = startFixtureCrm({ apiKey: API_KEY })
  const orgId = world.org.id
  const web = `http://localhost:${env.ports[1]}`
  const stamp = Date.now()
  const slug = `crm-${stamp.toString(36).slice(-6)}`

  const login = await api(env.serverUrl, "/api/auth/login", {
    body: { email: qa.admin.email, password: "12345678" },
  })
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  const adminToken = login.body.data.accessToken as string

  // ── 1. Settings: add the connection, its key, and test a read ─────────────
  const adapterYaml = readFileSync(FIXTURE_CRM_ADAPTER_FILE, "utf8").replace(
    /^baseUrl: .*$/m,
    `baseUrl: ${crm.baseUrl}`,
  )
  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`${web}/settings/api-connector`)
  await expect(page.getByTestId("api-connector-settings-list")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("api-connector-add").click()
  await page.getByTestId("api-connector-slug").fill(slug)
  await page.getByTestId("api-connector-adapter-text").fill(adapterYaml)
  await page.getByTestId("api-connector-adapter-save").click()

  const row = page.getByTestId(`api-connector-connection-${slug}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  // The credentials form opens next, asking for exactly the apiKey field.
  await expect(page.getByTestId("api-connector-credentials-form")).toBeVisible()
  // The key is typed in the host's credential dialog, never in the app's own page.
  await page.getByTestId("api-connector-cred-save").click()
  const credDialog = page.getByTestId("connect-app-dialog")
  await expect(credDialog).toBeVisible({ timeout: 10_000 })
  await credDialog.getByTestId("connect-field-apiKey").fill(API_KEY)
  await credDialog.getByTestId("connect-submit").click()
  await expect(page.getByTestId("api-connector-cred-saved")).toBeVisible({ timeout: 10_000 })

  await page.getByTestId(`api-connector-test-${slug}`).click()
  const panel = page.getByTestId("api-connector-test-panel")
  await expect(panel).toBeVisible()
  const options = await panel
    .getByTestId("api-connector-test-operation")
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))
  expect(options).toContain("find_customers")
  expect(options).not.toContain("create_note")
  await panel.getByTestId("api-connector-test-operation").selectOption("find_customers")
  await panel.getByTestId("api-connector-param-email").fill(ACME_CONTACT)
  await panel.getByTestId("api-connector-test-run").click()
  await expect(panel.getByTestId("api-connector-test-result")).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByTestId("api-connector-test-status")).toContainText("200")
  await expect(panel.getByTestId("api-connector-test-row")).toHaveCount(1)
  await expect(panel.getByTestId("api-connector-test-items")).toContainText("Acme Instruments")
  // Projection: the fixture's internal fields never reach the page.
  await expect(panel.getByTestId("api-connector-test-items")).not.toContainText("volume discount")
  expect(crm.handler.requests.some((r) => r.startsWith("GET /v1/companies?"))).toBe(true)

  // ── 2. Tickets: the card for a known contact and for an unknown sender ────
  const inbox = await seedInbox(env, orgId, {
    name: `Connector inbox ${stamp}`,
    emailAddress: `connector-${stamp}@e2e.support`,
    isDefault: false,
  })
  const acme = await resolveContact(env, adminToken, {
    email: ACME_CONTACT,
    name: "Jane Doe",
    externalId: { e2e: `connector-acme-${stamp}` },
    // A ticket links only an org-visible contact.
    audience: "org",
  })
  const stranger = await resolveContact(env, adminToken, {
    email: `stranger-${stamp}@nowhere.example`,
    name: "Stranger",
    externalId: { e2e: `connector-stranger-${stamp}` },
    // A ticket links only an org-visible contact.
    audience: "org",
  })
  const acmeTicket = await seedTicket(env, orgId, {
    subject: `Calibration certificates ${stamp}`,
    sourceInboxId: inbox.id,
    contactId: acme.id,
  })
  const strangerTicket = await seedTicket(env, orgId, {
    subject: `A question ${stamp}`,
    sourceInboxId: inbox.id,
    contactId: stranger.id,
  })

  await page.goto(`${web}/tickets/${acmeTicket.id}`)
  // Every open tab stays mounted (hidden): only the active tab's card is visible.
  const ticketCard = page
    .getByTestId("tickets-detail-panel")
    .getByTestId("customer-card")
    .filter({ visible: true })
  await expect(ticketCard).toHaveAttribute("data-state", "match", { timeout: 20_000 })
  await expect(ticketCard.getByTestId("customer-card-name")).toHaveText("Acme Instruments")
  await expect(ticketCard.getByTestId("customer-card-system")).toHaveText("Fixture CRM")
  await expect(ticketCard.getByTestId("customer-card-list-orders")).toBeVisible()
  await expect(
    ticketCard.getByTestId("customer-card-list-orders").getByTestId("customer-card-row").first(),
  ).toBeVisible()

  await page.goto(`${web}/tickets/${strangerTicket.id}`)
  const noMatch = page
    .getByTestId("tickets-detail-panel")
    .getByTestId("customer-card")
    .filter({ visible: true })
  await expect(noMatch).toHaveAttribute("data-state", "no-match", { timeout: 20_000 })
  await expect(noMatch.getByTestId("customer-card-state-no-match")).toContainText("Fixture CRM")

  // ── 3. A member without the read scope sees no card ──────────────────────
  const member = await createUserWithScopes(env.serverUrl, env.db.sql, adminToken, orgId, {
    scopes: [
      "kernel:threads:read",
      "kernel:contacts:read",
      "tickets:tickets:read",
      "tickets:inboxes:read",
    ],
    dimensions: { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })
  // The data layer refuses the lookup itself, whatever the page does.
  const refused = await fetch(`${env.serverUrl}/api/apps/api-connector/tools/customer_lookup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ email: ACME_CONTACT }),
  })
  expect(refused.status).toBe(403)
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  try {
    await loginAs(memberPage, env, member.email, "Pass1234!")
    await memberPage.goto(`${web}/tickets/${acmeTicket.id}`)
    await expect(memberPage.getByTestId("tickets-detail-panel")).toBeVisible({ timeout: 20_000 })
    await memberPage.waitForLoadState("networkidle")
    await expect(memberPage.getByTestId("customer-card")).toHaveCount(0)
  } finally {
    await memberContext.close()
  }

  // ── 4. Mail: a thread we started, card under the header, collapsible ─────
  const mailbox = await seedMailAccount(env, orgId, {
    userId: qa.admin.id,
    email: `connector-${stamp}@e2e.mail`,
  })
  const subject = `Your volume quote ${stamp}`
  const { conversationId } = await seedMailConversation(env, orgId, {
    accountId: mailbox.accountId,
    subject,
    lastMessageAt: new Date().toISOString(),
    messages: [
      {
        direction: "outbound",
        from: { name: "Us", email: `connector-${stamp}@e2e.mail` },
        to: [{ email: ACME_CONTACT }],
        textBody: "Here is the quote for twelve units.",
        sentAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
      {
        direction: "inbound",
        from: { name: "Jane Doe", email: ACME_CONTACT },
        to: [{ email: `connector-${stamp}@e2e.mail` }],
        textBody: "Can the units ship in two batches?",
        sentAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  })

  await page.goto(`${web}/mail/${conversationId}`)
  const mailCard = page.getByTestId("customer-card").filter({ visible: true })
  await expect(mailCard).toHaveAttribute("data-state", "match", { timeout: 20_000 })
  await expect(mailCard.getByTestId("customer-card-name")).toHaveText("Acme Instruments")
  await expect(mailCard).toHaveAttribute("data-collapsed", "false")
  await expect(mailCard.getByTestId("customer-card-body")).toBeVisible()
  await mailCard.getByTestId("customer-card-toggle").click()
  await expect(mailCard).toHaveAttribute("data-collapsed", "true")
  await expect(mailCard.getByTestId("customer-card-body")).toHaveCount(0)
  await mailCard.getByTestId("customer-card-toggle").click()
  await expect(mailCard).toHaveAttribute("data-collapsed", "false")
  await expect(mailCard.getByTestId("customer-card-body")).toBeVisible()
})
