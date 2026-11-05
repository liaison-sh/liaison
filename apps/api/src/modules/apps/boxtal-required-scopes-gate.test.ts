// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The real boxtal manifest's multi-scope tool reaches buildToolSet's gate.
// runtime-manifest.test.ts proves registerApps copies a manifest tool's
// requiredScopes onto its registry entry; this file feeds the shipped boxtal
// create_shipment entry through the same fields and asserts the catalog gate:
// an actor holding only one of its two grants never sees the tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { UserContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"

const ORG = "00000000-0000-0000-0000-000000b0a701"
const MANIFEST_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "boxtal",
  "app.manifest.json",
)

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
const tool = manifest.tools.create_shipment

const actorWith = (scopes: string[]): UserContext => ({
  actorType: "user",
  userId: "00000000-0000-0000-0000-000000b0a702",
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

const catalog = (scopes: string[]) =>
  Object.keys(buildToolSet(ORG, actorWith(scopes), undefined, ALL_DEFERRED_TOOLS_UNLOCKED))

describe("boxtal create_shipment: requiredScopes gate the agent catalog", () => {
  beforeAll(() => {
    // The same fields registerSingleApp projects from a manifest tool.
    toolRegistry.set([ORG, "boxtal", "create_shipment"], {
      appName: "boxtal",
      name: "create_shipment",
      description: tool.description,
      requiredScopes: tool.requiredScopes,
      gated: tool.gated,
      readOnly: tool.readOnly,
      handler: async () => ({ ok: true }),
    } as any)
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([ORG])
  })

  it("the shipped manifest is valid for the runtime", () => {
    expect(validateAppManifest(manifest).error ?? null).toBeNull()
  })

  it("excludes create_shipment for an actor holding only one of its two scopes", () => {
    expect(catalog(["boxtal:shipments:write"])).not.toContain("boxtal__create_shipment")
    expect(catalog(["boxtal:quotes:read"])).not.toContain("boxtal__create_shipment")
  })

  it("includes create_shipment for an actor holding both scopes", () => {
    expect(catalog(["boxtal:shipments:write", "boxtal:quotes:read"])).toContain(
      "boxtal__create_shipment",
    )
  })
})
