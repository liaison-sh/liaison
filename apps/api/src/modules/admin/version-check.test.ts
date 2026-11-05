// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { isUpdateAvailable } from "~/modules/admin/version-check"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const CACHE_KEY = "versionCheck:latest"
const CACHE_LAST_KEY = "versionCheck:latest:last"

describe("GET /api/admin/version-check", () => {
  const restorers: { mockRestore: () => void }[] = []

  beforeEach(async () => {
    await redis.del(CACHE_KEY, CACHE_LAST_KEY)
  })

  afterEach(async () => {
    for (const s of restorers.splice(0)) s.mockRestore()
    await redis.del(CACHE_KEY, CACHE_LAST_KEY)
  })

  it("returns running + latest, sets a 6h cache, and does not refetch on the second call", async () => {
    // A release build: only a release can be behind the latest release.
    const runningBefore = env.LIAISON_VERSION
    env.LIAISON_VERSION = "v1.0.0"
    restorers.push({
      mockRestore: () => {
        env.LIAISON_VERSION = runningBefore
      },
    })
    const admin = await minimal.adminSession((await createTestOrg()).id)
    let _fetched = 0
    const stub = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify([{ tag_name: "v9.9.9" }]), {
          status: 200,
        })) as unknown as typeof fetch,
    )
    restorers.push(stub)
    // The stub above counts via the spy; we keep it simple:
    _fetched = stub.mock.calls.length

    const r = await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      data: { running: string; latest: string; updateAvailable: boolean }
    }
    expect(body.data.latest).toBe("v9.9.9")
    expect(body.data.updateAvailable).toBe(true)

    const before = stub.mock.calls.length
    await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    expect(stub.mock.calls.length).toBe(before) // no second network call

    const ttl = await redis.ttl(CACHE_KEY)
    expect(ttl).toBeGreaterThan(60 * 60 * 5)
  })

  async function checkWith(
    running: string,
    releases: object[],
  ): Promise<{ latest: string; updateAvailable: boolean; securityUpdate: boolean }> {
    const before = env.LIAISON_VERSION
    env.LIAISON_VERSION = running
    restorers.push({
      mockRestore: () => {
        env.LIAISON_VERSION = before
      },
    })
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const stub = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify(releases), { status: 200 })) as unknown as typeof fetch,
    )
    restorers.push(stub)
    const r = await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    expect(r.status).toBe(200)
    return ((await r.json()) as { data: never }).data
  }

  const history = [
    { tag_name: "v1.1.0", name: "v1.1.0" },
    { tag_name: "v1.0.1", name: "v1.0.1 [security]" },
    { tag_name: "v1.0.0", name: "v1.0.0" },
  ]

  it("a newer security release between running and latest sets securityUpdate", async () => {
    const body = await checkWith("v1.0.0", history)
    expect(body.latest).toBe("v1.1.0")
    expect(body.updateAvailable).toBe(true)
    expect(body.securityUpdate).toBe(true)
  })

  it("a security release at or older than the running version does not", async () => {
    expect((await checkWith("v1.0.1", history)).securityUpdate).toBe(false)
    await redis.del(CACHE_KEY, CACHE_LAST_KEY)
    expect((await checkWith("v1.1.0", history)).securityUpdate).toBe(false)
  })

  it("picks the highest semver whatever the list order, ignoring drafts and prereleases", async () => {
    const body = await checkWith("v1.0.0", [
      { tag_name: "v2.0.0", name: "v2.0.0 [security]", draft: true },
      { tag_name: "v1.9.0-rc.1", name: "v1.9.0-rc.1 [security]", prerelease: true },
      { tag_name: "v1.0.1", name: "v1.0.1" },
      { tag_name: "v1.2.0", name: "v1.2.0" },
    ])
    expect(body.latest).toBe("v1.2.0")
    expect(body.securityUpdate).toBe(false)
  })

  it("a branch build never gets securityUpdate", async () => {
    const body = await checkWith("main-5f37ce0", history)
    expect(body.updateAvailable).toBe(false)
    expect(body.securityUpdate).toBe(false)
  })

  it("a legacy cache entry decodes with securityUpdate false", async () => {
    const before = env.LIAISON_VERSION
    env.LIAISON_VERSION = "v1.0.0"
    restorers.push({
      mockRestore: () => {
        env.LIAISON_VERSION = before
      },
    })
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await redis.set(CACHE_KEY, JSON.stringify({ tag: "v1.1.0", htmlUrl: "https://github.com/x" }))
    const r = await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    const body = (await r.json()) as { data: { latest: string; securityUpdate: boolean } }
    expect(body.data.latest).toBe("v1.1.0")
    expect(body.data.securityUpdate).toBe(false)
  })

  it("returns stale latest when GitHub fetch fails and last-known value exists", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await redis.set(CACHE_LAST_KEY, "v8.8.8")
    const stub = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("rate limit", { status: 403 })) as unknown as typeof fetch,
    )
    restorers.push(stub)

    const r = await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: { latest: string; stale: boolean } }
    expect(body.data.latest).toBe("v8.8.8")
    expect(body.data.stale).toBe(true)
  })

  it("returns running only when org has updateChecksEnabled=false; does not call GitHub", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await withSystemDb("test-disable-update-checks", async (db) => {
      await db
        .update(organizations)
        .set({ updateChecksEnabled: false })
        .where(eq(organizations.id, admin.orgId))
    })
    const stub = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify([{ tag_name: "v1.0.0" }]), {
          status: 200,
        })) as unknown as typeof fetch,
    )
    restorers.push(stub)

    const r = await app.request("/api/admin/version-check", {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      data: { enabled: boolean; updateAvailable: boolean; latest?: string }
    }
    expect(body.data.enabled).toBe(false)
    expect(body.data.updateAvailable).toBe(false)
    expect(stub.mock.calls.length).toBe(0)
  })
})

// A build of a branch (`main-<sha>`, `dev`, a deploy's own label) is not a
// release: comparing it to the latest release tag announced an "update" to
// every such build, forever.
describe("isUpdateAvailable", () => {
  it("never for a build that is not a release", () => {
    expect(isUpdateAvailable("main-5f37ce0", "v1.3.0")).toBe(false)
    expect(isUpdateAvailable("dev", "v1.3.0")).toBe(false)
    expect(isUpdateAvailable("prod-cutover", "v1.3.0")).toBe(false)
  })

  it("for a release other than the latest one", () => {
    expect(isUpdateAvailable("v1.2.0", "v1.3.0")).toBe(true)
    expect(isUpdateAvailable("v1.3.0", "v1.3.0")).toBe(false)
    expect(isUpdateAvailable("1.3.0", "v1.3.0")).toBe(false)
  })
})
