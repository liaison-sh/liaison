// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-sla-exempt — the per-inbox "No SLA" toggle (inboxes.sla_exempt). An
// admin opens an inbox's config in Tickets settings, flips "No SLA", saves, and
// the flag round-trips to the DB. This is the operator-configurable switch that
// makes a bug-report / monitoring inbox's tickets carry no SLA (no deadline, no
// breach) — configured per virtual mailbox, not hardcoded.
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("tickets-sla-exempt: admin toggles per-inbox No-SLA and it persists", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()

  const inbox = await seedInbox(env, orgId, {
    name: `SLA-exempt inbox ${stamp}`,
    emailAddress: `sla-exempt-${stamp}@e2e.test`,
    isDefault: true,
  })

  // Sanity: a freshly seeded inbox is NOT sla-exempt.
  const before = await env.db.sql.unsafe(
    `SELECT sla_exempt FROM ${ts(env)}.inboxes WHERE id = $1`,
    [inbox.id],
  )
  expect(before[0]?.sla_exempt).toBe(false)

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/tickets/inboxes`)
  await expect(page.getByTestId("tickets-inbox-routing")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId(`tickets-inboxes-row-${inbox.id}`)).toBeVisible({ timeout: 10000 })

  // Open the inbox config, revealing the per-inbox toggles.
  await page.getByTestId(`tickets-inboxes-configure-${inbox.id}`).click()
  const toggle = page.getByTestId(`tickets-inboxes-sla-exempt-${inbox.id}`)
  await expect(toggle).toBeVisible({ timeout: 10000 })
  expect(await toggle.isChecked()).toBe(false)

  // Screenshot the settings row with the "No SLA" control visible (deliverable).
  await page
    .getByTestId(`tickets-inboxes-row-${inbox.id}`)
    .screenshot({ path: "/tmp/tickets-sla-exempt-toggle.png" })

  // Flip "No SLA" and save.
  await toggle.check()
  const saveResp = page.waitForResponse(
    (r) =>
      r.url().includes("/api/apps/run-tool") &&
      (r.request().postDataJSON() as { toolName?: string } | null)?.toolName ===
        "tickets:inboxes.update",
  )
  await page.getByTestId(`tickets-inboxes-save-${inbox.id}`).click()
  const saved = await saveResp
  expect(saved.status(), await saved.text()).toBe(200)

  // The flag round-trips to the DB.
  await expect
    .poll(
      async () => {
        const rows = await env.db.sql.unsafe(
          `SELECT sla_exempt FROM ${ts(env)}.inboxes WHERE id = $1`,
          [inbox.id],
        )
        return rows[0]?.sla_exempt ?? null
      },
      { timeout: 10000 },
    )
    .toBe(true)
})
