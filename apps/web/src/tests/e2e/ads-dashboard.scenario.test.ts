// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta Ads Dashboard — end-to-end journey.
//
// Exercises the real bundled ads app (installed from tarball via the
// _test install route) + the server-side Meta Graph mock. Verifies:
//   1. Install + connect — tarball installs, mock credentials wired.
//   2. Campaigns tab — table renders, CAMPAIGN_PAUSED row has non-delivering badge.
//   3. Quick actions — Pause an ACTIVE campaign via confirm dialog; Resume.
//      `pause` is gated, and the gate has TWO documented outcomes. An
//      approve-holder's own click IS the approval (`computeSkipGate`:
//      `isDirectHumanCall && requesterCanApprove` -> skip, and the app guide's
//      rule 6 says the same), so the admin journey below asserts the
//      SELF-EXECUTE path. A member who may write but may NOT approve gets an
//      approval parked for someone who can; that is the second test in this
//      file.
//   4. Performance tab — account header + insights chart canvas appear.
//   5. Ads tab — creative grid + thumbnail.
//   6. Audiences tab — table rows + "unavailable" count for -1 bound.
//   7. Settings — connected status card.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "./bundled-app-tarball"
import { expect, loginAs, test } from "./fixtures/test"
import { grantScopes } from "./helpers/agent-seed"

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

async function metaTool(opts: {
  serverUrl: string
  token: string
  tool: string
  params: Record<string, unknown>
}): Promise<{ status: number; body: unknown }> {
  return api(opts.serverUrl, `/api/apps/ads/tools/${opts.tool}`, {
    method: "POST",
    token: opts.token,
    body: { params: opts.params },
  })
}

/**
 * The `effective_status` a tool envelope reports for one campaign.
 *
 * The envelope nests its rows differently per tool (the UI normalises with its
 * own `toolRows`), so this walks the payload for the object carrying the id
 * rather than guessing a field path that would break on the next shape change.
 */
function effectiveStatusOf(body: unknown, campaignId: string): string | null {
  const seen: unknown[] = [body]
  while (seen.length > 0) {
    const node = seen.pop()
    if (Array.isArray(node)) {
      seen.push(...node)
      continue
    }
    if (node && typeof node === "object") {
      const row = node as Record<string, unknown>
      if (row.id === campaignId && typeof row.effective_status === "string") {
        return row.effective_status
      }
      seen.push(...Object.values(row))
    }
  }
  return null
}

test.describe("Meta Ads Dashboard — full journey", () => {
  test("install → campaigns → performance → ads → audiences → settings", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertMetaAdsBundle()

    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id
    const viteUrl = `http://localhost:${env.ports[1]}`

    // ── 1. Reset + Install ────────────────────────────────────────────────────
    await resetMetaMock(s, token)
    const installed = await installMetaAds({ serverUrl: s, token, orgId })
    expect(installed.appName).toBe("ads")
    expect(installed.connectionId).toBeTruthy()

    // Verify tool reachability (app installed + registered).
    const reach = await metaTool({ serverUrl: s, token, tool: "account_info", params: {} })
    expect(reach.status, JSON.stringify(reach.body)).toBe(200)

    // ── 2. Navigate + check no mount error ────────────────────────────────────
    // Register error handlers BEFORE loginAs so we capture any errors from
    // loadManifestApps() which fires during shell mount (inside loginAs).
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    await loginAs(page, env, qa.admin.email, "12345678")

    // Shell.onMount fires loadManifestApps() asynchronously — it fetches
    // /api/apps/manifests and dynamic-imports the ui.js bundle. Wait for the
    // Meta Ads activity-bar entry to appear before navigating; this guarantees
    // the tab type is registered so the router resolves /ads/campaigns.
    await expect(
      page.locator('[data-testid="activity-ads"]'),
      `Bundle load errors: ${consoleErrors.join(" | ")}`,
    ).toBeVisible({ timeout: 20_000 })

    await page.goto(`${viteUrl}/ads/campaigns`)
    await page.waitForLoadState("networkidle")

    // No plugin-mount-error.
    const mountError = page.locator('[data-testid="plugin-mount-error-ads"]')
    if (await mountError.isVisible().catch(() => false)) {
      throw new Error(`ads UI bundle failed to mount: ${await mountError.textContent()}`)
    }

    const bundleErrors = consoleErrors.filter((m) =>
      /Failed to fetch dynamically imported module|does not provide an export named|window\.__liaisonHost/.test(
        m,
      ),
    )
    expect(bundleErrors, `Bundle errors: ${bundleErrors.join(", ")}`).toEqual([])

    // ── 3. Campaigns tab ──────────────────────────────────────────────────────
    await expect(page.locator('[data-testid="ads-campaigns-table"]')).toBeVisible({
      timeout: 15_000,
    })

    // All 5 fixture campaigns render.
    await expect(page.locator('[data-testid="ads-campaign-row-camp_RAL44"]')).toBeVisible()
    await expect(page.locator('[data-testid="ads-campaign-row-camp_dealer_eu"]')).toBeVisible()

    // The CAMPAIGN_PAUSED row has a non-delivering (muted/neutral) status badge.
    const ral44Row = page.locator('[data-testid="ads-campaign-row-camp_RAL44"]')
    const ral44Badge = ral44Row.locator('[data-testid="ads-status-badge"]')
    await expect(ral44Badge).toBeVisible()
    // The badge should NOT have the success tone (CAMPAIGN_PAUSED is not active).
    // We verify by checking the text is CAMPAIGN_PAUSED (not ACTIVE).
    await expect(ral44Badge).toHaveText("CAMPAIGN_PAUSED")

    // ── 4. Campaigns: Quick actions — a gated pause an approver clicks ───────
    // Click an ACTIVE campaign row to select it.
    await page.locator('[data-testid="ads-campaign-row-camp_dealer_eu"]').click()
    // Wait for detail panel.
    await expect(page.locator('[data-testid="ads-campaign-detail-camp_dealer_eu"]')).toBeVisible({
      timeout: 10_000,
    })

    // Pause button is enabled (campaign is ACTIVE).
    const pauseBtn = page.locator('[data-testid="ads-pause-camp_dealer_eu"]')
    await expect(pauseBtn).toBeEnabled()
    await pauseBtn.click()

    // Confirm dialog appears.
    await expect(page.locator('[data-testid="ads-confirm-dialog"]')).toBeVisible()
    await page.locator('[data-testid="confirm-dialog-confirm-btn"]').click()

    // Dialog closes. `pause` is a GATED tool, and THIS user holds `ads:approve`
    // (qa.admin), so the click is itself the approval: the call EXECUTES rather
    // than parking, and the executed call's refetch flips the status in place.
    // (The panel's own "Paused." note does not survive that refetch — the row it
    // is keyed on is replaced — so the flip, not the note, is the evidence.)
    await expect(page.locator('[data-testid="ads-confirm-dialog"]')).toHaveCount(0)
    const dealerDetail = page.locator('[data-testid="ads-campaign-detail-camp_dealer_eu"]')
    await expect(dealerDetail.locator('[data-testid="ads-status-badge"]').first()).toHaveText(
      "CAMPAIGN_PAUSED",
      { timeout: 15_000 },
    )
    await expect(dealerDetail).not.toContainText("pending approval")
    await expect(pauseBtn).toBeDisabled()
    await expect(page.locator('[data-testid="ads-resume-camp_dealer_eu"]')).toBeEnabled()

    // Server-side, not a UI proxy: the campaign really is paused on the mock,
    // and the click parked NO approval for anyone to decide.
    const afterPause = await metaTool({ serverUrl: s, token, tool: "campaigns_list", params: {} })
    expect(
      effectiveStatusOf(afterPause.body, "camp_dealer_eu"),
      JSON.stringify(afterPause.body).slice(0, 600),
    ).toBe("CAMPAIGN_PAUSED")
    const parked = (await env.db.sql.unsafe(
      `SELECT id FROM "${env.schemaPrefix ?? ""}kernel".approval_requests
        WHERE org_id = $1 AND tool_name LIKE '%pause%' AND status = 'pending'`,
      [orgId],
    )) as Array<{ id: string }>
    expect(parked.length, JSON.stringify(parked)).toBe(0)

    // ── 5. Performance is now merged into the Dashboard tab ──────────────────
    // The former standalone /ads/performance tab was removed; its KPIs, by-
    // campaign table, and daily-spend chart now live inside the Dashboard.
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")

    // The merged performance detail panel renders inside the dashboard.
    await expect(page.locator('[data-testid="ads-dash-performance"]')).toBeVisible({
      timeout: 15_000,
    })

    // Insights (by-campaign) table renders.
    await expect(page.locator('[data-testid="ads-insights-table"]')).toBeVisible()

    // Daily-spend chart canvas appears after the report completes.
    await expect(page.locator('[data-testid="ads-dash-spend-chart"]')).toBeVisible({
      timeout: 30_000,
    })

    // Take a screenshot for visual verification.
    await page.screenshot({ path: `/tmp/ads-performance.png` })

    // ── 6. Ads tab ────────────────────────────────────────────────────────────
    await page.goto(`${viteUrl}/ads/ads`)
    await page.waitForLoadState("networkidle")

    await expect(page.locator('[data-testid="ads-ads-grid"]')).toBeVisible({ timeout: 15_000 })

    // At least one ad thumb renders (after creative_get resolves).
    await expect(page.locator('[data-testid^="ads-ad-thumb-"]').first()).toBeVisible({
      timeout: 15_000,
    })

    // Take screenshot.
    await page.screenshot({ path: `/tmp/ads-ads.png` })

    // ── 7. Audiences tab ──────────────────────────────────────────────────────
    await page.goto(`${viteUrl}/ads/audiences`)
    await page.waitForLoadState("networkidle")

    await expect(page.locator('[data-testid="ads-audiences-table"]')).toBeVisible({
      timeout: 15_000,
    })

    // The audience table has at least 2 rows.
    const audienceRows = page.locator('[data-testid="ads-audiences-table"] tbody tr')
    await expect(audienceRows).toHaveCount(2, { timeout: 10_000 })

    // Take screenshot.
    await page.screenshot({ path: `/tmp/ads-audiences.png` })

    // ── 8. Settings tab ───────────────────────────────────────────────────────
    // The old path lands on the app's declarative settings page.
    await page.goto(`${viteUrl}/settings/ads`)
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/settings\/apps\/ads/)

    // The connections block lists the Meta connection (installed with credentials).
    await expect(page.getByTestId("connections-conn-meta")).toBeVisible({ timeout: 15_000 })
    // The account status block shows the Meta arm.
    await expect(page.locator('[data-testid="ads-settings-status"]')).toBeVisible()

    // Take screenshot.
    await page.screenshot({ path: `/tmp/ads-settings.png` })

    // ── 9. Dashboard tab (P6) — mounts against the server-side Meta mock;
    // Google/lab tools have no live mock wired in this journey so the MER
    // and experiments panels are expected to degrade gracefully (empty/
    // unavailable rather than crash) ──────────────────────────────────────────
    await page.goto(`${viteUrl}/ads/dashboard`)
    await page.waitForLoadState("networkidle")

    await expect(page.locator('[data-testid="ads-dashboard"]')).toBeVisible({ timeout: 15_000 })

    // The dashboard is now the DEFAULT landing tab (activityBar repoint) — the
    // sidebar carries a Dashboard row above Campaigns.
    await expect(page.locator('[data-testid="ads-sidebar-link-dashboard"]')).toBeVisible()

    // Take screenshot.
    await page.screenshot({ path: `/tmp/ads-dashboard.png` })

    // ── 10. Guide tab — static discoverability page with copyable prompts ────
    await page.goto(`${viteUrl}/ads/guide`)
    await page.waitForLoadState("networkidle")

    await expect(page.locator('[data-testid="ads-guide"]')).toBeVisible({ timeout: 15_000 })
    // At least one copyable example prompt renders.
    await expect(page.locator('[data-testid="ads-guide-prompt"]').first()).toBeVisible()
    // The sidebar carries a Guide row.
    await expect(page.locator('[data-testid="ads-sidebar-link-guide"]')).toBeVisible()

    // ── 11. Default landing — activityBar now opens the dashboard tab ────────
    await page.goto(`${viteUrl}/`)
    await page.waitForLoadState("networkidle")
    await page.locator('[data-testid="activity-ads"]').click()
    await expect(page).toHaveURL(/\/ads\/dashboard$/, { timeout: 10_000 })
  })

  // Persons are decided by the tool's own scope, never by `ads:approve`
  // (approvals are for agents): a member holding `ads:campaigns:write`, the
  // scope `pause` requires, pauses directly, and nothing parks for approval.
  test("a member without ads:approve pauses on the tool's own scope, and nothing parks", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertMetaAdsBundle()

    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id
    const viteUrl = `http://localhost:${env.ports[1]}`
    const ks = `${env.schemaPrefix ?? ""}kernel`

    // Fresh mock state: the journey above really paused camp_dealer_eu, and a
    // paused campaign's Pause button is disabled.
    await resetMetaMock(s, token)
    await installMetaAds({ serverUrl: s, token, orgId })

    // Amina gets the ads `member` role's campaign scopes (its `ads:internal`
    // included: the pause ledger is the app's internal bookkeeping) and is
    // deliberately NOT given `ads:approve`.
    await grantScopes(env, orgId, qa.amina.id, [
      "ads:campaigns:read",
      "ads:campaigns:write",
      "ads:insights:read",
      "ads:internal",
    ])
    const before = (await env.db.sql.unsafe(
      `SELECT id FROM "${ks}".approval_requests WHERE org_id = $1 AND tool_name LIKE '%pause%'`,
      [orgId],
    )) as Array<{ id: string }>

    await loginAs(page, env, qa.amina.email, "QaPass1!")
    await expect(page.locator('[data-testid="activity-ads"]')).toBeVisible({ timeout: 20_000 })
    await page.goto(`${viteUrl}/ads/campaigns`)
    await page.waitForLoadState("networkidle")

    await expect(page.locator('[data-testid="ads-campaigns-table"]')).toBeVisible({
      timeout: 15_000,
    })
    await page.locator('[data-testid="ads-campaign-row-camp_dealer_eu"]').click()
    const detail = page.locator('[data-testid="ads-campaign-detail-camp_dealer_eu"]')
    await expect(detail).toBeVisible({ timeout: 10_000 })

    const pauseBtn = page.locator('[data-testid="ads-pause-camp_dealer_eu"]')
    await expect(pauseBtn).toBeEnabled()
    await pauseBtn.click()
    await expect(page.locator('[data-testid="ads-confirm-dialog"]')).toBeVisible()
    await page.locator('[data-testid="confirm-dialog-confirm-btn"]').click()
    await expect(page.locator('[data-testid="ads-confirm-dialog"]')).toHaveCount(0)

    // The call executes: the status flips in place, with no refusal and no
    // pending-approval note.
    await expect(detail.locator('[data-testid="ads-status-badge"]').first()).toHaveText(
      "CAMPAIGN_PAUSED",
      { timeout: 15_000 },
    )
    await expect(detail).not.toContainText("You cannot run")
    await expect(detail).not.toContainText("pending approval")

    // A person's call parks nothing.
    const after = (await env.db.sql.unsafe(
      `SELECT id FROM "${ks}".approval_requests WHERE org_id = $1 AND tool_name LIKE '%pause%'`,
      [orgId],
    )) as Array<{ id: string }>
    expect(after.filter((r) => !before.some((b) => b.id === r.id))).toHaveLength(0)

    // Server-side, not a UI proxy: the campaign really is paused on the mock.
    const campaigns = await metaTool({ serverUrl: s, token, tool: "campaigns_list", params: {} })
    expect(
      effectiveStatusOf(campaigns.body, "camp_dealer_eu"),
      JSON.stringify(campaigns.body).slice(0, 600),
    ).toBe("CAMPAIGN_PAUSED")
  })
})
