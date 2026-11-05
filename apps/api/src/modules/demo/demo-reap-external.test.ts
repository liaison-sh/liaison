// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Collecting an expired demo workspace must leave nothing of it behind outside
// Postgres (object storage, Redis), and the reaper must drain the WHOLE expired
// backlog, not one batch (security pass, demo-and-selfhost).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3"
import { sql } from "~/db"
import {
  closeAllQueues,
  createAppQueue,
  registerJobWorker,
  upsertJobScheduler,
} from "~/infra/jobs/jobs"
import { deleteOrgPrefix } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { redisBullMQ } from "~/lib/redis"
import { listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import {
  DEMO_REAP_CONCURRENCY,
  DEMO_REAP_MAX_PER_RUN,
  demoResetLog,
  purgeDemoOrg,
  reapExpiredDemoOrgs,
} from "~/modules/demo/demo-reset"
import { deleteOrgRedisKeys } from "~/modules/org/purge/external"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOUR = 60 * 60 * 1000

/** The reap pass's info lines while `fn` runs: [fields, message]. */
async function reapInfoLines<T>(
  fn: () => Promise<T>,
): Promise<{ out: T; lines: Array<[Record<string, unknown>, string]> }> {
  const lines: Array<[Record<string, unknown>, string]> = []
  const spy = spyOn(demoResetLog, "info").mockImplementation(((obj: unknown, msg?: unknown) => {
    if (typeof msg === "string" && /^demo reap pass(:| skipped)/.test(msg)) {
      lines.push([(obj ?? {}) as Record<string, unknown>, msg])
    }
  }) as typeof demoResetLog.info)
  try {
    return { out: await fn(), lines }
  } finally {
    spy.mockRestore()
  }
}
const ORG_A = "11111111-1111-4111-8111-111111111111"
const ORG_B = "22222222-2222-4222-8222-222222222222"

/** An in-memory bucket speaking just enough S3 for deleteOrgPrefix. */
function fakeS3(keys: string[]) {
  const live = new Set(keys)
  const deleted: string[] = []
  const s3 = {
    send: async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? ""
        return {
          Contents: [...live].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })),
          IsTruncated: false,
        }
      }
      if (cmd instanceof DeleteObjectsCommand) {
        for (const o of cmd.input.Delete?.Objects ?? []) {
          live.delete(o.Key as string)
          deleted.push(o.Key as string)
        }
        return {}
      }
      throw new Error("unexpected command")
    },
  } as unknown as S3Client
  return { s3, live, deleted }
}

describe("deleteOrgPrefix", () => {
  it("removes every object under the org's prefix and nothing else", async () => {
    const { s3, live } = fakeS3([
      `orgs/${ORG_A}/files/a`,
      `orgs/${ORG_A}/avatars/b`,
      `orgs/${ORG_B}/files/c`,
    ])
    const n = await deleteOrgPrefix({ orgId: ORG_A }, { s3, bucket: "b" })
    expect(n).toBe(2)
    expect([...live]).toEqual([`orgs/${ORG_B}/files/c`])
  })

  it("refuses a value that is not an org uuid (no prefix games)", async () => {
    const { s3 } = fakeS3([])
    await expect(deleteOrgPrefix({ orgId: "../" }, { s3, bucket: "b" })).rejects.toThrow()
  })
})

describe("deleteOrgRedisKeys", () => {
  it("removes keys carrying the org id and leaves other tenants' keys", async () => {
    await redisBullMQ.set(`presence:${ORG_A}:u1`, "x")
    await redisBullMQ.set(`w0:demo-poll:${ORG_A}`, "x")
    await redisBullMQ.set(`presence:${ORG_B}:u1`, "x")
    expect(await deleteOrgRedisKeys(ORG_A)).toBeGreaterThanOrEqual(2)
    expect(await redisBullMQ.exists(`presence:${ORG_A}:u1`)).toBe(0)
    expect(await redisBullMQ.exists(`presence:${ORG_B}:u1`)).toBe(1)
    await redisBullMQ.del(`presence:${ORG_B}:u1`)
  })

  it("walks a large keyspace in few SCAN calls (a busy box holds hundreds of thousands of keys)", async () => {
    const filler = Array.from({ length: 12_000 }, (_, i) => `purge-scan-filler:${i}`)
    for (let i = 0; i < filler.length; i += 1000) {
      const pipe = redisBullMQ.pipeline()
      for (const k of filler.slice(i, i + 1000)) pipe.set(k, "x")
      await pipe.exec()
    }
    await redisBullMQ.set(`presence:${ORG_A}:u2`, "x")
    const keyspace = await redisBullMQ.dbsize()
    const scan = redisBullMQ.scan.bind(redisBullMQ)
    let calls = 0
    redisBullMQ.scan = ((...args: Parameters<typeof scan>) => {
      calls++
      return scan(...args)
    }) as typeof redisBullMQ.scan
    try {
      expect(await deleteOrgRedisKeys(ORG_A)).toBeGreaterThanOrEqual(1)
    } finally {
      redisBullMQ.scan = scan
      for (let i = 0; i < filler.length; i += 1000)
        await redisBullMQ.del(...filler.slice(i, i + 1000))
    }
    expect(await redisBullMQ.exists(`presence:${ORG_A}:u2`)).toBe(0)
    // 500 buckets a call took keyspace/500 calls (24+ here); PURGE_SCAN_COUNT a tenth of that.
    expect(calls).toBeLessThanOrEqual(Math.ceil(keyspace / 4000) + 2)
  })
})

describe("collecting expired demo workspaces", () => {
  const ids: string[] = []
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    // More than one batch's worth. The first is a full workspace (roles, apps,
    // agent), the one the purge case collects; the backlog behind it only has to
    // be listed and collected, so it is bare organisation rows. Thirty full
    // ensureOrg calls (app registration each) ran past the hook's minute on a
    // loaded machine.
    for (let i = 0; i < DEMO_REAP_MAX_PER_RUN + 5; i++) {
      const orgId =
        i === 0
          ? (await ensureOrg({ slug: `reap-${i}`, name: `Reap ${i}` })).orgId
          : ((
              await sql<{ id: string }[]>`
                INSERT INTO kernel.organizations (id, name, slug)
                VALUES (gen_random_uuid(), ${`Reap ${i}`}, ${`reap-${i}-${crypto.randomUUID().slice(0, 8)}`})
                RETURNING id`
            )[0]?.id as string)
      await markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - (80 + i) * HOUR)))
      ids.push(orgId)
    }
    invalidateDemoMarker()
  }, 60_000)
  afterAll(async () => {
    await closeAllQueues()
    DemoModeTestAccess.set(null)
    invalidateDemoMarker()
    await releaseTestLock()
  })

  it("a purge removes the org's objects, Redis keys and job schedulers too, and a failure keeps the org", async () => {
    const orgId = ids[0] as string
    const calls: string[] = []
    // A scheduler that carries the org (a routine's, say).
    registerJobWorker("reaptest", "tick", async () => {})
    const schedulerId = `tick-scheduler-${orgId}`
    await upsertJobScheduler("reaptest", "tick", "0 3 * * *", { orgId, schedulerId })
    const failing = await purgeDemoOrg(orgId, new Date(), {
      deleteObjects: async () => {
        throw new Error("storage down")
      },
      deleteRedisKeys: async () => 0,
    }).catch((e: Error) => e)
    expect(failing).toBeInstanceOf(Error)
    // Still listed: the next pass retries.
    expect((await listExpiredDemoOrgs()).map((o) => o.orgId)).toContain(orgId)

    const ok = await purgeDemoOrg(orgId, new Date(), {
      deleteObjects: async (id) => {
        calls.push(`objects:${id}`)
        return 3
      },
      deleteRedisKeys: async (id) => {
        calls.push(`redis:${id}`)
        return 2
      },
    })
    expect(ok.purged).toBe(true)
    expect(calls).toEqual([`objects:${orgId}`, `redis:${orgId}`])
    expect(ok.deleted?.["object-storage.objects"]).toBe(3)
    expect(ok.deleted?.["redis.keys"]).toBe(2)
    // The org's schedulers are gone with it, on every queue.
    expect(await createAppQueue("reaptest").getJobScheduler(schedulerId)).toBeUndefined()
    expect(ok.deleted?.["redis.job-schedulers"]).toBeGreaterThanOrEqual(1)
  })

  it("the reaper drains the whole backlog, past one batch, DEMO_REAP_CONCURRENCY purges at once", async () => {
    const before = (await listExpiredDemoOrgs()).length
    expect(before).toBeGreaterThan(DEMO_REAP_MAX_PER_RUN)
    let inFlight = 0
    let maxInFlight = 0
    const { out, lines } = await reapInfoLines(() =>
      reapExpiredDemoOrgs(new Date(), {
        // An idle box: no pressure signal.
        pressure: async () => ({ poolBusy: false, dbProbeMs: 0.5, hostLoadPerCore: 0.1 }),
        externalDeps: {
          // A purge's slow step (objects, Redis) while others run beside it.
          deleteObjects: async () => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((r) => setTimeout(r, 30))
            inFlight--
            return 0
          },
          deleteRedisKeys: async () => 0,
        },
      }),
    )
    expect(out.collected.length).toBe(before)
    // One summary line for the pass, with its counts.
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toMatchObject({
      expired: before,
      collected: before,
      refused: 0,
      failed: 0,
      stopped: "drained",
    })
    expect(lines[0]?.[1]).toBe(`demo reap pass: ${before} of ${before} expired collected`)
    expect(new Set(out.collected.map((o) => o.orgId)).size).toBe(before)
    expect(await listExpiredDemoOrgs()).toEqual([])
    expect(maxInFlight).toBe(DEMO_REAP_CONCURRENCY)
  })

  it("a pass with nothing to do says so, and so does a pass on a box with demo mode off", async () => {
    const empty = await reapInfoLines(() => reapExpiredDemoOrgs(new Date()))
    expect(empty.out.collected).toEqual([])
    expect(empty.lines).toHaveLength(1)
    expect(empty.lines[0]?.[0]).toMatchObject({ expired: 0, collected: 0, stopped: "drained" })
    expect(empty.lines[0]?.[1]).toBe("demo reap pass: nothing expired")

    DemoModeTestAccess.set(false)
    try {
      const off = await reapInfoLines(() => reapExpiredDemoOrgs(new Date()))
      expect(off.out.collected).toEqual([])
      expect(off.lines).toEqual([
        [{ reason: "demo-mode-off" }, "demo reap pass skipped: demo mode is off"],
      ])
    } finally {
      DemoModeTestAccess.set(true)
    }
  })

  it("under live-traffic pressure the reaper runs one purge at a time and rests after each", async () => {
    const fresh: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await sql<{ id: string }[]>`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${`Paced ${i}`}, ${`paced-${i}-${crypto.randomUUID().slice(0, 8)}`})
        RETURNING id`
      const orgId = row[0]?.id as string
      await markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - 80 * HOUR)))
      fresh.push(orgId)
    }
    invalidateDemoMarker()
    let inFlight = 0
    let maxInFlight = 0
    const starts: number[] = []
    const ends: number[] = []
    let samples = 0
    const out = await reapExpiredDemoOrgs(new Date(), {
      // A busy box: the privileged pool has waiters.
      pressure: async () => {
        samples++
        return { poolBusy: true, dbProbeMs: 0.5, hostLoadPerCore: 0.1 }
      },
      pacer: { maxRestMs: 120 },
      externalDeps: {
        deleteObjects: async () => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          starts.push(Date.now())
          await new Promise((r) => setTimeout(r, 30))
          inFlight--
          ends.push(Date.now())
          return 0
        },
        deleteRedisKeys: async () => 0,
      },
    })
    expect(out.collected.map((o) => o.orgId).sort()).toEqual([...fresh].sort())
    expect(maxInFlight).toBe(1)
    expect(samples).toBeGreaterThanOrEqual(fresh.length)
    // Each purge after the first started only after the previous one's rest:
    // at duty <= 0.5 the rest is at least as long as the purge (>= 30 ms).
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (ends[i - 1] as number)).toBeGreaterThanOrEqual(25)
    }
  })

  it("under sustained pressure a pass still drains its whole backlog within its budget (the floor)", async () => {
    // Run 5 of the launch load test: the box was busy for the whole pass, the
    // pacer rested nine times each purge, and the expired backlog outgrew the
    // workspace cap. Twelve orgs, a 6 s pass, purges of ~100 ms: at a tenth
    // duty that is ~12 s of work and rest, so an unfloored pass runs out of time.
    const fresh: string[] = []
    for (let i = 0; i < 12; i++) {
      const row = await sql<{ id: string }[]>`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${`Floor ${i}`}, ${`floor-${i}-${crypto.randomUUID().slice(0, 8)}`})
        RETURNING id`
      const orgId = row[0]?.id as string
      await markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - 80 * HOUR)))
      fresh.push(orgId)
    }
    invalidateDemoMarker()
    const { out, lines } = await reapInfoLines(() =>
      reapExpiredDemoOrgs(new Date(), {
        budgetMs: 6_000,
        pressure: async () => ({ poolBusy: true, dbProbeMs: 0.5, hostLoadPerCore: 0.1 }),
        externalDeps: {
          deleteObjects: async () => {
            await new Promise((r) => setTimeout(r, 100))
            return 0
          },
          deleteRedisKeys: async () => 0,
        },
      }),
    )
    expect(out.collected.map((o) => o.orgId).sort()).toEqual([...fresh].sort())
    expect(lines[0]?.[0]).toMatchObject({ stopped: "drained", backlog: 12, urgent: false })
  })

  it("a pass whose workspace cap is nearly full of expired workspaces does not yield", async () => {
    const saved = env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS
    const fresh: string[] = []
    for (let i = 0; i < 4; i++) {
      const row = await sql<{ id: string }[]>`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${`Capped ${i}`}, ${`capped-${i}-${crypto.randomUUID().slice(0, 8)}`})
        RETURNING id`
      const orgId = row[0]?.id as string
      await markOrgAsDemo(orgId, {
        ...visitorMarker(72, new Date(Date.now() - 80 * HOUR)),
        synthetic: true,
      })
      fresh.push(orgId)
    }
    invalidateDemoMarker()
    env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS = 5
    let inFlight = 0
    let maxInFlight = 0
    try {
      const { out, lines } = await reapInfoLines(() =>
        reapExpiredDemoOrgs(new Date(), {
          pressure: async () => ({ poolBusy: true, dbProbeMs: 0.5, hostLoadPerCore: 0.1 }),
          externalDeps: {
            deleteObjects: async () => {
              inFlight++
              maxInFlight = Math.max(maxInFlight, inFlight)
              await new Promise((r) => setTimeout(r, 30))
              inFlight--
              return 0
            },
            deleteRedisKeys: async () => 0,
          },
        }),
      )
      expect(out.collected.map((o) => o.orgId).sort()).toEqual([...fresh].sort())
      expect(lines[0]?.[0]).toMatchObject({ stopped: "drained", urgent: true })
      expect(maxInFlight).toBe(DEMO_REAP_CONCURRENCY)
    } finally {
      env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS = saved
    }
  })
})
