// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Code with no installed version (an import transform, a PDF template, an
// app-builder draft's preview) gets a Worker module (adhoc-module.ts) and runs
// on the sandbox service (real workerd processes) like an installed app, with
// QuickJS left only behind LIAISON_APP_RUNTIME=quickjs.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { PDFDocument } from "pdf-lib"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { createDraft, draftAppName } from "~/modules/app-builder/drafts"
import { previewDraft } from "~/modules/app-builder/preview"
import { templateFiles } from "~/modules/app-builder/templates"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { runTransformCall, TRANSFORM_RUN_APP } from "~/modules/imports/transforms/execute"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { saveTransform, TransformStoreError } from "~/modules/imports/transforms/store"
import { purgeOrgCustomApps } from "~/modules/org/purge/purge-org"
import { runTemplateToPdf } from "~/modules/pdf/sandbox-render"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { startWorkerdLoader, type WorkerdLoader } from "./__fixtures__/workerd-loader"
import {
  AdhocModuleError,
  AdhocModuleTestAccess,
  ensureScriptModule,
  pruneAdhocModules,
  readAdhocModule,
} from "./adhoc-module"
import { recentRunTimings } from "./timings"

const ENV_KEYS = [
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_SANDBOX_URL",
  "LIAISON_SANDBOX_BRIDGE_URL",
  "LIAISON_APP_RUNTIME",
  "LIAISON_CUSTOM_APPS",
] as const
type Mutable = Record<string, unknown>

const TRANSFORM = `
  async function transform(batch, ctx) {
    var out = batch.records.map(function (row) {
      return { externalRef: "help:" + row.id, subject: row.subject }
    })
    var answer = await ctx.emitRecords("tickets.ticket", out)
    return { state: { accepted: answer.accepted } }
  }`

const TEMPLATE = `
globalThis.renderTemplate = (data) => ([
  { op: "embedFont", ref: "f", standardFont: "Helvetica" },
  { op: "addPage", width: 595, height: 842 },
  { op: "drawText", page: 0, text: "Hi " + data.name, x: 40, y: 800, size: 12, font: "f" },
]);
`

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const lastRun = (app: string) =>
  recentRunTimings()
    .filter((r) => r.app === app)
    .at(-1)

describe("ad-hoc code on the sandbox service", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]))
  const savedAppsDir = process.env.LIAISON_APPS_DIR
  let scratch = ""
  let cell: Server<undefined> | null = null
  let loader: WorkerdLoader | null = null
  let orgId = ""
  let otherOrgId = ""
  let admin: UserContext

  const e = () => env as unknown as Mutable

  beforeAll(async () => {
    await acquireTestLock()
    scratch = mkdtempSync(join(tmpdir(), "adhoc-modules-"))
    process.env.LIAISON_APPS_DIR = join(scratch, "installed")
    orgId = (await createTestOrg()).id
    otherOrgId = (await minimal.secondOrg()).orgId
    const person = await minimal.orgAdmin(orgId)
    const perms = await withPrivilegedDb(orgId, "adhoc-test-perms", (tx) =>
      loadEffectivePermissions(tx, person.id, orgId),
    )
    admin = {
      actorType: "user",
      userId: person.id,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
    }
    await ensureAppsForOrg(orgId)

    cell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) })
    const cellOrigin = `http://127.0.0.1:${cell.port}`
    loader = await startWorkerdLoader({ cellOrigin })
    for (const k of ENV_KEYS) e()[k] = undefined
    e().LIAISON_SANDBOX_URL = loader.url
    e().LIAISON_SANDBOX_BRIDGE_URL = cellOrigin
    e().LIAISON_CUSTOM_APPS = "on"
  }, 600_000)

  afterAll(async () => {
    for (const k of ENV_KEYS) e()[k] = saved[k]
    await loader?.stop()
    cell?.stop(true)
    await purgeOrgCustomApps(orgId).catch(() => undefined)
    await sql`DELETE FROM kernel.app_code_modules WHERE org_id IN (${orgId}, ${otherOrgId})`
    await shutdownTransformPool()
    await shutdownWorkerPool()
    if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = savedAppsDir
    rmSync(scratch, { recursive: true, force: true })
    await releaseTestLock()
  }, 120_000)

  it("builds a script's module once per org and source, stores it by sha, refuses an import", async () => {
    AdhocModuleTestAccess.clearCache()
    const script = "function transform(b) { return { state: b.records.length } }"
    const input = { origin: "import-transform" as const, script, exports: ["transform"] }
    const before = AdhocModuleTestAccess.builds()
    const a = await ensureScriptModule({ ...input, orgId })
    AdhocModuleTestAccess.clearCache()
    // From the table, not built again.
    expect(await ensureScriptModule({ ...input, orgId })).toBe(a)
    expect(AdhocModuleTestAccess.builds() - before).toBeLessThanOrEqual(2) // + the runtime fingerprint
    const bytes = await readAdhocModule(a)
    expect(bytes && sha(bytes)).toBe(a)
    // Another org's code is its own row (deleted with that org).
    expect(await ensureScriptModule({ ...input, orgId: otherOrgId })).toBe(a)
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.app_code_modules WHERE sha256 = ${a}`
    expect(n).toBe(2)
    await expect(
      ensureScriptModule({
        ...input,
        orgId,
        script: `import { x } from "./m.ts" with { type: "macro" }\nfunction transform() { return x() }`,
      }),
    ).rejects.toBeInstanceOf(AdhocModuleError)
    // A module no run looked up for 30 days goes.
    await sql`UPDATE kernel.app_code_modules SET last_used_at = now() - interval '31 days'
      WHERE org_id = ${otherOrgId}`
    expect(await pruneAdhocModules()).toBeGreaterThanOrEqual(1)
    expect(await readAdhocModule(a)).not.toBeNull()
  }, 60_000)

  it("a saved transform's module is built at the save; code that does not build is refused there", async () => {
    await withPrivilegedDb(orgId, "adhoc-test-save", async (tx) => {
      const ref = await saveTransform(tx, {
        orgId,
        name: "adhoc-ok",
        source: TRANSFORM,
        kinds: ["tickets.ticket"],
        sourceType: "upload",
      })
      expect(ref.version).toBe(1)
    })
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.app_code_modules
      WHERE org_id = ${orgId} AND origin = 'import-transform'`
    expect(n).toBeGreaterThanOrEqual(1)
    const err = await withPrivilegedDb(orgId, "adhoc-test-save-bad", (tx) =>
      saveTransform(tx, {
        orgId,
        name: "adhoc-bad",
        source: "function transform(batch, ctx) { return {",
        kinds: ["tickets.ticket"],
        sourceType: "upload",
      }),
    ).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(TransformStoreError)
    expect((err as Error).message).toContain("Worker module")
  }, 60_000)

  it("an import transform runs on workerd, its bridge calls landing on the cell", async () => {
    const r = await runTransformCall({
      source: TRANSFORM,
      entry: "transform",
      params: {
        records: [
          { id: 1, subject: "Printer offline" },
          { id: 2, subject: "Refund" },
        ],
      },
      host: { orgId, kinds: ["tickets.ticket"], sourceType: "upload" },
    })
    expect(r.emitted).toEqual([
      {
        kind: "tickets.ticket",
        records: [
          { externalRef: "help:1", subject: "Printer offline" },
          { externalRef: "help:2", subject: "Refund" },
        ],
      },
    ])
    expect(r.value).toEqual({ state: { accepted: 2 } })
    expect(lastRun(TRANSFORM_RUN_APP)).toMatchObject({ executor: "workerd", ok: true })
    // `finish` is optional: the module's dispatcher answers that none is defined.
    const fin = await runTransformCall({
      source: TRANSFORM,
      entry: "finish",
      params: { records: [], state: null, done: true },
      host: { orgId, kinds: ["tickets.ticket"], sourceType: "upload" },
    })
    expect(fin.value).toEqual({ __liaisonNoFinish: true })
  }, 120_000)

  it("a PDF template renders on workerd", async () => {
    const bytes = await runTemplateToPdf({
      orgId,
      appName: "invoicing",
      bundleSource: TEMPLATE,
      data: { name: "Acme" },
    })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
    expect(lastRun("invoicing")).toMatchObject({ executor: "workerd", ok: true })
  }, 120_000)

  it("a draft's preview runs its own worker.js on workerd", async () => {
    const appName = draftAppName(orgId, "adhoc-read")
    const { draft } = await withRlsContext(admin, (tx) =>
      createDraft(
        tx,
        { orgId, userId: admin.userId },
        {
          baseName: "adhoc-read",
          title: "Adhoc",
          files: templateFiles("read-only", appName, "Adhoc"),
        },
      ),
    )
    const r = await previewDraft(
      { orgId, userId: admin.userId, scopes: admin.scopes },
      { draftId: draft.id, entry: { kind: "tool", name: "summary" } },
    )
    expect(r.error).toBeUndefined()
    expect(r).toMatchObject({ ok: true, result: { count: 0 } })
    expect(lastRun(appName)).toMatchObject({ executor: "workerd", ok: true })
    const runs = (loader?.runs ?? []).map(
      (x) => JSON.parse(x.body) as { app: string; version: string },
    )
    expect(runs.find((b) => b.app === appName)?.version).toBe("draft-1")
  }, 180_000)

  it("LIAISON_APP_RUNTIME=quickjs keeps ad-hoc code on QuickJS and builds nothing", async () => {
    e().LIAISON_APP_RUNTIME = "quickjs"
    try {
      AdhocModuleTestAccess.clearCache()
      const before = AdhocModuleTestAccess.builds()
      const r = await runTransformCall({
        source: `function transform(b, ctx) { return { state: { n: b.records.length, q: 1 } } }`,
        entry: "transform",
        params: { records: [1, 2, 3] },
        host: { orgId, kinds: ["tickets.ticket"], sourceType: "upload" },
      })
      expect(r.value).toEqual({ state: { n: 3, q: 1 } })
      expect(lastRun(TRANSFORM_RUN_APP)?.executor).toBe("quickjs")
      expect(AdhocModuleTestAccess.builds()).toBe(before)
    } finally {
      e().LIAISON_APP_RUNTIME = undefined
    }
  }, 120_000)
})
