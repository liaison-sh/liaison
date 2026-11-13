// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 — connection lifecycle. On connect, seed sync_state per platform/source
// + enqueue an immediate discovery (no host-scheduler call). On disconnect,
// flip this account's sync_state rows inactive (per-connection teardown).

import { describe, expect, test } from "bun:test"
import type { Platform } from "./adapters/types"
import { onConnectionDisconnected, onConnectionEstablished, resolveAccountAuth } from "./connection"
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

  test("maps facebook → `facebook`, instagram → `instagram`, youtube → `google`", async () => {
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
    expect(seen).toEqual(["facebook", "instagram", "google"])
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

// `instagram_unified` (Meta's Unified login) is declared as a preview: its reads
// wait for a live check of the Unified-login endpoints, so connecting it seeds
// nothing, and the Instagram platform keeps reading through `instagram`.
describe("instagram_unified preview leaves the instagram path untouched", () => {
  test("connecting instagram_unified seeds no sync_state and enqueues nothing", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(
      {
        ...instagramConnect,
        data: {
          ...instagramConnect.data,
          connectionName: "instagram_unified",
          identifier: "17841400000000101",
        },
      },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(0)
    expect(ctx.__jobs).toEqual([])
  })

  test("the instagram platform still sends the `instagram` connection's credential only", async () => {
    const asked: string[] = []
    const ctx = {
      connections: {
        getAccounts: async (name: string) => {
          asked.push(name)
          return [{ identifier: "IG_1", status: "active" }]
        },
      },
    } as unknown as SocialToolCtx
    expect(await resolveAccountAuth(ctx, "instagram" as Platform, "IG_1")).toMatchObject({
      connection: "instagram",
    })
    expect(asked).toEqual(["instagram"])
  })

  test("connecting instagram still seeds the instagram platform", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(instagramConnect, ctx)
    const rows = (await db.findMany("sync_state", {})) as Array<{ platform: string }>
    expect(rows.map((r) => r.platform)).toEqual(["instagram", "instagram", "instagram"])
  })
})
