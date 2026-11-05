// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  isUpdateAvailable,
  type PublishedRelease,
  resolveVersionStatus,
} from "~/modules/admin/version-check"
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

  it("reports the channel, and a nightly instance compares against the newest nightly", async () => {
    const channelBefore = env.LIAISON_RELEASE_CHANNEL
    env.LIAISON_RELEASE_CHANNEL = "nightly"
    restorers.push({
      mockRestore: () => {
        env.LIAISON_RELEASE_CHANNEL = channelBefore
      },
    })
    const body = (await checkWith("nightly-20261105-abc1234", [
      { tag_name: "nightly-20261106", prerelease: true, created_at: "2026-11-06T01:00:00Z" },
      { tag_name: "nightly-20261105", prerelease: true, created_at: "2026-11-05T01:00:00Z" },
      { tag_name: "v1.0.0", created_at: "2026-10-01T01:00:00Z" },
    ])) as unknown as { channel: string; latest: string; updateAvailable: boolean }
    expect(body.channel).toBe("nightly")
    expect(body.latest).toBe("nightly-20261106")
    expect(body.updateAvailable).toBe(true)
  })

  it("the default channel ignores nightlies, and a build with no release yet gets no latest", async () => {
    const body = (await checkWith("nightly-20261105-abc1234", [
      { tag_name: "nightly-20261106", prerelease: true, created_at: "2026-11-06T01:00:00Z" },
    ])) as unknown as { channel: string; latest?: string; updateAvailable: boolean }
    expect(body.channel).toBe("release")
    expect(body.latest).toBeUndefined()
    expect(body.updateAvailable).toBe(false)
  })

  it("an instance with no releases published at all says nothing about updates", async () => {
    const body = (await checkWith("v1.0.0", [])) as unknown as {
      latest?: string
      updateAvailable: boolean
      securityUpdate: boolean
    }
    expect(body.latest).toBeUndefined()
    expect(body.updateAvailable).toBe(false)
    expect(body.securityUpdate).toBe(false)
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

describe("resolveVersionStatus", () => {
  const stable = (tag: string, at: string, security = false): PublishedRelease => ({
    tag,
    commitAt: Date.parse(at),
    prerelease: false,
    security,
  })
  const nightly = (day: string, at: string): PublishedRelease => ({
    tag: `nightly-${day}`,
    commitAt: Date.parse(at),
    prerelease: true,
    security: false,
  })
  const history = [
    nightly("20261110", "2026-11-09T18:00:00Z"),
    nightly("20261109", "2026-11-08T18:00:00Z"),
    nightly("20261108", "2026-11-07T18:00:00Z"),
    stable("v1.2.0", "2026-11-08T18:00:00Z"), // cut from nightly-20261109's commit
    stable("v1.1.0", "2026-10-01T12:00:00Z"),
  ]

  describe("release channel", () => {
    it("compares against the newest release and never a nightly", () => {
      const s = resolveVersionStatus("release", "v1.1.0", history)
      expect(s.latest?.tag).toBe("v1.2.0")
      expect(s.updateAvailable).toBe(true)
    })

    it("a release on the newest release has no update", () => {
      expect(resolveVersionStatus("release", "v1.2.0", history).updateAvailable).toBe(false)
    })

    it("a nightly older than the release's commit has an update", () => {
      const s = resolveVersionStatus("release", "nightly-20261108-abc1234", history)
      expect(s.latest?.tag).toBe("v1.2.0")
      expect(s.updateAvailable).toBe(true)
    })

    it("a nightly at or past the release's commit stays put until a release includes it", () => {
      for (const running of ["nightly-20261109-abc1234", "nightly-20261110-abc1234"]) {
        const s = resolveVersionStatus("release", running, history)
        expect(s.latest?.tag).toBe("v1.2.0")
        expect(s.updateAvailable).toBe(false)
      }
    })

    it("a pruned nightly compares by its day", () => {
      expect(
        resolveVersionStatus("release", "nightly-20261001-abc1234", history).updateAvailable,
      ).toBe(true)
      expect(
        resolveVersionStatus("release", "nightly-20261201-abc1234", history).updateAvailable,
      ).toBe(false)
    })
  })

  describe("nightly channel", () => {
    it("an older nightly has an update to the newest one", () => {
      const s = resolveVersionStatus("nightly", "nightly-20261108-abc1234", history)
      expect(s.latest?.tag).toBe("nightly-20261110")
      expect(s.updateAvailable).toBe(true)
    })

    it("the newest nightly has none, and a later day never reads as behind", () => {
      expect(
        resolveVersionStatus("nightly", "nightly-20261110-abc1234", history).updateAvailable,
      ).toBe(false)
      expect(
        resolveVersionStatus("nightly", "nightly-20261111-abc1234", history).updateAvailable,
      ).toBe(false)
    })

    it("a release newer than the newest nightly is what is latest", () => {
      const list = [...history, stable("v1.3.0", "2026-11-10T09:00:00Z")]
      const s = resolveVersionStatus("nightly", "nightly-20261110-abc1234", list)
      expect(s.latest?.tag).toBe("v1.3.0")
      expect(s.updateAvailable).toBe(true)
    })

    it("a release cut from the newest nightly's commit stays behind it", () => {
      const list = [...history, stable("v1.3.0", "2026-11-09T18:00:00Z")]
      expect(resolveVersionStatus("nightly", "nightly-20261110-abc1234", list).latest?.tag).toBe(
        "nightly-20261110",
      )
    })

    it("a release instance compares by commit: its own nightly is not newer", () => {
      const onSameCommit = [nightly("20261109", "2026-11-08T18:00:00Z"), history[3] as never]
      expect(resolveVersionStatus("nightly", "v1.2.0", onSameCommit).updateAvailable).toBe(false)
      expect(resolveVersionStatus("nightly", "v1.2.0", history).updateAvailable).toBe(true)
    })

    it("falls back to the newest release while no nightly exists", () => {
      const list = history.filter((r) => !r.prerelease)
      const s = resolveVersionStatus("nightly", "v1.1.0", list)
      expect(s.latest?.tag).toBe("v1.2.0")
      expect(s.updateAvailable).toBe(true)
    })

    it("no release at all and no nightly: nothing to report", () => {
      const s = resolveVersionStatus("nightly", "nightly-20261110-abc1234", [])
      expect(s.latest).toBeUndefined()
      expect(s.updateAvailable).toBe(false)
      expect(s.securityUpdate).toBe(false)
    })
  })

  describe("security releases", () => {
    const list = [...history, stable("v1.2.1", "2026-11-09T06:00:00Z", true)]

    it("count for a nightly older than their commit, on either channel", () => {
      for (const channel of ["release", "nightly"] as const) {
        expect(resolveVersionStatus(channel, "nightly-20261109-abc1234", list).securityUpdate).toBe(
          true,
        )
      }
    })

    it("do not count for a nightly that already includes them", () => {
      expect(resolveVersionStatus("nightly", "nightly-20261110-abc1234", list).securityUpdate).toBe(
        false,
      )
    })

    it("still compare by version for a release", () => {
      expect(resolveVersionStatus("release", "v1.2.0", list).securityUpdate).toBe(true)
      expect(resolveVersionStatus("release", "v1.2.1", list).securityUpdate).toBe(false)
    })
  })

  it("a branch build, a local build or an odd label is never behind on either channel", () => {
    for (const running of ["dev", "main-5f37ce0", "nightly-tomorrow", "nightly-2026"]) {
      for (const channel of ["release", "nightly"] as const) {
        const s = resolveVersionStatus(channel, running, history)
        expect(s.updateAvailable).toBe(false)
        expect(s.securityUpdate).toBe(false)
      }
    }
  })
})
