// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveSeedAppDirs } from "~/cli/seed/app-dirs"

describe("liaison seed: app catalog and apps folder outside the image", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "seed-app-dirs-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })
  const withCatalog = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "catalog.json"), "[]")
  }

  it("defaults both to the checkout's own folders when unset", () => {
    withCatalog(path.join(repo, "app-catalog"))
    const res = resolveSeedAppDirs({ env: {}, repoRoot: repo, needsCatalog: true, inImage: false })
    expect(res).toEqual({
      ok: true,
      set: {
        LIAISON_APP_CATALOG_DIR: path.join(repo, "app-catalog"),
        LIAISON_APPS_DIR: path.join(repo, ".liaison-apps", "apps"),
      },
    })
    expect(existsSync(path.join(repo, ".liaison-apps", "apps"))).toBe(true)
  })

  it("keeps what the environment sets", () => {
    const catalog = path.join(repo, "elsewhere")
    withCatalog(catalog)
    const res = resolveSeedAppDirs({
      env: { LIAISON_APP_CATALOG_DIR: catalog, LIAISON_APPS_DIR: path.join(repo, "apps") },
      repoRoot: repo,
      needsCatalog: true,
      inImage: false,
    })
    expect(res).toEqual({ ok: true, set: {} })
  })

  it("stops with the variable to set when the checkout has no catalog", () => {
    const res = resolveSeedAppDirs({ env: {}, repoRoot: repo, needsCatalog: true, inImage: false })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.message).toContain("LIAISON_APP_CATALOG_DIR")
      expect(res.message).toContain("scripts/build-app-catalog.ts")
    }
    expect(existsSync(path.join(repo, ".liaison-apps"))).toBe(false)
  })

  it("goes on without a catalog when the seed writes no commerce, still defaulting the apps folder", () => {
    expect(
      resolveSeedAppDirs({ env: {}, repoRoot: repo, needsCatalog: false, inImage: false }),
    ).toEqual({
      ok: true,
      set: { LIAISON_APPS_DIR: path.join(repo, ".liaison-apps", "apps") },
    })
  })

  it("stops when LIAISON_APP_CATALOG_DIR names a folder without a catalog", () => {
    const res = resolveSeedAppDirs({
      env: { LIAISON_APP_CATALOG_DIR: path.join(repo, "nope") },
      repoRoot: repo,
      needsCatalog: true,
      inImage: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toStartWith("LIAISON_APP_CATALOG_DIR is ")
  })

  it("changes nothing in the image, which bakes the catalog and mounts the apps folder", () => {
    expect(
      resolveSeedAppDirs({ env: {}, repoRoot: repo, needsCatalog: true, inImage: true }),
    ).toEqual({
      ok: true,
      set: {},
    })
  })
})
