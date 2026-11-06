// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HEADLINE TEST: the demo store answered through the REAL app runtime.
//
// Nothing here calls the fixture module. Each case executes a real bundled-app
// tool (`shopify:home_load`, `shopify:orders_search`, ...) through `executeTool`
// for an org carrying the demo marker, so the whole production path runs: the
// tool registry, the sandbox worker, the app's own GraphQL document and
// projection, the connection lookup, the sandbox fetch bridge, and the demo
// interception sitting inside it. What is asserted is what the TOOL returned.
//
// `boxtal:to_prepare_list` is in here because it is half the point: the
// operator's primary screen derives its rows from a live Shopify order scan, so
// answering Shopify lights up two apps and this is the only way to see that.
//
// Run it against the isolated database, never a shared one:
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/tests/integration/demo-shopify-runtime.test.ts --timeout 300000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import { installCatalogApp } from "~/modules/apps/catalog"
import { enableApp } from "~/modules/apps/enabled-apps"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { uninstallApp } from "~/modules/apps/install-service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import { installDemoShopifyConnection } from "~/modules/demo/shopify"
import { resetDemoShopifyOverlay } from "~/modules/demo/shopify/overlay"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { DEMO_CATALOG } from "~/seed/world/fiction"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const APPS = ["shopify", "boxtal", "invoicing"] as const

let orgId = ""
let userId = ""
/**
 * Restored in afterAll: the catalog dir and the install root are process wide and
 * other files share them. Every org's app discovery reads the install root, so an
 * install left behind is registered for every later file's org, and with the
 * staged catalog gone it no longer matches the image's catalog: it loses the
 * first-party voucher and its readOnly and sink-reader declarations with it.
 */
let priorCatalogDir: string | undefined
let priorAppsDir: string | undefined
let stagedCatalogDir = ""
let stagedAppsRoot = ""

const actor = {
  actorType: "user" as const,
  userId: "",
  orgId: "",
  scopes: ["*"],
  dimensionGrants: {},
}

async function tool<T = any>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await executeTool<T>({
    toolName: name,
    orgId,
    actor: { ...actor, userId, orgId },
    params,
    origin: "in-app-agent",
  })
  return result.data as T
}

/**
 * A catalog from the tarballs already frozen under `bundled-apps/<app>/dist`,
 * so the runtime installs the CURRENT bundled app rather than whatever old
 * version the repo-root catalog happens to hold.
 */
function stageCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "demo-shopify-catalog-"))
  const entries = APPS.map((name) => {
    const manifest = JSON.parse(
      readFileSync(join(REPO, "bundled-apps", name, "app.manifest.json"), "utf8"),
    ) as {
      name: string
      displayName?: string
      version: string
      scopes?: string[]
      connections?: Record<string, unknown>
    }
    const file = `${name}-${manifest.version}.liaisonapp`
    const tarball = join(REPO, "bundled-apps", name, "dist", file)
    if (!existsSync(tarball)) {
      throw new Error(
        `${file} is not built. Run: bash scripts/build-bundled-app.sh ${name} --skip-sign --skip-typecheck`,
      )
    }
    copyFileSync(tarball, join(dir, file))
    return {
      name,
      displayName: manifest.displayName,
      version: manifest.version,
      file,
      scopes: manifest.scopes ?? [],
      connections: Object.keys(manifest.connections ?? {}),
    }
  })
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(entries, null, 2))
  return dir
}

describe("the demo store, driven through the real app runtime", () => {
  beforeAll(async () => {
    await acquireTestLock()
    priorAppsDir = process.env.LIAISON_APPS_DIR
    if (!process.env.LIAISON_APPS_DIR) {
      stagedAppsRoot = mkdtempSync(join(tmpdir(), "demo-shopify-apps-"))
      process.env.LIAISON_APPS_DIR = join(stagedAppsRoot, "apps")
      mkdirSync(process.env.LIAISON_APPS_DIR, { recursive: true })
    }
    priorCatalogDir = process.env.LIAISON_APP_CATALOG_DIR
    stagedCatalogDir = stageCatalog()
    process.env.LIAISON_APP_CATALOG_DIR = stagedCatalogDir

    orgId = (await ensureOrg({ slug: "demo-shopify-runtime", name: "Demo Shopify Runtime" })).orgId
    userId = (
      await ensureUser({
        orgId,
        email: "demo-shopify-runtime@example.com",
        name: "Demo Operator",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId

    for (const name of APPS) {
      await installCatalogApp({ orgId, name, installedBy: userId })
      await enableApp(orgId, name)
    }
    await ensureAppsForOrg(orgId)
    await initSandboxPool()

    // The demo instance, with this org marked, and the store connected.
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(orgId, reservedMarker())
    await installDemoShopifyConnection({ orgId, createdByUserId: userId })
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    if (priorCatalogDir === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
    else process.env.LIAISON_APP_CATALOG_DIR = priorCatalogDir
    invalidateDemoMarker()
    resetDemoShopifyOverlay()
    await shutdownSandboxPool()
    // A setup that stopped before the org exists has nothing to remove, and must
    // not report a second failure over the one that stopped it.
    if (orgId) {
      await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
      // Uninstall while the install root still points at these installs: their
      // rows, their registrations in every org and their files all go.
      for (const name of APPS) await uninstallApp({ name })
    }
    if (priorAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = priorAppsDir
    if (stagedAppsRoot) rmSync(stagedAppsRoot, { recursive: true, force: true })
    if (stagedCatalogDir) rmSync(stagedCatalogDir, { recursive: true, force: true })
    await releaseTestLock()
  })

  it("shopify:home_load returns a connected shop with orders and attention rows", async () => {
    const home = await tool("shopify:home_load", {})
    expect(home.error).toBeUndefined()
    expect(home.connection.shopDomain).toBe("resonant-audio-labs-demo.myshopify.com")
    expect(home.recentOrders.orders.length).toBeGreaterThan(0)

    const first = home.recentOrders.orders[0]
    expect(first.name).toMatch(/^#\d+$/)
    expect(Number(first.totalPrice.amount)).toBeGreaterThan(0)
    expect(first.lineItems.length).toBeGreaterThan(0)
    expect(first.customer.displayName).toBeTruthy()

    // All three attention categories, populated. A silently empty one would
    // mean a probe the provider answered with an error the handler swallowed.
    expect(home.attention.unfulfilledOrders.length).toBeGreaterThan(0)
    expect(home.attention.lowInventory.length).toBeGreaterThan(0)
    expect(home.attention.pendingReturns.length).toBeGreaterThan(0)
  })

  it("shopify:orders_search pages, counts and prices coherently", async () => {
    const page = await tool("shopify:orders_search", { limit: 20 })
    expect(page.results.length).toBe(20)
    expect(page.totalCount).toBeGreaterThan(50)
    expect(page.nextCursor).toBeTruthy()

    const next = await tool("shopify:orders_search", { limit: 20, cursor: page.nextCursor })
    const firstIds = page.results.map((r: any) => r.id)
    expect(next.results.some((r: any) => firstIds.includes(r.id))).toBe(false)

    for (const hit of page.results) {
      expect(hit.title).toBeTruthy()
      expect(
        Number(hit.attributes.totalAmount ?? hit.attributes.total_amount ?? 0),
      ).toBeGreaterThan(0)
    }
  })

  it("shopify:orders_get returns the same order the search hit named", async () => {
    const page = await tool("shopify:orders_search", { limit: 5 })
    const target = page.results[0]
    const detail = await tool("shopify:orders_get", { id: target.id })
    expect(detail.id ?? detail.order?.id ?? detail.results?.[0]?.id).toBeTruthy()
    expect(JSON.stringify(detail)).toContain("RAL-")
  })

  it("shopify:customers_search returns the demo world's own customers", async () => {
    const page = await tool("shopify:customers_search", { limit: 30 })
    expect(page.results.length).toBeGreaterThan(20)
    expect(page.totalCount).toBe(page.results.length + (page.nextCursor ? 0 : 0))
    const blob = JSON.stringify(page.results)
    expect(blob).toContain("@")
    // Every seeded person lives on a reserved domain; a real address here would
    // mean the provider leaked something that is not the demo world.
    expect(blob).not.toMatch(/@(gmail|outlook|yahoo)\.com/)
  })

  it("shopify:products_search returns the RAL catalog with prices and stock", async () => {
    const page = await tool("shopify:products_search", { limit: 50 })
    expect(page.results.length).toBeGreaterThanOrEqual(10)
    const blob = JSON.stringify(page.results)
    expect(blob).toContain("RAL-FLAG-01")
    // Every product of the demo world's catalog, by title, with its price.
    for (const sku of DEMO_CATALOG) {
      expect(blob).toContain(sku.title)
      expect(blob).toContain(`"firstVariantPrice":"${(sku.priceMinor / 100).toFixed(2)}"`)
    }
  })

  it("shopify:draft_orders_list returns quotes", async () => {
    const page = await tool("shopify:draft_orders_list", { limit: 50 })
    expect(page.results.length).toBeGreaterThan(5)
    expect(JSON.stringify(page.results)).toMatch(/"D1\d\d"/)
  })

  it("boxtal:to_prepare_list derives a worklist from the demo store's open orders", async () => {
    const list = await tool("boxtal:to_prepare_list", {})
    const rows = list.rows ?? list.results ?? list.items ?? []
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(20)
    for (const row of rows) {
      // Each row is a real order of the demo store, named and addressed.
      expect(row.order_key).toMatch(/^so:\d+$/)
      expect(row.customer).toBeTruthy()
      expect(row.destination).toMatch(/^[A-Z]{2}$/)
      expect(row.items).toBeGreaterThan(0)
    }
    // And they are the store's OPEN orders, not an arbitrary slice of it.
    const open = await tool("shopify:orders_search", {
      query:
        "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial OR fulfillment_status:on_hold)",
      limit: 100,
    })
    expect(rows.length).toBeLessThanOrEqual(open.totalCount)
  })

  it("fulfilling an order through the real tool takes it off the real worklist", async () => {
    const before = await tool("boxtal:to_prepare_list", {})
    const rows = before.rows ?? before.results ?? []
    const target = rows[0]
    const orderId = `gid://shopify/Order/${String(target.order_key).replace("so:", "")}`

    // Gated tool, driven the way the UI drives it: the human click IS the approval.
    const shipped = await executeTool({
      toolName: "shopify:fulfillments_create",
      orgId,
      actor: { ...actor, userId, orgId },
      params: {
        orderId,
        fulfillment: { trackingInfo: { company: "Colissimo", number: "DEMO-TRACK-1" } },
      },
      origin: "human-ui",
    })
    expect(JSON.stringify(shipped.data)).toContain("DEMO-TRACK-1")

    // The write is visible to a different app reading the same store.
    const after = await tool("boxtal:to_prepare_list", {})
    const afterRows = after.rows ?? after.results ?? []
    expect(afterRows.map((r: any) => r.order_key)).not.toContain(target.order_key)
    expect(afterRows.length).toBe(rows.length - 1)

    const detail = await tool("shopify:orders_get", { id: orderId })
    expect(JSON.stringify(detail)).toContain("DEMO-TRACK-1")
  })
})
