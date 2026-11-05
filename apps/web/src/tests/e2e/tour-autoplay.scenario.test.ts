// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T7 (S24): "Do it for me" drives the REAL UI in a real browser. The
// fixture tour `kernel.autoplay-fixture` (packages/shared/src/tours/kernel)
// has one do beat per kind of input the ghost cursor must handle:
//  * a ProseMirror editor: typing, an @mention picked from the picker, Send
//    (the message lands with the mention, read back from the database);
//  * a composer textarea (the session composer): typed character by character;
//  * a Kobalte popup menu: opened (on pointerdown) and an item picked (the
//    ticket's status changes in the database);
// and a real key during autoplay hands over (isTrusted takeover), while a
// mouse move never does.
// The tour routes are stubbed with route interception (the progress API is
// another track's); every product effect is the real server's.
import { randomUUID } from "node:crypto"
import type { TourListItem, TourProgress } from "@liaison/shared"
import { api } from "@liaison/test-helpers"
import type { Page, Route } from "@playwright/test"
import { expect, test } from "./fixtures/test"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import { pressTourMenu } from "./helpers/tour-menu"
import { waitForMentionIndex } from "./helpers/wait-for-mention"

const TOUR_ID = "kernel.autoplay-fixture"
const BEATS = ["mention", "session", "status"] as const

function at(
  beatId: (typeof BEATS)[number],
  status: TourProgress["status"] = "active",
): TourProgress {
  return {
    tourId: TOUR_ID,
    status,
    beatId,
    beatIndex: BEATS.indexOf(beatId),
    beatCount: BEATS.length,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
  }
}

/** Stub of the tour routes, holding one progress row the test moves. */
async function stubTours(page: Page, state: { progress: TourProgress; patches: unknown[] }) {
  await page.route("**/api/tours**", async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      })
    if (req.method() === "GET" && url.pathname === "/api/tours") {
      const item: TourListItem = {
        tourId: TOUR_ID,
        app: "kernel",
        title: "tours.kernel.autoplayFixture.title",
        summary: "tours.kernel.autoplayFixture.summary",
        beatCount: BEATS.length,
        progress: state.progress,
      }
      return json({ tours: [item] })
    }
    if (req.method() === "GET" && url.pathname.endsWith("/progress")) {
      return json({ progress: state.progress })
    }
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as { status?: TourProgress["status"] }
      state.patches.push(body)
      if (body.status) state.progress = { ...state.progress, status: body.status }
      return json({ progress: state.progress })
    }
    return route.fulfill({ status: 404, body: "{}" })
  })
}

test("tour autoplay: rich editor + mention, composer textarea, popup menu, takeover", async ({
  authenticatedPage: page,
  env,
  qa,
  world,
}) => {
  test.setTimeout(180_000)
  const orgId = world.org.id
  const ks = `${env.schemaPrefix}kernel`
  const stamp = Date.now()
  const base = `http://localhost:${env.ports[1]}`

  // A conversation with Amina, mentionable once the people index has her.
  const thread = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Tour autoplay ${stamp}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "context" },
    },
  })
  expect(thread.status).toBe(200)
  const threadId: string = thread.body.data.id
  const indexed = await waitForMentionIndex({
    serverUrl: env.serverUrl,
    token: qa.admin.token,
    query: "Ami",
    type: "user",
    predicate: (r) => String(r.id ?? "") === qa.amina.id,
  })
  expect(indexed, "Amina must be mentionable").not.toBeNull()

  // A finished coding session the admin owns (its composer is a textarea).
  const [agent] = await env.db.sql.unsafe<{ id: string }[]>(
    `SELECT id FROM "${ks}".agents WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
    [orgId],
  )
  const [session] = await env.db.sql.unsafe<{ id: string }[]>(
    `INSERT INTO "${ks}".node_sessions
       (org_id, owner_user_id, agent_id, source, config_kind, title, prompt, model, level,
        status, folder_name, folder_path, ended_at)
     VALUES ($1, $2, $3, 'app', 'owner', $4, 'Fix the build', 'claude-haiku-4-5', 'strict',
             'done', 'code', '/tmp/tour-autoplay-e2e', now())
     RETURNING id`,
    [orgId, qa.admin.id, agent?.id ?? randomUUID(), `Tour session ${stamp}`],
  )
  if (!session) throw new Error("the session row was not created")

  // A ticket whose status menu the ghost opens.
  await grantTicketsScopes(env, orgId, qa.admin.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
  ])
  const inbox = await seedInbox(env, orgId, {
    name: `Tour inbox ${stamp}`,
    emailAddress: `tour-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Tour ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })

  const state = { progress: at("mention"), patches: [] as unknown[] }
  await stubTours(page, state)
  const active = page.locator('[data-tab-active="true"]')

  // 1. Rich editor, @mention from the picker, Send.
  await page.goto(`${base}/threads/${threadId}`)
  const panel = page.getByTestId("tour-panel")
  await expect(panel).toHaveAttribute("data-beat-id", "mention", { timeout: 30_000 })
  await expect(page.getByTestId("tour-spotlight")).toHaveAttribute("data-anchor", "compose-editor")
  await page.getByTestId("tour-do-for-me").click()
  await expect(page.getByTestId("tour-ghost-cursor")).toBeVisible()
  // The picker opens and closes within the script (its pick is proven by the
  // stored mention below), so it is not asserted on screen here.
  await expect(page.getByTestId("tour-waiting")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () => {
        const rows = await env.db.sql.unsafe<{ content: string }[]>(
          `SELECT content FROM "${ks}".messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [threadId],
        )
        return rows[0]?.content ?? ""
      },
      { timeout: 15_000 },
    )
    .toMatch(new RegExp(`^Thanks .*user:${qa.amina.id}.*for the review`))
  await expect(page.getByTestId("tour-ghost-cursor")).toHaveCount(0)

  // 2. Composer textarea, typed at human speed.
  state.progress = at("session")
  await page.goto(`${base}/sessions/${session.id}`)
  await expect(panel).toHaveAttribute("data-beat-id", "session", { timeout: 30_000 })
  const field = active.getByTestId("session-composer-field").locator("textarea")
  await expect(field).toBeVisible({ timeout: 15_000 })
  // 2a. A real key while it plays hands over, and typing stops there. Taken
  // over first: a play that finishes spends the step's Do it for me (a second
  // press would send it twice), while a taken-over one offers it again. The
  // key goes in at once, while the ghost still glides to the field (the
  // typing itself takes about a fifth of a second).
  await field.fill("")
  await page.getByTestId("tour-do-for-me").click()
  await page.keyboard.press("Shift")
  await expect(page.getByTestId("tour-autoplay-takeover")).toBeVisible()
  const typed = await field.inputValue()
  await page.waitForTimeout(600)
  expect(await field.inputValue()).toBe(typed)
  expect(typed).not.toBe("Run the tests again please")

  // 2b. Pressed again, it types the whole line and waits for the step's event.
  // Moving the mouse meanwhile is never a takeover.
  await field.fill("")
  await page.getByTestId("tour-do-for-me").click()
  await expect(page.getByTestId("tour-autoplay-playing")).toBeVisible()
  await page.mouse.move(200, 200)
  await page.mouse.move(420, 380, { steps: 4 })
  await expect(field).toHaveValue("Run the tests again please", { timeout: 20_000 })
  await expect(page.getByTestId("tour-waiting")).toBeVisible()
  await expect(page.getByTestId("tour-autoplay-takeover")).toHaveCount(0)
  // Played to the end, the step's Do it for me is spent.
  await expect(page.getByTestId("tour-do-for-me")).toHaveCount(0)

  // 3. Popup menu: open the ticket's status menu, pick a status.
  state.progress = at("status")
  await page.goto(`${base}/tickets/${ticket.id}`)
  await expect(panel).toHaveAttribute("data-beat-id", "status", { timeout: 30_000 })
  await expect(active.getByTestId("tickets-detail-status")).toHaveAttribute("data-status", "open", {
    timeout: 15_000,
  })
  await page.getByTestId("tour-do-for-me").click()
  await expect(page.getByTestId("tickets-status-option-awaiting_customer")).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByTestId("tour-waiting")).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () => {
        const rows = await env.db.sql.unsafe<{ status: string }[]>(
          `SELECT status FROM "${env.schemaPrefix}app_tickets".tickets WHERE id = $1`,
          [ticket.id],
        )
        return rows[0]?.status
      },
      { timeout: 15_000 },
    )
    .toBe("awaiting_customer")
  await expect(active.getByTestId("tickets-detail-status")).toHaveAttribute(
    "data-status",
    "awaiting_customer",
  )

  // Pause collapses the panel to the resume chip on the same beat.
  await pressTourMenu(page, "tour-pause")
  await expect(page.getByTestId("tour-chip")).toContainText("3/3")
  await expect(panel).toHaveCount(0)
  expect(state.patches).toContainEqual({ status: "paused" })
  // A do beat is never advanced by the client: completion is the server's.
  expect(state.patches.some((p) => (p as { advance?: boolean }).advance)).toBe(false)
})
