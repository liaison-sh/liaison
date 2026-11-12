// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * L2: an org section that holds only a connections block and names no
 * adminScope is administered by the scope the server enforces on those
 * connections (connections/admin-scope.ts: the manifest's, else
 * `<app>:accounts:admin`), not the generic kernel:apps:admin. Otherwise a holder
 * of the connection's scope alone could act through the API and see no card.
 */
import { describe, expect, test } from "bun:test"
import { appSettingsSchema } from "@liaison/app-sdk"
import databaseManifest from "../../../../../bundled-apps/database/app.manifest.json"
import monitoringManifest from "../../../../../bundled-apps/monitoring/app.manifest.json"
import shopifyManifest from "../../../../../bundled-apps/shopify/app.manifest.json"
import { materialiseSections } from "./settings-schema-from-manifest"

type Manifest = { name: string; settings?: unknown; connections?: unknown }

function sectionsOf(m: Manifest) {
  return materialiseSections(appSettingsSchema.parse(m.settings), {
    app: m.name,
    connections: m.connections as Record<string, { adminScope?: string }> | undefined,
  })
}

describe("materialiseSections: connection sections take the connection's admin scope", () => {
  test.each([
    [databaseManifest as Manifest, "connection", "database:accounts:admin"],
    [monitoringManifest as Manifest, "alert-source", "monitoring:accounts:admin"],
  ])("connections section %# takes its connection's scope", (manifest, sectionId, scope) => {
    const s = sectionsOf(manifest).find((x) => x.id === sectionId)
    expect(s?.adminScope).toBe(scope)
  })

  test("shopify's connection section also holds the full order history toggle: the default", () => {
    const s = sectionsOf(shopifyManifest as Manifest).find((x) => x.id === "connection")
    expect(s?.blocks.some((b) => b.block === "field")).toBe(true)
    expect(s?.adminScope).toBe("kernel:apps:admin")
  })

  test("a declared connection adminScope wins; a section with fields keeps the default", () => {
    const sections = materialiseSections(
      appSettingsSchema.parse({
        sections: [
          { id: "c", title: "C", scope: "org", blocks: [{ block: "connections" }] },
          {
            id: "f",
            title: "F",
            scope: "org",
            blocks: [
              { block: "connections" },
              { block: "field", key: "x", type: "text", label: "X" },
            ],
          },
        ],
      }),
      { app: "acme", connections: { api: { adminScope: "acme:api:admin" } } },
    )
    expect(sections.find((s) => s.id === "c")?.adminScope).toBe("acme:api:admin")
    expect(sections.find((s) => s.id === "f")?.adminScope).toBe("kernel:apps:admin")
  })

  test("connections with different admin scopes leave the default", () => {
    const sections = materialiseSections(
      appSettingsSchema.parse({
        sections: [{ id: "c", title: "C", scope: "org", blocks: [{ block: "connections" }] }],
      }),
      { app: "acme", connections: { a: { adminScope: "acme:a:admin" }, b: {} } },
    )
    expect(sections[0]?.adminScope).toBe("kernel:apps:admin")
  })
})
