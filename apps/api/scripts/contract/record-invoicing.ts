// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixtures (fixtures/invoicing/*.json). Not part of any
// suite: a developer runs it by path when the app's egress changes, then reads what it wrote and
// commits it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-invoicing.ts)
//
// Needs the Shopify development store (SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_STORE_OFFLINE_TOKEN):
// invoicing reads orders and variants through the Shopify app, which this run installs and
// connects for an org whose ids are the contract's own (replay-bridge.ts). The registry (SIREN
// lookups) and VIES are public services. Every entry the plan names (recording-plan-invoicing.ts)
// runs on the live bridge in order: later steps use what earlier ones created (an issuer, a draft,
// an invoice, ...). Each fixture is scrubbed (store domain, emails, IPs, phones) and replayed twice
// before it is written. CONTRACT_RECORD_ONLY=<entry,entry> writes only those entries (the others still run).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { BUNDLED_APPS_DIR, bridgeSurfaceOf } from "~/modules/apps/contract/apps.test-helpers"
import { contractEntries } from "~/modules/apps/contract/entries"
import { bundledAppScripts, productionLimits } from "~/modules/apps/contract/harness"
import type { ContractIsolate } from "~/modules/apps/contract/isolate"
import { quickJsContractExecutor } from "~/modules/apps/contract/quickjs-isolate"
import {
  type Replacement,
  recordEntry,
  scrubFixture,
  verifyFixture,
  writeFixture,
} from "~/modules/apps/contract/recorder"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "~/modules/apps/contract/replay-bridge"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { registerTemplate } from "~/modules/pdf/registry"
import { acquireTestLock, releaseTestLock, superuserUrlForTestDb } from "~/tests/route-test-setup"
import { INVOICING_RECORDING_PLAN, type InvoicingPlanState } from "./recording-plan-invoicing"

const APP = "invoicing"
const FIXTURES_DIR = join(import.meta.dir, "../../src/modules/apps/contract/fixtures")
const STAND_IN_SHOP = "contract-shop.myshopify.com"

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: the recorder needs the development store`)
  return v
}

const rawDomain = requiredEnv("SHOPIFY_DEV_STORE_DOMAIN").toLowerCase()
const SHOP = rawDomain.endsWith(".myshopify.com") ? rawDomain : `${rawDomain}.myshopify.com`
const TOKEN = requiredEnv("SHOPIFY_DEV_STORE_OFFLINE_TOKEN")

type Manifest = Record<string, unknown> & { version: string; scopes: string[] }
const manifestOf = (app: string): Manifest =>
  JSON.parse(readFileSync(join(BUNDLED_APPS_DIR, app, "app.manifest.json"), "utf8")) as Manifest
const manifest = manifestOf(APP)
const shopifyManifest = manifestOf("shopify")

const actor: UserContext = {
  actorType: "user",
  userId: CONTRACT_USER_ID,
  orgId: CONTRACT_ORG_ID,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

const descriptor = (app: string, m: Manifest) => ({
  ...m,
  trusted: false,
  _firstParty: true,
  _format: "manifest",
  _bundlePath: join(BUNDLED_APPS_DIR, app, m.version, "bundle.js"),
})

/**
 * The app's PDF templates as the package build makes them (scripts/freeze-app.ts): bundled for the
 * sandbox in a child `bun build` (a second in-process Bun.build after the from-source registration
 * fails reading a dependency), the trailing ESM export block replaced by `globalThis.renderTemplate`.
 * Registered so a recorded issue renders its PDF as production does.
 */
function registerPdfTemplates(): void {
  for (const tpl of (manifest.pdf_templates ?? []) as Array<{ kind: string; source: string }>) {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(BUNDLED_APPS_DIR, APP, tpl.source),
        "--target",
        "bun",
        "--external",
        "node:*",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (build.exitCode !== 0)
      throw new Error(`template ${tpl.kind} build failed: ${build.stderr.toString()}`)
    const js = build.stdout.toString()
    const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
    const local = block?.[1]
      ?.split(",")
      .map((x) => x.trim())
      .map(
        (x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null),
      )
      .find((x) => x)
    if (!block || !local) throw new Error(`template ${tpl.kind} exports no renderTemplate`)
    registerTemplate(
      APP,
      tpl.kind,
      `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`,
    )
  }
}

describe("record invoicing contract fixtures", () => {
  let isolate: ContractIsolate
  let scripts: Awaited<ReturnType<typeof bundledAppScripts>>
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
      [descriptor("shopify", shopifyManifest), descriptor(APP, manifest)] as never,
      CONTRACT_ORG_ID,
    )
    bridgeManifest = (
      toolRegistry.get([CONTRACT_ORG_ID, APP, "documents_get"]) as { _manifest?: unknown }
    )?._manifest
    if (!bridgeManifest) throw new Error("invoicing did not register")
    // Boot builds the files read policy from every registered file parent (legal originals
    // included): without it, a legal original's bytes read back as forbidden.
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
    registerPdfTemplates()
    // The Shopify app, connected to the development store, answers invoicing's cross-app reads.
    await sql`UPDATE kernel.connected_accounts SET status = 'disconnected'
      WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = 'shopify' AND status = 'active'`
    const [account] = await sql<{ id: string }[]>`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, display_name,
       access_token_encrypted, status, created_by, metadata)
      VALUES (${CONTRACT_ORG_ID}, 'shopify', 'shop', 'org', 'oauth2', ${SHOP}, ${SHOP},
       ${encryptSecret(TOKEN, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
       'active', ${CONTRACT_USER_ID}, ${JSON.stringify({ grantedOAuthScopes: shopifyManifest.scopes })}::jsonb)
      RETURNING id`
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`INSERT INTO app_shopify.install_metadata
      (org_id, shop_domain, connection_id, api_version, granted_o_auth_scopes, connection_status,
       installed_at, unfulfilled_threshold_hours, consecutive_scope_mirror_failures)
      VALUES (${CONTRACT_ORG_ID}, ${SHOP}, ${account!.id}, ${String(
        (shopifyManifest.connections as { shop: { apiVersion: string } }).shop.apiVersion,
      )}, ${JSON.stringify(shopifyManifest.scopes)}::jsonb, 'connected', now(), 24, 0)`
    // Start from no invoicing data: a fixture must not depend on an earlier recording's rows.
    // Legal originals are retained by the database; an operator session lifts that for this org.
    const superUrl = superuserUrlForTestDb()
    if (!superUrl) throw new Error("the recorder needs the test database's superuser URL")
    const { default: postgres } = await import("postgres")
    const su = postgres(superUrl, { max: 1 })
    try {
      await su.begin(async (tx) => {
        await tx`SET LOCAL liaison.retention_override = 'on'`
        await tx`DELETE FROM app_invoicing.legal_originals WHERE org_id = ${CONTRACT_ORG_ID}`
        await tx`DELETE FROM app_invoicing.facturx_files WHERE org_id = ${CONTRACT_ORG_ID}`
        await tx`DELETE FROM kernel.files WHERE org_id = ${CONTRACT_ORG_ID} AND app = 'invoicing'`
      })
    } finally {
      await su.end()
    }
    for (const table of [
      "document_lines",
      "einvoice_transmissions",
      "deferred_events",
      "documents",
      "issuer_profiles",
      "hs_code_library",
      "product_customs_overlay",
      "contact_relationships",
      "counterparty_identities",
      "einvoicing_settings",
    ]) {
      await sql.unsafe(`DELETE FROM app_invoicing.${table} WHERE org_id = $1`, [CONTRACT_ORG_ID])
    }
    await sql`DELETE FROM kernel.app_sequences WHERE org_id = ${CONTRACT_ORG_ID} AND app_id = ${APP}`
    scripts = await bundledAppScripts(join(BUNDLED_APPS_DIR, APP))
    isolate = await quickJsContractExecutor.open(scripts.source, { memoryBytes: 64 * 1024 * 1024 })
  }, 300_000)

  afterAll(async () => {
    isolate?.dispose()
    await teardownAppRegistrations(CONTRACT_ORG_ID, APP)
    await teardownAppRegistrations(CONTRACT_ORG_ID, "shopify")
    await rebuildFilesSelectPolicy()
    toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
    initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
    await releaseTestLock()
  })

  function liveBridge(
    entryKind: string,
    job?: { name: string; payload: unknown },
    approval?: Record<string, unknown>,
  ): AppBridge {
    return createSessionRpcBridge(
      APP,
      CONTRACT_USER_ID,
      CONTRACT_ORG_ID,
      { run: (fn) => withRlsContext(actor, fn) },
      bridgeManifest as never,
      ["*"],
      "user",
      // A gated tool's real path: the run re-entered after a person approved it.
      approval as never,
      {
        actor,
        // A tool's handler may park itself on an approval, as its production run can.
        ...(entryKind === "tool"
          ? {
              requestApprovalImpl: (input: never) =>
                createHandlerApprovalRequest({
                  orgId: CONTRACT_ORG_ID,
                  requestedBy: CONTRACT_USER_ID,
                  actorScopes: ["*"],
                  defaultAppName: APP,
                  input,
                }),
            }
          : {}),
        ...(job
          ? {
              currentJob: {
                name: job.name,
                payload: job.payload,
                timeoutMs: 120_000,
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
    const replacements: Replacement[] = [
      { from: TOKEN, to: "shpat_redacted" },
      { from: SHOP, to: STAND_IN_SHOP },
      { from: SHOP.replace(/\.myshopify\.com$/, ""), to: "contract-shop" },
    ]
    const state: InvoicingPlanState = {
      shop: SHOP,
      values: {},
      rest: async (path) => {
        const res = await fetch(`https://${SHOP}/admin/api/2026-04/${path}`, {
          headers: { "X-Shopify-Access-Token": TOKEN },
        })
        if (!res.ok) throw new Error(`REST ${path}: ${res.status}`)
        return (await res.json()) as Record<string, unknown>
      },
      sql: async (text, params = []) =>
        (await sql.unsafe(text, params as never[])) as unknown as Array<Record<string, unknown>>,
    }
    const report: string[] = []
    const say = (line: string) => {
      report.push(line)
      console.log(`[record] ${line}`)
    }
    for (const step of INVOICING_RECORDING_PLAN) {
      const entry = entries.get(step.entry)
      if (!entry)
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
      let input: Awaited<ReturnType<typeof step.input>>
      try {
        await step.before?.(state)
        input = await step.input(state)
      } catch (err) {
        say(`ERR  ${step.entry}: setup failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const job =
        entry.kind === "job"
          ? { name: entry.entry.slice(4), payload: input.params ?? {} }
          : undefined
      // A PDF template runs as its own bundle, in an isolate of its own.
      const own = entry.templateSource
        ? await quickJsContractExecutor.open(await scripts.templateSource(entry.templateSource), {
            memoryBytes: 64 * 1024 * 1024,
          })
        : null
      const entryIsolate = own ?? isolate
      const { fixture, outcome } = await recordEntry({
        isolate: entryIsolate,
        entry,
        input,
        real: liveBridge(entry.kind, job, input.approval),
        surface,
        limits: productionLimits(entry),
        recordedFrom:
          "a contract org with the Shopify development store, scripts/contract/record-invoicing.ts",
      })
      const answer = outcome.ok ? outcome.result : { thrown: outcome.error }
      await step.after?.(answer, state)
      const summary = JSON.stringify(answer)?.slice(
        0,
        process.env.CONTRACT_RECORD_DEBUG ? 3000 : 200,
      )
      if (step.record === false) continue
      if (only && !only.has(step.entry)) continue
      const rejected =
        !outcome.ok ||
        (answer !== null && typeof answer === "object" && "error" in (answer as object))
      if (rejected && fixture.calls.length === 0) {
        say(`WEAK ${step.entry}: rejected its input before any call, not written | ${summary}`)
        continue
      }
      const scrubbed = scrubFixture(fixture, replacements)
      const problem = await verifyFixture({
        isolate: entryIsolate,
        entry,
        fixture: scrubbed,
        surface,
        limits: productionLimits(entry),
      })
      if (problem) {
        say(`FAIL ${step.entry}: ${problem} | ${summary}`)
        continue
      }
      const leaked = [TOKEN, SHOP].filter((s) => JSON.stringify(scrubbed).includes(s))
      expect(leaked).toEqual([])
      writeFixture(FIXTURES_DIR, APP, scrubbed)
      own?.dispose()
      say(`ok   ${step.entry} (${scrubbed.calls.length} calls): ${summary}`)
    }
    console.log(`\n${report.join("\n")}\n`)
  }, 1_800_000)
})
