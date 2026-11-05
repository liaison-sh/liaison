// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 — connection lifecycle. On connect, seed sync_state per platform/source
// + enqueue an immediate discovery (no host-scheduler call). On disconnect,
// flip this account's sync_state rows inactive (per-connection teardown).

import { describe, expect, test } from "bun:test"
import type { Platform } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import { onConnectionDisconnected, onConnectionEstablished, resolveAccessToken } from "./connection"
import { createMockDb, type MockDb } from "./test-db"

function makeCtx(db: MockDb): SocialToolCtx & { __jobs: Array<{ name: string; payload: unknown }> } {
  const jobs: Array<{ name: string; payload: unknown }> = []
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => "" })) as never,
    connections: {},
    config: { get: async () => null },
    async emit() {},
    async enqueueJob(name, payload) {
      jobs.push({ name, payload })
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    __jobs: jobs,
  } as SocialToolCtx & { __jobs: Array<{ name: string; payload: unknown }> }
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
    const discovery = (await db.findMany("sync_state", { where: { source_type: "discovery" } })) as Array<{
      active: boolean
    }>
    expect(discovery.length).toBe(1)
    expect(discovery.every((r) => r.active === true)).toBe(true)
    expect(ctx.__jobs.filter((j) => j.name === "discovery-sync").length).toBe(1)
  })

  test("facebook connection seeds facebook discovery/watch/dm", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished(
      { ...instagramConnect, data: { ...instagramConnect.data, connectionName: "facebook", identifier: "PAGE_1" } },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(3)
    const fb = (await db.findMany("sync_state", { where: { platform: "facebook" } })) as unknown[]
    expect(fb.length).toBe(3)
  })

  test("ignores events for other apps", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await onConnectionEstablished({ ...instagramConnect, data: { ...instagramConnect.data, appName: "boxtal" } }, ctx)
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
      { ...instagramConnect, data: { ...instagramConnect.data, connectionName: "google", identifier: "CHAN_1" } },
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

describe("resolveAccessToken — per-platform OAuth token resolution", () => {
  // FLAT sandbox-bridge shape: connections.getToken(name, identifier).
  function flatCtx(impl: (name: string, identifier?: string) => Promise<string>): SocialToolCtx {
    return { connections: { getToken: impl } } as unknown as SocialToolCtx
  }
  // RECORD SDK shape: connections[name].getToken(identifier).
  function recordCtx(
    map: Record<string, (identifier?: string) => Promise<string>>,
  ): SocialToolCtx {
    const conns: Record<string, { getToken: (id?: string) => Promise<string> }> = {}
    for (const [k, v] of Object.entries(map)) conns[k] = { getToken: v }
    return { connections: conns } as unknown as SocialToolCtx
  }

  test("maps facebook → `facebook`, instagram → `instagram`, youtube → `google`", async () => {
    const seen: Array<{ name: string; id?: string }> = []
    const ctx = flatCtx(async (name, id) => {
      seen.push({ name, id })
      return "tok"
    })
    await resolveAccessToken(ctx, "facebook" as Platform, "PAGE_1")
    await resolveAccessToken(ctx, "instagram" as Platform, "IG_1")
    await resolveAccessToken(ctx, "youtube" as Platform, "CHAN_1")
    expect(seen).toEqual([
      { name: "facebook", id: "PAGE_1" },
      { name: "instagram", id: "IG_1" },
      { name: "google", id: "CHAN_1" },
    ])
  })

  test("returns the token from the FLAT bridge shape", async () => {
    const ctx = flatCtx(async () => "flat-token")
    expect(await resolveAccessToken(ctx, "facebook" as Platform, "PAGE_1")).toBe("flat-token")
  })

  test("returns the token from the RECORD SDK shape", async () => {
    const ctx = recordCtx({ instagram: async () => "record-token" })
    expect(await resolveAccessToken(ctx, "instagram" as Platform, "IG_1")).toBe("record-token")
  })

  test("returns null when the host throws (no connected account / expired token)", async () => {
    const ctx = flatCtx(async () => {
      throw new Error("No access token stored")
    })
    expect(await resolveAccessToken(ctx, "youtube" as Platform, "CHAN_1")).toBeNull()
  })

  test("returns null when an empty token is stored", async () => {
    const ctx = flatCtx(async () => "")
    expect(await resolveAccessToken(ctx, "facebook" as Platform, "PAGE_1")).toBeNull()
  })

  test("returns null when no connections accessor is present", async () => {
    const ctx = { connections: {} } as unknown as SocialToolCtx
    expect(await resolveAccessToken(ctx, "facebook" as Platform, "PAGE_1")).toBeNull()
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
        data: { ...instagramConnect.data, connectionName: "instagram_unified", identifier: "17841400000000101" },
      },
      ctx,
    )
    expect(await db.count("sync_state")).toBe(0)
    expect(ctx.__jobs).toEqual([])
  })

  test("the instagram platform still resolves its token from the `instagram` connection only", async () => {
    const asked: string[] = []
    const ctx = {
      connections: {
        getToken: async (name: string) => {
          asked.push(name)
          return "tok"
        },
      },
    } as unknown as SocialToolCtx
    expect(await resolveAccessToken(ctx, "instagram" as Platform, "IG_1")).toBe("tok")
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
