// SPDX-License-Identifier: FSL-1.1-ALv2
import fs from "node:fs"
import path from "node:path"
import {
  api,
  createWorkerEnv,
  deterministicPorts,
  type LaneInfo,
  laneWorkerEnv,
  resetLane,
  type StandardWorld,
  seedStandardWorld,
  spawnViteServer,
  TestWorld,
  type WorkerEnv,
} from "@liaison/test-helpers"
import {
  type Browser,
  type BrowserContext,
  test as base,
  expect as baseExpect,
  type Page,
  type TestInfo,
} from "@playwright/test"
import type { MockDriveHandle } from "../../../../../api/src/tests/e2e/helpers/mock-drive"
import type { MockGitlabHandle } from "../../../../../api/src/tests/e2e/helpers/mock-gitlab"
import type { MockMcpHandle } from "../../../../../api/src/tests/e2e/helpers/mock-mcp"
import type { MockMcpOauthHandle } from "../../../../../api/src/tests/e2e/helpers/mock-mcp-oauth"
import {
  PW_ADMIN,
  PW_ENCRYPTION_KEY,
  PW_PORT_COUNT,
  pwServerEnv,
  requestPwLane,
  viteMode,
  WEB_DIR,
} from "../pw-lanes"

// Lazy-load the mock-drive helper so tests that don't need it don't pay the
// import cost (and a Bun-only import path can't bring down the whole worker
// during fixture init).
async function startMockDriveLazy(port: number): Promise<MockDriveHandle> {
  const mod = await import("../../../../../api/src/tests/e2e/helpers/mock-drive")
  return mod.startMockDrive(port)
}

async function startMockGitlabLazy(port: number): Promise<MockGitlabHandle> {
  const mod = await import("../../../../../api/src/tests/e2e/helpers/mock-gitlab")
  return mod.startMockGitlab(port)
}

async function startMockMcpLazy(port: number): Promise<MockMcpHandle> {
  const mod = await import("../../../../../api/src/tests/e2e/helpers/mock-mcp")
  return mod.startMockMcp(port)
}

async function startMockMcpOauthLazy(port: number): Promise<MockMcpOauthHandle> {
  const mod = await import("../../../../../api/src/tests/e2e/helpers/mock-mcp-oauth")
  return mod.startMockMcpOauth(port)
}

export type WorkerEnvWithDrive = WorkerEnv & {
  mockDrive?: MockDriveHandle
  /** In-process mock GitLab REST v4 server bound to `localhost`. */
  mockGitlab?: MockGitlabHandle
  /** In-process MCP HTTP server bound to `127.0.0.1`. */
  mockMcp?: MockMcpHandle
  /** In-process OAuth fixture bound to `127.0.0.1`. */
  mockMcpOauth?: MockMcpOauthHandle
  encryptionKey: string
}

/**
 * Re-login the long-lived worker users before each test so that
 * permission_version mutations applied by earlier tests in the same worker
 * don't invalidate the cached tokens (which would surface as cascading 401s
 * in admin invites, contact seeding, approval decision calls, etc.).
 */
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
  // The five sign-ins are independent: concurrently, not one after another.
  const users = (["amina", "lucas", "tobias", "margot"] as const)
    .map((k) => qa[k] as { email: string; token: string } | undefined)
    .filter((u): u is { email: string; token: string } => Boolean(u?.email))
  const [seededAdminToken, ...userTokens] = await Promise.all([
    refresh("admin@test.com", "12345678"),
    ...users.map((u) => refresh(u.email, "QaPass1!")),
  ])
  if (seededAdminToken) (qa.admin as { token: string }).token = seededAdminToken
  // The QA seed admin is the world admin.
  if (seededAdminToken && world.admin.email === "admin@test.com") {
    ;(world.admin as { token: string }).token = seededAdminToken
  } else {
    try {
      const adminToken = await world.refreshAdminToken()
      if (adminToken) (world.admin as { token: string }).token = adminToken
    } catch {
      // best-effort — tests that don't rely on admin.token will still proceed
    }
  }
  users.forEach((u, i) => {
    const t = userTokens[i]
    if (t) u.token = t
  })
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
/** One `[pw-timing]` line per fixture phase, so a run's log splits its wall clock. */
function timing(msg: string): void {
  process.stderr.write(`[pw-timing] pid=${process.pid} ${msg}\n`)
}

const DIAG_DIR = path.resolve(WEB_DIR, "logs/playwright-diagnostics")
fs.mkdirSync(DIAG_DIR, { recursive: true })

/**
 * On test failure: capture full accessibility tree + screenshot.
 * Files written to logs/playwright-diagnostics/<slug>/.
 * Paths logged to stderr for easy agent/human consumption.
 */
async function captureFailureDiagnostics(
  page: Page,
  testInfo: { title: string; status?: string },
  networkLog?: string[],
) {
  // status may be "failed", "timedOut", "interrupted" — capture for any non-pass
  if (testInfo.status === "passed" || testInfo.status === "skipped") return
  const now = new Date()
  const datePart = now.toISOString().replace(/[:.]/g, "-").slice(0, 19) // 2026-04-06T11-23-45
  const slug = testInfo.title
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
  const dir = path.join(DIAG_DIR, `${datePart}_${slug}`)
  fs.mkdirSync(dir, { recursive: true })

  try {
    // Aria snapshot — structured accessibility tree of the full page
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 3000 })
    fs.writeFileSync(path.join(dir, "ax-tree.yaml"), snapshot)
  } catch (e) {
    fs.writeFileSync(path.join(dir, "ax-tree.error.txt"), String(e))
  }

  try {
    // Full page HTML (cap at 200k to avoid giant dumps)
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

  // Meta: URL, test title, timestamp
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ url: page.url(), title: testInfo.title, time: now.toISOString() }, null, 2),
  )

  // Network trail — every 4xx/5xx response plus the agent/approvals API calls,
  // so a failure caused by a failed or empty fetch is diagnosable without a rerun.
  if (networkLog && networkLog.length > 0) {
    fs.writeFileSync(path.join(dir, "network.log"), networkLog.join("\n"))
  }

  process.stderr.write(`\n[DIAG] Test failed: ${testInfo.title}\n` + `[DIAG]   Dir: ${dir}\n`)
}

interface TestFixtures {
  authenticatedPage: Page
  /** Auto fixture — refreshes worker tokens before every test. Not consumed directly. */
  _freshTokens: undefined
  /** Auto fixture — fails the test on a browser CSP violation. Not consumed directly. */
  _cspGuard: undefined
}

interface WorkerFixtures {
  env: WorkerEnvWithDrive
  world: TestWorld
  qa: StandardWorld
}

/** Login as a specific user. Use instead of authenticatedPage when the actor is not Elodie. */
export async function loginAs(page: Page, env: WorkerEnv, email: string, password: string) {
  const vitePort = env.ports[1]
  // Keep browser navigation on localhost because the suite's direct page.goto()
  // calls use localhost too; auth cookies are host-scoped.
  await page.goto(`http://localhost:${vitePort}/login`)
  // The default sign-in surface is passwordless (magic-link + Google). Password
  // login is a retained alternate reached via a toggle — reveal it for the suite.
  // Waiting for the toggle button also proxies SolidJS hydration; filling inputs
  // before hydration completes causes SolidJS to clear them on re-render.
  // Test ids, not labels: a persisted non-English locale renders this page in
  // that language (i18n-locale-switch re-logs in after switching to French).
  const passwordToggle = page.getByTestId("password-login-toggle")
  await passwordToggle.waitFor({ state: "visible", timeout: 30000 })
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[type="submit"]')
      return btn && !btn.hasAttribute("disabled")
    },
    { timeout: 10000 },
  )
  await passwordToggle.click()
  await page.getByTestId("login-password-input").waitFor({ state: "visible", timeout: 10000 })
  await page.getByTestId("login-password-email").fill(email)
  await page.getByTestId("login-password-input").fill(password)
  await page.getByTestId("password-login-submit").click()
  // Wait for shell to appear (means login succeeded + app loaded)
  await page.waitForSelector("[data-shell]", { timeout: 60000 })
}

interface MockHandles {
  mockDrive?: MockDriveHandle
  mockGitlab?: MockGitlabHandle
  mockMcp?: MockMcpHandle
  mockMcpOauth?: MockMcpOauthHandle
}

/**
 * Start the in-process fixture servers on ports [2..5]. Each is optional: if
 * one fails to start, the scenarios that need it skip themselves and every
 * other scenario still runs. A worker replacing a failed one binds the same
 * ports the moment the old process is gone, so a busy port is retried briefly.
 */
async function startMocks(ports: number[]): Promise<MockHandles> {
  const start = async <T>(name: string, port: number, fn: (p: number) => Promise<T>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(port)
      } catch (err) {
        if (attempt < 20 && /EADDRINUSE|in use/i.test(String(err))) {
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
        process.stderr.write(`[fixture] ${name} failed to start on port ${port}: ${String(err)}\n`)
        return undefined
      }
    }
  }
  return {
    mockDrive: await start("mock-drive", ports[2]!, startMockDriveLazy),
    mockMcp: await start("mock-mcp", ports[3]!, startMockMcpLazy),
    mockMcpOauth: await start("mock-mcp-oauth", ports[4]!, startMockMcpOauthLazy),
    mockGitlab: await start("mock-gitlab", ports[5]!, startMockGitlabLazy),
  }
}

async function killMocks(m: MockHandles): Promise<void> {
  if (m.mockDrive) await m.mockDrive.kill().catch(() => {})
  if (m.mockGitlab) await m.mockGitlab.kill().catch(() => {})
  if (m.mockMcp) await m.mockMcp.kill().catch(() => {})
  if (m.mockMcpOauth) await m.mockMcpOauth.kill().catch(() => {})
}

function enrich(env: WorkerEnv, mocks: MockHandles): WorkerEnvWithDrive {
  const enriched = env as WorkerEnvWithDrive
  if (mocks.mockDrive) enriched.mockDrive = mocks.mockDrive
  if (mocks.mockGitlab) enriched.mockGitlab = mocks.mockGitlab
  if (mocks.mockMcp) enriched.mockMcp = mocks.mockMcp
  if (mocks.mockMcpOauth) enriched.mockMcpOauth = mocks.mockMcpOauth
  enriched.encryptionKey = PW_ENCRYPTION_KEY
  return enriched
}

// ── Per-file reset on a shared lane (pw-lanes.ts) ───────────────────────────
//
// The lane this worker attached to, the seed every reset hands back, and the
// spec file the lane was last reset for. Module state, so one per worker
// process. `freshForAnyFile`: a lane the worker reset at attach and no test
// has touched yet; the first file takes it as is.
let sharedLane: LaneInfo | null = null
let laneSeed: StandardWorld | null = null
let laneResetFor: string | null = null
let freshForAnyFile = false
// Bumped by every lane reset (and the first file's fresh lane): per-worker
// caches of server-side setup (an app installed for the org) key on it, since
// the reset puts the database back to the seeded world without that setup.
let laneGenerationCount = 0

/** The lane's data generation: it changes whenever the lane is reset to the seed. */
export function laneGeneration(): number {
  return laneGenerationCount
}

/**
 * Put the lane back to its seeded snapshot before the first test (or
 * `beforeAll`) of every spec file, so a file sees the QA world and nothing an
 * earlier file left: database, Redis, search documents, server caches.
 */
async function ensureFileReset(file: string): Promise<void> {
  if (!sharedLane || laneResetFor === file) return
  if (freshForAnyFile) {
    freshForAnyFile = false
    laneResetFor = file
    return
  }
  const t0 = performance.now()
  await resetLane(sharedLane)
  laneGenerationCount++
  laneResetFor = file
  timing(`file reset ${secs(performance.now() - t0)} (${path.basename(file)})`)
}

const baseTest = base.extend<TestFixtures, WorkerFixtures>({
  env: [
    async ({}, use, workerInfo) => {
      const t0 = performance.now()
      const shared = await requestPwLane(workerInfo.parallelIndex)
      if (shared) {
        // The lane (API + Vite + seeded QA world) belongs to the runner
        // process and outlives this worker; only the mock servers are ours.
        const tLane = performance.now()
        const mocks = await startMocks(shared.lane.ports)
        const reset = await resetLane(shared.lane)
        laneGenerationCount++
        sharedLane = shared.lane
        laneSeed = reset.seed as StandardWorld
        laneResetFor = null
        freshForAnyFile = true
        const env = laneWorkerEnv(shared.lane, reset.encryptionKey)
        timing(
          `env lane ${shared.lane.workerId}: lane ${secs(tLane - t0)}, mocks+reset ${secs(performance.now() - tLane)}`,
        )
        try {
          await use(enrich(env, mocks))
        } finally {
          sharedLane = null
          await env.teardown().catch(() => {})
          await killMocks(mocks)
        }
        return
      }

      // LIAISON_PW_SHARED_STACK=0: this worker boots and owns a whole stack.
      const workerId = workerInfo.workerIndex + 10 + Number(process.env.E2E_WORKER_ID_OFFSET ?? 0)
      const ports = deterministicPorts(workerId, PW_PORT_COUNT)
      const mocks = await startMocks(ports)
      let env: WorkerEnv | undefined
      let vite: Awaited<ReturnType<typeof spawnViteServer>> | undefined
      try {
        env = await createWorkerEnv(workerId, {
          portCount: PW_PORT_COUNT,
          serverEnv: pwServerEnv(ports),
        })
        const tApi = performance.now()
        vite = await spawnViteServer({
          port: env.ports[1] as number,
          cwd: WEB_DIR,
          env: { VITE_API_TARGET: env.serverUrl, VITE_TEST_MODE: "true" },
          mode: viteMode(),
        })
        // Warm up Vite: compile the key routes so tests don't hit a cold compile.
        const viteUrl = `http://127.0.0.1:${env.ports[1]}`
        await Promise.all([
          fetch(`${viteUrl}/`, { signal: AbortSignal.timeout(60_000) }).catch(() => {}),
          fetch(`${viteUrl}/login`, { signal: AbortSignal.timeout(60_000) }).catch(() => {}),
        ])
        timing(`env own stack: api ${secs(tApi - t0)}, vite+warm ${secs(performance.now() - tApi)}`)
        await use(enrich(env, mocks))
      } finally {
        // Vite FIRST: a live Vite keeps proxying browser requests into the API,
        // which keeps sessions open on the schemas `teardown()` drops.
        if (vite) await vite.kill().catch(() => {})
        if (env) await env.teardown().catch(() => {})
        await killMocks(mocks)
      }
    },
    // A lane's first ask boots and seeds it (about 90 s on a loaded machine).
    { scope: "worker", timeout: 300000 },
  ],

  world: [
    async ({ env }, use) => {
      const t0 = performance.now()
      const world = await TestWorld.create(env.serverUrl, env.db, {
        seed: 42,
        schemaPrefix: env.schemaPrefix,
        admin: PW_ADMIN,
        // On a lane the org and its admin are part of the snapshot.
        existingAdmin: sharedLane !== null,
      })
      await env.waitForReady(30_000)
      timing(`world ${secs(performance.now() - t0)}`)
      await use(world)
      await world.destroy()
    },
    { scope: "worker", timeout: 300000 },
  ],

  qa: [
    // `world` first: off a lane, it registers the org and its admin the seed fills.
    async ({ world: _world, env }, use) => {
      if (sharedLane && laneSeed) {
        // Seeded once in the lane; tokens are refreshed before every test.
        await use(structuredClone(laneSeed))
        return
      }
      await env.waitForReady(30_000) // Ensure apps are registered before seeding
      const t0 = performance.now()
      const qa = await seedStandardWorld(env, PW_ADMIN)
      timing(`qa-seed ${secs(performance.now() - t0)}`)
      await use(qa)
    },
    { scope: "worker", timeout: 300000 },
  ],

  // Reset a shared lane at a file boundary, then refresh the long-lived worker
  // tokens before EVERY test (auto fixture) so `permission_version` drift from
  // earlier tests can't 401 a cached `qa.*.token` / `world.admin.token`. This
  // must not be bundled into the `page` fixture: tests that only hit the API
  // (`{ env, world, qa }`, no `page`) would then skip both.
  _freshTokens: [
    async ({ env, qa, world }, use, testInfo) => {
      await ensureFileReset(testInfo.file)
      await refreshWorkerTokens(env, qa, world)
      await use(undefined)
    },
    { auto: true },
  ],

  // Wrap every test's page — capture diagnostics on failure.
  page: async ({ page }, use, testInfo) => {
    // Record a network trail so a failure caused by a failed/empty fetch is
    // diagnosable from the per-test artifacts (no rerun). Captures every
    // 4xx/5xx response and, for the agent/approvals endpoints, the body too.
    const networkLog: string[] = []
    page.on("response", (res) => {
      void (async () => {
        const status = res.status()
        const url = res.url()
        const ofInterest = /\/api\/(agent\/skills|agent\/routines|approvals)/.test(url)
        if (status < 400 && !ofInterest) return
        let bodyNote = ""
        if (ofInterest) {
          try {
            const text = await res.text()
            bodyNote = ` body[len=${text.length}]=${text.slice(0, 400)}`
          } catch (e) {
            bodyNote = ` body=<unavailable: ${String(e)}>`
          }
        }
        networkLog.push(
          `${new Date().toISOString()} ${status} ${res.request().method()} ${url}${bodyNote}`,
        )
      })()
    })
    await use(page)
    await captureFailureDiagnostics(page, testInfo, networkLog)
  },

  authenticatedPage: async ({ page, env, qa }, use) => {
    const t0 = performance.now()
    await loginAs(page, env, "admin@test.com", "12345678")
    timing(`login ${secs(performance.now() - t0)}`)
    await use(page)
  },

  // Fail the test on any Content Security Policy violation the browser
  // reports, in any page of the test: the default context (`context` below)
  // and every context a test opens itself (`browser` below). The stack serves
  // the production policy (`VITE_E2E_CSP`, vite.config.ts), so a violation here
  // is a violation in production.
  _cspGuard: [
    async ({}, use) => {
      cspViolations = []
      await use(undefined)
      const found = cspViolations
      cspViolations = []
      if (found.length > 0) {
        throw new Error(
          `Content Security Policy violation(s) reported by the browser:\n  ${found.join("\n  ")}`,
        )
      }
    },
    { auto: true },
  ],

  context: async ({ context }, use) => {
    watchCsp(context)
    await use(context)
  },

  browser: [
    async ({ browser }, use) => {
      // `browser.newPage()` goes through `newContext()` too.
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
        const ctx = await newContext(...args)
        watchCsp(ctx)
        return ctx
      }
      await use(browser)
    },
    { scope: "worker" },
  ],
})

// ── CSP violations ──────────────────────────────────────────────────────────

/** What Chromium logs for a CSP violation (console) or throws (eval, wasm). */
const CSP_VIOLATION =
  /Content Security Policy|Refused to (load|execute|apply|connect|frame|evaluate|compile|create|run|send)/i

let cspViolations: string[] = []

function watchCsp(ctx: BrowserContext): void {
  ctx.on("console", (msg) => {
    const text = msg.text()
    if (CSP_VIOLATION.test(text)) {
      cspViolations.push(`[console.${msg.type()}] ${text} (${msg.page()?.url() ?? "?"})`)
    }
  })
  ctx.on("weberror", (err) => {
    const text = String(err.error())
    if (CSP_VIOLATION.test(text))
      cspViolations.push(`[pageerror] ${text} (${err.page()?.url() ?? "?"})`)
  })
}

// ── Per-file reset ahead of `beforeAll` ─────────────────────────────────────
//
// A `beforeAll` that seeds data runs before the first test's fixtures, so the
// per-test reset above would wipe what it seeded. Every `beforeAll` registered
// through this `test` (or a `test.extend()` of it) is preceded by a hook that
// does the file's reset first; the first test then finds the file already
// reset and leaves it alone.
type AnyTest = typeof baseTest

function resetBeforeAll<T extends AnyTest>(t: T): T {
  const beforeAll = t.beforeAll.bind(t) as (...args: unknown[]) => void
  const extend = t.extend.bind(t) as (...args: unknown[]) => AnyTest
  Object.assign(t, {
    beforeAll: (...args: unknown[]) => {
      beforeAll(async ({ env: _env }: { env: WorkerEnvWithDrive }, info: { file: string }) => {
        await ensureFileReset(info.file)
      })
      beforeAll(...args)
    },
    extend: (...args: unknown[]) => resetBeforeAll(extend(...args)),
  })
  return t
}

export const test = resetBeforeAll(baseTest)

// ── Visual baselines per platform ───────────────────────────────────────────
//
// Baselines are per platform (`<name>-<platform>.png`, playwright.config.ts)
// and the committed ones were captured on one platform. On another platform a
// screenshot assertion has nothing to compare against: Playwright writes the
// actual image and fails, and a failing test also costs its worker. So when
// this platform has no baseline for the screenshot, the test is SKIPPED with
// the reason, after every assertion before the screenshot has run. A platform
// that has its baselines (or a run that sets PW_UPDATE_SNAPSHOTS to create
// them, docs/testing.md) compares as before.

function baselineExists(testInfo: TestInfo, name: string | string[] | undefined): boolean {
  const platform = process.platform
  if (name !== undefined) {
    const parts = Array.isArray(name) ? [...name] : [name]
    const last = parts[parts.length - 1] as string
    if (!/\.png$/i.test(last)) parts[parts.length - 1] = `${last}.png`
    return fs.existsSync(testInfo.snapshotPath(...parts))
  }
  // An unnamed screenshot: any baseline of this file on this platform.
  const dir = path.join(path.dirname(testInfo.file), `${path.basename(testInfo.file)}-snapshots`)
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(`-${platform}.png`))
  } catch {
    return false
  }
}

function skipWithoutBaseline(name: string | string[] | undefined): void {
  if (process.env.PW_UPDATE_SNAPSHOTS) return
  const testInfo = test.info()
  if (baselineExists(testInfo, name)) return
  const label = Array.isArray(name) ? name.join("/") : (name ?? "(unnamed)")
  testInfo.skip(
    true,
    `no ${process.platform} visual baseline for "${label}": generate it with PW_UPDATE_SNAPSHOTS (docs/testing.md, Visual baselines)`,
  )
}

type ScreenshotArgs = [name?: string | string[] | object, options?: object]

function nameOf(args: unknown[]): string | string[] | undefined {
  const first = args[0]
  return typeof first === "string" || Array.isArray(first)
    ? (first as string | string[])
    : undefined
}

function withBaselineCheck<M extends object>(matchers: M): M {
  return new Proxy(matchers, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === "toHaveScreenshot" && typeof value === "function") {
        return (...args: ScreenshotArgs) => {
          skipWithoutBaseline(nameOf(args))
          return value.apply(target, args)
        }
      }
      if (prop === "toMatchSnapshot" && typeof value === "function") {
        return (...args: unknown[]) => {
          // toMatchSnapshot(value, name?) — the name is the second argument.
          skipWithoutBaseline(nameOf(args.slice(1)))
          return value.apply(target, args)
        }
      }
      return value
    },
  })
}

/** `expect` from @playwright/test, with screenshot assertions skipped on a platform without baselines. */
export const expect = new Proxy(baseExpect, {
  apply(target, thisArg, args: Parameters<typeof baseExpect>) {
    return withBaselineCheck(Reflect.apply(target, thisArg, args) as object)
  },
}) as typeof baseExpect
