// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bottom-pinned composer rises above the desktop dock's bar once the bar
// grows far enough left to hide one of its controls (primitives/dockLift.ts),
// and drops back when the bar shrinks. A bar that only grazes the Send corner
// moves nothing (CLAUDE.md, "Chat dock overlap").

import { api } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"

const SEE = { timeout: 20_000 } as const

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error("element has no layout box")
  return b
}

/** Two frames: the bar's measure and the lift settle on the frame after. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

test("dock.composer-rises-above-a-bar-that-hides-its-controls", async ({
  page,
  env,
  qa,
  world,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const orgId = world.org.id
  const stamp = Date.now()
  await grantTicketsScopes(env, orgId, qa.admin.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
  ])
  const inbox = await seedInbox(env, orgId, {
    name: `Lift inbox ${stamp}`,
    emailAddress: `lift-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Lift ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })

  // Eight collapsed conversations in the dock: enough to run the bar left
  // over the composer's Send and the controls beside it.
  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const threadIds: string[] = []
  for (let i = 0; i < 8; i++) {
    const res = await api(env.serverUrl, "/api/threads", {
      token,
      body: {
        forceCreate: true,
        title: `Dock lift ${i + 1}`,
        participantIds: [qa.admin.id, qa.amina.id],
        initialMessage: { content: "hello" },
      },
    })
    expect(res.status).toBe(200)
    threadIds.push(res.body.data.id)
  }
  const now = Date.now()
  await page.addInitScript(
    ({ ids, at }) => {
      if (sessionStorage.getItem("dock-lift-seeded")) return
      sessionStorage.setItem("dock-lift-seeded", "1")
      localStorage.setItem(
        "liaison.dock.v1",
        JSON.stringify({
          tabs: ids.map((threadId, i) => ({
            threadId,
            expanded: false,
            openedAt: at + i,
            lastActiveAt: at + i,
          })),
          activeThreadId: null,
          chatsOpen: false,
          allCollapsed: false,
          foldedOpenId: null,
        }),
      )
    },
    { ids: threadIds, at: now },
  )

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  const composer = page.getByTestId("tickets-composer")
  const send = page.getByTestId("tickets-composer-submit")
  const bar = page.locator("[data-dock-bar]")
  await expect(composer).toBeVisible(SEE)
  await expect(bar).toBeVisible(SEE)
  await expect(page.locator("[data-dock-tab]").first()).toBeVisible(SEE)
  await settle(page)

  // 1. The bar reaches past Send's centre: the composer sits on top of it,
  //    Send fully clear of it.
  const wide = await box(bar)
  const s = await box(send)
  expect(wide.x).toBeLessThan(s.x + s.width / 2)
  await expect
    .poll(async () => (await box(composer)).y + (await box(composer)).height, SEE)
    .toBeLessThanOrEqual(wide.y + 1)
  const lifted = await box(send)
  expect(lifted.y + lifted.height).toBeLessThanOrEqual(wide.y)
  // The ticket's own column shrank to make room: nothing scrolls the page.
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)

  // 2. Collapse all into Chats: the bar shrinks to its corner and the
  //    composer drops back flush to the panel's bottom.
  await page.getByTestId("dock-collapse-all").click()
  await expect(page.locator("[data-dock-tab]")).toHaveCount(0, SEE)
  const panelBottom = async () => {
    const p = await box(page.getByTestId("main-panel"))
    return p.y + p.height
  }
  await expect
    .poll(async () => {
      const c = await box(composer)
      return Math.abs((await panelBottom()) - (c.y + c.height))
    }, SEE)
    .toBeLessThanOrEqual(1)
  await expect(composer).not.toHaveAttribute("data-dock-lift", /.+/)
})
