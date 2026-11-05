// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W5 — Visual goldens for Settings → System, Plan card (managed),
// and the maintenance page (E2E plan 16-phase-14-e2e-plan.md). Three
// independent profiled fixtures because each surface has incompatible boot-
// time env requirements (GitHub seam, control-plane managed mode, maintenance
// flag paths). Cropped per data-testid, never full-page.
import path from "node:path"
import { createProfiledE2ETest, expect } from "./fixtures/profiled-test"
import {
  clearMaintenanceFlag,
  maintenanceFlagPaths,
  setMaintenanceFlag,
} from "./helpers/maintenance-flag"
import { type FakeControlPlaneHandle, startFakeControlPlane } from "./helpers/mock-control-plane"
import {
  type FakeGitHubReleasesHandle,
  startFakeGitHubReleases,
} from "./helpers/mock-github-releases"

const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.05 }

// ─── W5.1 — Settings → System cropped golden ──────────────────────────────

let _gh: FakeGitHubReleasesHandle | undefined
const systemTest = createProfiledE2ETest({
  workerIdOffset: 100,
  portCount: 4,
  before: async (ports) => {
    _gh = await startFakeGitHubReleases(ports[2], {
      latest: "v0.1.1",
      htmlUrl: "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    })
    return {
      env: { LIAISON_VERSION: "v0.1.0", GITHUB_API_BASE: _gh.url },
      teardowns: [
        async () => {
          await _gh?.kill().catch(() => {})
          _gh = undefined
        },
      ],
    }
  },
})

systemTest.describe("System settings golden", () => {
  systemTest("captures cropped system settings", async ({ authenticatedPage, env }) => {
    await authenticatedPage.goto(`http://localhost:${env.ports[1]}/settings/system`)
    await expect(authenticatedPage.getByTestId("settings-system")).toBeVisible({
      timeout: 15000,
    })
    // Wait for all four pills + the update banner before capturing.
    for (const name of ["db", "redis", "meilisearch", "objectStorage"] as const) {
      await expect(authenticatedPage.getByTestId(`health-pill-${name}`)).toBeVisible({
        timeout: 15000,
      })
    }
    await expect(authenticatedPage.getByTestId("update-banner")).toBeVisible({
      timeout: 15000,
    })
    // The migration head is a hash over every migration file: masked, or each
    // new migration would move this golden.
    await expect(authenticatedPage.getByTestId("settings-system")).toHaveScreenshot(
      "system-settings.png",
      { ...SCREENSHOT_OPTS, mask: [authenticatedPage.getByTestId("system-migration-head")] },
    )
  })
})

// ─── W5.2 — Managed-mode Plan card cropped golden ────────────────────────

let _cp: FakeControlPlaneHandle | undefined
const planTest = createProfiledE2ETest({
  workerIdOffset: 120,
  portCount: 4,
  before: async (ports) => {
    _cp = await startFakeControlPlane(ports[2], {
      initialPayload: {
        tier: "team",
        status: "active",
        billingPortalUrl: "https://fake-cp.local/portal",
        checkoutUrl: "https://fake-cp.local/checkout",
        includedCredits: "10000",
        periodEnd: "2099-01-01T00:00:00.000Z",
      },
    })
    return {
      env: {
        CONTROL_PLANE_URL: _cp.url,
        CONTROL_PLANE_API_KEY: "w5-cp-key-32-chars-padded-padded-padded",
      },
      teardowns: [
        async () => {
          await _cp?.kill().catch(() => {})
          _cp = undefined
        },
      ],
    }
  },
})

planTest.describe("Plan card (managed) golden", () => {
  planTest("captures cropped plan card", async ({ authenticatedPage, env }) => {
    await authenticatedPage.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(authenticatedPage.getByTestId("plan-card")).toBeVisible({
      timeout: 15000,
    })
    // Make sure the tier + status text has hydrated before capturing.
    await expect(authenticatedPage.getByTestId("plan-card")).toContainText(/team/i)
    await expect(authenticatedPage.getByTestId("plan-card")).toHaveScreenshot(
      "plan-card-managed.png",
      SCREENSHOT_OPTS,
    )
  })
})

// ─── W5.3 — Maintenance page golden ──────────────────────────────────────

const W5_MAINT_WORKER_KEY = "w5-maintenance"
const maintenanceTest = createProfiledE2ETest({
  workerIdOffset: 140,
  portCount: 4,
  before: async () => {
    const paths = maintenanceFlagPaths(W5_MAINT_WORKER_KEY)
    // Ensure no leftover flag from a prior failed run.
    clearMaintenanceFlag(W5_MAINT_WORKER_KEY)
    return {
      env: {
        LIAISON_VERSION: "v0.1.0",
        MAINTENANCE_FLAG_PATH: paths.flagPath,
        MAINTENANCE_VERSION_PATH: paths.versionPath,
      },
      teardowns: [() => clearMaintenanceFlag(W5_MAINT_WORKER_KEY)],
    }
  },
})

maintenanceTest.describe("Maintenance page golden", () => {
  maintenanceTest("captures maintenance HTML against the API origin", async ({ page, env }) => {
    setMaintenanceFlag(W5_MAINT_WORKER_KEY, "v0.1.1")
    try {
      // Navigate to the API origin directly — the maintenance gate fires
      // BEFORE static-SPA serving in lib/server.ts, so this is what end
      // users see during an upgrade window.
      await page.goto(`${env.serverUrl}/`)
      await expect(page.locator("main")).toBeVisible({ timeout: 15000 })
      await expect(page.locator("main")).toContainText("Liaison is upgrading")
      await expect(page.locator("main")).toContainText("v0.1.1")
      await expect(page.locator("main")).toHaveScreenshot("maintenance-page.png", SCREENSHOT_OPTS)
    } finally {
      clearMaintenanceFlag(W5_MAINT_WORKER_KEY)
    }
    // Sanity: path import keeps Node module resolution happy for snapshots.
    void path
  })
})
