// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 — connection lifecycle. On connect, seed sync_state per platform/source
// + enqueue an immediate discovery (no host-scheduler call). On disconnect,
// flip this account's sync_state rows inactive (per-connection teardown).

import { describe, expect, test } from "bun:test"
import type { Platform } from "./adapters/types"
import {
  onConnectionDisconnected,
  onConnectionEstablished,
  resolveAccountAuth,
  resolveConnectedAccount,
} from "./connection"
import type { SocialToolCtx } from "./ctx"
import { createMockDb, type MockDb } from "./test-db"

type Job = { name: string; payload: unknown; opts?: { delay?: number; jobId?: string } }

function makeCtx(db: MockDb): SocialToolCtx & { __jobs: Job[] } {
  const jobs: Job[] = []
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => "",
    })) as never,
    connections: {},
    config: { get: async () => null },
    async emit() {},
    async enqueueJob(name, payload, opts) {
      jobs.push({ name, payload, ...(opts ? { opts } : {}) })
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    __jobs: jobs,
  } as SocialToolCtx & { __jobs: Job[] }
}

const instagramConnect = {
  app: "kernel" as const,
  entity: "connected_account" as const,
  action: "create" as const,
  orgId: "org-1",
  data: { id: "ca-1", appName: "social", connectionName: "instagram", identifier: "IG_1" },
}

describe("onConnectionEstablished (B10)", () => {
  test("seeds sync_state for instagram discovery/watch/dm and enqueues an immediate discovery", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    // instagram × {discovery, watch, dm} = 3 rows
    expect(await db.count("sync_state")).toBe(3)
    const discovery = (await db.findMany("sync_state", {
      where: { source_type: "discovery" },
    })) as Array<{
      active: boolean
    }>
    expect(discovery.length).toBe(1)
    expect(discovery.every((r) => r.active === true)).toBe(true)
    expect(ctx.__jobs.filter((j) => j.name === "discovery-sync").length).toBe(1)
  })

  test("the discovery kick is one deduplicated job, after every sync row is written", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    // The discovery job syncs every active row: kicks from connects close
    // together share one id, so the queue runs it once.
    await onConnectionEstablished(instagramConnect, ctx)
    await onConnectionEstablished(instagramConnect, ctx)
    const kicks = ctx.__jobs.filter((j) => j.name === "discovery-sync")
    expect(kicks.length).toBe(2)
    for (const k of kicks) {
      expect(k.opts?.jobId).toBe("discovery-sync-on-connect")
      expect(k.opts?.delay).toBeGreaterThan(0)
    }
  })

  test("facebook connection seeds facebook discovery/watch/dm", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(
      {
        ...instagramConnect,
        data: { ...instagramConnect.data, connectionName: "facebook", identifier: "PAGE_1" },
      },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(3)
    const fb = (await db.findMany("sync_state", { where: { platform: "facebook" } })) as unknown[]
    expect(fb.length).toBe(3)
  })

  test("ignores events for other apps", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(
      { ...instagramConnect, data: { ...instagramConnect.data, appName: "boxtal" } },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(0)
  })

  test("re-connect reactivates existing rows (idempotent, no duplicates)", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    await onConnectionEstablished(instagramConnect, ctx)
    expect(await db.count("sync_state")).toBe(3)
  })

  test("google connection seeds youtube discovery/watch (no dm)", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(
      {
        ...instagramConnect,
        data: { ...instagramConnect.data, connectionName: "google", identifier: "CHAN_1" },
      },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(2)
    expect(await db.count("sync_state", { where: { source_type: "dm" } })).toBe(0)
    // No DMs on YouTube: only the discovery kick is queued.
    expect(ctx.__jobs.filter((j) => j.name === "dm-sync").length).toBe(0)
    expect(ctx.__jobs.filter((j) => j.name === "discovery-sync").length).toBe(1)
  })

  test("a connection that carries DMs queues a deduplicated dm-sync next to discovery", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    const discovery = ctx.__jobs.filter((j) => j.name === "discovery-sync")
    const dm = ctx.__jobs.filter((j) => j.name === "dm-sync")
    expect(discovery.length).toBe(1)
    expect(dm.length).toBe(1)
    expect(dm[0]?.opts?.jobId).toBe("dm-sync-on-connect")
    expect(dm[0]?.opts?.delay).toBeGreaterThan(0)
  })
})

describe("onConnectionDisconnected (B10)", () => {
  test("flips this account's sync_state rows inactive", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    await onConnectionDisconnected(instagramConnect, ctx)
    const rows = (await db.findMany("sync_state")) as Array<{ active: boolean }>
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.active === false)).toBe(true)
  })
})

describe("resolveAccountAuth — the connected account's host-side credential", () => {
  type Account = { identifier: string; status: string }
  // FLAT sandbox-bridge shape: connections.getAccounts(name).
  function flatCtx(impl: (name: string) => Promise<Account[] | string>): SocialToolCtx {
    return { connections: { getAccounts: impl } } as unknown as SocialToolCtx
  }
  // RECORD SDK shape: connections[name].getAccounts().
  function recordCtx(map: Record<string, () => Promise<Account[]>>): SocialToolCtx {
    const conns: Record<string, { getAccounts: () => Promise<Account[]> }> = {}
    for (const [k, v] of Object.entries(map)) conns[k] = { getAccounts: v }
    return { connections: conns } as unknown as SocialToolCtx
  }
  const active = (identifier: string): Account => ({ identifier, status: "active" })

  test("maps facebook → `facebook`, instagram → `instagram_unified` then `instagram`, youtube → `google`", async () => {
    const seen: string[] = []
    const ctx = flatCtx(async (name) => {
      seen.push(name)
      return [active("PAGE_1"), active("IG_1"), active("CHAN_1")]
    })
    expect(await resolveAccountAuth(ctx, "facebook" as Platform, "PAGE_1")).toEqual({
      connection: "facebook",
      identifier: "PAGE_1",
      scheme: "bearer",
    })
    await resolveAccountAuth(ctx, "instagram" as Platform, "IG_1")
    expect(await resolveAccountAuth(ctx, "youtube" as Platform, "CHAN_1")).toMatchObject({
      connection: "google",
    })
    // This host lists IG_1 under every name, so the first candidate holds it.
    expect(seen).toEqual(["facebook", "instagram_unified", "google"])
  })

  test("reads the FLAT shape's JSON answer and the RECORD SDK shape", async () => {
    const flat = flatCtx(async () => JSON.stringify([active("PAGE_1")]))
    expect(await resolveAccountAuth(flat, "facebook" as Platform, "PAGE_1")).not.toBeNull()
    const record = recordCtx({ instagram: async () => [active("IG_1")] })
    expect(await resolveAccountAuth(record, "instagram" as Platform, "IG_1")).not.toBeNull()
  })

  test("returns null for an account that is not connected, a host that throws, or no accessor", async () => {
    const other = flatCtx(async () => [active("PAGE_2")])
    expect(await resolveAccountAuth(other, "facebook" as Platform, "PAGE_1")).toBeNull()
    const throws = flatCtx(async () => {
      throw new Error("No connected account")
    })
    expect(await resolveAccountAuth(throws, "youtube" as Platform, "CHAN_1")).toBeNull()
    const none = { connections: {} } as unknown as SocialToolCtx
    expect(await resolveAccountAuth(none, "facebook" as Platform, "PAGE_1")).toBeNull()
  })
})

// `instagram_unified` (Meta's Instagram API with Unified login) backs the same
// Instagram platform as `instagram`: connecting it seeds the instagram rows and
// the platform's credential resolves through whichever connection holds the account.
describe("instagram_unified backs the instagram platform", () => {
  const unifiedConnect = {
    ...instagramConnect,
    data: {
      ...instagramConnect.data,
      connectionName: "instagram_unified",
      identifier: "17841400000000101",
    },
  }

  test("connecting instagram_unified seeds instagram discovery/watch/dm and kicks discovery", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(unifiedConnect, ctx)
    const rows = (await db.findMany("sync_state", {})) as Array<{
      platform: string
      account_external_id: string
      source_type: string
    }>
    expect(rows.map((r) => [r.platform, r.account_external_id, r.source_type])).toEqual([
      ["instagram", "17841400000000101", "discovery"],
      ["instagram", "17841400000000101", "watch"],
      ["instagram", "17841400000000101", "dm"],
    ])
    expect(ctx.__jobs.filter((j) => j.name === "discovery-sync").length).toBe(1)
  })

  test("disconnecting instagram_unified flips its instagram rows inactive", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(unifiedConnect, ctx)
    await onConnectionDisconnected(unifiedConnect, ctx)
    const rows = (await db.findMany("sync_state")) as Array<{ active: boolean }>
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.active === false)).toBe(true)
  })

  test("resolves an instagram account held only by instagram_unified", async () => {
    const ctx = {
      connections: {
        getAccounts: async (name: string) =>
          name === "instagram_unified"
            ? [{ identifier: "17841400000000101", status: "active" }]
            : [],
      },
    } as unknown as SocialToolCtx
    expect(await resolveAccountAuth(ctx, "instagram" as Platform, "17841400000000101")).toEqual({
      connection: "instagram_unified",
      identifier: "17841400000000101",
      scheme: "bearer",
    })
  })

  test("prefers the connection that holds the identifier when both exist", async () => {
    const ctx = {
      connections: {
        getAccounts: async (name: string) =>
          name === "instagram_unified"
            ? [{ identifier: "17841400000000101", status: "active" }]
            : [{ identifier: "IG_1", status: "active" }],
      },
    } as unknown as SocialToolCtx
    expect(await resolveAccountAuth(ctx, "instagram" as Platform, "IG_1")).toMatchObject({
      connection: "instagram",
    })
    expect(
      await resolveAccountAuth(ctx, "instagram" as Platform, "17841400000000101"),
    ).toMatchObject({ connection: "instagram_unified" })
  })

  test("the RECORD SDK shape resolves an instagram_unified account too", async () => {
    const ctx = {
      connections: {
        instagram_unified: { getAccounts: async () => [{ identifier: "IG_U", status: "active" }] },
      },
    } as unknown as SocialToolCtx
    expect(await resolveAccountAuth(ctx, "instagram" as Platform, "IG_U")).toMatchObject({
      connection: "instagram_unified",
    })
  })

  test("connecting instagram still seeds the instagram platform", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    const rows = (await db.findMany("sync_state", {})) as Array<{ platform: string }>
    expect(rows.map((r) => r.platform)).toEqual(["instagram", "instagram", "instagram"])
  })
})

describe("resolveConnectedAccount: the platform's first active account whose credential resolves", () => {
  test("skips a seeded row with no connected account behind it", async () => {
    const db = createMockDb()
    // A seeded (demo) row first, then the real connected account.
    await db.insert("sync_state", {
      platform: "instagram",
      account_external_id: "seeded-ig",
      source_type: "discovery",
      active: true,
    })
    await db.insert("sync_state", {
      platform: "instagram",
      account_external_id: "17841400000000101",
      source_type: "discovery",
      active: true,
    })
    const ctx = makeCtx(db)
    ctx.connections = {
      getAccounts: async (name: string) =>
        name === "instagram_unified" ? [{ identifier: "17841400000000101", status: "active" }] : [],
    }
    expect(await resolveConnectedAccount(ctx, "instagram" as Platform)).toEqual({
      accountExternalId: "17841400000000101",
      auth: { connection: "instagram_unified", identifier: "17841400000000101", scheme: "bearer" },
    })
  })

  test("returns null when no active row resolves", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      platform: "instagram",
      account_external_id: "seeded-ig",
      source_type: "discovery",
      active: true,
    })
    const ctx = makeCtx(db)
    ctx.connections = { getAccounts: async () => [] }
    expect(await resolveConnectedAccount(ctx, "instagram" as Platform)).toBeNull()
  })
})
