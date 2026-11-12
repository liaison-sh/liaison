// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the api-connector app's contract fixtures (fixtures/api-connector/*.json). Not part
// of any suite: a developer runs it by path when the app's calls change, then reads what it
// wrote and commits it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-api-connector.ts)
//
// The provider is a real HTTP API: the fixture CRM (connections/api/__fixtures__/fixture-crm)
// served on a loopback port, reached through the platform-held API connection (`ctx.api`),
// so every call goes through the real transport (render, auth, fetch, projection). The
// connection's API key is stored as an org account and never crosses the bridge. Every entry
// runs once on the live bridge; a run that the live bridge refused writes nothing and fails the
// recording. Its fixture is scrubbed and replayed twice before it is written. The contract
// org's rows are removed at the end.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import {
  fixtureCrmAdapterText,
  loadFixtureCrmAdapter,
} from "~/modules/apps/connections/api/__fixtures__/fixture-crm/adapter"
import { startFixtureCrm } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/server"
import { createCredentialConnection } from "~/modules/apps/connections/service"
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
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "api-connector"
const FIXTURES_DIR = join(import.meta.dir, "../../src/modules/apps/contract/fixtures")
const API_KEY = "contract-recording-key"
/** The origin every fixture names, whatever port this run's server took. */
const STABLE_ORIGIN = "http://127.0.0.1:4010"
const RECORDED_FROM =
  "a contract org connected to the fixture CRM over a loopback port, scripts/contract/record-api-connector.ts"

type Manifest = Record<string, unknown> & { version: string; scopes: string[] }
const manifest = JSON.parse(
  readFileSync(join(BUNDLED_APPS_DIR, APP, "app.manifest.json"), "utf8"),
) as Manifest

const actor: UserContext = {
  actorType: "user",
  userId: CONTRACT_USER_ID,
  orgId: CONTRACT_ORG_ID,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

describe("record api-connector contract fixtures", () => {
  let isolate: ContractIsolate
  let crm: ReturnType<typeof startFixtureCrm>
  let bridgeManifest: unknown
  const surface = bridgeSurfaceOf(APP, undefined, manifest)
  const entries = new Map(contractEntries(manifest).map((e) => [e.entry, e]))

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    // The fixture CRM is plain http on loopback (development hosts only).
    process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS = "true"
    crm = startFixtureCrm({ apiKey: API_KEY, referenceDate: new Date("2026-05-15T00:00:00Z") })

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
          _bundlePath: join(BUNDLED_APPS_DIR, APP, manifest.version, "bundle.js"),
        },
      ] as never,
      CONTRACT_ORG_ID,
    )
    bridgeManifest = (
      toolRegistry.get([CONTRACT_ORG_ID, APP, "connector_read"]) as { _manifest?: unknown }
    )?._manifest
    if (!bridgeManifest) throw new Error("api-connector did not register")
    await cleanRows()
    // The connection: the fixture CRM's adapter at this run's port, and its API key.
    const { upsertAdapterRow } = await import("~/modules/apps/connections/api/store")
    const adapter = loadFixtureCrmAdapter({ baseUrl: crm.baseUrl })
    // An earlier version kept in the history (restored below), then the current one.
    await upsertAdapterRow(CONTRACT_ORG_ID, "crm", { ...adapter, version: "0.9.0" }, null)
    await upsertAdapterRow(CONTRACT_ORG_ID, "crm", adapter, null)
    await withPrivilegedDb(CONTRACT_ORG_ID, "contract-record-api-connector", (tx) =>
      createCredentialConnection(tx, CONTRACT_ORG_ID, CONTRACT_USER_ID, APP, "api", {
        identifier: "crm",
        ownerType: "org",
        displayName: "Fixture CRM",
        credentials: { apiKey: API_KEY },
      }),
    )
    const scripts = await bundledAppScripts(join(BUNDLED_APPS_DIR, APP))
    isolate = await quickJsContractExecutor.open(scripts.source, { memoryBytes: 64 * 1024 * 1024 })
  }, 300_000)

  async function cleanRows(): Promise<void> {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    await sql`DELETE FROM app_api_connector.adapter_versions WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`DELETE FROM app_api_connector.adapters WHERE org_id = ${CONTRACT_ORG_ID}`
  }

  afterAll(async () => {
    isolate?.dispose()
    await teardownAppRegistrations(CONTRACT_ORG_ID, APP)
    toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
    initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
    await cleanRows()
    await crm?.stop()
    delete process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS
    await releaseTestLock()
  })

  function liveBridge(): AppBridge {
    return createSessionRpcBridge(
      APP,
      CONTRACT_USER_ID,
      CONTRACT_ORG_ID,
      { run: (fn) => withRlsContext(actor, fn) },
      bridgeManifest as never,
      ["*"],
      "user",
      undefined,
      { actor } as never,
    ) as AppBridge
  }

  async function live(method: string, request: unknown): Promise<Record<string, unknown>> {
    const fn = (liveBridge() as unknown as Record<string, (j: string) => Promise<string>>)[method]
    if (!fn) throw new Error(`no bridge method ${method}`)
    return JSON.parse(await fn(JSON.stringify(request))) as Record<string, unknown>
  }

  it("records every entry", async () => {
    const write = {
      connection: "crm",
      operation: "create_note",
      params: { customerId: "cmp_001", text: "Called back about the Q3 order." },
    }
    // What the preflight pins at staging: the write runs on exactly that target.
    const validated = await live("api_writeValidate", write)
    const target = (validated.pinnedParams as { target?: unknown } | undefined)?.target
    if (!target) throw new Error(`the write did not validate: ${JSON.stringify(validated)}`)
    const versions = await live("api_adapterVersions", { identifier: "crm" })
    const versionId = (versions.versions as Array<{ id: string }> | undefined)?.[0]?.id
    if (!versionId) throw new Error(`no kept version: ${JSON.stringify(versions)}`)
    const document = fixtureCrmAdapterText().replace(
      /^baseUrl: .*$/m,
      `baseUrl: ${crm.baseUrl}`,
    )

    /** Each entry with the input a production run of it gets, in the order they can run. */
    const plan: Array<{ entry: string; params?: unknown }> = [
      { entry: "tool:connector_list_operations", params: {} },
      {
        entry: "tool:connector_read",
        params: {
          connection: "crm",
          operation: "find_customers",
          params: { email: "jane.doe@acme-instruments.example" },
        },
      },
      { entry: "preflight:connector_write", params: write },
      { entry: "tool:connector_write", params: { ...write, target } },
      { entry: "summarizer:connector_write", params: { ...write, target } },
      { entry: "tool:connector_adapter_reference", params: { section: "auth" } },
      { entry: "tool:connector_adapter_get", params: { identifier: "crm" } },
      { entry: "tool:connector_adapter_versions", params: { identifier: "crm" } },
      {
        entry: "tool:connector_adapter_test",
        params: { identifier: "crm", operation: "list_companies", params: {} },
      },
      { entry: "tool:settings_connections", params: {} },
      {
        entry: "tool:settings_adapter_test",
        params: { identifier: "crm", operation: "list_companies", params: {} },
      },
      {
        entry: "tool:customer_lookup",
        params: { email: "jane.doe@acme-instruments.example" },
      },
      { entry: "tool:settings_adapter_save", params: { identifier: "crm-eu", document } },
      {
        entry: "tool:settings_adapter_restore",
        params: { identifier: "crm", versionId },
      },
      { entry: "tool:settings_adapter_delete", params: { identifier: "crm-eu" } },
      {
        entry: "provision:handler",
        params: {
          config: { connectors: [{ identifier: "crm-us", adapter: document }] },
          dryRun: false,
        },
      },
      { entry: "provision:verify", params: { config: {} } },
    ]

    const replacements: Replacement[] = [
      { from: crm.origin, to: STABLE_ORIGIN },
      { from: `127.0.0.1:${crm.port}`, to: STABLE_ORIGIN.slice("http://".length) },
      { from: API_KEY, to: "redacted" },
    ]
    const report: string[] = []
    for (const step of plan) {
      const entry = entries.get(step.entry)
      if (!entry) {
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
      }
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry,
        input: { params: step.params },
        real: liveBridge(),
        surface,
        limits: productionLimits(entry),
        recordedFrom: RECORDED_FROM,
      })
      const answer = outcome.ok ? outcome.result : { thrown: outcome.error }
      const summary = JSON.stringify(answer)?.slice(
        0,
        process.env.CONTRACT_RECORD_DEBUG ? 3000 : 240,
      )
      const rejected =
        !outcome.ok ||
        (answer !== null &&
          typeof answer === "object" &&
          ("error" in (answer as object) ||
            (answer as { ok?: unknown }).ok === false ||
            (answer as { result?: unknown }).result === "FAILED"))
      if (rejected) {
        report.push(`FAIL ${step.entry}: the live run refused | ${summary}`)
        continue
      }
      const scrubbed = scrubFixture(fixture, replacements)
      const problem = await verifyFixture({
        isolate,
        entry,
        fixture: scrubbed,
        surface,
        limits: productionLimits(entry),
      })
      if (problem) {
        report.push(`FAIL ${step.entry}: ${problem} | ${summary}`)
        continue
      }
      expect(JSON.stringify(scrubbed).includes(API_KEY)).toBe(false)
      writeFixture(FIXTURES_DIR, APP, scrubbed)
      report.push(`ok   ${step.entry} (${scrubbed.calls.length} calls): ${summary}`)
    }
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => l.startsWith("FAIL"))).toEqual([])
    // The write reached the CRM once, through the real transport.
    expect(crm.handler.notes.map((n) => n.body)).toContain("Called back about the Q3 order.")
  }, 600_000)
})
