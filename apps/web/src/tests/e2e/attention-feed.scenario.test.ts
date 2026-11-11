// SPDX-License-Identifier: FSL-1.1-ALv2
// attention.feed-three-providers-inline-approval — verify the unified Home feed
// surfaces one row from each of three providers (projects, tickets, approvals),
// the inline approve button decides the approval, the row disappears, and the
// frontend never falls back to per-app /api/apps/*/attention-items endpoints.
// D21: the approval is under Needs you (whose total is the Home badge), the
// unassigned ticket awaiting a reply under Your queues.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import {
  grantPhase8AttentionScopes,
  observeNoPerAppAttentionFetches,
  refreshStoredAttention,
  resetAttentionForUser,
  seedAttentionFixtures,
} from "./helpers/projects-seed"
import { seedInbox } from "./helpers/seed"

test("attention.feed-three-providers-inline-approval", async ({ page, env, qa, world }) => {
  // 1. Pre-login: grant the union of scopes attention rows need (projects + tickets +
  //    kernel:approvals + test:approve). Bumping is skipped (see helper).
  await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)

  // 2. Worker-shared rows from prior tests can leak in; neutralize them first.
  await resetAttentionForUser(env, world.org.id, qa.admin.token)

  // 3. Need an inbox for the seeded ticket — direct DB insert via the existing
  //    helper (the public route is a tool: /api/apps/tools/tickets:inboxes.create).
  const inbox = await seedInbox(env, world.org.id, {
    name: `AttnInbox-${Date.now()}`,
    emailAddress: `attn-${Date.now()}@e2e.test`,
  })
  const inboxId = inbox.id

  // 4. Seed exactly one row per provider for admin.
  const seeded = await seedAttentionFixtures(env, {
    orgId: world.org.id,
    userId: qa.admin.id,
    adminToken: qa.admin.token,
    inboxId,
  })

  // 5. The apps' attention lists are stored, recomputed after the app was woken
  //    and on the attention minute tick: a ticket written straight into its
  //    table wakes nothing, so run the org's tick job, as the next minute would.
  await refreshStoredAttention(env, world.org.id)

  // 6. Verify the aggregator returns the three seeded rows ordered by urgency desc.
  const seededIds = new Set([
    `projects:task_overdue:${seeded.overdueTaskId}`,
    `awaiting_agent:${seeded.ticketId}`,
    `kernel:approval_pending:${seeded.approvalRequestId}`,
  ])
  const seenAppsNow = async () => {
    const aggRes = await api(env.serverUrl, "/api/attention-items", { token: qa.admin.token })
    expect(aggRes.status).toBe(200)
    const items = (aggRes.body.data.items ?? aggRes.body.data) as Array<{
      id: string
      app: string
      urgency: number
      entityId?: string
    }>
    return new Set(items.filter((i) => seededIds.has(i.id)).map((i) => i.app))
  }
  await expect
    .poll(seenAppsNow, { timeout: 15_000 })
    .toEqual(new Set(["projects", "tickets", "kernel"]))

  // 7. Login + observe no per-app fetches across all subsequent navigation.
  const teardownObserver = await observeNoPerAppAttentionFetches(page)
  await loginAs(page, env, "admin@test.com", "12345678")

  // 8. Open Home, wait for the unified feed mount. Needs you holds the
  //    approval and its total IS the Home badge (both read homeActionItems);
  //    the unassigned ticket awaiting a reply is queue volume, listed under
  //    Your queues, not in the badge (D21).
  await page.getByTestId("activity-home").click()
  await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })
  const needsTotal = page.getByTestId("home-side-needs-total")
  const homeBadge = page.getByTestId("activity-bar-home-badge")
  await expect(homeBadge).toBeVisible({ timeout: 10_000 })
  await expect(async () => {
    expect(Number(await needsTotal.textContent())).toBeGreaterThanOrEqual(1)
    expect(await homeBadge.textContent()).toBe(await needsTotal.textContent())
  }).toPass({ timeout: 10_000 })
  const needsBefore = Number(await needsTotal.textContent())
  // The seeded approval expires within the hour, so Needs you lists it as a
  // time-limited row (with its countdown) rather than under Approvals.
  await expect(
    page
      .getByTestId(`home-side-time-kernel:approval_pending:${seeded.approvalRequestId}`)
      .or(page.getByTestId("home-side-approvals")),
  ).toBeVisible()
  await expect(page.getByTestId("home-side-queue-tickets")).toBeVisible()

  // 9. Assert all three rows are mounted, each ONCE (a page-wide locator is
  //    strict: an approval drawn in two cards fails here).
  const overdueRow = page.locator(
    `[data-testid="attention-row-projects-task-${seeded.overdueTaskId}"]`,
  )
  const ticketRow = page.locator(`[data-testid="attention-row-tickets-ticket-${seeded.ticketId}"]`)
  const approvalRow = page.locator(
    `[data-testid="attention-row-kernel-approval_request-${seeded.approvalRequestId}"]`,
  )
  await expect(overdueRow).toBeVisible()
  await expect(ticketRow).toBeVisible()
  await expect(approvalRow).toBeVisible()

  // 10. Approve via the inline button; the row should disappear and the server
  //    should record the decision.
  await approvalRow
    .getByTestId(/approve$/)
    .first()
    .click()
  await expect(approvalRow).toHaveCount(0, { timeout: 5_000 })
  // The row hides at once; the decision is posted once the Undo window
  // (decision-queue.ts, 5 s) has passed.
  await expect
    .poll(
      async () => {
        const decided = await api(env.serverUrl, `/api/approvals/${seeded.approvalRequestId}`, {
          token: qa.admin.token,
        })
        expect(decided.status).toBe(200)
        return decided.body.data.status
      },
      { timeout: 20_000 },
    )
    .toBe("approved")

  // 11. After approval, Needs you and the Home badge drop by one together,
  //     and the queues are untouched.
  await expect(needsTotal).toHaveText(String(needsBefore - 1), { timeout: 10_000 })
  if (needsBefore - 1 > 0) await expect(homeBadge).toHaveText(String(needsBefore - 1))
  else await expect(homeBadge).toHaveCount(0)
  await expect(page.getByTestId("home-side-queue-tickets")).toBeVisible()

  // 12. Detach the observer; throws if any per-app fetch fired.
  await teardownObserver()
})

// Journey C (liaison-messaging-visibility): thread mute suppresses ordinary
// replies from generating attention activity, but a direct @mention still
// reaches a muted participant (Slack semantics). Since D21 mentions are not on
// Home: they surface in Messages' Mentions filter. Uses a freshly created
// thread (not a worker-shared QA fixture thread) so muting it cannot poison any
// other test sharing this worker.
test("attention.thread-mute-suppresses-replies-not-mentions", async ({ page, env, qa }) => {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.lucas.token,
    body: {
      forceCreate: true,
      participantIds: [qa.amina.id],
      title: `Mute test ${Date.now()}`,
      initialMessage: { content: "Starting a muted-thread test" },
    },
  })
  const threadId = created.body.data.id as string

  await api(env.serverUrl, `/api/threads/${threadId}/state`, {
    method: "PATCH",
    token: qa.amina.token,
    body: { isMuted: true },
  })

  await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home-attention-sidebar")).toBeVisible({ timeout: 10_000 })

  await page.getByTestId("activity-messages").click()
  await page.waitForURL(/\/chats/, { timeout: 10_000 })
  const sidebar = page.locator('[data-testid="sidebar"]')
  await sidebar.getByTestId("chats-filter-mentions").click()
  const mentioned = sidebar.locator(`[data-testid="thread-item"][data-thread-id="${threadId}"]`)
  // On Home, a mention row would have this id (pre-D21 Home listed mentions).
  const homeMentionRow = page.locator(`[data-testid="attention-row-kernel-thread-${threadId}"]`)

  // Lucas posts an ordinary reply into the muted thread: no mention. Bounded
  // wait covers the outbox's ~1s poll interval: reading immediately would
  // trivially pass whether or not mute worked, so wait long enough for a row
  // to have appeared and THEN assert continued absence.
  await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
    token: qa.lucas.token,
    body: { content: "Muted thread reply -- should not notify" },
  })
  await page.waitForTimeout(3_000)
  await expect(mentioned).toHaveCount(0)
  await expect(homeMentionRow).toHaveCount(0)

  // Lucas then @mentions Amina in the SAME muted thread: Messages' Mentions
  // filter lists the thread, and Home still shows no conversation row.
  await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
    token: qa.lucas.token,
    body: { content: `@[Amina Cherif](user:${qa.amina.id}) can you take a look` },
  })
  await expect(mentioned).toBeVisible({ timeout: 10_000 })
  await expect(homeMentionRow).toHaveCount(0)
})
