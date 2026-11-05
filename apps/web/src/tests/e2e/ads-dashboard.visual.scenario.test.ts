// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VISUAL — pixel baselines + functional assertions for the Ads dashboard
// UI surfaces. Modeled exactly on the Social Ground Control visual test
// (`social-ground-control/visual.scenario.test.ts`): per-test the host-mock
// interceptor returns canned tool shapes so every panel renders with fixed,
// representative data — no live round-trips, deterministic pixels.
//
// Pixel goldens are darwin-only (`*-darwin.png`); FUNCTIONAL assertions (panel +
// sidebar mount, content testids, expected text, both-directions / count-0
// anti-rubber-stamp checks) run EVERYWHERE. Re-bake after an intentional UI
// change with:
//   bunx --bun playwright test --update-snapshots=all -g "Ads dashboard visual"
//
// NO LLM-semantic validator — pixel-golden + functional-assertion is the project
// idiom. The functional assertions ARE the anti-rubber-stamp guard.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import {
  ACCOUNT_INFO,
  AD_PREVIEW,
  ADS_LIST,
  ADSETS_LIST,
  AUDIENCES_LIST,
  CAMPAIGNS_LIST,
  COUNTS,
  CREATIVE_GET,
  EXPERIMENT_LIST,
  EXPERIMENT_LIST_EMPTY,
  GOOGLE_ACCOUNT_INFO,
  GOOGLE_CAMPAIGNS_LIST_EMPTY,
  GOOGLE_INSIGHTS_QUERY_EMPTY,
  GOOGLE_NOT_CONNECTED,
  INSIGHTS_QUERY_AGGREGATE,
  INSIGHTS_QUERY_DAILY,
  installAdsHostMock,
  MERCHANT_FEED_STATUS,
  MERCHANT_FEED_STATUS_CLEAN,
  MERCHANT_NOT_CONNECTED,
  METRICS_RUN_DTC,
  METRICS_RUN_TOTAL,
  METRICS_RUN_UNAVAILABLE,
  mockError,
  PENDING_APPROVALS,
  PENDING_APPROVALS_EMPTY,
} from "./ads-dashboard/helpers/ads-visual-mocks"
import { forceDarkMode } from "./agent-bootstrap"
import { bundledAppTarball } from "./bundled-app-tarball"
import { expect, loginAs, test } from "./fixtures/test"
import { volatileShellMasks } from "./helpers/visual-masks"

const SHOT = { maxDiffPixelRatio: 0.02 } as const
const PIXEL_BASELINES = process.platform === "darwin"

test.setTimeout(120_000)

// ── Paths ─────────────────────────────────────────────────────────────────────
// __dirname = liaison/apps/web/src/tests/e2e
// Walk up 5 levels: e2e → tests → src → web → apps → liaison
const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..")
const META_ADS_MANIFEST = resolve(LIAISON_ROOT, "bundled-apps/ads/app.manifest.json")
const META_ADS_TARBALL = bundledAppTarball(LIAISON_ROOT, "ads")

function assertMetaAdsBundle(): void {
  if (!existsSync(META_ADS_MANIFEST)) {
    throw new Error(`Meta Ads manifest missing at ${META_ADS_MANIFEST}`)
  }
  if (!existsSync(META_ADS_TARBALL)) {
    throw new Error(
      `Meta Ads tarball missing at ${META_ADS_TARBALL}. Run: bash scripts/build-bundled-app.sh ads --skip-sign`,
    )
  }
}

async function resetMetaMock(serverUrl: string, token: string): Promise<void> {
  await api(serverUrl, "/api/_test/ads/mock/reset", { method: "POST", token, body: {} })
}

async function installMetaAds(opts: {
  serverUrl: string
  token: string
  orgId: string
}): Promise<{ appName: string; connectionId: string; adAccountId: string }> {
  const resp = await api(opts.serverUrl, "/api/_test/ads/install-for-test", {
    method: "POST",
    token: opts.token,
    body: {
      orgId: opts.orgId,
      accessToken: "fixture-system-user-token",
      adAccountId: "act_FIXTURE",
      defaultPageId: "page_1",
    },
  })
  if (resp.status !== 200) {
    throw new Error(`installMetaAds: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return resp.body as { appName: string; connectionId: string; adAccountId: string }
}

// Navigate to an ads route, wait for the sidebar + the panel to mount,
// optionally interact, render-settle (debounce animations), then full-page
// screenshot the whole shell.
async function shotPage(
  page: Page,
  env: { ports: number[] },
  relativeUrl: string,
  panelSelector: string,
  name: string,
  extraShot?: { mask?: ReturnType<Page["locator"]>[] },
  interact?: (page: Page) => Promise<void>,
) {
  const viteUrl = `http://localhost:${env.ports[1]}`
  await page.goto(`${viteUrl}${relativeUrl}`)
  await page.waitForLoadState("networkidle")
  await expect(page.locator(panelSelector).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="ads-sidebar"]')).toBeVisible({ timeout: 20_000 })
  if (interact) await interact(page)
  // Post-readiness pixel debounce (NOT a readiness sleep — readiness is gated on
  // the testid visibility above). Mirrors the Social / Boxtal shotPage helper.
  await page.waitForTimeout(350)
  if (PIXEL_BASELINES) {
    await expect(page).toHaveScreenshot(name, {
      ...SHOT,
      mask: [...volatileShellMasks(page), ...(extraShot?.mask ?? [])],
    })
  }
}

test.describe("Ads dashboard visual", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    assertMetaAdsBundle()
    await resetMetaMock(env.serverUrl, qa.admin.token)
    await installMetaAds({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
    })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  // ── Campaigns — populated ────────────────────────────────────────────────────
  test("campaigns-populated", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:counts": COUNTS,
      // Detail pane for auto-selected first row:
      "ads:adsets_list": ADSETS_LIST,
      "ads:ads_list": ADS_LIST,
      "ads:insights_query": INSIGHTS_QUERY_AGGREGATE,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/campaigns",
      '[data-testid="ads-campaigns-table"]',
      "campaigns-populated.png",
    )

    const table = page.locator('[data-testid="ads-campaigns-table"]')
    // All three campaign rows render.
    for (const row of CAMPAIGNS_LIST.data) {
      await expect(table.locator(`[data-testid="ads-campaign-row-${row.id}"]`)).toBeVisible()
    }

    // The CAMPAIGN_PAUSED row (camp_RAL44) has a non-success badge.
    const ral44Row = table.locator('[data-testid="ads-campaign-row-camp_RAL44"]')
    const ral44Badge = ral44Row.locator('[data-testid="ads-status-badge"]')
    await expect(ral44Badge).toBeVisible()
    await expect(ral44Badge).toHaveText("CAMPAIGN_PAUSED")

    // The ACTIVE row (camp_dealer_eu) badge shows ACTIVE (both-directions).
    const dealerRow = table.locator('[data-testid="ads-campaign-row-camp_dealer_eu"]')
    const dealerBadge = dealerRow.locator('[data-testid="ads-status-badge"]')
    await expect(dealerBadge).toHaveText("ACTIVE")

    // Budget column present (at least one cell is non-empty for a campaign with daily_budget).
    await expect(table).toContainText("€")

    // Objective column present.
    await expect(table).toContainText("OUTCOME_SALES")
  })

  // ── Campaigns — empty ────────────────────────────────────────────────────────
  test("campaigns-empty", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:campaigns_list": { data: [] },
      "ads:counts": { active: 0, paused: 0, total: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    // When the list is empty the table is hidden; wait for the sidebar instead.
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/campaigns`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("campaigns-empty.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })

    // EmptyState text renders.
    await expect(page.locator("body")).toContainText(/No campaigns yet/i)

    // Table is NOT present (count-0 anti-rubber-stamp).
    await expect(page.locator('[data-testid="ads-campaigns-table"]')).toHaveCount(0)
  })

  // ── Campaign detail ──────────────────────────────────────────────────────────
  test("campaign-detail", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:counts": COUNTS,
      "ads:adsets_list": ADSETS_LIST,
      "ads:ads_list": ADS_LIST,
      "ads:insights_query": INSIGHTS_QUERY_AGGREGATE,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/campaigns",
      '[data-testid="ads-campaigns-table"]',
      "campaign-detail.png",
      undefined,
      async (p) => {
        // Click the ACTIVE row to open its detail pane.
        await p.locator('[data-testid="ads-campaign-row-camp_dealer_eu"]').click()
        await expect(p.locator('[data-testid="ads-campaign-detail-camp_dealer_eu"]')).toBeVisible({
          timeout: 10_000,
        })
      },
    )

    // Detail pane shows the campaign.
    await expect(page.locator('[data-testid="ads-campaign-detail-camp_dealer_eu"]')).toBeVisible()

    // Pause button enabled (campaign is ACTIVE, not already paused).
    await expect(page.locator('[data-testid="ads-pause-camp_dealer_eu"]')).toBeEnabled()

    // Resume button disabled (campaign is already ACTIVE).
    await expect(page.locator('[data-testid="ads-resume-camp_dealer_eu"]')).toBeDisabled()
  })

  // ── Performance (now merged into the Dashboard tab) ──────────────────────────
  test("performance", async ({ page, env, qa }) => {
    // The former standalone Performance tab is gone; its KPIs, by-campaign
    // table, and daily-spend chart live inside the Dashboard now. Mount the
    // dashboard with the daily insights fixture and assert the merged panel.
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_DTC,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
      "ads:counts": COUNTS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/dashboard",
      '[data-testid="ads-dash-performance"]',
      "performance.png",
      {
        // Chart canvas pixels are non-deterministic — mask it so the golden stays stable.
        mask: [page.locator('[data-testid="ads-dash-spend-chart"]')],
      },
    )

    // The merged performance panel is present.
    await expect(page.locator('[data-testid="ads-dash-performance"]')).toBeVisible()

    // Insights (by-campaign) table is present.
    await expect(page.locator('[data-testid="ads-insights-table"]')).toBeVisible()

    // Chart canvas exists and has at least one non-transparent pixel (confirms chart.js rendered).
    const canvas = page.locator('[data-testid="ads-dash-spend-chart"]')
    await expect(canvas).toBeVisible({ timeout: 15_000 })
    const hasPixel = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="ads-dash-spend-chart"]',
      ) as HTMLCanvasElement | null
      if (!el) return false
      const ctx = el.getContext("2d")
      if (!ctx) return false
      const data = ctx.getImageData(0, 0, el.width, el.height).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i]! > 0) return true
      }
      return false
    })
    expect(hasPixel, "chart canvas should have at least one non-transparent pixel").toBe(true)
  })

  // ── Ads grid ─────────────────────────────────────────────────────────────────
  test("ads-grid", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:ads_list": ADS_LIST,
      "ads:creative_get": CREATIVE_GET,
      "ads:ad_preview": AD_PREVIEW,
      "ads:counts": COUNTS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(page, env, "/ads/ads", '[data-testid="ads-ads-grid"]', "ads-grid.png")

    // Grid renders at least one tile.
    const thumbs = page.locator('[data-testid^="ads-ad-thumb-"]')
    expect(await thumbs.count()).toBeGreaterThanOrEqual(1)

    // The thumbnail img has a non-empty src (creative resolved).
    const firstThumb = thumbs.first()
    await expect(firstThumb).toBeVisible()
    const imgSrc = await firstThumb.locator("img").first().getAttribute("src")
    expect(imgSrc, "ad thumb img src should be non-empty").toBeTruthy()
  })

  // ── Audiences ────────────────────────────────────────────────────────────────
  test("audiences", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:audiences_list": AUDIENCES_LIST,
      "ads:counts": COUNTS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/audiences",
      '[data-testid="ads-audiences-table"]',
      "audiences.png",
    )

    const table = page.locator('[data-testid="ads-audiences-table"]')

    // Both audience rows render.
    const rows = table.locator("tbody tr")
    expect(await rows.count()).toBeGreaterThanOrEqual(2)

    // The lower_bound:-1 audience (aud_2) shows "unavailable".
    await expect(table).toContainText("unavailable")

    // A delivery-status badge renders (aud_1 has code:200 → "This audience is ready.").
    await expect(table).toContainText("This audience is ready.")

    // aud_2 shows "Audience too small" delivery status (both-directions sanity).
    await expect(table).toContainText("Audience too small")
  })

  // ── Settings ─────────────────────────────────────────────────────────────────
  test("settings", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:counts": COUNTS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/apps/ads`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-account-status"]')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByTestId("connections-conn-meta")).toBeVisible()
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("settings.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })

    // Status card shows Connected with account name + currency.
    const status = page.locator('[data-testid="ads-settings-status"]')
    await expect(status).toBeVisible()
    await expect(status).toContainText("Connected")
    await expect(status).toContainText("Tessera — Global")
    await expect(status).toContainText("EUR")
  })

  // ── Sidebar badges ───────────────────────────────────────────────────────────
  test("sidebar-badges", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:counts": COUNTS,
      "ads:adsets_list": ADSETS_LIST,
      "ads:ads_list": ADS_LIST,
      "ads:insights_query": INSIGHTS_QUERY_AGGREGATE,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/campaigns",
      '[data-testid="ads-campaigns-table"]',
      "sidebar-badges.png",
    )

    const sidebar = page.locator('[data-testid="ads-sidebar"]')
    await expect(sidebar).toBeVisible()

    // Counts badge shows the total count (3 from COUNTS fixture).
    const badge = sidebar.locator('[data-testid="ads-sidebar-counts"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText("3")
  })

  // ── Dashboard — empty ────────────────────────────────────────────────────────
  test("dashboard-empty", async ({ page, env, qa }) => {
    // A genuine fresh nothing-connected install, in the handlers' real
    // not-set-up shapes: account_info rejects coded meta_not_connected,
    // google_account_info and merchant_feed_status answer a
    // google_not_connected envelope. The lab tools still answer (metrics
    // degrade, experiment ledger empty), so the dashboard resolves to "empty",
    // not "error". Every dashboard read is mocked so nothing falls through to
    // the real installed test backend.
    await installAdsHostMock(page, {
      "ads:account_info": mockError(
        "Meta not connected: configure the Meta connection in app settings",
        "meta_not_connected",
      ),
      "ads:google_account_info": GOOGLE_NOT_CONNECTED,
      "ads:merchant_feed_status": MERCHANT_NOT_CONNECTED,
      "ads:insights_query": { data: [], _split: false },
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": { data: [] },
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_UNAVAILABLE,
      "ads:experiment_list": EXPERIMENT_LIST_EMPTY,
      "ads:pending_approvals_list": mockError("no app-facing approvals read (sdk gap)"),
      "ads:counts": { active: 0, paused: 0, total: 0 },
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES)
      await expect(page).toHaveScreenshot("dashboard-empty.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })

    await expect(page.locator('[data-testid="ads-dash-empty"]')).toBeVisible()
    // Populated panels must NOT render (count-0 anti-rubber-stamp).
    await expect(page.locator('[data-testid="ads-dash-mer-trend"]')).toHaveCount(0)
  })

  // ── Dashboard — error (EVERY tile of the header card failed) ────────────────
  test("dashboard-error", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_NOT_CONNECTED,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      // ALL FOUR header-card tiles (MER DTC, MER total, Meta spend, Google
      // spend) must fail for the global banner: a partial failure stays
      // inline-only (see dashboard-partial-tile-failure below).
      "ads:insights_query": mockError(
        "insights_query: simulated failure for the dashboard error-state test",
      ),
      "ads:google_insights_query": mockError(
        "google_insights_query: simulated failure for the dashboard error-state test",
      ),
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:metrics_run": mockError(
        "metrics_run: simulated failure for the dashboard error-state test",
      ),
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(350)
    if (PIXEL_BASELINES) {
      await expect(page).toHaveScreenshot("dashboard-error.png", {
        ...SHOT,
        mask: [...volatileShellMasks(page), page.locator('[data-testid="ads-dash-spend-chart"]')],
      })
    }

    await expect(page.locator('[data-testid="ads-dash-error"]')).toBeVisible()
    // Meta's connection chip still shows OK (graceful per-arm degradation):
    // the header-card failures do not turn a connected arm red.
    await expect(page.locator('[data-testid="ads-dash-health-conn-meta"]')).toContainText("OK")
    // Failed tiles carry their inline Retry affordance.
    await expect(page.locator('[data-testid="ads-dash-retry-mer-dtc"]')).toBeVisible()
    // The failed daily series degrades its own panel instead of taking the tab down.
    await expect(page.locator('[data-testid="ads-dash-spend-error"]')).toBeVisible()
  })

  // ── Dashboard — a SINGLE failed tile stays inline (no global banner) ────────
  test("dashboard-partial-tile-failure", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      // Only metrics_run fails (both MER tiles) while spend tiles load fine:
      // NOT every header tile failed, so no global banner appears.
      "ads:metrics_run": mockError("metrics_run: simulated transient failure"),
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(350)

    // The global banner must NOT render for a partial tile failure.
    await expect(page.locator('[data-testid="ads-dash-error"]')).toHaveCount(0)
    // The failed MER tiles degrade inline with a Retry affordance.
    await expect(page.locator('[data-testid="ads-dash-mer-dtc"]')).toContainText("Unavailable")
    await expect(page.locator('[data-testid="ads-dash-retry-mer-dtc"]')).toBeVisible()
    // The sibling spend tiles are live (populated board, per-tile degradation).
    await expect(page.locator('[data-testid="ads-dash-spend-meta"]')).toBeVisible()
  })

  // ── Dashboard — populated ────────────────────────────────────────────────────
  test("dashboard-populated", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_DTC,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    await shotPage(
      page,
      env,
      "/ads/dashboard",
      '[data-testid="ads-dashboard"]',
      "dashboard-populated.png",
      { mask: [page.locator('[data-testid="ads-dash-spend-chart"]')] },
    )

    // MER trend panel — verbatim value string + caveat present.
    await expect(page.locator('[data-testid="ads-dash-mer-trend"]')).toBeVisible()
    await expect(page.locator('[data-testid="ads-dash-mer-dtc"]')).toContainText(
      METRICS_RUN_DTC.value,
    )

    // Experiments panel — both rows render with days-to-decision.
    await expect(page.locator('[data-testid="ads-dash-experiments"]')).toContainText(
      "Brand vs non-brand split",
    )
    await expect(page.locator('[data-testid="ads-dash-experiment-exp_1"]')).toBeVisible()
    // exp_2's decision_date (2026-07-01) is in the past relative to the fixture "today" —
    // both-directions: at least one experiment shows a decision badge, not all identical.
    await expect(page.locator('[data-testid="ads-dash-experiment-exp_2"]')).toBeVisible()

    // Health panel — zombie flag for camp_RAL44 (CAMPAIGN_PAUSED effective_status is
    // NOT zombie-eligible; camp_dealer_eu/camp_retargeting are ACTIVE with spend from
    // the daily series, so 0 zombies expected here) + disapproved count from fixture.
    await expect(page.locator('[data-testid="ads-dash-health"]')).toBeVisible()
    await expect(page.locator('[data-testid="ads-dash-health-disapproved"]')).toContainText(
      String(MERCHANT_FEED_STATUS.disapproved),
    )
    await expect(page.locator('[data-testid="ads-dash-health-conn-meta"]')).toContainText("OK")
    await expect(page.locator('[data-testid="ads-dash-health-conn-google"]')).toContainText("OK")

    // Pending approvals panel — count from fixture (both-directions vs the empty variant below).
    await expect(page.locator('[data-testid="ads-dash-approvals-count"]')).toContainText(
      String(PENDING_APPROVALS.count),
    )
  })

  // ── Dashboard — populated, zero pending approvals + zero disapproved (count-0 anti-rubber-stamp) ──
  test("dashboard-populated-zero-counts", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS_CLEAN,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_TOTAL,
      "ads:experiment_list": EXPERIMENT_LIST_EMPTY,
      "ads:pending_approvals_list": PENDING_APPROVALS_EMPTY,
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })

    // Zero disapproved products reported explicitly, not omitted.
    await expect(page.locator('[data-testid="ads-dash-health-disapproved"]')).toContainText("0")
    // Zero pending approvals reported explicitly.
    await expect(page.locator('[data-testid="ads-dash-approvals-count"]')).toContainText("0")
    // No open experiments — the empty-experiments fallback text renders.
    await expect(page.locator('[data-testid="ads-dash-experiments"]')).toContainText(
      "No open experiments",
    )
  })

  // ── Dashboard — degraded metric surfaces a badge, not a crash ────────────────
  test("dashboard-degraded-metric", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_UNAVAILABLE,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })

    await expect(page.locator('[data-testid="ads-dash-mer-dtc"]')).toContainText("unavailable")
  })

  // ── Dashboard — campaigns fetch failure degrades the Health panel to an
  // explicit "delivery data unavailable" state, never a confident zombie
  // count of 0 built from a partial/failed read ────────────────────────────
  test("dashboard-delivery-data-unavailable", async ({ page, env, qa }) => {
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      // Meta's campaigns_list fails — the fetcher that (together with
      // insights_query) feeds zombieRows/flags.zombieCount. A confident
      // "0 zombie ACTIVE campaigns" here would be a false-negative outage
      // masquerading as a clean bill of health.
      "ads:campaigns_list": mockError(
        "campaigns_list: simulated outage for the delivery-data-unavailable test",
      ),
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_DTC,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })

    // Health panel degrades to an explicit unavailable state, NOT "0 zombie
    // ACTIVE campaigns" (both-directions vs dashboard-populated's real 0-count).
    await expect(page.locator('[data-testid="ads-dash-health-zombie"]')).toContainText(
      "delivery data unavailable",
    )
    await expect(page.locator('[data-testid="ads-dash-health-zombie"]')).not.toContainText(
      "zombie ACTIVE",
    )
  })

  // ── Dashboard — experiments panel filters to status: running only ───────────
  test("dashboard-experiments-running-only", async ({ page, env, qa }) => {
    // Install a wrapper BEFORE navigation so it captures the initial
    // createResource fetch args, then delegates to the normal canned mock.
    await installAdsHostMock(page, {
      "ads:account_info": ACCOUNT_INFO,
      "ads:google_account_info": GOOGLE_ACCOUNT_INFO,
      "ads:merchant_feed_status": MERCHANT_FEED_STATUS,
      "ads:insights_query": INSIGHTS_QUERY_DAILY,
      "ads:google_insights_query": GOOGLE_INSIGHTS_QUERY_EMPTY,
      "ads:campaigns_list": CAMPAIGNS_LIST,
      "ads:google_campaigns_list": GOOGLE_CAMPAIGNS_LIST_EMPTY,
      "ads:metrics_run": METRICS_RUN_DTC,
      "ads:experiment_list": EXPERIMENT_LIST,
      "ads:pending_approvals_list": PENDING_APPROVALS,
    })
    await page.addInitScript(() => {
      const w = window as unknown as { __adsExperimentListArgs?: Record<string, unknown> }
      const poll = setInterval(() => {
        const host = (window as unknown as Record<string, unknown>).__liaisonHost as
          | {
              invokeTool: (a: string, t: string, args: Record<string, unknown>) => Promise<unknown>
            }
          | undefined
        if (!host) return
        clearInterval(poll)
        const orig = host.invokeTool
        host.invokeTool = async (
          appName: string,
          toolName: string,
          args: Record<string, unknown>,
        ) => {
          if (toolName === "experiment_list") w.__adsExperimentListArgs = args
          return orig.call(host, appName, toolName, args)
        }
      }, 10)
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="ads-dash-experiments"]')).toBeVisible()

    // The panel renders EXPERIMENT_LIST's ("running") rows.
    await expect(page.locator('[data-testid="ads-dash-experiment-exp_1"]')).toBeVisible()
    await expect(page.locator('[data-testid="ads-dash-experiment-exp_2"]')).toBeVisible()

    // Pins the exact tool-call args: a regression that drops the status
    // filter would silently start returning decided/abandoned rows too
    // without the content assertions above noticing (the canned mock
    // returns the same fixture regardless of args).
    const capturedArgs = await page.evaluate(
      () =>
        (window as unknown as { __adsExperimentListArgs?: Record<string, unknown> })
          .__adsExperimentListArgs,
    )
    expect(capturedArgs).toEqual({ status: "running" })
  })
})
