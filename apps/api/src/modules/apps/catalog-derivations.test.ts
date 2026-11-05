// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The instance-wide derivations (the files SELECT policy's parents, the search
// settings and the index shape fingerprint) come from the installed catalog,
// through the same per-entity mapping an org's registration uses. A process
// that registered no org must derive exactly what one that registered every org
// derives.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { entityRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import {
  CatalogDerivationsTestAccess,
  type CatalogFileParent,
  catalogFileParents,
  catalogSearchInputs,
  manifestFileParentOf,
} from "~/modules/apps/catalog-derivations"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { searchShapeFingerprintOf, settingsInputsOf } from "~/modules/search/index-shape"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"

const ORG = "5a23d0e1-0000-4000-8000-00000000c0de"

function policyKeys(parents: CatalogFileParent[]): string[] {
  return parents
    .map((p) =>
      [p.app, p.entityType, p.schemaRef, p.tableName, p.joinOn, p.softDeleteColumn ?? ""].join("|"),
    )
    .sort()
}

function sortedInputs(i: {
  registeredReadScopes: string[]
  dimensionFields: string[]
  aclFieldNames: string[]
}) {
  return {
    registeredReadScopes: [...i.registeredReadScopes].sort(),
    dimensionFields: [...i.dimensionFields].sort(),
    aclFieldNames: [...i.aclFieldNames].sort(),
  }
}

/** A minimal manifest-shaped descriptor: only the parts the derivations read. */
function fixtureApp(
  name: string,
  entities: Record<string, unknown>,
  schema: Record<string, unknown> = {},
): AppDescriptor {
  return { name, version: "1.0.0", _format: "manifest", entities, schema }
}

describe("catalog derivations", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Catalog derivations', 'catalog-derivations-test')
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    resetAppRegistries()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("derives from the catalog exactly what one org's full registration derives", async () => {
    resetAppRegistries()
    const apps = await getDefaultApps()
    await initAppsForOrg(ORG, apps)

    const fromRegistry = CatalogDerivationsTestAccess.registryFileParents()
    const fromCatalog = catalogFileParents(apps)
    expect(fromCatalog.length).toBeGreaterThan(3)
    expect(policyKeys(fromCatalog)).toEqual(policyKeys(fromRegistry))

    const regs = collectSearchableRegistrations(ORG)
    const catalog = catalogSearchInputs(apps)
    expect(sortedInputs(catalog.settings)).toEqual(sortedInputs(settingsInputsOf(regs)))
    expect(catalog.fingerprint).toBe(searchShapeFingerprintOf(regs))
  })

  it("carries an immutable parent table's retention", () => {
    const app = fixtureApp(
      "fxretain",
      {
        record: {
          labelField: "name",
          handlePrefix: "rec",
          fileParent: {
            tableName: "records",
            schemaRef: "app_fxretain",
            joinOn: "id",
            readScope: "fxretain:records:read",
            writeScope: "fxretain:records:write",
          },
        },
      },
      { records: { fields: {}, immutable: { retentionYears: 10 } } },
    )
    const expected = { retentionYears: 10, anchor: "created_at" }
    const entity = (app.entities as Record<string, unknown>).record
    expect(manifestFileParentOf(app, entity)?.retention).toEqual(expected)
    const parent = catalogFileParents([app]).find((p) => p.app === "fxretain")
    expect(parent?.retention).toEqual(expected)
  })

  it("excludes an entity with a non-identifier ACL field, from the catalog and from a registry alike", () => {
    const entity = {
      labelField: "name",
      handlePrefix: "w",
      searchable: true,
      tableName: "widgets",
      permissionFields: {
        readScope: "fxacl:widgets:read",
        aclFields: {
          orgWideField: "org wide) OR (1=1",
          userIdsField: "acl_user_ids",
          roleIdsField: "acl_role_ids",
        },
      },
    }
    const catalog = catalogSearchInputs([fixtureApp("fxacl", { widget: entity })])
    expect(catalog.registrations.entities.some((e) => e.app === "fxacl")).toBe(false)
    expect(catalog.settings.registeredReadScopes).not.toContain("fxacl:widgets:read")
    expect(catalog.settings.aclFieldNames).not.toContain("org wide) OR (1=1")

    entityRegistry.set([ORG, "fxacl", "widget"], entity)
    try {
      const regs = collectSearchableRegistrations(ORG)
      expect(regs.entities.some((e) => e.app === "fxacl")).toBe(false)
      expect(regs.aclFieldNames).not.toContain("org wide) OR (1=1")
    } finally {
      entityRegistry.delete([ORG, "fxacl", "widget"])
    }
  })

  it("drops an app's parents when the catalog no longer holds the app", async () => {
    const apps = await getDefaultApps()
    expect(catalogFileParents(apps).some((p) => p.app === "knowledge")).toBe(true)
    const without = apps.filter((a) => a.name !== "knowledge")
    const parents = catalogFileParents(without)
    expect(parents.some((p) => p.app === "knowledge")).toBe(false)
    // The kernel's own parents stay, first.
    expect(parents.slice(0, 4).map((p) => `${p.app}:${p.entityType}`)).toEqual([
      "kernel:thread",
      "kernel:message",
      "kernel:document_template",
      "kernel:file_upload_session",
    ])
  })

  it("does not depend on the catalog's order", async () => {
    const apps = await getDefaultApps()
    const reversed = [...apps].reverse()
    expect(catalogSearchInputs(reversed).fingerprint).toBe(catalogSearchInputs(apps).fingerprint)
    expect(catalogFileParents(reversed)).toEqual(catalogFileParents(apps))
  })

  it("changes the fingerprint when one manifest's indexFields change", () => {
    const entity = (title: string) => ({
      labelField: "name",
      handlePrefix: "n",
      searchable: true,
      tableName: "notes",
      readScope: "fxshape:notes:read",
      indexFields: { title },
    })
    const a = catalogSearchInputs([fixtureApp("fxshape", { note: entity("name") })])
    const b = catalogSearchInputs([fixtureApp("fxshape", { note: entity("subject") })])
    expect(a.settings).toEqual(b.settings)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })
})
