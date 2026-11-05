// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Permission field names from a manifest are spliced into the search filter as
// attribute names, so an entity whose names are not plain identifiers must not
// be searchable at all.
import { afterEach, describe, expect, it } from "bun:test"
import { entityRegistry } from "~/modules/apps/app-registries"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"

const ORG = "00000000-0000-0000-0000-5ea4c4000001"

function register(entity: string, dimensionFields: string[]) {
  entityRegistry.set([ORG, "fieldnames", entity], {
    labelField: "name",
    tableName: entity,
    searchable: true,
    readScope: "fieldnames:things:read",
    indexFields: { title: "name" },
    permissionFields: { readScope: "fieldnames:things:read", dimensionFields },
  } as never)
}

describe("searchable entity permission field names", () => {
  afterEach(() => {
    entityRegistry.delete([ORG, "fieldnames", "good"])
    entityRegistry.delete([ORG, "fieldnames", "bad"])
  })

  it("keeps an entity with plain identifiers and drops one whose name could rewrite the filter", () => {
    register("good", ["team"])
    register("bad", ['team EXISTS) OR (org_id = "other"'])
    const regs = collectSearchableRegistrations(ORG)
    const names = regs.entities.filter((e) => e.app === "fieldnames").map((e) => e.entityType)
    expect(names).toEqual(["good"])
    expect(regs.dimensionFields).toContain("team")
    expect(regs.dimensionFields.some((d) => d.includes("org_id"))).toBe(false)
  })
})
