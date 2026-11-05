// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W1 — Settings → System renders version, dependency pills, and
// update banner (E2E plan 16-phase-14-e2e-plan.md, smoke test E2E-INFRA-5
// inlined as the first test of this file).
//
// The profiled fixture starts a per-worker fake GitHub releases server BEFORE
// `createWorkerEnv`, then boots the API with GITHUB_API_BASE pointed at the
// fake. This is the only supported path for tests that need boot-time env
// overrides — the default `fixtures/test.ts` cannot mutate serverEnv after
// `validateControlPlaneEnv` and the version-check fetch path have observed
// the process env at startup.
import { api } from "@liaison/test-helpers"
import { createProfiledE2ETest, expect } from "./fixtures/profiled-test"
import {
  type FakeGitHubReleasesHandle,
  startFakeGitHubReleases,
} from "./helpers/mock-github-releases"

let sharedFakeGh: FakeGitHubReleasesHandle | undefined

const test = createProfiledE2ETest({
  workerIdOffset: 40,
  portCount: 4, // [0]=API, [1]=Vite, [2]=fake GitHub, [3]=spare
  before: async (ports) => {
    const ghPort = ports[2]
    const gh = await startFakeGitHubReleases(ghPort, {
      latest: "v0.1.1",
      htmlUrl: "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    })
    sharedFakeGh = gh
    return {
      env: {
        LIAISON_VERSION: "v0.1.0",
        GITHUB_API_BASE: gh.url,
      },
      teardowns: [
        async () => {
          await gh.kill()
          sharedFakeGh = undefined
        },
      ],
    }
  },
})

test.describe.configure({ mode: "serial" })

test.describe("Settings -> System", () => {
  test("[smoke] System page renders the running version", async ({ authenticatedPage, env }) => {
    await authenticatedPage.goto(`http://localhost:${env.ports[1]}/settings/system`)
    await expect(authenticatedPage.getByTestId("settings-system")).toBeVisible({
      timeout: 15000,
    })
    await expect(authenticatedPage.getByTestId("system-version")).toContainText(/v\d+\.\d+\.\d+/)
  })

  test("renders version, update banner with release-notes link, dependency pills, and persists opt-out", async ({
    authenticatedPage,
    env,
    qa,
  }) => {
    const page = authenticatedPage
    if (!sharedFakeGh) throw new Error("fake GitHub server missing")
    // Reset upstream + Redis cache so this test sees a fresh fetch.
    sharedFakeGh.resetRequests()
    sharedFakeGh.setStatus(200)
    sharedFakeGh.setLatest({
      tag: "v0.1.1",
      htmlUrl: "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    })
    await env.redis.redis.del(
      `${env.redisPrefix}versionCheck:latest`,
      `${env.redisPrefix}versionCheck:latest:last`,
    )

    await page.goto(`http://localhost:${env.ports[1]}/settings/system`)
    await expect(page.getByTestId("settings-system")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("system-version")).toContainText("v0.1.0")

    // The banner appears after /api/admin/version-check resolves.
    const banner = page.getByTestId("update-banner")
    await expect(banner).toContainText("v0.1.1", { timeout: 15000 })
    await expect(banner.getByRole("link")).toHaveAttribute("href", /releases\/tag\/v0\.1\.1/)

    // Dependency pills — all four required dependencies must report ok against
    // the real worker stack.
    for (const name of ["db", "redis", "meilisearch", "objectStorage"] as const) {
      await expect(page.getByTestId(`health-pill-${name}`)).toContainText("ok", {
        timeout: 15000,
      })
    }

    // Toggle update checks off; assert the org write persisted.
    const toggle = page.getByTestId("toggle-update-checks")
    await expect(toggle).toContainText("Disable update checks")
    await toggle.click()
    // Toast appears with the "Update checks disabled" message.
    await expect(page.getByText("Update checks disabled")).toBeVisible({ timeout: 5000 })

    // Cross-check the org flag flipped via the API.
    const orgRes = await api(env.serverUrl, "/api/org", { token: qa.admin.token })
    expect(orgRes.status).toBe(200)
    const data = (orgRes.body as { data: { updateChecksEnabled?: boolean } }).data
    expect(data.updateChecksEnabled).toBe(false)

    // Reload with the fake GitHub set to fail. The opt-out should short-circuit
    // BEFORE the GitHub fetch, so the banner must not appear.
    sharedFakeGh.setStatus(503)
    sharedFakeGh.resetRequests()
    await page.reload()
    await expect(page.getByTestId("settings-system")).toBeVisible({ timeout: 15000 })
    // The opt-out toggle must reflect the disabled state.
    await expect(page.getByTestId("toggle-update-checks")).toContainText("Enable update checks")
    // Negative assertion: banner must not render when org flag is false.
    await expect(page.getByTestId("update-banner")).toHaveCount(0)

    // Re-enable for clean state. Reset upstream so subsequent tests in this
    // worker see a healthy stub.
    const reenable = await api(env.serverUrl, "/api/org", {
      token: qa.admin.token,
      method: "PATCH",
      body: { updateChecksEnabled: true },
    })
    expect(reenable.status).toBe(200)
    sharedFakeGh.setStatus(200)
  })
})
