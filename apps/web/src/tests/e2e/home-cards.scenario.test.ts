// SPDX-License-Identifier: FSL-1.1-ALv2
// home-cards.reorder-collapse-persist-scroll (liaison-messaging-visibility,
// Journey B) — the Home card redesign: drag-reorder + collapse persist
// server-side (not just localStorage), and a large approvals pile scrolls
// inside its capped card body instead of pushing everything else down.
// D21: the overview cards are Approvals, Alerts (card id "messages") and
// Activity; conversations and new mail left Home, so a mail item draws no card.
//
// DnD is driven via explicit dragstart/dragover/drop DataTransfer events
// (the projects-dnd.scenario.test.ts precedent) rather than Playwright's
// high-level dragAndDrop, which is not reliable for custom HTML5 DnD.
import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { ks } from "./helpers/db-reads"
import { freshAccessToken } from "./helpers/fresh-token"
import {
  grantPhase8AttentionScopes,
  resetAttentionForUser,
  seedApprovalsForFacets,
} from "./helpers/projects-seed"

/** Seed one persisted attention row directly (a mail item, a system alert):
 *  the full simulation helpers are unnecessary machinery for a layout test
 *  that never opens the row. */
async function seedAttentionRow(
  env: Parameters<typeof resetAttentionForUser>[0],
  orgId: string,
  userId: string,
  row: { app: string; entityType: string; kind: string; urgency: number; summary: string },
): Promise<void> {
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.attention_events
       (id, org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
        actor_type, occurred_at, digest_eligible_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'system', now(), now(), now())`,
    [orgId, userId, row.app, row.entityType, randomUUID(), row.kind, row.urgency, row.summary],
  )
}

/** Drag a card by its handle onto another card's body, via explicit
 *  DataTransfer events (HomeCard.tsx gates dragstart to the handle testid). */
async function dragCardOnto(page: Page, draggedId: string, targetId: string): Promise<void> {
  await page.evaluate(
    ({ draggedId, targetId }) => {
      const handle = document.querySelector(
        `[data-testid="home-card-handle-${draggedId}"]`,
      ) as HTMLElement | null
      const target = document.querySelector(
        `[data-testid="home-card-${targetId}"]`,
      ) as HTMLElement | null
      if (!handle || !target) throw new Error(`drag elements missing: ${draggedId} -> ${targetId}`)
      const dt = new DataTransfer()
      const rect = target.getBoundingClientRect()
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + rect.height / 2
      handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientX, clientY }),
      )
      handle.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }))
    },
    { draggedId, targetId },
  )
}

async function cardOrderInDom(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-testid="home-feed"] section[data-testid^="home-card-"]'),
    ).map((el) => (el as HTMLElement).dataset.testid!.replace("home-card-", "")),
  )
}

test("home-cards.reorder-collapse-persist-scroll", async ({ page, env, qa, world }) => {
  const orgId = world.org.id
  const aminaId = qa.amina.id

  await grantPhase8AttentionScopes(env, orgId, aminaId)
  // The grant moved Amina's permission version: her worker token is stale.
  const aminaToken = await freshAccessToken(
    env.serverUrl,
    "amina@resonantaudiolabs.example",
    "QaPass1!",
  )
  await resetAttentionForUser(env, orgId, aminaToken, qa.admin.token)

  // 9 pending approvals -- over the fold threshold of 5 (Home.tsx
  // APPROVALS_FOLD_OVER), so the card shows the first 3 and folds the rest
  // behind a "Show N more" button rather than pushing Alerts/Activity below.
  // Each is staged in its own agent turn: Home folds one run's cards, or a
  // day of one action with no run behind it, into a single row (the next
  // test), and this one needs 9 rows.
  await seedApprovalsForFacets(env, {
    orgId,
    userId: aminaId,
    toolNames: Array.from({ length: 9 }, () => "test:gatedEcho"),
    runPerCard: true,
  })
  // A system alert gives the Alerts card (id "messages") content to drag.
  await seedAttentionRow(env, orgId, aminaId, {
    app: "kernel",
    entityType: "system",
    kind: "system_alert",
    urgency: 80,
    summary: "Home cards seed: system alert",
  })
  // New mail is Mail's (D21): this row must not bring a Mail card back.
  await seedAttentionRow(env, orgId, aminaId, {
    app: "mail",
    entityType: "conversation",
    kind: "unassigned",
    urgency: 20,
    summary: "Home cards seed: mail item",
  })

  await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
  await page.getByTestId("activity-home").click()
  // D21: Home opens on its overview cards, with its own sidebar.
  await expect(page.getByTestId("home-attention-sidebar")).toBeVisible({ timeout: 10_000 })
  await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })

  const approvalsCard = page.getByTestId("home-card-approvals")
  const alertsCard = page.getByTestId("home-card-messages")
  await expect(approvalsCard).toBeVisible({ timeout: 10_000 })
  await expect(alertsCard).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("home-card-count-approvals")).toHaveText("9")
  await expect(page.getByTestId("home-card-mail")).toHaveCount(0)
  // Needs you lists the same 9 approvals the card does: these seeds expire
  // within the hour, so each is a time-limited row (any left are counted on
  // the Approvals row).
  await expect(async () => {
    const timeLimited = await page
      .locator('[data-testid^="home-side-time-kernel:approval_pending:"]')
      .count()
    const grouped = page.getByTestId("home-side-approvals-count")
    const rest = (await grouped.count()) > 0 ? Number(await grouped.textContent()) : 0
    expect(timeLimited + rest).toBe(9)
  }).toPass({ timeout: 5_000 })

  // Approvals card shows 3 of the 9 rows and folds the other 6 behind
  // "Show 6 more" instead of scrolling.
  const approvalsBody = page.getByTestId("home-card-body-approvals")
  await expect(approvalsBody).toBeVisible()
  await expect(page.getByTestId("home-approvals-fold")).toHaveText(/Show\s+6\s+more/)

  // Default order puts approvals before the alerts.
  const beforeDrag = await cardOrderInDom(page)
  expect(beforeDrag.indexOf("messages")).toBeGreaterThan(beforeDrag.indexOf("approvals"))

  // Visual baseline: Home cards populated, approvals overflowing/scrolled.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await expect(page.getByTestId("home")).toHaveScreenshot("home-cards-populated.png", {
    maxDiffPixelRatio: 0.05,
    // The status line carries counts and "updated" time that vary run to run.
    mask: [page.getByTestId("home-status")],
  })

  // Drag the alerts onto approvals -- they were AFTER approvals in the
  // current order, so they land immediately before it (home-card-layout's
  // reorderCards: dragged-was-after -> insert AT the target's position).
  await dragCardOnto(page, "messages", "approvals")
  await expect(async () => {
    const order = await cardOrderInDom(page)
    expect(order.indexOf("messages")).toBeLessThan(order.indexOf("approvals"))
  }).toPass({ timeout: 5_000 })

  // Text in a card body is selectable with a real mouse drag, and letting go
  // neither unfolds the row nor starts a card drag (only the header drags).
  const firstTitle = approvalsBody
    .locator('[data-testid^="attention-row-"][data-testid$="-title"]')
    .first()
  const titleRow = approvalsBody
    .locator('[data-testid^="attention-row-"][data-testid$="-details"]')
    .first()
  await expect(titleRow).toHaveAttribute("aria-expanded", "false")
  const box = await firstTitle.boundingBox()
  if (!box) throw new Error("approval row title has no box")
  const orderBeforeSelect = await cardOrderInDom(page)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).not.toBe("")
  await expect(titleRow).toHaveAttribute("aria-expanded", "false")
  expect(await cardOrderInDom(page)).toEqual(orderBeforeSelect)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())

  // Collapse the approvals card.
  await page.getByTestId("home-card-collapse-approvals").click()
  await expect(page.getByTestId("home-card-body-approvals")).toHaveCount(0, { timeout: 5_000 })

  // Visual baseline: a collapsed card (chevron rotated, body gone, handle/count/chevron still visible).
  await page.waitForTimeout(200)
  await expect(page.getByTestId("home")).toHaveScreenshot("home-cards-collapsed.png", {
    maxDiffPixelRatio: 0.05,
    // The status line carries counts and "updated" time that vary run to run.
    mask: [page.getByTestId("home-status")],
  })

  // The debounced PUT fires; verify SERVER persistence directly (not just
  // that the DOM looks right, which localStorage alone could also explain).
  await expect
    .poll(
      async () => {
        const res = await api(env.serverUrl, "/api/user/preferences", { token: aminaToken })
        const layout = res.body.data?.homeCardLayout as {
          order: string[]
          collapsed: string[]
        } | null
        return layout
          ? {
              orderOk: layout.order.indexOf("messages") < layout.order.indexOf("approvals"),
              collapsed: layout.collapsed,
            }
          : null
      },
      { timeout: 10_000 },
    )
    .toMatchObject({ orderOk: true, collapsed: ["approvals"] })

  // Clear localStorage (proves the persisted state comes from the SERVER,
  // not a client-only fallback) and reload. home-card-layout.ts keeps NO
  // localStorage of its own -- it is server-only by design -- but the auth
  // module gates session restoration on a `liaison:session` localStorage
  // flag, so a blanket clear would also log Amina out before the reload can
  // even reach Home. Preserve just that flag; everything relevant to the
  // card layout is cleared (there is nothing else to clear).
  await page.evaluate(() => {
    const session = localStorage.getItem("liaison:session")
    localStorage.clear()
    if (session) localStorage.setItem("liaison:session", session)
  })
  await page.reload()
  await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })

  // The persisted layout preference loads asynchronously, so the feed can
  // briefly render in default order before it applies.
  await expect(async () => {
    const order = await cardOrderInDom(page)
    expect(order.indexOf("messages")).toBeLessThan(order.indexOf("approvals"))
  }).toPass({ timeout: 5_000 })
  await expect(page.getByTestId("home-card-body-approvals")).toHaveCount(0)
  // Collapsed cards still show their count pill / handle -- only the body is gone.
  await expect(page.getByTestId("home-card-approvals")).toBeVisible()
})

test("home-cards.same-day-same-action-approvals-group", async ({ page, env, qa, world }) => {
  const orgId = world.org.id
  const aminaId = qa.amina.id

  await grantPhase8AttentionScopes(env, orgId, aminaId)
  const aminaToken = await freshAccessToken(
    env.serverUrl,
    "amina@resonantaudiolabs.example",
    "QaPass1!",
  )
  await resetAttentionForUser(env, orgId, aminaToken, qa.admin.token)
  // The test above leaves Amina's Approvals card collapsed (server-side).
  const layout = await api(env.serverUrl, "/api/user/preferences/home-cards", {
    method: "PUT",
    token: aminaToken,
    body: { order: ["approvals", "messages", "feed"], collapsed: [] },
  })
  expect(layout.status).toBe(200)

  // Three of one action for the same approver on one day, with no run behind
  // them: Home shows them as ONE row that opens to the three cards, and the
  // card counts that row once.
  await seedApprovalsForFacets(env, {
    orgId,
    userId: aminaId,
    toolNames: ["test:gatedEcho", "test:gatedEcho", "test:gatedEcho"],
  })

  await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
  await page.getByTestId("activity-home").click()
  await page.waitForSelector("[data-testid='home-feed']", { timeout: 10_000 })

  const approvalsBody = page.getByTestId("home-card-body-approvals")
  await expect(approvalsBody).toBeVisible({ timeout: 10_000 })
  const group = approvalsBody.getByTestId("approval-run-group-row")
  await expect(group).toHaveCount(1, { timeout: 10_000 })
  await expect(group).toHaveAttribute("data-count", "3")
  await expect(page.getByTestId("home-card-count-approvals")).toHaveText("1")
  await expect(page.getByTestId("home-approvals-fold")).toHaveCount(0)

  // Opening the row lists each card, still decided on its own.
  await group.getByTestId("approval-run-group-toggle").click()
  await expect(
    group
      .getByTestId("approval-run-group-list")
      .locator('[data-testid^="attention-row-"][data-testid$="-details"]'),
  ).toHaveCount(3)
})
