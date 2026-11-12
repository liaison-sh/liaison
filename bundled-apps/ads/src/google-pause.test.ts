// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { google_pause } from "./google-pause"
import { GoogleConfigError } from "./lib/google-config"
import { createMockDb } from "./test-db"

interface FetchCall {
  url: string
  method: string
  body?: string
}

interface MockResponse {
  status: number
  body: string
}

function makeCtx(fetchResponses: MockResponse[], db = createMockDb()) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  const connections = {
    google: { getToken: async () => "oauth_tok_abc" },
    "google-config": {
      getCredentials: async () => ({
        developerToken: "dev_tok_123",
        loginCustomerId: "9998887777",
        customerId: "1234567890",
        merchantId: "mc_1",
      }),
    },
  }
  return { ctx: { fetch, connections, db, actorId: "user_1" }, calls, db }
}

function streamBody(results: unknown[]) {
  return JSON.stringify([{ results }])
}

function prePauseGet(id: string, status = "ENABLED") {
  return { status: 200, body: streamBody([{ campaign: { id, name: `Camp ${id}`, status } }]) }
}
function mutateWrite() {
  return {
    status: 200,
    body: JSON.stringify({ results: [{ resourceName: "customers/1234567890/campaigns/1" }] }),
  }
}
function postPauseGet(id: string, status = "PAUSED") {
  return { status: 200, body: streamBody([{ campaign: { id, name: `Camp ${id}`, status } }]) }
}
function adGroupPreGet(id: string, status = "ENABLED") {
  return { status: 200, body: streamBody([{ adGroup: { id, name: `Group ${id}`, status } }]) }
}
function adGroupPostGet(id: string, status = "PAUSED") {
  return { status: 200, body: streamBody([{ adGroup: { id, status } }]) }
}
function adPreGet(id: string, status = "ENABLED") {
  return { status: 200, body: streamBody([{ adGroupAd: { ad: { id }, status } }]) }
}
function adPostGet(id: string, status = "PAUSED") {
  return { status: 200, body: streamBody([{ adGroupAd: { status } }]) }
}

describe("google_pause — three-call contract", () => {
  it("calls.length===3: GAQL pre-read -> campaigns:mutate PAUSED -> GAQL re-read", async () => {
    const { ctx, calls } = makeCtx([prePauseGet("111"), mutateWrite(), postPauseGet("111")])
    await google_pause({ object_id: "111", object_type: "campaign" }, ctx)
    expect(calls.length).toBe(3)
    expect(calls[0]?.url).toContain("googleAds:searchStream")
    expect(calls[1]?.url).toContain("campaigns:mutate")
    expect(calls[1]?.body).toContain("PAUSED")
    expect(calls[2]?.url).toContain("googleAds:searchStream")
  })

  it("returns the VERIFIED post-write status from the re-read, not the mutate write echo", async () => {
    const { ctx } = makeCtx([
      prePauseGet("111", "ENABLED"),
      mutateWrite(),
      postPauseGet("111", "PAUSED"),
    ])
    const result = (await google_pause({ object_id: "111", object_type: "campaign" }, ctx)) as {
      status: string
      prior_status: string
    }
    expect(result.status).toBe("PAUSED")
    expect(result.prior_status).toBe("ENABLED")
  })

  it("writes a pause_ledger row with paused_by_us=true and the pre-read prior_status", async () => {
    const { ctx, db } = makeCtx([prePauseGet("111", "ENABLED"), mutateWrite(), postPauseGet("111")])
    await google_pause({ object_id: "111", object_type: "campaign" }, ctx)
    const rows = db.__all("pause_ledger")
    expect(rows.length).toBe(1)
    expect(rows[0]?.paused_by_us).toBe(true)
    expect(rows[0]?.prior_status).toBe("ENABLED")
    expect(rows[0]?.meta_object_id).toBe("111")
  })

  it("throws an actionable connect-error when the google connection is absent (never a crash)", async () => {
    const { calls } = makeCtx([])
    void calls
    const ctx = {
      fetch: async () => {
        throw new Error("must not be called")
      },
      connections: {},
      db: createMockDb(),
    }
    await expect(
      google_pause({ object_id: "111", object_type: "campaign" }, ctx),
    ).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

describe("google_pause — per object_type mutate path + status extraction", () => {
  it("object_type=ad_group hits adGroups:mutate and reads status from ad_group.status", async () => {
    const { ctx, calls } = makeCtx([
      adGroupPreGet("222", "ENABLED"),
      mutateWrite(),
      adGroupPostGet("222", "PAUSED"),
    ])
    const result = (await google_pause({ object_id: "222", object_type: "ad_group" }, ctx)) as {
      status: string
      prior_status: string
    }
    expect(calls[1]?.url).toContain("adGroups:mutate")
    expect(calls[1]?.body).toContain("PAUSED")
    expect(result.prior_status).toBe("ENABLED")
    expect(result.status).toBe("PAUSED")
  })

  it("object_type=ad hits adGroupAds:mutate and falls back to adGroupAd.status for extraction", async () => {
    const { ctx, calls } = makeCtx([
      adPreGet("333", "ENABLED"),
      mutateWrite(),
      adPostGet("333", "PAUSED"),
    ])
    const result = (await google_pause(
      { object_id: "20~333", object_type: "ad", ad_group_id: "20", ad_id: "333" },
      ctx,
    )) as {
      status: string
      prior_status: string
    }
    expect(calls[1]?.url).toContain("adGroupAds:mutate")
    expect(calls[1]?.body).toContain("PAUSED")
    // "ad" rows have no top-level resourceField key on the row (adGroupAd is
    // the resourceField here too, but the row is keyed adGroupAd.status, not
    // ad_group_ad.status) — the adGroupAd.status fallback must resolve it.
    expect(result.prior_status).toBe("ENABLED")
    expect(result.status).toBe("PAUSED")
  })

  it("object_type=ad builds the composite adGroupAd resourceName ({adGroupId}~{adId}), never a bare ad id", async () => {
    const { ctx, calls } = makeCtx([
      adPreGet("444", "ENABLED"),
      mutateWrite(),
      adPostGet("444", "PAUSED"),
    ])
    await google_pause({ object_type: "ad", ad_group_id: "77", ad_id: "444" } as never, ctx)
    expect(calls[1]?.body).toContain("adGroupAds/77~444")
  })

  it("object_type=ad accepts a pre-composed object_id (adGroupId~adId) as an alternative to ad_group_id+ad_id", async () => {
    const { ctx, calls } = makeCtx([
      adPreGet("555", "ENABLED"),
      mutateWrite(),
      adPostGet("555", "PAUSED"),
    ])
    await google_pause({ object_id: "88~555", object_type: "ad" }, ctx)
    expect(calls[1]?.body).toContain("adGroupAds/88~555")
  })

  it("object_type=ad without ad_group_id/ad_id or a composite object_id throws an actionable error", async () => {
    const { ctx } = makeCtx([])
    await expect(google_pause({ object_id: "333", object_type: "ad" }, ctx)).rejects.toThrow(
      /composite/,
    )
  })
})

describe("google_pause — bulk-pause notification threshold", () => {
  it("does NOT emit ads:bulk_pause_threshold on the 3rd campaign-level pause within the hour", async () => {
    const db = createMockDb()
    // Seed 2 prior campaign-level pauses within the last hour.
    const now = new Date().toISOString()
    db.__seed("pause_ledger", [
      {
        meta_object_id: "a",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "campaign",
        created_at: now,
      },
      {
        meta_object_id: "b",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "campaign",
        created_at: now,
      },
    ])
    const emitted: Array<{ event: string; payload: unknown }> = []
    const { ctx } = makeCtx([prePauseGet("c"), mutateWrite(), postPauseGet("c")], db)
    ;(ctx as unknown as { emit: unknown }).emit = async (event: string, payload: unknown) => {
      emitted.push({ event, payload })
    }
    await google_pause({ object_id: "c", object_type: "campaign" }, ctx)
    expect(emitted.length).toBe(0)
  })

  it("emits ads:bulk_pause_threshold with count+objectIds on the 4th campaign-level pause within the hour", async () => {
    const db = createMockDb()
    const now = new Date().toISOString()
    db.__seed("pause_ledger", [
      {
        meta_object_id: "a",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "campaign",
        created_at: now,
      },
      {
        meta_object_id: "b",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "campaign",
        created_at: now,
      },
      {
        meta_object_id: "c",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "campaign",
        created_at: now,
      },
    ])
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
    const { ctx } = makeCtx([prePauseGet("d"), mutateWrite(), postPauseGet("d")], db)
    ;(ctx as unknown as { emit: unknown }).emit = async (
      event: string,
      payload: Record<string, unknown>,
    ) => {
      emitted.push({ event, payload })
    }
    const result = await google_pause({ object_id: "d", object_type: "campaign" }, ctx)
    expect(emitted.length).toBe(1)
    expect(emitted[0]?.event).toBe("ads:bulk_pause_threshold")
    expect(emitted[0]?.payload.count).toBe(4)
    expect(emitted[0]?.payload.window).toBe("1h")
    expect(emitted[0]?.payload.objectIds).toContain("d")
    // The threshold never blocks the pause — the pause result is still returned.
    expect((result as { status: string }).status).toBe("PAUSED")
  })

  it("does not count non-campaign-level pauses toward the campaign threshold", async () => {
    const db = createMockDb()
    const now = new Date().toISOString()
    db.__seed("pause_ledger", [
      {
        meta_object_id: "a",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "ad_group",
        created_at: now,
      },
      {
        meta_object_id: "b",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "ad_group",
        created_at: now,
      },
      {
        meta_object_id: "c",
        prior_status: "ENABLED",
        paused_by_us: true,
        reason: "x",
        object_type: "ad_group",
        created_at: now,
      },
    ])
    const emitted: Array<{ event: string }> = []
    const { ctx } = makeCtx([prePauseGet("d"), mutateWrite(), postPauseGet("d")], db)
    ;(ctx as unknown as { emit: unknown }).emit = async (event: string) => {
      emitted.push({ event })
    }
    await google_pause({ object_id: "d", object_type: "campaign" }, ctx)
    expect(emitted.length).toBe(0)
  })
})
