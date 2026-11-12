// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Page ids a server-wide Meta callback routes to this workspace are checked
// against Meta before a delivery is ingested (meta-pages.ts): a Page the
// account no longer manages (handed over to another workspace) is pruned from
// the list and its entries, Messenger text included, are never ingested; a
// token Meta refuses clears the list; a disconnect clears it; self-hosted
// (no routed ids) is untouched.

import { describe, expect, test } from "bun:test"
import { onConnectionDisconnected } from "./connection"
import type { SocialToolCtx } from "./ctx"
import { parseWebhookJob } from "./ingest"
import {
  CHECK_TTL_MS,
  livePagesOnly,
  MetaPagesUnavailableError,
  refreshMetaPageIds,
} from "./meta-pages"
import { createMockDb, type MockDb } from "./test-db"

type Reply = { status: number; body: string }

function harness(reply: () => Reply) {
  const db = createMockDb()
  const calls: string[] = []
  const ctx = {
    orgId: "org-1",
    db,
    fetch: async (url: string) => {
      calls.push(url)
      return reply()
    },
    connections: { getToken: async () => "user-token" },
    config: { get: async () => null },
    async emit() {},
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as SocialToolCtx
  return { db, ctx, calls }
}

const managed = (...ids: string[]): Reply => ({
  status: 200,
  body: JSON.stringify({ data: ids.map((id) => ({ id })) }),
})

async function seedRouted(db: MockDb, pages: string[], extra: Record<string, unknown> = {}) {
  for (const source_type of ["discovery", "watch", "dm"]) {
    await db.insert("sync_state", {
      platform: "facebook",
      account_external_id: "U1",
      source_type,
      active: true,
      metadata: { meta_page_ids: pages, ...extra },
    })
  }
}

async function storedIds(db: MockDb): Promise<unknown[]> {
  const rows = (await db.findMany("sync_state", { where: { platform: "facebook" } })) as Array<{
    metadata?: Record<string, unknown>
  }>
  return rows.map((r) => r.metadata?.meta_page_ids)
}

const messengerFor = (pageId: string, mid: string) => ({
  id: pageId,
  time: Date.now(),
  messaging: [
    {
      sender: { id: `psid-${mid}` },
      recipient: { id: pageId },
      timestamp: Date.UTC(2026, 0, 15, 9, 30),
      message: { mid, text: `private message ${mid}` },
    },
  ],
})

describe("livePagesOnly", () => {
  test("self-hosted (no routed Page ids): the body passes untouched, Meta is not asked", async () => {
    const h = harness(() => managed())
    const body = { object: "page", entry: [messengerFor("P1", "m1")] }
    expect(await livePagesOnly(h.ctx, body)).toBe(body)
    expect(h.calls).toEqual([])
  })

  test("a Page handed over: its entries are dropped and it leaves the routing list", async () => {
    const h = harness(() => managed("P2"))
    await seedRouted(h.db, ["P1", "P2"])
    const out = (await livePagesOnly(h.ctx, {
      object: "page",
      entry: [messengerFor("P1", "m1"), messengerFor("P2", "m2")],
    })) as { entry: Array<{ id: string }> }
    expect(out.entry.map((e) => e.id)).toEqual(["P2"])
    expect(await storedIds(h.db)).toEqual([["P2"], ["P2"], ["P2"]])
  })

  test("Meta refuses the token (#190): the list is cleared and nothing is ingested", async () => {
    const h = harness(() => ({
      status: 400,
      body: JSON.stringify({ error: { code: 190, message: "expired" } }),
    }))
    await seedRouted(h.db, ["P1"])
    const out = (await livePagesOnly(h.ctx, {
      object: "page",
      entry: [messengerFor("P1", "m1")],
    })) as {
      entry: unknown[]
    }
    expect(out.entry).toEqual([])
    expect(await storedIds(h.db)).toEqual([[], [], []])
  })

  test("a check younger than the TTL is trusted; an older one asks Meta again", async () => {
    const h = harness(() => managed("P1"))
    await seedRouted(h.db, ["P1"], { meta_pages_checked_at: new Date().toISOString() })
    await livePagesOnly(h.ctx, { object: "page", entry: [messengerFor("P1", "m1")] })
    expect(h.calls.length).toBe(0)
    await livePagesOnly(
      h.ctx,
      { object: "page", entry: [] },
      new Date(Date.now() + CHECK_TTL_MS + 1),
    )
    expect(h.calls.length).toBe(1)
  })

  test("Meta unavailable: the job fails (and retries) without dropping or keeping anything", async () => {
    const h = harness(() => ({ status: 500, body: "{}" }))
    await seedRouted(h.db, ["P1"])
    await expect(
      livePagesOnly(h.ctx, { object: "page", entry: [messengerFor("P1", "m1")] }),
    ).rejects.toBeInstanceOf(MetaPagesUnavailableError)
    expect(await storedIds(h.db)).toEqual([["P1"], ["P1"], ["P1"]])
  })
})

describe("the parse-webhook job", () => {
  test("Messenger text of a Page the workspace no longer manages is never stored", async () => {
    const h = harness(() => managed("P2"))
    await seedRouted(h.db, ["P1", "P2"])
    const r = await parseWebhookJob(h.ctx, {
      platform: "facebook",
      body: { object: "page", entry: [messengerFor("P1", "m1"), messengerFor("P2", "m2")] },
    })
    expect(r.messagesIngested).toBe(1)
    const texts = ((await h.db.findMany("dm_message")) as Array<Record<string, unknown>>).map((m) =>
      JSON.stringify(m),
    )
    expect(texts.some((t) => t.includes("private message m1"))).toBe(false)
    expect(texts.some((t) => t.includes("private message m2"))).toBe(true)
  })
})

describe("refresh on discovery and disconnect", () => {
  test("refreshMetaPageIds prunes to the Pages Meta lists", async () => {
    const h = harness(() => managed("P3"))
    await seedRouted(h.db, ["P1", "P3"])
    expect(await refreshMetaPageIds(h.ctx, "U1", { force: true })).toEqual({
      kind: "ok",
      ids: ["P3"],
    })
    expect(await storedIds(h.db)).toEqual([["P3"], ["P3"], ["P3"]])
  })

  test("a disconnect clears the account's routing list", async () => {
    const h = harness(() => managed("P1"))
    await seedRouted(h.db, ["P1"])
    await onConnectionDisconnected(
      {
        app: "kernel",
        entity: "connected_account",
        action: "delete",
        orgId: "org-1",
        data: { id: "ca-1", appName: "social", connectionName: "facebook", identifier: "U1" },
      } as never,
      h.ctx,
    )
    expect(await storedIds(h.db)).toEqual([[], [], []])
  })
})
