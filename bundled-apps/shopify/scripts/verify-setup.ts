#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
// Sanity-checks the Shopify dev-store setup before implementation dispatches.
// Verifies:
//   1. Env vars present.
//   2. Offline token validates against /admin/api/<v>/shop.json.
//   3. staffMembers returns ≥ 3 entries (Test Admin / Refunder / Reader).
//   4. markets returns ≥ 2 enabled.
//   5. Seeded baseline present (tagged products, customers, orders).
//   6. Fixtures present and parseable.
//
// Output: ✅ READY when all pass; checklist of failures otherwise.
//
// Run: bun run liaison/bundled-apps/shopify/scripts/verify-setup.ts

import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { graphqlThrottled, loadShopifyEnv } from "./_shopify-client.ts"

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "src",
  "__fixtures__",
  "shopify",
)

const EXPECTED_FIXTURES = [
  "orders-search.json",
  "orders-get.json",
  "customers-search.json",
  "products-search.json",
  "markets-list.json",
  "shop.json",
  "locations.json",
]

// Optional fixtures — present if the corresponding restricted scope is granted,
// absent otherwise. Verifier won't fail on these being missing.
const OPTIONAL_FIXTURES = ["staff-members.json"]

interface Check {
  name: string
  ok: boolean
  /** When true, the check failed but it's a known limitation (e.g. Shopify-Plus-only scope on a non-Plus store). Reports as a warning instead of blocking READY. */
  warn?: boolean
  detail: string
}

async function checkEnv(): Promise<Check> {
  try {
    loadShopifyEnv()
    return { name: "env vars", ok: true, detail: "all required vars present" }
  } catch (err) {
    return { name: "env vars", ok: false, detail: (err as Error).message }
  }
}

async function checkToken(env: ReturnType<typeof loadShopifyEnv>): Promise<Check> {
  try {
    const res = await graphqlThrottled<{ shop: { name: string; myshopifyDomain: string } }>(
      env,
      `query { shop { name myshopifyDomain } }`,
    )
    if (res.data?.shop?.myshopifyDomain) {
      return { name: "offline token", ok: true, detail: `validates against ${res.data.shop.myshopifyDomain}` }
    }
    return { name: "offline token", ok: false, detail: "shop query returned no data" }
  } catch (err) {
    return { name: "offline token", ok: false, detail: (err as Error).message }
  }
}

async function checkStaff(env: ReturnType<typeof loadShopifyEnv>): Promise<Check> {
  try {
    const res = await graphqlThrottled<{ staffMembers: { edges: Array<{ node: { email: string } }> } }>(
      env,
      `query { staffMembers(first: 20) { edges { node { email } } } }`,
    )
    const count = res.data?.staffMembers?.edges?.length ?? 0
    if (count >= 3) return { name: "staff (≥ 3)", ok: true, detail: `${count} staff members configured` }
    return { name: "staff (≥ 3)", ok: false, detail: `only ${count} staff member(s): add Test Refunder + Test Reader per setup doc step 4` }
  } catch (err) {
    const msg = (err as Error).message
    // read_users is Shopify-Plus-only; dev stores and non-Plus production stores
    // can't query staffMembers. Report as warning (not failure) — the spec's
    // scope-mirroring design needs to handle this case anyway.
    if (/access denied for staffMembers/i.test(msg)) {
      return {
        name: "staff (≥ 3)",
        ok: false,
        warn: true,
        detail: "staffMembers query inaccessible (read_users is Plus-only), so scope-mirroring will use Liaison-side grants instead of auto-mirror; see spec amendment",
      }
    }
    return { name: "staff (≥ 3)", ok: false, detail: msg }
  }
}

async function checkMarkets(env: ReturnType<typeof loadShopifyEnv>): Promise<Check> {
  try {
    const res = await graphqlThrottled<{ markets: { edges: Array<{ node: { handle: string; enabled: boolean } }> } }>(
      env,
      `query { markets(first: 25) { edges { node { handle enabled } } } }`,
    )
    const enabled = (res.data?.markets?.edges ?? []).filter((e) => e.node.enabled).length
    if (enabled >= 2) return { name: "markets (≥ 2 enabled)", ok: true, detail: `${enabled} enabled markets` }
    return { name: "markets (≥ 2 enabled)", ok: false, detail: `only ${enabled} enabled: enable EU + US per setup doc step 3` }
  } catch (err) {
    return { name: "markets (≥ 2 enabled)", ok: false, detail: (err as Error).message }
  }
}

async function checkSeed(env: ReturnType<typeof loadShopifyEnv>): Promise<Check> {
  try {
    const res = await graphqlThrottled<{
      products: { edges: unknown[] }
      customers: { edges: unknown[] }
      orders: { edges: unknown[] }
    }>(
      env,
      `query {
        products(first: 50, query: "tag:liaison-seed") { edges { node { id } } }
        customers(first: 50, query: "tag:liaison-seed") { edges { node { id } } }
        orders(first: 50, query: "tag:liaison-seed") { edges { node { id } } }
      }`,
    )
    const p = res.data?.products.edges.length ?? 0
    const c = res.data?.customers.edges.length ?? 0
    const o = res.data?.orders.edges.length ?? 0
    if (p >= 5 && c >= 10 && o >= 10) {
      return { name: "seed baseline", ok: true, detail: `${p} products / ${c} customers / ${o} orders` }
    }
    return {
      name: "seed baseline",
      ok: false,
      detail: `incomplete (${p}/5 products, ${c}/10 customers, ${o}/15 orders): run dev-store-seed.ts`,
    }
  } catch (err) {
    return { name: "seed baseline", ok: false, detail: (err as Error).message }
  }
}

async function checkFixtures(): Promise<Check> {
  try {
    const entries = await readdir(FIXTURE_DIR)
    const missing = EXPECTED_FIXTURES.filter((f) => !entries.includes(f))
    if (missing.length > 0) {
      return { name: "fixtures", ok: false, detail: `missing: ${missing.join(", ")}: run capture-fixtures.ts` }
    }
    for (const f of EXPECTED_FIXTURES) {
      const text = await readFile(resolve(FIXTURE_DIR, f), "utf8")
      JSON.parse(text)
    }
    return { name: "fixtures", ok: true, detail: `${EXPECTED_FIXTURES.length} fixture files present and parseable` }
  } catch (err) {
    return { name: "fixtures", ok: false, detail: (err as Error).message }
  }
}

async function main() {
  const checks: Check[] = []
  checks.push(await checkEnv())
  if (!checks[0]!.ok) {
    report(checks)
    process.exit(1)
  }
  const env = loadShopifyEnv()
  checks.push(await checkToken(env))
  checks.push(await checkStaff(env))
  checks.push(await checkMarkets(env))
  checks.push(await checkSeed(env))
  checks.push(await checkFixtures())
  report(checks)
  process.exit(exitCode(checks))
}

function report(checks: Check[]): void {
  for (const c of checks) {
    const mark = c.ok ? "✅" : c.warn ? "⚠️ " : "❌"
    console.log(`${mark} ${c.name}: ${c.detail}`)
  }
  console.log("")
  const hardFailures = checks.filter((c) => !c.ok && !c.warn)
  if (hardFailures.length === 0) {
    console.log("✅ READY — implementation pipeline can dispatch.")
    const warns = checks.filter((c) => !c.ok && c.warn)
    if (warns.length > 0) {
      console.log(`(${warns.length} known limitation${warns.length === 1 ? "" : "s"} — see spec for handling.)`)
    }
  } else {
    console.log("❌ Setup incomplete. Address the items above.")
  }
}

function exitCode(checks: Check[]): number {
  return checks.some((c) => !c.ok && !c.warn) ? 1 : 0
}

main().catch((err) => {
  console.error("\n❌ verify-setup crashed:", err.message)
  process.exit(2)
})
