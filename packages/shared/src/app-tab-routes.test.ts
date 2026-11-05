// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  manifestTabRouteRefusal,
  manifestTabUrlPatterns,
  type TabRouteOwner,
  tabRouteRefusal,
} from "./app-tab-routes"

const mail: TabRouteOwner = {
  name: "mail",
  patterns: ["/mail", "/mail/:entityId", "/mail/compose"],
}
const kpi: TabRouteOwner = { name: "kpi", patterns: ["/kpi", "/kpi-catalogue/:entityId+"] }

describe("the tab URL patterns an app may declare", () => {
  it("refuses a leading parameter, a Liaison page route and another app's prefix", () => {
    expect(tabRouteRefusal("evil", "/:a/:b", [mail])).toBe(
      "tab urlPattern '/:a/:b' starts with a parameter: its first segment must be a fixed name the app owns (/evil/...)",
    )
    expect(tabRouteRefusal("evil", "/settings/:x", [mail])).toBe(
      "tab urlPattern '/settings/:x' is under '/settings', a Liaison page route",
    )
    expect(tabRouteRefusal("evil", "/mail/:entityIdXXXXXXXX", [mail])).toBe(
      "tab urlPattern '/mail/:entityIdXXXXXXXX' is under '/mail', which belongs to the app 'mail'",
    )
    // Another app's own non-name prefix is that app's too.
    expect(tabRouteRefusal("evil", "/kpi-catalogue/:x", [kpi])).toBe(
      "tab urlPattern '/kpi-catalogue/:x' is under '/kpi-catalogue', which belongs to the app 'kpi'",
    )
    expect(tabRouteRefusal("evil", "/", [])).not.toBeNull()
    expect(tabRouteRefusal("evil", "evil/x", [])).not.toBeNull()
  })

  it("allows the app's own name and a prefix no other app owns", () => {
    expect(tabRouteRefusal("kpi", "/kpi-catalogue/:entityId+", [mail])).toBeNull()
    expect(tabRouteRefusal("kpi", "/kpi/metrics/:id", [mail, kpi])).toBeNull()
    expect(manifestTabRouteRefusal("kpi", { views: { tabTypes: { a: {} } } }, [mail])).toBeNull()
    expect(manifestTabUrlPatterns("kpi", { views: { tabTypes: { a: {} } } })).toEqual([
      "/kpi/a/:entityId",
    ])
  })
})

describe("every app manifest in the repository", () => {
  const root = join(import.meta.dir, "../../..")
  const dirs = [
    "apps/api/src/apps",
    "apps/api/test-support/apps",
    "bundled-apps",
    "apps/web/src/tests/e2e/outside-app",
  ]
  const apps: Array<{ name: string; manifest: unknown }> = []
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(root, dir, entry, "app.manifest.json")
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { name: string }
      apps.push({ name: manifest.name, manifest })
    }
  }
  // A fork's KPI app keeps its catalogue under a prefix of its own beside `/kpi`.
  apps.push({
    name: "kpi",
    manifest: {
      views: {
        tabTypes: {
          home: { urlPattern: "/kpi" },
          definitions: { urlPattern: "/kpi-catalogue/:entityId+" },
        },
      },
    },
  })
  const owners = apps.map((a) => ({
    name: a.name,
    patterns: manifestTabUrlPatterns(a.name, a.manifest),
  }))

  it("finds the in-tree and bundled apps", () => {
    expect(apps.map((a) => a.name)).toEqual(
      expect.arrayContaining(["mail", "tickets", "invoicing"]),
    )
  })

  it("declares only tab patterns its own", () => {
    const refusals = apps
      .map((a) => [a.name, manifestTabRouteRefusal(a.name, a.manifest, owners)] as const)
      .filter(([, refusal]) => refusal !== null)
    expect(refusals).toEqual([])
  })
})
