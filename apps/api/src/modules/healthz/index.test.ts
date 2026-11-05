// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import * as searchClient from "~/infra/search/client"
import * as objectStorage from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import {
  type DepStatus,
  isPrivateAddress,
  resetHealthzCache,
  TIMEOUT_MS,
  withTimeout,
} from "~/modules/healthz"

const LOCAL = { "x-bun-socket-ip": "127.0.0.1" }

describe("GET /healthz", () => {
  const spies: { mockRestore: () => void }[] = []

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
    resetHealthzCache()
  })

  it("returns 200 with status, version, migration head, and dependency status", async () => {
    const r = await app.request("/healthz", { headers: LOCAL })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status: string
      version: string
      migrationHead: string
      schemaBaseline: string
      dependencies: Record<string, string>
    }
    expect(body.status).toBe("ok")
    // version + migrationHead + schemaBaseline MUST be present on the
    // unauthenticated /healthz: the self-host upgrade gates (validate-compose,
    // the runbook's healthz wait) read them, and during a
    // maintenance window /healthz is the only reachable route. See modules/healthz.
    expect(typeof body.version).toBe("string")
    expect(body.version.length).toBeGreaterThan(0)
    expect(body.migrationHead).toMatch(/^([0-9a-f]{64}|pending:\d+\/\d+|unknown)$/)
    expect(body.schemaBaseline).toBe("v0.1.0")
    expect(body.dependencies).toEqual(
      expect.objectContaining({
        db: expect.any(String),
        redis: expect.any(String),
        meilisearch: expect.any(String),
        objectStorage: expect.any(String),
      }),
    )
  })

  it("returns 200 even when a dependency is degraded (informational only)", async () => {
    spies.push(
      spyOn(searchClient, "getMeili").mockReturnValue({
        health: async () => Promise.reject(new Error("meili down")),
      } as never),
    )

    const r = await app.request("/healthz", { headers: LOCAL })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { dependencies: Record<string, string> }
    expect(["error", "timeout"]).toContain(body.dependencies.meilisearch)
  })

  it("probes object storage with a bucket-scoped command the scoped app identity allows (not ListBuckets)", async () => {
    // Regression: ListBucketsCommand needs s3:ListAllMyBuckets, which the scoped
    // scoped app identity does NOT grant — so it 403s and reports healthy storage as down.
    // The probe must use a bucket-scoped ListObjectsV2 against our own bucket.
    const sent: { ClientName?: string; input?: Record<string, unknown> }[] = []
    const fakeS3 = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ ClientName: cmd.constructor.name, input: cmd.input })
        return { Contents: [] }
      },
    }
    spies.push(spyOn(objectStorage, "getStorageClient").mockReturnValue(fakeS3 as never))

    const r = await app.request("/healthz", { headers: LOCAL })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { dependencies: Record<string, string> }
    expect(body.dependencies.objectStorage).toBe("ok")

    const storageCmd = sent.find((s) => s.ClientName?.includes("ListObjects"))
    expect(storageCmd).toBeDefined()
    // Must NOT use the broad ListBuckets command.
    expect(sent.some((s) => s.ClientName?.includes("ListBuckets"))).toBe(false)
    // Scoped to our own bucket.
    expect(storageCmd?.input?.Bucket).toBe(env.OBJECT_STORAGE_BUCKET)
  })

  it("bounds a hung dependency at the probe budget (response stays well under it plus slack)", async () => {
    // The invariant is that ONE hung dependency can never hang the endpoint --
    // not the specific millisecond count. The budget moved 200ms -> 2s (see
    // "dependency probe budget" below); this probe is slower than the new budget
    // so it still exercises the timeout path rather than the resolve path.
    spies.push(
      spyOn(searchClient, "getMeili").mockReturnValue({
        health: () => new Promise((resolve) => setTimeout(resolve, 6000)),
      } as never),
    )

    const start = Date.now()
    const r = await app.request("/healthz", { headers: LOCAL })
    const elapsed = Date.now() - start
    expect(r.status).toBe(200)
    const body = (await r.json()) as { dependencies: Record<string, string> }
    expect(body.dependencies.meilisearch).toBe("timeout")
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 1000)
  })
})

// Regression (prod 2026-08-27): the container healthcheck reads /healthz's
// `dependencies` and exits non-zero on any dep that is not "ok". With a 200ms
// budget the object-storage probe timed out on roughly half its runs while the store
// was perfectly healthy, so the check flapped, and deploy-liaison.sh aborted with
// FATAL at its post-recreate health gate on an app that was serving 200s
// throughout. be905d53 had already raised the identical constant for /diag; this
// copy, the one the healthcheck actually runs, was missed.
describe("GET /healthz — public caller", () => {
  afterEach(() => resetHealthzCache())
  const publicShapes: Record<string, Record<string, string>> = {
    "no socket peer": {},
    "public peer": { "x-bun-socket-ip": "203.0.113.9" },
    "proxy on loopback forwarding a public client": {
      "x-bun-socket-ip": "127.0.0.1",
      "x-forwarded-for": "203.0.113.9",
    },
    "proxy on a private network (x-real-ip)": {
      "x-bun-socket-ip": "10.0.0.2",
      "x-real-ip": "203.0.113.9",
    },
    "wrong bearer token": { "x-bun-socket-ip": "203.0.113.9", authorization: "Bearer nope" },
  }
  for (const [name, headers] of Object.entries(publicShapes)) {
    it(`returns only {status} to ${name}, without probing`, async () => {
      const probe = spyOn(searchClient, "getMeili")
      const r = await app.request("/healthz", { headers })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ status: "ok" })
      expect(probe).not.toHaveBeenCalled()
      probe.mockRestore()
    })
  }

  it("gives the detail to a holder of the monitor token even from a public address", async () => {
    const prev = env.MONITOR_TOKEN
    ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = "monitor-secret-for-healthz-test"
    try {
      const r = await app.request("/healthz", {
        headers: {
          "x-bun-socket-ip": "203.0.113.9",
          "x-forwarded-for": "203.0.113.9",
          authorization: "Bearer monitor-secret-for-healthz-test",
        },
      })
      const body = (await r.json()) as { version?: string; dependencies?: unknown }
      expect(body.version).toBeString()
      expect(body.dependencies).toBeDefined()
    } finally {
      ;(env as { MONITOR_TOKEN: string }).MONITOR_TOKEN = prev
    }
  })

  it("serves the detailed body from a short cache so repeated calls do not re-probe", async () => {
    const meili = spyOn(searchClient, "getMeili")
    await app.request("/healthz", { headers: LOCAL })
    await app.request("/healthz", { headers: LOCAL })
    await app.request("/healthz", { headers: LOCAL })
    expect(meili).toHaveBeenCalledTimes(1)
    meili.mockRestore()
  })

  it("classifies private and loopback peers", () => {
    for (const ip of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.18.0.1",
      "192.168.65.1",
      "fd00::1",
    ])
      expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ["203.0.113.9", "172.32.0.1", "8.8.8.8", "2001:db8::1"])
      expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe("dependency probe budget", () => {
  it("gives a dependency enough time that a normal round trip is not a timeout", async () => {
    // A probe slower than the OLD 200ms but well inside a healthy round trip must
    // report ok, not timeout.
    const slowButFine = () => new Promise<DepStatus>((r) => setTimeout(() => r("ok"), 400))
    expect(await withTimeout(slowButFine, TIMEOUT_MS)).toBe("ok")
  })

  it("still reports a genuinely hung dependency as timeout", () => {
    // The budget must not become "never fails": a dep that never answers is down.
    expect(TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })

  it("matches the budget /diag settled on, so the two verdicts cannot disagree", () => {
    expect(TIMEOUT_MS).toBe(2000)
  })
})

// REGRESSION (prod: 59 health-dep pages, essentially all false positives, over 48h of
// 2382 /diag samples with a p99 of 360ms). The API is single process, so blocking the
// event loop for ~2s makes ALL FOUR dep-probe timers fire at once even though every
// dependency answered fine -- the probes never got a chance to run before the block
// ended. withTimeout must tell "the loop was too busy to check on schedule" apart from
// "the dependency genuinely never answered".
describe("withTimeout under event-loop lag", () => {
  it("reports a dependency as slow, not timeout, when a loop stall explains the overrun and the probe itself answers late", async () => {
    // The probe DOES answer, just after the loop stall we cause below -- it is a real
    // dependency that was fine, and our own event loop was the problem. A probe that
    // NEVER answers at all is a down dependency (see the "genuinely unresponsive
    // dependency" test below), not this case: a probe that never settles is exactly
    // what must NOT read as "slow".
    const answersLate = (): Promise<DepStatus> =>
      new Promise((resolve) => setTimeout(() => resolve("ok"), 2600))

    const resultPromise = withTimeout(answersLate, TIMEOUT_MS)

    const blockUntil = Date.now() + 2500
    while (Date.now() < blockUntil) {
      // busy-wait: simulates the GC pause / busy tick that starved the real timer in prod
    }

    const result = await resultPromise
    // The overrun is fully explained by the loop stall we just caused, and the probe
    // itself went on to answer fine within the grace window -- "slow", not the
    // false-positive "timeout" that paged the watchdog 59 times.
    expect(result).toBe("slow")
  }, 10000)

  it("reports a probe's own error verdict as error, not slow, when it answers by value during a loop stall", async () => {
    // Same loop stall shape as the "slow" case above, but the probe RETURNS "error"
    // by value instead of throwing (this is how probeRedis reports a bad PING reply:
    // it never throws). The grace window must not launder that into "slow" just
    // because it answered late -- only an "ok" verdict gets reclassified.
    const answersLateWithError = (): Promise<DepStatus> =>
      new Promise((resolve) => setTimeout(() => resolve("error"), 2600))

    const resultPromise = withTimeout(answersLateWithError, TIMEOUT_MS)

    const blockUntil = Date.now() + 2500
    while (Date.now() < blockUntil) {
      // busy-wait: simulates the GC pause / busy tick that starved the real timer in prod
    }

    const result = await resultPromise
    expect(result).toBe("error")
  }, 10000)

  it("reports a genuinely unresponsive dependency as timeout, even under a loop stall that straddles the deadline", async () => {
    // Same loop stall shape as the "slow" case above, but the probe never answers at
    // all. A dependency that never answers is down no matter how busy we were: the
    // loop-lag exemption must not become a blanket excuse that hides a dead dependency
    // behind "slow".
    const hungProbe = (): Promise<DepStatus> => new Promise(() => {})

    const resultPromise = withTimeout(hungProbe, TIMEOUT_MS)

    const blockUntil = Date.now() + 2500
    while (Date.now() < blockUntil) {
      // busy-wait: simulates the GC pause / busy tick that starved the real timer in prod
    }

    const result = await resultPromise
    expect(result).toBe("timeout")
  }, 10000)
})
