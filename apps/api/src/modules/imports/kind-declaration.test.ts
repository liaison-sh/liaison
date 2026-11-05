// SPDX-License-Identifier: FSL-1.1-ALv2
// The manifest `import` key (P3a T2): the shape and cross-field rules a kind
// declaration must satisfy, and registration into the import registry.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { importRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps } from "~/modules/apps/runtime"
import { importTableErrors } from "~/modules/imports/kind-schema"
import { listImportKinds } from "~/modules/imports/kinds"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function kind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: {
      type: "object",
      required: ["ref", "title"],
      properties: { ref: { type: "string" }, title: { type: "string" }, team: { type: "string" } },
    },
    handler: "importWidget",
    dedupKey: "ref",
    tables: ["app_importfixture.widgets"],
    writeScopes: ["importfixture:widgets:write"],
    ...overrides,
  }
}

function manifest(kinds: Record<string, unknown>): Record<string, unknown> {
  return { name: "importfixture", version: "1.0.0", import: { kinds } }
}

function errorOf(m: Record<string, unknown>): string {
  const r = validateAppManifest(m)
  expect(r.success).toBe(false)
  return r.error ?? ""
}

describe("manifest import key: validation", () => {
  it("accepts a complete kind", () => {
    const r = validateAppManifest(manifest({ widget: kind() }))
    expect(r.error).toBeUndefined()
    expect(r.success).toBe(true)
  })

  it("rejects a kind without a dedup key", () => {
    const { dedupKey: _drop, ...rest } = kind()
    expect(errorOf(manifest({ widget: rest }))).toMatch(/dedupKey/)
  })

  it("rejects a kind without tables", () => {
    const { tables: _drop, ...rest } = kind()
    expect(errorOf(manifest({ widget: rest }))).toMatch(/tables/)
  })

  it("rejects a kind without write scopes", () => {
    const { writeScopes: _drop, ...rest } = kind()
    expect(errorOf(manifest({ widget: rest }))).toMatch(/writeScopes/)
  })

  it("rejects a record schema that is not an object schema", () => {
    expect(
      errorOf(manifest({ widget: kind({ schema: { type: "array", items: { type: "string" } } }) })),
    ).toMatch(/object schema/)
  })

  it("rejects a dedup key that is not a top-level string property", () => {
    expect(errorOf(manifest({ widget: kind({ dedupKey: "missing" }) }))).toMatch(
      /dedupKey: "missing"/,
    )
  })

  it("rejects a dedup key the schema does not require", () => {
    expect(errorOf(manifest({ widget: kind({ dedupKey: "team" }) }))).toMatch(/schema\.required/)
  })

  it("rejects a dimension field that is not in the schema", () => {
    expect(
      errorOf(
        manifest({ widget: kind({ dimension: { field: "region", dimension: "x:region" } }) }),
      ),
    ).toMatch(/dimension\.field/)
  })

  it("rejects a parent that is not a sibling kind", () => {
    expect(errorOf(manifest({ widget: kind({ parent: "gadget" }) }))).toMatch(/parent/)
  })

  it("rejects an unknown property on a kind", () => {
    expect(errorOf(manifest({ widget: kind({ surprise: true }) }))).toMatch(/surprise/)
  })

  it("rejects a table outside the app's schema and a non-allowlisted kernel table", () => {
    expect(errorOf(manifest({ widget: kind({ tables: ["kernel.organizations"] }) }))).toMatch(
      /kernel\.organizations/,
    )
    expect(errorOf(manifest({ widget: kind({ tables: ["app_tickets.tickets"] }) }))).toMatch(
      /outside the app's own schema/,
    )
  })

  it("an installed app's kind may not write an allowlisted kernel table either", () => {
    expect(
      importTableErrors("importfixture", "widget", ["kernel.contacts"], { builtin: false }),
    ).toEqual([
      'import.kinds.widget.tables: "kernel.contacts" may only be written by a built-in app\'s kind',
    ])
    expect(
      importTableErrors("importfixture", "widget", ["kernel.contacts"], { builtin: true }),
    ).toEqual([])
  })

  it("accepts rollupTables that are among the kind's tables", () => {
    const r = validateAppManifest(
      manifest({ widget: kind({ rollupTables: ["app_importfixture.widgets"] }) }),
    )
    expect(r.error).toBeUndefined()
    expect(r.success).toBe(true)
  })

  it("rejects rollupTables that are not among the kind's tables", () => {
    expect(
      errorOf(manifest({ widget: kind({ rollupTables: ["app_importfixture.gadgets"] }) })),
    ).toMatch(/rollupTables: "app_importfixture\.gadgets" is not one of the kind's tables/)
  })

  it("rejects an empty kinds map", () => {
    expect(errorOf(manifest({}))).toMatch(/kinds/)
  })
})

describe("manifest import key: registration", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("a valid declaration registers and listImportKinds returns it", async () => {
    const { orgId } = await ensureOrg({
      slug: `import-decl-${crypto.randomUUID().slice(0, 10)}`,
      name: "Import Decl Org",
    })
    await registerApps(
      [
        {
          ...manifest({ widget: kind({ label: "Widget" }) }),
          name: "importfixture",
          version: "1.0.0",
          _format: "manifest",
        },
      ],
      orgId,
    )
    expect(importRegistry.get([orgId, "importfixture"])?.kinds.widget?.dedupKey).toBe("ref")
    const kinds = await listImportKinds(orgId)
    const widget = kinds.find((k) => k.kind === "importfixture.widget")
    expect(widget).toBeDefined()
    expect(widget?.app).toBe("importfixture")
    expect(widget?.decl.writeScopes).toEqual(["importfixture:widgets:write"])
  })
})

describe("manifest import key: registration refuses an installed app's kernel table", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("a non-built-in kind naming kernel.contacts, or declaring rollupTables, is not registered", async () => {
    const { orgId } = await ensureOrg({
      slug: `import-decl-k-${crypto.randomUUID().slice(0, 10)}`,
      name: "Import Decl Org K",
    })
    await registerApps(
      [
        {
          ...manifest({
            widget: kind(),
            people: kind({ tables: ["kernel.contacts"] }),
            // Roll-up tables are for built-in kinds only.
            counted: kind({ rollupTables: ["app_importfixture.widgets"] }),
          }),
          name: "importfixture",
          version: "1.0.0",
          _format: "manifest",
        },
      ],
      orgId,
    )
    const kinds = importRegistry.get([orgId, "importfixture"])?.kinds ?? {}
    expect(Object.keys(kinds)).toEqual(["widget"])
  })
})
