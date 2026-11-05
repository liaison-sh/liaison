// SPDX-License-Identifier: FSL-1.1-ALv2
// workspace.ticket-project-tabs-preserve-state — open ticket detail, type into the reply
// composer, switch to a project workspace tab, switch back, verify composer text persisted.
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"

const TICKET_SCOPES = ["tickets:tickets:read", "tickets:tickets:write"]
const PROJECT_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

async function grantAll(env: { db: { sql: any } }, orgId: string) {
  for (const scope of [...TICKET_SCOPES, ...PROJECT_SCOPES]) {
    await env.db
      .sql`INSERT INTO kernel.role_scope_grants (role_id, scope) SELECT id, ${scope} FROM kernel.roles WHERE org_id = ${orgId} ON CONFLICT DO NOTHING`
  }
}

test("workspace.ticket-project-tabs-preserve-state + visual baselines", async ({
  authenticatedPage: page,
  env,
  qa,
  world,
}) => {
  await grantAll(env, world.org.id)

  // Seed a ticket + a project so both tabs can mount.
  const stamp = Date.now()
  const inbox = await seedInbox(env, world.org.id, {
    name: `TabState-${stamp}`,
    emailAddress: `tabstate-${stamp}@e2e.test`,
  })
  const inboxId = inbox.id
  const seededTicket = await seedTicket(env, world.org.id, {
    subject: "State preservation",
    sourceInboxId: inboxId,
  })
  const ticketId = seededTicket.id

  const projectRes = await api(env.serverUrl, "/api/projects", {
    token: qa.admin.token,
    body: { name: `TabState-${stamp}` },
  })
  expect(projectRes.status, JSON.stringify(projectRes.body)).toBe(200)
  const projectId = (projectRes.body.data as { id: string }).id

  // SPA-internal navigation: history.pushState + popstate stays within the same
  // page load so all open tabs stay mounted (display:none keep-alive). Using
  // page.goto() would force a full reload and reset every component's state.
  const spaNavigate = async (url: string) => {
    await page.evaluate((u) => {
      window.history.pushState({}, "", u)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, url)
  }

  // Open ticket detail tab + type into composer
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticketId}`)
  await page.waitForSelector("[data-testid='tickets-composer-body']", { timeout: 15_000 })
  const draftText = `keep-alive draft ${stamp}`
  await page.getByTestId("tickets-composer-body").fill(draftText)

  // Open a project workspace tab without closing the ticket tab — in-app navigation
  await spaNavigate(`/projects/${projectId}`)
  await page.waitForSelector("[data-testid='project-workspace']", { timeout: 15_000 })

  // Switch back to the ticket — keep-alive must preserve the reply being written
  await spaNavigate(`/tickets/${ticketId}`)
  await page.waitForSelector("[data-testid='tickets-composer-body']", { timeout: 15_000 })
  await expect(page.getByTestId("tickets-composer-body")).toHaveText(draftText)
})
