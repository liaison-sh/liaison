// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-workspace app state reader (A5, A6, A24-1, A24-3): a cold process loads
// the state from the database, an unreadable state refuses (fail-closed, never
// "On"), registration keeps an existing row's status (a re-register or an
// upgrade never turns an Off app back On; only `error` recovers to active), and
// a write reaches this process at once and open sessions over the
// `kernel:org_app:update` WebSocket event.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import * as privileged from "~/db/privileged"
import * as eventBus from "~/infra/events/event-bus"
import { REDIS_PREFIX, RedisTestAccess } from "~/lib/redis"
import { setOrgAppAccess, setOrgAppStatus } from "~/modules/apps/org-app-service"
import {
  AppStateUnavailableError,
  forgetOrgApps,
  isAppActiveForOrgAsync,
  isAppOffForOrg,
  listOrgAppStates,
  noteOrgPrincipalsChanged,
  peekOrgAppState,
  primeOrgApps,
  reloadOrgApps,
  reloadOrgAppsAfterPeerWrite,
} from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import {
  cleanupSeededOrg,
  manifestWithBundle,
  seedOrgWithTicketsApp,
} from "~/modules/mcp/test-helpers"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"

const orgs: string[] = []
afterEach(async () => {
  for (const o of orgs.splice(0)) {
    forgetOrgApps(o)
    await cleanupSeededOrg(o)
  }
})

async function statusOf(orgId: string, app: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM kernel.apps WHERE org_id = ${orgId} AND name = ${app}`
  return row?.status
}

describe("org app state reader", () => {
  it("a cold process loads the persisted state: an app turned Off in the database reads Off", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${seed.orgId} AND name = 'test'`
    forgetOrgApps(seed.orgId) // nothing cached: a process that never saw this org
    expect(await isAppActiveForOrgAsync(seed.orgId, "test")).toBe(false)
    expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
    expect(await isAppActiveForOrgAsync(seed.orgId, "kernel")).toBe(true)
  }, 30_000)

  it("fail-closed: a state that cannot be loaded refuses instead of reading On", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    forgetOrgApps(seed.orgId)
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(async () => {
      throw new Error("database unreachable")
    })
    try {
      await expect(isAppActiveForOrgAsync(seed.orgId, "test")).rejects.toBeInstanceOf(
        AppStateUnavailableError,
      )
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("a stale entry whose reload fails keeps its last persisted answer", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(async () => {
      throw new Error("database unreachable")
    })
    try {
      await primeOrgApps(seed.orgId, 0)
      expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("re-registering an Off app keeps it Off, at the same version and after an upgrade", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await setOrgAppStatus(seed.orgId, "test", "disabled")
    // A fresh process (boot): nothing registered in memory, the database decides.
    resetOrgRuntimeForTest(seed.orgId)
    await registerApps([manifestWithBundle()], seed.orgId)
    expect(await statusOf(seed.orgId, "test")).toBe("disabled")
    resetOrgRuntimeForTest(seed.orgId)
    await registerApps([{ ...manifestWithBundle(), version: "9.9.9" }], seed.orgId)
    expect(await statusOf(seed.orgId, "test")).toBe("disabled")
    const [row] = await sql<{ version: string }[]>`
      SELECT version FROM kernel.apps WHERE org_id = ${seed.orgId} AND name = 'test'`
    expect(row?.version).toBe("9.9.9")
    await setOrgAppStatus(seed.orgId, "test", "removed")
    resetOrgRuntimeForTest(seed.orgId)
    await registerApps([manifestWithBundle()], seed.orgId)
    expect(await statusOf(seed.orgId, "test")).toBe("removed")
  }, 60_000)

  it("a registration error recovers to active on the next successful registration", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await sql`UPDATE kernel.apps SET status = 'error' WHERE org_id = ${seed.orgId} AND name = 'test'`
    resetOrgRuntimeForTest(seed.orgId)
    await registerApps([manifestWithBundle()], seed.orgId)
    expect(await statusOf(seed.orgId, "test")).toBe("active")
  }, 60_000)

  it("an app registered after the org's state was loaded is listed at once, not after the TTL", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    // The org's state is loaded while the app is not installed for it yet.
    await sql`DELETE FROM kernel.apps WHERE org_id = ${seed.orgId} AND name = 'test'`
    forgetOrgApps(seed.orgId)
    await primeOrgApps(seed.orgId)
    expect((await listOrgAppStates(seed.orgId)).map((s) => s.app)).not.toContain("test")
    // Installing it registers it for the org: the admin's list and the
    // add / enable routes see it now.
    resetOrgRuntimeForTest(seed.orgId)
    await registerApps([manifestWithBundle()], seed.orgId)
    const listed = (await listOrgAppStates(seed.orgId)).find((s) => s.app === "test")
    expect(listed?.status).toBe("active")
  }, 60_000)

  it("a write updates this process at once and broadcasts kernel:org_app:update", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await primeOrgApps(seed.orgId)
    const spy = spyOn(eventBus, "broadcastEphemeral")
    try {
      await setOrgAppStatus(seed.orgId, "test", "disabled")
      expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          app: "kernel",
          entity: "org_app",
          action: "update",
          orgId: seed.orgId,
          data: { app: "test", status: "disabled", accessMode: "everyone" },
        }),
      )
      await setOrgAppStatus(seed.orgId, "test", "active")
      expect(isAppOffForOrg(seed.orgId, "test")).toBe(false)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("a peer's invalidation starts a fresh read: a load in flight from before the write does not win", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await primeOrgApps(seed.orgId)
    // A reload that read the pre-write state and is still in flight.
    let release: (v: unknown) => void = () => {}
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as never,
    )
    const stale = primeOrgApps(seed.orgId, 0)
    spy.mockRestore()
    // The peer wrote the app Off, then told this process.
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${seed.orgId} AND name = 'test'`
    await reloadOrgAppsAfterPeerWrite(seed.orgId)
    release(new Map([["test", { ...peekOrgAppState(seed.orgId, "test"), status: "active" }]]))
    await stale
    expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
  }, 30_000)

  it("a writer's reload overtaken by a newer one resolves only once the newer answer is cached", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await primeOrgApps(seed.orgId)
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${seed.orgId} AND name = 'test'`
    // The writer's own reload reads now; a newer one (a self-echoed invalidation)
    // starts right after it and is still reading when the first one finishes.
    const writer = reloadOrgApps(seed.orgId, { fresh: true })
    let release: (v: unknown) => void = () => {}
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as never,
    )
    const newer = reloadOrgApps(seed.orgId, { fresh: true })
    spy.mockRestore()
    const off = { ...peekOrgAppState(seed.orgId, "test"), status: "disabled" }
    // readOrgApps resolves `{ apps, orgMissing }` (the org-missing read, #233).
    setTimeout(() => release({ apps: new Map([["test", off]]), orgMissing: false }), 200)
    await writer
    // The writer's caller reads its own write, never the entry from before it.
    expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
    await newer
  }, 30_000)

  it("a counter dropped by forgetOrgApps is never reused: an untracked older load cannot write", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    forgetOrgApps(seed.orgId)
    // A: a load that read the state while the app was On, still in flight.
    let release: (v: unknown) => void = () => {}
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as never,
    )
    const stale = reloadOrgApps(seed.orgId, { fresh: true })
    spy.mockRestore()
    // B overtakes A and finishes: A is left running, tracked by nothing.
    await reloadOrgApps(seed.orgId, { fresh: true })
    const on = { ...peekOrgAppState(seed.orgId, "test"), status: "active" }
    // The org is released (its counter dropped), the app turned Off, and a new load caches Off.
    forgetOrgApps(seed.orgId)
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${seed.orgId} AND name = 'test'`
    await reloadOrgApps(seed.orgId)
    expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
    // A finishes last: its pre-write answer must not replace the newer one.
    release({ apps: new Map([["test", on]]), orgMissing: false })
    await stale
    expect(isAppOffForOrg(seed.orgId, "test")).toBe(true)
  }, 30_000)

  it("a role assignment reloads a restricted app's members (no TTL wait)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const [role] = await sql<{ id: string }[]>`
      INSERT INTO kernel.roles (org_id, name) VALUES (${seed.orgId}, 'p3-restricted-role') RETURNING id`
    try {
      await setOrgAppAccess(seed.orgId, "test", {
        mode: "restricted",
        roleIds: [role!.id],
        userIds: [],
      })
      expect(peekOrgAppState(seed.orgId, "test")?.allowedUserIds.has(seed.ownerId)).toBe(false)
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${seed.ownerId}, ${role!.id}, ${seed.orgId})`
      await noteOrgPrincipalsChanged({
        app: "kernel",
        entity: "role_assignment",
        orgId: seed.orgId,
      })
      expect(peekOrgAppState(seed.orgId, "test")?.allowedUserIds.has(seed.ownerId)).toBe(true)
      await sql`DELETE FROM kernel.user_roles WHERE org_id = ${seed.orgId} AND role_id = ${role!.id}`
      await noteOrgPrincipalsChanged({
        app: "kernel",
        entity: "role_assignment",
        orgId: seed.orgId,
      })
      expect(peekOrgAppState(seed.orgId, "test")?.allowedUserIds.has(seed.ownerId)).toBe(false)
    } finally {
      await sql`DELETE FROM kernel.user_roles WHERE org_id = ${seed.orgId}`
      await sql`DELETE FROM kernel.org_app_access WHERE org_id = ${seed.orgId}`
      await sql`DELETE FROM kernel.roles WHERE id = ${role!.id}`
    }
  }, 30_000)

  // A permission event reaches every process (per-replica delivery). Each one
  // reloads its own entry; only the process that published the event tells
  // peers, or N processes would each make every other one reload (N^2).
  it("a peer's copy of a permission event reloads locally and publishes no invalidation", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const [role] = await sql<{ id: string }[]>`
      INSERT INTO kernel.roles (org_id, name) VALUES (${seed.orgId}, 'p2a-remote-role') RETURNING id`
    const invalidations: string[] = []
    RedisTestAccess.setPublish(async (channel, payload) => {
      if (channel === `${REDIS_PREFIX}org-apps:invalidate`) invalidations.push(payload)
      return 1
    })
    try {
      await setOrgAppAccess(seed.orgId, "test", {
        mode: "restricted",
        roleIds: [role!.id],
        userIds: [],
      })
      invalidations.length = 0
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${seed.ownerId}, ${role!.id}, ${seed.orgId})`
      await noteOrgPrincipalsChanged({
        app: "kernel",
        entity: "role_assignment",
        orgId: seed.orgId,
        _remote: true,
      })
      expect(peekOrgAppState(seed.orgId, "test")?.allowedUserIds.has(seed.ownerId)).toBe(true)
      expect(invalidations).toEqual([])

      // The publishing process's own copy still tells peers.
      await sql`DELETE FROM kernel.user_roles WHERE org_id = ${seed.orgId} AND role_id = ${role!.id}`
      await noteOrgPrincipalsChanged({
        app: "kernel",
        entity: "role_assignment",
        orgId: seed.orgId,
      })
      expect(peekOrgAppState(seed.orgId, "test")?.allowedUserIds.has(seed.ownerId)).toBe(false)
      expect(invalidations).toEqual([JSON.stringify({ orgId: seed.orgId })])
    } finally {
      RedisTestAccess.setPublish(undefined)
      await sql`DELETE FROM kernel.user_roles WHERE org_id = ${seed.orgId}`
      await sql`DELETE FROM kernel.org_app_access WHERE org_id = ${seed.orgId}`
      await sql`DELETE FROM kernel.roles WHERE id = ${role!.id}`
    }
  }, 30_000)
})
