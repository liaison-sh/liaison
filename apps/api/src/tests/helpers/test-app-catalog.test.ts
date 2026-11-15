// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A catalog dir the process inherited is shared with other API servers: baking into it would
// let each server's memoized index drop the entries another baked. The bake writes its own copy.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listCatalog, resetCatalogCache } from "~/modules/apps/catalog"
import { bakeIntoTestCatalog } from "./test-app-catalog"

let work = ""
let saved: string | undefined

function tarball(name: string, version: string): string {
  const src = join(work, `${name}-src`)
  spawnSync("mkdir", ["-p", src])
  writeFileSync(join(src, "app.manifest.json"), JSON.stringify({ name, version, scopes: [] }))
  const out = join(work, `${name}-${version}.liaisonapp`)
  const r = spawnSync("tar", ["-czf", out, "-C", src, "app.manifest.json"])
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr?.toString()}`)
  return out
}

beforeEach(() => {
  saved = process.env.LIAISON_APP_CATALOG_DIR
  work = mkdtempSync(join(tmpdir(), "test-app-catalog-test-"))
})

afterEach(() => {
  if (saved === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
  else process.env.LIAISON_APP_CATALOG_DIR = saved
  resetCatalogCache()
  rmSync(work, { recursive: true, force: true })
})

describe("bakeIntoTestCatalog", () => {
  it("never writes an inherited catalog dir, and keeps its entries in its own copy", () => {
    const shared = join(work, "shared")
    spawnSync("mkdir", ["-p", shared])
    const inherited = tarball("lane-app", "1.0.0")
    spawnSync("cp", [inherited, join(shared, "lane-app-1.0.0.liaisonapp")])
    const index = `${JSON.stringify([
      { name: "lane-app", version: "1.0.0", file: "lane-app-1.0.0.liaisonapp", scopes: [], connections: [] },
    ])}\n`
    writeFileSync(join(shared, "catalog.json"), index)
    process.env.LIAISON_APP_CATALOG_DIR = shared
    resetCatalogCache()

    const path = bakeIntoTestCatalog(tarball("baked-app", "0.1.0"))

    expect(readFileSync(join(shared, "catalog.json"), "utf8")).toBe(index)
    expect(process.env.LIAISON_APP_CATALOG_DIR).not.toBe(shared)
    expect(path.startsWith(process.env.LIAISON_APP_CATALOG_DIR ?? "")).toBe(true)
    expect(listCatalog().map((e) => e.name).sort()).toEqual(["baked-app", "lane-app"])

    // A second bake goes to the same owned copy and keeps the first.
    bakeIntoTestCatalog(tarball("other-app", "0.2.0"))
    expect(listCatalog().map((e) => e.name).sort()).toEqual(["baked-app", "lane-app", "other-app"])
  })
})
