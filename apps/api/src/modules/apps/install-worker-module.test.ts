// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every `.liaisonapp` carries its Worker module (worker.js beside bundle.js):
// the install records its sha256 and bytes on the installed row, checks them
// against a pin when one is given (the catalog's index, the app builder's
// approval), and the cell serves the module to the app loader for any
// installed, enabled app, re-hashed on the way out.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import {
  applyUpgrade,
  installAppFromTarball,
  WorkerModulePinMismatchError,
} from "~/modules/apps/install-service"
import { readInstalledWorkerModule } from "~/modules/apps/sandbox/run-app"
import { createAppBridgeBundleRoutes } from "~/modules/apps/workers/bundle-route"
import type { WorkersConfig } from "~/modules/apps/workers/config"
import { signCellRequestV2 } from "~/modules/apps/workers/sign"

const ADMIN = "00000000-0000-0000-0000-000000000001"
const APP = "test-worker-module"
let installRoot = ""
const work: string[] = []

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** A package; `worker` null leaves worker.js out (a package from before they were packaged). */
function pkg(version: string, worker: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-pkg-"))
  work.push(dir)
  const stage = join(dir, "stage")
  mkdirSync(stage)
  writeFileSync(
    join(stage, "app.manifest.json"),
    JSON.stringify({
      name: APP,
      version,
      packageFormat: 1,
      license: "MIT",
      scopes: [`${APP}:items:read`],
    }),
  )
  writeFileSync(join(stage, "bundle.js"), "// noop")
  const files = ["app.manifest.json", "bundle.js"]
  if (worker !== null) {
    writeFileSync(join(stage, "worker.js"), worker)
    files.push("worker.js")
  }
  const tar = join(dir, `${APP}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, ...files])
  return tar
}

const install = (tarballPath: string, workerSha256?: string) =>
  installAppFromTarball({
    tarballPath,
    installedBy: ADMIN,
    grantedScopes: [`${APP}:items:read`],
    requireSignature: false,
    ...(workerSha256 ? { workerSha256 } : {}),
  })

async function row(version: string) {
  const all = await withSystemDb("worker-module-test-rows", (db) =>
    db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
  )
  return all.find((x) => x.version === version)
}

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "worker-install-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
})
afterEach(async () => {
  rmSync(installRoot, { recursive: true, force: true })
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true })
  await withSystemDb("worker-module-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
  })
})

const WORKER = "export default { run() { return 1 } }\n"

describe("install records the package's Worker module", () => {
  it("records worker.js's sha256 and bytes for an instance app (no pin needed)", async () => {
    await install(pkg("1.0.0", WORKER))
    const r = await row("1.0.0")
    expect(r?.orgId).toBeNull()
    expect(r?.workerSha256).toBe(sha(WORKER))
    expect(new TextDecoder().decode(r?.workerModule ?? new Uint8Array())).toBe(WORKER)
  })

  it("accepts the bytes the pin names", async () => {
    await install(pkg("1.0.0", WORKER), sha(WORKER))
    expect((await row("1.0.0"))?.workerSha256).toBe(sha(WORKER))
  })

  it("refuses a tampered worker.js against its pin, and records nothing", async () => {
    const tampered = `${WORKER}globalThis.exfiltrate = true\n`
    await expect(install(pkg("1.0.0", tampered), sha(WORKER))).rejects.toBeInstanceOf(
      WorkerModulePinMismatchError,
    )
    expect(await row("1.0.0")).toBeUndefined()
  })

  it("refuses a pinned install whose package carries no worker.js", async () => {
    await expect(install(pkg("1.0.0", null), sha(WORKER))).rejects.toThrow(/is missing/)
    expect(await row("1.0.0")).toBeUndefined()
  })

  it("installs a package without worker.js with no module (it runs on QuickJS)", async () => {
    await install(pkg("1.0.0", null))
    const r = await row("1.0.0")
    expect(r?.workerSha256).toBeNull()
    expect(r?.workerModule).toBeNull()
  })

  it("an install without a module gains one when it moves to a package that has it", async () => {
    await install(pkg("1.0.0", null))
    // The catalog path (an install over the active version) ...
    await install(pkg("1.1.0", WORKER), sha(WORKER))
    expect((await row("1.0.0"))?.workerSha256).toBeNull()
    expect((await row("1.1.0"))?.workerSha256).toBe(sha(WORKER))
    // ... and an admin's upgrade.
    const next = `${WORKER}// 1.2.0\n`
    await applyUpgrade({
      name: APP,
      tarballPath: pkg("1.2.0", next),
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    expect((await row("1.2.0"))?.workerSha256).toBe(sha(next))
  })
})

describe("the cell serves any installed app's module to the loader", () => {
  const cfg: WorkersConfig = {
    loaderUrl: "https://loader.invalid",
    cellId: "cell-wm",
    loaderKey: "wm-cell-key-0123456789abcdef",
    bridgeBaseUrl: "https://cell.invalid",
  }
  const get = (route: ReturnType<typeof createAppBridgeBundleRoutes>, s: string) =>
    route.request(`/bundles/${s}`, {
      headers: signCellRequestV2({
        cellId: cfg.cellId,
        cellKey: cfg.loaderKey,
        direction: "loader->cell",
        method: "GET",
        path: `/bundles/${s}`,
        body: "",
      }),
    })

  it("serves an instance (catalog-style) app's module, re-hashed; nothing while no loader is configured", async () => {
    await install(pkg("1.0.0", WORKER))
    const route = createAppBridgeBundleRoutes({ config: () => cfg })
    const res = await get(route, sha(WORKER))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(WORKER)
    expect((await readInstalledWorkerModule(sha(WORKER)))?.appName).toBe(APP)
    const off = createAppBridgeBundleRoutes({ config: () => null })
    expect((await get(off, sha(WORKER))).status).toBe(404)
  })

  it("never serves a disabled version's module, nor bytes that no longer match their sha", async () => {
    await install(pkg("1.0.0", WORKER))
    await withSystemDb("worker-module-test-disable", (db) =>
      db.update(appsInstalled).set({ disabledAt: new Date() }).where(eq(appsInstalled.name, APP)),
    )
    expect(await readInstalledWorkerModule(sha(WORKER))).toBeNull()
    await withSystemDb("worker-module-test-tamper", (db) =>
      db
        .update(appsInstalled)
        .set({ disabledAt: null, workerModule: new TextEncoder().encode("tampered") })
        .where(eq(appsInstalled.name, APP)),
    )
    expect(await readInstalledWorkerModule(sha(WORKER))).toBeNull()
  })
})
