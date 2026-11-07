// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { STORE_COLLECTION_PATTERN, STORE_FIELD_PATTERN } from "@liaison/app-sdk"
import { appStoreDeclarationsRegistry } from "~/modules/apps/app-registries"
import {
  AGENT_COLLECTION_DECLARATION,
  getDeclaredCollection,
  listDeclaredCollections,
} from "~/modules/data-store/declared"
import { COLLECTION_RE, FIELD_RE } from "~/modules/data-store/service"

const ORG = "00000000-0000-4000-8000-00000000d0a1"
const OTHER = "00000000-0000-4000-8000-00000000d0a2"

afterEach(() => {
  appStoreDeclarationsRegistry.deleteByPrefix([ORG])
  appStoreDeclarationsRegistry.deleteByPrefix([OTHER])
})

describe("declared store collections", () => {
  it("the SDK's name rules are the store's", () => {
    expect(STORE_COLLECTION_PATTERN.source).toBe(COLLECTION_RE.source)
    expect(STORE_FIELD_PATTERN.source).toBe(FIELD_RE.source)
  })

  it("returns an app's declaration, defaults filled, and null for an undeclared one", () => {
    appStoreDeclarationsRegistry.set([ORG, "shop"], {
      orders: {
        readScope: "shop:orders:read",
        searchable: { labelField: "title", fields: ["title", "customer"] },
        agentReadable: true,
      },
      drafts: { readScope: "shop:orders:read" },
    })
    expect(getDeclaredCollection(ORG, "shop", "orders")).toEqual({
      app: "shop",
      collection: "orders",
      readScope: "shop:orders:read",
      searchable: { labelField: "title", fields: ["title", "customer"] },
      agentReadable: true,
    })
    expect(getDeclaredCollection(ORG, "shop", "drafts")).toMatchObject({
      searchable: null,
      agentReadable: false,
    })
    expect(getDeclaredCollection(ORG, "shop", "notes")).toBeNull()
    expect(getDeclaredCollection(OTHER, "shop", "orders")).toBeNull()
    expect(getDeclaredCollection(ORG, "other", "orders")).toBeNull()
  })

  it("the agent namespace declares every valid collection with the fixed declaration", () => {
    expect(getDeclaredCollection(ORG, "agent", "notes")).toEqual({
      app: "agent",
      collection: "notes",
      readScope: "kernel:data:read",
      searchable: { labelField: "title", fields: ["title", "summary"] },
      agentReadable: true,
    })
    expect(AGENT_COLLECTION_DECLARATION.readScope).toBe("kernel:data:read")
    expect(getDeclaredCollection(ORG, "agent", "Bad-Name")).toBeNull()
  })

  it("lists one org's declarations, sorted, per app or all", () => {
    appStoreDeclarationsRegistry.set([ORG, "zeta"], { b: { readScope: "zeta:x:read" } })
    appStoreDeclarationsRegistry.set([ORG, "alpha"], {
      z: { readScope: "alpha:x:read" },
      a: { readScope: "alpha:x:read" },
    })
    appStoreDeclarationsRegistry.set([OTHER, "alpha"], { q: { readScope: "alpha:x:read" } })
    expect(listDeclaredCollections(ORG).map((d) => `${d.app}.${d.collection}`)).toEqual([
      "alpha.a",
      "alpha.z",
      "zeta.b",
    ])
    expect(listDeclaredCollections(ORG, "zeta").map((d) => d.collection)).toEqual(["b"])
    expect(listDeclaredCollections(ORG, "agent")).toEqual([])
  })
})
