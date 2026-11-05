// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-settings — S10/S14: the admin's one Tickets settings page (old
// per-section URLs redirect to it) shows the seeded inbox and category, an
// inbox disconnects, and the response-time and API-key sections are there.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox } from "./helpers/seed"
import { grantSupportAgent } from "./helpers/settings-roles"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC13] tickets-settings: admin opens the Tickets page and disconnects a seeded inbox", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()

  // Seed two inboxes so the table renders multiple rows and we can disconnect one.
  const inboxA = await seedInbox(env, orgId, {
    name: `Settings inbox A ${stamp}`,
    emailAddress: `settings-a-${stamp}@e2e.test`,
    isDefault: true,
  })
  const inboxB = await seedInbox(env, orgId, {
    name: `Settings inbox B ${stamp}`,
    emailAddress: `settings-b-${stamp}@e2e.test`,
    isDefault: false,
  })

  // Seed a category so the categories tree renders a row.
  const categoryName = `Settings category ${stamp}`
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.categories (id, org_id, parent_id, name, sort_order, archived_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, NULL, $2, 0, NULL, now(), now())`,
    [orgId, categoryName],
  )

  await loginAs(page, env, qa.admin.email, "12345678")

  // 1) The former Inboxes URL lands on the one Tickets page; rows render, disconnect one.
  await page.goto(`http://localhost:${env.ports[1]}/settings/tickets/inboxes`)
  await expect(page).toHaveURL(/\/settings\/apps\/tickets/, { timeout: 10000 })
  await expect(page.getByTestId("tickets-inbox-routing")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-inboxes-row-${inboxA.id}`)).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-inboxes-row-${inboxB.id}`)).toBeVisible()
  await page.getByTestId(`tickets-inboxes-disconnect-${inboxB.id}`).click()
  await page.getByTestId("tickets-inboxes-disconnect-dialog-confirm").click()
  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT archived_at FROM ${ts(env)}.inboxes WHERE id = $1`,
        [inboxB.id],
      )
      return rows[0]?.archived_at ?? null
    })
    .not.toBeNull()
  // After refresh, archived row shows "archived" status text and no Disconnect button.
  await expect(page.getByTestId(`tickets-inboxes-disconnect-${inboxB.id}`)).toHaveCount(0)

  // 2) Categories: the tree renders the seeded row.
  const categories = page.getByTestId("settings-section-categories")
  await expect(categories).toBeVisible()
  await expect(categories.getByText(categoryName)).toBeVisible({ timeout: 10000 })

  // 3) Response times & email: a target field is there.
  await expect(page.getByTestId("settings-section-response-times")).toBeVisible()
  await expect(page.getByTestId("settings-input-sla.targets.normal")).toBeVisible()

  // 4) API keys: the list and its create action.
  const keys = page.getByTestId("settings-section-api-keys")
  await expect(keys).toBeVisible()
  await expect(keys.getByTestId("settings-list-add")).toBeVisible()
})

test("[SC13] tickets-settings: non-admin actor cannot reach Tickets admin pages", async ({
  page,
  env,
  world,
  qa,
}) => {
  // Amina works tickets (a support agent) without tickets:settings:admin: the
  // Tickets page shows her own signature, never the organization's API keys.
  await grantSupportAgent(env, world.org.id, qa.amina.id)
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/settings/tickets/api-keys`)
  await expect(page.getByTestId("settings-section-signature")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("settings-section-api-keys")).toHaveCount(0)
})
