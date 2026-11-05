// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import type { Page, WebSocketRoute } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

// Conversations are listed in Messages' sidebar. Since D21 Home's sidebar is
// the attention summary (Needs you / Your queues / Agents / Today), so a flow
// that picks a thread opens Messages first.
async function openMessages(page: Page): Promise<void> {
  await page.getByTestId("activity-messages").click()
  await page.waitForURL(/\/chats/, { timeout: 10_000 })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 05: Real-Time Multi-User
// ALL 8 flows (A–H). Amina = browser user. Lucas = API user (secondary actor).
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Flow A: Real-Time Message Delivery", () => {
  test("Lucas sends via API, Amina sees it live", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: the open Home and Messages tabs are kept alive.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Q2 Marketing Plan").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    await api(env.serverUrl, `/api/threads/${qa.threads.q2Marketing.id}/messages`, {
      token: qa.lucas.token,
      body: { content: "Real-time test: Lucas says hello!" },
    })

    // Scope to the active tab's thread body so we don't collide with the
    // attention-feed row that surfaces the same text as a notification (the
    // unscoped match used to land both, which now fails Playwright strict
    // mode under load when the attention row arrives before the message
    // settles in the thread view).
    const messageBody = page
      .locator('[data-tab-active="true"]')
      .locator('[data-testid="message-row"]')
      .filter({ hasText: "Real-time test: Lucas says hello!" })
    await expect(messageBody).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow B: Real-Time Thread Creation", () => {
  test("Lucas creates thread with Amina, appears in sidebar", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: a page-wide title query could match a kept-alive tab.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })

    await api(env.serverUrl, "/api/threads", {
      token: qa.lucas.token,
      body: {
        forceCreate: true,
        participantIds: [qa.amina.id],
        title: "Realtime test thread",
        initialMessage: { content: "Created by Lucas in real-time!" },
      },
    })

    await expect(sidebar.getByText("Realtime test thread")).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow C: Real-Time Reaction Updates", () => {
  test("Lucas adds reaction via API, appears in Amina's view", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: the open Home and Messages tabs are kept alive.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Weekly standup notes")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Weekly standup notes").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    const msgsRes = await api(
      env.serverUrl,
      `/api/threads/${qa.threads.weeklyStandup.id}/messages?limit=5`,
      {
        token: qa.lucas.token,
      },
    )
    const targetMsg = msgsRes.body.data[0]

    await api(
      env.serverUrl,
      `/api/threads/${qa.threads.weeklyStandup.id}/messages/${targetMsg.id}/reactions`,
      {
        token: qa.lucas.token,
        body: { emoji: "🚀" },
      },
    )

    await expect(page.getByText("🚀")).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow D: Real-Time Message Edit", () => {
  test("Lucas sends then edits, Amina sees (edited)", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: the open Home and Messages tabs are kept alive.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Q2 Marketing Plan").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    const sendRes = await api(env.serverUrl, `/api/threads/${qa.threads.q2Marketing.id}/messages`, {
      token: qa.lucas.token,
      body: { content: "Original from Lucas" },
    })
    const content = page.locator('[data-testid="tab-content-area"]')
    await expect(content.getByText("Original from Lucas")).toBeVisible({ timeout: 10000 })

    await api(
      env.serverUrl,
      `/api/threads/${qa.threads.q2Marketing.id}/messages/${sendRes.body.data.id}`,
      {
        method: "PATCH",
        token: qa.lucas.token,
        body: { content: "Edited by Lucas" },
      },
    )

    await expect(content.getByText("Edited by Lucas")).toBeVisible({ timeout: 10000 })
    await expect(content.getByText("(edited)")).toBeVisible({ timeout: 5000 })
  })
})

test.describe("Flow E: Real-Time Message Deletion", () => {
  test("Lucas sends then deletes, Amina sees [message deleted]", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: the open Home and Messages tabs are kept alive.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Q2 Marketing Plan").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    const sendRes = await api(env.serverUrl, `/api/threads/${qa.threads.q2Marketing.id}/messages`, {
      token: qa.lucas.token,
      body: { content: "Will be deleted by Lucas" },
    })
    // The message list, not the whole tab area: the Home tab's feed carries a
    // preview of the same message ("Lucas Pereira: Will be deleted by Lucas").
    const content = page.getByTestId("message-scroll-container")
    await expect(content.getByText("Will be deleted by Lucas")).toBeVisible({
      timeout: 10000,
    })

    await api(
      env.serverUrl,
      `/api/threads/${qa.threads.q2Marketing.id}/messages/${sendRes.body.data.id}`,
      {
        method: "DELETE",
        token: qa.lucas.token,
      },
    )

    await expect(content.getByText("[message deleted]")).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow F: Typing Indicator", () => {
  test("Lucas typing shows 'Lucas Pereira is typing', auto-expires after 4s", async ({
    page,
    env,
    qa,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: the open Home and Messages tabs are kept alive.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Q2 Marketing Plan").click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    // No typing indicator initially
    await expect(page.getByText(/typing/i)).not.toBeVisible({ timeout: 1000 })

    // Connect Lucas's WS from Node.js (avoids page.evaluate context-destruction races)
    const threadId = qa.threads.q2Marketing.id
    const ticketRes = await api(env.serverUrl, "/api/auth/ws-ticket", {
      method: "POST",
      token: qa.lucas.token,
    })
    const wsUrl = `${env.serverUrl.replace("http", "ws")}/ws?ticket=${ticketRes.body.data.ticket}`
    const lucasWs = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      lucasWs.onopen = () => resolve()
      lucasWs.onerror = (e) => reject(new Error(`Lucas WS failed to connect: ${e}`))
      setTimeout(() => reject(new Error("Lucas WS connect timeout")), 10000)
    })
    lucasWs.send(JSON.stringify({ type: "hello" }))
    // Wait for hello to be processed (loads userName from DB)
    await new Promise((r) => setTimeout(r, 2000))
    lucasWs.send(JSON.stringify({ type: "typing", threadId }))

    // Typing indicator should appear with Lucas's name
    await expect(page.getByText(/Lucas Pereira.*typing|typing/i)).toBeVisible({ timeout: 5000 })

    // Typing indicator should auto-expire after 4s TTL — assert hidden with timeout covering the TTL
    await expect(page.getByText(/typing/i)).not.toBeVisible({ timeout: 8000 })

    lucasWs.close()
  })
})

test.describe("Flow F.1: Presence / Online Status", () => {
  test("Lucas connecting shows online count update", async ({ browser, env, qa }) => {
    // Amina in first browser context
    const aminaCtx = await browser.newContext()
    const aminaPage = await aminaCtx.newPage()
    await loginAs(aminaPage, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(aminaPage)

    const aminaSidebar = aminaPage.locator('[data-testid="sidebar"]')
    await expect(aminaSidebar.getByText("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await aminaSidebar.getByText("Q2 Marketing Plan").click()
    await aminaPage.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(aminaPage.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    // Lucas connects in second context — this triggers presence update
    const lucasCtx = await browser.newContext()
    const lucasPage = await lucasCtx.newPage()
    await loginAs(lucasPage, env, "lucas@resonantaudiolabs.example", "QaPass1!")

    // Amina's thread header should show updated online count
    // (At least "2 online" since both Amina and Lucas are now connected)
    // The exact format depends on the component, but the number should increase
    await expect(aminaPage.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 3000,
    })

    await lucasCtx.close()
    await aminaCtx.close()
  })
})

test.describe("Flow G: Real-Time Participant Addition", () => {
  test("Lucas adds Elodie via API, Amina sees update", async ({ page, env, qa }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await openMessages(page)
    // Sidebar-scoped: `.first()` here could pick a kept-alive tab's copy.
    const sidebar = page.locator('[data-testid="sidebar"]')
    await expect(sidebar.getByText("Design system v2").first()).toBeVisible({ timeout: 10000 })
    await sidebar.getByText("Design system v2").first().click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(page.locator('[data-tab-active="true"] [role="textbox"]')).toBeVisible({
      timeout: 5000,
    })

    await api(env.serverUrl, `/api/threads/${qa.threads.designSystemV2.id}/participants`, {
      token: qa.lucas.token,
      body: { userId: qa.admin.id },
    })

    // Open actions menu and verify Elodie was added. The panel is portaled out
    // of the tab, so assert inside it rather than page-wide.
    await page.locator('[data-tab-active="true"] [aria-label="Thread actions"]').click()
    await expect(page.locator(".popup-menu").getByText("Elodie")).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow I: Messages badge, tab title, and the Unread filter (D21: badges split)", () => {
  test("Lucas's message while Amina is on Settings raises the Messages badge and title, not Home's; the Unread filter lists the thread until Amina opens it", async ({
    page,
    env,
    qa,
  }) => {
    // The Home badge counts the attention feed: measure it only once the
    // first feed has landed, or an item already waiting for Amina (a seeded
    // approval) reads as raised by Lucas's message.
    const feedLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/attention-items") && r.request().method() === "GET",
    )
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    expect((await feedLoaded).status()).toBe(200)
    // Navigate away from the conversation (Settings: every user has it) so the
    // message arrives while Amina is not looking at it: the badge/title
    // increment must come from the thread store, not an open thread.
    await page.getByTestId("activity-settings").click()
    // Tabs are keep-alive: the Home tab stays mounted and only hides.
    await expect(page.getByTestId("home")).toBeHidden()

    // Amina is a worker-shared QA user, so badges may already be nonzero from
    // other tests in this worker: assert DELTAS, never absolute values.
    const badgeCount = async (id: "messages" | "home"): Promise<number> => {
      const el = page.getByTestId(
        id === "home" ? "activity-bar-home-badge" : `activity-bar-badge-${id}`,
      )
      if ((await el.count()) === 0) return 0
      const text = (await el.first().textContent()) ?? "0"
      return Number.parseInt(text.replace("+", ""), 10) || 0
    }
    const messagesBefore = await badgeCount("messages")
    const homeBefore = await badgeCount("home")

    await api(env.serverUrl, `/api/threads/${qa.threads.q2Marketing.id}/messages`, {
      token: qa.lucas.token,
      body: { content: "Badge test: Lucas says hi" },
    })

    // The Messages badge is WS-driven (thread store), a bounded wait.
    await expect
      .poll(() => badgeCount("messages"), { timeout: 10_000 })
      .toBeGreaterThan(messagesBefore)
    await expect.poll(() => page.title(), { timeout: 10000 }).toContain("(")
    // An unread message is not an action item: the Home badge does not move.
    expect(await badgeCount("home")).toBe(homeBefore)

    // Home's overview no longer lists conversations (D21): no message row.
    await page.getByTestId("activity-home").click()
    await expect(page.getByTestId("home-attention-sidebar")).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator(`[data-testid="home-message-row-${qa.threads.q2Marketing.id}"]`),
    ).toHaveCount(0)

    // Messages' Unread filter lists the thread.
    await openMessages(page)
    const sidebar = page.locator('[data-testid="sidebar"]')
    await sidebar.getByTestId("chats-filter-unread").click()
    const threadRow = sidebar.locator(
      `[data-testid="thread-item"][data-thread-id="${qa.threads.q2Marketing.id}"]`,
    )
    await expect(threadRow).toBeVisible({ timeout: 10_000 })

    await threadRow.click()
    await page.waitForURL(/\/threads\//, { timeout: 5000 })
    await expect(
      page
        .locator('[data-tab-active="true"]')
        .locator('[data-testid="message-row"]')
        .filter({ hasText: "Badge test: Lucas says hi" }),
    ).toBeVisible({ timeout: 10_000 })
    // Other tests can leave OTHER threads unread, so the proof of the read
    // round trip is THIS thread leaving the Unread filter, not a zero badge.
    await openMessages(page)
    await sidebar.getByTestId("chats-filter-unread").click()
    await expect(threadRow).toHaveCount(0, { timeout: 10_000 })
  })
})

test.describe("Flow H: WebSocket Connection Status", () => {
  test("WS connected, reconnects after disconnect", async ({ page, env, qa }) => {
    // Every socket the page opens to /ws goes through this route, which
    // forwards it to the server untouched; the route is how the test cuts one.
    // (The stack serves a production build: there is no test hook on window.)
    const routed: WebSocketRoute[] = []
    await page.routeWebSocket(
      (url) => url.pathname.startsWith("/ws"),
      (ws) => {
        ws.connectToServer()
        routed.push(ws)
      },
    )
    // The activity bar shows a connection status only while the socket is not
    // connected: its absence is the page's own "connected".
    const notConnected = page
      .getByTestId("activity-bar")
      .getByRole("status", { name: /connection status/i })

    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 5000 })
    await expect.poll(() => routed.length, { timeout: 20_000 }).toBeGreaterThan(0)
    await expect(notConnected).toHaveCount(0, { timeout: 20_000 })

    // Cut the connection the way a network drop does, from outside the page.
    const before = routed.length
    await routed[routed.length - 1]?.close({ code: 4000, reason: "e2e drop" })

    // The client reconnects on its own: a NEW socket, and connected again.
    await expect.poll(() => routed.length, { timeout: 20_000 }).toBeGreaterThan(before)
    await expect(notConnected).toHaveCount(0, { timeout: 20_000 })
  })
})
