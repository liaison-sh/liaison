// SPDX-License-Identifier: FSL-1.1-ALv2
// Media-analysis admin settings panel — the ONLY human-facing UI this feature
// added. The per-file image/video analysis SUMMARY is agent-facing only (read
// via the `media_analysis` kernel tool / written onto kernel.files.analysis_*),
// so there is intentionally no ticket-UI surface to assert here — this scenario
// covers the settings panel exclusively.
//
// Browser-driven coverage for the 2×2 toggle grid (Tickets/Email × Images/Videos):
//   • renders with the correct DEFAULTS (Tickets img+video ON, Email img+video OFF)
//   • toggling a switch round-trips through PUT /org/settings/media-analysis and
//     survives a reload (server persistence, not just optimistic UI)
//   • while a PUT is in flight every toggle is disabled (saving state)
//   • a failed PUT reverts the optimistic toggle (no false persistence)
//   • a non-admin cannot reach the panel (section is scope-gated → redirected;
//     the server also 403s GET/PUT as defense-in-depth)

import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

const PANEL_URL = (vitePort: number) => `http://localhost:${vitePort}/settings/admin/media-analysis`

/** Kobalte ToggleButton renders `data-pressed` only when ON; absent when OFF. */
async function expectToggle(
  page: import("@playwright/test").Page,
  surface: "tickets" | "mail",
  kind: "image" | "video",
  on: boolean,
) {
  const toggle = page.getByTestId(`media-analysis-toggle-${surface}-${kind}`)
  await expect(toggle).toBeVisible()
  if (on) {
    await expect(toggle).toHaveAttribute("data-pressed", /.*/)
  } else {
    await expect(toggle).not.toHaveAttribute("data-pressed", /.*/)
  }
}

test("[MediaAnalysis] admin settings: defaults, persist across reload, saving + revert", async ({
  authenticatedPage,
  env,
  qa,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]

  // ── Reset the org's media-analysis settings to the seeded baseline so this
  // test is deterministic regardless of run order (the four-boolean defaults
  // are what an un-configured org resolves to). ───────────────────────────────
  await api(env.serverUrl, "/api/org/settings/media-analysis", {
    method: "PUT",
    token: qa.admin.token,
    body: {
      tickets: { image: true, video: true },
      mail: { image: false, video: false },
    },
  })

  await page.goto(PANEL_URL(vitePort))

  // The grid renders (skeleton resolves) with the correct defaults.
  await expect(page.getByTestId("media-analysis-grid")).toBeVisible({ timeout: 15_000 })
  await expectToggle(page, "tickets", "image", true)
  await expectToggle(page, "tickets", "video", true)
  await expectToggle(page, "mail", "image", false)
  await expectToggle(page, "mail", "video", false)

  // ── Toggle Email→Images ON; assert the PUT fires and succeeds ───────────────
  const putResp = page.waitForResponse(
    (r) => r.url().endsWith("/api/org/settings/media-analysis") && r.request().method() === "PUT",
  )
  await page.getByTestId("media-analysis-toggle-mail-image").click()
  expect((await putResp).status()).toBeLessThan(400)

  // Optimistic state applied.
  await expectToggle(page, "mail", "image", true)

  // ── Persistence: reload the page; the new state survives (came from the
  // server, not an in-memory optimistic update). ──────────────────────────────
  await page.reload()
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.goto(PANEL_URL(vitePort))
  await expect(page.getByTestId("media-analysis-grid")).toBeVisible({ timeout: 15_000 })
  await expectToggle(page, "mail", "image", true) // persisted
  await expectToggle(page, "tickets", "image", true) // untouched siblings survive
  await expectToggle(page, "tickets", "video", true)
  await expectToggle(page, "mail", "video", false)

  // Server-side confirmation: GET returns the persisted 2×2.
  const getResp = await api(env.serverUrl, "/api/org/settings/media-analysis", {
    method: "GET",
    token: qa.admin.token,
  })
  expect(getResp.status).toBe(200)
  expect(getResp.body?.data).toEqual({
    tickets: { image: true, video: true },
    mail: { image: true, video: false },
  })

  // ── Saving state: while a PUT is in flight every toggle is disabled. Delay
  // the next PUT so the disabled window is observable race-free. ───────────────
  await page.route("**/api/org/settings/media-analysis", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    await new Promise((r) => setTimeout(r, 800))
    return route.continue()
  })
  await page.getByTestId("media-analysis-toggle-tickets-video").click()
  // Mid-flight: the toggle just clicked AND its siblings are disabled.
  await expect(page.getByTestId("media-analysis-toggle-tickets-image")).toBeDisabled()
  await expect(page.getByTestId("media-analysis-toggle-mail-image")).toBeDisabled()
  // After the PUT settles, toggles re-enable and the change stuck.
  await expect(page.getByTestId("media-analysis-toggle-tickets-image")).toBeEnabled({
    timeout: 10_000,
  })
  await expectToggle(page, "tickets", "video", false)
  await page.unroute("**/api/org/settings/media-analysis")

  // ── Revert-on-error: a failing PUT rolls the optimistic toggle back ─────────
  await page.route("**/api/org/settings/media-analysis", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "boom" } }),
        })
      : route.continue(),
  )
  // mail→video is OFF; click it ON — the failed PUT must revert it to OFF.
  await expectToggle(page, "mail", "video", false)
  await page.getByTestId("media-analysis-toggle-mail-video").click()
  // After the failed PUT resolves, the toggle is back OFF (no false persistence).
  await expect(page.getByTestId("media-analysis-toggle-mail-video")).not.toHaveAttribute(
    "data-pressed",
    /.*/,
    { timeout: 10_000 },
  )
  await page.unroute("**/api/org/settings/media-analysis")

  // The reverted state is genuinely not persisted server-side.
  const afterRevert = await api(env.serverUrl, "/api/org/settings/media-analysis", {
    method: "GET",
    token: qa.admin.token,
  })
  expect(afterRevert.body?.data?.mail?.video).toBe(false)
})

test("[MediaAnalysis] non-admin cannot reach the panel (scope-gated UI + server 403)", async ({
  page,
  env,
  qa,
}) => {
  const vitePort = env.ports[1]

  // Amina is a QA member without kernel:org:admin.
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(PANEL_URL(vitePort))

  // The media-analysis section is scope-gated: it's filtered out of the visible
  // settings sections, and SettingsLayout redirects her to the fallback (the
  // user-group Profile page at /settings). The grid never renders.
  await page.waitForURL(/\/settings(\/|$)/, { timeout: 15_000 })
  await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("media-analysis-grid")).toHaveCount(0)
  // Redirected away from the admin route.
  expect(page.url()).not.toContain("/settings/admin/media-analysis")

  // Defense-in-depth: the server rejects a non-admin's direct API calls.
  const getResp = await api(env.serverUrl, "/api/org/settings/media-analysis", {
    method: "GET",
    token: qa.amina.token,
  })
  expect(getResp.status).toBe(403)

  const putResp = await api(env.serverUrl, "/api/org/settings/media-analysis", {
    method: "PUT",
    token: qa.amina.token,
    body: { tickets: { image: false, video: false }, mail: { image: false, video: false } },
  })
  expect(putResp.status).toBe(403)
})
