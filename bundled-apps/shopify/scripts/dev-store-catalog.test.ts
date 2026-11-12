// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertCatalogConsistent, FICTION_CATALOG, loadDevStoreCatalog } from "./dev-store-catalog"

describe("dev-store catalog", () => {
  it("defaults to the fiction catalog, which is self-consistent", async () => {
    expect(await loadDevStoreCatalog({})).toBe(FICTION_CATALOG)
    expect(() => assertCatalogConsistent(FICTION_CATALOG)).not.toThrow()
  })

  it("loads the module LIAISON_SHOPIFY_DEV_STORE_CATALOG names", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dev-store-catalog-"))
    try {
      const file = path.join(dir, "catalog.ts")
      const own = {
        ...FICTION_CATALOG,
        secondaryLocation: { ...FICTION_CATALOG.secondaryLocation, name: "Depot" },
      }
      writeFileSync(file, `export const catalog = ${JSON.stringify(own)}\n`)
      const loaded = await loadDevStoreCatalog({ LIAISON_SHOPIFY_DEV_STORE_CATALOG: file })
      expect(loaded.secondaryLocation.name).toBe("Depot")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails loudly on a missing file or a dangling reference", async () => {
    await expect(
      loadDevStoreCatalog({ LIAISON_SHOPIFY_DEV_STORE_CATALOG: "/nonexistent/catalog.ts" }),
    ).rejects.toThrow(/no such file/)
    const dangling = {
      ...FICTION_CATALOG,
      fulfilledOrders: [{ ...FICTION_CATALOG.fulfilledOrders[0]!, productExternalId: "missing" }],
    }
    expect(() => assertCatalogConsistent(dangling)).toThrow(/unknown product missing/)
  })
})
