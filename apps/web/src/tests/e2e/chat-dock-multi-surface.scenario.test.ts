// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T21, S24 end to end in a real browser at desktop width: ONE conversation,
// two surfaces. The dock carries it across every surface (Home included since
// the always-on-desktop rule), Home carries the same thread as a full tab, and
// a message sent on either side is on the other without a reload. What the dock holds survives a reload: the tabs, which of
// them are expanded, and which one is active.
//
// (The scope-request lane lives in approvals-scope-requests.scenario.test.ts.)
//
// No model is needed anywhere here, and none is used: every assertion is about
// the VIEWER's own messages and the dock's own state. The agent's reply would
// need a live turn, which this headless lane never waits on (the same bound
// web-11 Scenario 10 states).

import type { WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { readDockState, sendInConversation } from "./agent-bootstrap"
import { expect, loginAs, test } from "./fixtures/test"

const NAV = { timeout: 30_000 } as const
const SEE = { timeout: 20_000 } as const

/** A role agent this org can be offered a DM with, unique per test so the
 *  Chats roster always shows it as an OFFER (`agent-dm-row`) and never as a
 *  DM another test in this worker's schema already started. */
async function seedRoleAgent(env: WorkerEnv, orgId: string, displayName: string): Promise<string> {
  const ks = `${env.schemaPrefix}kernel`
  const handle = `${displayName.toLowerCase()}-${Date.now().toString(36)}`
  const rows = (await env.db.sql.unsafe(
    `INSERT INTO "${ks}".agents (org_id, kind, handle, display_name)
     VALUES ($1, 'role', $2, $3) RETURNING id`,
    [orgId, `@${handle}`, displayName],
  )) as Array<{ id: string }>
  return rows[0]!.id
}

/** The display name the sidebar and the dock both show for a DM: the agent
 *  seated in it. Read from the database so the test names the conversation the
 *  way the product does, without hardcoding a seed's wording. */
async function dmAgentName(env: WorkerEnv, threadId: string): Promise<string> {
  const ks = `${env.schemaPrefix}kernel`
  const rows = (await env.db.sql.unsafe(
    `SELECT a.display_name AS name
       FROM "${ks}".thread_participants tp
       JOIN "${ks}".agents a ON a.id = tp.agent_id
      WHERE tp.thread_id = $1
      LIMIT 1`,
    [threadId],
  )) as Array<{ name: string }>
  return rows[0]!.name
}

async function openSurface(page: Page, testId: string): Promise<void> {
  const entry = page.getByTestId(testId)
  await entry.waitFor({ state: "visible", ...NAV })
  await entry.click(NAV)
}

/** The shell registers its keydown listener in onMount; `[data-shell]` paints
 *  before that, so a shortcut sent in the gap is silently dropped. */
async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("[data-shell][data-shell-ready='true']")).toBeVisible(NAV)
}

function dockTab(page: Page, threadId: string): Locator {
  return page.locator(`[data-dock-tab="${threadId}"]`)
}

function messageIn(scope: Locator, text: string): Locator {
  return scope.getByTestId("message-row").filter({ hasText: text })
}

/** The dock's roster: open the Chats panel and hand it back. Opening a
 *  conversation from it closes the panel again (dock-store.openConversation),
 *  so each pick reopens it. */
async function openChatsRoster(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chats", exact: true }).click(NAV)
  const panel = page.getByTestId("chats-panel")
  await expect(panel).toBeVisible(SEE)
  return panel
}

test.describe("P4c-T21: the same conversation from the dock and from Home", () => {
  test("carries one thread across surfaces and restores the dock after a reload", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(qa.admin.token).toBeTruthy()
    const roleAgentId = await seedRoleAgent(env, world.org.id, "Logistics")
    expect(roleAgentId).toBeTruthy()

    await loginAs(page, env, "admin@test.com", "12345678")
    await shellReady(page)

    // ── 1. Tickets: mod+. expands the personal agent's dock tab ──────────────
    await openSurface(page, "activity-tickets")
    await expect(page.locator("[data-chat-dock]")).toBeVisible(SEE)
    await page.keyboard.press("ControlOrMeta+Period")

    const expandedTab = page.locator('[data-dock-tab][data-expanded="true"]').first()
    await expect(expandedTab).toBeVisible(SEE)
    await expect
      .poll(async () => (await readDockState(page))?.activeThreadId ?? null, SEE)
      .not.toBeNull()
    const dmId = (await readDockState(page))!.activeThreadId as string

    await sendInConversation(page, dockTab(page, dmId), "dock one")
    await expect(messageIn(dockTab(page, dmId), "dock one")).toBeVisible(SEE)

    // ── 2. Projects: the same tab, still carrying the message ────────────────
    await openSurface(page, "activity-projects")
    await expect(page.locator("[data-chat-dock]")).toBeVisible(SEE)
    await expect(dockTab(page, dmId)).toHaveAttribute("data-expanded", "true")
    await expect(messageIn(dockTab(page, dmId), "dock one")).toBeVisible(SEE)

    // ── 3. Home: the dock is STILL there, and the SAME DM is in the sidebar
    //      and opens as a full tab beside it ─────────────────────────────────
    const agentName = await dmAgentName(env, dmId)
    // Conversations are listed under Messages since D21 (Home's sidebar is
    // what is asked of the viewer); the full tab opens there.
    await openSurface(page, "activity-messages")
    await expect(page.locator("[data-chat-dock]")).toHaveCount(1)

    // The personal agent's DM is the sidebar's own pinned row
    // (chats-personal-agent-row), every other DM a thread-item.
    const sidebarRow = page
      .getByTestId("thread-item")
      .or(page.getByTestId("chats-personal-agent-row"))
      .filter({ hasText: agentName })
      .first()
    await expect(sidebarRow).toBeVisible(SEE)
    await sidebarRow.click(NAV)

    const homeConversation = page
      .locator('[data-tab-active="true"]')
      .filter({ has: page.getByTestId("compose-editor") })
      .first()
    await expect(homeConversation).toBeVisible(SEE)
    await expect(messageIn(homeConversation, "dock one")).toBeVisible(SEE)

    await sendInConversation(page, homeConversation, "home two")
    await expect(messageIn(homeConversation, "home two")).toBeVisible(SEE)

    // ── 4. Back to Tickets: the dock tab has the Home message, no reload ─────
    await openSurface(page, "activity-tickets")
    await expect(page.locator("[data-chat-dock]")).toBeVisible(SEE)
    await expect(messageIn(dockTab(page, dmId), "home two")).toBeVisible(SEE)
    await expect(messageIn(dockTab(page, dmId), "dock one")).toBeVisible(SEE)

    // ── 5. A channel and a second DM from the Chats roster, then a reload ────
    const roster = await openChatsRoster(page)
    const channelRow = roster
      .locator('[data-testid="thread-group"][data-group="channels"]')
      .getByTestId("thread-item")
      .first()
    await expect(channelRow).toBeVisible(SEE)
    const channelName = ((await channelRow.textContent()) ?? "").trim()
    await channelRow.click(NAV)

    await expect.poll(async () => (await readDockState(page))?.tabs.length ?? 0, SEE).toBe(2)
    const channelId = (await readDockState(page))!.activeThreadId as string
    expect(channelId).not.toBe(dmId)

    // Collapsed on purpose: a reload that restores three IDENTICAL expanded
    // tabs cannot tell a restored state from a default one.
    await dockTab(page, channelId).getByRole("button", { name: "Collapse" }).click(NAV)
    await expect(dockTab(page, channelId)).toHaveAttribute("data-expanded", "false")

    const roster2 = await openChatsRoster(page)
    const offer = roster2.getByTestId("agent-dm-row").filter({ hasText: "Logistics" }).first()
    await expect(offer).toBeVisible(SEE)
    await offer.click(NAV)

    await expect.poll(async () => (await readDockState(page))?.tabs.length ?? 0, SEE).toBe(3)
    const secondDmId = (await readDockState(page))!.activeThreadId as string
    expect([dmId, channelId]).not.toContain(secondDmId)

    const before = (await readDockState(page))!
    expect(before.chatsOpen).toBe(false)

    await page.reload()
    await shellReady(page)
    await expect(page.locator("[data-chat-dock]")).toBeVisible(SEE)
    await expect(dockTab(page, secondDmId)).toBeVisible(SEE)

    const after = (await readDockState(page))!
    expect(after.activeThreadId).toBe(secondDmId)
    // ONE window at a time: opening the second DM put the first one away.
    expect(new Map(after.tabs.map((t) => [t.threadId, t.expanded]))).toEqual(
      new Map([
        [dmId, false],
        [channelId, false],
        [secondDmId, true],
      ]),
    )

    // Every restored tab is accounted for ON SCREEN: the bar shows as many as
    // fit and the rest sit in the overflow item. The capacity depends on the
    // surface's sidebar width, so the count is read, not assumed.
    const rendered = page.locator("[data-dock-tab]")
    await expect(rendered.first()).toBeVisible(SEE)
    const overflowItem = page.getByTestId("dock-overflow")
    const overflowCount = (await overflowItem.isVisible().catch(() => false))
      ? Number(
          (await overflowItem
            .locator("[data-overflow-count]")
            .getAttribute("data-overflow-count")) ?? 0,
        )
      : 0
    expect((await rendered.count()) + overflowCount).toBe(3)

    // …and each one that IS on screen was restored in its own persisted state.
    for (const tab of await rendered.all()) {
      const threadId = await tab.getAttribute("data-dock-tab")
      const expanded = await tab.getAttribute("data-expanded")
      expect(String(after.tabs.find((t) => t.threadId === threadId)?.expanded)).toBe(expanded)
    }

    // The channel tab still names the channel after the reload, so what came
    // back is the conversation and not just a row of ids.
    if (
      await dockTab(page, channelId)
        .isVisible()
        .catch(() => false)
    ) {
      await expect(dockTab(page, channelId)).toContainText(channelName.slice(0, 12))
    }

    // ── 6. The rule, stated: at desktop the dock is on EVERY surface ─────────
    await openSurface(page, "activity-home")
    await expect(page.locator("[data-chat-dock]")).toHaveCount(1)
    await openSurface(page, "activity-tickets")
    await expect(page.locator("[data-chat-dock]")).toHaveCount(1)
  })

  // The bar is anchored flush to the panel's bottom right corner, which is
  // where a full-surface composer keeps its send button. Desktop pages reserve
  // no band for it (--shell-dock-clearance is 0, Shell.tsx), so the button's
  // bottom edge may sit behind the bar, but its centre stays above the bar and
  // a click there reaches it: asserted on real boxes, in a real browser.
  test("the anchored bar leaves the composer's send button clickable", async ({
    page,
    env,
    qa,
  }) => {
    expect(qa.admin.token).toBeTruthy()
    await loginAs(page, env, "admin@test.com", "12345678")
    await shellReady(page)

    await openSurface(page, "activity-messages")
    const row = page.getByTestId("thread-item").first()
    await expect(row).toBeVisible(SEE)
    await row.click(NAV)

    const send = page.locator('[data-tab-active="true"] [data-testid="compose-send"]').first()
    await expect(send).toBeVisible(SEE)
    const bar = page.locator("[data-dock-bar]")
    await expect(bar).toBeVisible(SEE)
    await page.waitForTimeout(300)

    const s = (await send.boundingBox())!
    const b = (await bar.boundingBox())!
    const panel = (await page.getByTestId("main-panel").boundingBox())!
    // Flush: the bar's bottom and right edges are the panel's.
    expect(Math.abs(b.y + b.height - (panel.y + panel.height))).toBeLessThanOrEqual(1)
    expect(Math.abs(b.x + b.width - (panel.x + panel.width))).toBeLessThanOrEqual(1)
    expect(s.y + s.height / 2).toBeLessThan(b.y)
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="compose-send"]') !== null,
      { x: s.x + s.width / 2, y: s.y + s.height / 2 },
    )
    expect(hit, `send ${JSON.stringify(s)} vs bar ${JSON.stringify(b)}`).toBe(true)

    await page.screenshot({ path: test.info().outputPath("composer-and-bar.png") })
  })

  // ── 7. Visual baselines ───────────────────────────────────────────────────
  // Both open a FRESH DM (its own role agent per test, so the roster offers it
  // and the conversation is empty): the journey test above leaves messages in
  // the personal DM, and a baseline of a conversation whose content grows with
  // the suite is a baseline of nothing.

  async function openFreshDockDm(
    page: Page,
    agentName: string,
    surface = "activity-tickets",
  ): Promise<Locator> {
    await openSurface(page, surface)
    await expect(page.locator("[data-chat-dock]")).toBeVisible(SEE)
    const roster = await openChatsRoster(page)
    const offer = roster.getByTestId("agent-dm-row").filter({ hasText: agentName }).first()
    await expect(offer).toBeVisible(SEE)
    await offer.click(NAV)
    await expect(page.locator('[data-dock-tab][data-expanded="true"]').first()).toBeVisible(SEE)
    // Keyed by thread id, not by expanded state: the collapse gesture below
    // would otherwise move the tab out from under its own locator.
    const threadId = (await readDockState(page))!.activeThreadId as string
    const tab = dockTab(page, threadId)
    await expect(tab.getByTestId("compose-editor")).toBeVisible(SEE)
    return tab
  }

  /** The dock's corner of the page: the bar and, when one is open, the window
   *  floating above it, as one clip. The strip itself spans the whole panel
   *  width and is transparent, so shooting it would mostly shoot the page. */
  async function dockClip(page: Page) {
    const boxes = [
      await page.locator("[data-dock-bar]").boundingBox(),
      await page
        .locator("[data-dock-window]")
        .first()
        .boundingBox()
        .catch(() => null),
    ].filter((b): b is NonNullable<typeof b> => b !== null)
    const pad = 12
    const x = Math.min(...boxes.map((b) => b.x)) - pad
    const y = Math.min(...boxes.map((b) => b.y)) - pad
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad
    return { x, y, width: right - x, height: bottom - y }
  }

  /** The worker's seed delivers messages from its people while the page
   *  loads, and an incoming message surfaces its conversation on the bar
   *  (dock-store surfaceIncoming), whenever it lands. Let that settle, then
   *  close whatever surfaced, so a baseline holds its own conversation only. */
  async function onlyThisConversation(page: Page, tab: Locator): Promise<void> {
    await page.waitForTimeout(2500)
    const threadId = await tab.getAttribute("data-dock-tab")
    const ids = await page
      .locator("[data-dock-tab]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-dock-tab")))
    for (const id of ids) {
      if (!id || id === threadId) continue
      await dockTab(page, id).getByTestId("dock-tab-close").click(NAV)
    }
    await expect(page.locator("[data-dock-tab]")).toHaveCount(1)
  }

  test("visual: the dock strip with a collapsed conversation", async ({ page, env, world, qa }) => {
    expect(qa.admin.token).toBeTruthy()
    await seedRoleAgent(env, world.org.id, "Shipping")
    await loginAs(page, env, "admin@test.com", "12345678")
    await shellReady(page)

    // Search with no query is the one working surface whose lower half is
    // genuinely empty: a Tickets row with a relative timestamp ("5 minutes
    // ago") behind the bar would rot this baseline within the hour.
    const tab = await openFreshDockDm(page, "Shipping", "activity-search")
    await tab.getByRole("button", { name: "Collapse" }).click(NAV)
    await expect(tab).toHaveAttribute("data-expanded", "false")
    await expect(page.locator("[data-dock-window]")).toHaveCount(0)
    await onlyThisConversation(page, tab)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot("chat-dock-strip.png", {
      clip: await dockClip(page),
      maxDiffPixelRatio: 0.05,
      // The Chats item's unread total is whatever the worker's seed has read
      // so far, which is not this baseline's subject.
      mask: [page.locator("[data-chat-dock] [role='status']")],
    })
  })

  test("visual: one expanded conversation tab", async ({ page, env, world, qa }) => {
    expect(qa.admin.token).toBeTruthy()
    await seedRoleAgent(env, world.org.id, "Warehouse")
    await loginAs(page, env, "admin@test.com", "12345678")
    await shellReady(page)

    // Search, for the same reason as above: nothing behind the dock moves.
    const tab = await openFreshDockDm(page, "Warehouse", "activity-search")
    await onlyThisConversation(page, tab)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot("chat-dock-tab-expanded.png", {
      clip: await dockClip(page),
      maxDiffPixelRatio: 0.05,
      mask: [page.locator("[data-chat-dock] [role='status']")],
    })
  })
})
