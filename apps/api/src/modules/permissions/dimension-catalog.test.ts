// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { dimensionDefRegistry } from "~/modules/apps/app-registries"
import {
  findDimensionEntry,
  getDimensionCatalog,
  invalidateDimensionCatalog,
} from "~/modules/permissions/dimension-catalog"

const ORG = "00000000-0000-4000-8000-000000000011"
const OTHER_ORG = "00000000-0000-4000-8000-000000000012"

describe("dimension catalog", () => {
  beforeEach(() => {
    dimensionDefRegistry.deleteByPrefix([ORG])
    dimensionDefRegistry.deleteByPrefix([OTHER_ORG])
    // The kernel-global "*"-scoped dims (e.g. kernel:skills_domain) are registered
    // at kernel-tool registration and leak into every org's catalog by design;
    // clear them too so this catalog-isolation suite sees only its own fixtures.
    dimensionDefRegistry.deleteByPrefix(["*"])
    invalidateDimensionCatalog()
  })

  afterEach(() => {
    dimensionDefRegistry.deleteByPrefix([ORG])
    dimensionDefRegistry.deleteByPrefix([OTHER_ORG])
    dimensionDefRegistry.deleteByPrefix(["*"])
    invalidateDimensionCatalog()
  })

  it("returns membership dimensions with their type", () => {
    dimensionDefRegistry.set([ORG, "tickets", "team"], { type: "membership" })
    const catalog = getDimensionCatalog(ORG)
    const team = catalog.find((d) => d.key === "tickets:team")
    expect(team).toBeDefined()
    expect(team?.type).toBe("membership")
    expect(team?.app).toBe("tickets")
    expect(team?.values).toBeUndefined()
    expect(team?.order).toBeUndefined()
  })

  it("returns level dimensions with their declared order", () => {
    dimensionDefRegistry.set([ORG, "tickets", "sensitivity"], {
      type: "level",
      order: ["internal", "confidential", "restricted"],
    })
    const sensitivity = findDimensionEntry(ORG, "tickets:sensitivity")
    expect(sensitivity).toBeDefined()
    expect(sensitivity?.type).toBe("level")
    expect(sensitivity?.order).toEqual(["internal", "confidential", "restricted"])
  })

  it("returns enum dimensions with their declared values", () => {
    dimensionDefRegistry.set([ORG, "projects", "region"], {
      type: "enum",
      values: ["eu", "na", "apac"],
    })
    const region = findDimensionEntry(ORG, "projects:region")
    expect(region?.values).toEqual(["eu", "na", "apac"])
  })

  it("does not leak dimensions from another org", () => {
    dimensionDefRegistry.set([OTHER_ORG, "tickets", "team"], { type: "membership" })
    const catalog = getDimensionCatalog(ORG)
    expect(catalog.map((d) => d.key)).not.toContain("tickets:team")
  })

  it("orders results by app, then by key", () => {
    dimensionDefRegistry.set([ORG, "tickets", "team"], { type: "membership" })
    dimensionDefRegistry.set([ORG, "projects", "region"], { type: "enum", values: ["eu"] })
    dimensionDefRegistry.set([ORG, "tickets", "sensitivity"], { type: "level", order: ["a"] })
    const keys = getDimensionCatalog(ORG).map((d) => d.key)
    expect(keys).toEqual(["projects:region", "tickets:sensitivity", "tickets:team"])
  })

  it("cache invalidates per-org so newly registered dimensions appear", () => {
    expect(getDimensionCatalog(ORG)).toEqual([])
    dimensionDefRegistry.set([ORG, "tickets", "team"], { type: "membership" })
    invalidateDimensionCatalog(ORG)
    expect(getDimensionCatalog(ORG).map((d) => d.key)).toContain("tickets:team")
  })

  it("invalidateDimensionCatalog() with no args clears all orgs", () => {
    dimensionDefRegistry.set([ORG, "a", "x"], { type: "membership" })
    getDimensionCatalog(ORG)
    getDimensionCatalog(OTHER_ORG)
    invalidateDimensionCatalog()
    dimensionDefRegistry.set([OTHER_ORG, "b", "y"], { type: "membership" })
    expect(getDimensionCatalog(OTHER_ORG).map((d) => d.key)).toContain("b:y")
  })
})
