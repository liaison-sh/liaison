// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task B17 — Freeze/install round-trip smoke test.
//
// Verifies validation 10.1 (the freeze step produces a `.liaisonapp` tarball
// containing the required artifacts) by invoking
// `liaison/scripts/build-bundled-app.sh shopify --skip-sign --skip-typecheck`.
//
// Sign (cosign) and dev-stack `/api/apps/install` POST require interactive /
// running-stack infrastructure that the unit suite cannot provide; the build
// script is otherwise the canonical entry point used by humans + CI.
import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { freezeTarballPath, readTarballEntry, runFreeze, tarballEntries } from "../../../scripts/lib/freeze-roundtrip.ts"

const TARBALL = freezeTarballPath("shopify", join(import.meta.dir, ".."))

describe("Phase 16 Task B17 — build-bundled-app freeze round-trip", () => {
  it("produces shopify-<version>.liaisonapp via scripts/build-bundled-app.sh shopify --skip-sign", () => {
    runFreeze("shopify", 120_000)
    expect(existsSync(TARBALL)).toBe(true)
  })

  it("tarball contains app.manifest.json and bundle.js (validation 10.1)", () => {
    expect(existsSync(TARBALL)).toBe(true)
    const list = tarballEntries(TARBALL)
    expect(list).toContain("app.manifest.json")
    expect(list).toContain("bundle.js")
  })

  it("packed app.manifest.json declares name=shopify and packageFormat=1", () => {
    const manifest = JSON.parse(readTarballEntry(TARBALL, "app.manifest.json"))
    expect(manifest.name).toBe("shopify")
    expect(manifest.packageFormat).toBe(1)
    expect(manifest.license).toBe("FSL-1.1-ALv2")
  })

  it("packed bundle.js exports the webhook handlers + verifier declared in the manifest", () => {
    const bundle = readTarballEntry(TARBALL, "bundle.js")
    // Pin a few canonical exports — the full export-presence audit is
    // performed by freezeApp itself (Task A6); we just spot-check a couple
    // so the round-trip suite fails loud if the bundle ever ships empty.
    expect(bundle).toMatch(/shopifyWebhookVerifier/)
    expect(bundle).toMatch(/ordersCreate/i)
  })
})
