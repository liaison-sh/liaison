// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the Shopify app's contract fixtures against a Shopify development
// store (fixtures/shopify/*.json). Not part of any suite: a developer runs it
// by path when the app's egress changes, then reads what it wrote and commits it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-shopify.recorder.ts)
//
// Needs SHOPIFY_DEV_STORE_DOMAIN and SHOPIFY_DEV_STORE_OFFLINE_TOKEN (a
// development store's offline Admin API token). The run installs the app for an
// org whose ids are the contract's own (replay-bridge.ts), connects the store,
// and runs every entry the plan below names (recording-plan-shopify.ts) on the
// live bridge, in order: later steps use what earlier ones created (a product,
// a draft order, an order, ...). The write tools change the development store;
// the plan cleans up what it creates where the app can. Each fixture is
// scrubbed (store domain, emails, IPs, phones) and replayed twice before it is
// written. CONTRACT_RECORD_ONLY=<entry,entry> records only those entries (their
// prerequisites still run, unwritten).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { createWebhookVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { BUNDLED_APPS_DIR, bridgeSurfaceOf, verifySurface } from "./apps.test-helpers"
import { contractEntries } from "./entries"
import { bundledAppScripts, productionLimits } from "./harness"
import type { ContractIsolate } from "./isolate"
import { quickJsContractExecutor } from "./quickjs-isolate"
import {
  type Replacement,
  recordEntry,
  scrubFixture,
  scrubValue,
  verifyFixture,
  writeFixture,
} from "./recorder"
import {
  type PlanState,
  SHOPIFY_RECORDING_PLAN,
  SYNTHETIC_WEBHOOK_SECRET,
} from "./recording-plan-shopify"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "./replay-bridge"

const APP = "shopify"
const DIR = join(BUNDLED_APPS_DIR, APP)
const FIXTURES_DIR = join(import.meta.dir, "fixtures")
const STAND_IN_SHOP = "contract-shop.myshopify.com"

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: the recorder needs the development store`)
  return v
}

const rawDomain = requiredEnv("SHOPIFY_DEV_STORE_DOMAIN").toLowerCase()
const SHOP = rawDomain.endsWith(".myshopify.com") ? rawDomain : `${rawDomain}.myshopify.com`
const TOKEN = requiredEnv("SHOPIFY_DEV_STORE_OFFLINE_TOKEN")

const manifest = JSON.parse(readFileSync(join(DIR, "app.manifest.json"), "utf8")) as Record<
  string,
  unknown
> & {
  version: string
  scopes: string[]
}
const actor: UserContext = {
  actorType: "user",
  userId: CONTRACT_USER_ID,
  orgId: CONTRACT_ORG_ID,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

async function restRead(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${SHOP}/admin/api/2026-04/${path}`, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  })
  if (!res.ok) throw new Error(`REST ${path}: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function adminGraphql(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  })
  return ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
}

/** Remove what the plan made on the store: products, discounts, draft orders and orders tagged for it. */
async function cleanStore(): Promise<void> {
  const ids = async (query: string, path: string) => {
    const data = await adminGraphql(query)
    return ((data[path] as { nodes?: Array<{ id: string }> })?.nodes ?? []).map((n) => n.id)
  }
  for (const id of await ids(
    `{ products(first: 100, query: "tag:contract-fixture") { nodes { id } } }`,
    "products",
  )) {
    await adminGraphql(
      "mutation ($id: ID!) { productDelete(input: { id: $id }) { deletedProductId } }",
      { id },
    )
  }
  for (const id of await ids(
    `{ codeDiscountNodes(first: 100, query: "title:Contract Fixture*") { nodes { id } } }`,
    "codeDiscountNodes",
  )) {
    await adminGraphql(
      "mutation ($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId } }",
      { id },
    )
  }
  for (const id of await ids(
    `{ draftOrders(first: 100, query: "tag:contract-fixture status:open") { nodes { id } } }`,
    "draftOrders",
  )) {
    await adminGraphql(
      "mutation ($id: ID!) { draftOrderDelete(input: { id: $id }) { deletedId } }",
      { id },
    )
  }
  for (const id of await ids(
    `{ orders(first: 100, query: "tag:contract-fixture") { nodes { id } } }`,
    "orders",
  )) {
    await adminGraphql("mutation ($id: ID!) { orderDelete(orderId: $id) { deletedId } }", { id })
  }
}

describe("record Shopify contract fixtures", () => {
  let isolate: ContractIsolate
  let bridgeManifest: unknown
  const surface = bridgeSurfaceOf(APP)
  const entries = new Map(contractEntries(manifest).map((e) => [e.entry, e]))

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${CONTRACT_ORG_ID}, 'Contract recording', 'contract-recording') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${CONTRACT_USER_ID}, ${CONTRACT_ORG_ID}, 'recorder@example.com', 'Contract Recorder', 'x')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(CONTRACT_ORG_ID)
    await registerApps(
      [
        {
          ...manifest,
          trusted: false,
          _firstParty: true,
          _format: "manifest",
          _bundlePath: join(DIR, manifest.version, "bundle.js"),
        },
      ] as never,
      CONTRACT_ORG_ID,
    )
    bridgeManifest = (
      toolRegistry.get([CONTRACT_ORG_ID, APP, "orders_search"]) as { _manifest?: unknown }
    )?._manifest
    if (!bridgeManifest) throw new Error("shopify did not register")
    await sql`UPDATE kernel.connected_accounts SET status = 'disconnected'
      WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP} AND status = 'active'`
    const [account] = await sql<{ id: string }[]>`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, display_name,
       access_token_encrypted, status, created_by, metadata)
      VALUES (${CONTRACT_ORG_ID}, ${APP}, 'shop', 'org', 'oauth2', ${SHOP}, ${SHOP},
       ${encryptSecret(TOKEN, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
       'active', ${CONTRACT_USER_ID}, ${JSON.stringify({ grantedOAuthScopes: manifest.scopes })}::jsonb)
      RETURNING id`
    await sql`INSERT INTO kernel.apps (org_id, name, version, config)
      VALUES (${CONTRACT_ORG_ID}, ${APP}, ${manifest.version}, ${JSON.stringify({ shopifyWebhookSecret: SYNTHETIC_WEBHOOK_SECRET })}::jsonb)
      ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config`
    // The store's real OAuth grant, so the app's scope checks see what the token can do.
    const scopeRes = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query: "{ currentAppInstallation { accessScopes { handle } } }" }),
    })
    const granted = (
      (await scopeRes.json()) as {
        data: { currentAppInstallation: { accessScopes: Array<{ handle: string }> } }
      }
    ).data.currentAppInstallation.accessScopes.map((x) => x.handle)
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`DELETE FROM app_shopify.webhook_deliveries WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`DELETE FROM app_shopify.backfill_progress WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`INSERT INTO app_shopify.install_metadata
      (org_id, shop_domain, connection_id, api_version, granted_o_auth_scopes, connection_status,
       installed_at, unfulfilled_threshold_hours, consecutive_scope_mirror_failures)
      VALUES (${CONTRACT_ORG_ID}, ${SHOP}, ${account!.id}, ${String(
        (manifest.connections as { shop: { apiVersion: string } }).shop.apiVersion,
      )}, ${JSON.stringify(granted)}::jsonb, 'connected', now(), 24, 0)`
    console.log(`granted OAuth scopes: ${granted.join(",")}`)
    const scripts = await bundledAppScripts(DIR)
    isolate = await quickJsContractExecutor.open(scripts.source, { memoryBytes: 64 * 1024 * 1024 })
  }, 300_000)

  afterAll(async () => {
    await cleanStore()
    isolate?.dispose()
    await teardownAppRegistrations(CONTRACT_ORG_ID, APP)
    toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
    initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
    await releaseTestLock()
  }, 600_000)

  function liveBridge(job?: { name: string; payload: Record<string, unknown> }): AppBridge {
    return createSessionRpcBridge(
      APP,
      CONTRACT_USER_ID,
      CONTRACT_ORG_ID,
      { run: (fn) => withRlsContext(actor, fn) },
      bridgeManifest as never,
      ["*"],
      "user",
      undefined,
      {
        actor,
        ...(job
          ? {
              currentJob: {
                name: job.name,
                payload: job.payload,
                timeoutMs: 60_000,
                atomic: false,
              },
            }
          : {}),
      } as never,
    ) as AppBridge
  }

  it("records every planned entry", async () => {
    const only = process.env.CONTRACT_RECORD_ONLY
      ? new Set(process.env.CONTRACT_RECORD_ONLY.split(","))
      : null
    // The store's own identity (its name, its owner, its domains) never reaches a fixture.
    const shop = (await restRead("shop.json")).shop as Record<string, unknown>
    const identity = (field: string, to: string): Replacement[] =>
      typeof shop[field] === "string" && (shop[field] as string).length > 2
        ? [{ from: shop[field] as string, to }]
        : []
    const replacements: Replacement[] = [
      { from: TOKEN, to: "shpat_redacted" },
      ...identity("shop_owner", "Store Owner"),
      ...identity("domain", STAND_IN_SHOP),
      ...identity("name", "Contract Shop"),
      { from: SHOP, to: STAND_IN_SHOP },
      { from: SHOP.replace(/\.myshopify\.com$/, ""), to: "contract-shop" },
    ]
    const state: PlanState = {
      shop: SHOP,
      values: {},
      admin: adminGraphql,
      rest: restRead,
      signed: (topic, body, webhookId) => {
        const text = JSON.stringify(scrubValue(body, replacements))
        return {
          headers: {
            "x-shopify-hmac-sha256": createHmac("sha256", SYNTHETIC_WEBHOOK_SECRET)
              .update(text)
              .digest("base64"),
            "x-shopify-webhook-id": webhookId,
            "x-shopify-topic": topic,
            "x-shopify-shop-domain": SHOP,
            "x-shopify-api-version": "2026-04",
          },
          body: text,
        }
      },
    }
    const report: string[] = []
    for (const step of SHOPIFY_RECORDING_PLAN) {
      const entry = entries.get(step.entry)
      if (!entry)
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
      const input = await step.input(state)
      const params = input.params as Record<string, unknown> | undefined
      const job =
        entry.kind === "job" ? { name: entry.entry.slice(4), payload: params ?? {} } : undefined
      const verifier = entry.kind === "webhook-verify"
      const entrySurface = verifier ? verifySurface() : surface
      const real = verifier
        ? (createWebhookVerifyBridge({
            appOrgId: CONTRACT_ORG_ID,
            appName: APP,
            appConfig: { shopifyWebhookSecret: SYNTHETIC_WEBHOOK_SECRET },
            manifestConnections: manifest.connections as never,
          }) as AppBridge)
        : liveBridge(job)
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry,
        input,
        real,
        surface: entrySurface,
        limits: productionLimits(entry),
        recordedFrom: "a Shopify development store, record-shopify.recorder.ts",
      })
      const answer = outcome.ok ? outcome.result : { thrown: outcome.error }
      await step.after?.(answer, state)
      const summary = JSON.stringify(answer)?.slice(
        0,
        process.env.CONTRACT_RECORD_DEBUG ? 3000 : 160,
      )
      if (only && !only.has(step.entry)) {
        report.push(`  (prereq) ${step.entry}: ${summary}`)
        continue
      }
      if (step.record === false) continue
      const rejected =
        !outcome.ok ||
        (answer !== null && typeof answer === "object" && "error" in (answer as object))
      if (rejected && fixture.calls.length === 0) {
        report.push(
          `WEAK ${step.entry}: rejected its input before any call, not written | ${summary}`,
        )
        continue
      }
      const scrubbed = scrubFixture(fixture, replacements)
      const problem = await verifyFixture({
        isolate,
        entry,
        fixture: scrubbed,
        surface: entrySurface,
        limits: productionLimits(entry),
      })
      if (problem) {
        report.push(`FAIL ${step.entry}: ${problem} | ${summary}`)
        continue
      }
      const leaked = [TOKEN, SHOP].filter((s) => JSON.stringify(scrubbed).includes(s))
      expect(leaked).toEqual([])
      writeFixture(FIXTURES_DIR, APP, scrubbed)
      report.push(`ok   ${step.entry} (${scrubbed.calls.length} calls): ${summary}`)
    }
    console.log(`\n${report.join("\n")}\n`)
  }, 1_800_000)
})
