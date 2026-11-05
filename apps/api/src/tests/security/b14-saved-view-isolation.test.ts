// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedSavedViewFixture } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B14 — saved view isolation: private views never leak to other users", () => {
  test("userB does not see userA's private saved view when listing the same app/viewId", async () => {
    const { privateViewId, tokenA, tokenB, app, viewId } = await seedSavedViewFixture({
      visibility: "private",
      owner: "userA",
    })
    const appReq = await buildTestApp()
    const url = `/api/saved-views?app=${encodeURIComponent(app)}&viewId=${encodeURIComponent(viewId)}`

    // Precondition: owner sees their own private view.
    const ra = await appReq.request(url, { headers: { authorization: `Bearer ${tokenA}` } })
    expect(ra.status).toBe(200)
    const bodyA = (await ra.json()) as { data: Array<{ id: string }> }
    expect(bodyA.data.some((v) => v.id === privateViewId)).toBe(true)

    // Invariant: a different user (no team membership, no share) must not.
    const rb = await appReq.request(url, { headers: { authorization: `Bearer ${tokenB}` } })
    expect(rb.status).toBe(200)
    const bodyB = (await rb.json()) as { data: Array<{ id: string }> }
    expect(bodyB.data.some((v) => v.id === privateViewId)).toBe(false)
  })
})
