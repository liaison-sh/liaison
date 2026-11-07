// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The in-product app builder end to end, on a real database, the real
// sandbox pool and the real install path (modules/app-builder):
//   - the templates pass check and preview as they are;
//   - preview isolation: store writes in `draft:<id>` only (wiped at the next
//     preview and after a day), ctx.db -> preview_no_schema before the first
//     publish, ctx.fetch only to hosts the ACTIVE version was granted, no
//     secret / config / auth / cross-app call, logs returned;
//   - publish pinning: the approval pins name, version, sha and grants; a
//     draft changed after the request installs nothing of the change; an
//     altered or missing sha and a moved app refuse; the request takes no edit;
//   - a person holding kernel:apps:admin publishes through REST, ungated; the
//     cap counts the first publish only; a builder app's ui.js is never trusted;
//   - identity: an app installed by URL, or another draft's app, is refused.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, type UserContext, withRlsContext } from "~/db/rls"
import { checkDraft } from "~/modules/app-builder/check"
import {
  createDraft,
  type DraftCaller,
  DraftError,
  draftAppName,
  getDraft,
  updateDraftFiles,
} from "~/modules/app-builder/drafts"
import { pruneDraftStoreNamespaces } from "~/modules/app-builder/installed"
import { createRunLogSink } from "~/modules/app-builder/logs"
import { PreviewTestAccess, previewDraft, previewManifest } from "~/modules/app-builder/preview"
import { executePublish, preparePublish } from "~/modules/app-builder/publish"
import { templateFiles } from "~/modules/app-builder/templates"
import { decideApproval } from "~/modules/approvals/decide"
import { UpdatePayloadError, updatePayload } from "~/modules/approvals/edit"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { getInstallTrust, resetInstallTrustCache } from "~/modules/apps/install-trust"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { draftStoreApp, getDocument, setDocument } from "~/modules/data-store/service"
import { setOrgCaps } from "~/modules/org/caps"
import { purgeOrgCustomApps } from "~/modules/org/purge/purge-org"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let bearer = ""
let admin: UserContext
let installRoot = ""
const savedAppsDir = process.env.LIAISON_APPS_DIR

const caller = (): DraftCaller => ({ orgId, userId: adminId })
const asAdmin = <T>(fn: (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => Promise<T>) =>
  withRlsContext(admin, fn)
const actor = () => ({ orgId, userId: adminId, scopes: admin.scopes })

/** A draft's files: a manifest for `appName` plus the given handlers and tools. */
function probeFiles(
  appName: string,
  tools: Record<string, Record<string, unknown>>,
  handlers: string,
  extra: Record<string, unknown> = {},
): Record<string, string> {
  const read = `${appName}:items:read`
  const manifest = {
    name: appName,
    version: "0.1.0",
    packageFormat: 1,
    host: "^1",
    license: "UNLICENSED",
    displayName: "Probe",
    description: "Probe",
    scopes: [read],
    store: { collections: { items: { readScope: read } } },
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [
        name,
        {
          description: name,
          requiredScopes: [read],
          handler: name,
          params: { type: "object", properties: {} },
          ...t,
        },
      ]),
    ),
    ...extra,
  }
  return { "app.manifest.json": JSON.stringify(manifest, null, 2), "handlers.ts": handlers }
}

async function newDraft(base: string, files?: Record<string, string>) {
  const appName = draftAppName(orgId, base)
  const { draft } = await asAdmin((tx) =>
    createDraft(tx, caller(), {
      baseName: base,
      title: `Draft ${base}`,
      files: files ?? templateFiles("store-crud", appName, `Draft ${base}`),
    }),
  )
  return { draftId: draft.id, appName }
}

async function storeRows(app: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.app_documents WHERE org_id = ${orgId} AND app = ${app}`
  return row?.n ?? 0
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (err) {
    if (err instanceof DraftError || err instanceof UpdatePayloadError) return err.code
    return String((err as { code?: unknown }).code ?? (err as Error).message)
  }
}

async function restPublish(draftId: string, body: Record<string, unknown> = {}) {
  return app.request(`/api/apps/builder/drafts/${draftId}/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "app-builder-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
  orgId = (await createTestOrg()).id
  const person = await minimal.orgAdmin(orgId)
  adminId = person.id
  bearer = await minimal.token(adminId)
  const perms = await withPrivilegedDb(orgId, "app-builder-test-perms", (tx) =>
    loadEffectivePermissions(tx, adminId, orgId),
  )
  admin = {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
  await ensureAppsForOrg(orgId)
}, 120_000)

afterAll(async () => {
  await purgeOrgCustomApps(orgId).catch(() => undefined)
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
  await shutdownWorkerPool()
  if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = savedAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
}, 120_000)

describe("templates", () => {
  it("store-crud passes check and preview as it is; its write lands in the draft's namespace only", async () => {
    const { draftId, appName } = await newDraft("tpl-crud")
    const checked = await asAdmin((tx) => checkDraft(tx, caller(), { draftId }))
    expect(checked.errors).toEqual([])
    expect(checked.ok).toBe(true)
    expect(checked.appName).toBe(appName)
    expect(checked.appVersion).toBe("0.1.0")

    const added = await previewDraft(actor(), {
      draftId,
      entry: { kind: "tool", name: "items_add" },
      params: { title: "First" },
    })
    expect(added.error).toBeUndefined()
    expect(added.ok).toBe(true)
    expect(added.storeNamespace).toBe(`draft:${draftId}`)
    expect(added.logs.map((l) => l.message)).toContain("added an item")
    expect(await storeRows(`draft:${draftId}`)).toBe(1)
    expect(await storeRows(appName)).toBe(0)

    // The next preview of the draft starts from an empty namespace.
    const listed = await previewDraft(actor(), {
      draftId,
      entry: { kind: "tool", name: "items_list" },
    })
    expect(listed.ok).toBe(true)
    expect((listed.result as { items: unknown[] }).items).toEqual([])
    expect(await storeRows(`draft:${draftId}`)).toBe(0)
  }, 120_000)

  it("read-only passes check and preview as it is", async () => {
    const appName = draftAppName(orgId, "tpl-read")
    const { draftId } = await newDraft("tpl-read", templateFiles("read-only", appName, "Read"))
    expect((await asAdmin((tx) => checkDraft(tx, caller(), { draftId }))).ok).toBe(true)
    const r = await previewDraft(actor(), { draftId, entry: { kind: "tool", name: "summary" } })
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ count: 0 })
  }, 120_000)
})

describe("preview isolation", () => {
  const PROBES = `import { type AppContext, defineHandlers } from "@liaison/app-sdk"
async function attempt(fn: () => Promise<unknown>) {
  try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? null, message: String((e as Error).message ?? e) } }
}
export async function probe_db(_p: Record<string, never>, ctx: AppContext) {
  return attempt(() => ctx.db.findMany("things", {}))
}
export async function probe_fetch(p: { url: string; secret?: boolean }, ctx: AppContext) {
  return attempt(() => ctx.fetch(p.url, p.secret ? { method: "POST", configSecrets: { k: "$k" } } as never : { method: "GET" }))
}
export async function probe_config(_p: Record<string, never>, ctx: AppContext) {
  return attempt(() => ctx.config.get("k"))
}
export async function probe_store(_p: Record<string, never>, ctx: AppContext) {
  await ctx.store.set("items", "x", { v: 1 })
  ctx.logger.warn("wrote x")
  return { got: await ctx.store.get("items", "x") }
}
export default defineHandlers({ probe_db, probe_fetch, probe_config, probe_store })
`
  const tools = {
    probe_db: {},
    probe_fetch: {
      params: {
        type: "object",
        properties: { url: { type: "string" }, secret: { type: "boolean" } },
      },
    },
    probe_config: {},
    probe_store: {},
  }
  let draftId = ""
  let appName = ""

  beforeAll(async () => {
    appName = draftAppName(orgId, "probes")
    ;({ draftId } = await newDraft(
      "probes",
      probeFiles(appName, tools, PROBES, {
        network: { allowedDomains: ["api.example.com", "evil.example.org"] },
      }),
    ))
  }, 60_000)

  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const r = await previewDraft(actor(), { draftId, entry: { kind: "tool", name }, params })
    expect(r.error).toBeUndefined()
    return r.result as { ok: boolean; code?: string | null; message?: string; value?: unknown }
  }

  it("ctx.db answers preview_no_schema before the first publish", async () => {
    const r = await run("probe_db")
    expect(r.ok).toBe(false)
    expect(r.code).toBe("preview_no_schema")
  }, 60_000)

  it("ctx.fetch: a host the draft declares but no published version was granted is refused", async () => {
    const r = await run("probe_fetch", { url: "https://api.example.com/x" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Domain not in allowlist")
  }, 60_000)

  it("no config value and no configSecrets in a preview", async () => {
    const config = await run("probe_config")
    expect(config.ok).toBe(false)
    expect(config.code).toBe("secret_not_available_on_workers")
  }, 60_000)

  it("store writes land in draft:<id> only, never the app's or another draft's; wiped next preview and after a day", async () => {
    const other = await newDraft("other-ns")
    await asAdmin(async (tx) => {
      await setDocument(tx, { orgId, app: appName, userId: adminId }, "items", "x", { v: "real" })
      await setDocument(
        tx,
        { orgId, app: draftStoreApp(other.draftId), userId: adminId },
        "items",
        "x",
        {
          v: "other",
        },
      )
    })
    const r = await previewDraft(actor(), {
      draftId,
      entry: { kind: "tool", name: "probe_store" },
    })
    expect(r.ok).toBe(true)
    expect((r.result as { got: { data: { v: number } } }).got.data.v).toBe(1)
    expect(r.logs.some((l) => l.level === "warn" && l.message === "wrote x")).toBe(true)
    const real = await asAdmin((tx) =>
      getDocument(tx, { orgId, app: appName, userId: null }, "items", "x"),
    )
    expect(real?.data).toEqual({ v: "real" })
    const otherDoc = await asAdmin((tx) =>
      getDocument(tx, { orgId, app: draftStoreApp(other.draftId), userId: null }, "items", "x"),
    )
    expect(otherDoc?.data).toEqual({ v: "other" })
    expect(await storeRows(`draft:${draftId}`)).toBe(1)
    // A day later the namespace goes; the app's and the other draft's written now stay.
    await sql`UPDATE kernel.app_documents SET updated_at = now() - interval '25 hours'
      WHERE org_id = ${orgId} AND app = ${`draft:${draftId}`}`
    await pruneDraftStoreNamespaces()
    expect(await storeRows(`draft:${draftId}`)).toBe(0)
    expect(await storeRows(appName)).toBe(1)
    expect(await storeRows(draftStoreApp(other.draftId))).toBe(1)
    await sql`DELETE FROM kernel.app_documents WHERE org_id = ${orgId} AND app = ${appName}`
    await sql`DELETE FROM kernel.app_document_usage WHERE org_id = ${orgId} AND app = ${appName}`
  }, 60_000)

  it("the preview bridge refuses every secret, credential, mail account and cross-app call", async () => {
    const manifest = previewManifest(
      JSON.parse(probeFiles(appName, tools, PROBES)["app.manifest.json"]),
      null,
    )
    const session = createRlsSession({ ...admin, scopes: [`${appName}:items:read`] })
    const bridge = PreviewTestAccess.previewBridge({
      appName,
      draftId,
      actor: actor(),
      session,
      manifest,
      callerScopes: [`${appName}:items:read`],
      neverPublished: true,
      sink: createRunLogSink({ orgId, app: appName, draftId, scopeTags: [] }),
    })
    const refusedCode = (name: string, ...args: unknown[]) =>
      code(Promise.resolve().then(() => bridge[name](...args)))
    expect(await refusedCode("connections_getToken", "x")).toBe("preview_refused")
    expect(await refusedCode("connections_getCredentials", "x")).toBe("preview_refused")
    expect(await refusedCode("config_get", "anything")).toBe("secret_not_available_on_workers")
    for (const name of Object.keys(bridge).filter((n) => /ForConfig$|^(imap|smtp|mcp)_/.test(n))) {
      expect(await refusedCode(name)).toBe("preview_refused")
    }
    expect(
      await refusedCode(
        "fetch",
        "https://api.example.com/",
        JSON.stringify({ auth: { connection: "x" } }),
      ),
    ).toBe("preview_refused")
    expect(await refusedCode("executeTool", "kernel:tickets_search", "{}")).toBe("preview_refused")
    expect(await refusedCode("db_insert", "things", "{}")).toBe("preview_no_schema")
  }, 60_000)

  it("once published, a preview reaches the hosts that version was granted, not a host only the draft adds", async () => {
    // v1 (granted at publish): api.example.com only.
    const base = "probes-pub"
    const name = draftAppName(orgId, base)
    const { draftId: pubId } = await newDraft(
      base,
      probeFiles(name, tools, PROBES, { network: { allowedDomains: ["api.example.com"] } }),
    )
    expect((await restPublish(pubId)).status).toBe(200)
    // v2 adds a host nobody granted.
    await asAdmin((tx) =>
      updateDraftFiles(tx, caller(), {
        draftId: pubId,
        files: probeFiles(name, tools, PROBES, {
          network: { allowedDomains: ["api.example.com", "evil.example.org"] },
        }),
        message: "adds a host",
      }),
    )
    const lookup = spyOn(dnsPromises, "lookup").mockImplementation((async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    }) as unknown as typeof dnsPromises.lookup)
    try {
      const go = async (url: string) =>
        (
          await previewDraft(actor(), {
            draftId: pubId,
            entry: { kind: "tool", name: "probe_fetch" },
            params: { url },
          })
        ).result as { ok: boolean; message?: string }
      const granted = await go("https://api.example.com/x")
      expect(granted.message ?? "").not.toContain("Domain not in allowlist")
      const added = await go("https://evil.example.org/x")
      expect(added.ok).toBe(false)
      expect(added.message).toContain("Domain not in allowlist")
      const secret = await previewDraft(actor(), {
        draftId: pubId,
        entry: { kind: "tool", name: "probe_fetch" },
        params: { url: "https://api.example.com/x", secret: true },
      })
      expect((secret.result as { code?: string }).code).toBe("preview_refused")
      // ctx.db exists now (it refuses for its own reasons, not as a never-published draft).
      const db = await previewDraft(actor(), {
        draftId: pubId,
        entry: { kind: "tool", name: "probe_db" },
      })
      expect(db.neverPublished).toBe(false)
      expect((db.result as { code?: string }).code).not.toBe("preview_no_schema")
    } finally {
      lookup.mockRestore()
    }
  }, 180_000)

  it("grants come from the active version only: domains, capabilities and cross-app calls", () => {
    const draft = {
      network: { allowedDomains: ["api.example.com", "evil.example.org"] },
      capabilities: ["messages.post", "grants.setUserScopes"],
      cross_app_calls: [
        { target: "knowledge:search", reason: "r" },
        { target: "mail:compose", reason: "r" },
      ],
      connections: { crm: { allowedDomains: ["crm.example.com"] } },
    }
    const never = previewManifest(draft, null)
    expect((never.network as { allowedDomains: string[] }).allowedDomains).toEqual([])
    expect(never.capabilities).toEqual([])
    expect(never.allowedCrossAppCalls).toEqual([])
    expect(never.connections).toEqual({})
    const active = previewManifest(draft, {
      name: "x",
      version: "0.1.0",
      sha256: "0".repeat(64),
      sourceUrl: null,
      grantedScopes: [],
      grantedConnections: [],
      grantedCapabilities: ["messages.post"],
      grantedCrossAppCalls: ["knowledge:search"],
      manifest: { network: { allowedDomains: ["api.example.com"] } },
    })
    expect((active.network as { allowedDomains: string[] }).allowedDomains).toEqual([
      "api.example.com",
    ])
    expect(active.capabilities).toEqual(["messages.post"])
    expect(active.allowedCrossAppCalls).toEqual(["knowledge:search"])
  })
})

describe("REST and the preview frame", () => {
  it("serves a version's ui.js to a builder and its frame only against the token GET hands out", async () => {
    const appName = draftAppName(orgId, "framed")
    const { draftId } = await newDraft("framed", {
      ...templateFiles("store-crud", appName, "Framed"),
      "ui.tsx": `export default function Page() {\n  return <p data-testid="framed">hi</p>\n}\n`,
    })
    const auth = { authorization: `Bearer ${bearer}` }
    const check = await app.request(`/api/apps/builder/drafts/${draftId}/check`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    })
    expect(check.status).toBe(200)
    expect(((await check.json()) as { data: { ok: boolean } }).data.ok).toBe(true)
    const got = await app.request(`/api/apps/builder/drafts/${draftId}`, { headers: auth })
    const { data } = (await got.json()) as {
      data: { appName: string; preview: { frameUrl: string; uiUrl: string } | null }
    }
    expect(data.appName).toBe(appName)
    expect(data.preview).not.toBeNull()
    const ui = await app.request(data.preview!.uiUrl, { headers: auth })
    expect(ui.status).toBe(200)
    expect(ui.headers.get("content-type")).toContain("text/plain")
    expect(await ui.text()).toContain("framed")
    expect((await app.request(data.preview!.uiUrl)).status).toBe(401)
    expect((await app.request(`/api/apps/builder/drafts/${draftId}/1/frame`)).status).toBe(404)
    const frame = await app.request(data.preview!.frameUrl)
    expect(frame.status).toBe(200)
    expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    // The token is bound to this draft version: another version's frame refuses it.
    const t = new URL(`http://x${data.preview!.frameUrl}`).searchParams.get("t")
    expect(
      (await app.request(`/api/apps/builder/drafts/${draftId}/2/frame?t=${encodeURIComponent(t!)}`))
        .status,
    ).toBe(404)
    const preview = await app.request(`/api/apps/builder/drafts/${draftId}/preview`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ entry: { kind: "tool", name: "items_list" } }),
    })
    expect(((await preview.json()) as { data: { ok: boolean } }).data.ok).toBe(true)
  }, 180_000)
})

describe("publish", () => {
  it("a person holding kernel:apps:admin publishes through REST, ungated; a builder app's ui.js is never trusted", async () => {
    const appName = draftAppName(orgId, "rest-pub")
    const files = {
      ...templateFiles("store-crud", appName, "REST pub"),
      "ui.tsx": `export default function Page() {\n  return <p data-testid="rest-pub">hello</p>\n}\n`,
    }
    const { draftId } = await newDraft("rest-pub", files)
    const res = await restPublish(draftId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { appName: string; appVersion: string; sha256: string; firstPublish: boolean }
    }
    expect(body.data).toMatchObject({ appName, appVersion: "0.1.0", firstPublish: true })
    const [row] = await sql<
      { sha256: string; source_url: string; ui_full_access_approved_by: string | null }[]
    >`
      SELECT sha256, source_url, ui_full_access_approved_by FROM kernel.apps_installed
      WHERE name = ${appName} AND version = '0.1.0'`
    expect(row?.sha256).toBe(body.data.sha256)
    expect(row?.source_url).toBe(`builder:draft/${draftId}/1`)
    expect(row?.ui_full_access_approved_by).toBeNull()
    resetInstallTrustCache(appName)
    expect((await getInstallTrust(appName)).uiTrust).toBeNull()
    const [audit] = await sql<{ metadata: { sha256: string; draftId: string; n: number } }[]>`
      SELECT metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND action = 'app.custom.published' AND app = ${appName}`
    expect(audit?.metadata).toMatchObject({ sha256: body.data.sha256, draftId, n: 1 })

    // The published app runs on its own store namespace, not the draft's.
    const added = await executeTool({
      toolName: `${appName}:items_add`,
      orgId,
      actor: admin,
      params: { title: "Live" },
      origin: "human-ui",
    })
    expect(JSON.stringify(added)).not.toContain("error")
    expect(await storeRows(appName)).toBe(1)
  }, 180_000)

  it("the agent's request pins the bytes: a change after the request installs nothing of it, and the request takes no edit", async () => {
    const { draftId, appName } = await newDraft("pinned")
    const staged = (await executeTool({
      toolName: "kernel:apps_build_publish",
      orgId,
      actor: admin,
      params: { draftId, pin: { packageSha256: "f".repeat(64) } },
      origin: "in-app-agent",
    })) as unknown as Record<string, unknown>
    expect(JSON.stringify(staged)).toContain("approval")
    const [req] = await sql<
      {
        id: string
        current_payload: { pin: Record<string, unknown> }
        summary: { title: string; lines: string[] }
        approve_scope: string
      }[]
    >`
      SELECT id::text, current_payload, summary, approve_scope FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'kernel:apps_build_publish' AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`
    expect(req).toBeDefined()
    const pin = req!.current_payload.pin
    // The caller's own pin was dropped; the server's carries name, version, sha and grants.
    expect(pin).toMatchObject({ draftId, n: 1, appName, appVersion: "0.1.0", baseVersion: null })
    expect(pin.packageSha256).not.toBe("f".repeat(64))
    expect((pin.grants as { scopes: string[] }).scopes).toContain(`${appName}:items:write`)
    // The card: decided by kernel:apps:admin; name, version, sha and what the app asks for.
    expect(req!.approve_scope).toBe("kernel:apps:admin")
    const card = req!.summary.lines.join("\n")
    expect(card).toContain(`Installs ${appName} 0.1.0`)
    expect(card).toContain(`Package sha256: ${pin.packageSha256}`)
    expect(card).toContain(`Scopes asked: ${appName}:items:read, ${appName}:items:write`)

    // No edit of the request, whatever the field.
    expect(
      await code(
        updatePayload({
          orgId,
          requestId: req!.id,
          fields: { n: 2 },
          actor: admin,
          actingAgentId: null,
        }),
      ),
    ).toBe("invalid_edit")

    // The draft changes while the request waits.
    const { version: v1 } = await asAdmin((tx) => getDraft(tx, draftId))
    await asAdmin((tx) =>
      updateDraftFiles(tx, caller(), {
        draftId,
        files: { ...v1.files, "handlers.ts": `${v1.files["handlers.ts"]}\n// v2\n` },
        message: "v2",
      }),
    )

    const decided = await decideApproval({
      orgId,
      requestId: req!.id,
      actor: admin,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const [row] = await sql<{ sha256: string; version: string }[]>`
      SELECT sha256, version FROM kernel.apps_installed WHERE name = ${appName}`
    expect(row).toMatchObject({ sha256: pin.packageSha256, version: "0.1.0" })
    const [draft] = await sql<{ published_app_name: string | null; status: string }[]>`
      SELECT published_app_name, status FROM kernel.app_drafts WHERE id = ${draftId}`
    expect(draft).toMatchObject({ published_app_name: appName, status: "published" })
  }, 240_000)

  it("refuses an altered sha, a moved app and a pin for another draft's app", async () => {
    const { draftId, appName } = await newDraft("sha-check")
    const prepared = await asAdmin((tx) => preparePublish(tx, caller(), { draftId }))
    const install = { ...caller(), installedBy: adminId }
    const altered = {
      ...prepared.pin,
      packageSha256: createHash("sha256").update("x").digest("hex"),
    }
    expect(await code(asAdmin((tx) => executePublish(tx, install, altered)))).toBe("pin_mismatch")
    const moved = { ...prepared.pin, baseVersion: "0.0.9" }
    expect(await code(asAdmin((tx) => executePublish(tx, install, moved)))).toBe("publish_stale")
    const other = await newDraft("sha-other")
    const foreign = { ...prepared.pin, draftId: other.draftId }
    expect(await code(asAdmin((tx) => executePublish(tx, install, foreign)))).toBe("pin_mismatch")
    // The genuine pin installs.
    const ok = await asAdmin((tx) => executePublish(tx, install, prepared.pin))
    expect(ok).toMatchObject({ appName, appVersion: "0.1.0" })
    // A second publish is the next patch, over the active version.
    const next = await asAdmin((tx) => preparePublish(tx, caller(), { draftId }))
    expect(next.pin).toMatchObject({ appVersion: "0.1.1", baseVersion: "0.1.0" })
  }, 240_000)

  it("the customApps cap counts the first publish only", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT name)::int AS n FROM kernel.apps_installed WHERE org_id = ${orgId}`
    await setOrgCaps(orgId, { set: { customApps: row!.n } })
    try {
      const { draftId } = await newDraft("over-cap")
      const res = await restPublish(draftId)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(await res.json())).toMatch(/CUSTOM_APP_LIMIT|custom app/i)
      // An app already published takes its next version under the same cap.
      const [owned] = await sql<{ id: string }[]>`
        SELECT id::text FROM kernel.app_drafts WHERE org_id = ${orgId} AND base_name = 'sha-check'`
      const up = await restPublish(owned!.id)
      expect(up.status).toBe(200)
      expect(((await up.json()) as { data: { appVersion: string } }).data.appVersion).toBe("0.1.1")
    } finally {
      await setOrgCaps(orgId, { unset: ["customApps"] })
    }
  }, 240_000)

  it("refuses to publish into an app the builder did not build", async () => {
    const { draftId, appName } = await newDraft("by-url")
    // The org already has an app of that name from elsewhere.
    await sql`INSERT INTO kernel.apps_installed (name, version, source_url, sha256, granted_scopes, installed_by, org_id)
      VALUES (${appName}, '1.0.0', 'https://example.com/x.liaisonapp', ${"a".repeat(64)}, '{}', ${adminId}, ${orgId})`
    try {
      expect(await code(asAdmin((tx) => preparePublish(tx, caller(), { draftId })))).toBe(
        "app_not_built_by_builder",
      )
    } finally {
      await sql`DELETE FROM kernel.apps_installed WHERE name = ${appName}`
    }
  }, 60_000)
})
