// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo Shopify provider's blast radius, asserted from the source tree.
//
// Two claims this file will not let rot:
//
//   1. `installDemoShopifyConnection` is reachable only from the demo seeder.
//      No route, no sandbox bridge method, no tool wraps it, so a visitor has
//      no way to invoke it however they drive the product. That, plus the fact
//      that it takes no credential and no shop, is what makes it safe for a
//      shipped product to carry a function that writes a connection past the
//      demo-mode refusal.
//
//   2. The hot path stays cheap. `provider.ts` is imported by the sandbox
//      egress bridge on every deployment, so it must not pull the fixtures, the
//      search parser or the node builders in with it: everything behind the
//      gate is loaded by a dynamic import that only a demo request takes.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { demoShopifyReadOperations } from "./reads"
import { demoShopifyWriteOperations } from "./writes"

const SRC = path.resolve(import.meta.dir, "..", "..", "..")
const REPO = path.resolve(SRC, "..", "..", "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out
}

function callers(symbol: string, roots: string[]): string[] {
  const hits: string[] = []
  for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })) continue
    for (const file of walk(root)) {
      if (file.endsWith(".test.ts")) continue
      const src = readFileSync(file, "utf8")
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(src)) hits.push(path.relative(REPO, file))
    }
  }
  return hits.sort()
}

describe("the demo Shopify provider's boundary", () => {
  it("only the demo module and the demo seeder ever call installDemoShopifyConnection", () => {
    const hits = callers("installDemoShopifyConnection", [
      path.join(SRC),
      path.join(REPO, "scripts"),
      path.join(REPO, "apps", "web", "src"),
      path.join(REPO, "bundled-apps"),
    ])
    for (const hit of hits) {
      const allowed =
        hit.startsWith("apps/api/src/modules/demo/shopify/") ||
        hit.startsWith("apps/api/src/seed/tiers/demo/")
      expect({ hit, allowed }).toEqual({ hit, allowed: true })
    }
  })

  it("no route file and no sandbox bridge file mentions it at all", () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.endsWith(".test.ts")) continue
      const rel = path.relative(REPO, file)
      const isSurface =
        rel.includes("routes") || rel.includes("/sandbox/bridge/") || rel.includes("/tools/")
      if (!isSurface) continue
      if (readFileSync(file, "utf8").includes("installDemoShopifyConnection")) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it("the installer takes no credential and no shop from its caller", () => {
    const src = readFileSync(path.join(import.meta.dir, "connection.ts"), "utf8")
    const signature = src.slice(src.indexOf("export async function installDemoShopifyConnection"))
    const params = signature.slice(0, signature.indexOf("}): Promise"))
    expect(params).toContain("orgId")
    expect(params).toContain("createdByUserId")
    for (const forbidden of ["token", "credential", "shopDomain", "shop:", "identifier"]) {
      expect(params.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it("provider.ts, which the egress bridge imports, pulls in no fixture code", () => {
    const src = readFileSync(path.join(import.meta.dir, "provider.ts"), "utf8")
    const staticImports = [...src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1])
    expect(staticImports.sort()).toEqual([
      "./sentinel",
      // The LIAISON_DEMO_SHOPIFY_FIXTURES gate (20bf24529): config, not fixture code.
      "~/lib/env",
      "~/modules/demo/demo-mode",
      "~/modules/demo/demo-org",
      // The fixture connection's own request, recognised on any box: string compares, no fixtures.
      "~/modules/demo/fixture-credential",
    ])
    // The expensive half (the shared store's replica, then the answer and its
    // fixtures) is behind a dynamic import, taken only past both gates.
    expect(src).toContain('await import("./replica")')
  })

  it("the egress bridge asks the process gate before it asks anything else", () => {
    const src = readFileSync(path.join(import.meta.dir, "provider.ts"), "utf8")
    const body = src.slice(src.indexOf("export async function maybeDemoShopifyResponse"))
    const gate = body.indexOf("isDemoModeEnabled()")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf("new URL("))
    expect(gate).toBeLessThan(body.indexOf("loadDemoOrg("))
  })

  it("covers the operations the demo tour and Boxtal need", () => {
    const reads = demoShopifyReadOperations()
    for (const operation of [
      "OrdersSearch",
      "OrderGet",
      "RecentOrders",
      "Unfulfilled",
      "LowInventory",
      "PendingReturns",
      "CustomersSearch",
      "CustomerGet",
      "ProductsSearch",
      "ProductGet",
      "VariantsSearch",
      "VariantGet",
      "DraftOrdersList",
      "DraftOrderGet",
      "B2bCustomerCompanies",
      "B2bDraftBuyer",
      "ReturnsByOrders",
      "ReturnsByOrderId",
      "OrderFulfillmentOrdersGet",
      "LocationsList",
      "InventoryLevels",
    ]) {
      expect(reads).toContain(operation)
    }
    expect(demoShopifyWriteOperations()).toEqual([
      "DiscountCodeBasicCreate",
      "DiscountRedeemCodeBulkAdd",
      "DraftOrderComplete",
      "DraftOrderCreate",
      "FulfillmentCreateV2",
      "FulfillmentTrackingInfoUpdate",
      "OrderCancel",
      "OrderNoteSet",
      "OrderUpdate",
      "RefundCreate",
      "TagsAdd",
      "TagsRemove",
    ])
  })
})
