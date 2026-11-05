// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The whole visitor path on a demo deployment: the entry screen, the workspace
// created from it, landing INSIDE the product with the world still seeding, and
// the standing banner with its list of what the demo cannot do.
//
// WHY TWO ROUTES ARE INTERCEPTED. `LIAISON_DEMO_MODE` is a MOUNT-time gate: the
// API in this harness boots with it off, so `POST /api/demo/orgs` and its
// status read do not exist in this process and cannot be made to (they are
// mounted in app.ts before the fixture ever sees the server). So exactly three
// reads are served here: the branding flag that tells the client this is a
// demo, the signup, and the readiness poll. Everything else in this test is the
// real thing, and deliberately so: the session the intercepted signup hands back
// is a REAL token minted by the REAL API for a REAL user, so what the visitor
// lands in is the product itself, authenticating and fetching for real. The
// route contract being stubbed is pinned by the API's own tests
// (apps/api/src/modules/demo/routes.test.ts).
import { api } from "@liaison/test-helpers"
import { serveDemoOrgRead } from "./demo-welcome-routes"
import { expect, test } from "./fixtures/test"

const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111"

interface Tokens {
  accessToken: string
  refreshToken?: string
}

/** A real session for a real seeded user, handed back through the demo shape. */
async function realTokens(serverUrl: string): Promise<Tokens> {
  const res = await api(serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: "admin@test.com", password: "12345678" },
  })
  expect(res.status).toBe(200)
  const data = res.body?.data as Tokens
  expect(typeof data?.accessToken).toBe("string")
  return data
}

test.describe("the public demo instance", () => {
  test("entry screen, create a workspace, land in the product, see the banner", async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    const tokens = await realTokens(env.serverUrl)

    // The deployment says it is the demo. This is the ONLY thing that turns any
    // of the surfaces below on.
    await serveDemoOrgRead(page)
    await page.route("**/api/settings/branding", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgName: "Resonant Audio Labs",
            logoUrl: null,
            flags: { demo: true },
            byokModelIds: [],
          },
        }),
      }),
    )

    // The readiness poll: still seeding at first, ready shortly after, so the
    // test drives the real "in the product while the world fills in" path
    // rather than jumping straight to a finished workspace.
    let polls = 0
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
    await page.route(`**/api/demo/orgs/${DEMO_ORG_ID}/status`, (route) => {
      polls += 1
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgId: DEMO_ORG_ID,
            state: polls >= 2 ? "ready" : "provisioning",
            startedAt: new Date().toISOString(),
            finishedAt: polls >= 2 ? new Date().toISOString() : null,
            expiresAt,
          },
        }),
      })
    })

    let signups = 0
    await page.route("**/api/demo/orgs", (route) => {
      if (route.request().method() !== "POST") return route.continue()
      signups += 1
      const body = JSON.parse(route.request().postData() ?? "{}")
      expect(body).toMatchObject({ name: "Jane Doe", email: "visitor@example.com" })
      // One start carries one random signup key, so a lost answer can be resumed.
      expect(body.signupKey).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgId: DEMO_ORG_ID,
            orgSlug: "demo-acme-audio-a1b2c3",
            userId: "00000000-0000-4000-8000-000000000001",
            state: "provisioning",
            statusUrl: `/api/demo/orgs/${DEMO_ORG_ID}/status`,
            expiresAt,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        }),
      })
    })

    // ── The entry screen ─────────────────────────────────────────────────────
    await page.goto(`http://localhost:${vitePort}/login`)

    const entry = page.getByTestId("demo-entry")
    await expect(entry).toBeVisible({ timeout: 30000 })
    // The one door replaced the login card entirely.
    await expect(page.getByTestId("auth-card")).toHaveCount(0)
    await expect(page.getByTestId("demo-pick-step")).toBeVisible()

    // ── Create a workspace: what to see, the company, the details ───────────
    await page.getByTestId("demo-needs-support").click()
    await page.getByTestId("demo-continue").click()
    await expect(page.getByTestId("demo-company-step")).toBeVisible()
    await page.getByTestId("demo-company-continue").click()
    await page.getByTestId("demo-name").fill("Jane Doe")
    await page.getByTestId("demo-email").fill("visitor@example.com")
    await page.getByTestId("demo-create").click()

    // ── Inside the product, not on a waiting screen ──────────────────────────
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 30000 })
    expect(signups).toBe(1)

    // ── The standing banner, naming the instance and the expiry ──────────────
    const banner = page.getByTestId("demo-banner")
    await expect(banner).toBeVisible()
    await expect(banner).toContainText("Demo instance")
    await expect(page.getByTestId("demo-banner-expiry")).toContainText("expires")

    // The seed's honest state, then ready: the poll really ran and really
    // settled, so the notice goes on its own.
    await expect(page.getByTestId("demo-state-provisioning")).toBeVisible()
    await expect(page.getByTestId("demo-state-provisioning")).toHaveCount(0, { timeout: 30000 })
    expect(polls).toBeGreaterThanOrEqual(2)

    // ── What this demo cannot do ─────────────────────────────────────────────
    await page.getByTestId("demo-limits-open").click()
    const limits = page.getByTestId("demo-limits")
    await expect(limits).toBeVisible()
    await expect(limits.locator("li")).toHaveCount(6)
    await expect(limits).toContainText("No mail leaves this instance")
    await expect(limits).toContainText("Connectors are fixtures")
    await expect(limits).toContainText("Ads is not part of the demo")
    await expect(limits).toContainText("once you confirm your email, within a small budget")
    await page.keyboard.press("Escape")
    // The email code and the model key form live in the welcome popup
    // (demo-welcome.scenario.test.ts), not on the page.
    await expect(page.getByTestId("demo-byok")).toHaveCount(0)
    await expect(page.getByTestId("demo-verify")).toHaveCount(0)
  })

  test("a deployment that is not a demo shows an ordinary login and no demo surface", async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    // No interception at all: the real branding route answers with `flags: {}`
    // because this API booted with demo mode off, which is the whole gate.
    await page.goto(`http://localhost:${vitePort}/login`)
    await expect(page.getByTestId("auth-card")).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId("demo-entry")).toHaveCount(0)
    await expect(page.getByTestId("demo-banner")).toHaveCount(0)
  })
})
