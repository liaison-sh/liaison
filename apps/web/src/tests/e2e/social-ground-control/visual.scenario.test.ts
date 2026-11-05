// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VISUAL — pixel baselines + functional assertions for the Social "Ground
// Control" UI surfaces (§12 state matrix). Modeled exactly on the Boxtal
// `visual.scenario.test.ts`: per-test the host-mock interceptor returns canned
// tool shapes so every panel renders with fixed, representative data — no live
// round-trips, deterministic pixels.
//
// Pixel goldens are darwin-only (`*-darwin.png`); FUNCTIONAL assertions (panel +
// sidebar mount, content testids, expected text, both-directions / count-0
// anti-rubber-stamp checks) run EVERYWHERE. Re-bake after an intentional UI
// change with:
//   bunx --bun playwright test --update-snapshots=all -g "Social Ground Control visual"
//
// NO LLM-semantic validator — pixel-golden + functional-assertion is the project
// idiom (this codebase has no dual-path LLM validator). The functional
// assertions ARE the anti-rubber-stamp guard.

import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { volatileShellMasks } from "../helpers/visual-masks"
import { assertSocialBundle, expect, test } from "./helpers/social-fixtures"
import { installSocialApp, resetSocialMock } from "./helpers/social-harness"
import {
  CONVERSATIONS_WINDOWS,
  FINDINGS_MIXED,
  FINDINGS_OVERFLOW,
  findingFromRelationFixtures,
  installSocialHostMock,
  WATCHED_CADENCE,
  youtubeQuota,
} from "./helpers/social-visual-mocks"

const SHOT = { maxDiffPixelRatio: 0.02 } as const
const PIXEL_BASELINES = process.platform === "darwin"

test.setTimeout(120_000)

const COUNTS_QUIET = { findings_new: 0, awaiting_approval: 0, open_dms: 0 }

test.describe("Social Ground Control visual", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    assertSocialBundle()
    await resetSocialMock(env.serverUrl, qa.admin.token)
    await installSocialApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
    })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  // Navigate to a social route, wait for the SocialSidebar + the panel to mount,
  // optionally interact, render-settle (debounce the §12 stagger animation), then
  // full-page screenshot the whole shell.
  async function shotPage(
    page: Page,
    env: { ports: number[] },
    relativeUrl: string,
    panelSelector: string,
    name: string,
    interact?: (page: Page) => Promise<void>,
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}${relativeUrl}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator(panelSelector).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="social-sidebar"]')).toBeVisible({ timeout: 20_000 })
    if (interact) await interact(page)
    // Post-readiness pixel debounce (NOT a readiness sleep — readiness is gated on
    // the testid visibility above). Mirrors the Boxtal shotPage helper.
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot(name, { ...SHOT, mask: volatileShellMasks(page) })
  }

  // ── Surface 1 — Findings ──────────────────────────────────────────────────
  test("findings empty", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:findings_list": { findings: [] },
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "findings-empty.png",
    )
    await expect(page.locator('[data-testid="social-findings-list"]')).toContainText(
      /No findings yet/i,
    )
  })

  test("findings populated", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:findings_list": { findings: FINDINGS_MIXED },
      "social:findings_get": FINDINGS_MIXED[0],
      "social:counts": { findings_new: 1, awaiting_approval: 1, open_dms: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "findings-populated.png",
    )
    const list = page.locator('[data-testid="social-findings-list"]')
    // ≥1 "Awaiting approval" badge somewhere in the rendered surface.
    await expect(page.getByText("Awaiting approval").first()).toBeVisible()
    // Rows for the mixed findings render.
    for (const f of FINDINGS_MIXED) {
      await expect(list.locator(`[data-testid="social-finding-row-${f.id}"]`)).toBeVisible()
    }
    // The agent's drafted reply renders in the editable composer — "Approve &
    // post" now shows WHAT will be posted (not just the inbound comment).
    await expect(page.locator('[data-testid="social-reply-text"]')).toHaveValue(
      /fabrikam\.example\/shop/,
    )
  })

  test("findings approval surface", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:findings_list": { findings: FINDINGS_MIXED },
      "social:findings_get": FINDINGS_MIXED[0],
      "social:counts": { findings_new: 1, awaiting_approval: 1, open_dms: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    // The first fixture is awaiting_approval — selecting it surfaces the approval pane.
    const awaitingId = FINDINGS_MIXED[0].id
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "findings-approval-surface.png",
      async (p) => {
        await p.locator(`[data-testid="social-finding-row-${awaitingId}"]`).click()
        await expect(p.locator('[data-testid="social-approval-surface"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    await expect(page.locator('[data-testid="social-finding-detail"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-approve"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-reject"]')).toBeVisible()
    // The drafted reply is what Approve & post will send — surface it.
    await expect(page.locator('[data-testid="social-reply-text"]')).toHaveValue(
      /fabrikam\.example\/shop/,
    )
  })

  test("findings like greyed", async ({ page, env, qa }) => {
    const { yt, fb } = findingFromRelationFixtures()
    await installSocialHostMock(page, {
      "social:findings_list": { findings: [yt, fb] },
      "social:counts": { findings_new: 2, awaiting_approval: 0, open_dms: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "findings-like-greyed.png",
      async (p) => {
        await p.locator(`[data-testid="social-finding-row-${yt.id}"]`).click()
        await expect(p.locator('[data-testid="social-finding-detail"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    // YT like disabled, FB like enabled (both directions — anti-rubber-stamp).
    await expect(page.locator('[data-testid="social-like"]')).toBeDisabled()
    await page.locator(`[data-testid="social-finding-row-${fb.id}"]`).click()
    await expect(page.locator('[data-testid="social-like"]')).toBeEnabled()
  })

  test("findings overflow", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:findings_list": { findings: FINDINGS_OVERFLOW },
      "social:counts": { findings_new: 26, awaiting_approval: 6, open_dms: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "findings-overflow.png",
    )
    // The list renders many rows without layout break (overflow/storm density).
    const rows = page.locator('[data-testid^="social-finding-row-"]')
    expect(await rows.count()).toBeGreaterThanOrEqual(20)
  })

  // ── Surface 2 — Messages ────────────────────────────────────────────────────
  test("messages empty", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:dm_list": { conversations: [] },
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/messages",
      '[data-testid="social-messages-list"]',
      "messages-empty.png",
    )
    await expect(page.locator('[data-testid="social-messages-list"]')).toContainText(
      /No conversations/i,
    )
  })

  test("messages open window", async ({ page, env, qa }) => {
    const open = CONVERSATIONS_WINDOWS.find((c) => c.id === "c-open")!
    await installSocialHostMock(page, {
      "social:dm_list": { conversations: CONVERSATIONS_WINDOWS },
      "social:counts": { findings_new: 0, awaiting_approval: 0, open_dms: 3 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/messages",
      '[data-testid="social-messages-list"]',
      "messages-open-window.png",
      async (p) => {
        await p.locator(`[data-testid="social-conversation-row-${open.id}"]`).click()
        await expect(p.locator('[data-testid="social-dm-window-pill"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    await expect(page.locator('[data-testid="social-dm-window-pill"]')).toContainText(
      /Open \(24h\)/i,
    )
    await expect(page.locator('[data-testid="social-dm-compose"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-dm-fallback"]')).toHaveCount(0)
  })

  test("messages human agent window", async ({ page, env, qa }) => {
    const ha = CONVERSATIONS_WINDOWS.find((c) => c.id === "c-human-agent")!
    await installSocialHostMock(page, {
      "social:dm_list": { conversations: CONVERSATIONS_WINDOWS },
      "social:counts": { findings_new: 0, awaiting_approval: 0, open_dms: 3 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/messages",
      '[data-testid="social-messages-list"]',
      "messages-human-agent.png",
      async (p) => {
        await p.locator(`[data-testid="social-conversation-row-${ha.id}"]`).click()
        await expect(p.locator('[data-testid="social-dm-window-pill"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    await expect(page.locator('[data-testid="social-dm-window-pill"]')).toContainText(
      /Human-agent \(7d\)/i,
    )
    await expect(page.locator('[data-testid="social-dm-compose"]')).toBeVisible()
  })

  test("messages closed window", async ({ page, env, qa }) => {
    const closed = CONVERSATIONS_WINDOWS.find((c) => c.id === "c-closed")!
    await installSocialHostMock(page, {
      "social:dm_list": { conversations: CONVERSATIONS_WINDOWS },
      "social:counts": { findings_new: 0, awaiting_approval: 0, open_dms: 3 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/messages",
      '[data-testid="social-messages-list"]',
      "messages-closed-window.png",
      async (p) => {
        await p.locator(`[data-testid="social-conversation-row-${closed.id}"]`).click()
        await expect(p.locator('[data-testid="social-dm-fallback"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )
    await expect(page.locator('[data-testid="social-dm-window-pill"]')).toContainText(
      /Window closed/i,
    )
    await expect(page.locator('[data-testid="social-dm-open-native"]')).toBeVisible()
    // count-0 anti-rubber-stamp: closed window has NO compose box.
    await expect(page.locator('[data-testid="social-dm-compose"]')).toHaveCount(0)
  })

  // ── Surface 3 — Watched ─────────────────────────────────────────────────────
  test("watched empty", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:watched_list": { watched: [] },
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/watched",
      '[data-testid="social-watched-list"]',
      "watched-empty.png",
    )
    await expect(page.locator('[data-testid="social-watched-list"]')).toContainText(
      /Nothing watched yet/i,
    )
  })

  test("watched cadence matrix", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:watched_list": { watched: WATCHED_CADENCE },
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/watched",
      '[data-testid="social-watched-list"]',
      "watched-cadence-matrix.png",
    )
    await expect(page.locator('[data-testid="social-watched-cadence-w-hot"]')).toContainText("HOT")
    await expect(page.locator('[data-testid="social-watched-cadence-w-warm"]')).toContainText(
      "WARM",
    )
    await expect(page.locator('[data-testid="social-watched-cadence-w-cool"]')).toContainText(
      "COOL",
    )
    await expect(page.locator('[data-testid="social-watched-cadence-w-decayed"]')).toContainText(
      "DECAYED",
    )
    // The decayed row exposes a Resume action; the others do not (both directions).
    await expect(page.locator('[data-testid="social-watched-resume-w-decayed"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-watched-resume-w-hot"]')).toHaveCount(0)
  })

  // ── Settings ────────────────────────────────────────────────────────────────
  // The app's declarative settings page (/settings/apps/social): the kernel's
  // connections block and terms list read the real server; the quota block is
  // the app's own, fed by the host mock.
  test("settings disconnected", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:quota_status": youtubeQuota(0, 10_000, 0),
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/apps/social`)
    await page.waitForLoadState("networkidle")
    const connections = page.getByTestId("settings-section-connections")
    await expect(connections).toBeVisible({ timeout: 20_000 })
    for (const name of ["facebook", "instagram", "google"]) {
      const card = connections.getByTestId(`connections-conn-${name}`)
      await expect(card).toContainText("No account connected yet.")
      await expect(card.getByTestId(`connections-connect-${name}`)).toBeEnabled()
    }
    await expect(page.getByTestId("social-quota-readout")).toContainText("0 of 10,000 units today")
    // No quota banner when not exhausted (count-0 anti-rubber-stamp).
    await expect(page.locator('[data-testid="social-quota-banner"]')).toHaveCount(0)
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("settings-disconnected.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("settings quota exhausted", async ({ page, env, qa }) => {
    const added = await api(env.serverUrl, "/api/apps/social/tools/monitor_terms_add", {
      method: "POST",
      token: qa.admin.token,
      body: { params: { value: "Tessera", kind: "keyword" } },
    })
    expect(added.status).toBe(200)
    await installSocialHostMock(page, {
      "social:quota_status": youtubeQuota(10_000, 10_000, 5),
      "social:counts": COUNTS_QUIET,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/apps/social`)
    await page.waitForLoadState("networkidle")
    const terms = page.getByTestId("settings-section-terms")
    await expect(terms).toBeVisible({ timeout: 20_000 })
    await expect(terms).toContainText("Tessera")
    // Remove is the destructive action of the terms list (danger style).
    await expect(terms.getByText("Remove").first()).toHaveClass(/text-error/)
    await expect(page.locator('[data-testid="social-quota-banner"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-quota-banner"]')).toContainText("5")
    await expect(page.locator('[data-testid="social-quota-readout"]')).toContainText(
      "10,000 of 10,000 units today",
    )
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("settings-quota-exhausted.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  // ── Sidebar badges ──────────────────────────────────────────────────────────
  test("sidebar badges", async ({ page, env, qa }) => {
    await installSocialHostMock(page, {
      "social:findings_list": { findings: FINDINGS_MIXED },
      "social:counts": { findings_new: 3, awaiting_approval: 1, open_dms: 2 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/social/findings",
      '[data-testid="social-findings-list"]',
      "sidebar-badges.png",
    )
    const sidebar = page.locator('[data-testid="social-sidebar"]')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.locator('[data-testid="social-sidebar-badge-findings"]')).toContainText(
      "3",
    )
    await expect(sidebar.locator('[data-testid="social-sidebar-badge-awaiting"]')).toContainText(
      "1",
    )
    await expect(sidebar.locator('[data-testid="social-sidebar-badge-messages"]')).toContainText(
      "2",
    )
  })
})
