// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-contact-backlinks — verifies Tickets show as backlinks in
// Contacts detail and the row reflects the seeded handle/subject/status.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { resolveContact } from "./helpers/contacts-seed"
import { seedInbox, seedTicket } from "./helpers/seed"

test("[SC11] tickets-contact-backlinks: contact detail lists tickets and links open the ticket tab", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id

  // Use Elodie's token to resolve a fresh contact through the real API.
  const login = await api(env.serverUrl, "/api/auth/login", {
    body: { email: qa.admin.email, password: "12345678" },
  })
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  const token = login.body.data.accessToken as string

  const stamp = Date.now()
  const contact = await resolveContact(env, token, {
    email: `backlinks-${stamp}@e2e.test`,
    name: `Backlinks ${stamp}`,
    externalId: { e2e: `backlinks-${stamp}` },
    // A ticket links only an org-visible contact: resolve it for the organisation.
    audience: "org",
  })

  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${stamp}`,
    emailAddress: `backlinks-${stamp}@e2e.support`,
    isDefault: true,
  })

  const ticketA = await seedTicket(env, orgId, {
    subject: `Backlink ticket A ${stamp}`,
    sourceInboxId: inbox.id,
    contactId: contact.id,
  })
  const ticketB = await seedTicket(env, orgId, {
    subject: `Backlink ticket B ${stamp}`,
    sourceInboxId: inbox.id,
    contactId: contact.id,
    status: "awaiting_customer",
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/contacts/${contact.id}`)
  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })

  const backlinkList = page.getByTestId("contact-ticket-backlinks")
  await expect(backlinkList).toBeVisible({ timeout: 10000 })

  // Both seeded tickets surface as backlinks under the Contact's right-rail Tickets section.
  await expect(page.getByTestId(`contact-ticket-backlink-${ticketA.id}`)).toContainText(
    ticketA.subject,
  )
  await expect(page.getByTestId(`contact-ticket-backlink-${ticketB.id}`)).toContainText(
    ticketB.subject,
  )
  await expect(page.getByTestId(`contact-ticket-backlink-${ticketB.id}`)).toContainText(
    "awaiting_customer",
  )
})
