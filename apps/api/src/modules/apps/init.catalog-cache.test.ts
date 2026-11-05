// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { discoverInTreeApps } from "~/modules/apps/discover-apps"
import { GetDefaultAppsTestAccess, getDefaultApps } from "~/modules/apps/init"

describe("getDefaultApps: cached per catalog generation", () => {
  beforeEach(() => {
    bumpCatalogGeneration()
    GetDefaultAppsTestAccess.resetStats()
  })

  it("returns equal, non-identical descriptors: mutating one leaves the next call intact", async () => {
    const first = await getDefaultApps()
    const second = await getDefaultApps()
    expect(second.map((a) => a.name)).toEqual(first.map((a) => a.name))
    const a = first.find((d) => d.schema && Object.keys(d.schema).length > 0)
    expect(a).toBeDefined()
    const b = second.find((d) => d.name === a?.name)
    expect(b).not.toBe(a)
    expect(b?.schema).not.toBe(a?.schema)
    expect(b?.schema).toEqual(a?.schema)
    // The freshManifest regression: a registration mutating its descriptor.
    const entity = Object.keys(a?.schema ?? {})[0] as string
    ;(a?.schema as Record<string, unknown>)[entity] = "corrupted"
    const third = await getDefaultApps()
    const c = third.find((d) => d.name === a?.name)
    expect(c?.schema?.[entity]).not.toBe("corrupted")
    expect(c?.schema).toEqual(b?.schema)
  })

  it("100 org setups read each manifest file once", async () => {
    const inTree = (await discoverInTreeApps()).filter((a) => a.descriptorPath)
    await Promise.all(Array.from({ length: 100 }, () => getDefaultApps()))
    const stats = GetDefaultAppsTestAccess.stats()
    expect(stats.builds).toBe(1)
    expect(stats.manifestReads).toBe(inTree.length)
  })

  it("a generation bump (activation, install, announced change) makes the next call read again", async () => {
    await getDefaultApps()
    await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().builds).toBe(1)
    bumpCatalogGeneration()
    await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().builds).toBe(2)
  })

  it("vouches the installed apps once per generation", async () => {
    for (let i = 0; i < 5; i++) await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().voucherRuns).toBe(1)
    bumpCatalogGeneration()
    for (let i = 0; i < 5; i++) await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().voucherRuns).toBe(2)
  })
})

describe("getDefaultApps: a catalog built from a fallback is not cached", () => {
  const savedRoot = process.env.LIAISON_APPS_DIR
  let root: string

  beforeEach(() => {
    // One installed app on disk, so the catalog reads its active version and install row.
    root = mkdtempSync(join(tmpdir(), "catalog-fallback-"))
    const dir = join(root, "fallbackprobe", "1.0.0")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "app.manifest.json"),
      JSON.stringify({ name: "fallbackprobe", version: "1.0.0", _format: "manifest" }),
    )
    writeFileSync(join(dir, "bundle.js"), "")
    process.env.LIAISON_APPS_DIR = root
    bumpCatalogGeneration()
    GetDefaultAppsTestAccess.resetStats()
  })
  afterEach(() => {
    GetDefaultAppsTestAccess.failCatalogDbReads(false)
    if (savedRoot === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = savedRoot
    rmSync(root, { recursive: true, force: true })
    bumpCatalogGeneration()
  })

  it("a database blip during the build serves that call, and the next call reads again", async () => {
    GetDefaultAppsTestAccess.failCatalogDbReads(true)
    const degraded = await getDefaultApps()
    // The fallback still registers the installed app (its newest version).
    expect(degraded.some((a) => a.name === "fallbackprobe")).toBe(true)
    await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().builds).toBe(2)

    GetDefaultAppsTestAccess.failCatalogDbReads(false)
    await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().builds).toBe(3)
    // A build whose reads all succeeded is kept for the generation.
    await getDefaultApps()
    expect(GetDefaultAppsTestAccess.stats().builds).toBe(3)
  })
})
