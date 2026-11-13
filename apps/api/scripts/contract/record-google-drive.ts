// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the google-drive app's contract fixtures (fixtures/google-drive/*.json). Not part of
// any suite: a developer runs it by path when the app's calls change, then reads what it wrote
// and commits it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-google-drive.ts)
//
// The provider is a fake Google Drive v3 answering the REAL transport: every call leaves through
// the live bridge (`ctx.fetch` with `auth.account`, `files_importFromUrl`), which adds the
// connected account's token host-side; the fake server checks that token and answers from a
// small fixed tree. No real Google account is involved (the test env carries none). Everything
// else is live: the contract org's connected accounts, its Knowledge sources, the page link, the
// account metadata writes. Each entry runs once on the live bridge, then its fixture is scrubbed
// and replayed twice before it is written. The contract org's rows are removed at the end.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
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
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "google-drive"
const FIXTURES_DIR = join(import.meta.dir, "../../src/modules/apps/contract/fixtures")
const RECORDED_FROM =
  "a contract org's Drive accounts against a fake Google Drive v3 reached through the live bridge transport, scripts/contract/record-google-drive.ts"
const TOKENS = {
  personal: "ya29.contract-personal-token",
  org: "ya29.contract-org-token",
  gone: "ya29.contract-gone-token",
}
const ACC = {
  personal: "00000000-0000-4000-8000-00000000d001",
  org: "00000000-0000-4000-8000-00000000d002",
  gone: "00000000-0000-4000-8000-00000000d003",
}
const DOC = "application/vnd.google-apps.document"
const FOLDER = "application/vnd.google-apps.folder"
const FULL = ["https://www.googleapis.com/auth/drive.readonly"]
const PICKED = ["https://www.googleapis.com/auth/drive.file"]

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

/** The fake Drive's tree: My Drive files of the personal account, one shared drive. */
const FILES: Record<
  string,
  { name: string; mimeType: string; parents?: string[]; driveId?: string; body?: string }
> = {
  root0001: { name: "Handbook", mimeType: FOLDER },
  doc00001: { name: "Onboarding plan", mimeType: DOC, parents: ["root0001"] },
  note0001: {
    name: "notes.md",
    mimeType: "text/markdown",
    parents: ["root0001"],
    body: "# Notes\nShip on Friday.",
  },
  sub00001: { name: "Specs", mimeType: FOLDER, parents: ["root0001"] },
  spec0001: { name: "Spec", mimeType: DOC, parents: ["sub00001"] },
  scan0001: {
    name: "Scan.pdf",
    mimeType: "application/pdf",
    parents: ["root0001"],
    body: "%PDF-1.4 contract",
  },
  team0001: { name: "Team plan", mimeType: DOC, driveId: "DRIVE_TEAM" },
}

/** The fake Google Drive: refuses a call without one of the contract accounts' tokens. */
async function fakeDrive(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const auth = new Headers(init?.headers).get("authorization") ?? ""
  if (!Object.values(TOKENS).some((t) => auth === `Bearer ${t}`)) {
    return Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 })
  }
  const path = url.pathname.replace(/^\/(upload\/)?drive\/v3/, "")
  const q = url.searchParams
  const meta = (id: string) => {
    const f = FILES[id]
    return f
      ? {
          id,
          name: f.name,
          mimeType: f.mimeType,
          ...(f.driveId ? { driveId: f.driveId } : {}),
          modifiedTime: "2026-11-01T09:00:00.000Z",
          webViewLink: `https://drive.google.com/file/d/${id}/view`,
          capabilities: { canDownload: true },
        }
      : null
  }
  if (path === "/files" && q.get("uploadType") === "multipart") {
    return Response.json({
      id: "upload0001",
      webViewLink: "https://drive.google.com/file/d/upload0001/view",
    })
  }
  if (path === "/files" && (init?.method ?? "GET") === "POST")
    return Response.json({ id: "reports001" })
  if (path === "/files") {
    const query = q.get("q") ?? ""
    if (query.includes("appProperties")) return Response.json({ files: [] })
    const parent = /'([^']+)' in parents/.exec(query)?.[1]
    const driveId = q.get("driveId")
    const words = /contains '([^']+)'/.exec(query)?.[1]?.toLowerCase()
    const files = Object.keys(FILES)
      .filter((id) => (parent ? FILES[id]?.parents?.includes(parent) : true))
      .filter((id) => (driveId ? FILES[id]?.driveId === driveId : !FILES[id]?.driveId))
      .filter((id) => !words || (FILES[id]?.name.toLowerCase().includes(words) ?? false))
      .map(meta)
    return Response.json({ files })
  }
  if (path === "/drives") return Response.json({ drives: [{ id: "DRIVE_TEAM", name: "Team" }] })
  const id = /^\/files\/([^/?]+)/.exec(path)?.[1] ?? ""
  const f = FILES[id]
  if (!f)
    return Response.json(
      { error: { code: 404, message: `File not found: ${id}` } },
      { status: 404 },
    )
  if (path.endsWith("/export")) {
    return new Response(`${f.name}\nExported as ${q.get("mimeType")}.`, {
      headers: { "content-type": "text/plain" },
    })
  }
  if (q.get("alt") === "media")
    return new Response(f.body ?? f.name, { headers: { "content-type": f.mimeType } })
  return Response.json(meta(id))
}

const SOURCE_ID = "00000000-0000-4000-8000-00000000d010"
const ROLE_ID = "00000000-0000-4000-8000-00000000d011"
const pick = { id: "doc00001", name: "Onboarding plan", mimeType: DOC }

/** Each entry with the input a production run of it gets, and the state it runs in. */
const PLAN: Array<{ entry: string; params?: unknown; before?: () => Promise<void> }> = [
  { entry: "tool:search", params: { query: "plan" } },
  { entry: "tool:read", params: { driveFileId: "note0001" } },
  { entry: "knowledge-items:search", params: { query: "plan", limit: 5, cursor: null } },
  { entry: "knowledge-items:resolve", params: { ref: "note0001", content: true } },
  { entry: "tool:import", params: { driveFileId: "scan0001" } },
  {
    entry: "tool:upload",
    params: {
      name: "Report.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("Weekly report").toString("base64"),
    },
  },
  { entry: "tool:shared_drives", params: {} },
  { entry: "tool:choose_shared_drives", params: { drives: ["Team"], account: "team@example.com" } },
  { entry: "tool:shared_drives_save", params: { drives: ["Team"], account: "team@example.com" } },
  {
    entry: "knowledge-sync:folder",
    params: {
      sourceId: SOURCE_ID,
      kind: "folder",
      config: { ref: "root0001" },
      cursor: null,
      scope: "personal",
    },
  },
  { entry: "export:export", params: { format: "json" } },
  {
    entry: "provision:handler",
    params: {
      config: { sharedDrives: [{ account: "team@example.com", drives: ["Team"] }] },
      dryRun: false,
    },
  },
  {
    entry: "event:kernel/connected_account:disconnect",
    params: {
      app: "kernel",
      entity: "connected_account",
      action: "disconnect",
      data: { id: ACC.gone, appName: APP },
    },
  },
  // Picked mode from here on: the person's account was granted drive.file only.
  {
    entry: "tool:drive_picker",
    params: {},
    before: async () => {
      await sql`UPDATE kernel.connected_accounts
        SET metadata = ${JSON.stringify({ grantedOAuthScopes: PICKED, pickedItems: [pick] })}::jsonb
        WHERE id = ${ACC.personal}`
    },
  },
  { entry: "tool:picker_state", params: {} },
  {
    entry: "route:savePicks",
    params: { body: { add: [pick] }, params: { account: ACC.personal }, page: "picker" },
  },
  {
    entry: "knowledge-sync:picked",
    params: {
      sourceId: SOURCE_ID,
      kind: "picked",
      config: { account: "ana@example.com" },
      cursor: null,
      scope: "personal",
    },
  },
  { entry: "tool:picker_remove", params: { account: ACC.personal, itemId: "doc00001" } },
]

describe("record google-drive contract fixtures", () => {
  let isolate: ContractIsolate
  let bridgeManifest: unknown
  const surface = bridgeSurfaceOf(APP)
  const entries = new Map(contractEntries(manifest).map((e) => [e.entry, e]))

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM app_knowledge.synced_sources WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    await sql`DELETE FROM kernel.app_documents WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "www.googleapis.com")
    SandboxBridgeTestAccess.setFetch(fakeDrive as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${CONTRACT_ORG_ID}, 'Contract recording', 'contract-recording') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${CONTRACT_USER_ID}, ${CONTRACT_ORG_ID}, 'recorder@example.com', 'Contract Recorder', 'x')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(CONTRACT_ORG_ID)
    // The person the page opens for holds the page's scope (a page re-checks it).
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_ID}, ${CONTRACT_ORG_ID}, 'drive-reader', 'Contract role') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${ROLE_ID}, 'google-drive:accounts:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${CONTRACT_USER_ID}, ${ROLE_ID}, ${CONTRACT_ORG_ID}) ON CONFLICT DO NOTHING`
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
    bridgeManifest = (toolRegistry.get([CONTRACT_ORG_ID, APP, "search"]) as { _manifest?: unknown })
      ?._manifest
    if (!bridgeManifest) throw new Error("google-drive did not register")
    await cleanup()
    // The Google Picker's key and project number, as an admin sets them (apps[].config).
    const pickerConfig = JSON.stringify({
      pickerApiKey: "contract-picker-key",
      pickerAppId: "123456789",
    })
    await sql`INSERT INTO kernel.apps (org_id, name, version, status, config)
      VALUES (${CONTRACT_ORG_ID}, ${APP}, ${manifest.version}, 'active', ${pickerConfig}::jsonb)
      ON CONFLICT (org_id, name) DO UPDATE SET config = COALESCE(kernel.apps.config, '{}'::jsonb) || EXCLUDED.config`
    const token = (t: string) =>
      encryptSecret(t, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)
    const base = {
      orgId: CONTRACT_ORG_ID,
      appName: APP,
      connectionName: "drive",
      providerType: "oauth2",
      createdBy: CONTRACT_USER_ID,
    }
    await seedConnectedAccountRow({
      ...base,
      id: ACC.personal,
      ownerType: "user",
      ownerId: CONTRACT_USER_ID,
      identifier: "ana@example.com",
      accessTokenEncrypted: token(TOKENS.personal),
      status: "active",
      metadata: { grantedOAuthScopes: FULL },
    })
    await seedConnectedAccountRow({
      ...base,
      id: ACC.org,
      ownerType: "org",
      identifier: "team@example.com",
      accessTokenEncrypted: token(TOKENS.org),
      status: "active",
      metadata: {},
    })
    await seedConnectedAccountRow({
      ...base,
      id: ACC.gone,
      ownerType: "user",
      ownerId: CONTRACT_USER_ID,
      identifier: "old@example.com",
      accessTokenEncrypted: token(TOKENS.gone),
      status: "disconnected",
    })
    const scripts = await bundledAppScripts(join(BUNDLED_APPS_DIR, APP))
    isolate = await quickJsContractExecutor.open(scripts.source, { memoryBytes: 64 * 1024 * 1024 })
  }, 300_000)

  afterAll(async () => {
    isolate?.dispose()
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await cleanup()
    await teardownAppRegistrations(CONTRACT_ORG_ID, APP)
    toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
    initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
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

  it("records every entry", async () => {
    const replacements: Replacement[] = Object.values(TOKENS).map((t) => ({
      from: t,
      to: "redacted",
    }))
    const report: string[] = []
    for (const step of PLAN) {
      await step.before?.()
      const entry = entries.get(step.entry)
      if (!entry)
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
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
        (answer !== null && typeof answer === "object" && "error" in (answer as object))
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
      for (const t of Object.values(TOKENS))
        expect(JSON.stringify(scrubbed).includes(t)).toBe(false)
      writeFixture(FIXTURES_DIR, APP, scrubbed)
      report.push(`ok   ${step.entry} (${scrubbed.calls.length} calls): ${summary}`)
    }
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => l.startsWith("FAIL"))).toEqual([])
  }, 600_000)
})
