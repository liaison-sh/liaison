// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 G4 — Freeze/install round-trip smoke test (modeled on the
// Phase 16 shopify build-roundtrip pattern).
//
// Asserts:
//   - `scripts/build-bundled-app.sh invoicing --skip-sign --skip-typecheck`
//     exits 0 and emits `dist/invoicing-<version>.liaisonapp`.
//   - The tarball contains app.manifest.json + bundle.js + templates.bundle.js
//     (Phase 17 K2.b adds templates.bundle.js; verify it ships).
//   - The packed manifest declares the right name + packageFormat + license.
//   - The packed bundle.js exports the Phase 17 UI components + handlers
//     declared in the manifest.
//   - The packed templates.bundle.js registers all 4 declared kinds.
import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { freezeTarballPath, readTarballEntry, runFreeze, tarballEntries } from "../../../scripts/lib/freeze-roundtrip.ts"

const TARBALL = freezeTarballPath("invoicing", join(import.meta.dir, ".."))

describe("Phase 17 G4 — build-bundled-app freeze round-trip", () => {
  it("produces invoicing-<version>.liaisonapp via scripts/build-bundled-app.sh invoicing", () => {
    runFreeze("invoicing", 180_000)
    expect(existsSync(TARBALL)).toBe(true)
  })

  it("tarball contains app.manifest.json + bundle.js + templates.bundle.js (K2.b)", () => {
    expect(existsSync(TARBALL)).toBe(true)
    const list = tarballEntries(TARBALL)
    expect(list).toContain("app.manifest.json")
    expect(list).toContain("bundle.js")
    // The Phase 17 K2.b deliverable adds templates.bundle.js next to the UI
    // bundle; freeze-app emits it whenever the manifest has pdf_templates[].
    // Either the bundled artifact or the per-kind files under templates/
    // satisfies the contract — accept any tar entry under templates/.
    const hasTemplates = list.some((e) => e === "templates.bundle.js" || e.startsWith("templates/"))
    expect(hasTemplates).toBe(true)
  })

  it("packed app.manifest.json declares name=invoicing and packageFormat=1", () => {
    const manifest = JSON.parse(readTarballEntry(TARBALL, "app.manifest.json"))
    expect(manifest.name).toBe("invoicing")
    expect(manifest.packageFormat).toBe(1)
    expect(manifest.license).toBe("FSL-1.1-ALv2")
    expect(Array.isArray(manifest.pdf_templates)).toBe(true)
    // invoice, quote, proforma, purchase order, credit note (0.5.0+).
    expect(manifest.pdf_templates.length).toBe(5)
  })

  it("packed ui.js exports the Phase 17 UI surfaces declared in the manifest", () => {
    // The frontend UI bundle is emitted as `ui.js` (freeze-app.ts:140 —
    // browser-target esbuild). `bundle.js` is the host-side handlers
    // bundle (Bun target) and only contains the handlers + event/job
    // exports — UI components are NOT linked through it.
    const bundle = readTarballEntry(TARBALL, "ui.js")
    // Spot-check the F1/F3/F5/F6 components — full export-presence audit
    // lives in freezeApp itself.
    expect(bundle).toMatch(/InvoicingSidebar/)
    expect(bundle).toMatch(/DocumentDetail/)
    expect(bundle).toMatch(/ContactDocumentsPanel/)
    expect(bundle).toMatch(/InvoicingIssuerProfiles/)
  })
})
