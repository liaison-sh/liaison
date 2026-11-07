// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Org-private custom apps (S33) and the hostile-tenant boundary around them
// (modules/apps/app-org-scope.ts), on a managed cell AND a multi-org
// self-hosted server (ownership comes from the owner row on every edition).
// Two tenants on one server, real database, real install route, real sandbox:
//   - each installs base `crm` 1.0.0 with different code and gets its own answer;
//   - nothing of A's app is reachable from B: tool call, webhook, MCP tool
//     registry, listings, the ui.js bundle on B's host, cron fan-out, events;
//   - A's app cannot reach internal addresses through ctx.fetch;
//   - the install refuses forbidden declarations, wrong names and a full cap;
//   - a suspended org's private app is refused; the org purge removes it.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import type { Server } from "bun"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { enumerateFanoutOrgs } from "~/infra/jobs/fanout-runtime"
import { _setEdition, type Edition } from "~/lib/edition"
import { env } from "~/lib/env"
import { forgetOrgHostCache } from "~/lib/org-host"
import { appVisibleToOrg, customAppOrgKey } from "~/modules/apps/app-org-scope"
import { toolRegistry, webhookHandlers } from "~/modules/apps/app-registries"
import { declaredDomains } from "~/modules/apps/egress-grants"
import { executeTool } from "~/modules/apps/execute-tool"
import { reloadInstalledApps } from "~/modules/apps/init"
import { gateEventOnAppState } from "~/modules/apps/runtime"
import { getWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { signUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { setOrgCaps } from "~/modules/org/caps"
import { purgeOrgCustomApps } from "~/modules/org/purge/purge-org"
import { CustomAppWebhookLimitTestAccess } from "~/modules/webhooks/custom-app-webhook-limit"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TEMPLATE = "https://{slug}.example.com"
const INSTANCE_KEY = "d7".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)

/** Control's signed call to the cell: the operator's custom app kill switch. */
async function setAppState(orgId: string, name: string, disabled: boolean, reason?: string) {
  const path = `/api/cloud/orgs/${orgId}/custom-apps/${name}/state`
  const raw = JSON.stringify({ orgId, name, disabled, ...(reason ? { reason } : {}) })
  const headers = {
    "Content-Type": "application/json",
    ...signControlRequest(CONTROL_KEY, {
      method: "PUT",
      path,
      body: raw,
      messageId: randomUUID(),
      ts: Math.floor(Date.now() / 1000),
    }),
  }
  return on("cell-1.example.com", path, { method: "PUT", headers, body: raw })
}

interface Tenant {
  user: minimal.Person
  orgId: string
  bearer: string
  host: string
  crm: string
}

let A: Tenant
let B: Tenant
let installRoot = ""
let pkgDir = ""
let server: Server<undefined> | null = null
const savedTemplate = env.LIAISON_ORG_HOST_TEMPLATE
const savedAppsDir = process.env.LIAISON_APPS_DIR

function on(host: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", host)
  return app.request(`http://${host}${path}`, { ...init, headers })
}

const asJson = (t: Tenant, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${t.bearer}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

/** A `.liaisonapp` with a tool answering `who`, a webhook, a cron job and an egress probe. */
function makePackage(name: string, who: string, extra: Record<string, unknown> = {}): string {
  const stage = join(pkgDir, `${name}-${randomBytes(3).toString("hex")}`)
  mkdirSync(stage, { recursive: true })
  const scope = `${name}:items:read`
  const manifest = {
    name,
    version: "1.0.0",
    packageFormat: 1,
    license: "MIT",
    displayName: "CRM",
    scopes: [scope],
    network: {
      allowedDomains: ["169.254.169.254", "127.0.0.1", "localhost", "host.docker.internal"],
    },
    tools: {
      whoami: { description: "Who answers", handler: "whoami", requiredScopes: [scope] },
      probe: { description: "Fetch a URL", handler: "probe", requiredScopes: [scope] },
      spin: {
        description: "Hold a worker",
        handler: "spin",
        requiredScopes: [scope],
        timeoutMs: 3_000,
      },
    },
    jobs: { tick: { schedule: "*/5 * * * *", handler: "tick" } },
    webhooks: { ping: { handler: "onPing", verify: "verifyPing" } },
    webhookHealth: { probe: null, reason: "test app" },
    ...extra,
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(
    join(stage, "bundle.js"),
    `function whoami() { return { who: ${JSON.stringify(who)} } }
async function probe(p, ctx) {
  try { var r = await ctx.fetch(p.url, { method: "GET" }); return { ok: true, status: r && r.status } }
  catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}
function spin(p) { var t = Date.now() + p.ms; while (Date.now() < t) {} return { ok: true } }
function tick() { return { ok: true } }
function onPing() { return { ok: true } }
function verifyPing() { return { valid: true } }
`,
  )
  writeFileSync(join(stage, "ui.js"), `export const Page = () => ${JSON.stringify(who)}\n`)
  const tar = join(pkgDir, `${name}-${randomBytes(3).toString("hex")}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js", "ui.js"])
  packageDomains.set(tar, declaredDomains(manifest))
  return tar
}

/** Each package's declared outbound domains: the install consents to them (egress-grants.ts). */
const packageDomains = new Map<string, string[]>()

function urlOf(tarPath: string): string {
  return `http://127.0.0.1:${server?.port}/${encodeURIComponent(tarPath.split("/").pop() ?? "")}`
}

function installBody(name: string, tarPath: string, extra: Record<string, unknown> = {}) {
  return {
    url: urlOf(tarPath),
    grantedScopes: [`${name}:items:read`],
    grantedCapabilities: [],
    grantedCrossAppCalls: [],
    grantedDomains: packageDomains.get(tarPath) ?? [],
    approveUiFullAccess: true,
    ...extra,
  }
}

async function install(t: Tenant, name: string, tarPath: string, extra = {}) {
  return on(t.host, "/api/apps/custom/install", asJson(t, installBody(name, tarPath, extra)))
}

async function tenant(first: boolean, ed: Edition = "managed"): Promise<Tenant> {
  const orgId = first
    ? (await createTestOrg()).id
    : (await minimal.secondOrg({ name: `Custom apps B (${ed})` })).orgId
  const user = await minimal.orgAdmin(orgId)
  const [org] = await sql<{ slug: string }[]>`
    SELECT slug FROM kernel.organizations WHERE id = ${user.orgId}`
  return {
    user,
    orgId: user.orgId,
    bearer: await minimal.token(user.id),
    host: `${org!.slug}.example.com`,
    crm: `crm-o${customAppOrgKey(user.orgId)}`,
  }
}

async function callTool(t: Tenant, host: string, appName: string, tool: string, params = {}) {
  return on(host, `/api/apps/${appName}/tools/${tool}`, asJson(t, { params }))
}

const savedCustomApps = env.LIAISON_CUSTOM_APPS

beforeAll(async () => {
  await acquireTestLock()
  // Organisations' own apps on, on either edition (they default off when self-hosted).
  env.LIAISON_CUSTOM_APPS = "on"
  env.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  forgetOrgHostCache()
  installRoot = mkdtempSync(join(tmpdir(), "custom-apps-root-"))
  pkgDir = mkdtempSync(join(tmpdir(), "custom-apps-pkg-"))
  process.env.LIAISON_APPS_DIR = installRoot
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const file = join(pkgDir, decodeURIComponent(new URL(req.url).pathname.slice(1)))
      if (!existsSync(file)) return new Response("no", { status: 404 })
      return new Response(Bun.file(file))
    },
  })
  await withSystemDb("test-custom-apps-identity", async (db) => {
    await deleteIdentity(db)
    await writeIdentity(db, {
      ...mintIdentity(),
      keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
      state: "registered" as const,
      registeredAt: new Date().toISOString(),
    })
  })
}, 120_000)

afterAll(async () => {
  env.LIAISON_CUSTOM_APPS = savedCustomApps
  server?.stop(true)
  await shutdownWorkerPool()
  await withSystemDb("test-custom-apps-identity", (db) => deleteIdentity(db))
  _setEdition(null)
  env.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = savedAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  rmSync(pkgDir, { recursive: true, force: true })
  await releaseTestLock()
}, 120_000)

/** Two fresh tenants under edition `ed`; their custom apps purged at the end. */
function tenantsOn(ed: Edition): void {
  beforeAll(async () => {
    _setEdition(ed)
    // The first org's slug repeats across suites: forget the previous one's host.
    forgetOrgHostCache()
    A = await tenant(true)
    B = await tenant(false, ed)
  }, 120_000)
  afterAll(async () => {
    for (const t of [A, B]) {
      if (!t) continue
      await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${t.orgId}`
      await purgeOrgCustomApps(t.orgId).catch(() => undefined)
    }
    clearOrgBillingStatusCache()
  }, 120_000)
}

function boundarySuite(ed: Edition): void {
  describe("custom app install", () => {
    it("shows the org's namespace", async () => {
      const res = await on(A.host, "/api/apps/custom/namespace", {
        headers: { authorization: `Bearer ${A.bearer}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { orgKey: string; suffix: string } }
      expect(body.data.orgKey).toBe(customAppOrgKey(A.orgId))
      expect(body.data.suffix).toBe(`-o${customAppOrgKey(A.orgId)}`)
    })

    it("refuses a name without the org suffix, with the expected name", async () => {
      const res = await install(A, "crm", makePackage("crm", "A"))
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; expectedName: string } }
      expect(body.error.code).toBe("custom_app_name")
      expect(body.error.expectedName).toBe(A.crm)
    })

    it("refuses another org's suffix and a catalog app's base", async () => {
      expect((await install(A, B.crm, makePackage(B.crm, "A"))).status).toBe(422)
      const tickets = `tickets-o${customAppOrgKey(A.orgId)}`
      const res = await install(A, tickets, makePackage(tickets, "A"))
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("custom_app_name")
    })

    it("refuses an instance capability and the private-host flag with custom_app_capability (422)", async () => {
      const caps = await install(
        A,
        A.crm,
        makePackage(A.crm, "A", { capabilities: ["grants.setUserScopes"] }),
        { grantedCapabilities: ["grants.setUserScopes"] },
      )
      expect(caps.status).toBe(422)
      const body = (await caps.json()) as { error: { code: string; capability: string } }
      expect(body.error).toMatchObject({
        code: "custom_app_capability",
        capability: "grants.setUserScopes",
      })
      const flag = await install(
        A,
        A.crm,
        makePackage(A.crm, "A", {
          network: { allowedDomains: ["example.com"], allowPrivateHostsInTest: true },
        }),
      )
      expect(flag.status).toBe(422)
      expect(((await flag.json()) as { error: { capability: string } }).error.capability).toBe(
        "network.allowPrivateHostsInTest",
      )
    })

    it("refuses a foreign key into another schema (kernel, another tenant's app) with custom_app_capability (422)", async () => {
      for (const schema of ["kernel", `app_${B.crm.replace(/-/g, "_")}`]) {
        const res = await install(
          A,
          A.crm,
          makePackage(A.crm, "A", {
            schema: {
              pins: {
                fields: {
                  victim: {
                    type: "uuid",
                    references: {
                      schema,
                      table: "organizations",
                      column: "id",
                      onDelete: "restrict",
                    },
                  },
                },
              },
            },
          }),
        )
        expect(res.status).toBe(422)
        expect(((await res.json()) as { error: unknown }).error).toMatchObject({
          code: "custom_app_capability",
          capability: "schema.pins.fields.victim.references",
        })
      }
      // Nothing was created for the refused package.
      const made = await sql`SELECT 1 FROM information_schema.tables
        WHERE table_schema LIKE ${`%app_${A.crm.replace(/-/g, "_")}`} AND table_name = 'pins'`
      expect(made).toHaveLength(0)
    })

    it("A and B install base crm 1.0.0 with different code; each runs its own", async () => {
      const a = await install(A, A.crm, makePackage(A.crm, "A"))
      expect(a.status).toBe(200)
      const b = await install(B, B.crm, makePackage(B.crm, "B"))
      expect(b.status).toBe(200)
      const rows = await sql<{ name: string; org_id: string }[]>`
        SELECT name, org_id::text FROM kernel.apps_installed WHERE name IN (${A.crm}, ${B.crm})`
      expect(Object.fromEntries(rows.map((r) => [r.name, r.org_id]))).toEqual({
        [A.crm]: A.orgId,
        [B.crm]: B.orgId,
      })
      const active = await sql<{ name: string; org_id: string }[]>`
        SELECT name, org_id::text FROM kernel.apps_active_version WHERE name IN (${A.crm}, ${B.crm})`
      expect(active).toHaveLength(2)
      for (const r of active) expect(r.org_id).toBe(r.name === A.crm ? A.orgId : B.orgId)
      await reloadInstalledApps(A.orgId)
      await reloadInstalledApps(B.orgId)
      const ra = await callTool(A, A.host, A.crm, "whoami")
      expect(ra.status).toBe(200)
      expect(((await ra.json()) as { data: { who: string } }).data.who).toBe("A")
      const rb = await callTool(B, B.host, B.crm, "whoami")
      expect(((await rb.json()) as { data: { who: string } }).data.who).toBe("B")
    }, 120_000)

    it("the predicate: A's app is visible to A only", async () => {
      expect(await appVisibleToOrg(A.crm, A.orgId)).toBe(true)
      expect(await appVisibleToOrg(A.crm, B.orgId)).toBe(false)
      expect(await appVisibleToOrg("tickets", B.orgId)).toBe(true)
    })
  })

  describe("A's app is unreachable from B", () => {
    it("tool: B calling A's tool is 404 (HTTP and direct dispatch)", async () => {
      const res = await callTool(B, B.host, A.crm, "whoami")
      expect(res.status).toBe(404)
      const direct = executeTool({
        toolName: `${A.crm}:whoami`,
        orgId: B.orgId,
        actor: { actorType: "user", userId: B.user.id, orgId: B.orgId, scopes: ["*"] } as never,
        params: {},
        origin: "human-ui",
      })
      await expect(direct).rejects.toThrow(`tool ${A.crm}:whoami not registered`)
    })

    it("MCP: B's tool registry holds none of A's tools", () => {
      const bTools = [...toolRegistry.entriesOf(B.orgId)].map(([key]) => key[1])
      expect(bTools).not.toContain(A.crm)
      const aTools = [...toolRegistry.entriesOf(A.orgId)].map(([key]) => key[1])
      expect(aTools).toContain(A.crm)
    })

    it("listings: B's app list and manifests do not name A's app", async () => {
      const list = await on(B.host, "/api/apps", {
        headers: { authorization: `Bearer ${B.bearer}` },
      })
      expect(list.status).toBe(200)
      const names = ((await list.json()) as { data: Array<{ name: string }> }).data.map(
        (e) => e.name,
      )
      expect(names).toContain(B.crm)
      expect(names).not.toContain(A.crm)
      const manifests = await on(B.host, "/api/apps/manifests", {
        headers: { authorization: `Bearer ${B.bearer}` },
      })
      const mnames = ((await manifests.json()) as { data: Array<{ name: string }> }).data.map(
        (e) => e.name,
      )
      expect(mnames).not.toContain(A.crm)
    })

    it("webhook: B's org path to A's endpoint is 404; A's own is registered", async () => {
      expect(webhookHandlers.get([A.orgId, A.crm, "ping"])).toBeDefined()
      expect(webhookHandlers.get([B.orgId, A.crm, "ping"])).toBeUndefined()
      const res = await on("cell-1.example.com", `/webhooks/${B.orgId}/${A.crm}/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(res.status).toBe(404)
    })

    it("ui.js: served on A's host only; B's host and a cell host get 404", async () => {
      const path = `/api/apps/${A.crm}/1.0.0/ui.js`
      const tA = await signUiBundleToken(A.crm, "1.0.0", A.host)
      expect((await on(A.host, `${path}?t=${encodeURIComponent(tA)}`)).status).toBe(200)
      const tB = await signUiBundleToken(A.crm, "1.0.0", B.host)
      expect((await on(B.host, `${path}?t=${encodeURIComponent(tB)}`)).status).toBe(404)
      const tCell = await signUiBundleToken(A.crm, "1.0.0", "cell-1.example.com")
      expect(
        (await on("cell-1.example.com", `${path}?t=${encodeURIComponent(tCell)}`)).status,
      ).toBe(404)
      // B's manifests never hand out a URL for it either (above), and the frame refuses too.
      expect((await on(B.host, `/api/apps/${A.crm}/1.0.0/frame?t=${tB}`)).status).toBe(404)
    })

    it("cron: A's app job fans out to A only; an instance app's to every org", async () => {
      const orgs = (await enumerateFanoutOrgs(A.crm)).map((o) => o.orgId)
      expect(orgs).toEqual([A.orgId])
      const all = (await enumerateFanoutOrgs("tickets")).map((o) => o.orgId)
      expect(all).toContain(A.orgId)
      expect(all).toContain(B.orgId)
    })

    it("events: an event of B never reaches A's subscriber", async () => {
      const seen: string[] = []
      const gated = gateEventOnAppState(A.crm, A.orgId, async (e) => {
        seen.push(e.orgId)
      })
      await gated({ orgId: B.orgId, app: "kernel", entity: "contact", action: "create" })
      await gated({ orgId: A.orgId, app: "kernel", entity: "contact", action: "create" })
      expect(seen).toEqual([A.orgId])
    })

    it("operator routes: B cannot uninstall or approve A's app (404)", async () => {
      const del = await on(B.host, `/api/apps/${A.crm}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${B.bearer}` },
      })
      expect(del.status).toBe(404)
      const appr = await on(B.host, `/api/apps/${A.crm}/ui-approval`, asJson(B, { approved: true }))
      expect(appr.status).toBe(404)
    })
  })

  describe("A's interface runs isolated", () => {
    it("never in the page: not first-party, ui.js as text, the frame sandboxed with no network", async () => {
      const manifests = await on(A.host, "/api/apps/manifests", {
        headers: { authorization: `Bearer ${A.bearer}` },
      })
      const entry = (
        (await manifests.json()) as { data: Array<Record<string, unknown>> }
      ).data.find((e) => e.name === A.crm)
      expect(entry).toBeDefined()
      expect(entry?.firstParty).not.toBe(true)
      const t = encodeURIComponent(await signUiBundleToken(A.crm, "1.0.0", A.host))
      const ui = await on(A.host, `/api/apps/${A.crm}/1.0.0/ui.js?t=${t}`)
      expect(ui.status).toBe(200)
      expect(ui.headers.get("content-type")).toContain("text/plain")
      expect(ui.headers.get("x-content-type-options")).toBe("nosniff")
      const frame = await on(A.host, `/api/apps/${A.crm}/1.0.0/frame?t=${t}`)
      expect(frame.status).toBe(200)
      const csp = frame.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("sandbox allow-scripts allow-forms")
      expect(csp).not.toContain("allow-same-origin")
      expect(csp).toContain("connect-src 'none'")
    })
  })

  describe("A's app inside the sandbox", () => {
    it("ctx.fetch to the metadata IP, the Redis host and host.docker.internal is refused", async () => {
      const redisUrl = new URL(env.REDIS_URL)
      // On a cell, host.docker.internal is the Docker host gateway (a private
      // address); this machine may not resolve it at all, so it answers the
      // gateway address here, as the cell's resolver would.
      const realLookup = dnsPromises.lookup
      const lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation(((
        host: string,
        opts: unknown,
      ) =>
        host === "host.docker.internal"
          ? Promise.resolve([{ address: "172.17.0.1", family: 4 }])
          : (realLookup as (h: string, o: unknown) => Promise<unknown>)(
              host,
              opts,
            )) as unknown as typeof dnsPromises.lookup)
      for (const url of [
        "https://169.254.169.254/latest/meta-data/",
        `https://${redisUrl.hostname}:${redisUrl.port || 6379}/`,
        "https://host.docker.internal:6432/",
      ]) {
        const res = await callTool(A, A.host, A.crm, "probe", { url })
        const body = (await res.json()) as {
          data?: { ok: boolean; error?: string }
          error?: { message: string }
        }
        // Refused by the guard: the handler sees a thrown fetch (ok false) or
        // the call fails; never a response from the internal address.
        const reached = res.status === 200 && body.data?.ok === true
        console.log(`probe ${url}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
        expect({ url, reached }).toEqual({ url, reached: false })
        const reason = body.data?.error ?? body.error?.message ?? ""
        // The Redis host here is this server itself (localhost): refused as its own address.
        expect(reason).toMatch(
          /must not (point|resolve) to (a (private network|link-local)|this server's own address)/,
        )
      }
      lookupSpy.mockRestore()
    }, 60_000)
  })

  describe("one tenant cannot starve the others", () => {
    it("A's flood runs 2 at a time and is refused past its line (429); B's tool answers at once", async () => {
      const tenant = `org:${customAppOrgKey(A.orgId)}`
      const flood = Array.from({ length: 11 }, () =>
        callTool(A, A.host, A.crm, "spin", { ms: 2_500 }),
      )
      await Bun.sleep(400)
      expect(getWorkerPool().tenantStats()[tenant]).toEqual({ inFlight: 2, waiting: 8 })
      const started = Date.now()
      const rb = await callTool(B, B.host, B.crm, "whoami")
      const waited = Date.now() - started
      expect(rb.status).toBe(200)
      expect(waited).toBeLessThan(1_500)
      const answers = await Promise.all(flood)
      const statuses = answers.map((r) => r.status)
      expect(statuses.every((s) => s === 200 || s === 429)).toBe(true)
      const refused = answers.filter((r) => r.status === 429)
      expect(refused.length).toBeGreaterThanOrEqual(1)
      expect(refused[0]!.headers.get("retry-after")).toMatch(/^\d+$/)
      const body = (await refused[0]!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("custom_app_busy")
      expect(getWorkerPool().tenantStats()[tenant]).toBeUndefined()
    }, 60_000)

    it("a custom app's webhook has a per-minute budget (429 + Retry-After); B's own is separate", async () => {
      CustomAppWebhookLimitTestAccess.setLimit(3)
      try {
        const post = (t: Tenant) =>
          on("cell-1.example.com", `/webhooks/${t.orgId}/${t.crm}/ping`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        // Delivered to the app (its verify answers this test body as unsigned: 401).
        for (let i = 0; i < 3; i++) expect((await post(A)).status).not.toBe(429)
        const over = await post(A)
        expect(over.status).toBe(429)
        expect(over.headers.get("retry-after")).toMatch(/^\d+$/)
        expect(((await over.json()) as { error: { code: string } }).error.code).toBe(
          "custom_app_rate_limited",
        )
        expect((await post(B)).status).not.toBe(429)
      } finally {
        CustomAppWebhookLimitTestAccess.setLimit(null)
      }
    }, 60_000)
  })

  describe("caps, operator rule, suspension", () => {
    it("a second custom app at a cap of 1 is 409 CUSTOM_APP_LIMIT_REACHED", async () => {
      await setOrgCaps(A.orgId, { set: { customApps: 1 } })
      try {
        const other = `other-o${customAppOrgKey(A.orgId)}`
        const res = await install(A, other, makePackage(other, "A2"))
        expect(res.status).toBe(409)
        const body = (await res.json()) as {
          error: { code: string; details: { limit: number; used: number } }
        }
        expect(body.error.code).toBe("CUSTOM_APP_LIMIT_REACHED")
        expect(body.error.details).toEqual({ limit: 1, used: 1 })
        // Re-installing its own app is no new app: allowed at the cap.
        expect((await install(A, A.crm, makePackage(A.crm, "A"))).status).toBe(200)
      } finally {
        await setOrgCaps(A.orgId, { unset: ["customApps"] })
      }
    }, 60_000)

    it.if(ed === "managed")(
      "a tenant admin is still 403 on a catalog install (operator rule)",
      async () => {
        const res = await on(A.host, "/api/apps/catalog/tickets/install", asJson(A, {}))
        expect(res.status).toBe(403)
      },
    )

    // Billing suspension exists in the managed edition only.
    it.if(ed === "managed")(
      "a suspended org's private app is refused: tool 403, ui.js 404, events skipped",
      async () => {
        await seedOrgBillingState(
          A.orgId,
          {
            plan: "base",
            status: "suspended",
            includedCredits: 100,
            accessUntil: new Date(Date.now() + 10 * 86_400_000),
          },
          { onConflict: "status" },
        )
        clearOrgBillingStatusCache()
        try {
          const res = await callTool(A, A.host, A.crm, "whoami")
          expect(res.status).toBe(403)
          const tA = await signUiBundleToken(A.crm, "1.0.0", A.host)
          const ui = await on(A.host, `/api/apps/${A.crm}/1.0.0/ui.js?t=${encodeURIComponent(tA)}`)
          expect(ui.status).toBe(404)
          const seen: string[] = []
          await gateEventOnAppState(A.crm, A.orgId, async (e) => {
            seen.push(e.orgId)
          })({ orgId: A.orgId })
          expect(seen).toEqual([])
          expect((await enumerateFanoutOrgs(A.crm)).length).toBe(1) // jobs: skipped at dispatch
        } finally {
          await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${A.orgId}`
          clearOrgBillingStatusCache()
        }
      },
    )
  })

  // Control's kill switch (signed cell call) is the managed operator's tool.
  describe.if(ed === "managed")("the operator's kill switch", () => {
    it("disables A's app for everyone (A included), refuses its replacement and removal, audits it", async () => {
      // Another org cannot be named for A's app.
      expect((await setAppState(B.orgId, A.crm, true, "wrong org")).status).toBe(404)
      const off = await setAppState(A.orgId, A.crm, true, "busy-loop webhook")
      expect(off.status).toBe(200)
      expect(await off.json()).toEqual({ ok: true, name: A.crm, disabled: true })
      expect(await appVisibleToOrg(A.crm, A.orgId)).toBe(false)
      expect((await callTool(A, A.host, A.crm, "whoami")).status).toBe(404)
      const hook = await on("cell-1.example.com", `/webhooks/${A.orgId}/${A.crm}/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(hook.status).toBe(404)
      expect((await enumerateFanoutOrgs(A.crm)).length).toBe(0)
      const reinstall = await install(A, A.crm, makePackage(A.crm, "A"))
      expect(reinstall.status).toBe(409)
      expect(((await reinstall.json()) as { error: { code: string } }).error.code).toBe(
        "custom_app_disabled",
      )
      const del = await on(A.host, `/api/apps/${A.crm}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${A.bearer}` },
      })
      expect(del.status).toBe(409)
      const audit = await sql<{ action: string; metadata: { reason: string } }[]>`
        SELECT action, metadata FROM kernel.audit_log
        WHERE org_id = ${A.orgId} AND app = ${A.crm} AND action = 'app.custom.disabled'`
      expect(audit).toHaveLength(1)
      expect(audit[0]!.metadata.reason).toBe("busy-loop webhook")
      // B's app is untouched.
      const rb = await callTool(B, B.host, B.crm, "whoami")
      expect(rb.status).toBe(200)
    }, 60_000)

    it("enables it again: A's tool answers", async () => {
      const on_ = await setAppState(A.orgId, A.crm, false)
      expect(on_.status).toBe(200)
      expect(await appVisibleToOrg(A.crm, A.orgId)).toBe(true)
      const ra = await callTool(A, A.host, A.crm, "whoami")
      expect(ra.status).toBe(200)
      expect(((await ra.json()) as { data: { who: string } }).data.who).toBe("A")
    }, 60_000)
  })

  describe("org purge", () => {
    it("removes the org's custom apps (rows, schema, files, registrations); B's stays", async () => {
      await purgeOrgCustomApps(A.orgId)
      const rows = await sql`SELECT 1 FROM kernel.apps_installed WHERE org_id = ${A.orgId}`
      expect(rows).toHaveLength(0)
      const active = await sql`SELECT 1 FROM kernel.apps_active_version WHERE name = ${A.crm}`
      expect(active).toHaveLength(0)
      const schema = await sql`SELECT 1 FROM information_schema.schemata
        WHERE schema_name LIKE ${`%app_${A.crm.replace(/-/g, "_")}`}`
      expect(schema).toHaveLength(0)
      expect(existsSync(join(installRoot, A.crm))).toBe(false)
      expect(webhookHandlers.get([A.orgId, A.crm, "ping"])).toBeUndefined()
      const bRows = await sql`SELECT 1 FROM kernel.apps_installed WHERE org_id = ${B.orgId}`
      expect(bRows.length).toBeGreaterThan(0)
      const rb = await callTool(B, B.host, B.crm, "whoami")
      expect(((await rb.json()) as { data: { who: string } }).data.who).toBe("B")
    }, 60_000)
  })
}

// The same boundary on both editions. On self-hosted: two orgs on one
// server, org A installs a custom app, org B cannot see, list or run it; A can.
for (const ed of ["managed", "self_hosted"] as const) {
  describe(`edition ${ed}`, () => {
    tenantsOn(ed)
    boundarySuite(ed)
  })
}

describe("self-hosted without organization hosts", () => {
  tenantsOn("self_hosted")
  it("a custom app installs and runs for its org; its interface is refused (no org host to isolate it on)", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    forgetOrgHostCache()
    try {
      const host = "localhost"
      const res = await on(
        host,
        "/api/apps/custom/install",
        asJson(A, installBody(A.crm, makePackage(A.crm, "A"))),
      )
      expect(res.status).toBe(200)
      await reloadInstalledApps(A.orgId)
      await reloadInstalledApps(B.orgId)
      const ra = await callTool(A, host, A.crm, "whoami")
      expect(ra.status).toBe(200)
      expect(((await ra.json()) as { data: { who: string } }).data.who).toBe("A")
      expect((await callTool(B, host, A.crm, "whoami")).status).toBe(404)
      expect(await appVisibleToOrg(A.crm, B.orgId)).toBe(false)
      const t = await signUiBundleToken(A.crm, "1.0.0", host)
      expect(
        (await on(host, `/api/apps/${A.crm}/1.0.0/ui.js?t=${encodeURIComponent(t)}`)).status,
      ).toBe(404)
    } finally {
      env.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
      forgetOrgHostCache()
    }
  }, 120_000)
})
