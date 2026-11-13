// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installed versions with no Worker module: the boot gives each the worker.js of
// its own stored package, and lists (and counts) those whose package has none.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { deleteObject, putObject } from "~/infra/storage/object-storage"
import { packageKey } from "~/modules/apps/package-store"
import { backfillWorkerModules, countInstallsWithoutWorkerModule } from "./worker-module-backfill"

const WITH = `wmbf-with-${Date.now().toString(36)}`
const WITHOUT = `wmbf-without-${Date.now().toString(36)}`
const WORKER_JS = "export default { run() { return 1 } }\n"
const work: string[] = []

/** A package of `name`@1.0.0, with a worker.js or not. */
function pkg(name: string, worker: boolean): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "wmbf-"))
  work.push(dir)
  const stage = join(dir, "stage")
  mkdirSync(stage)
  writeFileSync(
    join(stage, "app.manifest.json"),
    JSON.stringify({ name, version: "1.0.0", packageFormat: 1, license: "MIT", scopes: [] }),
  )
  writeFileSync(join(stage, "bundle.js"), "function x() {}\n")
  const files = ["app.manifest.json", "bundle.js"]
  if (worker) {
    writeFileSync(join(stage, "worker.js"), WORKER_JS)
    files.push("worker.js")
  }
  const tar = join(dir, "p.liaisonapp")
  spawnSync("tar", ["-czf", tar, "-C", stage, ...files])
  return readFileSync(tar)
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

describe("the Worker module back-fill", () => {
  beforeAll(async () => {
    for (const [name, worker] of [
      [WITH, true],
      [WITHOUT, false],
    ] as const) {
      const bytes = pkg(name, worker)
      await putObject({
        key: packageKey(name, "1.0.0"),
        body: bytes,
        contentType: "application/gzip",
      })
      await withSystemDb("wmbf-seed", async (db) => {
        await db.insert(appsInstalled).values({
          name,
          version: "1.0.0",
          sourceUrl: "file:///wmbf",
          sha256: sha(bytes),
          installedBy: "00000000-0000-0000-0000-000000000000",
        })
        await db.insert(appsActiveVersion).values({ name, version: "1.0.0" })
      })
    }
  })

  afterAll(async () => {
    await withSystemDb("wmbf-clean", async (db) => {
      await db.delete(appsActiveVersion).where(inArray(appsActiveVersion.name, [WITH, WITHOUT]))
      await db.delete(appsInstalled).where(inArray(appsInstalled.name, [WITH, WITHOUT]))
    })
    for (const name of [WITH, WITHOUT])
      await deleteObject(packageKey(name, "1.0.0")).catch(() => {})
    for (const d of work) rmSync(d, { recursive: true, force: true })
  })

  it("records the worker.js of a version's own package, and lists one whose package has none", async () => {
    const before = await countInstallsWithoutWorkerModule()
    const r = await backfillWorkerModules()
    expect(r.backfilled).toContain(`${WITH}@1.0.0`)
    expect(r.missing.map((m) => m.app)).toContain(`${WITHOUT}@1.0.0`)
    expect(r.missing.find((m) => m.app === `${WITHOUT}@1.0.0`)?.reason).toMatch(/no worker\.js/)
    const rows = await withSystemDb("wmbf-read", (db) =>
      db
        .select({ name: appsInstalled.name, workerSha256: appsInstalled.workerSha256 })
        .from(appsInstalled)
        .where(inArray(appsInstalled.name, [WITH, WITHOUT])),
    )
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.workerSha256]))
    expect(byName[WITH]).toBe(sha(WORKER_JS))
    expect(byName[WITHOUT]).toBeNull()
    // The one still without a module is what /healthz counts.
    expect(await countInstallsWithoutWorkerModule()).toBe(before - 1)
    // A second pass records nothing again.
    expect((await backfillWorkerModules()).backfilled).not.toContain(`${WITH}@1.0.0`)
  })
})
