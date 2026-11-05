// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build/freeze round-trip smoke test.
//
// Verifies the freeze step produces a `.liaisonapp` tarball containing the
// required artifacts by invoking
// `liaison/scripts/build-bundled-app.sh ads --skip-sign --skip-typecheck`.
import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { freezeTarballPath, readTarballEntry, runFreeze, tarballEntries } from "../../../scripts/lib/freeze-roundtrip.ts"

const TARBALL = freezeTarballPath("ads", join(import.meta.dir, ".."))

describe("ads build-bundled-app freeze round-trip", () => {
  it("produces ads-<version>.liaisonapp via scripts/build-bundled-app.sh", () => {
    runFreeze("ads", 120_000)
    expect(existsSync(TARBALL)).toBe(true)
  })

  it("tarball contains app.manifest.json and bundle.js", () => {
    expect(existsSync(TARBALL)).toBe(true)
    const list = tarballEntries(TARBALL)
    expect(list).toContain("app.manifest.json")
    expect(list).toContain("bundle.js")
  })

  it("packed app.manifest.json declares name=ads, packageFormat=1, license=FSL-1.1-ALv2", () => {
    const manifest = JSON.parse(readTarballEntry(TARBALL, "app.manifest.json"))
    expect(manifest.name).toBe("ads")
    expect(manifest.packageFormat).toBe(1)
    expect(manifest.license).toBe("FSL-1.1-ALv2")
  })

  it("packed bundle.js exports pause and create_campaign", () => {
    const bundle = readTarballEntry(TARBALL, "bundle.js")
    // Spot-check canonical exports — proves the bundle isn't empty
    expect(bundle).toMatch(/create_campaign/)
    expect(bundle).toMatch(/summarizePause/)
  })
})
