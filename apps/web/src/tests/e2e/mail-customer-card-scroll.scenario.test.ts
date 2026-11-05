// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mail conversation with the Customer card open under its header (walk D64).
// The card's column is capped, so a tall card is cut where the thread begins.
// It was cut mid-row with nothing between it and the thread: the first
// message's avatar and bubble ran straight into half an order row, so the
// thread read as drawn over the card's amounts and statuses. Now the column
// fades its cut edge out whenever more of the card lies below it, and the
// thread never covers a row that is on screen.

import { readFileSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { FIXTURE_CRM_ADAPTER_FILE } from "../../../../api/src/apps/api-connector/__fixtures__/fixture-crm/adapter"
import {
  type FixtureCrm,
  startFixtureCrm,
} from "../../../../api/src/apps/api-connector/__fixtures__/fixture-crm/server"
import { expect, loginAs, test } from "./fixtures/test"
import { seedMailAccount, seedMailConversation } from "./helpers/mail-fixtures"

const SEE = { timeout: 20_000 } as const
const ACME_CONTACT = "jane.doe@acme-instruments.example"
const API_KEY = "fixture-crm-card-scroll-key"

let crm: FixtureCrm | null = null

test.afterAll(async () => {
  await crm?.stop()
  crm = null
})

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

test("mail.customer-card-stays-above-the-scrolled-thread", async ({
  page,
  env,
  qa,
  world,
}, testInfo) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const web = `http://localhost:${env.ports[1]}`
  const orgId = world.org.id
  const stamp = Date.now()

  const login = await api(env.serverUrl, "/api/auth/login", {
    body: { email: qa.admin.email, password: "12345678" },
  })
  expect(login.status, JSON.stringify(login.body)).toBe(200)

  // A thread long enough to scroll, with a customer the connected CRM knows.
  const mailbox = await seedMailAccount(env, orgId, {
    userId: qa.admin.id,
    email: `card-${stamp}@e2e.mail`,
  })
  const subject = `Your volume quote ${stamp}`
  const paragraph =
    "We would be glad to prepare the quote with our current lead time and dealer terms. "
  const { conversationId } = await seedMailConversation(env, orgId, {
    accountId: mailbox.accountId,
    subject,
    lastMessageAt: new Date().toISOString(),
    messages: Array.from({ length: 6 }, (_, i) => {
      const inbound = i % 2 === 0
      return {
        direction: inbound ? ("inbound" as const) : ("outbound" as const),
        from: inbound
          ? { name: "Jane Doe", email: ACME_CONTACT }
          : { name: "Us", email: `card-${stamp}@e2e.mail` },
        to: [{ email: inbound ? `card-${stamp}@e2e.mail` : ACME_CONTACT }],
        textBody: `${i + 1}. ${paragraph.repeat(8)}`,
        sentAt: new Date(Date.now() - (6 - i) * 3_600_000).toISOString(),
      }
    }),
  })

  await loginAs(page, env, qa.admin.email, "12345678")

  // The connected CRM, added as an admin does (the api-connector scenario's steps).
  crm = startFixtureCrm({ apiKey: API_KEY })
  const slug = `crm-${stamp.toString(36).slice(-6)}`
  await page.goto(`${web}/settings/api-connector`)
  await expect(page.getByTestId("api-connector-settings-list")).toBeVisible(SEE)
  await page.getByTestId("api-connector-add").click()
  await page.getByTestId("api-connector-slug").fill(slug)
  await page
    .getByTestId("api-connector-adapter-text")
    .fill(
      readFileSync(FIXTURE_CRM_ADAPTER_FILE, "utf8").replace(
        /^baseUrl: .*$/m,
        `baseUrl: ${crm.baseUrl}`,
      ),
    )
  await page.getByTestId("api-connector-adapter-save").click()
  await expect(page.getByTestId(`api-connector-connection-${slug}`)).toBeVisible(SEE)
  await page.getByTestId("api-connector-cred-apiKey").fill(API_KEY)
  await page.getByTestId("api-connector-cred-save").click()
  await expect(page.getByTestId("api-connector-cred-saved")).toBeVisible(SEE)

  await page.goto(`${web}/mail/${conversationId}`)
  const card = page.getByTestId("customer-card").filter({ visible: true })
  await expect(card).toHaveAttribute("data-state", "match", SEE)
  await expect(card).toHaveAttribute("data-collapsed", "false")
  const rows = card.getByTestId("customer-card-row")
  await expect(rows.first()).toBeVisible(SEE)
  const scroll = page.getByTestId("mail-conversation-scroll").filter({ visible: true })

  for (const top of [0, 150, 300, 600, 10_000]) {
    await scroll.evaluate((el, y) => {
      el.scrollTop = y
    }, top)
    await settle(page)
    await page.waitForTimeout(200)
    await page.screenshot({ path: testInfo.outputPath(`mail-card-scrolled-${top}-1280.png`) })
    // Each row's left and right ends (its number, its amount and status) are
    // the card's own pixels, never a message drawn over them.
    const covered = await rows.evaluateAll((els) =>
      els.flatMap((row) => {
        const r = row.getBoundingClientRect()
        if (r.height === 0) return []
        const cardEl = row.closest("[data-testid='customer-card']")
        // A row the banner column scrolled out of its own view is not on screen.
        const column = row.closest("[data-testid='mail-conversation-banners']")
        const view = (column ?? cardEl)?.getBoundingClientRect()
        const y = r.top + r.height / 2
        if (view && (y < view.top || y > view.bottom)) return []
        const points = [
          [r.left + 4, y],
          [r.right - 4, y],
        ] as const
        return points.flatMap(([x, y]) => {
          const hit = document.elementFromPoint(x, y)
          if (!hit || cardEl?.contains(hit)) return []
          const at = hit.closest("[data-testid]")?.getAttribute("data-testid") ?? hit.tagName
          return [`${row.textContent?.trim().slice(0, 16)} @${Math.round(x)}: ${at}`]
        })
      }),
    )
    expect(covered, `scrolled to ${top}`).toEqual([])
    // The column cuts the card: its lower edge fades out, never a bare cut.
    const column = page.getByTestId("mail-conversation-banners").filter({ visible: true })
    const edge = await column.evaluate((el) => {
      const cut = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      const fade = el.parentElement?.querySelector<HTMLElement>("[data-testid='scroll-fade-end']")
      return { cut, faded: fade ? getComputedStyle(fade).opacity === "1" : false }
    })
    if (top === 0) expect(edge.cut, "the card is taller than its column").toBe(true)
    expect.soft(edge.faded, `scrolled to ${top}`).toBe(edge.cut)
  }
  // Scrolled to the card's end, the column shows it whole, its own edge.
  const column = page.getByTestId("mail-conversation-banners").filter({ visible: true })
  await column.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await settle(page)
  await page.waitForTimeout(200)
  await page.screenshot({ path: testInfo.outputPath("mail-card-column-end-1280.png") })
  expect(
    await column.evaluate((el) => {
      const fade = el.parentElement?.querySelector<HTMLElement>("[data-testid='scroll-fade-end']")
      return fade ? getComputedStyle(fade).opacity : "missing"
    }),
  ).toBe("0")
})
