// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B7 — search permission safety: forged filter params do not leak cross-org rows", () => {
  test("userB never sees orgA-indexed entities through ?filter= or ?meilisearch_filter= forgery", async () => {
    const { orgA, tokenB } = await seedTwoOrgsWithIsolatedData()
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${tokenB}` }

    // Vector 1: kernel-style forged filter.
    const forgedKernel = await app.request("/api/search?q=secret&filter=orgId:any", {
      headers: hdr,
    })
    expect([200, 503]).toContain(forgedKernel.status)
    const t1 = await forgedKernel.text()
    expect(t1.includes(orgA.secretThreadId)).toBe(false)
    if (forgedKernel.status === 200) {
      const b1 = JSON.parse(t1) as { data: unknown }
      const items = (Array.isArray(b1.data) ? b1.data : []) as unknown[]
      expect(items.length).toBe(0)
    }

    // Vector 2: meili-shape forged filter (the query string is silently
    // dropped by `zValidator`, but the assertion must still hold).
    const meiliQs = `orgId="${orgA.id}"`
    const forgedMeili = await app.request(
      `/api/search?q=secret&meilisearch_filter=${encodeURIComponent(meiliQs)}`,
      { headers: hdr },
    )
    expect([200, 503]).toContain(forgedMeili.status)
    const t2 = await forgedMeili.text()
    expect(t2.includes(orgA.secretThreadId)).toBe(false)
    if (forgedMeili.status === 200) {
      const b2 = JSON.parse(t2) as { data: unknown }
      const items = (Array.isArray(b2.data) ? b2.data : []) as unknown[]
      expect(items.length).toBe(0)
    }
  })
})
