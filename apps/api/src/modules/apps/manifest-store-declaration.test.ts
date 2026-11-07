// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The manifest `store` declaration (@liaison/app-sdk app-store.ts): the runtime
// manifest validator, the descriptor validator and the package schema accept
// the same declarations and refuse the same mistakes.
import { describe, expect, it } from "bun:test"
import { packageManifestSchema } from "@liaison/app-sdk"
import { validateAppDescriptor, validateAppManifest } from "~/modules/apps/contract"

const base = {
  name: "shop",
  version: "1.0.0",
  scopes: ["shop:orders"],
  tools: {
    list: {
      description: "List",
      handler: "list",
      requiredScopes: ["shop:orders:read"],
      readOnly: true,
    },
  },
}

const withStore = (store: unknown) => ({ ...base, store })
/** The in-tree descriptor form: handlers are functions. */
const descriptor = (store: unknown) => ({
  ...base,
  tools: { list: { ...base.tools.list, handler: async () => null } },
  store,
})

function packageErrors(m: Record<string, unknown>): string {
  const r = packageManifestSchema.safeParse({ ...m, packageFormat: 1, license: "MIT" })
  return r.success ? "" : r.error.issues.map((i) => i.message).join("; ")
}

const good = {
  collections: {
    orders: {
      readScope: "shop:orders:read",
      searchable: { labelField: "title", fields: ["title", "customer_name"] },
      agentReadable: true,
    },
    drafts: { readScope: "shop:orders" },
  },
}

describe("manifest store declaration", () => {
  it("accepts collections whose readScope is a declared scope or a tool's required scope", () => {
    expect(validateAppManifest(withStore(good))).toMatchObject({ success: true })
    expect(validateAppDescriptor(descriptor(good))).toMatchObject({ success: true })
    expect(packageErrors(withStore(good))).toBe("")
    expect(
      packageManifestSchema.parse({ ...withStore(good), packageFormat: 1, license: "MIT" }).store,
    ).toEqual(good)
  })

  it("refuses a readScope the app does not declare", () => {
    const m = withStore({ collections: { orders: { readScope: "shop:secret:read" } } })
    expect(validateAppManifest(m).error ?? "").toMatch(/not a scope this app declares/)
    expect(validateAppDescriptor(descriptor(m.store)).error ?? "").toMatch(
      /not a scope this app declares/,
    )
    expect(packageErrors(m)).toMatch(/not a scope this app declares/)
  })

  it("refuses a readScope in another namespace (a kernel scope too)", () => {
    for (const readScope of ["kernel:data:read", "other:orders:read"]) {
      const m = withStore({ collections: { orders: { readScope } } })
      expect(validateAppManifest(m).error ?? "").toMatch(/own scopes/)
      expect(packageErrors(m)).toMatch(/own scopes/)
    }
  })

  it("refuses a bad collection name, field name or empty field list", () => {
    const cases: unknown[] = [
      { collections: { "Bad-Name": { readScope: "shop:orders:read" } } },
      {
        collections: {
          orders: {
            readScope: "shop:orders:read",
            searchable: { labelField: "a b", fields: ["a"] },
          },
        },
      },
      {
        collections: {
          orders: {
            readScope: "shop:orders:read",
            searchable: { labelField: "a", fields: ["x;drop"] },
          },
        },
      },
      {
        collections: {
          orders: { readScope: "shop:orders:read", searchable: { labelField: "a", fields: [] } },
        },
      },
      { collections: { orders: { readScope: "shop:orders:read", extra: true } } },
      { collections: { orders: {} } },
      { tables: {} },
    ]
    for (const store of cases) {
      const m = withStore(store)
      expect(validateAppManifest(m).success).toBe(false)
      expect(validateAppDescriptor(descriptor(store)).success).toBe(false)
      expect(packageErrors(m)).not.toBe("")
    }
  })
})
