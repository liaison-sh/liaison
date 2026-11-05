// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo org must never advertise an app it does not have. `enableApp` only
// appends a name to `settings.enabledApps`: it succeeds for an app with no
// schema and no registered manifest, and the org then opens a tab whose every
// read hits a relation that does not exist.
//
// This was observed, not imagined. A seed run without a writable
// `LIAISON_APPS_DIR` failed to install all seven catalog apps and still wrote
// all thirteen into `enabledApps`, leaving an org offering invoicing, boxtal,
// shopify, social, pennylane, kpi and monitoring tabs with no `app_*` schemas
// behind any of them.

import { describe, expect, it } from "bun:test"
import { shouldEnableApp } from "~/seed/factories/org/app-enablement"

describe("enabling a seeded app", () => {
  it("does not enable a catalog app whose install failed", () => {
    expect(shouldEnableApp({ isCatalogApp: true, installed: false })).toBe(false)
  })

  it("enables a catalog app that installed", () => {
    expect(shouldEnableApp({ isCatalogApp: true, installed: true })).toBe(true)
  })

  // mail, tickets, knowledge, projects, calendar and contacts ship inside the
  // API rather than the catalog, so they are never "installed" and must still
  // enable, otherwise the demo loses the half of the product that works.
  it("enables a kernel native app, which is never installed from the catalog", () => {
    expect(shouldEnableApp({ isCatalogApp: false, installed: false })).toBe(true)
  })
})

describe("DEMO_APPS", () => {
  it("leaves out apps that need a service no demo org has (kpi, ads, calls)", async () => {
    const { DEMO_APPS } = await import("./demo-apps")
    for (const app of ["kpi", "ads", "calls"])
      expect(DEMO_APPS as readonly string[]).not.toContain(app)
  })
})
