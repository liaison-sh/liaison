// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeIdempotency,
  invalidateIdempotency,
  reserveIdempotency,
} from "~/modules/apps/idempotency"
import { clearRedisPatterns } from "~/tests/route-test-setup"

const orgId = "00000000-0000-0000-0000-000000007101"

afterEach(async () => {
  await clearRedisPatterns([`app_idem:${orgId}:*`])
})

describe("idempotency", () => {
  it("reserve marks pending; finalize stores result for 24h", async () => {
    const r1 = await reserveIdempotency(orgId, "a:b", "k1", { p: 1 })
    expect(r1.outcome).toBe("reserved")
    await finalizeIdempotency(orgId, "a:b", "k1", { p: 1 }, { data: { x: 1 } })
    const r2 = await reserveIdempotency(orgId, "a:b", "k1", { p: 1 })
    expect(r2.outcome).toBe("hit")
    if (r2.outcome === "hit") expect(r2.cached).toEqual({ data: { x: 1 } })
  })

  it("same key + different params returns idempotency_conflict", async () => {
    await reserveIdempotency(orgId, "a:b", "k2", { p: 1 })
    await finalizeIdempotency(orgId, "a:b", "k2", { p: 1 }, { data: 1 })
    const r = await reserveIdempotency(orgId, "a:b", "k2", { p: 2 })
    expect(r.outcome).toBe("conflict")
  })

  it("concurrent reserve while pending returns in_flight", async () => {
    await reserveIdempotency(orgId, "a:b", "k3", { p: 1 })
    const r = await reserveIdempotency(orgId, "a:b", "k3", { p: 1 })
    expect(r.outcome).toBe("in_flight")
  })

  it("invalidate removes the entry; next reserve succeeds fresh", async () => {
    await reserveIdempotency(orgId, "a:b", "k4", { p: 1 })
    await finalizeIdempotency(orgId, "a:b", "k4", { p: 1 }, { data: 1 })
    await invalidateIdempotency(orgId, "a:b", "k4")
    const r = await reserveIdempotency(orgId, "a:b", "k4", { p: 1 })
    expect(r.outcome).toBe("reserved")
  })

  it("cleanupOnError DELs the pending entry", async () => {
    await reserveIdempotency(orgId, "a:b", "k5", { p: 1 })
    await invalidateIdempotency(orgId, "a:b", "k5")
    const r = await reserveIdempotency(orgId, "a:b", "k5", { p: 1 })
    expect(r.outcome).toBe("reserved")
  })
})
