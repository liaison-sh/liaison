// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIF-3: the chat dock sits in the main panel's bottom right corner, and a
// thread's message list used to scroll its last message under it. Scrolled to
// the end, the last message must end ABOVE the dock: above the bar, and above
// the open dock window (here the Chats roster) while one is up.

import { api } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

const SEE = { timeout: 20_000 } as const

async function scrollListToEnd(page: Page): Promise<void> {
  await page.getByTestId("message-scroll-container").evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  // Two frames: the reserve and the pin settle on the frame after a change.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

async function bottomOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error("element has no layout box")
  return box.y + box.height
}

async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error("element has no layout box")
  return box.y
}

test("dock.message-list-clears-the-dock", async ({ page, env, qa }) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: "Dock clearance thread",
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "first" },
    },
  })
  expect(threadRes.status).toBe(200)
  const threadId: string = threadRes.body.data.id
  const lastText = "the very last message of the thread"
  for (let i = 0; i < 24; i++) {
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token: qa.admin.token,
      body: { content: i === 23 ? lastText : `filler message number ${i + 1}` },
    })
    expect(res.status).toBe(200)
  }

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  const lastRow = page.getByTestId("message-row").filter({ hasText: lastText })
  await expect(lastRow).toBeVisible(SEE)

  // 1. The dock strip alone.
  const bar = page.locator("[data-dock-bar]")
  await expect(bar).toBeVisible(SEE)
  await scrollListToEnd(page)
  expect(await bottomOf(lastRow)).toBeLessThanOrEqual(await topOf(bar))

  // 1b. At desktop the bar is anchored flush to the corner and nothing
  // reserves a band for it: the tab's wrapper pads nothing and the composer
  // keeps only its own 14px, ending at the panel's bottom edge. Its send stays
  // clickable: the button's centre is above the bar.
  const composer = page.getByTestId("compose-dropzone")
  const panelBottom = await bottomOf(page.getByTestId("main-panel"))
  const reserve = await page
    .getByTestId("app-tab-scroll")
    .filter({ has: composer })
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom))
  expect(reserve).toBe(0)
  expect(
    await composer.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom)),
  ).toBe(14)
  expect(Math.abs(panelBottom - (await bottomOf(composer)))).toBeLessThanOrEqual(1)
  expect(Math.abs(panelBottom - (await bottomOf(bar)))).toBeLessThanOrEqual(1)
  const send = (await page.getByTestId("compose-send").first().boundingBox())!
  expect(send.y + send.height / 2).toBeLessThan(await topOf(bar))

  // 2. A dock window open over the corner: the Chats roster.
  await page.getByRole("button", { name: "Chats", exact: true }).click()
  const dockWindow = page.getByTestId("chats-panel")
  await expect(dockWindow).toBeVisible(SEE)
  await scrollListToEnd(page)
  expect(await bottomOf(lastRow)).toBeLessThanOrEqual(await topOf(dockWindow))
})
