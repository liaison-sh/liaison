// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 A4 — Version-check endpoint caches, falls back stale, and honours
// the org opt-out (E2E plan 16-phase-14-e2e-plan.md).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld } from "@liaison/test-helpers"
import { allocatePorts, api, type WorkerEnv } from "@liaison/test-helpers"
import {
  type FakeGitHubReleasesHandle,
  startFakeGitHubReleases,
} from "./helpers/mock-github-releases"
import { setupScenario, teardownScenario } from "./setup"

describe("/api/admin/version-check end-to-end", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let fakeGh: FakeGitHubReleasesHandle
  let ghPort: number
  let token: string
  let orgId: string

  beforeAll(async () => {
    ;[ghPort] = await allocatePorts(1)
    fakeGh = await startFakeGitHubReleases(ghPort, {
      latest: "v0.1.1",
      htmlUrl: "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    })
    const result = await setupScenario({
      seed: 14,
      org: { name: "Version Check E2E" },
      serverEnv: {
        LIAISON_VERSION: "v0.1.0",
        GITHUB_API_BASE: fakeGh.url,
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    token = world.admin.token
    orgId = world.org.id

    // Clear the worker-prefixed version-check cache keys so each test sees a
    // clean slate against the same long-lived worker. Production prepends
    // `REDIS_PREFIX` via ioredis keyPrefix; in tests we read the raw client.
    await env.redis.redis.del(
      `${env.redisPrefix}versionCheck:latest`,
      `${env.redisPrefix}versionCheck:latest:last`,
    )
  }, 120_000)

  afterAll(async () => {
    if (fakeGh) await fakeGh.kill()
    await teardownScenario(env, world)
  }, 15_000)

  async function clearCaches() {
    await env.redis.redis.del(
      `${env.redisPrefix}versionCheck:latest`,
      `${env.redisPrefix}versionCheck:latest:last`,
    )
  }

  it("returns running + latest + latestUrl, caches, and does not refetch on the second call", async () => {
    await clearCaches()
    fakeGh.resetRequests()
    fakeGh.setStatus(200)
    fakeGh.setLatest({
      tag: "v0.1.1",
      htmlUrl: "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    })

    const first = await api(url, "/api/admin/version-check", { token })
    expect(first.status).toBe(200)
    expect(first.body.data.running).toBe("v0.1.0")
    expect(first.body.data.latest).toBe("v0.1.1")
    expect(first.body.data.latestUrl).toBe(
      "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    )
    expect(first.body.data.updateAvailable).toBe(true)
    expect(first.body.data.stale).toBeUndefined()
    expect(first.body.data.enabled).toBe(true)
    expect(fakeGh.getRequests()).toHaveLength(1)

    // Second hit: Redis cache should answer; no upstream fetch.
    const second = await api(url, "/api/admin/version-check", { token })
    expect(second.status).toBe(200)
    expect(second.body.data.latest).toBe("v0.1.1")
    expect(second.body.data.latestUrl).toBe(
      "https://github.com/mathieufro/liaison/releases/tag/v0.1.1",
    )
    expect(fakeGh.getRequests()).toHaveLength(1)

    // TTL was set to 6h.
    const ttl = await env.redis.redis.ttl(`${env.redisPrefix}versionCheck:latest`)
    expect(ttl).toBeGreaterThan(5 * 60 * 60)
  })

  it("falls back to last-known stale latest when upstream errors", async () => {
    await clearCaches()
    fakeGh.resetRequests()
    fakeGh.setStatus(200)
    fakeGh.setLatest({ tag: "v0.1.1" })

    // Warm the last-known cache via a successful round-trip.
    const ok = await api(url, "/api/admin/version-check", { token })
    expect(ok.status).toBe(200)
    expect(ok.body.data.latest).toBe("v0.1.1")

    // Drop only the live cache so the next call refetches.
    await env.redis.redis.del(`${env.redisPrefix}versionCheck:latest`)
    fakeGh.setStatus(503)
    fakeGh.resetRequests()

    const stale = await api(url, "/api/admin/version-check", { token })
    expect(stale.status).toBe(200)
    expect(stale.body.data.latest).toBe("v0.1.1")
    expect(stale.body.data.stale).toBe(true)
    expect(fakeGh.getRequests().length).toBeGreaterThanOrEqual(1)
  })

  it("flags a security release newer than the running build, from the releases list", async () => {
    await clearCaches()
    fakeGh.setStatus(200)
    fakeGh.setReleases([
      { tag: "v0.2.0" },
      { tag: "v0.1.1", name: "v0.1.1 [security]" },
      { tag: "v0.1.0" },
    ])
    const res = await api(url, "/api/admin/version-check", { token })
    expect(res.body.data.latest).toBe("v0.2.0")
    expect(res.body.data.securityUpdate).toBe(true)
    await clearCaches()
    fakeGh.setLatest({ tag: "v0.1.1" })
  })

  it("respects the org opt-out: GitHub is not contacted and updateAvailable is false", async () => {
    await clearCaches()
    fakeGh.setStatus(200)
    fakeGh.setLatest({ tag: "v0.1.1" })

    // Flip org-level opt-out via the org PATCH route.
    const patch = await api(url, "/api/org", {
      token,
      method: "PATCH",
      body: { updateChecksEnabled: false },
    })
    expect(patch.status).toBe(200)

    fakeGh.resetRequests()
    const off = await api(url, "/api/admin/version-check", { token })
    expect(off.status).toBe(200)
    expect(off.body.data.enabled).toBe(false)
    expect(off.body.data.updateAvailable).toBe(false)
    expect(fakeGh.getRequests()).toHaveLength(0)

    // Re-enable for the next describe-block test to keep the world clean.
    const reenable = await api(url, "/api/org", {
      token,
      method: "PATCH",
      body: { updateChecksEnabled: true },
    })
    expect(reenable.status).toBe(200)

    // Sanity: org id matches the world.
    expect(orgId).toBe(world.org.id)
  })
})
