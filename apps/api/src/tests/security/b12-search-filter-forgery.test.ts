// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

// The plan delegates the search-permission invariant to B7. B12 nails down the
// forgery-vector matrix as a separate set of assertions: each query-string
// forgery shape that an attacker might try must produce a response that does
// not leak orgA rows to userB.
const FORGERY_VECTORS: Array<{ name: string; querySuffix: string }> = [
  { name: "kernel-shape filter", querySuffix: "&filter=orgId:any" },
  { name: "meili-shape filter", querySuffix: "&meilisearch_filter=orgId%3D%22any%22" },
  { name: "raw orgId injection", querySuffix: "&orgId=any" },
  { name: "userId override", querySuffix: "&userId=any" },
  { name: "scope override", querySuffix: "&scopes=admin" },
  { name: "limit overflow", querySuffix: "&limit=100000" },
]

describe("B12 — search filter forgery matrix", () => {
  test("each forgery vector produces a response that never leaks orgA secret thread id", async () => {
    const { orgA, tokenB } = await seedTwoOrgsWithIsolatedData()
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${tokenB}` }
    for (const v of FORGERY_VECTORS) {
      const r = await app.request(`/api/search?q=secret${v.querySuffix}`, { headers: hdr })
      // 200 (empty / filtered) or 503 (Meili unavailable) or 400 (zValidator
      // rejected the malformed query) all preserve the invariant.
      expect([200, 400, 503]).toContain(r.status)
      const text = await r.text()
      expect(text.includes(orgA.secretThreadId)).toBe(false)
    }
  })
})
