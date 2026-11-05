// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B4 — agent permission boundary: agent tool returns same data set as direct REST", () => {
  test("userB sees zero threads via both REST and the kernel:threads_search agent tool", async () => {
    const { tokenB } = await seedTwoOrgsWithIsolatedData()
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${tokenB}` }

    const restResp = await app.request("/api/threads", { headers: hdr })
    expect(restResp.status).toBe(200)
    const restBody = (await restResp.json()) as { data: unknown }
    const restThreads = (Array.isArray(restBody.data) ? restBody.data : []) as Array<{ id: string }>

    const agentResp = await app.request("/api/apps/tools/kernel:threads_search", {
      method: "POST",
      headers: { ...hdr, "content-type": "application/json" },
      body: JSON.stringify({ params: { query: "" } }),
    })
    expect(agentResp.status).toBe(200)
    const agentBody = (await agentResp.json()) as { data: { threads?: Array<{ id: string }> } }
    const agentThreads = agentBody.data?.threads ?? []

    // Same set of thread IDs visible through both paths.
    const restIds = new Set(restThreads.map((t) => t.id))
    const agentIds = new Set(agentThreads.map((t) => t.id))
    expect([...agentIds]).toEqual([...restIds])

    // Boundary holds: a freshly bootstrapped org B should have zero threads
    // visible to its admin until one is created.
    expect(restIds.size).toBe(0)
  })
})
