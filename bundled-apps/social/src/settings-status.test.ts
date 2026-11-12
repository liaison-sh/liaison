// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings read tools: connections_status (per-connection kernel status) and
// quota_status (per-platform usage). Mock ctx: the kernel describe bridge and
// an in-memory sync_state.

import { describe, expect, test } from "bun:test"
import type { SocialToolCtx } from "./ctx"
import {
  type ConnectionAccount,
  connectionsStatus,
  deriveConnectionState,
  quotaStatus,
} from "./settings-status"
import { createMockDb, type MockDb } from "./test-db"

const NOW = new Date("2026-10-20T12:00:00Z")

function account(over: Partial<ConnectionAccount>): ConnectionAccount {
  return {
    id: "a1",
    identifier: "id-1",
    displayName: null,
    ownerType: "org",
    isMine: false,
    status: "active",
    statusMessage: null,
    tokenExpiresAt: null,
    hasRefreshToken: false,
    connectedByName: "Sam",
    connectedAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  }
}

function makeCtx(db: MockDb, connections: unknown): SocialToolCtx {
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, body: "" })) as never,
    connections,
    config: { get: async () => null },
    async emit() {},
  } as SocialToolCtx
}

describe("connections_status", () => {
  test("lists facebook, instagram and google with each one's real kernel state", async () => {
    const asked: string[] = []
    const byName: Record<string, ConnectionAccount[]> = {
      facebook: [account({ identifier: "fb-user", displayName: "Resonant Audio Labs Page" })],
      instagram: [account({ identifier: "ig-1", ownerType: "user", isMine: true })],
      google: [],
    }
    const ctx = makeCtx(createMockDb(), {
      // The sandbox bridge's FLAT shape; it answers a JSON string.
      describe: async (name: string) => {
        asked.push(name)
        return JSON.stringify(byName[name] ?? [])
      },
    })
    const res = await connectionsStatus({}, ctx, NOW)
    expect(res.available).toBe(true)
    expect(asked).toEqual(["facebook", "instagram", "google"])
    expect(res.connections.map((c) => [c.name, c.state])).toEqual([
      ["facebook", "connected"],
      ["instagram", "connected"],
      ["google", "not_connected"],
    ])
    expect(res.connections[0]!.primary?.displayName).toBe("Resonant Audio Labs Page")
    expect(res.connections[1]!.primary?.ownerType).toBe("user")
  })

  test("a kernel without describe answers available false, never a fake Not connected", async () => {
    const res = await connectionsStatus(
      {},
      makeCtx(createMockDb(), { getToken: async () => "t" }),
      NOW,
    )
    expect(res.available).toBe(false)
  })
})

describe("deriveConnectionState", () => {
  test("org active row wins over a personal one", () => {
    const r = deriveConnectionState(
      [account({ id: "p", ownerType: "user", isMine: true }), account({ id: "o" })],
      NOW,
    )
    expect(r.primary?.id).toBe("o")
    expect(r.state).toBe("connected")
  })
  test("error row, expired token and near expiry", () => {
    expect(deriveConnectionState([account({ status: "error" })], NOW).state).toBe("needs_reconnect")
    expect(
      deriveConnectionState([account({ tokenExpiresAt: "2026-10-19T00:00:00Z" })], NOW).state,
    ).toBe("needs_reconnect")
    expect(
      deriveConnectionState([account({ tokenExpiresAt: "2026-10-23T00:00:00Z" })], NOW).state,
    ).toBe("expiring")
    expect(
      deriveConnectionState([account({ tokenExpiresAt: "2026-12-23T00:00:00Z" })], NOW).state,
    ).toBe("connected")
    expect(deriveConnectionState([], NOW).state).toBe("not_connected")
  })
  test("a stored refresh token renews access: an expired or near expiry access token is still connected", () => {
    const past = "2026-10-19T00:00:00Z"
    const soon = "2026-10-23T00:00:00Z"
    expect(
      deriveConnectionState([account({ tokenExpiresAt: past, hasRefreshToken: true })], NOW).state,
    ).toBe("connected")
    expect(
      deriveConnectionState([account({ tokenExpiresAt: soon, hasRefreshToken: true })], NOW).state,
    ).toBe("connected")
  })
  test("without a refresh token an expired access token needs a reconnect, and a failed refresh always does", () => {
    const past = "2026-10-19T00:00:00Z"
    expect(
      deriveConnectionState([account({ tokenExpiresAt: past, hasRefreshToken: false })], NOW).state,
    ).toBe("needs_reconnect")
    expect(
      deriveConnectionState(
        [account({ status: "error", tokenExpiresAt: past, hasRefreshToken: true })],
        NOW,
      ).state,
    ).toBe("needs_reconnect")
  })
})

describe("quota_status", () => {
  test("YouTube: sums today's units across the discovery and watch rows (quota ledger read)", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "discovery",
      active: true,
      units_consumed_today: 6069,
      units_window_date: "2026-10-20",
      metadata: {},
    })
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "watch",
      active: true,
      units_consumed_today: 2000,
      units_window_date: "2026-10-20",
      metadata: {},
    })
    await db.insert("sync_state", {
      platform: "facebook",
      account_external_id: "fb",
      source_type: "dm",
      active: true,
      units_consumed_today: 0,
      metadata: {},
    })
    const res = await quotaStatus({}, makeCtx(db, {}), NOW)
    expect(res.youtube).not.toBeNull()
    expect(res.youtube!.consumed).toBe(8069)
    expect(res.youtube!.day).toBe("2026-10-20")
    expect(res.youtube!.remaining).toBe(res.youtube!.cap - 8069)
    expect(res.youtube!.source).toBe("ledger")
    expect(res.youtube!.bySource).toEqual([
      { source: "discovery", consumed: 6069 },
      { source: "watch", consumed: 2000 },
    ])
    // Meta has no unit quota and no stored rate-limit state: omitted.
    expect(res.rateLimits).toEqual([])
  })

  test("YouTube: units from an older quota day are not counted as today's", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "discovery",
      active: true,
      units_consumed_today: 50,
      units_window_date: "2026-10-20",
      metadata: {},
    })
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "watch",
      active: true,
      units_consumed_today: 9000,
      units_window_date: "2026-10-19",
      metadata: {},
    })
    const res = await quotaStatus({}, makeCtx(db, {}), NOW)
    expect(res.youtube!.consumed).toBe(50)
  })

  test("YouTube: reads the ledger's exhaustion, reset instant and deferred watch count (readYoutubeQuotaStatus)", async () => {
    const db = createMockDb()
    // NOW is 2026-10-20 05:00 Pacific: Google refused for quota until the next Pacific midnight.
    const exhaustedUntil = "2026-10-21T07:00:00.000Z"
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "discovery",
      active: true,
      units_consumed_today: 4000,
      units_window_date: "2026-10-20",
      metadata: { youtube_quota: { exhausted_until: exhaustedUntil } },
    })
    await db.insert("sync_state", {
      platform: "youtube",
      account_external_id: "ch",
      source_type: "watch",
      active: true,
      units_consumed_today: 100,
      units_window_date: "2026-10-20",
      metadata: { youtube_quota: { deferred: 7 } },
    })
    const res = await quotaStatus({}, makeCtx(db, {}), NOW)
    expect(res.youtube).not.toBeNull()
    expect(res.youtube!.source).toBe("ledger")
    expect(res.youtube!.day).toBe("2026-10-20")
    expect(res.youtube!.resetsAt).toBe(exhaustedUntil)
    expect(res.youtube!.exhaustedUntil).toBe(exhaustedUntil)
    // Exhausted: nothing remains until the reset, whatever the cap says.
    expect(res.youtube!.remaining).toBe(0)
    expect(res.youtube!.consumed).toBe(4100)
    expect(res.youtube!.deferred).toBe(7)
  })

  test("Meta appears only with a stored rate-limit state; no YouTube row means no YouTube entry", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      platform: "instagram",
      account_external_id: "ig",
      source_type: "dm",
      active: true,
      metadata: { rate_limited_until: "2026-10-20T13:00:00Z", cursor_hint: "x" },
    })
    const res = await quotaStatus({}, makeCtx(db, {}), NOW)
    expect(res.youtube).toBeNull()
    expect(res.rateLimits).toEqual([
      { platform: "instagram", rateLimit: { rate_limited_until: "2026-10-20T13:00:00Z" } },
    ])
  })
})
