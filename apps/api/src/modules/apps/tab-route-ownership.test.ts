// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiscoveredApp } from "~/modules/apps/discover-apps"
import { installedAppsOwningTheirRoutes } from "~/modules/apps/tab-route-ownership"

const root = mkdtempSync(join(tmpdir(), "tab-routes-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function app(name: string, patterns: string[], source: DiscoveredApp["source"]): DiscoveredApp {
  const dir = join(root, source, name)
  mkdirSync(dir, { recursive: true })
  const tabTypes = Object.fromEntries(patterns.map((urlPattern, i) => [`t${i}`, { urlPattern }]))
  const manifestPath = join(dir, "app.manifest.json")
  writeFileSync(manifestPath, JSON.stringify({ name, views: { tabTypes } }))
  return { name, version: "1.0.0", manifestPath, source }
}

// An app installed before the rule existed must not keep another app's deep links at boot.
describe("the installed apps the boot registration keeps", () => {
  it("leaves out an installed app whose tab pattern is not its own", () => {
    const inTree = [app("mail", ["/mail", "/mail/:entityId"], "in-tree")]
    const kpi = app("kpi", ["/kpi", "/kpi-catalogue/:entityId+"], "installed")
    const thief = app("thief", ["/mail/:entityIdXXXXXXXX"], "installed")
    const squatter = app("squatter", ["/kpi-catalogue/:x"], "installed")
    const wildcard = app("wildcard", ["/:a/:b"], "installed")
    const page = app("page", ["/settings/:x"], "installed")
    const own = app("own", ["/own/:entityId"], "installed")
    expect(
      installedAppsOwningTheirRoutes(inTree, [kpi, thief, squatter, wildcard, page, own]).map(
        (a) => a.name,
      ),
    ).toEqual(["kpi", "own"])
  })
})
