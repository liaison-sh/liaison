// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared Playwright lanes: one API server serving the web build and a seeded
 * QA world per worker SLOT, owned by the runner process, reused across spec
 * files and across worker restarts.
 *
 * Before, every Playwright worker booted its own stack in a worker fixture:
 * clone the schemas, spawn the API, spawn a Vite dev server, create the world
 * and seed the QA dataset, about 90-100 s on a loaded machine. Playwright
 * throws a worker away after ANY failing test, so every failure (a missing
 * visual baseline included) paid that boot again; a 40-minute run spent most of
 * its time booting stacks, and a slow seed overran the `qa` fixture's budget,
 * failed the test, and started the next boot.
 *
 * Now global-setup builds the web app once (`vite build`, about 20 s) and
 * serves a small registry from the runner process. A worker asks it for the
 * lane of its `parallelIndex`; the first ask creates the lane
 * (packages/test-helpers/src/e2e-lane.ts with a `seed`: org, admin, then the
 * standard seed tier through the CLI, `liaison seed --tier standard`, then a
 * data snapshot), every later ask (the next worker of that slot, after a
 * failure) gets the running lane. Before the first test of every spec file the
 * worker resets the lane to its snapshot (`resetLane`: database, Redis keys,
 * search documents, in-process caches; about a second), so a file sees exactly
 * the seeded world, whatever ran before it.
 *
 * THE API SERVES THE WEB BUILD (`LIAISON_PUBLIC_DIR`), as in production: one
 * origin for the page, the API and the websocket, and the production security
 * headers on the shell, Content-Security-Policy included, so the suite's CSP
 * guard sees what a browser in production sees. The lane hands the API port out
 * as both `ports[0]` and `ports[1]` (the "web" port the scenarios navigate to).
 * No Vite dev server runs: no per-lane cold compile, no dev-only proxy.
 *
 * `LIAISON_PW_SHARED_STACK=0` boots a stack per worker the old way (API + Vite
 * dev server), for when the sharing is suspected.
 */

import { execSync } from "node:child_process"
import path from "node:path"
import {
  createE2eLane,
  deterministicPorts,
  type E2eLane,
  type LaneInfo,
  type StandardWorld,
  seedStandardWorld,
} from "@liaison/test-helpers"
import { installLaneCatalogApps, laneCatalogEnv } from "./lane-catalog"

/** Set by global-setup: the registry's URL. Unset = the old per-worker stacks. */
export const PW_LANE_REGISTRY_ENV = "LIAISON_PW_LANE_REGISTRY"

/** Ports per lane: [0] API [1] Vite [2] mock-Drive [3] mock-MCP [4] mock-MCP-OAuth [5] mock-GitLab. */
export const PW_PORT_COUNT = 6

export const PW_ADMIN = { email: "admin@test.com", password: "12345678", name: "Elodie Vasseur" }

/** The default fixture's worker id for a slot (its ports and `w<id>_` schemas). */
export function pwWorkerId(parallelIndex: number): number {
  // Offset by 10 to avoid collisions with the API parallel runner (workers 0-3).
  // E2E_WORKER_ID_OFFSET lets a second lane share this machine.
  return parallelIndex + 10 + Number(process.env.E2E_WORKER_ID_OFFSET ?? 0)
}

export const PW_ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const API_TEST_HELPERS = path.resolve(__dirname, "../../../../api/src/tests/e2e/helpers")
export const WEB_DIR = path.resolve(__dirname, "../../..")

/**
 * The API server env every default-fixture stack boots with. The mock servers
 * run in the worker process on the lane's ports [2..4]; their URLs are fixed
 * by those ports, so the server can be booted before any worker exists.
 */
export function pwServerEnv(ports: number[]): Record<string, string> {
  return {
    GMAIL_OAUTH_CLIENT_ID: "playwright-gmail-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "playwright-gmail-client-secret",
    // The MCP device /initiate 403s any client id absent from this allow-list.
    DEVICE_FLOW_CLIENTS: "*",
    DRIVE_API_BASE_URL: `http://localhost:${ports[2]}/drive/v3`,
    // The API connector reaches http only on loopback, and only with this flag
    // (a development setting): the api-connector scenario runs the fixture CRM
    // on 127.0.0.1. Link-local and metadata addresses stay refused.
    LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS: "true",
    // Organisations' own apps (the app builder, "Apps in the making", install
    // by URL) are off on a self-hosted server unless set (lib/edition.ts
    // customAppsEnabled), and lanes boot self-hosted: the app-builder
    // scenario drives them, so the lanes turn them on.
    LIAISON_CUSTOM_APPS: "on",
    // Every OAuth connection authorizes and exchanges against the lane's mock
    // OAuth server (read only under NODE_ENV test): the connect card scenario
    // runs a real consent round trip without reaching Google.
    LIAISON_TEST_OAUTH_PROVIDER: `http://127.0.0.1:${ports[4]}`,
    // Deterministic agent stream for the interleaved-timeline scenario. The stub
    // delegates every prompt WITHOUT its marker to the real `streamText`.
    AGENT_STREAM_STUB: path.join(API_TEST_HELPERS, "timeline-interleave-stub.ts"),
    ENCRYPTION_KEY: PW_ENCRYPTION_KEY,
    // The catalog global-setup staged (lane-catalog.ts).
    ...laneCatalogEnv(),
  }
}

/**
 * The world every Playwright stack starts from: the `standard` seed tier, then
 * the catalog apps installed as its admin through the App store (lane-catalog.ts).
 * `catalogApps: false` skips the installs: a managed worker's org is a
 * customer's, which may not install apps (helpers/managed-edition.ts).
 */
export async function seedPwWorld(
  env: Parameters<typeof seedStandardWorld>[0],
  admin: { email: string; password: string },
  opts: { catalogApps?: boolean } = {},
): Promise<StandardWorld> {
  const world = await seedStandardWorld(env, admin)
  if (opts.catalogApps !== false) await installLaneCatalogApps(env.serverUrl, world.admin.token)
  return world
}

/** E2E_WEB_PREVIEW=1 serves the production build global-setup made. */
export function viteMode(): "dev" | "preview" {
  return process.env.E2E_WEB_PREVIEW === "1" ? "preview" : "dev"
}

/**
 * The build a `vite preview` serves: the shared lanes' build when global-setup
 * made one (the lane registry is up), else the config's own `dist/`, which
 * global-setup builds for per-worker stacks under E2E_WEB_PREVIEW=1.
 */
export function previewBuildDir(): string | undefined {
  return process.env[PW_LANE_REGISTRY_ENV] ? PW_WEB_BUILD_DIR : undefined
}

export interface PwLaneInfo {
  lane: LaneInfo
}

// ── Runner side (global-setup) ──────────────────────────────────────────────

/** Where global-setup builds the web app the lanes serve. */
export const PW_WEB_BUILD_DIR = path.join(WEB_DIR, "dist-e2e")

/** Build the web app once per run, for every lane to serve. */
export function buildPwWeb(): void {
  const t0 = performance.now()
  // A VITE_* variable is baked into the bundle: a stray VITE_API_TARGET would
  // send the page's websocket to another origin.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "VITE_API_TARGET" && k !== "VITE_WS_BASE"),
  )
  execSync(`bunx vite build --outDir ${PW_WEB_BUILD_DIR} --emptyOutDir`, {
    cwd: WEB_DIR,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  })
  process.stderr.write(`[pw-lane] web build ${secs(performance.now() - t0)}\n`)
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

async function createPwLane(parallelIndex: number, logDir: string): Promise<E2eLane> {
  const workerId = pwWorkerId(parallelIndex)
  const t0 = performance.now()
  let tSeed = 0
  const lane = await createE2eLane(workerId, logDir, {
    portCount: PW_PORT_COUNT,
    // Same deterministic allocation createOwnedWorkerEnv makes inside, so the
    // mock URLs can be in the env the server boots with.
    serverEnv: {
      ...pwServerEnv(deterministicPorts(workerId, PW_PORT_COUNT)),
      LIAISON_PUBLIC_DIR: PW_WEB_BUILD_DIR,
    },
    admin: PW_ADMIN,
    seed: async (env) => {
      tSeed = performance.now()
      return seedPwWorld(env, PW_ADMIN)
    },
  })
  process.stderr.write(
    `[pw-lane ${parallelIndex}] w${workerId}: server ${secs(tSeed - t0)}, seed+snapshot ${secs(performance.now() - tSeed)}\n`,
  )
  return lane
}

/**
 * Start the lane registry in the runner process. Lanes are created on demand,
 * one per worker slot that asks, so a one-file run boots one stack, not one per
 * configured worker.
 */
export function startPwLaneRegistry(logDir: string): { url: string; close(): Promise<void> } {
  const lanes = new Map<number, Promise<E2eLane>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const index = Number(new URL(req.url).searchParams.get("index"))
      if (!Number.isInteger(index) || index < 0) return new Response("bad index", { status: 400 })
      let pending = lanes.get(index)
      if (!pending) {
        pending = createPwLane(index, logDir)
        lanes.set(index, pending)
        // A lane that failed to boot is forgotten, so the next worker retries.
        pending.catch(() => lanes.delete(index))
      }
      try {
        const { info } = await pending
        // The API serves the web app: its port is the "web" port too.
        const ports = [...info.ports]
        ports[1] = ports[0] as number
        return Response.json({ lane: { ...info, ports } } satisfies PwLaneInfo)
      } catch (err) {
        return new Response(err instanceof Error ? (err.stack ?? err.message) : String(err), {
          status: 500,
        })
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    async close() {
      server.stop(true)
      const all = await Promise.allSettled(lanes.values())
      for (const r of all) if (r.status === "fulfilled") await r.value.close().catch(() => {})
    },
  }
}

// ── Worker side (fixtures/test.ts) ──────────────────────────────────────────

export async function requestPwLane(parallelIndex: number): Promise<PwLaneInfo | null> {
  const registry = process.env[PW_LANE_REGISTRY_ENV]
  if (!registry) return null
  const res = await fetch(`${registry}/lane?index=${parallelIndex}`, { method: "POST" })
  const text = await res.text()
  if (!res.ok) throw new Error(`pw lane ${parallelIndex}: ${res.status} ${text}`)
  return JSON.parse(text) as PwLaneInfo
}
