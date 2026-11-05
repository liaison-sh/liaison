// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
// Every first-party app has a human name (STO-01): an app without a manifest
// display name is labelled from `kernel.capabilities.apps.<name>`, so a missing
// entry printed the package id ("mcp-manager") in the App store. This walks the
// in-tree and bundled app folders and requires the entry in English and French.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = resolve(__dirname, "../../../..")
/** Test scaffolding the server never loads in production (discover-apps.ts TEST_ONLY_APPS). */
const DEV_ONLY = new Set(["example", "test", "test-bridge-a", "test-bridge-b", "chaos-debug"])

function appFolders(dir: string): string[] {
  const abs = join(ROOT, dir)
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(abs, d.name, "app.manifest.json")))
    .map((d) => d.name)
    .filter((name) => !DEV_ONLY.has(name))
}

interface KernelCatalog {
  capabilities: { apps: Record<string, string> }
  nav: Record<string, unknown> & { app?: Record<string, string> }
}

function kernelCatalog(locale: "en" | "fr"): KernelCatalog {
  const file = join(ROOT, "packages/shared/src/i18n/locales", locale, "kernel.json")
  return JSON.parse(readFileSync(file, "utf8")) as KernelCatalog
}

function appLabels(locale: "en" | "fr"): Record<string, string> {
  return kernelCatalog(locale).capabilities.apps
}

describe("first-party app names", () => {
  const apps = [...appFolders("apps/api/src/apps"), ...appFolders("bundled-apps")]

  it("finds the first-party apps", () => {
    expect(apps).toContain("tickets")
    expect(apps).toContain("invoicing")
  })

  it.each(["en", "fr"] as const)("every first-party app has a %s name", (locale) => {
    const labels = appLabels(locale)
    const missing = apps.filter((name) => !labels[name]?.trim())
    expect(missing).toEqual([])
  })

  // An app reads by ONE name: its rail or settings name (`kernel.nav.<app>`,
  // `kernel.nav.app.<app>`, what the Connectors card and the app's page say)
  // is its name in the App store and the Roles table (`capabilities.apps`).
  // The database connector read "Database" on its card and "Business records"
  // in the store and its roles.
  it.each(["en", "fr"] as const)("every app has one %s name across surfaces", (locale) => {
    const catalog = kernelCatalog(locale)
    const differing = apps.flatMap((name) => {
      const own = catalog.nav[name]
      const page = typeof own === "string" ? own : catalog.nav.app?.[name]
      const listed = catalog.capabilities.apps[name]
      return page !== undefined && page !== listed ? [`${name}: "${page}" vs "${listed}"`] : []
    })
    expect(differing).toEqual([])
  })
})
