// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S4 — Catalog CRUD + resolver pre-fill (tool + UI).
//
// The catalog rows (shipping_profile / pack / pack_component / local_product)
// feed the package resolver + customs assembly. This scenario proves the CRUD
// round-trip end-to-end against the real kernel:
//   - product_profile_upsert persists a profile with unit_weight + solo dims +
//     content_category; packages_list reflects it.
//   - pack_upsert persists a named pack with a component multiset; packages_list
//     reflects the pack + its components.
//   - a pack referencing a product that has NO profile is flagged `stale:true`
//     (the resolver must not silently match a deleted/unknown ref).
//   - pack_delete removes the pack.
//   - the Catalog UI renders the persisted profiles + packs.
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { assertBoxtalBundle, BOXTAL_BUNDLE, expect, test } from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

interface PackagesList {
  profiles: Array<Record<string, unknown>>
  packs: Array<{
    id: string
    name: string
    gross_weight: number
    stale: boolean
    components: Array<{ product_source: string; product_id: string; quantity: number }>
  }>
  local_products: Array<Record<string, unknown>>
}

async function callTool(
  serverUrl: string,
  token: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await api(serverUrl, `/api/apps/boxtal/tools/${tool}`, {
    method: "POST",
    token,
    body: { params },
  })
  if (resp.status !== 200) {
    throw new Error(`${tool}: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return unwrap(resp.body)
}

async function listPackages(serverUrl: string, token: string): Promise<PackagesList> {
  return (await callTool(serverUrl, token, "packages_list", {})) as unknown as PackagesList
}

test.describe("Boxtal: catalog CRUD + resolver", () => {
  test("profile/pack/local CRUD round-trips; missing-ref pack is stale; delete removes it", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    const s = env.serverUrl

    // Fresh install: catalog is empty.
    const empty = await listPackages(s, token)
    expect(empty.profiles).toEqual([])
    expect(empty.packs).toEqual([])

    // 1. Upsert a profiled product (unit_weight + solo dims + content_category).
    const prof = await callTool(s, token, "product_profile_upsert", {
      product_source: "shopify",
      product_id: "SKU-WIDGET",
      unit_weight: 0.45,
      solo_length: 20,
      solo_width: 15,
      solo_height: 10,
      content_category: "content:v1:10120",
    })
    expect(prof.id).toBeTruthy()

    // 2. A pack with a component bill referencing the profiled product.
    const pack = await callTool(s, token, "pack_upsert", {
      name: "Carton A",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 1.2,
      content_category: "content:v1:10120",
      components: [{ product_source: "shopify", product_id: "SKU-WIDGET", quantity: 2 }],
    })
    expect(pack.id).toBeTruthy()

    // 3. A local product.
    const local = await callTool(s, token, "local_product_upsert", {
      sku: "LOCAL-1",
      label: "Hand-made box",
    })
    expect(local.id).toBeTruthy()

    // packages_list reflects each upsert — assert the round-trip VALUES.
    const afterUpsert = await listPackages(s, token)
    expect(afterUpsert.profiles.length).toBe(1)
    const p0 = afterUpsert.profiles[0]
    expect(p0.product_id).toBe("SKU-WIDGET")
    expect(Number(p0.unit_weight)).toBeCloseTo(0.45, 3)

    expect(afterUpsert.packs.length).toBe(1)
    const pk0 = afterUpsert.packs[0]
    expect(pk0.name).toBe("Carton A")
    expect(Number(pk0.gross_weight)).toBeCloseTo(1.2, 3)
    // The component multiset round-trips (one component, quantity 2).
    expect(pk0.components.length).toBe(1)
    expect(pk0.components[0].product_id).toBe("SKU-WIDGET")
    expect(pk0.components[0].quantity).toBe(2)
    // The referenced product HAS a profile → not stale.
    expect(pk0.stale).toBe(false)

    expect(afterUpsert.local_products.length).toBe(1)
    expect(afterUpsert.local_products[0].sku).toBe("LOCAL-1")

    // 4. A pack referencing a product with NO profile is flagged stale.
    const stalePack = await callTool(s, token, "pack_upsert", {
      name: "Carton B",
      length: 50,
      width: 40,
      height: 30,
      gross_weight: 2.0,
      components: [{ product_source: "shopify", product_id: "SKU-MISSING", quantity: 1 }],
    })
    expect(stalePack.id).toBeTruthy()
    const withStale = await listPackages(s, token)
    const cartonB = withStale.packs.find((p) => p.name === "Carton B")
    expect(cartonB).toBeTruthy()
    expect(cartonB?.stale).toBe(true)
    // Carton A still not stale (its ref is profiled).
    const cartonA = withStale.packs.find((p) => p.name === "Carton A")
    expect(cartonA?.stale).toBe(false)

    // 5. delete removes the pack (and the resolver no longer sees it).
    await callTool(s, token, "pack_delete", { id: (cartonB as { id: string }).id })
    const afterDelete = await listPackages(s, token)
    expect(afterDelete.packs.find((p) => p.name === "Carton B")).toBeUndefined()
    expect(afterDelete.packs.length).toBe(1)
  })

  test("UI: the catalog surface renders the persisted profiles + packs", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    await resetMock(env.serverUrl, token)
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    const s = env.serverUrl

    // Seed catalog rows before the page loads.
    await callTool(s, token, "product_profile_upsert", {
      product_source: "shopify",
      product_id: "SKU-UIWIDGET",
      unit_weight: 0.6,
      solo_length: 22,
      solo_width: 16,
      solo_height: 11,
    })
    await callTool(s, token, "pack_upsert", {
      name: "UI Carton",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 1.5,
      components: [{ product_source: "shopify", product_id: "SKU-UIWIDGET", quantity: 1 }],
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/catalog`)
    await page.waitForLoadState("networkidle")

    const catalog = page.locator('[data-testid="boxtal-catalog"]')
    await expect(catalog).toBeVisible({ timeout: 15_000 })
    // The seeded profile + pack render their identifying text. formatWeight
    // (kit.tsx) renders sub-kg in grams and >=1kg in kg, so 0.6 → "600 g",
    // 1.5 → "1.5 kg" (the prior "0.6 kg" expectation was stale).
    await expect(catalog).toContainText("SKU-UIWIDGET")
    await expect(catalog).toContainText("600 g")
    await expect(catalog).toContainText("UI Carton")
    await expect(catalog).toContainText("1.5 kg")
  })
})
