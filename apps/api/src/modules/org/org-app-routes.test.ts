// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S24 / A4 / A6 / A7 / A12 / A24-2 / A24-6: the workspace app management
// routes (`/api/org/apps`), the instance uninstall guard and the gated kernel
// tools `apps_set_enabled` / `apps_set_access`.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { routines } from "~/db/schema/kernel"
import {
  summarizeAppsSetAccess,
  summarizeAppsSetEnabled,
} from "~/modules/agent/tools/kernel-summarizers"
import { handleSetAppAccess, handleSetAppEnabled } from "~/modules/agent/tools/org-config-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as connections from "~/modules/apps/connections/service"
import * as init from "~/modules/apps/init"
import { otherWorkspacesWithApp } from "~/modules/apps/org-app-admin"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let member: minimal.Session

async function refreshTokens(): Promise<void> {
  admin = { ...admin, bearer: await minimal.token(admin.userId) }
  member = { ...member, bearer: await minimal.token(member.userId) }
}

async function call(path: string, s: minimal.Session, init: RequestInit = {}) {
  const res = await app.request(`/api/org/apps${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.bearer}` },
  })
  // Every successful change bumps the org's permission version.
  if (res.ok && (init.method === "POST" || init.method === "PUT")) await refreshTokens()
  return res
}

async function body(
  res: Response,
): Promise<{ data?: any; error?: { code?: string; message: string } }> {
  return (await res.json()) as { data?: any; error?: { code?: string; message: string } }
}

async function statusOf(name: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = ${name}`
  return row?.status
}

beforeAll(async () => {
  await acquireTestLock()
  admin = await minimal.adminSession((await createTestOrg()).id)
  member = await minimal.session(admin.orgId, { role: "member" })
}, 120_000)

afterEach(async () => {
  for (const a of ["tickets", "projects"]) await setOrgAppStatus(admin.orgId, a, "active")
  await sql`UPDATE kernel.apps SET access_mode = 'everyone' WHERE org_id = ${admin.orgId}`
  await sql`DELETE FROM kernel.org_app_access WHERE org_id = ${admin.orgId}`
  await refreshTokens()
})

afterAll(releaseTestLock)

describe("GET /api/org/apps", () => {
  it("lists every app of the workspace with its state for an admin; a member is refused", async () => {
    await setOrgAppStatus(admin.orgId, "tickets", "disabled")
    await refreshTokens()
    const res = await call("", admin)
    expect(res.status).toBe(200)
    const rows = (await body(res)).data as Array<Record<string, unknown>>
    const tickets = rows.find((r) => r.name === "tickets")
    expect(tickets).toMatchObject({
      name: "tickets",
      status: "disabled",
      accessMode: "everyone",
      principals: { roleIds: [], userIds: [] },
      hasOwnScopes: true,
      installSource: "in-tree",
      // The listing's licence: an in-tree app is in no catalog, its manifest says it.
      license: "FSL-1.1-ALv2",
    })
    expect(Array.isArray(tickets?.dependents)).toBe(true)
    expect(rows.find((r) => r.name === "contacts")?.hasOwnScopes).toBe(false)
    // The workspace depends on knowledge and contacts: the header offers no
    // switch or Remove for them, so the server says so up front (MGT-07).
    expect(tickets?.canDisable).toBe(true)
    expect(rows.find((r) => r.name === "knowledge")?.canDisable).toBe(false)
    expect(rows.find((r) => r.name === "contacts")?.canDisable).toBe(false)
    expect((await call("", member)).status).toBe(403)
  }, 60_000)

  it("an app whose manifest fails validation is listed as errored, with the validator's reason (STO-09)", async () => {
    const name = "broken-manifest-fixture"
    try {
      // A manifest with a key the app contract does not allow: never registered.
      await registerApps(
        [{ _format: "manifest", name, version: "1.0.0", notAManifestKey: true }],
        admin.orgId,
      )
      const rows = (await body(await call("", admin))).data as Array<Record<string, any>>
      const row = rows.find((r) => r.name === name)
      expect(row?.status).toBe("error")
      expect(row?.problem?.code).toBe("manifest_invalid")
      expect(row?.problem?.message).toContain("notAManifestKey")
      // A healthy app carries no problem.
      expect(rows.find((r) => r.name === "tickets")?.problem).toBeNull()
    } finally {
      await sql`DELETE FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = ${name}`
      forgetOrgApps(admin.orgId)
    }
  }, 60_000)

  it("an app whose host API range this server cannot satisfy is errored at registration, with the reason (S3)", async () => {
    const name = "future-host-fixture"
    try {
      await registerApps([{ _format: "manifest", name, version: "2.0.0", host: "^9" }], admin.orgId)
      expect(await statusOf(name)).toBe("error")
      const rows = (await body(await call("", admin))).data as Array<Record<string, any>>
      const row = rows.find((r) => r.name === name)
      expect(row?.status).toBe("error")
      expect(row?.problem?.message).toBe(
        `${name} 2.0.0 needs host API ^9; this server provides host API 1.1.0. Update Liaison first.`,
      )
    } finally {
      await sql`DELETE FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = ${name}`
      forgetOrgApps(admin.orgId)
    }
  }, 60_000)
})

describe("a retired app (its package gone from the server)", () => {
  it("is listed as retired, and an admin can remove it from the workspace", async () => {
    const name = "retired-fixture-app"
    try {
      await sql`
        INSERT INTO kernel.apps (org_id, name, version, status)
        VALUES (${admin.orgId}, ${name}, '0.1.0', 'disabled')`
      forgetOrgApps(admin.orgId)
      const rows = (await body(await call("", admin))).data as Array<Record<string, any>>
      expect(rows.find((r) => r.name === name)).toMatchObject({
        status: "disabled",
        retired: true,
        displayName: null,
        problem: null,
      })
      expect(rows.find((r) => r.name === "tickets")?.retired).toBe(false)

      const removed = await call(`/${name}/remove`, admin, { method: "POST" })
      expect(removed.status).toBe(200)
      expect(await statusOf(name)).toBe("removed")
    } finally {
      await sql`DELETE FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = ${name}`
      forgetOrgApps(admin.orgId)
    }
  }, 60_000)
})

describe("POST /api/org/apps/:app/{add|remove|enable|disable}", () => {
  it("disable then enable round trip; audited; a member is refused", async () => {
    expect((await call("/tickets/disable", member, { method: "POST" })).status).toBe(403)
    const off = await call("/tickets/disable", admin, { method: "POST" })
    expect(off.status).toBe(200)
    expect((await body(off)).data).toMatchObject({ name: "tickets", status: "disabled" })
    expect(await statusOf("tickets")).toBe("disabled")
    const on = await call("/tickets/enable", admin, { method: "POST" })
    expect(on.status).toBe(200)
    expect(await statusOf("tickets")).toBe("active")
    const audit = await sql<{ action: string }[]>`
      SELECT action FROM kernel.audit_log
      WHERE org_id = ${admin.orgId} AND app = 'kernel' AND entity_type = 'org_app' AND entity_id = 'tickets'
      ORDER BY "timestamp"`
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["org_app.disable", "org_app.enable"]),
    )
  }, 60_000)

  it("an app routine is paused while the app is Off and resumes when it is back On", async () => {
    const [row] = await withPrivilegedDb(admin.orgId, "seed-app-routine", (tx) =>
      tx
        .insert(routines)
        .values({
          orgId: admin.orgId,
          ownerUserId: admin.userId,
          name: "p3 app routine",
          description: "d",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          runAt: null,
          prompt: "p",
          scopes: [],
          createdByUserId: admin.userId,
          createdByActorType: "user",
          appName: "projects",
          templateKey: "p3-template",
          sourceKind: "app",
        })
        .returning({ id: routines.id }),
    )
    const statusOfRoutine = async () =>
      (await sql<{ status: string }[]>`SELECT status FROM kernel.routines WHERE id = ${row?.id}`)[0]
        ?.status
    try {
      expect((await call("/projects/disable", admin, { method: "POST" })).status).toBe(200)
      expect(await statusOfRoutine()).toBe("paused_app_disabled")
      expect((await call("/projects/enable", admin, { method: "POST" })).status).toBe(200)
      expect(await statusOfRoutine()).toBe("active")
    } finally {
      await sql`DELETE FROM kernel.routines WHERE id = ${row?.id}`
    }
  }, 60_000)

  it("kernel, knowledge and contacts cannot be turned off or removed", async () => {
    for (const name of ["knowledge", "contacts"]) {
      for (const action of ["disable", "remove"]) {
        const res = await call(`/${name}/${action}`, admin, { method: "POST" })
        expect({ name, action, status: res.status }).toEqual({ name, action, status: 409 })
        expect((await body(res)).error?.code).toBe("app_required")
      }
    }
    expect((await call("/kernel/disable", admin, { method: "POST" })).status).toBe(409)
  }, 60_000)

  it("an app another On app requires cannot be turned off; the refusal names the dependents", async () => {
    const real = await init.getDefaultApps()
    const spy = spyOn(init, "getDefaultApps").mockImplementation(async () => [
      ...real,
      { name: "p3-dependent", version: "1.0.0", dependencies: { required: ["projects"] } },
    ])
    await sql`INSERT INTO kernel.apps (org_id, name, version) VALUES (${admin.orgId}, 'p3-dependent', '1.0.0')`
    forgetOrgApps(admin.orgId) // the row was written behind the cache's back
    try {
      const res = await call("/projects/disable", admin, { method: "POST" })
      expect(res.status).toBe(409)
      const b = await body(res)
      expect(b.error?.code).toBe("app_has_dependents")
      expect(b.error?.message).toContain("p3-dependent")
      // Once the dependent is Off, the app may go Off.
      await setOrgAppStatus(admin.orgId, "p3-dependent", "disabled")
      await refreshTokens()
      expect((await call("/projects/disable", admin, { method: "POST" })).status).toBe(200)
    } finally {
      spy.mockRestore()
      await sql`DELETE FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = 'p3-dependent'`
    }
  }, 60_000)

  it("an app whose required app is Off or removed cannot be turned on or added; the refusal names it", async () => {
    const real = await init.getDefaultApps()
    const spy = spyOn(init, "getDefaultApps").mockImplementation(async () => [
      ...real,
      { name: "p3-needs", version: "1.0.0", dependencies: { required: ["projects"] } },
    ])
    // p3-needs has no source to register: the resume step's registration is a no-op here.
    const ensure = spyOn(init, "ensureAppsForOrg").mockImplementation(async () => {})
    await sql`INSERT INTO kernel.apps (org_id, name, version, status)
      VALUES (${admin.orgId}, 'p3-needs', '1.0.0', 'disabled')`
    forgetOrgApps(admin.orgId) // the row was written behind the cache's back
    try {
      expect((await call("/projects/disable", admin, { method: "POST" })).status).toBe(200)
      const on = await call("/p3-needs/enable", admin, { method: "POST" })
      expect(on.status).toBe(409)
      const b = await body(on)
      expect(b.error?.code).toBe("app_requires")
      expect(b.error?.message).toContain("projects")
      expect(await statusOf("p3-needs")).toBe("disabled")
      await setOrgAppStatus(admin.orgId, "p3-needs", "removed")
      await setOrgAppStatus(admin.orgId, "projects", "removed")
      await refreshTokens()
      const add = await call("/p3-needs/add", admin, { method: "POST" })
      expect(add.status).toBe(409)
      expect((await body(add)).error?.message).toContain("projects")
      // Once the required app is back On, the app may be added.
      await setOrgAppStatus(admin.orgId, "projects", "active")
      await refreshTokens()
      expect((await call("/p3-needs/add", admin, { method: "POST" })).status).toBe(200)
    } finally {
      spy.mockRestore()
      ensure.mockRestore()
      await sql`DELETE FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = 'p3-needs'`
      forgetOrgApps(admin.orgId)
    }
  }, 60_000)

  it("remove then add keeps the app's data; a removed app is not enabled, it is added", async () => {
    const [before] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = 'projects'`
    const removed = await call("/projects/remove", admin, { method: "POST" })
    expect(removed.status).toBe(200)
    expect(await statusOf("projects")).toBe("removed")
    const enable = await call("/projects/enable", admin, { method: "POST" })
    expect(enable.status).toBe(409)
    expect((await body(enable)).error?.code).toBe("app_removed")
    const added = await call("/projects/add", admin, { method: "POST" })
    expect(added.status).toBe(200)
    expect(await statusOf("projects")).toBe("active")
    const [after] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.apps WHERE org_id = ${admin.orgId} AND name = 'projects'`
    expect(after?.n).toBe(before?.n)
  }, 60_000)

  it("re-enable re-registers the app for the org, then reconciles each active connection", async () => {
    const accountId = randomUUID()
    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id, status,
        provider_type, identifier, access_token_encrypted, provider_account_id, metadata,
        created_by, created_at, updated_at)
      VALUES (${accountId}, ${admin.orgId}, 'tickets', 'p3-conn', 'user', ${admin.userId}, 'active',
        'credentials', ${`p3-${accountId}`}, 'enc', ${`p3-${accountId}`}, '{}'::jsonb,
        ${admin.userId}, now(), now())`
    const order: string[] = []
    const ensure = spyOn(init, "ensureAppsForOrg")
    ensure.mockImplementation(async () => {
      order.push("register")
    })
    const reconcile = spyOn(connections, "reconcileAppConnections").mockImplementation(
      async (_org, _user, appName, connectionName) => {
        order.push(`reconcile:${appName}/${connectionName}`)
        return { reconciled: [] }
      },
    )
    try {
      expect((await call("/tickets/disable", admin, { method: "POST" })).status).toBe(200)
      expect(reconcile).not.toHaveBeenCalled()
      expect((await call("/tickets/enable", admin, { method: "POST" })).status).toBe(200)
      expect(order).toEqual(["register", "reconcile:tickets/p3-conn"])
    } finally {
      ensure.mockRestore()
      reconcile.mockRestore()
      await sql`DELETE FROM kernel.connected_accounts WHERE id = ${accountId}`
    }
  }, 60_000)
})

describe("PUT /api/org/apps/:app/access", () => {
  it("restricts to roles and people of the workspace; refuses an app with no own scopes (422)", async () => {
    const [role] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${admin.orgId} AND name = 'member' LIMIT 1`
    const ok = await call("/tickets/access", admin, {
      method: "PUT",
      body: JSON.stringify({ mode: "restricted", roleIds: [role?.id], userIds: [member.userId] }),
    })
    expect(ok.status).toBe(200)
    expect((await body(ok)).data).toMatchObject({
      name: "tickets",
      accessMode: "restricted",
      principals: { roleIds: [role?.id], userIds: [member.userId] },
    })
    const none = await call("/contacts/access", admin, {
      method: "PUT",
      body: JSON.stringify({ mode: "restricted", roleIds: [], userIds: [member.userId] }),
    })
    expect(none.status).toBe(422)
    expect((await body(none)).error?.message).toBe("This app has no permissions to restrict")
    const foreign = await call("/tickets/access", admin, {
      method: "PUT",
      body: JSON.stringify({ mode: "restricted", roleIds: [randomUUID()], userIds: [] }),
    })
    expect(foreign.status).toBe(400)
    const back = await call("/tickets/access", admin, {
      method: "PUT",
      body: JSON.stringify({ mode: "everyone" }),
    })
    expect((await body(back)).data).toMatchObject({
      accessMode: "everyone",
      principals: { roleIds: [] },
    })
  }, 60_000)
})

describe("instance uninstall guard", () => {
  it("counts the OTHER workspaces that still have the app added (two orgs)", async () => {
    const other = await minimal.secondOrg()
    try {
      expect(await otherWorkspacesWithApp(admin.orgId, "tickets")).toBe(1)
      expect(await otherWorkspacesWithApp(other.orgId, "tickets")).toBe(1)
      await setOrgAppStatus(other.orgId, "tickets", "removed")
      expect(await otherWorkspacesWithApp(admin.orgId, "tickets")).toBe(0)
      // Removed elsewhere, still added here: the other org's admin sees this one.
      expect(await otherWorkspacesWithApp(other.orgId, "tickets")).toBe(1)
    } finally {
      await setOrgAppStatus(other.orgId, "tickets", "active")
    }
  }, 120_000)
})

describe("kernel tools apps_set_enabled / apps_set_access", () => {
  it("are gated, admin-scoped, and act through the same checks", async () => {
    for (const name of ["apps_set_enabled", "apps_set_access"]) {
      const def = toolRegistry.get([admin.orgId, "kernel", name])
      expect(def?.gated).toBe(true)
      expect(def?.requiredScopes).toEqual(["kernel:apps:admin"])
    }
    const ctx = { orgId: admin.orgId, userId: admin.userId }
    expect(await handleSetAppEnabled({ appName: "tickets", enabled: false }, ctx)).toEqual({
      appName: "tickets",
      status: "disabled",
    })
    expect(await handleSetAppEnabled({ appName: "knowledge", enabled: false }, ctx)).toMatchObject({
      code: "app_required",
    })
    expect(
      await handleSetAppAccess({ appName: "contacts", mode: "restricted", userIds: [] }, ctx),
    ).toMatchObject({ code: "app_not_restrictable" })
    expect(await handleSetAppEnabled({ appName: "no-such-app", enabled: false }, ctx)).toEqual({
      error: "app not installed",
    })
  }, 60_000)

  it("summaries say what changes", async () => {
    const c = {} as Parameters<typeof summarizeAppsSetEnabled>[1]
    expect((await summarizeAppsSetEnabled({ appName: "ads", enabled: false }, c)).title).toBe(
      "Turn off the ads app",
    )
    expect((await summarizeAppsSetEnabled({ appName: "ads", enabled: true }, c)).title).toBe(
      "Turn the ads app back on",
    )
    expect(
      (await summarizeAppsSetAccess({ appName: "tickets", mode: "restricted", roleIds: ["r"] }, c))
        .title,
    ).toBe("Limit who can use the tickets app")
  })
})
