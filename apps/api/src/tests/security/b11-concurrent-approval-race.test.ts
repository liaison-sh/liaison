// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedApproval } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B11 — concurrent approval race: exactly one outcome wins, losers get 409", () => {
  test("50 concurrent approve/deny attempts produce exactly one 200 and only 409s otherwise", async () => {
    const { approvalId, tokenB } = await seedApproval()
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${tokenB}`, "content-type": "application/json" }

    // The payload the deciders were shown: an approve is bound to it.
    const shown = await app.request(`/api/approvals/${approvalId}`, { headers: hdr })
    const payloadHash = ((await shown.json()) as any).data.payloadHash as string

    // 50 approve + 50 deny in parallel against the same approval id.
    const calls: Array<Response | Promise<Response>> = []
    const fire = (body: string) =>
      app.request(`/api/approvals/${approvalId}/decide`, { method: "POST", headers: hdr, body })
    for (let i = 0; i < 50; i++) {
      calls.push(fire(JSON.stringify({ decision: "approve", payloadHash })))
      calls.push(fire(JSON.stringify({ decision: "deny", reason: "race" })))
    }
    const results = await Promise.all(calls)
    const statuses = results.map((r) => r.status).sort()
    const ok = statuses.filter((s) => s === 200).length
    const conflicts = statuses.filter((s) => s === 409).length
    // Exactly one winner; everyone else conflicts. No 5xx, no surprise 4xx.
    expect(ok).toBe(1)
    expect(conflicts).toBe(statuses.length - 1)
    expect(new Set(statuses)).toEqual(new Set([200, 409]))

    // Final persisted state must be one of the two valid terminal values.
    const [row] = await withSystemDb("b11-final", async (db) =>
      db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)),
    )
    expect(["approved", "denied"]).toContain(row!.status)
  })
})
