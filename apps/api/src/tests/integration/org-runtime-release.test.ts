// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A released org runtime (org-runtime-release.ts) leaves nothing of the org in
// the process, and the org set up again afterwards is set up exactly as in a
// process that never saw it.
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import {
  holdOrgRuntime,
  initializedOrgRuntimes,
  orgRuntimeLastTouch,
  registeredApps,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { awaitOrgApps, ensureAppsForOrg } from "~/modules/apps/init"
import {
  idleOrgRuntimes,
  releaseOrgRuntimes,
  setUpOrgsThatAreGone,
  sweepIdleOrgRuntimes,
} from "~/modules/apps/org-runtime-release"
import { RegistriesTestAccess } from "~/modules/apps/registries"

async function newOrg(): Promise<string> {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Release Org', ${`org-release-${crypto.randomUUID()}`}) RETURNING id`),
  )
  return org.id
}

describe("org runtime release", () => {
  it("leaves nothing of the org, and setting it up again rebuilds the same runtime", async () => {
    const orgId = await newOrg()
    await ensureAppsForOrg(orgId)
    const before = RegistriesTestAccess.keysUnder(orgId)
    expect(before.size).toBeGreaterThan(0)
    expect([...registeredApps].some((k) => k.startsWith(`${orgId}:`))).toBe(true)

    expect(await releaseOrgRuntimes([orgId], { gone: false })).toEqual([orgId])
    expect(RegistriesTestAccess.keysUnder(orgId).size).toBe(0)
    expect([...registeredApps].some((k) => k.startsWith(`${orgId}:`))).toBe(false)
    expect(initializedOrgRuntimes.has(orgId)).toBe(false)
    expect(toolRegistry.get([orgId, "kernel", "user_memory_get"])).toBeUndefined()

    await ensureAppsForOrg(orgId)
    const after = RegistriesTestAccess.keysUnder(orgId)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [id, keys] of before)
      expect([...(after.get(id) ?? [])].sort()).toEqual([...keys].sort())
    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
  })

  it("finds the set-up orgs whose row is gone, and only those", async () => {
    const live = await newOrg()
    await ensureAppsForOrg(live)
    const gone = crypto.randomUUID()
    initializedOrgRuntimes.add(gone)
    try {
      const found = await setUpOrgsThatAreGone()
      expect(found).toContain(gone)
      expect(found).not.toContain(live)
    } finally {
      initializedOrgRuntimes.delete(gone)
    }
  })

  it("releases only the orgs idle past LIAISON_ORG_RUNTIME_IDLE_MINUTES, and only when it is set", async () => {
    const idle = await newOrg()
    const busy = await newOrg()
    await awaitOrgApps(idle)
    await awaitOrgApps(busy)
    const saved = env.LIAISON_ORG_RUNTIME_IDLE_MINUTES
    try {
      const later = Date.now() + 20 * 60_000
      orgRuntimeLastTouch.set(busy, later - 60_000)
      env.LIAISON_ORG_RUNTIME_IDLE_MINUTES = 0
      expect(await sweepIdleOrgRuntimes(later)).toEqual([])
      env.LIAISON_ORG_RUNTIME_IDLE_MINUTES = 15
      expect(idleOrgRuntimes(15 * 60_000, later)).toContain(idle)
      expect(idleOrgRuntimes(15 * 60_000, later)).not.toContain(busy)
      const released = await sweepIdleOrgRuntimes(later)
      expect(released).toContain(idle)
      expect(released).not.toContain(busy)
      expect(initializedOrgRuntimes.has(idle)).toBe(false)
      expect(initializedOrgRuntimes.has(busy)).toBe(true)
      // Its next touch sets it up again.
      await awaitOrgApps(idle)
      expect(initializedOrgRuntimes.has(idle)).toBe(true)
      expect(toolRegistry.get([idle, "kernel", "user_memory_get"])).toBeDefined()
    } finally {
      env.LIAISON_ORG_RUNTIME_IDLE_MINUTES = saved
    }
  })

  it("past LIAISON_ORG_RUNTIME_MAX_ORGS a new setup releases the least recently used org, set up again at its next touch", async () => {
    const a = await newOrg()
    const b = await newOrg()
    const c = await newOrg()
    await awaitOrgApps(a)
    await awaitOrgApps(b)
    // Every other org this process holds stays out of it.
    const unholds = [...initializedOrgRuntimes]
      .filter((id) => id !== a && id !== b)
      .map((id) => holdOrgRuntime(id))
    const saved = env.LIAISON_ORG_RUNTIME_MAX_ORGS
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      return check()
    }
    try {
      orgRuntimeLastTouch.set(a, Date.now() - 60_000)
      env.LIAISON_ORG_RUNTIME_MAX_ORGS = initializedOrgRuntimes.size
      await awaitOrgApps(c)
      expect(await until(() => !initializedOrgRuntimes.has(a))).toBe(true)
      expect(initializedOrgRuntimes.has(b)).toBe(true)
      expect(initializedOrgRuntimes.has(c)).toBe(true)
      expect(toolRegistry.get([a, "kernel", "user_memory_get"])).toBeUndefined()
      // Its next touch sets it up again; now b is the least recently used.
      await awaitOrgApps(a)
      expect(toolRegistry.get([a, "kernel", "user_memory_get"])).toBeDefined()
      expect(await until(() => !initializedOrgRuntimes.has(b))).toBe(true)
      expect(initializedOrgRuntimes.has(a)).toBe(true)
      expect(initializedOrgRuntimes.has(c)).toBe(true)
    } finally {
      env.LIAISON_ORG_RUNTIME_MAX_ORGS = saved
      for (const unhold of unholds) unhold()
    }
  })

  it("a touch during a release waits for it, then finds the org set up again", async () => {
    const orgId = await newOrg()
    await awaitOrgApps(orgId)
    const releasing = releaseOrgRuntimes([orgId], { gone: false })
    // The release marked it not set up before its first await.
    expect(initializedOrgRuntimes.has(orgId)).toBe(false)
    const touched = awaitOrgApps(orgId)
    await Promise.all([releasing, touched])
    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
    expect(toolRegistry.get([orgId, "kernel", "user_memory_get"])).toBeDefined()
    expect([...registeredApps].some((k) => k.startsWith(`${orgId}:`))).toBe(true)
  })
})
