// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S10 Bulk per-item failure remains visible without aborting.
// (e2e-plan §S10, spec §1.3 criterion 17, §3.3 failure modes.)
//
// Drives bulk-assign on two real tickets while injecting one bogus ticket id
// into the dispatched ids[] payload. Asserts the response reports two
// successes and one per-item failure with the bogus id surfaced.

import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"
import { seedInbox, seedTicket } from "./helpers/seed"
import { indexSeededTickets, searchInboxFor } from "./helpers/tickets-search"

test("bulk per-item failure surfaces alongside successful items", async ({
  page,
  env,
  qa,
  world,
}) => {
  const prefix = `s10-${randomUUID().slice(0, 6)}`
  const inbox = await seedInbox(env, world.org.id, {
    name: `S10Inbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const valid1 = await seedTicket(env, world.org.id, {
    subject: `${prefix} valid A`,
    sourceInboxId: inbox.id,
  })
  const valid2 = await seedTicket(env, world.org.id, {
    subject: `${prefix} valid B`,
    sourceInboxId: inbox.id,
  })
  const bogusId = randomUUID()
  await indexSeededTickets(env, { email: qa.admin.email, password: "12345678" }, prefix, [
    valid1.id,
    valid2.id,
  ])

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${valid1.id}`)).toBeVisible({ timeout: 15000 })
  await searchInboxFor(page, prefix, [valid1.id, valid2.id])
  await page.getByTestId(`tickets-row-checkbox-${valid1.id}`).check()
  await page.getByTestId(`tickets-row-checkbox-${valid2.id}`).check()
  await expect(page.getByTestId("bulk-selection-count")).toHaveText("2 selected")

  await page.getByTestId("bulk-action-assign").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await page.getByTestId("bulk-field-assignedTo").fill(qa.amina.id)

  // Inject one bogus id into the bulk-assign POST body so the dispatcher
  // surfaces a per-item failure for it.
  const allIds = [valid1.id, valid2.id, bogusId]
  await page.evaluate(
    ({ ids }) => {
      const origFetch = window.fetch
      ;(window as any).__origFetch = origFetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url
        if (url.includes("/api/apps/tickets/bulk/assign") && init?.body) {
          try {
            const parsed = JSON.parse(init.body as string) as Record<string, unknown>
            parsed.ids = ids
            return origFetch(input, { ...init, body: JSON.stringify(parsed) })
          } catch {}
        }
        return origFetch(input, init)
      }) as typeof window.fetch
    },
    { ids: allIds },
  )

  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/assign") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  const resp = await dispatchResp
  await page.evaluate(() => {
    if ((window as any).__origFetch) window.fetch = (window as any).__origFetch
  })

  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as {
    data: {
      bulkRequestId: string
      total: number
      succeeded: number
      failed: number
      errors: Array<{ id: string }>
    }
  }
  expect(body.data.total).toBe(3)
  expect(body.data.succeeded).toBe(2)
  expect(body.data.failed).toBe(1)
  expect(body.data.errors.map((e) => e.id)).toContain(bogusId)

  // Wait for the outcome row to render the per-item error UI before snapping.
  await expect(page.getByTestId("bulk-outcome")).toBeVisible({ timeout: 5000 })
  const errList = page.getByTestId("bulk-outcome-errors")
  await expect(errList).toBeVisible({ timeout: 5000 })
  await expect(errList).toContainText(bogusId)
  await expect(page.getByTestId("bulk-toolbar")).toHaveScreenshot(
    "phase9-bulk-toolbar-outcome-errors.png",
    { maxDiffPixelRatio: 0.05 },
  )
})
