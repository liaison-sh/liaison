// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The remote `liaison` CLI's server side, through the real app and a real
// device-flow sign-in (client id `liaison-cli`):
//   - the sign-in is capped by the server: no declared scopes = app building and
//     logs only, never kernel:apps:admin; a write scope outside the opt-in list
//     is refused; kernel:apps:admin only when asked for (modules/auth/cli-client.ts);
//   - REST create / update / status of a draft; a preview checks the tool's arguments;
//   - a CLI token never installs by itself: the REST publish parks the same
//     approval card as MCP (a person decides it), and the install routes refuse
//     it, admin scope or not;
//   - the interface consent from the CLI needs the person's explicit
//     confirmation (the app's name) and kernel:apps:admin in the token.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { activeCustomApp } from "~/modules/app-builder/installed"
import { decideApproval } from "~/modules/approvals/decide"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { purgeOrgCustomApps } from "~/modules/org/purge/purge-org"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CLI = "liaison-cli"
let installs: AppInstallSnapshot | null = null
let orgId = ""
let adminId = ""
let fullToken = ""
let admin: UserContext
let installRoot = ""
const savedAppsDir = process.env.LIAISON_APPS_DIR
const savedCustomApps = env.LIAISON_CUSTOM_APPS

function req(method: string, token: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

async function initiate(scopes?: string[]) {
  return app.request("/api/auth/device-flow/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: CLI,
      deviceLabel: "test laptop",
      ...(scopes ? { scopes } : {}),
    }),
  })
}

/** A `liaison-cli` sign-in through the whole real flow: initiate, approve, poll. */
async function cliLogin(scopes?: string[]): Promise<string> {
  const res = await initiate(scopes)
  expect(res.status).toBe(200)
  const { userCode, deviceCode } = ((await res.json()) as any).data
  const approved = await app.request(
    `/api/auth/device-flow/approve/${userCode}`,
    req("POST", fullToken, {}),
  )
  expect(approved.status).toBe(200)
  await redis.del(`device-poll:${deviceCode}`)
  const polled = await app.request(`/api/auth/device-flow/poll/${deviceCode}?client_id=${CLI}`)
  const data = ((await polled.json()) as any).data
  expect(data.status).toBe("approved")
  return data.accessToken as string
}

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  env.LIAISON_CUSTOM_APPS = "on"
  installRoot = mkdtempSync(join(tmpdir(), "app-builder-cli-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
  orgId = (await createTestOrg()).id
  adminId = (await minimal.orgAdmin(orgId)).id
  fullToken = await minimal.token(adminId)
  const perms = await withPrivilegedDb(orgId, "app-builder-cli-test-perms", (tx) =>
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
  env.LIAISON_CUSTOM_APPS = savedCustomApps
  await installs?.restore()
  await releaseTestLock()
}, 120_000)

describe("what a liaison-cli sign-in carries", () => {
  it("declaring nothing gets app building and logs only, never kernel:apps:admin, even for an admin", async () => {
    const token = await cliLogin()
    const claims = await verifyAccessToken(token, env.JWT_SECRET)
    expect(claims.restricted).toBe(true)
    expect([...(claims.scopes ?? [])].sort()).toEqual(["kernel:apps:build", "kernel:apps:logs"])
    expect(claims.scopes).not.toContain("kernel:apps:admin")
  })

  it("a write scope outside the opt-in list is refused at initiate; read scopes and kernel:apps:admin when asked for", async () => {
    const refused = await initiate(["kernel:apps:build", "tickets:reply"])
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as any).error.message).toContain("tickets:reply")

    const token = await cliLogin(["kernel:apps:build", "kernel:apps:admin", "kernel:skills:read"])
    const claims = await verifyAccessToken(token, env.JWT_SECRET)
    expect([...(claims.scopes ?? [])].sort()).toEqual([
      "kernel:apps:admin",
      "kernel:apps:build",
      "kernel:skills:read",
    ])
  })
})

describe("a CLI token builds, but never installs by itself", () => {
  let draftId = ""
  let appName = ""
  let adminCli = ""

  it("creates a draft, pushes files and reads its status over REST", async () => {
    const token = await cliLogin()
    const created = await app.request(
      "/api/apps/builder/drafts",
      req("POST", token, { base_name: "cli-notes", title: "CLI notes", template: "store-crud" }),
    )
    expect(created.status).toBe(201)
    const c = ((await created.json()) as any).data
    draftId = c.draftId
    appName = c.appName
    expect(appName.startsWith("cli-notes-o")).toBe(true)
    expect(Object.keys(c.files)).toContain("app.manifest.json")

    const readme = "# CLI notes\n"
    const pushed = await app.request(
      `/api/apps/builder/drafts/${draftId}/files`,
      req("PUT", token, { files: { "README.md": readme }, message: "readme" }),
    )
    expect(pushed.status).toBe(200)
    expect(((await pushed.json()) as any).data.n).toBe(2)

    const status = await app.request(
      `/api/apps/builder/drafts/${draftId}/status`,
      req("GET", token),
    )
    expect(status.status).toBe(200)
    const s = ((await status.json()) as any).data
    expect(s).toMatchObject({ draftId, appName, latestVersion: 2, installed: null, publishes: [] })
  })

  it("a try refuses the arguments a real call would refuse", async () => {
    const token = await cliLogin()
    const preview = async (params: Record<string, unknown>) => {
      const res = await app.request(
        `/api/apps/builder/drafts/${draftId}/preview`,
        req("POST", token, { entry: { kind: "tool", name: "items_add" }, params }),
      )
      expect(res.status).toBe(200)
      return ((await res.json()) as any).data
    }
    const missing = await preview({})
    expect(missing.ok).toBe(false)
    expect(missing.error.code).toBe("invalid_params")
    expect(missing.error.message).toContain("title")
    const unknownField = await preview({ title: "a", colour: "red" })
    expect(unknownField.error?.code).toBe("invalid_params")
    expect((await preview({ title: "milk" })).ok).toBe(true)
  }, 120_000)

  it("a publish from a CLI token, admin scope included, parks an approval card and installs nothing until a person approves", async () => {
    adminCli = await cliLogin(["kernel:apps:build", "kernel:apps:admin"])
    const res = await app.request(
      `/api/apps/builder/drafts/${draftId}/publish`,
      req("POST", adminCli, {}),
    )
    const body = ((await res.json()) as any).data
    expect(res.status).toBe(202)
    expect(body.status).toBe("pending_approval")
    const approvalId = body.approvalId as string
    expect(body.summary.lines.join("\n")).toContain(`Installs ${appName} 0.1.0`)
    expect(await activeCustomApp(orgId, appName)).toBeNull()
    const [row] = await sql<{ status: string; tool_name: string }[]>`
      SELECT status, tool_name FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(row).toMatchObject({ status: "pending" })
    expect(row!.tool_name).toContain("apps_build_publish")

    // The CLI follows the card with its own token.
    const followed = await app.request(`/api/approvals/${approvalId}/result`, req("GET", adminCli))
    expect(followed.status).toBe(200)
    expect(((await followed.json()) as any).data.status).toBe("pending")

    // The CLI cannot decide it: deciding is a person's act in their own session.
    const selfDecide = await app.request(
      `/api/approvals/${approvalId}/decide`,
      req("POST", adminCli, { decision: "approve" }),
    )
    expect(selfDecide.status).toBe(403)

    const decided = await decideApproval({
      orgId,
      requestId: approvalId,
      actor: admin,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    expect((await activeCustomApp(orgId, appName))?.version).toBe("0.1.0")
    resetInstallTrustCache(appName)

    const status = await app.request(
      `/api/apps/builder/drafts/${draftId}/status`,
      req("GET", adminCli),
    )
    const s = ((await status.json()) as any).data
    expect(s.installed).toMatchObject({ version: "0.1.0", draftVersion: 2 })
    expect(s.publishes[0]).toMatchObject({ version: "0.1.0", draftId, n: 2 })
  }, 120_000)

  it("a publish from a CLI token without kernel:apps:admin still only asks", async () => {
    const token = await cliLogin()
    const res = await app.request(
      `/api/apps/builder/drafts/${draftId}/publish`,
      req("POST", token, {}),
    )
    expect(res.status).toBe(202)
  }, 120_000)

  it("the install routes refuse a CLI token, admin scope or not", async () => {
    for (const path of ["/api/apps/custom/install", "/api/apps/install"]) {
      const res = await app.request(
        path,
        req("POST", adminCli, { url: "https://example.com/x.liaisonapp" }),
      )
      expect(res.status).toBe(403)
      expect(((await res.json()) as any).error.message).toContain("cannot install apps")
    }
  })

  it("the interface consent from the CLI needs the person's typed confirmation and kernel:apps:admin", async () => {
    const path = `/api/apps/${appName}/ui-approval`
    const bare = await app.request(path, req("POST", adminCli, { approved: true }))
    expect(bare.status).toBe(400)
    const wrong = await app.request(
      path,
      req("POST", adminCli, { approved: true, confirm: "other" }),
    )
    expect(wrong.status).toBe(400)

    const noAdmin = await cliLogin()
    const denied = await app.request(
      path,
      req("POST", noAdmin, { approved: true, confirm: appName }),
    )
    expect(denied.status).toBe(403)

    const ok = await app.request(path, req("POST", adminCli, { approved: true, confirm: appName }))
    expect(ok.status).toBe(200)
    const [audit] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND app = ${appName} AND action = 'app.ui_full_access.approved'`
    expect(audit?.metadata).toMatchObject({ via: "device-session" })

    // Withdrawing needs no confirmation.
    const withdrawn = await app.request(path, req("POST", adminCli, { approved: false }))
    expect(withdrawn.status).toBe(200)
  })
})
