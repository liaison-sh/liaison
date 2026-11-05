// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Apps live without a restart, across processes (S1.4): two real
// `src/index.ts` processes (role `all`, so each serves the API and hosts job
// workers) over one Postgres, Redis and object store (createRoleCell), each
// with its OWN install root (`LIAISON_APPS_DIR`), as two containers have.
//
// An app is installed, upgraded and uninstalled through process A's HTTP API.
// After each step, process B follows within 5 s, read over B's own HTTP API:
// the org's scope catalog lists the scopes of the tools B has registered for
// the org (scope-catalog.ts walks the live tool registry). B never had the
// package on disk: it fetches it from the package store (S1.3). B also
// consumes the new app's job queue within 5 s (S1.2), and after the uninstall
// its local files and every stored package are gone (S1.1, A8). Neither
// process restarts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  api,
  bootstrap,
  createRoleCell,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"
import { Queue } from "bullmq"
import IORedis from "ioredis"
import { getObjectBuffer } from "~/infra/storage/object-storage"

// The parallel runner gives this file a private worker id; a plain run takes
// one clear of the lanes (0-3), the helper tests (50-61, 99) and the cell
// scenarios (70-79).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 85
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
// Unique per run: object storage is shared by every checkout's runs.
const APP = `live-install-${Date.now().toString(36)}`
const ALPHA = `${APP}:alpha:read`
const BETA = `${APP}:beta:read`
const JOB = "sweep"
const FOLLOW_MS = 5_000

const work = mkdtempSync(join(tmpdir(), "live-install-"))
const packages = new Map<string, Uint8Array>()

/** A `.liaisonapp` whose one tool needs `scope`; v1 points its update channel at v2. */
function pack(version: string, scope: string, updateUrl?: string): Uint8Array {
  const stage = join(work, `stage-${version}`)
  mkdirSync(stage, { recursive: true })
  const manifest = {
    name: APP,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: [scope],
    ...(updateUrl ? { updateUrl } : {}),
    tools: {
      list_items: {
        description: `List items ${version}`,
        requiredScopes: [scope],
        readOnly: true,
        handler: "list_items",
      },
    },
    jobs: { [JOB]: { handler: JOB, onDemand: true } },
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(
    join(stage, "bundle.js"),
    `function list_items() { return { version: "${version}" } }\nfunction ${JOB}() {}\n`,
  )
  const tar = join(work, `${APP}-${version}.liaisonapp`)
  const r = spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`)
  return readFileSync(tar)
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(100)
  }
  return undefined
}

async function stored(version: string): Promise<boolean> {
  try {
    await getObjectBuffer(`instance/apps/${APP}/${version}.liaisonapp`)
    return true
  } catch {
    return false
  }
}

describe("S1.4: install, upgrade and uninstall on one process reach the others, no restart", () => {
  let cell: RoleCell
  let a: RoleProcess
  let b: RoleProcess
  /** A third process sharing A's install root, as replicas on one volume do. */
  let c: RoleProcess
  let server: ReturnType<typeof Bun.serve>
  let token: string
  let connection: IORedis
  let queue: Queue
  let pids: number[]
  const rootA = join(work, "apps-a")
  const rootB = join(work, "apps-b")

  /**
   * The app's tool scopes in B's scope catalog for the org: what B has
   * registered (the derived `<app>:approve` scope comes with any tool, so it
   * says nothing about the version).
   */
  async function scopesOn(p: RoleProcess): Promise<string[]> {
    const res = await api(p.url, "/api/admin/scope-catalog", { token })
    if (res.status !== 200) throw new Error(`scope-catalog on :${p.port}: ${res.status}`)
    return (res.body.data as Array<{ scope: string }>)
      .map((e) => e.scope)
      .filter((s) => s === ALPHA || s === BETA)
      .sort()
  }

  /**
   * Wait until the followers' registered scopes for the app are `want`, B (its
   * own install root) and C (A's install root: the files are there at once, so
   * C asks for the activation lock while A may still hold it).
   */
  async function bFollows(want: string[]): Promise<void> {
    const both = async () => ({ b: await scopesOn(b), c: await scopesOn(c) })
    const target = JSON.stringify({ b: want, c: want })
    const seen = await until(async () => {
      const got = await both()
      return JSON.stringify(got) === target ? got : undefined
    }, FOLLOW_MS)
    expect(seen ?? (await both())).toEqual({ b: want, c: want })
  }

  async function instanceId(p: RoleProcess): Promise<string> {
    const res = await fetch(`${p.url}/readyz`)
    return ((await res.json()) as { instanceId: string }).instanceId
  }

  beforeAll(async () => {
    mkdirSync(rootA)
    mkdirSync(rootB)
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const bytes = packages.get(new URL(req.url).pathname)
        return bytes ? new Response(bytes) : new Response("not found", { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    packages.set("/v1.liaisonapp", pack("1.0.0", ALPHA, `${base}/v2.liaisonapp`))
    packages.set("/v2.liaisonapp", pack("2.0.0", BETA))

    cell = await createRoleCell(CELL_WORKER, [], {
      serverEnv: { LIAISON_REQUIRE_APP_SIGNATURE: "false" },
    })
    a = await cell.spawn("all", { LIAISON_APPS_DIR: rootA })
    b = await cell.spawn("all", { LIAISON_APPS_DIR: rootB })
    c = await cell.spawn("all", { LIAISON_APPS_DIR: rootA })
    pids = [a.proc.pid, b.proc.pid, c.proc.pid]
    token = (await bootstrap(a.url)).accessToken
    // The org runs in B and C too (their first touch sets it up there).
    expect(await scopesOn(b)).toEqual([])
    expect(await scopesOn(c)).toEqual([])
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
    queue = new Queue(`app-${APP}`, { connection, prefix: `${cell.redisPrefix}bull` })
  }, 240_000)

  afterAll(async () => {
    await queue?.close()
    connection?.disconnect()
    await cell?.teardown()
    server?.stop(true)
    rmSync(work, { recursive: true, force: true })
  }, 60_000)

  it("an install on A registers in B's running org and binds B's job queue within 5 s", async () => {
    const res = await api(a.url, "/api/apps/install", {
      token,
      body: { url: `http://127.0.0.1:${server.port}/v1.liaisonapp`, grantedScopes: [ALPHA] },
    })
    expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
      status: 200,
      body: null,
    })
    await bFollows([ALPHA])
    // B fetched the package: its own install root holds the version now.
    expect(existsSync(join(rootB, APP, "1.0.0", "bundle.js"))).toBe(true)
    expect(await stored("1.0.0")).toBe(true)
    // BullMQ names a Worker's connection `…:w:<instance id>`.
    const bId = await instanceId(b)
    const bound = await until(async () => {
      const ws = await queue.getWorkers()
      return ws.some((w) => String(w.rawname ?? "").endsWith(`:w:${bId}`)) ? true : undefined
    }, FOLLOW_MS)
    expect(bound).toBe(true)
  }, 60_000)

  it("an upgrade on A switches B to the new version within 5 s", async () => {
    const res = await api(a.url, `/api/apps/${APP}/upgrade/apply`, {
      token,
      body: { grantedScopes: [BETA] },
    })
    expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
      status: 200,
      body: null,
    })
    await bFollows([BETA])
    expect(existsSync(join(rootB, APP, "2.0.0", "bundle.js"))).toBe(true)
  }, 60_000)

  it("an uninstall on A unregisters it in B within 5 s and removes B's files and the stored packages", async () => {
    const res = await api(a.url, `/api/apps/${APP}`, { token, method: "DELETE" })
    expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
      status: 200,
      body: null,
    })
    await bFollows([])
    const cleaned = await until(
      async () => (existsSync(join(rootB, APP)) ? undefined : true),
      FOLLOW_MS,
    )
    expect(cleaned).toBe(true)
    expect(await stored("1.0.0")).toBe(false)
    expect(await stored("2.0.0")).toBe(false)
  }, 60_000)

  it("neither process restarted", () => {
    expect([a.proc.pid, b.proc.pid, c.proc.pid]).toEqual(pids)
    expect([a.proc.exitCode, b.proc.exitCode, c.proc.exitCode]).toEqual([null, null, null])
  })
})
