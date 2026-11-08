// SPDX-License-Identifier: FSL-1.1-ALv2
import fs from "node:fs"
import path from "node:path"
import {
  api,
  createWorkerEnv,
  deterministicPorts,
  type StandardWorld,
  seedStandardWorld,
  spawnViteServer,
  TestWorld,
  type WorkerEnv,
} from "@liaison/test-helpers"
import { test as base, type Page } from "@playwright/test"
import { previewBuildDir, viteMode } from "../pw-lanes"
import { loginAs } from "./test"
import { PROFILE_WORKER_SLOTS } from "./worker-slots"

/**
 * Profiled Playwright fixture factory for Phase 14 E2E (W1/W2b/W3/W5).
 *
 * The default `fixtures/test.ts` constructs `WorkerEnv` with a fixed serverEnv
 * before `world`/`qa` exist. That works for scenarios that don't care about
 * boot-time env vars, but Phase 14 has UI surfaces whose behavior is decided
 * at server startup (control-plane edition, GITHUB_API_BASE, maintenance
 * paths, version pin). Mutating those after the API spawned is too late —
 * `validateControlPlaneEnv` and the billing-state route mount run during
 * `app.ts`'s module load.
 *
 * `createProfiledE2ETest(profile)` clones the default fixture topology but
 * runs `profile.before(ports)` *before* `createWorkerEnv`, letting the test
 * file boot fake servers (control plane, GitHub releases) on the worker's
 * reserved port range and merge their URLs into the API's serverEnv.
 *
 * Worker offsets: default fixture uses workerIndex + 10. Profiled fixtures
 * use workerIndex + (offset). Pick an offset per profile so the deterministic
 * ports don't collide with each other or with the default fixture.
 */

export interface ProfiledFixtureProfile {
  /** The first of this profile's worker ids (see PROFILE_WORKER_SLOTS). */
  workerIdOffset: number
  /** Reserve N ports per worker: [0]=API, [1]=Vite, [2…]=available to `before`. */
  portCount: number
  /**
   * Called BEFORE `createWorkerEnv`. Receives the worker's reserved ports.
   * Returns extra env vars to merge into the API server's spawn env and an
   * array of teardown handles (closed in reverse order, even on error).
   */
  before: (ports: number[]) => Promise<{
    env: Record<string, string | undefined>
    teardowns: Array<() => Promise<void> | void>
    /**
     * Env applied by a server restart once the test world exists. The
     * managed edition refuses the web bootstrap registration (its first
     * account is provisioned out of band), so a managed profile boots
     * self-hosted, creates the world, then restarts as managed. A function
     * runs against the self-hosted server first (helpers/managed-edition.ts
     * seeds what the managed boot requires) and returns the env.
     */
    envAfterWorld?: EnvAfterWorld
    /** Extra env of the worker's Vite server (helpers/managed-edition.ts MANAGED_VITE_ENV). */
    viteEnv?: Record<string, string>
  }>
}

/** Env for the restart after the world exists, or a function that prepares the server and returns it. */
export type EnvAfterWorld =
  | Record<string, string | undefined>
  | ((ctx: { env: WorkerEnv; world: TestWorld }) => Promise<Record<string, string | undefined>>)

export interface ProfiledWorkerEnv extends WorkerEnv {
  /** Extra ports past API/Vite — for fake servers, etc. */
  profilePorts: number[]
  /** `envAfterWorld` from the profile, applied by the world fixture. */
  envAfterWorld?: EnvAfterWorld
  /**
   * Set by a managed restart (helpers/managed-edition.ts): the org's host is
   * the Vite origin, so after the restart the test process talks to the API
   * through it too (`serverUrl` takes this value).
   */
  serverUrlAfterRestart?: string
}

interface TestFixtures {
  authenticatedPage: Page
}

interface WorkerFixtures {
  env: ProfiledWorkerEnv
  world: TestWorld
  qa: StandardWorld
}

const WEB_DIR = path.resolve(__dirname, "../../../..")
const DIAG_DIR = path.resolve(WEB_DIR, "logs/playwright-diagnostics")
fs.mkdirSync(DIAG_DIR, { recursive: true })

async function refreshWorkerTokens(
  env: WorkerEnv,
  qa: StandardWorld,
  world: TestWorld,
): Promise<void> {
  const refresh = async (email: string, password: string): Promise<string | null> => {
    try {
      const res = await api(env.serverUrl, "/api/auth/login", {
        method: "POST",
        body: { email, password },
      })
      if (res.status !== 200) return null
      const token = res.body?.data?.accessToken
      return typeof token === "string" && token.length > 0 ? token : null
    } catch {
      return null
    }
  }
  const seededAdminToken = await refresh("admin@test.com", "12345678")
  if (seededAdminToken) (qa.admin as { token: string }).token = seededAdminToken
  if (seededAdminToken && world.admin.email === "admin@test.com") {
    ;(world.admin as { token: string }).token = seededAdminToken
  } else {
    try {
      const adminToken = await world.refreshAdminToken()
      if (adminToken) (world.admin as { token: string }).token = adminToken
    } catch {
      /* best-effort */
    }
  }
}

async function captureFailureDiagnostics(page: Page, testInfo: { title: string; status?: string }) {
  if (testInfo.status === "passed" || testInfo.status === "skipped") return
  const now = new Date()
  const datePart = now.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const slug = testInfo.title
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
  const dir = path.join(DIAG_DIR, `${datePart}_${slug}`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 3000 })
    fs.writeFileSync(path.join(dir, "ax-tree.yaml"), snapshot)
  } catch (e) {
    fs.writeFileSync(path.join(dir, "ax-tree.error.txt"), String(e))
  }
  try {
    const html = await page.content()
    fs.writeFileSync(path.join(dir, "page.html"), html.slice(0, 200_000))
  } catch (e) {
    fs.writeFileSync(path.join(dir, "page.html.error.txt"), String(e))
  }
  try {
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true })
  } catch (e) {
    fs.writeFileSync(path.join(dir, "screenshot.error.txt"), String(e))
  }
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ url: page.url(), title: testInfo.title, time: now.toISOString() }, null, 2),
  )
  process.stderr.write(`\n[DIAG] Test failed: ${testInfo.title}\n[DIAG]   Dir: ${dir}\n`)
}

// The sign-in flow lives in one place: fixtures/test.ts. This module used to
// carry its own copy, which went stale when the login page became
// magic-link-first (the password form is behind a toggle).
export { loginAs }

export function createProfiledE2ETest(profile: ProfiledFixtureProfile) {
  const test = base.extend<TestFixtures, WorkerFixtures>({
    env: [
      async ({}, use, workerInfo) => {
        // parallelIndex (the worker SLOT, 0..workers-1), not workerIndex,
        // which grows with every worker Playwright replaces: ports wrap at
        // 100 ids, so a growing index eventually landed on the ports of the
        // shared lanes (pw-lanes.ts, ids 10..13) while they were serving.
        if (workerInfo.parallelIndex >= PROFILE_WORKER_SLOTS) {
          throw new Error(
            `profiled fixture: worker slot ${workerInfo.parallelIndex} is past the ${PROFILE_WORKER_SLOTS} ids a profile owns; run with fewer workers`,
          )
        }
        const workerId =
          workerInfo.parallelIndex +
          profile.workerIdOffset +
          Number(process.env.E2E_WORKER_ID_OFFSET ?? 0)
        const ports = deterministicPorts(workerId, profile.portCount)
        const profilePorts = ports.slice(2)

        let beforeResult: Awaited<ReturnType<typeof profile.before>> | undefined
        let env: WorkerEnv | undefined
        let vite: Awaited<ReturnType<typeof spawnViteServer>> | undefined

        try {
          beforeResult = await profile.before(ports)
          env = await createWorkerEnv(workerId, {
            portCount: profile.portCount,
            serverEnv: beforeResult.env,
          })
          // The production build global-setup made, through `vite preview`,
          // as the shared lanes serve it: a dev server compiled the whole app
          // on demand for every profiled worker, and on a small CI runner
          // (four vCPUs shared with the lanes' servers and browsers) the shell
          // after sign-in took longer to compile than the tests wait for it.
          vite = await spawnViteServer({
            port: env.ports[1],
            cwd: WEB_DIR,
            mode: viteMode(),
            outDir: previewBuildDir(),
            env: {
              VITE_API_TARGET: env.serverUrl,
              VITE_TEST_MODE: "true",
              ...beforeResult.viteEnv,
            },
          })
          const viteUrl = `http://127.0.0.1:${env.ports[1]}`
          await Promise.all([
            // Bounded — see fixtures/test.ts.
            fetch(`${viteUrl}/`, { signal: AbortSignal.timeout(60_000) }).catch(() => {}),
            fetch(`${viteUrl}/login`, { signal: AbortSignal.timeout(60_000) }).catch(() => {}),
          ])
          const enriched = env as ProfiledWorkerEnv
          enriched.profilePorts = profilePorts
          enriched.envAfterWorld = beforeResult.envAfterWorld
          await use(enriched)
        } finally {
          if (env) await env.teardown().catch(() => {})
          if (vite) await vite.kill().catch(() => {})
          if (beforeResult) {
            for (const t of [...beforeResult.teardowns].reverse()) {
              try {
                await t()
              } catch {
                /* best-effort */
              }
            }
          }
        }
      },
      { scope: "worker", timeout: 180000 },
    ],

    world: [
      async ({ env }, use) => {
        const world = await TestWorld.create(env.serverUrl, env.db, {
          seed: 42,
          schemaPrefix: env.schemaPrefix,
          admin: { email: "admin@test.com", password: "12345678", name: "Elodie Vasseur" },
        })
        await env.waitForReady(30_000)
        if (env.envAfterWorld) {
          const after =
            typeof env.envAfterWorld === "function"
              ? await env.envAfterWorld({ env, world })
              : env.envAfterWorld
          await env.restart({ env: after })
          if (env.serverUrlAfterRestart) env.serverUrl = env.serverUrlAfterRestart
        }
        await use(world)
        await world.destroy()
      },
      { scope: "worker", timeout: 180000 },
    ],

    qa: [
      // `world` first: it registers the org and its admin the seed fills.
      async ({ world: _world, env }, use) => {
        await env.waitForReady(30_000)
        const qa = await seedStandardWorld(env, {
          email: "admin@test.com",
          password: "12345678",
        })
        await use(qa)
      },
      { scope: "worker", timeout: 60000 },
    ],

    page: async ({ page, env, qa, world }, use, testInfo) => {
      await refreshWorkerTokens(env, qa, world)
      await use(page)
      await captureFailureDiagnostics(page, testInfo)
    },

    authenticatedPage: async ({ page, env, qa }, use) => {
      await loginAs(page, env, "admin@test.com", "12345678")
      await use(page)
    },
  })

  return test
}

export { expect } from "./test"
