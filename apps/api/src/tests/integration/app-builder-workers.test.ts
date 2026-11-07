// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Custom apps on the Workers executor (LIAISON_WORKERS_CUSTOM_APPS), end to
// end on a real database, the real install path and a local loader that
// behaves like the real one (workers/__fixtures__/fake-loader.ts):
//   - a publish records the pinned build's Worker module on the installed row;
//   - selection: a custom app goes to Workers only with the switch on, and
//     needs no LIAISON_WORKERS_APPS / LIAISON_WORKERS_BUNDLES entry;
//   - parity: the loader has no copy, fetches the module from the cell's
//     bundle route (signed v2 loader->cell), re-hashes it, runs it, and the
//     tool answers as on QuickJS;
//   - the bundle route refuses unsigned, v1, a /run signature replayed, another
//     path, a stale timestamp, an unknown sha and a draft's unpublished sha; it
//     serves an installed custom app of ANY org of the cell (cell-wide: the
//     loader holds one key per cell);
//   - reliability: one org's broken module falls back to QuickJS for that
//     org's app only, another org stays on Workers, and the run line says so;
//   - logs: the app's console lines reach its app logs (source "console") on
//     Workers and on QuickJS alike.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { createRlsSession, type UserContext, withRlsContext } from "~/db/rls"
import { appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import { checkDraft } from "~/modules/app-builder/check"
import { createDraft, draftAppName, updateDraftFiles } from "~/modules/app-builder/drafts"
import { templateFiles } from "~/modules/app-builder/templates"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { clearInstalledIdentityCache, resolveWorkersTarget } from "~/modules/apps/sandbox/run-app"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { type FakeLoader, startFakeLoader } from "~/modules/apps/workers/__fixtures__/fake-loader"
import { WorkersFallbackTestAccess } from "~/modules/apps/workers/fallback"
import {
  CELL_SIGNATURE_VERSION_HEADER,
  signCellRequestV1,
  signCellRequestV2,
} from "~/modules/apps/workers/sign"
import { recentRunTimings } from "~/modules/apps/workers/timings"
import { purgeOrgCustomApps } from "~/modules/org/purge/purge-org"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CELL_ID = "cell-custom"
const CELL_KEY = "custom-cell-key-0123456789abcdef"
const ENV_KEYS = [
  "LIAISON_WORKERS_APPS",
  "LIAISON_WORKERS_CUSTOM_APPS",
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_WORKERS_BUNDLES",
] as const
type Mutable = Record<string, unknown>
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]))
const savedRole = env.LIAISON_ROLE
const savedAppsDir = process.env.LIAISON_APPS_DIR

interface Org {
  orgId: string
  adminId: string
  bearer: string
  admin: UserContext
}
let a: Org
let b: Org
let installRoot = ""
let cell: Server<undefined> | null = null
let cellOrigin = ""
let loader: FakeLoader

async function makeOrg(second = false): Promise<Org> {
  // createTestOrg truncates the org tables: the second org comes from the seed's own path.
  const orgId = second ? (await minimal.secondOrg()).orgId : (await createTestOrg()).id
  const person = await minimal.orgAdmin(orgId)
  const perms = await withPrivilegedDb(orgId, "builder-workers-perms", (tx) =>
    loadEffectivePermissions(tx, person.id, orgId),
  )
  await ensureAppsForOrg(orgId)
  return {
    orgId,
    adminId: person.id,
    bearer: await minimal.token(person.id),
    admin: {
      actorType: "user",
      userId: person.id,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
    },
  }
}

/** Loader + cell configured; custom apps on unless `custom: false`. */
function workers(opts: { custom?: boolean } = {}) {
  const e = env as unknown as Mutable
  for (const k of ENV_KEYS) e[k] = undefined
  e.LIAISON_APP_LOADER_URL = loader.url
  e.LIAISON_APP_LOADER_CELL_ID = CELL_ID
  e.LIAISON_APP_LOADER_KEY = CELL_KEY
  e.LIAISON_APP_BRIDGE_BASE_URL = cellOrigin
  if (opts.custom === false) {
    // A listed-apps cell that does not list it: the custom app stays on QuickJS.
    e.LIAISON_WORKERS_APPS = "kpi"
    e.LIAISON_WORKERS_BUNDLES = JSON.stringify({ "kpi@1.0.0": "a".repeat(64) })
  } else {
    e.LIAISON_WORKERS_CUSTOM_APPS = "1"
  }
  clearInstalledIdentityCache()
}

function workersOff() {
  const e = env as unknown as Mutable
  for (const k of ENV_KEYS) e[k] = undefined
  clearInstalledIdentityCache()
}

async function publish(
  org: Org,
  base: string,
  extraHandlers = "",
  editHandlers: (source: string) => string = (source) => source,
): Promise<{ appName: string; draftId: string }> {
  const appName = draftAppName(org.orgId, base)
  const files = templateFiles("store-crud", appName, `Draft ${base}`)
  files["handlers.ts"] = editHandlers(`${files["handlers.ts"]}${extraHandlers}`)
  const { draft } = await withRlsContext(org.admin, (tx) =>
    createDraft(
      tx,
      { orgId: org.orgId, userId: org.adminId },
      {
        baseName: base,
        title: `Draft ${base}`,
        files,
      },
    ),
  )
  const res = await app.request(`/api/apps/builder/drafts/${draft.id}/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${org.bearer}`, "content-type": "application/json" },
    body: "{}",
  })
  expect(res.status).toBe(200)
  await ensureAppsForOrg(org.orgId)
  return { appName, draftId: draft.id }
}

async function workerRow(appName: string) {
  const [row] = await sql<{ worker_sha256: string | null; worker_module: Buffer | null }[]>`
    SELECT worker_sha256, worker_module FROM kernel.apps_installed
    WHERE name = ${appName} AND version = '0.1.0'`
  return row
}

function bundleGet(sha: string, headers: Record<string, string>) {
  return app.request(`http://localhost/api/app-bridge/bundles/${sha}`, { method: "GET", headers })
}

function signedGet(sha: string, over: { ts?: number; path?: string } = {}) {
  return signCellRequestV2({
    cellId: CELL_ID,
    cellKey: CELL_KEY,
    direction: "loader->cell",
    method: "GET",
    path: over.path ?? `/api/app-bridge/bundles/${sha}`,
    body: "",
    ...(over.ts !== undefined ? { ts: over.ts } : {}),
  })
}

let crud: { appName: string; draftId: string }
let crudSha = ""

const savedCustomApps = env.LIAISON_CUSTOM_APPS

beforeAll(async () => {
  // Organisations' own apps on, on either edition (they default off when self-hosted).
  env.LIAISON_CUSTOM_APPS = "on"
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "builder-workers-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
  ;(env as unknown as Mutable).LIAISON_ROLE = "all"
  a = await makeOrg()
  b = await makeOrg(true)
  cell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) })
  cellOrigin = `http://127.0.0.1:${cell.port}`
  loader = startFakeLoader({
    cells: { [CELL_ID]: { key: CELL_KEY, bridgeOrigin: cellOrigin } },
    bundles: {},
  })
  workersOff()
  crud = await publish(a, "wk-crud")
  crudSha = (await workerRow(crud.appName))?.worker_sha256 ?? ""
}, 300_000)

afterAll(async () => {
  env.LIAISON_CUSTOM_APPS = savedCustomApps
  const e = env as unknown as Mutable
  for (const k of ENV_KEYS) e[k] = savedEnv[k]
  e.LIAISON_ROLE = savedRole
  loader?.stop()
  cell?.stop(true)
  for (const org of [a, b]) if (org) await purgeOrgCustomApps(org.orgId).catch(() => undefined)
  await shutdownWorkerPool()
  clearInstalledIdentityCache()
  if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = savedAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
}, 120_000)

describe("custom apps on Workers", () => {
  it("a publish records the pinned build's Worker module on the installed row", async () => {
    const row = await workerRow(crud.appName)
    expect(row?.worker_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(
      createHash("sha256")
        .update(row?.worker_module ?? "")
        .digest("hex"),
    ).toBe(row?.worker_sha256 as string)
    const [v] = await sql<{ sha: string }[]>`
      SELECT build->>'workerSha256' AS sha FROM kernel.app_draft_versions
      WHERE draft_id = ${crud.draftId} AND n = 1`
    expect(v?.sha).toBe(row?.worker_sha256 as string)
  })

  it("selects a custom app only with LIAISON_WORKERS_CUSTOM_APPS=1, from its row's sha", async () => {
    const opts = { trusted: false, appName: crud.appName, orgId: a.orgId }
    workersOff()
    expect(await resolveWorkersTarget(opts)).toBeNull()
    workers({ custom: false })
    expect(await resolveWorkersTarget(opts)).toBeNull()
    workers()
    const target = await resolveWorkersTarget(opts)
    expect(target?.sha256).toBe(crudSha)
    expect(target?.version).toBe("0.1.0")
    // A caller-supplied identity without the module still finds it on the row.
    const supplied = await resolveWorkersTarget({
      ...opts,
      installed: { version: "0.1.0", sha256: "x" },
    })
    expect(supplied?.sha256).toBe(crudSha)
    // Trusted code never goes there; another org does not see the app's row.
    expect(await resolveWorkersTarget({ ...opts, trusted: true })).toBeNull()
    expect(await resolveWorkersTarget({ ...opts, orgId: b.orgId })).toBeNull()
  })

  it("parity: the loader fetches the module from the cell, runs it, and the tool answers as on QuickJS", async () => {
    const call = (title: string) =>
      executeTool({
        toolName: `${crud.appName}:items_add`,
        orgId: a.orgId,
        actor: a.admin,
        params: { title },
        origin: "human-ui",
      })
    const list = () =>
      executeTool({
        toolName: `${crud.appName}:items_list`,
        orgId: a.orgId,
        actor: a.admin,
        params: {},
        origin: "human-ui",
      })
    workersOff()
    const q = await call("on-quickjs")
    expect(JSON.stringify(q)).not.toContain("error")

    workers()
    const fetchesBefore = loader.bundleFetches.length
    const w = await call("on-workers")
    expect(JSON.stringify(w)).not.toContain("error")
    const run = recentRunTimings()
      .filter((r) => r.app === crud.appName)
      .at(-1)
    expect(run?.executor).toBe("workers")
    expect(run?.ok).toBe(true)
    const fetched = loader.bundleFetches.slice(fetchesBefore)
    expect(fetched.map((f) => f.status)).toEqual([200])
    expect(fetched[0]?.url).toBe(`${cellOrigin}/api/app-bridge/bundles/${crudSha}`)
    expect(fetched[0]?.headers[CELL_SIGNATURE_VERSION_HEADER]).toBe("2")
    // Same shape of answer on both executors (ids and times differ).
    const shape = (v: unknown) => JSON.stringify(v).replace(/"[^"]*"/g, '""')
    expect(shape(w)).toBe(shape(q))

    // Cached: the next run fetches nothing; both writes are in the app's store.
    const listed = JSON.stringify(await list())
    expect(loader.bundleFetches.length).toBe(fetchesBefore + 1)
    expect(listed).toContain("on-quickjs")
    expect(listed).toContain("on-workers")
    workersOff()
  }, 180_000)
})

describe("GET /api/app-bridge/bundles/:sha256", () => {
  it("serves the installed module to a v2 loader->cell signature", async () => {
    workers()
    const res = await bundleGet(crudSha, signedGet(crudSha))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/javascript")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(crudSha)
  })

  it("answers 404 on every path while custom apps are off", async () => {
    workers({ custom: false })
    expect((await bundleGet(crudSha, signedGet(crudSha))).status).toBe(404)
    workersOff()
    expect((await bundleGet(crudSha, signedGet(crudSha))).status).toBe(404)
  })

  it("refuses unsigned, v1, a /run signature replayed, another path, a stale timestamp and another cell", async () => {
    workers()
    const reason = async (res: Response) => {
      expect(res.status).toBe(401)
      return ((await res.json()) as { reason: string }).reason
    }
    expect(await reason(await bundleGet(crudSha, {}))).toBe("unknown_cell")
    expect(await reason(await bundleGet(crudSha, { "x-cell-id": CELL_ID }))).toBe("missing")
    // A legacy v1 signature (no version header): never accepted by the cell.
    expect(await reason(await bundleGet(crudSha, signCellRequestV1(CELL_ID, CELL_KEY, "")))).toBe(
      "missing",
    )
    // A captured cell->loader /run signature replayed here (same key, other direction).
    const run = signCellRequestV2({
      cellId: CELL_ID,
      cellKey: CELL_KEY,
      direction: "cell->loader",
      method: "POST",
      path: "/run",
      body: "",
    })
    expect(await reason(await bundleGet(crudSha, run))).toBe("bad_signature")
    const sameRoute = signCellRequestV2({
      cellId: CELL_ID,
      cellKey: CELL_KEY,
      direction: "cell->loader",
      method: "GET",
      path: `/api/app-bridge/bundles/${crudSha}`,
      body: "",
    })
    expect(await reason(await bundleGet(crudSha, sameRoute))).toBe("bad_signature")
    // Signed for another sha's path.
    const other = "0".repeat(64)
    expect(await reason(await bundleGet(crudSha, signedGet(other)))).toBe("bad_signature")
    expect(
      await reason(await bundleGet(crudSha, signedGet(crudSha, { ts: Date.now() - 61_000 }))),
    ).toBe("skew")
    const wrongKey = signCellRequestV2({
      cellId: CELL_ID,
      cellKey: "another-cell-key-0000000000000000",
      direction: "loader->cell",
      method: "GET",
      path: `/api/app-bridge/bundles/${crudSha}`,
      body: "",
    })
    expect(await reason(await bundleGet(crudSha, wrongKey))).toBe("bad_signature")
    expect(
      await reason(await bundleGet(crudSha, { ...signedGet(crudSha), "x-cell-id": "cell-other" })),
    ).toBe("unknown_cell")
  })

  it("answers 404 for an unknown sha and for a draft's sha before its publish", async () => {
    workers()
    const unknown = "f".repeat(64)
    expect((await bundleGet(unknown, signedGet(unknown))).status).toBe(404)
    expect((await bundleGet("nothex", signedGet("nothex"))).status).toBe(404)

    // Version 2 of the draft, built (checked) but not published: its module is not servable.
    const files = templateFiles("store-crud", crud.appName, "Draft wk-crud v2")
    files["handlers.ts"] = `${files["handlers.ts"]}\nexport const v2 = true\n`
    await withRlsContext(a.admin, (tx) =>
      updateDraftFiles(
        tx,
        { orgId: a.orgId, userId: a.adminId },
        {
          draftId: crud.draftId,
          files,
          message: "v2",
        },
      ),
    )
    const checked = await checkDraft(
      createRlsSession(a.admin),
      { orgId: a.orgId, userId: a.adminId },
      { draftId: crud.draftId },
    )
    expect(checked.ok).toBe(true)
    const [v2] = await sql<{ sha: string }[]>`
      SELECT build->>'workerSha256' AS sha FROM kernel.app_draft_versions
      WHERE draft_id = ${crud.draftId} AND n = ${checked.n}`
    expect(v2?.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(v2?.sha).not.toBe(crudSha)
    expect((await bundleGet(v2!.sha, signedGet(v2!.sha))).status).toBe(404)
  }, 180_000)

  it("is cell-wide: another org's installed custom app is servable to the loader", async () => {
    // The module is the handlers' code alone: the same code in two apps is one
    // module (one sha). Different code here, so this sha is this app's only.
    const theirs = await publish(b, "wk-other", '\nexport const marker = "org-b"\n')
    const sha = (await workerRow(theirs.appName))?.worker_sha256 ?? ""
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(sha).not.toBe(crudSha)
    workers()
    expect((await bundleGet(sha, signedGet(sha))).status).toBe(200)
    // A disabled custom app's module is not served.
    const disabled = await withSystemDb("builder-workers-disable", (db) =>
      db
        .update(appsInstalled)
        .set({ disabledAt: new Date(), disabledReason: "test" })
        .where(eq(appsInstalled.name, theirs.appName))
        .returning({ name: appsInstalled.name }),
    )
    expect(disabled.length).toBe(1)
    expect((await bundleGet(sha, signedGet(sha))).status).toBe(404)
  }, 180_000)
})

describe("custom apps on Workers: fallback and console logs", () => {
  // A distinct line per app: identical sources would build one identical Worker module.
  const addLine = (tag: string) => (source: string) =>
    source.replace(
      'ctx.logger.info("added an item", { id: doc.id })',
      `ctx.logger.info("added an item", { id: doc.id })\n  console.log("console says added (${tag})", params.title)`,
    )
  const add = (org: Org, appName: string, title: string) =>
    executeTool({
      toolName: `${appName}:items_add`,
      orgId: org.orgId,
      actor: org.admin,
      params: { title },
      origin: "human-ui",
    })
  const lastRun = (appName: string) =>
    recentRunTimings()
      .filter((r) => r.app === appName)
      .at(-1)
  const consoleRows = (orgId: string, appName: string) =>
    sql<{ message: string; source: string | null; run_id: string }[]>`
      SELECT message, fields->>'source' AS source, run_id::text FROM kernel.app_logs
      WHERE org_id = ${orgId} AND app = ${appName} AND fields->>'source' = 'console'
      ORDER BY at`

  it("org A's broken module falls back to QuickJS for org A's app only; org B stays on Workers", async () => {
    workersOff()
    const broken = await publish(a, "wk-broken", "", addLine("broken"))
    const healthy = await publish(b, "wk-healthy", "", addLine("healthy"))
    // Org A's installed module no longer hashes to its sha: the cell cannot serve it.
    await withSystemDb("test-break-module", (db) =>
      db
        .update(appsInstalled)
        .set({ workerModule: Buffer.from("not the module") })
        .where(eq(appsInstalled.name, broken.appName)),
    )
    WorkersFallbackTestAccess.reset()
    workers()

    const first = await add(a, broken.appName, "a-first").then(
      () => null,
      (e: Error) => e,
    )
    expect(first).toBeInstanceOf(Error)
    expect(lastRun(broken.appName)).toMatchObject({
      executor: "workers",
      ok: false,
      faultClass: "app",
      errorKind: "bundle_missing",
    })
    expect(loader.bundleFetches.at(-1)?.status).toBe(404)

    const second = await add(a, broken.appName, "a-second")
    expect(JSON.stringify(second)).not.toContain("error")
    expect(lastRun(broken.appName)).toMatchObject({
      executor: "quickjs",
      ok: true,
      fallback: "app",
    })

    const other = await add(b, healthy.appName, "b-first")
    expect(JSON.stringify(other)).not.toContain("error")
    const bRun = lastRun(healthy.appName)
    expect(bRun?.executor).toBe("workers")
    expect(bRun?.fallback).toBeUndefined()

    // Console lines: on Workers (org B) and on QuickJS (org A's fallback run), both in the
    // app logs (a session bridge's sink flushes on its own timer, 2 s after its first line).
    const messages = async (orgId: string, appName: string) =>
      (await consoleRows(orgId, appName)).map((r) => r.message)
    const until = Date.now() + 8_000
    while (
      Date.now() < until &&
      (!(await messages(b.orgId, healthy.appName)).length ||
        !(await messages(a.orgId, broken.appName)).length)
    ) {
      await Bun.sleep(200)
    }
    expect(await messages(b.orgId, healthy.appName)).toContain(
      "console says added (healthy) b-first",
    )
    expect(await messages(a.orgId, broken.appName)).toContain(
      "console says added (broken) a-second",
    )
    WorkersFallbackTestAccess.reset()
    workersOff()
  }, 240_000)
})
