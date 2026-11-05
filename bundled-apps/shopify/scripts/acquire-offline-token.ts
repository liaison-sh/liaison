#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
// Keeps the dev store's token able to do everything the shopify app asks for. Run from the
// monorepo root:
//   bun run liaison/bundled-apps/shopify/scripts/acquire-offline-token.ts          # check, then wait for approval
//   bun run liaison/bundled-apps/shopify/scripts/acquire-offline-token.ts --mint   # no token yet: print a new one
//
// Loads SHOPIFY_OAUTH_CLIENT_ID, SHOPIFY_OAUTH_CLIENT_SECRET, SHOPIFY_DEV_STORE_DOMAIN and
// SHOPIFY_DEV_STORE_OFFLINE_TOKEN from liaison/.env.test.
//
// The dev app uses Shopify-managed installation: the store grants the scopes in the app's
// configuration (`shopify.app.toml`, released with `shopify app deploy`), not scopes named in an
// authorize URL. So a scope the manifest adds is granted in two steps, and the token you already
// have gains it, no new token needed:
//   1. Add the scope to the app's configuration and release it (`shopify app deploy`).
//   2. Run this script. It lists what the token lacks, prints the store's approval link, and
//      waits while a store staff member opens it (in the browser signed in to that store) and
//      approves.
//
// `--mint` asks for a token with the client credentials grant. It holds what the store has
// granted the app and lasts 24 hours: enough for a run, not a permanent value for .env.test.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { grantSatisfies } from "../src/lib/constants.ts"
import { loadShopifyEnv, type ShopifyEnv } from "./_shopify-client.ts"

const POLL_MS = 5_000
const WAIT_MS = 15 * 60_000

/** The scopes the shopify app's store connection asks for (its manifest is the one source). */
function manifestScopes(): string[] {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8")) as {
    connections: { shop: { scopes: string[] } }
  }
  return manifest.connections.shop.scopes
}

async function grantedScopes(env: ShopifyEnv, token: string): Promise<string[]> {
  const res = await fetch(`https://${env.domain}/admin/oauth/access_scopes.json`, {
    headers: { "X-Shopify-Access-Token": token },
  })
  if (!res.ok) throw new Error(`access_scopes.json returned ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { access_scopes: Array<{ handle: string }> }
  return body.access_scopes.map((s) => s.handle)
}

function missingScopes(required: string[], granted: string[]): string[] {
  const held = new Set(granted)
  return required.filter((s) => !grantSatisfies(held, s))
}

async function mint(env: ShopifyEnv): Promise<void> {
  const res = await fetch(`https://${env.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.clientId,
      client_secret: env.clientSecret,
    }),
  })
  if (!res.ok) throw new Error(`Client credentials grant failed ${res.status}: ${await res.text()}`)
  const token = (await res.json()) as { access_token: string; scope: string; expires_in?: number }
  const missing = missingScopes(manifestScopes(), token.scope.split(","))
  console.log(`Token minted (expires_in=${token.expires_in ?? "unknown"}s).`)
  if (missing.length > 0) console.log(`It lacks: ${missing.join(", ")}. Run without --mint to approve them.`)
  console.log(`\nSHOPIFY_DEV_STORE_OFFLINE_TOKEN=${token.access_token}\n`)
}

async function main() {
  const wantsMint = process.argv.includes("--mint")
  const env = loadShopifyEnv({ requireToken: !wantsMint })
  if (wantsMint) return mint(env)

  const required = manifestScopes()
  let missing = missingScopes(required, await grantedScopes(env, env.offlineToken))
  if (missing.length === 0) {
    console.log(`The dev store token holds all ${required.length} scopes the manifest asks for.`)
    return
  }

  const store = env.domain.replace(/\.myshopify\.com$/, "")
  const approvalUrl = `https://admin.shopify.com/store/${store}/oauth/install?client_id=${encodeURIComponent(env.clientId)}`
  console.log(`The token lacks: ${missing.join(", ")}.`)
  console.log("If the app's configuration lacks them too, add them and run `shopify app deploy` first.")
  console.log("\nOpen this link in the browser signed in to the dev store, and approve:\n")
  console.log(`  ${approvalUrl}\n`)
  console.log("Waiting for the approval…")

  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    missing = missingScopes(required, await grantedScopes(env, env.offlineToken))
    if (missing.length === 0) {
      console.log("Approved: the token now holds every scope. Nothing to change in .env.test.")
      return
    }
  }
  throw new Error(`Still missing after ${WAIT_MS / 60_000} min: ${missing.join(", ")}`)
}

main().catch((err) => {
  console.error("\nFailed:", (err as Error).message)
  process.exit(1)
})
